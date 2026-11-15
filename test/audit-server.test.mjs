// Audit: server-side concurrency safety for PUT / DELETE / POST /v1/rename.
//
// Targets the read-then-write (TOCTOU) pattern in server/src/db.ts:
//   writeFile  : getFile() -> compare base_rev -> getNextSeq() -> db.batch()      (db.ts:134-204)
//   deleteFile : getFile() -> compare base_rev -> getNextSeq() -> db.batch()      (db.ts:215-285)
//   renameFile : getFile(from) -> compare base_rev -> getFile(to) -> 2x getNextSeq()
//                -> db.batch()                                                     (db.ts:301-401)
// The check and the write are separated by awaits, so two requests that read the same
// pre-write snapshot both pass the check and both commit. In production those requests
// run in different Worker isolates against the same D1 primary, which is exactly the
// schedule modelled here. The in-process mock only interleaves at some await points, so
// `installReadBarrier` forces the deterministic "both read before either writes" order.
// It delays reads only - all writes below are executed by the real worker code.
//
// Expected behaviour is grounded in README.md:24 ("The server never silently overwrites
// files. Atomic compare-and-swap checks base_rev.") and README.md:30 ("Renames are
// first-class atomic metadata operations with tombstones for old paths.").
//
// Run: node --experimental-strip-types test/audit-server.test.mjs
// On 929dfe0: 2 pass (CONTROL, ORDERING), 6 fail. Failing tests list every violated
// invariant together, with the observed state in the test diagnostic.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTestServer } from "./harness.mjs";

const BASE = "http://test.local";
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Wrap a mock D1 so the first `count` reads of `files WHERE path = ?` for `path` are
 * held until all have arrived, then released together. Models two Worker isolates that
 * both read the pre-write snapshot before either CAS write lands.
 */
function installReadBarrier(db, { path, count, timeoutMs = 1500 }) {
  let arrivals = 0;
  let open = false;
  const waiters = [];

  function gate() {
    if (open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      waiters.push(resolve);
      arrivals++;
      if (arrivals === 1) {
        const timer = setTimeout(() => {
          if (!open) {
            reject(new Error(`read barrier timeout on ${path}: only ${arrivals}/${count} readers arrived`));
          }
        }, timeoutMs);
        timer.unref?.();
      }
      if (arrivals >= count) {
        open = true;
        for (const r of waiters) r();
      }
    });
  }

  const wrap = (stmt) => ({
    _sql: stmt._sql,
    _args: stmt._args,
    bind: (...args) => wrap(stmt.bind(...args)),
    first: async () => {
      if (stmt._sql.includes("FROM files WHERE path = ?") && stmt._args[0] === path) {
        await gate();
      }
      return stmt.first();
    },
    all: () => stmt.all(),
    run: () => stmt.run(),
  });

  return {
    prepare: (sql) => wrap(db.prepare(sql)),
    batch: (stmts) => db.batch(stmts),
  };
}

async function withBarrier(server, path, count, fn) {
  const original = server.env.DB;
  server.env.DB = installReadBarrier(original, { path, count });
  try {
    return await fn();
  } finally {
    server.env.DB = original;
  }
}

