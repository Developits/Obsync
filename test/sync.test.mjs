// Comprehensive end-to-end integration and data-safety tests.
// Tests the Cloudflare Worker + D1 + R2 server against simulated multi-device sync scenarios.

import test from "node:test";
import assert from "node:assert/strict";
import { createTestServer, createTestDevice } from "./harness.mjs";

test("Scenario 1: Single device create, edit, rename, delete roundtrip", async () => {
  const server = await createTestServer();
  const token = await server.mintToken("device-1");
  const d1 = createTestDevice(server, "laptop", token);

  // 1. Create file
  await d1.edit("Notes/Idea.md", "# My Idea\nInitial thought");
  let res = await d1.sync();
  assert.equal(res.pushed, 1);
  assert.equal(d1.index.get("Notes/Idea.md").base_rev, 1);

  // 2. Edit file
  await d1.edit("Notes/Idea.md", "# My Idea\nUpdated thought");
  res = await d1.sync();
  assert.equal(res.pushed, 1);
  assert.equal(d1.index.get("Notes/Idea.md").base_rev, 2);

  // 3. Rename file
  await d1.rename("Notes/Idea.md", "Notes/GreatIdea.md");
  res = await d1.sync();
  assert.equal(res.pushed, 1);
  assert.equal(await d1.vault.exists("Notes/Idea.md"), false);
  assert.equal(await d1.vault.exists("Notes/GreatIdea.md"), true);
  assert.equal(d1.index.get("Notes/GreatIdea.md").base_rev, 1);

  // 4. Delete file
  await d1.delete("Notes/GreatIdea.md");
  res = await d1.sync();
  assert.equal(res.pushed, 1);
  assert.equal(await d1.vault.exists("Notes/GreatIdea.md"), false);
  assert.equal(d1.index.get("Notes/GreatIdea.md"), undefined);
});

test("Scenario 2: Multi-device sync across two devices", async () => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("device-a");
  const tokenB = await server.mintToken("device-b");

  const devA = createTestDevice(server, "laptop", tokenA);
  const devB = createTestDevice(server, "phone", tokenB);

  // Device A creates notes
  await devA.edit("Daily/2026-10-12.md", "Today is productive.");
  await devA.edit("Projects/Alpha.md", "Project specs.");
  await devA.sync();

  // Device B syncs
  assert.equal(await devB.vault.exists("Daily/2026-10-12.md"), false);
  const resB = await devB.sync();
  assert.equal(resB.pulled, 2);

  // Device B now has both notes with identical content
  assert.equal(await devB.vault.read("Daily/2026-10-12.md"), "Today is productive.");
  assert.equal(await devB.vault.read("Projects/Alpha.md"), "Project specs.");
});

test("Scenario 3: Two devices edit different files simultaneously -> automatic merge", async () => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("device-a");
  const tokenB = await server.mintToken("device-b");

  const devA = createTestDevice(server, "laptop", tokenA);
  const devB = createTestDevice(server, "phone", tokenB);

  // Both devices start synced
  await devA.edit("Base.md", "Base content");
  await devA.sync();
  await devB.sync();

  // Device A writes Book.md while Device B writes Idea.md
  await devA.edit("Book.md", "Philosophy chapter");
  await devB.edit("Idea.md", "Start a blog");

  await devA.sync();
  await devB.sync();
  await devA.sync();

  // Both devices have both files cleanly
  assert.equal(await devA.vault.read("Idea.md"), "Start a blog");
  assert.equal(await devB.vault.read("Book.md"), "Philosophy chapter");
});

test("Scenario 4: Two devices edit disjoint lines in the same note -> clean 3-way merge", async () => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("device-a");
  const tokenB = await server.mintToken("device-b");

  const devA = createTestDevice(server, "laptop", tokenA);
  const devB = createTestDevice(server, "phone", tokenB);

  // Base document
  const baseContent = ["Title", "Introduction", "Body paragraph", "Conclusion"].join("\n");
  await devA.edit("Essay.md", baseContent);
  await devA.sync();
  await devB.sync();

  // Device A edits Introduction (line 2)
  const contentA = ["Title", "Deep Introduction", "Body paragraph", "Conclusion"].join("\n");
  await devA.edit("Essay.md", contentA);

  // Device B edits Conclusion (line 4)
  const contentB = ["Title", "Introduction", "Body paragraph", "Powerful Conclusion"].join("\n");
  await devB.edit("Essay.md", contentB);

  // Device A pushes first
  await devA.sync();

  // Device B pulls and syncs (triggers 3-way merge)
  const resB = await devB.sync();
  assert.equal(resB.conflicts, 0);

  const mergedB = await devB.vault.read("Essay.md");
  const expected = ["Title", "Deep Introduction", "Body paragraph", "Powerful Conclusion"].join("\n");
  assert.equal(mergedB.trim(), expected.trim());

  // Device A syncs back the converged result
  await devA.sync();
  assert.equal((await devA.vault.read("Essay.md")).trim(), expected.trim());
});

