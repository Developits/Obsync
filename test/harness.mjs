// In-process test harness for Cloudflare Worker + D1 + R2 and multi-device simulation.
// Zero network overhead, zero external dependencies, 100% standard library.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import worker from "../server/src/index.ts";
import { SyncClient } from "../plugin/src/api.ts";
import { LocalIndex } from "../plugin/src/index-store.ts";
import { SyncEngine } from "../plugin/src/sync-engine.ts";
import { normalizePath } from "../plugin/src/paths.ts";

export function createMockD1(schemaPath) {
  const db = new DatabaseSync(":memory:");
  const schemaSql = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schemaSql);

  function wrapStmt(sql, boundArgs = []) {
    return {
      bind(...args) {
        return wrapStmt(sql, args);
      },
      async first() {
        const stmt = db.prepare(sql);
        const row = stmt.get(...boundArgs);
        return row || null;
      },
      async all() {
        const stmt = db.prepare(sql);
        const rows = stmt.all(...boundArgs);
        return { results: rows || [] };
      },
      async run() {
        const stmt = db.prepare(sql);
        stmt.run(...boundArgs);
        return { success: true };
      },
      _sql: sql,
      _args: boundArgs,
    };
  }

  return {
    prepare(sql) {
      return wrapStmt(sql);
    },
    async batch(stmts) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const s of stmts) {
          const stmt = db.prepare(s._sql);
          // For INSERT/UPDATE with RETURNING, or SELECT, use all()
          if (/RETURNING|SELECT/i.test(s._sql)) {
            const rows = stmt.all(...s._args);
            results.push({ results: rows });
          } else {
            stmt.run(...s._args);
            results.push({ success: true });
          }
        }
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

export function createMockR2() {
  const store = new Map();

  return {
    async head(key) {
      const item = store.get(key);
      if (!item) return null;
      return { size: item.size };
    },
    async put(key, data, opts = {}) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      store.set(key, {
        data: buf,
        size: buf.byteLength,
        httpMetadata: opts.httpMetadata || {},
      });
      return { key, size: buf.byteLength };
    },
    async get(key, opts = {}) {
      const item = store.get(key);
      if (!item) return null;

      let buf = item.data;
      if (opts.range) {
        const offset = opts.range.offset || 0;
        const length = opts.range.length ?? buf.byteLength - offset;
        buf = buf.subarray(offset, offset + length);
      }

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      });

      return {
        key,
        size: item.size,
        body: stream,
        async arrayBuffer() {
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
      };
    },
    _store: store,
  };
}

export class FakeVault {
  constructor() {
    this.files = new Map();
  }

  async read(filePath) {
    const norm = normalizePath(filePath);
    const buf = this.files.get(norm);
    if (!buf) throw new Error(`File not found: ${norm}`);
    return buf.toString("utf-8");
  }

  async readBinary(filePath) {
    const norm = normalizePath(filePath);
    const buf = this.files.get(norm);
    if (!buf) throw new Error(`File not found: ${norm}`);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  async write(filePath, text) {
    const norm = normalizePath(filePath);
    this.files.set(norm, Buffer.from(text, "utf-8"));
  }

  async writeBinary(filePath, data) {
    const norm = normalizePath(filePath);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.files.set(norm, buf);
  }

  async remove(filePath) {
    const norm = normalizePath(filePath);
    this.files.delete(norm);
  }

  async rename(from, to) {
    const nFrom = normalizePath(from);
    const nTo = normalizePath(to);
    const val = this.files.get(nFrom);
    if (!val) throw new Error(`Cannot rename missing: ${nFrom}`);
    this.files.set(nTo, val);
    this.files.delete(nFrom);
  }

  async exists(filePath) {
    const norm = normalizePath(filePath);
    return this.files.has(norm);
  }

  async mkdir(dirPath) {
    // In-memory map automatically creates hierarchy
  }

  async stat(filePath) {
    const norm = normalizePath(filePath);
    const buf = this.files.get(norm);
    if (!buf) return null;
    return { mtime: Date.now(), size: buf.byteLength };
  }

  async listFiles() {
    return Array.from(this.files.keys());
  }
}

export async function createTestServer() {
  const schemaPath = path.resolve("server/schema.sql");
  const db = createMockD1(schemaPath);
  const bucket = createMockR2();
  const env = { DB: db, BUCKET: bucket };

  // Dispatch requests directly to worker.fetch
  async function dispatch(reqUrl, options = {}) {
    const req = new Request(reqUrl, options);
    return await worker.fetch(req, env);
  }

  // Mint bootstrap token
  const bootstrapResp = await dispatch("http://test.local/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "admin" }),
  });
  const { token: adminToken } = await bootstrapResp.json();