function api(server, token) {
  const headers = (extra = {}) => ({
    Authorization: `Bearer ${token}`,
    "X-Device": "audit",
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
    async changes(since = 0, limit = 500) {
      const res = await server.dispatch(`${BASE}/v1/changes?since=${since}&limit=${limit}`, {
        headers: headers(),
      });
      assert.equal(res.status, 200, "changes endpoint");
      return res.json();
    },
  };
}

async function row(server, path) {
  return (await server.env.DB
    .prepare("SELECT path, rev, seq, hash, deleted, size, renamed_from FROM files WHERE path = ?")
    .bind(path)
    .first()) ?? null;
}

async function revisions(server, path) {
  return (await server.env.DB
    .prepare("SELECT path, rev, hash, seq FROM revisions WHERE path = ? ORDER BY rev")
    .bind(path)
    .all()).results ?? [];
}

async function readAck(res) {
  const body = await res.json();
  return { status: res.status, ...body };
}

/**
 * Invariants every acknowledged (200) mutation must satisfy:
 *  1. its exact change appears in /v1/changes (acknowledged changes are never reordered
 *     away or replaced by an earlier seq);
 *  2. `files` is that change (no regression to an older seq);
 *  3. `GET /v1/file?rev=` serves the content the ack advertised.
 */
async function ackViolations(server, client, acks, changes) {
  const found = [];
  for (const ack of acks.filter((a) => a.status === 200)) {
    const tag = `${ack.path}@rev${ack.rev}/seq${ack.seq}`;
    const entry = changes.entries.find((e) => e.path === ack.path && e.seq === ack.seq);
    if (!entry) {
      found.push(`${tag}: acked change is absent from /v1/changes (seq was overwritten/reordered)`);
    } else {
      if (entry.rev !== ack.rev) found.push(`${tag}: changelog says rev ${entry.rev}`);
      if (entry.deleted !== Boolean(ack.deleted)) found.push(`${tag}: changelog says deleted=${entry.deleted}`);
      if ((entry.hash ?? "") !== (ack.hash ?? "")) found.push(`${tag}: changelog hash differs from ack`);
    }

    const current = await row(server, ack.path);
    if (!current) {
      found.push(`${tag}: no files row`);
    } else if (current.seq < ack.seq) {
      found.push(`${tag}: files.seq ${current.seq} regressed below the acked seq ${ack.seq}`);
    } else if (current.seq === ack.seq && current.rev !== ack.rev) {
      found.push(`${tag}: files.rev ${current.rev}`);
    }

    const got = await client.get(ack.path, ack.rev);
    if (ack.deleted) {
      if (got.status !== 404) found.push(`${tag}: acked tombstone, GET ?rev=${ack.rev} returned ${got.status}`);
    } else {
      if (got.status !== 200) {
        found.push(`${tag}: acked live content, GET ?rev=${ack.rev} returned ${got.status}`);
      } else {
        const hash = sha256(Buffer.from(await got.arrayBuffer()));
        if (hash !== ack.hash) found.push(`${tag}: GET ?rev=${ack.rev} returns hash ${hash.slice(0, 12)}, ack says ${String(ack.hash).slice(0, 12)}`);
      }
    }
  }

  // Two acks for the same (path, rev) with different content cannot both be true.
  const byRev = new Map();
  for (const ack of acks.filter((a) => a.status === 200)) {
    const k = `${ack.path}#${ack.rev}`;
    const prev = byRev.get(k);
    if (prev && (prev.hash ?? "") !== (ack.hash ?? "")) {
      found.push(`${k}: two 200 acks claim different hashes (${String(prev.hash).slice(0, 12)} vs ${String(ack.hash).slice(0, 12)})`);
    }
    byRev.set(k, ack);
  }
  return found;
}

test("CONTROL: concurrent distinct paths succeed; a sequential stale base_rev is rejected", async () => {
  const server = await createTestServer();
  const token = await server.mintToken("control");
  const c = api(server, token);

  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, i) => c.put(`parallel/${i}.md`, `body-${i}`, 0))
  );
  const bodies = await Promise.all(responses.map((r) => r.json()));
  assert.deepEqual(responses.map((r) => r.status), Array(8).fill(200));
  assert.equal(new Set(bodies.map((b) => b.seq)).size, 8, "seq must be unique per change");

  // The CAS itself works when the reads do not overlap.
  const stale = await c.put("parallel/0.md", "rewrite", 0);
  assert.equal(stale.status, 409, "sequential stale base_rev must be rejected");
  const fresh = await c.put("parallel/0.md", "rewrite", 1);
  assert.equal(fresh.status, 200);
});

