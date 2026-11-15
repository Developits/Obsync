// Standalone client-side edge-case audit for plugin/src/sync-engine.ts (+ paths.ts, index-store.ts).
//
// These tests assert the semantics the project documents in README.md:
//   - "No data loss ever"
//   - "Edit beats delete"
//   - "Edit follows rename: Renames are first-class atomic metadata operations with tombstones for old paths."
//   - "Conflict branching ... sibling file: Note (conflict <device> YYYY-MM-DD HH.mm).md"
//
// Production source is deliberately NOT patched: each failing test below is a bug report.
// Run with: node --experimental-strip-types test/audit-client.test.mjs
//
// Only in-process harness (server/src -> node:sqlite + in-memory R2). No network, no remote side effects.

import test from "node:test";
import assert from "node:assert/strict";
import { createTestServer, createTestDevice } from "./harness.mjs";

const decode = (buf) => new TextDecoder().decode(buf);

async function serverText(device, path, rev) {
  const file = await device.client.getFile(path, rev);
  return decode(file.data);
}

async function tryServerText(device, path, rev) {
  try {
    return await serverText(device, path, rev);
  } catch (err) {
    return `<${err.name}: ${err.message}>`;
  }
}

async function vaultTexts(vault) {
  const out = {};
  for (const p of await vault.listFiles()) {
    out[p] = await vault.read(p);
  }
  return out;
}

function pathsContaining(texts, needle) {
  return Object.entries(texts)
    .filter(([, text]) => text.includes(needle))
    .map(([p]) => p);
}

// Deterministic minute bucket for generateConflictPath(), which calls `new Date()` internally.
// Only constructor()/now() are frozen; Date.parse etc. still work.
function freezeClock(iso = "2026-11-15T18:45:00.000Z") {
  const RealDate = globalThis.Date;
  const fixed = new RealDate(iso).getTime();
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FrozenDate;
  return () => {
    globalThis.Date = RealDate;
  };
}

// ---------------------------------------------------------------------------
// A. Offline edit versus rename
// ---------------------------------------------------------------------------

test("AUDIT A1: offline edit + rename must upload the edited content (edit follows rename)", async (t) => {
  const server = await createTestServer();
  const devA = createTestDevice(server, "laptop", await server.mintToken("device-a"));
  const devB = createTestDevice(server, "phone", await server.mintToken("device-b"));

  await devA.edit("Draft.md", "original draft");
  await devA.sync();
  await devB.sync(); // phone is now clean at Draft.md rev 1

  // Laptop goes offline: edits the note, then renames it (Obsidian emits modify, then rename).
  await devA.edit("Draft.md", "OFFLINE EDIT that must survive");
  await devA.rename("Draft.md", "Final.md");

  const res = await devA.sync();
  const state = devA.index.get("Final.md");
  const localFinal = await devA.vault.read("Final.md");
  const serverFinal = await tryServerText(devB, "Final.md");
  const serverDraft = await tryServerText(devB, "Draft.md");

  // Phone pulls whatever the server now advertises for the renamed note.
  await devB.sync();
  const phoneFinal = await tryServerText(devA, "Final.md");

  t.diagnostic(
    `sync=${JSON.stringify(res)} index(Final)={base_rev:${state?.base_rev}, dirty:${state?.dirty}} ` +
      `local="${localFinal}" server@Final="${serverFinal}" server@Draft=${serverDraft} phone="${phoneFinal}"`
  );

  // sync-engine.ts:135-142 overwrites the destination index entry with dirty:false after the
  // rename push, even though the local file was edited before/after the rename.
  assert.equal(
    serverFinal,
    "OFFLINE EDIT that must survive",
    "rename was pushed but the pending local edit was never uploaded; the index was marked clean anyway"
  );
  assert.equal(state?.dirty, false);
  assert.equal(phoneFinal, "OFFLINE EDIT that must survive", "second device must receive the renamed note with the edit");
});

