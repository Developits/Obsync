// Client review blockers and remaining audit items (B1/B2/C3/B3/N3/M2/M1/N4).
// All tests are in-process: Worker + D1 + R2 stubs from test/harness.mjs, no network.
// Each test documents the concrete regression it locks down.

import test from "node:test";
import assert from "node:assert/strict";
import { createTestServer, createTestDevice, FakeVault } from "./harness.mjs";
import { LocalIndex } from "../plugin/src/index-store.ts";
import { SyncEngine } from "../plugin/src/sync-engine.ts";

const decode = (buf) => new TextDecoder().decode(buf);
const texts = async (vault) => {
  const out = {};
  for (const p of await vault.listFiles()) out[p] = await vault.read(p);
  return out;
};

async function pair() {
  const server = await createTestServer();
  return {
    server,
    a: createTestDevice(server, "laptop", await server.mintToken("device-a")),
    b: createTestDevice(server, "phone", await server.mintToken("device-b")),
  };
}

// ---------------------------------------------------------------------------
// B1: a reused rename source is new local bytes, not the renamed identity.
// ---------------------------------------------------------------------------

test("B1: rename ack + tombstone echo must not remove a new file at the reused source path", async (t) => {
  const { a, b } = await pair();
  await a.edit("Reuse.md", "original body");
  await a.sync();

  // Rename the old note, then create an unrelated note at the vacated path
  // before the queued rename/ack round-trips to the server.
  await a.rename("Reuse.md", "Moved.md");
  await a.edit("Reuse.md", "brand new note at the reused path");

  const first = await a.sync();
  const afterFirst = await texts(a.vault);
  t.diagnostic(`first=${JSON.stringify(first)} vault=${JSON.stringify(afterFirst)}`);

  assert.equal(afterFirst["Reuse.md"], "brand new note at the reused path",
    "tombstone echo deleted local bytes that were never part of the renamed identity");
  assert.equal(afterFirst["Moved.md"], "original body", "renamed copy must survive");

  // The new file must still be tracked and reach the server on a later cycle.
  await a.sync();
  const serverNew = await b.client.getFile("Reuse.md");
  const serverMoved = await b.client.getFile("Moved.md");
  t.diagnostic(`server Reuse=\"${decode(serverNew.data)}\" Moved=\"${decode(serverMoved.data)}\"`);

  assert.equal(decode(serverNew.data), "brand new note at the reused path");
  assert.equal(decode(serverMoved.data), "original body");
  assert.equal(a.index.get("Reuse.md")?.dirty, false);
});

test("B1 control: an ordinary remote deletion still removes the tracked local file", async () => {
  const { a, b } = await pair();
  await a.edit("Gone.md", "delete me");
  await a.sync();
  await b.sync();
  await a.delete("Gone.md");
  await a.sync();

  await b.sync();
  assert.equal(await b.vault.exists("Gone.md"), false);
});

// ---------------------------------------------------------------------------
// B2 / C3: follow a remote rename only with proven tracked lineage.
// ---------------------------------------------------------------------------

test("B2/C3: unrelated untracked note at the source path is not adopted by remote rename", async (t) => {
  const { a, b } = await pair();
  await a.edit("Remote.md", "remote original");
  await a.sync();
  await a.rename("Remote.md", "Final.md");
  await a.sync();

  // This device never synced Remote.md; its bytes are an independent note.
  await b.edit("Remote.md", "unrelated local note");
  const res = await b.sync();
  const vault = await texts(b.vault);
  t.diagnostic(`res=${JSON.stringify(res)} vault=${JSON.stringify(vault)}`);

  assert.equal(vault["Remote.md"], "unrelated local note",
    "untracked bases (base_rev 0) must never be adopted as rename lineage");
  assert.equal(vault["Final.md"], "remote original", "remote rename destination still arrives");
});

test("B2: tracked entry with a different base content is not followed as rename lineage", async (t) => {
  const { a, b } = await pair();
  await a.edit("Tracked.md", "v1");
  await a.sync();
  await b.sync(); // b tracks Tracked.md at v1

  // Server content moved on before the rename, so b's base is not the rename base.
  await a.edit("Tracked.md", "v2");
  await a.sync();
  await a.rename("Tracked.md", "TrackedFinal.md");
  await a.sync();

  const res = await b.sync();
  const vault = await texts(b.vault);
  t.diagnostic(`res=${JSON.stringify(res)} vault=${JSON.stringify(vault)}`);

  assert.equal(vault["TrackedFinal.md"], "v2", "destination content must be pulled normally");
  assert.equal(vault["Tracked.md"], "v1",
    "local base bytes must not be renamed over the destination when lineage is unproven");
  const revived = await a.client.getFile("Tracked.md");
  assert.equal(decode(revived.data), "v1", "preserved bytes must be re-uploaded, not left in limbo");
});