test("BUG 1: two PUTs with the same base_rev must not both commit (lost update)", async (t) => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("a");
  const tokenB = await server.mintToken("b");
  const a = api(server, tokenA);
  const b = api(server, tokenB);

  await a.put("race.md", "BASE", 0); // rev 1

  const [ra, rb] = await withBarrier(server, "race.md", 2, () =>
    Promise.all([a.put("race.md", "AAA", 1), b.put("race.md", "BBB", 1)])
  );
  const acks = [await readAck(ra), await readAck(rb)];
  const files = await row(server, "race.md");
  const revs = await revisions(server, "race.md");
  const changes = await a.changes();

  t.diagnostic("acks:      " + JSON.stringify(acks));
  t.diagnostic("files row: " + JSON.stringify(files));
  t.diagnostic("revisions: " + JSON.stringify(revs));
  t.diagnostic("changes:   " + JSON.stringify(changes.entries));

  const violations = [];
  const codes = acks.map((x) => x.status).sort((x, y) => x - y);
  if (codes[0] !== 200 || codes[1] !== 409) {
    violations.push(`expected [200,409] (stale base_rev must conflict), got [${codes}]`);
  }
  violations.push(...await ackViolations(server, a, acks, changes));

  const rev2 = revs.filter((r) => r.rev === 2);
  if (revs.length !== 2 || rev2.length > 1) violations.push(`revision history is not linear: ${JSON.stringify(revs)}`);
  if (rev2.length === 1 && files && rev2[0].hash !== files.hash) {
    violations.push(`(path, rev 2) resolves to two contents: revisions=${rev2[0].hash.slice(0, 12)} files=${String(files.hash).slice(0, 12)}`);
  }
  assert.deepEqual(violations, []);
});

test("BUG 2: PUT racing DELETE at the same base_rev must not create two states for one rev", async (t) => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("a");
  const tokenB = await server.mintToken("b");
  const a = api(server, tokenA);
  const b = api(server, tokenB);

  await a.put("dp.md", "v1", 0); // rev 1

  const [rp, rd] = await withBarrier(server, "dp.md", 2, () =>
    Promise.all([a.put("dp.md", "v2", 1), b.del("dp.md", 1)])
  );
  const acks = [await readAck(rp), await readAck(rd)];
  const files = await row(server, "dp.md");
  const revs = await revisions(server, "dp.md");
  const changes = await a.changes();

  t.diagnostic("acks:      " + JSON.stringify(acks));
  t.diagnostic("files row: " + JSON.stringify(files));
  t.diagnostic("revisions: " + JSON.stringify(revs));
  t.diagnostic("changes:   " + JSON.stringify(changes.entries.filter((e) => e.path === "dp.md")));

  const violations = [];
  const codes = acks.map((x) => x.status).sort((x, y) => x - y);
  if (codes[0] !== 200 || codes[1] !== 409) {
    violations.push(`expected [200,409] (one of PUT/DELETE must conflict), got [${codes}]`);
  }
  violations.push(...await ackViolations(server, a, acks, changes));

  const live = changes.entries.find((e) => e.path === "dp.md" && e.seq === files.seq);
  if (live && live.deleted !== Boolean(files.deleted)) {
    violations.push(`changelog/file divergence for dp.md@seq${files.seq}`);
  }
  const rev2 = revs.filter((r) => r.rev === 2);
  if (rev2.length === 1 && files.deleted === 0 && rev2[0].hash === null) {
    violations.push("current live rev 2 has a NULL hash in revisions (content not reachable by rev)");
  }
  assert.deepEqual(violations, []);
});