test("AUDIT A1b: rename then edit offline is dropped by the same dirty:false overwrite", async (t) => {
  const server = await createTestServer();
  const devA = createTestDevice(server, "laptop", await server.mintToken("device-a"));
  const devB = createTestDevice(server, "phone", await server.mintToken("device-b"));

  await devA.edit("Plan.md", "plan v1");
  await devA.sync();
  await devB.sync();

  // Reverse event order: rename first, then edit the renamed file while offline.
  await devA.rename("Plan.md", "Plan-2026.md");
  await devA.edit("Plan-2026.md", "OFFLINE EDIT after rename");

  const res = await devA.sync();
  const state = devA.index.get("Plan-2026.md");
  const serverText = await tryServerText(devB, "Plan-2026.md");

  t.diagnostic(
    `sync=${JSON.stringify(res)} index={base_rev:${state?.base_rev}, dirty:${state?.dirty}} server="${serverText}"`
  );

  assert.equal(serverText, "OFFLINE EDIT after rename", "same Phase-2 dirty overwrite loses the edit regardless of event order");
  assert.equal(state?.dirty, false);
});

test("AUDIT A2: rename-dropped offline edit is later overwritten with no conflict artifact", async (t) => {
  const server = await createTestServer();
  const devA = createTestDevice(server, "laptop", await server.mintToken("device-a"));
  const devB = createTestDevice(server, "phone", await server.mintToken("device-b"));

  await devA.edit("Draft.md", "base text");
  await devA.sync();
  await devB.sync();

  // Laptop offline: edit + rename, sync (A1 bug drops the edit).
  await devA.edit("Draft.md", "LOCAL EDIT ONLY");
  await devA.rename("Draft.md", "Final.md");
  await devA.sync();

  // Phone edits the renamed note normally and uploads rev 2.
  await devB.edit("Final.md", "REMOTE v2 from phone");
  await devB.sync();

  // Laptop pulls rev 2. Its index says "clean", so applyRemoteChange() takes the
  // accept-remote branch (sync-engine.ts:270-283) and overwrites the local file.
  const res = await devA.sync();
  const texts = await vaultTexts(devA.vault);
  const serverHistory = [];
  for (let rev = 1; rev <= 4; rev++) serverHistory.push(await tryServerText(devB, "Final.md", rev));
  const survivesOnServer = serverHistory.some((text) => text.includes("LOCAL EDIT ONLY"));
  const survivesInVault = pathsContaining(texts, "LOCAL EDIT ONLY").length > 0;

  t.diagnostic(
    `sync=${JSON.stringify(res)} conflictsNotified=${devA.conflicts.length} ` +
      `vaultFiles=${JSON.stringify(Object.keys(texts))} ` +
      `survives(vault=${survivesInVault}, serverHistory=${survivesOnServer}) history=${JSON.stringify(serverHistory)}`
  );

  // Invariant (README "no data loss ever"): the text must be recoverable from the vault or from
  // server revisions. Because the edit was never uploaded and no conflict copy was made, once the
  // accept-remote branch overwrites the local file the text exists nowhere.
  assert.ok(
    survivesInVault || survivesOnServer,
    "offline edit text is unrecoverable: never uploaded, no conflict copy, silently overwritten locally"
  );
});

test("AUDIT A3: rename on one device + offline edit on the old path must not duplicate the note", async (t) => {
  const server = await createTestServer();
  const devA = createTestDevice(server, "laptop", await server.mintToken("device-a"));
  const devB = createTestDevice(server, "phone", await server.mintToken("device-b"));

  await devA.edit("Draft.md", "Draft text");
  await devA.sync();
  await devB.sync();

  // Laptop renames and publishes the rename (Draft tombstoned, Final created).
  await devA.rename("Draft.md", "Final.md");
  await devA.sync();

  // Phone was offline and edited the OLD path.
  await devB.edit("Draft.md", "phone edits the draft offline");
  const resB = await devB.sync();

  const statsAfterB = await devA.client.stats();
  const phoneHasDraft = await devB.vault.exists("Draft.md");
  const phoneHasFinal = await devB.vault.exists("Final.md");
  const finalText = await tryServerText(devA, "Final.md");
  const draftText = await tryServerText(devA, "Draft.md");

  // Laptop pulls the phone's change: the duplicate propagates to every device.
  await devA.sync();
  const laptopHasDraft = await devA.vault.exists("Draft.md");

  t.diagnostic(
    `resB=${JSON.stringify(resB)} conflicts=${devB.conflicts.length} serverFiles=${statsAfterB.files} ` +
      `phone(Draft=${phoneHasDraft}, Final=${phoneHasFinal}) Final="${finalText}" Draft="${draftText}" ` +
      `laptopHasDraftAfterPull=${laptopHasDraft}`
  );

  // applyRemoteChange() treats the tombstone as "edit beats deletion" because the local entry is
  // dirty, resurrecting the old path (sync-engine.ts:250-261) instead of moving the edit to the
  // rename destination advertised by `renamed_from`.
  const phoneTexts = await vaultTexts(devB.vault);
  const serverRevs = [];
  for (let rev = 1; rev <= 4; rev++) serverRevs.push(await tryServerText(devA, "Final.md", rev));
  const editPreserved = [...Object.values(phoneTexts), ...serverRevs].some((text) =>
    text.includes("phone edits the draft offline")
  );

  assert.equal(phoneHasDraft, false, "edited old path was resurrected as a second active note instead of following the rename");
  assert.equal(statsAfterB.files, 1, "server must expose exactly one active file for the renamed note");
  assert.equal(laptopHasDraft, false, "duplicate leaked back to the device that renamed");
  assert.ok(editPreserved, "offline edit must survive somewhere (renamed note or an explicit conflict copy)");
});