// ---------------------------------------------------------------------------
// N3: edit during download / merge must not be overwritten by a stale snapshot.
// ---------------------------------------------------------------------------

test("N3: edit made while a clean 3-way merge downloads must survive", async (t) => {
  const { a, b } = await pair();
  const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven";
  await a.edit("Merge.md", base);
  await a.sync();
  await b.sync();

  await b.edit("Merge.md", base.replace("two", "two-LOCAL"));
  await a.edit("Merge.md", base.replace("six", "six-SERVER"));
  await a.sync();

  const getFile = b.client.getFile.bind(b.client);
  let injected = false;
  b.client.getFile = async (...args) => {
    const response = await getFile(...args);
    if (!injected) {
      injected = true;
      await b.vault.write("Merge.md", "typed while merge downloads");
    }
    return response;
  };

  const first = await b.sync();
  const afterFirst = await texts(b.vault);
  t.diagnostic(`first=${JSON.stringify(first)} vault=${JSON.stringify(afterFirst)}`);
  assert.equal(afterFirst["Merge.md"], "typed while merge downloads",
    "stale merge write clobbered bytes typed while the merge was in flight");

  await b.sync(); // retry with a fresh local snapshot
  await b.sync();
  const final = await texts(b.vault);
  t.diagnostic(`final=${JSON.stringify(final)}`);
  assert.ok(Object.values(final).includes("typed while merge downloads"));
  assert.ok(Object.values(final).some((text) => text.includes("six-SERVER")),
    "remote version must be preserved (file or conflict copy)");
});

// ---------------------------------------------------------------------------
// M2: base_path/base_rev pairing.
// ---------------------------------------------------------------------------

test("M2: push reconciliation uses the original base path, not the stale destination revision", async (t) => {
  const { a, b } = await pair();
  const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven";

  // Make the destination path exist as a tombstone first, so the rename
  // publishes the destination at a revision unrelated to the source revision.
  await a.edit("Y.md", "stale old Y");
  await a.sync();
  await a.delete("Y.md");
  await a.sync();
  await a.edit("X.md", base);
  await a.sync();
  await b.sync();

  await a.rename("X.md", "Y.md");
  await a.sync();

  // Dirty before the pull so the rename is followed with the paired base
  // (base_path X, base_rev 1) instead of being accepted at the destination rev.
  await b.edit("X.md", base.replace("two", "two-LOCAL"));

  // Remote edit lands after b's pull but before b's conditional push.
  const put = b.client.putFile.bind(b.client);
  let injected = false;
  b.client.putFile = async (...args) => {
    if (!injected) {
      injected = true;
      await a.edit("Y.md", base.replace("six", "six-SERVER"));
      await a.sync();
    }
    return put(...args);
  };

  const res = await b.sync();
  const vault = await texts(b.vault);
  t.diagnostic(`res=${JSON.stringify(res)} vault=${JSON.stringify(vault)}`);

  assert.equal(vault["Y.md"], "one\ntwo-LOCAL\nthree\nfour\nfive\nsix-SERVER\nseven",
    "conflict reconciliation fetched the merge base from Y instead of the paired X base");
  assert.equal(b.conflicts.length, 0, "a clean merge must not create a conflict artifact");

  await b.sync();
  await a.sync();
  assert.equal(await a.vault.read("Y.md"), "one\ntwo-LOCAL\nthree\nfour\nfive\nsix-SERVER\nseven");
});

test("M2: conflict branch clears base_path when it advances to the destination revision", async (t) => {
  const { a, b } = await pair();
  await a.edit("Y.md", "stale old Y");
  await a.sync();
  await a.delete("Y.md");
  await a.sync();
  await a.edit("X.md", "shared line");
  await a.sync();
  await b.sync();

  await a.rename("X.md", "Y.md");
  await a.sync();
  await b.edit("X.md", "local overlapping edit");

  const put = b.client.putFile.bind(b.client);
  let injected = false;
  b.client.putFile = async (...args) => {
    if (!injected) {
      injected = true;
      await a.edit("Y.md", "remote overlapping edit");
      await a.sync();
    }
    return put(...args);
  };

  const res = await b.sync();
  const state = b.index.get("Y.md");
  t.diagnostic(`res=${JSON.stringify(res)} state=${JSON.stringify(state)}`);
  assert.ok(b.conflicts.length >= 1, "overlapping edit must surface a conflict copy");
  assert.equal(state?.base_rev, 4);
  assert.equal(state?.base_path, undefined,
    "base_path must not stay paired with a destination revision");
});

// ---------------------------------------------------------------------------
// M1 / N4: per-file failures are surfaced, do not starve other paths,
// and local index persistence failures are honest.
// ---------------------------------------------------------------------------