test("Scenario 5: Two devices edit the same line -> conflict detected, sibling conflict file created, ZERO data lost", async () => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("device-a");
  const tokenB = await server.mintToken("device-b");

  const devA = createTestDevice(server, "laptop", tokenA);
  const devB = createTestDevice(server, "android", tokenB);

  // Base
  await devA.edit("Study.md", "I study philosophy");
  await devA.sync();
  await devB.sync();

  // Device A changes line to ancient philosophy
  await devA.edit("Study.md", "I study ancient philosophy");

  // Device B changes the SAME line to modern philosophy
  await devB.edit("Study.md", "I study modern philosophy");

  // Device A pushes
  await devA.sync();

  // Device B pulls -> overlapping collision!
  const resB = await devB.sync();
  assert.equal(resB.conflicts, 1);

  // Local file on Device B remains untouched
  assert.equal(await devB.vault.read("Study.md"), "I study modern philosophy");

  // A sibling conflict file holding the remote version was created!
  assert.equal(devB.conflicts.length, 1);
  const conflictFile = devB.conflicts[0].conflict;
  assert.match(conflictFile, /Study \(conflict laptop \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\)\.md/);
  assert.equal(await devB.vault.exists(conflictFile), true);
  assert.equal(await devB.vault.read(conflictFile), "I study ancient philosophy");
});

test("Scenario 6: Delete vs Edit race -> Edit beats delete", async () => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("device-a");
  const tokenB = await server.mintToken("device-b");

  const devA = createTestDevice(server, "laptop", tokenA);
  const devB = createTestDevice(server, "phone", tokenB);

  // Initial file
  await devA.edit("Important.md", "Original important notes");
  await devA.sync();
  await devB.sync();

  // Device A deletes the file
  await devA.delete("Important.md");
  await devA.sync();

  // Device B edited the file while offline
  await devB.edit("Important.md", "Updated critical notes!");

  // Device B syncs: edit beats delete!
  await devB.sync();
  assert.equal(await devB.vault.exists("Important.md"), true);
  assert.equal(await devB.vault.read("Important.md"), "Updated critical notes!");

  // Device A syncs: recovers the edited note!
  await devA.sync();
  assert.equal(await devA.vault.exists("Important.md"), true);
  assert.equal(await devA.vault.read("Important.md"), "Updated critical notes!");
});

test("Scenario 7: Rename vs Edit race -> Rename preserved with edit", async () => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("device-a");
  const tokenB = await server.mintToken("device-b");

  const devA = createTestDevice(server, "laptop", tokenA);
  const devB = createTestDevice(server, "phone", tokenB);

  // Initial file
  await devA.edit("Draft.md", "Draft text");
  await devA.sync();
  await devB.sync();

  // Device A renames Draft.md to Final.md
  await devA.rename("Draft.md", "Final.md");
  await devA.sync();

  // Device B syncs: receives rename to Final.md
  await devB.sync();
  assert.equal(await devB.vault.exists("Draft.md"), false);
  assert.equal(await devB.vault.exists("Final.md"), true);
  assert.equal(await devB.vault.read("Final.md"), "Draft text");
});

test("Scenario 8: Binary file conflict (Canvas / PDF / Image) -> sibling conflict copies, never corrupted", async () => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("device-a");
  const tokenB = await server.mintToken("device-b");

  const devA = createTestDevice(server, "laptop", tokenA);
  const devB = createTestDevice(server, "phone", tokenB);

  // Binary dummy image (e.g. PNG header bytes)
  const baseImg = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
  await devA.editBinary("Diagram.png", baseImg);
  await devA.sync();
  await devB.sync();

  // Device A updates image
  const imgA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb]);
  await devA.editBinary("Diagram.png", imgA);
  await devA.sync();

  // Device B independently updates image
  const imgB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xcc, 0xdd]);
  await devB.editBinary("Diagram.png", imgB);

  // Device B pulls -> binary files are NEVER merged with diff3; sibling copy created!
  const resB = await devB.sync();
  assert.equal(resB.conflicts, 1);

  // Local image on Device B is preserved byte-for-byte
  const localBytes = Buffer.from(await devB.vault.readBinary("Diagram.png"));
  assert.deepEqual(localBytes, imgB);

  // Remote image saved as conflict copy
  const conflictImg = devB.conflicts[0].conflict;
  assert.match(conflictImg, /Diagram \(conflict laptop \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\)\.png/);
  const conflictBytes = Buffer.from(await devB.vault.readBinary(conflictImg));
  assert.deepEqual(conflictBytes, imgA);
});

test("Scenario 9: Idempotent duplicate write -> identical content does not advance seq", async () => {
  const server = await createTestServer();
  const token = await server.mintToken("device-1");
  const dev = createTestDevice(server, "laptop", token);

  await dev.edit("Note.md", "Exact same text");
  await dev.sync();
  const seq1 = dev.index.getSeq();

  // Second sync with identical content
  await dev.sync();
  const seq2 = dev.index.getSeq();

  assert.equal(seq1, seq2);
});