test("AUDIT A4: rename vs rename must not leave a permanently stuck queue and unsent local file", async (t) => {
  const server = await createTestServer();
  const devA = createTestDevice(server, "laptop", await server.mintToken("device-a"));
  const devB = createTestDevice(server, "phone", await server.mintToken("device-b"));

  await devA.edit("Note.md", "Note body");
  await devA.sync();
  await devB.sync();

  await devA.rename("Note.md", "Renamed.md");
  await devA.sync();

  // Phone renames the same note, offline, to a different name.
  await devB.rename("Note.md", "PhoneCopy.md");
  const res1 = await devB.sync();
  const queuedAfter1 = devB.index.getQueuedRenames();
  const res2 = await devB.sync();
  const queuedAfter2 = devB.index.getQueuedRenames();
  const serverCopy = await tryServerText(devA, "PhoneCopy.md");
  const copyOnDisk = await devB.vault.exists("PhoneCopy.md");
  const retryCount = devB.logs.filter((l) => l.includes("Failed to push rename")).length;
  const uploaded = !serverCopy.startsWith("<ApiError") && serverCopy.includes("Note body");
  const reportedConflict = devB.conflicts.length > 0;

  t.diagnostic(
    `res1=${JSON.stringify(res1)} queue1=${JSON.stringify(queuedAfter1)} res2=${JSON.stringify(res2)} ` +
      `queue2=${JSON.stringify(queuedAfter2)} logs=${JSON.stringify(devB.logs.slice(-4))} ` +
      `localPhoneCopy=${copyOnDisk} serverPhoneCopy="${serverCopy}" retries=${retryCount} ` +
      `uploaded=${uploaded} reportedConflict=${reportedConflict}`
  );

  // Phase 2 catches the 500 from the server (source already tombstoned) and only logs; the queued
  // rename and the local-only file are never reconciled (sync-engine.ts:130-153).
  assert.deepEqual(queuedAfter2, [], "failed rename stays queued and is retried forever");
  assert.ok(retryCount <= 1, `rename failure repeats on every sync without recovery (${retryCount} attempts)`);
  assert.ok(
    uploaded || reportedConflict,
    "locally renamed copy is stranded on the device: it is neither uploaded nor surfaced as a conflict"
  );
});

// ---------------------------------------------------------------------------
// B. Local delete versus remote edit
// ---------------------------------------------------------------------------