test("BUG 3: two renames of one source must not fork the file into two live destinations", async (t) => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("a");
  const tokenB = await server.mintToken("b");
  const a = api(server, tokenA);
  const b = api(server, tokenB);

  await a.put("src.md", "SRC", 0); // rev 1

  const [r1, r2] = await withBarrier(server, "src.md", 2, () =>
    Promise.all([a.rename("src.md", "dst-a.md", 1), b.rename("src.md", "dst-b.md", 1)])
  );
  const acks = [await readAck(r1), await readAck(r2)];
  const changes = await a.changes();
  const live = changes.entries.filter((e) => !e.deleted && (e.path === "dst-a.md" || e.path === "dst-b.md"));

  t.diagnostic("acks:    " + JSON.stringify(acks));
  t.diagnostic("src row: " + JSON.stringify(await row(server, "src.md")));
  t.diagnostic("changes: " + JSON.stringify(changes.entries.filter((e) => /src|dst-/.test(e.path))));

  const violations = [];
  const codes = acks.map((x) => x.status).sort((x, y) => x - y);
  if (codes[0] !== 200 || codes[1] !== 409) {
    violations.push(`expected [200,409] (second rename sees advanced source rev), got [${codes}]`);
  }
  if (live.length !== 1) violations.push(`rename forked the file: ${live.length} live destinations (${live.map((e) => e.path)})`);
  if ((await row(server, "src.md")).deleted !== 1) violations.push("source is not tombstoned");
  violations.push(...await ackViolations(server, a, acks, changes));
  assert.deepEqual(violations, []);
});

test("BUG 4: rename racing a write to the source must not swallow the acked write", async (t) => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("a");
  const tokenB = await server.mintToken("b");
  const a = api(server, tokenA);
  const b = api(server, tokenB);

  await a.put("mv.md", "OLD", 0); // rev 1

  const [rr, rw] = await withBarrier(server, "mv.md", 2, () =>
    Promise.all([a.rename("mv.md", "moved.md", 1), b.put("mv.md", "NEW", 1)])
  );
  const acks = [await readAck(rr), await readAck(rw)];
  const src = await row(server, "mv.md");
  const dst = await row(server, "moved.md");
  const changes = await a.changes();

  t.diagnostic("acks:    " + JSON.stringify(acks));
  t.diagnostic("src row: " + JSON.stringify(src));
  t.diagnostic("dst row: " + JSON.stringify(dst));
  t.diagnostic("changes: " + JSON.stringify(changes.entries.filter((e) => /mv\.md|moved\.md/.test(e.path))));

  const violations = [];
  const codes = acks.map((x) => x.status).sort((x, y) => x - y);
  if (codes[0] !== 200 || codes[1] !== 409) {
    violations.push(`expected [200,409] (rename and write to the same base_rev must serialize), got [${codes}]`);
  }
  violations.push(...await ackViolations(server, a, acks, changes));

  const put = acks.find((x) => x.status === 200 && !x.deleted && x.path === "mv.md");
  const ren = acks.find((x) => x.status === 200 && x.path === "moved.md");
  if (put && src.deleted === 1) violations.push("PUT was acknowledged but its path is now tombstoned");
  if (put && src.deleted === 0 && src.hash !== put.hash) violations.push("PUT was acknowledged but its content was discarded");
  if (ren && (src.deleted !== 1 || dst?.hash !== ren.hash)) {
    violations.push("rename was acknowledged but source/destination do not reflect it");
  }
  assert.deepEqual(violations, []);
});

