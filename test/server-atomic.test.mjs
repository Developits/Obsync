// Focused server metadata-atomicity tests (S2) that complement test/audit-server.test.mjs.
//
// Covers the invariants that are not exercised by the concurrent race audit:
//   - rename lineage (renamed_from) survives later writes at the destination;
//   - a rejected conditional mutation publishes no files/revisions state and
//     consumes no acknowledged sequence entry;
//   - a rename from a missing source is a typed 409 ConflictError, never a 500;
//   - a tombstoned destination is still a legal rename target (rev+1).
//
// Run: node --experimental-strip-types test/server-atomic.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTestServer } from "./harness.mjs";

const BASE = "http://test.local";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function api(server, token) {
  const headers = (extra = {}) => ({
    Authorization: `Bearer ${token}`,
    "X-Device": "atomic",
    ...extra,
  });
  return {
    put(path, body, baseRev) {
      return server.dispatch(`${BASE}/v1/file?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: headers({ "X-Base-Rev": String(baseRev) }),
        body,
      });
    },
    del(path, baseRev) {
      return server.dispatch(`${BASE}/v1/file?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
        headers: headers({ "X-Base-Rev": String(baseRev) }),
      });
    },
    rename(from, to, baseRev) {
      return server.dispatch(`${BASE}/v1/rename`, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ from, to, base_rev: baseRev }),
      });
    },
    get(path, rev) {
      const q = rev == null
        ? `${BASE}/v1/file?path=${encodeURIComponent(path)}`
        : `${BASE}/v1/file?path=${encodeURIComponent(path)}&rev=${rev}`;
      return server.dispatch(q, { headers: headers() });
    },
    async changes(since = 0, limit = 1000) {
      const res = await server.dispatch(`${BASE}/v1/changes?since=${since}&limit=${limit}`, {
        headers: headers(),
      });
      assert.equal(res.status, 200);
      return res.json();
    },
  };
}

async function row(server, path) {
  return (await server.env.DB
    .prepare("SELECT path, rev, seq, hash, deleted, renamed_from FROM files WHERE path = ?")
    .bind(path)
    .first()) ?? null;
}

async function revisions(server, path) {
  return (await server.env.DB
    .prepare("SELECT path, rev, hash, seq FROM revisions WHERE path = ? ORDER BY rev")
    .bind(path)
    .all()).results ?? [];
}

test("rename conflict after a concurrent live source edit reports deleted false", async () => {
  const server = await createTestServer();
  const c = api(server, await server.mintToken("source-state"));
  await c.put("live-source.md", "base", 0);
  const batch = server.env.DB.batch.bind(server.env.DB);
  let injected = false;
  server.env.DB.batch = async (statements) => {
    if (!injected) {
      injected = true;
      assert.equal((await c.put("live-source.md", "live edit", 1)).status, 200);
    }
    return batch(statements);
  };
  const response = await c.rename("live-source.md", "destination.md", 1);
  assert.equal(response.status, 409);
  const conflict = await response.json();
  assert.equal(conflict.server_rev, 2);
  assert.equal(conflict.deleted, false);
  assert.equal((await c.get("live-source.md")).status, 200);
});

test("rename lineage survives a later write at the destination", async () => {
  const server = await createTestServer();
  const c = api(server, await server.mintToken("lineage"));

  assert.equal((await c.put("A.md", "old", 0)).status, 200);
  const renamed = await c.rename("A.md", "B.md", 1);
  assert.equal(renamed.status, 200);

  const wrote = await c.put("B.md", "new", 1);
  assert.equal(wrote.status, 200);
  const ack = await wrote.json();
  assert.equal(ack.rev, 2);

  const dst = await row(server, "B.md");
  assert.equal(dst.rev, 2);
  assert.equal(dst.deleted, 0);
  assert.equal(dst.hash, sha256("new"));
  assert.equal(dst.renamed_from, "A.md", "lineage must not be reset by a later write");

  const revs = await revisions(server, "B.md");
  assert.deepEqual(revs.map((r) => r.rev), [1, 2]);
  assert.equal(revs[0].hash, sha256("old"));
  assert.equal(revs[1].hash, sha256("new"));

  const first = await c.get("B.md", 1);
  assert.equal(first.status, 200);
  assert.equal(Buffer.from(await first.arrayBuffer()).toString(), "old");
  const second = await c.get("B.md", 2);
  assert.equal(second.status, 200);
  assert.equal(Buffer.from(await second.arrayBuffer()).toString(), "new");
});