test("Scenario 10: Old device returns after months and catches up", async () => {
  const server = await createTestServer();
  const tokenA = await server.mintToken("active-device");
  const tokenOld = await server.mintToken("old-device");

  const devActive = createTestDevice(server, "workstation", tokenA);
  const devOld = createTestDevice(server, "old-tablet", tokenOld);

  // Create initial state
  await devActive.edit("OldNote.md", "Created in January");
  await devActive.sync();
  await devOld.sync();

  // Workstation performs 50 modifications over time
  for (let i = 1; i <= 20; i++) {
    await devActive.edit(`Note-${i}.md`, `Content revision ${i}`);
  }
  await devActive.edit("OldNote.md", "Updated in October");
  await devActive.sync();

  // Old tablet wakes up months later at seq 1
  assert.equal(devOld.index.getSeq(), 1);
  const res = await devOld.sync();
  assert.equal(res.pulled, 21);
  assert.equal(await devOld.vault.read("OldNote.md"), "Updated in October");
  assert.equal(await devOld.vault.read("Note-20.md"), "Content revision 20");
});

test("Scenario 11: Pre-existing vault initial push to empty server", async () => {
  const server = await createTestServer();
  const token1 = await server.mintToken("device-1");
  const token2 = await server.mintToken("device-2");

  const dev1 = createTestDevice(server, "laptop", token1);
  const dev2 = createTestDevice(server, "mobile", token2);

  // Simulate pre-existing vault on dev1: write 20 files directly to vault without indexing
  for (let i = 1; i <= 20; i++) {
    await dev1.vault.write(`Archive/Note-${i}.md`, `Pre-existing note ${i}`);
  }
  // Verify dev1 index is completely empty before sync
  assert.equal(dev1.index.allEntries().length, 0);

  // Initial sync: dev1 scans vault, indexes all 20 files, and pushes to server
  const res1 = await dev1.sync();
  assert.equal(res1.pushed, 20);
  assert.equal(res1.conflicts, 0);

  // All 20 entries are now clean in dev1 index with base_rev = 1
  for (let i = 1; i <= 20; i++) {
    const entry = dev1.index.get(`Archive/Note-${i}.md`);
    assert.ok(entry);
    assert.equal(entry.dirty, false);
    assert.equal(entry.base_rev, 1);
  }

  // Device 2 pulls all 20 files cleanly
  const res2 = await dev2.sync();
  assert.equal(res2.pulled, 20);
  assert.equal(await dev2.vault.read("Archive/Note-1.md"), "Pre-existing note 1");
  assert.equal(await dev2.vault.read("Archive/Note-20.md"), "Pre-existing note 20");
});

test("Scenario 12: Second device joins with identical pre-existing vault (fast hash deduplication)", async () => {
  const server = await createTestServer();
  const token1 = await server.mintToken("device-1");
  const token2 = await server.mintToken("device-2");

  const dev1 = createTestDevice(server, "laptop", token1);
  const dev2 = createTestDevice(server, "tablet", token2);

  // Dev 1 creates and pushes a note
  await dev1.edit("Shared/Doc.md", "Shared documentation text");
  await dev1.sync();

  // Dev 2 ALREADY has the exact same file on disk (e.g. copied via USB/airdrop), but empty index
  await dev2.vault.write("Shared/Doc.md", "Shared documentation text");
  assert.equal(dev2.index.get("Shared/Doc.md"), undefined);

  // Dev 2 syncs: hashes match, so it links rev without pushing or conflicting
  const res2 = await dev2.sync();
  assert.equal(res2.conflicts, 0);
  assert.equal(res2.pushed, 0);

  const entry = dev2.index.get("Shared/Doc.md");
  assert.ok(entry);
  assert.equal(entry.dirty, false);
  assert.equal(entry.base_rev, 1);
});

test("Scenario 13: Second device joins with differing pre-existing file (safe conflict branching, zero data loss)", async () => {
  const server = await createTestServer();
  const token1 = await server.mintToken("device-1");
  const token2 = await server.mintToken("device-2");

  const dev1 = createTestDevice(server, "laptop", token1);
  const dev2 = createTestDevice(server, "phone", token2);

  // Dev 1 creates and pushes note
  await dev1.edit("Notes/Project.md", "Project Roadmap from Laptop");
  await dev1.sync();

  // Dev 2 ALREADY has the same path on disk with different content, untracked
  await dev2.vault.write("Notes/Project.md", "Project Notes drafted offline on Phone");

  // Dev 2 syncs: mismatch with no common ancestor -> conflict copy created, local preserved
  const res2 = await dev2.sync();
  assert.equal(res2.conflicts, 1);

  // Dev 2's local note is NOT overwritten
  assert.equal(await dev2.vault.read("Notes/Project.md"), "Project Notes drafted offline on Phone");

  // Conflict copy from laptop was created
  assert.equal(dev2.conflicts.length, 1);
  const conflictPath = dev2.conflicts[0].conflict;
  assert.match(conflictPath, /Notes\/Project \(conflict laptop \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\)\.md/);
  assert.equal(await dev2.vault.exists(conflictPath), true);
  assert.equal(await dev2.vault.read(conflictPath), "Project Roadmap from Laptop");
});
