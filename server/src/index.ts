// Cloudflare Worker entrypoint for Distributed Obsidian Sync.
// Implements the /v1 protocol with atomic D1 metadata transactions and R2 blob storage.

import {
  ConflictError,
  deleteFile,
  getChanges,
  getDeletedFiles,
  getFile,
  getRetentionDays,
  getRevisionHash,
  getStats,
  purgeDeletedFiles,
  renameFile,
  setRetentionDays,
  writeFile,
} from "./db.ts";
import { getBlob, putBlob, sha256Hex } from "./storage.ts";
import { countTokens, createToken, validateToken } from "./auth.ts";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  API_KEY?: string;
}

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, X-Base-Rev, X-Mtime, X-Folder, X-Device",
      ...extraHeaders,
    },
  });
}

function errorResponse(status: number, error: string, message: string): Response {
  return jsonResponse({ error, message }, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, X-Base-Rev, X-Mtime, X-Folder, X-Device",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Public / health probe
    if (path === "/v1/health" || path === "/health" || path === "/") {
      return jsonResponse({ ok: true });
    }

    // Token creation / bootstrap endpoint
    if (path === "/v1/tokens" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      const apiKeyHeader = request.headers.get("X-Api-Key");
      const totalTokens = await countTokens(env.DB);

      // Allow bootstrap if no tokens exist, or if valid token or API_KEY matches
      const isBootstrap = totalTokens === 0;
      const isApiKeyValid = env.API_KEY && apiKeyHeader === env.API_KEY;
      const isTokenValid = await validateToken(env.DB, authHeader);

      if (!isBootstrap && !isApiKeyValid && !isTokenValid) {
        return errorResponse(401, "unauthorized", "Valid authentication required to mint tokens");
      }

      let body: { name?: string } = {};
      try {
        body = (await request.json()) as { name?: string };
      } catch {}
      const deviceName = body.name || "default-device";
      const { token } = await createToken(env.DB, deviceName);
      return jsonResponse({ token, vault: "vault" });
    }

    // Require Bearer authentication for all remaining /v1 endpoints
    const authHeader = request.headers.get("Authorization");
    const isAuthenticated = await validateToken(env.DB, authHeader);
    if (!isAuthenticated) {
      return errorResponse(401, "unauthorized", "Invalid or missing Bearer token");
    }

    const deviceName = request.headers.get("X-Device") || "unknown";

    try {
      // 1. Vault stats
      if (path === "/v1/stats" && request.method === "GET") {
        const stats = await getStats(env.DB);
        return jsonResponse(stats);
      }

      // 2. Incremental delta changelog
      if (path === "/v1/changes" && request.method === "GET") {
        const since = parseInt(url.searchParams.get("since") || "0", 10);
        const limit = parseInt(url.searchParams.get("limit") || "500", 10);
        const changes = await getChanges(env.DB, since, limit);

        // Format boolean fields for client engine
        const entries = changes.entries.map((e) => ({
          seq: e.seq,
          path: e.path,
          rev: e.rev,
          hash: e.hash ?? undefined,
          size: e.size,
          mtime: e.mtime,
          deleted: Boolean(e.deleted),
          folder: Boolean(e.folder),
          updated_by: e.updated_by ?? undefined,
          renamed_from: e.renamed_from ?? undefined,
        }));

        return jsonResponse({
          entries,
          next_seq: changes.next_seq,
          has_more: changes.has_more,
        });
      }

      // 3. File retrieval (GET /v1/file)
      if (path === "/v1/file" && (request.method === "GET" || request.method === "HEAD")) {
        const filePath = url.searchParams.get("path");
        if (!filePath) {
          return errorResponse(400, "missing_path", "Missing path query parameter");
        }

        const revParam = url.searchParams.get("rev");
        let targetHash: string | null = null;
        let targetRev = 0;

        if (revParam != null) {
          targetRev = parseInt(revParam, 10);
          targetHash = await getRevisionHash(env.DB, filePath, targetRev);
        } else {
          const cur = await getFile(env.DB, filePath);
          if (cur && cur.deleted === 0) {
            targetHash = cur.hash;
            targetRev = cur.rev;
          }
        }

        if (!targetHash) {
          return errorResponse(404, "not_found", "File revision not found or deleted");
        }

        // Parse Range request if provided
        const rangeHeader = request.headers.get("Range");
        let rangeOpt: R2Range | undefined;
        let startByte = 0;
        let endByte = 0;
        let isRange = false;

        if (rangeHeader && rangeHeader.startsWith("bytes=")) {
          const parts = rangeHeader.slice("bytes=".length).split("-");
          startByte = parseInt(parts[0], 10);
          if (parts[1]) {
            endByte = parseInt(parts[1], 10);
            rangeOpt = { offset: startByte, length: endByte - startByte + 1 };
          } else {
            rangeOpt = { offset: startByte };
          }
          isRange = true;
        }

        const blob = await getBlob(env.BUCKET, targetHash, rangeOpt);
        if (!blob) {
          return errorResponse(404, "blob_missing", "Blob content missing from storage");
        }

        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(blob.size),
              "ETag": `"${targetHash}"`,
              "X-Rev": String(targetRev),
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/octet-stream",
          "ETag": `"${targetHash}"`,
          "X-Rev": String(targetRev),
          "Access-Control-Allow-Origin": "*",
        };

        if (isRange) {
          headers["Content-Range"] = `bytes ${startByte}-${startByte + blob.size - 1}/${blob.size}`;
          return new Response(blob.body, { status: 206, headers });
        }

        return new Response(blob.body, { status: 200, headers });
      }

      // 4. File / folder write (PUT /v1/file)
      if (path === "/v1/file" && request.method === "PUT") {
        const filePath = url.searchParams.get("path");
        if (!filePath) {
          return errorResponse(400, "missing_path", "Missing path query parameter");
        }

        const baseRev = parseInt(request.headers.get("X-Base-Rev") || "0", 10);
        const mtime = parseInt(request.headers.get("X-Mtime") || String(Date.now()), 10);
        const isFolder = request.headers.get("X-Folder") === "1";

        let hash = "";
        let size = 0;

        if (!isFolder) {
          const bodyBuffer = await request.arrayBuffer();
          size = bodyBuffer.byteLength;
          hash = await sha256Hex(bodyBuffer);
          // Store blob in R2
          await putBlob(env.BUCKET, hash, bodyBuffer);
        }

        const { record } = await writeFile(env.DB, {
          path: filePath,
          baseRev,
          hash,
          size,
          mtime,
          folder: isFolder,
          updatedBy: deviceName,
        });

        return jsonResponse({
          path: record.path,
          rev: record.rev,
          seq: record.seq,
          hash: record.hash ?? "",
          deleted: false,
        });
      }

      // 5. File deletion (DELETE /v1/file)
      if (path === "/v1/file" && request.method === "DELETE") {
        const filePath = url.searchParams.get("path");
        if (!filePath) {
          return errorResponse(400, "missing_path", "Missing path query parameter");
        }
        const baseRev = parseInt(request.headers.get("X-Base-Rev") || "0", 10);

        const tombstone = await deleteFile(env.DB, filePath, baseRev, deviceName);
        return jsonResponse({
          path: tombstone.path,
          rev: tombstone.rev,
          seq: tombstone.seq,
          hash: "",
          deleted: true,
        });
      }

      // 6. Rename (POST /v1/rename)
      if (path === "/v1/rename" && request.method === "POST") {
        const body = (await request.json()) as { from: string; to: string; base_rev: number };
        if (!body.from || !body.to || body.base_rev == null) {
          return errorResponse(400, "invalid_rename", "Body must include from, to, and base_rev");
        }

        const newDst = await renameFile(env.DB, body.from, body.to, body.base_rev, deviceName);
        return jsonResponse({
          path: newDst.path,
          rev: newDst.rev,
          seq: newDst.seq,
          hash: newDst.hash ?? "",
          deleted: false,
        });
      }

      // 7. Recoverable deleted files
      if (path === "/v1/deleted" && request.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "200", 10);
        const entries = await getDeletedFiles(env.DB, limit);
        return jsonResponse({ entries });
      }

      // 8. Purge deleted files
      if (path === "/v1/deleted" && request.method === "DELETE") {
        const purged = await purgeDeletedFiles(env.DB);
        return jsonResponse(purged);
      }

      // 9. Retention settings
      if (path === "/v1/retention" && request.method === "GET") {
        const days = await getRetentionDays(env.DB);
        return jsonResponse({ days });
      }

      if (path === "/v1/retention" && request.method === "PUT") {
        const body = (await request.json()) as { days?: number };
        const days = body.days ?? 30;
        await setRetentionDays(env.DB, days);
        return jsonResponse({ days });
      }

      return errorResponse(404, "not_found", `Route ${request.method} ${path} not found`);
    } catch (err: unknown) {
      if (err instanceof ConflictError) {
        return jsonResponse(
          {
            error: "conflict",
            path: err.path,
            server_rev: err.serverRev,
            server_hash: err.serverHash ?? "",
            deleted: err.deleted,
            updated_by: err.updatedBy ?? "",
          },
          409
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(500, "internal_error", message);
    }
  },
};