test("BUG 5: rename racing a create at the destination must not lose the renamed content", async (t) => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("a");
  const tokenB = await server.mintToken("b");
  const a = api(server, tokenA);
  const b = api(server, tokenB);

  await a.put("from.md", "FROM", 0); // rev 1

  // Both read the destination as absent before either writes.
  const [rr, rw] = await withBarrier(server, "to.md", 2, () =>
    Promise.all([a.rename("from.md", "to.md", 1), b.put("to.md", "OTHER", 0)])
  );
  const acks = [await readAck(rr), await readAck(rw)];
  const src = await row(server, "from.md");
  const dst = await row(server, "to.md");
  const changes = await a.changes();

  t.diagnostic("acks:    " + JSON.stringify(acks));
  t.diagnostic("src row: " + JSON.stringify(src));
  t.diagnostic("dst row: " + JSON.stringify(dst));
  t.diagnostic("changes: " + JSON.stringify(changes.entries.filter((e) => /from\.md|^to\.md/.test(e.path))));

  const violations = [];
  const codes = acks.map((x) => x.status).sort((x, y) => x - y);
  if (codes[0] !== 200 || codes[1] !== 409) {
    violations.push(`expected [200,409] (destination create/rename must serialize), got [${codes}]`);
  }
  violations.push(...await ackViolations(server, a, acks, changes));

  const ren = acks.find((x) => x.status === 200 && x.path === "to.md" && x.deleted === false && x.hash);
  const put = acks.find((x) => x.status === 200 && x.path === "to.md");
  if (ren && dst?.hash !== ren.hash) violations.push("rename acked but the destination holds different content");
  if (ren && src.deleted !== 1) violations.push("rename acked but the source is still live");
  const live = changes.entries.filter((e) => !e.deleted && (e.path === "from.md" || e.path === "to.md"));
  if (live.length !== 1) violations.push(`expected exactly one live path, found ${live.map((e) => e.path)}`);
  if (put && put.path === "to.md" && dst?.hash !== put.hash) violations.push("PUT acked but its content is not at the destination");
  assert.deepEqual(violations, []);
});

test("ORDERING: rename change (destination) precedes source tombstone, incl. pagination", async () => {
  const server = await createTestServer();
  const token = await server.mintToken("ord");
  const c = api(server, token);

  await c.put("A.md", "content-A", 0);
  assert.equal((await c.rename("A.md", "B.md", 1)).status, 200);

  const all = [];
  let since = 0;
  let hasMore = true;
  for (let pages = 0; hasMore && pages < 10; pages++) {
    const page = await c.changes(since, 1);
    all.push(...page.entries);
    since = page.next_seq;
    hasMore = page.has_more;
  }

  const dstEntry = all.find((e) => e.path === "B.md" && !e.deleted);
  const srcEntry = all.find((e) => e.path === "A.md" && e.deleted);
  assert.ok(dstEntry, "destination change missing from changelog");
  assert.ok(srcEntry, "source tombstone missing from changelog");
  assert.ok(dstEntry.seq < srcEntry.seq,
    `destination seq ${dstEntry.seq} must precede source tombstone seq ${srcEntry.seq}`);
  assert.equal(srcEntry.rev, 2, "tombstone rev must be source rev + 1");

  assert.equal((await row(server, "A.md")).deleted, 1);
  assert.equal((await row(server, "B.md")).deleted, 0);
  const got = await c.get("B.md");
  assert.equal(got.status, 200);
  assert.equal(Buffer.from(await got.arrayBuffer()).toString(), "content-A");
});

test("ORDERING: chained rename racing the first rename must fail as a conflict, not 500", async (t) => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("a");
  const tokenB = await server.mintToken("b");
  const a = api(server, tokenA);
  const b = api(server, tokenB);

  await a.put("one.md", "ONE", 0);
  const [r1, r2] = await withBarrier(server, "two.md", 2, () =>
    Promise.all([a.rename("one.md", "two.md", 1), b.rename("two.md", "three.md", 1)])
  );
  const acks = [await readAck(r1), await readAck(r2)];
  const rows = await Promise.all(["one.md", "two.md", "three.md"].map((p) => row(server, p)));
  t.diagnostic("acks: " + JSON.stringify(acks));
  t.diagnostic("rows: " + JSON.stringify(rows));

  const violations = [];
  const codes = acks.map((x) => x.status).sort((x, y) => x - y);
  if (codes[0] !== 200 || codes[1] !== 409) {
    violations.push(`chained rename precondition missing: expected [200,409], got [${codes}] ` +
      `(${acks.find((x) => x.status !== 200)?.error ?? "?"}: ${acks.find((x) => x.status !== 200)?.message ?? ""})`);
  }
  const live = rows.filter((r) => r && r.deleted === 0);
  if (live.length !== 1) violations.push(`expected exactly one live path, found ${live.map((r) => r.path)}`);
  assert.deepEqual(violations, []);
});