test("a rejected conditional write publishes no row revision or seq regression", async () => {
  const server = await createTestServer();
  const c = api(server, await server.mintToken("orphan"));

  const created = await c.put("f.md", "one", 0);
  assert.equal(created.status, 200);
  const first = await created.json();

  const stale = await c.put("f.md", "stale", 0);
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.error, "conflict");
  assert.equal(conflict.server_rev, 1);

  const current = await row(server, "f.md");
  assert.equal(current.rev, 1);
  assert.equal(current.seq, first.seq, "a rejected attempt must not republish the path");
  assert.deepEqual((await revisions(server, "f.md")).map((r) => r.rev), [1]);

  const next = await c.put("f.md", "two", 1);
  assert.equal(next.status, 200);
  const second = await next.json();
  assert.ok(second.seq > first.seq, "sequence must keep moving forward");
  assert.deepEqual((await revisions(server, "f.md")).map((r) => r.rev), [1, 2]);

  const changes = await c.changes();
  const entries = changes.entries.filter((e) => e.path === "f.md");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].seq, second.seq);
  assert.equal(entries[0].rev, 2);
});

test("rename from a missing source is a typed 409 conflict, not a 500", async () => {
  const server = await createTestServer();
  const c = api(server, await server.mintToken("missing"));

  const res = await c.rename("ghost.md", "elsewhere.md", 0);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "conflict");
  assert.equal(body.path, "ghost.md");
  assert.equal(body.server_rev, 0);
  assert.equal(await row(server, "elsewhere.md"), null);
  assert.deepEqual(await revisions(server, "elsewhere.md"), []);
});

test("sequence allocation self-heals when the meta counter is missing or behind", async () => {
  const server = await createTestServer();
  const c = api(server, await server.mintToken("seq"));

  // Simulate a database whose files rows predate the seq counter (or a lost row).
  await server.env.DB
    .prepare(
      "INSERT INTO files (path, rev, seq, hash, size, mtime, deleted, folder, updated_by, renamed_from) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, NULL)"
    )
    .bind("old.md", 1, 10, sha256("old"), 3, Date.now(), "seed")
    .run();

  const created = await c.put("new.md", "new", 0);
  assert.equal(created.status, 200);
  const ack = await created.json();
  assert.ok(ack.seq > 10, `seq must resume above the published maximum, got ${ack.seq}`);

  // A stale (behind) counter must also be advanced past published state.
  await server.env.DB.prepare("UPDATE meta SET value = '3' WHERE key = 'seq'").run();
  const next = await c.put("newer.md", "newer", 0);
  assert.equal(next.status, 200);
  assert.ok((await next.json()).seq > ack.seq);

  const changes = await c.changes();
  assert.deepEqual(
    changes.entries.filter((e) => ["old.md", "new.md", "newer.md"].includes(e.path)).length,
    3
  );
});

test("rename over a tombstoned destination advances its rev and records lineage", async () => {
  const server = await createTestServer();
  const c = api(server, await server.mintToken("tomb"));

  assert.equal((await c.put("dst.md", "old", 0)).status, 200);
  assert.equal((await c.del("dst.md", 1)).status, 200); // tombstone at rev 2
  assert.equal((await c.put("src.md", "moved", 0)).status, 200);

  const renamed = await c.rename("src.md", "dst.md", 1);
  assert.equal(renamed.status, 200);
  const ack = await renamed.json();
  assert.equal(ack.rev, 3);

  const dst = await row(server, "dst.md");
  assert.equal(dst.rev, 3);
  assert.equal(dst.deleted, 0);
  assert.equal(dst.hash, sha256("moved"));
  assert.equal(dst.renamed_from, "src.md");

  const revs = await revisions(server, "dst.md");
  assert.deepEqual(revs.map((r) => r.rev), [1, 2, 3]);
  assert.equal(revs[2].hash, sha256("moved"));
  assert.equal(revs[2].seq, ack.seq);

  const got = await c.get("dst.md", 3);
  assert.equal(got.status, 200);
  assert.equal(Buffer.from(await got.arrayBuffer()).toString(), "moved");
});