test("AUDIT B1: local delete + remote edit must restore the note, not throw and wedge sync", async (t) => {
  const server = await createTestServer();
  const devA = createTestDevice(server, "laptop", await server.mintToken("device-a"));
  const devB = createTestDevice(server, "phone", await server.mintToken("device-b"));

  await devA.edit("Important.md", "original important notes");
  await devA.sync();
  await devB.sync();

  // Phone deletes the note locally (plugin records a dirty deletion intent).
  await devB.delete("Important.md");

  // Laptop edits the same note and publishes rev 2.
  await devA.edit("Important.md", "remote edit must win over the phone deletion");
  await devA.sync();

  // Pull order matters: the remote modification arrives before the deletion is pushed, so
  // applyRemoteChange() reaches the "dirty + remote changed" branch and calls readBinary() on a
  // file that no longer exists (sync-engine.ts:286) with no existence guard.
  let err1 = null;
  let res1 = null;
  try {
    res1 = await devB.sync();
  } catch (err) {
    err1 = err;
  }

  let err2 = null;
  try {
    await devB.sync();
  } catch (err) {
    err2 = err;
  }

  const exists = await devB.vault.exists("Important.md");
  const content = exists ? await devB.vault.read("Important.md") : "<missing>";
  const state = devB.index.get("Important.md");

  t.diagnostic(
    `sync1=${JSON.stringify(res1)} err1=${err1 ? `${err1.name}: ${err1.message}` : "none"} ` +
      `err2=${err2 ? `${err2.name}: ${err2.message}` : "none"} exists=${exists} content="${content}" ` +
      `seq=${devB.index.getSeq()} state=${JSON.stringify(state)}`
  );

  assert.equal(err1, null, `sync() threw instead of reconciling the delete/edit race: ${err1?.message}`);
  assert.equal(err2, null, `sync() is wedged and throws again on every retry: ${err2?.message}`);
  assert.equal(exists, true, "remote edit must restore the deleted note locally (edit beats delete)");
  assert.equal(content, "remote edit must win over the phone deletion");
  assert.equal(state?.dirty, false);
  assert.equal(devB.conflicts.length, 0);
});

test("AUDIT B2: deletion discovered by the offline scan + remote edit must not wedge sync", async (t) => {
  const server = await createTestServer();
  const devA = createTestDevice(server, "laptop", await server.mintToken("device-a"));
  const devB = createTestDevice(server, "phone", await server.mintToken("device-b"));

  await devA.edit("Archive.md", "archived notes");
  await devA.sync();
  await devB.sync();

  // Plugin inactive: file removed from disk. Phase 0 (sync-engine.ts:102-108) marks it dirty.
  await devB.vault.remove("Archive.md");

  // Remote edit lands while the phone is still inactive.
  await devA.edit("Archive.md", "archived notes v2");
  await devA.sync();

  let err = null;
  try {
    await devB.sync();
  } catch (e) {
    err = e;
  }

  const exists = await devB.vault.exists("Archive.md");
  const content = exists ? await devB.vault.read("Archive.md") : "<missing>";

  t.diagnostic(
    `err=${err ? `${err.name}: ${err.message}` : "none"} exists=${exists} content="${content}" seq=${devB.index.getSeq()}`
  );

  // Same defect as B1, reached through the documented offline-scan path: a dirty entry with no
  // local file falls into the remote-modification branch and calls readBinary() unguarded.
  assert.equal(err, null, `sync() threw for an offline deletion racing a remote edit: ${err?.message}`);
  assert.equal(exists, true, "remote edit must restore the note (edit beats delete)");
  assert.equal(content, "archived notes v2");
});

// ---------------------------------------------------------------------------
// C. Conflict preservation repeated within the same minute
// ---------------------------------------------------------------------------

test("AUDIT C1: two conflicts on one note within a minute must not overwrite each other", async (t) => {
  const thaw = freezeClock("2026-11-15T18:45:00.000Z");
  try {
    const server = await createTestServer();
    const devA = createTestDevice(server, "laptop", await server.mintToken("device-a"));
    const devB = createTestDevice(server, "phone", await server.mintToken("device-b"));

    await devA.edit("Study.md", "study base");
    await devA.sync();
    await devB.sync();

    // Conflict 1: phone edits offline, laptop publishes rev 2.
    await devB.edit("Study.md", "phone edit 1");
    await devA.edit("Study.md", "remote one");
    await devA.sync();
    await devB.sync(); // conflict copy #1 is written here
    assert.equal(devB.conflicts.length, 1);

    // Phone edits again; laptop publishes rev 4; phone pulls again in the same clock minute.
    await devB.edit("Study.md", "phone edit 2");
    await devA.sync(); // laptop first pulls phone's rev 3, then pushes rev 4
    await devA.edit("Study.md", "remote two");
    await devA.sync();
    const res = await devB.sync(); // conflict copy #2 is written here

    const texts = await vaultTexts(devB.vault);
    const conflictPaths = devB.conflicts.map((c) => c.conflict);
    const preservedOne = pathsContaining(texts, "remote one");
    const preservedTwo = pathsContaining(texts, "remote two");
    const rev2OnServer = await tryServerText(devA, "Study.md", 2);

    t.diagnostic(
      `sync=${JSON.stringify(res)} conflicts=${JSON.stringify(conflictPaths)} ` +
        `vaultFiles=${JSON.stringify(Object.keys(texts))} preserved(remote one)=${JSON.stringify(preservedOne)} ` +
        `preserved(remote two)=${JSON.stringify(preservedTwo)} serverRev2="${rev2OnServer}"`
    );

    // generateConflictPath() has minute granularity and writeBinary() does not check existence
    // (paths.ts:40-61, sync-engine.ts:336-346 / 414-419), so copy #2 clobbers copy #1.
    assert.equal(devB.conflicts.length, 2);
    assert.notEqual(
      devB.conflicts[0].conflict,
      devB.conflicts[1].conflict,
      "second conflict reused the first conflict path and destroyed its contents"
    );
    assert.deepEqual(preservedOne.length, 1, "first remote version must survive as its own conflict copy");
    assert.deepEqual(preservedTwo.length, 1, "second remote version must survive as its own conflict copy");
    // Scope check: the first version is still recoverable from server history, so this is a lost
    // local artifact, not unrecoverable server-side data loss.
    assert.equal(rev2OnServer, "remote one");
  } finally {
    thaw();
  }
});

