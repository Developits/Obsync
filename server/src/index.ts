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
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, X-Base-Rev, X-Mtime, X-Folder, X-Device, X-Api-Key",
      ...extraHeaders,
    },
  });
}

function errorResponse(status: number, error: string, message: string): Response {
  return jsonResponse({ error, message }, status);
}

class InvalidInput extends Error {}

function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !/^\d+$/.test(value))) {
    throw new InvalidInput(`${name} must be an integer between ${min} and ${max}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new InvalidInput(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function validatePath(path: string): void {
  // Clients publish NFC vault-relative slash paths. Reject aliases/traversal,
  // but do not impose client exclusion rules or ban reserved URI characters.
  if (path !== path.normalize("NFC") || path.includes("\0") || path.includes("\\") ||
      /^[A-Za-z]:/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new InvalidInput("Expected an NFC vault-relative path without traversal or empty segments");
  }
}

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, X-Base-Rev, X-Mtime, X-Folder, X-Device, X-Api-Key",
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

      // A public, empty database is not authorization. Initial enrollment
      // requires the configured secret; existing devices may enroll peers.
      const isApiKeyValid = Boolean(env.API_KEY && apiKeyHeader === env.API_KEY);
      const isTokenValid = totalTokens > 0 && await validateToken(env.DB, authHeader);

      if (!isApiKeyValid && !isTokenValid) {
        return errorResponse(401, "unauthorized", "Valid authentication required to mint tokens");
      }

      const body = await readObject(request);
      if (!body || (body.name !== undefined && typeof body.name !== "string")) {
        return errorResponse(400, "invalid_body", "Expected a JSON object with an optional string name");
      }
      const deviceName = (body.name as string) || "default-device";
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
        const since = integer(url.searchParams.get("since") ?? "0", "since");
        const limit = integer(url.searchParams.get("limit") ?? "500", "limit", 1, 1000);
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
        validatePath(filePath);

        const revParam = url.searchParams.get("rev");
        let targetHash: string | null = null;
        let targetRev = 0;

        if (revParam != null) {
          targetRev = integer(revParam, "rev", 1);
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

        // HEAD ignores Range. GET supports one byte range; invalid/multiple
        // ranges receive 416 rather than being partially interpreted by R2.
        const metadata = await env.BUCKET.head(`blobs/${targetHash.slice(0, 2)}/${targetHash}`);
        if (!metadata) {
          return errorResponse(404, "blob_missing", "Blob content missing from storage");
        }
        const totalSize = metadata.size;
        const rangeHeader = request.method === "GET" ? request.headers.get("Range") : null;
        let rangeOpt: R2Range | undefined;
        let startByte = 0;
        let endByte = totalSize - 1;
        if (rangeHeader !== null) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
          const first = match?.[1] ? Number(match[1]) : null;
          const last = match?.[2] ? Number(match[2]) : null;
          const invalid = !match || (first === null && last === null) || totalSize === 0 ||
            (first !== null && (!Number.isSafeInteger(first) || first >= totalSize)) ||
            (last !== null && !Number.isSafeInteger(last)) ||
            (first === null && last === 0) ||
            (first !== null && last !== null && last < first);
          if (invalid) {
            return jsonResponse({ error: "invalid_range", message: "Expected one satisfiable byte range" }, 416,
              { "Content-Range": `bytes */${totalSize}` });
          }
          startByte = first === null ? Math.max(0, totalSize - last!) : first;
          endByte = first === null || last === null ? totalSize - 1 : Math.min(last, totalSize - 1);
          rangeOpt = { offset: startByte, length: endByte - startByte + 1 };
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

        headers["Accept-Ranges"] = "bytes";
        headers["Content-Length"] = String(rangeOpt ? endByte - startByte + 1 : totalSize);
        if (rangeOpt) {
          headers["Content-Range"] = `bytes ${startByte}-${endByte}/${totalSize}`;
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
        validatePath(filePath);

        const baseRev = integer(request.headers.get("X-Base-Rev") ?? "0", "X-Base-Rev", 0, Number.MAX_SAFE_INTEGER - 1);
        const mtime = integer(request.headers.get("X-Mtime") ?? Date.now(), "X-Mtime");
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
        validatePath(filePath);
        const baseRev = integer(request.headers.get("X-Base-Rev") ?? "0", "X-Base-Rev", 0, Number.MAX_SAFE_INTEGER - 1);

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
        const body = await readObject(request);
        if (!body || typeof body.from !== "string" || !body.from ||
            typeof body.to !== "string" || !body.to || body.from === body.to || body.base_rev == null) {
          return errorResponse(400, "invalid_rename", "Body must include from, to, and base_rev");
        }

        validatePath(body.from);
        validatePath(body.to);
        if (typeof body.base_rev !== "number") throw new InvalidInput("base_rev must be a JSON integer");
        const baseRev = integer(body.base_rev, "base_rev", 0, Number.MAX_SAFE_INTEGER - 1);
        const newDst = await renameFile(env.DB, body.from, body.to, baseRev, deviceName);
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
        const limit = integer(url.searchParams.get("limit") ?? "200", "limit", 1, 500);
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
        const body = await readObject(request);
        if (!body) return errorResponse(400, "invalid_body", "Expected a JSON object");
        // Policy: explicit whole days, inclusive 0..36500 (~100 years).
        if (typeof body.days !== "number") throw new InvalidInput("days must be a JSON integer");
        const days = integer(body.days, "days", 0, 36500);
        await setRetentionDays(env.DB, days);
        return jsonResponse({ days });
      }

      return errorResponse(404, "not_found", `Route ${request.method} ${path} not found`);
    } catch (err: unknown) {
      if (err instanceof InvalidInput) return errorResponse(400, "invalid_input", err.message);
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