  return {
    env,
    dispatch,
    adminToken,
    async mintToken(name) {
      const resp = await dispatch("http://test.local/v1/tokens", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      });
      const data = await resp.json();
      return data.token;
    },
  };
}

export function createTestDevice(server, deviceName, token) {
  const vault = new FakeVault();
  const indexStorage = {
    async read(p) {
      return vault.exists(p).then((ex) => (ex ? vault.read(p) : null));
    },
    async write(p, data) {
      return vault.write(p, data);
    },
  };

  const index = new LocalIndex(indexStorage, ".index/sync-state.json");

  // Client that uses server.dispatch
  const client = new SyncClient("http://test.local", token, deviceName);
  // Monkey-patch request in client to route to server.dispatch
  client.request = async (method, endpoint, opts = {}) => {
    const fullUrl = `http://test.local/v1${endpoint}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      "X-Device": deviceName,
      ...(opts.headers || {}),
    };

    const resp = await server.dispatch(fullUrl, {
      method,
      headers,
      body: opts.body,
    });

    const headerMap = {};
    resp.headers.forEach((val, key) => {
      headerMap[key.toLowerCase()] = val;
    });

    return client.handleResponse({
      status: resp.status,
      headers: headerMap,
      json: async () => resp.json(),
      arrayBuffer: async () => resp.arrayBuffer(),
    });
  };

  const conflicts = [];
  const logs = [];

  const engine = new SyncEngine({
    adapter: vault,
    index,
    client,
    deviceName,
    excludes: [".index"],
    onConflict: (orig, conflict) => conflicts.push({ orig, conflict }),
    onLog: (msg) => logs.push(msg),
  });

  return {
    name: deviceName,
    vault,
    index,
    client,
    engine,
    conflicts,
    logs,
    async edit(filePath, text) {
      const norm = normalizePath(filePath);
      await vault.write(norm, text);
      const known = index.get(norm);
      index.set(norm, {
        base_rev: known?.base_rev ?? 0,
        base_hash: known?.base_hash ?? "",
        local_hash: "",
        mtime: Date.now(),
        dirty: true,
      });
    },
    async editBinary(filePath, data) {
      const norm = normalizePath(filePath);
      await vault.writeBinary(norm, data);
      const known = index.get(norm);
      index.set(norm, {
        base_rev: known?.base_rev ?? 0,
        base_hash: known?.base_hash ?? "",
        local_hash: "",
        mtime: Date.now(),
        dirty: true,
      });
    },
    async delete(filePath) {
      const norm = normalizePath(filePath);
      await vault.remove(norm);
      const known = index.get(norm);
      if (known) {
        index.set(norm, { ...known, dirty: true });
      }
    },
    async rename(from, to) {
      const nFrom = normalizePath(from);
      const nTo = normalizePath(to);
      await vault.rename(nFrom, nTo);
      const known = index.get(nFrom);
      if (known && known.base_rev > 0) {
        index.queueRename({ from: nFrom, to: nTo, base_rev: known.base_rev });
        index.set(nTo, { ...known, dirty: known.dirty ?? false });
        index.remove(nFrom);
      }
    },
    async sync() {
      return await engine.sync();
    },
  };
}