// ---------------------------------------------------------------------------
// D. Offline scan
// ---------------------------------------------------------------------------

test("AUDIT D1: external offline edit newer than index mtime but within 1s must not be overwritten", async (t) => {
  const server = await createTestServer();
  const devA = createTestDevice(server, "laptop", await server.mintToken("device-a"));
  const devB = createTestDevice(server, "phone", await server.mintToken("device-b"));

  await devA.edit("Diary.md", "diary base");
  await devA.sync();
  await devB.sync();

  // Plugin inactive: file is modified by an external tool. No index update, no Obsidian event.
  await devB.vault.write("Diary.md", "externally edited while plugin was inactive");
  const known = devB.index.get("Diary.md");
  const stat = await devB.vault.stat("Diary.md");

  // Laptop publishes a conflicting rewrite.
  await devA.edit("Diary.md", "remote rewrite");
  await devA.sync();

  const res = await devB.sync();
  const texts = await vaultTexts(devB.vault);
  const survivors = pathsContaining(texts, "externally edited");
  const state = devB.index.get("Diary.md");

  t.diagnostic(
    `stat.mtime-index.mtime=${stat.mtime - known.mtime}ms res=${JSON.stringify(res)} ` +
      `conflicts=${devB.conflicts.length} survivors=${JSON.stringify(survivors)} ` +
      `content="${texts["Diary.md"]}" indexDirty=${state?.dirty}`
  );

  // Phase 0 only flags files when stat.mtime > known.mtime + 1000 (sync-engine.ts:94-100).
  // A fast external edit (or any tool that preserves mtime) is therefore treated as clean and the
  // pull accept-remote branch overwrites it.
  assert.deepEqual(
    survivors,
    ["Diary.md"],
    "external offline edit must be treated as dirty and preserved (conflict copy), not silently replaced"
  );
  assert.equal(state?.dirty, false);
});

test("AUDIT D2 (control): the same external edit is detected when mtime is >1s newer", async (t) => {
  const server = await createTestServer();
  const devA = createTestDevice(server, "laptop", await server.mintToken("device-a"));
  const devB = createTestDevice(server, "phone", await server.mintToken("device-b"));

  await devA.edit("Journal.md", "journal base");
  await devA.sync();
  await devB.sync();

  // Simulate an index baseline from >1s ago (plugin had been closed for a while).
  const known = devB.index.get("Journal.md");
  devB.index.set("Journal.md", { ...known, mtime: Date.now() - 10_000 });

  await devB.vault.write("Journal.md", "externally edited while plugin was inactive");
  await devA.edit("Journal.md", "remote rewrite");
  await devA.sync();

  const res = await devB.sync();
  const texts = await vaultTexts(devB.vault);
  const survivors = pathsContaining(texts, "externally edited");

  t.diagnostic(
    `res=${JSON.stringify(res)} conflicts=${JSON.stringify(devB.conflicts)} survivors=${JSON.stringify(survivors)}`
  );

  // Confirms the offline-scan path itself works when the mtime guard passes; D1 isolates the
  // 1-second (and mtime-preserving) blind spot rather than a completely missing scan.
  assert.deepEqual(survivors, ["Journal.md"]);
  assert.equal(devB.conflicts.length, 1);
});