test("M1: unreadable local file is reported without aborting unrelated sync", async (t) => {
  const { a, b } = await pair();
  await a.edit("good.md", "good content");
  a.vault.files.set("bad.md", Buffer.from("unreadable secret"));
  a.index.set("bad.md", { base_rev: 0, base_hash: "", local_hash: "", mtime: Date.now(), dirty: true });

  const readBinary = a.vault.readBinary.bind(a.vault);
  a.vault.readBinary = async (path) => {
    if (path === "bad.md") throw new Error("EACCES: unreadable");
    return readBinary(path);
  };

  const res = await a.sync();
  await b.sync();
  t.diagnostic(`res=${JSON.stringify(res)}`);

  assert.equal(await b.vault.read("good.md"), "good content");
  assert.ok(res.failed >= 1, "unreadable path must be counted as failed");
  assert.ok(res.errors.some((e) => e.path === "bad.md"), "failed path must be reported");
  assert.ok(res.pending >= 1, "unreadable path remains pending");
  assert.equal(a.vault.files.get("bad.md").toString("utf-8"), "unreadable secret");
});

test("M1: scan failure blocks destructive incoming writes for that path only", async (t) => {
  const { a, b } = await pair();
  await a.edit("blocked.md", "local bytes that must not be overwritten");
  await a.sync();
  await b.sync();

  // Remote moves on, then the local file becomes unreadable (permissions,
  // locked file, transient I/O). The pull must not overwrite it.
  await b.edit("blocked.md", "remote blocked content");
  await b.edit("other.md", "other content");
  await b.sync();

  const readBinary = a.vault.readBinary.bind(a.vault);
  a.vault.readBinary = async (path) => {
    if (path === "blocked.md") throw new Error("EIO: cannot read");
    return readBinary(path);
  };

  const res = await a.sync();
  t.diagnostic(`res=${JSON.stringify(res)}`);

  assert.equal(a.vault.files.get("blocked.md").toString("utf-8"),
    "local bytes that must not be overwritten");
  assert.equal(await a.vault.read("other.md"), "other content",
    "an unrelated remote path must still be pulled");
  assert.ok(res.failed >= 1);
  assert.ok(res.errors.some((e) => e.path === "blocked.md"));
});

test("N4: LocalIndex.save rejects instead of silently dropping persistence failures", async () => {
  const index = new LocalIndex({
    async read() { return null; },
    async write() { throw new Error("disk full"); },
  }, "state.json");
  index.set("note.md", { base_rev: 0, base_hash: "", local_hash: "", mtime: 1, dirty: true });
  await assert.rejects(() => index.save(), /disk full/);
});

test("N4: index persistence failure is surfaced in the sync result", async (t) => {
  const { a } = await pair();
  await a.edit("persist.md", "content");
  a.index.adapter.write = async () => { throw new Error("state write failed"); };

  const res = await a.sync();
  t.diagnostic(`res=${JSON.stringify(res)}`);
  assert.ok(res.failed >= 1);
  assert.ok(res.errors.some((e) => e.operation === "save"), "save failure must be reported");
});

// ---------------------------------------------------------------------------
// C1 follow-up: conflict preservation must be an exclusive create.
// ---------------------------------------------------------------------------

test("C1: concurrent conflict preservation cannot overwrite the same candidate path", async (t) => {
  const vault = new FakeVault();
  const adapter = {
    read: (p) => vault.read(p),
    readBinary: (p) => vault.readBinary(p),
    write: (p, text) => vault.write(p, text),
    writeBinary: (p, data) => vault.writeBinary(p, data),
    // Exclusive create: check and insert synchronously, like Vault.createBinary.
    createBinary: async (p, data) => {
      if (vault.files.has(p)) throw new Error("File already exists");
      vault.files.set(p, Buffer.from(data));
    },
    remove: (p) => vault.remove(p),
    rename: (from, to) => vault.rename(from, to),
    exists: (p) => vault.exists(p),
    mkdir: (p) => vault.mkdir(p),
    stat: (p) => vault.stat(p),
  };
  const index = new LocalIndex({ async read() { return null; }, async write() {} }, "state.json");
  const engine = new SyncEngine({ adapter, index, client: {}, deviceName: "dev" });
  const data = new TextEncoder().encode("remote payload").buffer;

  const [first, second] = await Promise.all([
    engine.preserveConflict("Note.md", "laptop", data),
    engine.preserveConflict("Note.md", "laptop", data),
  ]);
  const files = await vault.listFiles();
  t.diagnostic(`paths=${JSON.stringify([first, second])} files=${JSON.stringify(files)}`);

  assert.notEqual(first, second, "both writers selected the same conflict path");
  assert.deepEqual(files.filter((p) => p.includes("conflict laptop")).sort(), [first, second].sort());
  assert.equal(await vault.read(first), "remote payload");
  assert.equal(await vault.read(second), "remote payload");
  assert.ok(index.get(first)?.dirty && index.get(second)?.dirty);
});
