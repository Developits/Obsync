// Isolated, deterministic edge/fault probes. No production code or real vault access.
// Failures are intentional RED acceptance probes, not expected-failure suppression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, createTestDevice } from './harness.mjs';
import { LocalIndex } from '../plugin/src/index-store.ts';
import { SyncEngine } from '../plugin/src/sync-engine.ts';

const STATE = '.index/sync-state.json';
const bytes = (data) => Buffer.from(data);
const state = (n = 1) => ({ base_rev: n, base_hash: '', local_hash: '', mtime: 1000, dirty: true });
async function pair() {
  const server = await createTestServer();
  const a = createTestDevice(server, 'edge-a', await server.mintToken('edge-a'));
  const b = createTestDevice(server, 'edge-b', await server.mintToken('edge-b'));
  for (const d of [a, b]) d.vault.stat = async (p) => d.vault.files.has(p)
    ? { mtime: 1000, size: d.vault.files.get(p).length } : null;
  return { server, a, b };
}
async function seed(a, b, p = 'source.md', content = 'original source') {
  await a.edit(p, content); await a.sync(); await b.sync();
}
async function localContents(d) {
  return [...d.vault.files].filter(([p]) => !p.startsWith('.index/')).map(([p, data]) => [p, data.toString('hex')]);
}
async function restart(d) {
  const index = new LocalIndex({
    read: async (p) => await d.vault.exists(p) ? d.vault.read(p) : null,
    write: (p, v) => d.vault.write(p, v),
  }, STATE);
  await index.load();
  const engine = new SyncEngine({ adapter: d.vault, index, client: d.client, deviceName: d.name, excludes: ['.index'] });
  return { index, sync: () => engine.sync() };
}

// Documented limitation: demanding clean identity preservation is deliberately RED.
test('EDGE occupied remote rename destination retains source identity and both byte versions', async (t) => {
  const { a, b } = await pair(); await seed(a, b);
  await a.rename('source.md', 'destination.md');
  await b.edit('destination.md', 'unrelated destination'); await b.sync();
  const result = await a.sync();
  const local = await localContents(a);
  const old = await a.client.getFile('source.md', 1);
  t.diagnostic(JSON.stringify({ result, local, queue: a.index.getQueuedRenames(), oldSource: bytes(old.data).toString() }));
  assert.equal(bytes(old.data).toString(), 'original source', 'historical source must remain recoverable');
  assert.ok(local.some(([, hex]) => hex === Buffer.from('unrelated destination').toString('hex')));
  assert.equal(await a.vault.read('destination.md'), 'original source', 'queued rename must not silently replace intended local identity');
});

test('EDGE remote rename into excluded destination retains a local artifact', async (t) => {
  const { a, b } = await pair(); await seed(a, b);
  await b.client.rename('source.md', '.index/hidden.md', b.index.get('source.md').base_rev);
  const result = await a.sync();
  const remote = await a.client.getFile('.index/hidden.md');
  t.diagnostic(JSON.stringify({ result, local: await localContents(a), remote: bytes(remote.data).toString() }));
  assert.equal(bytes(remote.data).toString(), 'original source', 'remote recovery copy must exist');
  assert.equal(await a.vault.exists('.index/hidden.md'), false, 'excluded content must not be downloaded');
  assert.ok((await localContents(a)).some(([, hex]) => hex === Buffer.from('original source').toString('hex')),
    'remote exclusion crossing must retain original bytes or an explicit local artifact');
});

test('EDGE semantic rename conflict rebases historical base_path with destination revision', async (t) => {
  const { a, b } = await pair(); await seed(a, b);
  await b.edit('destination.md', 'destination rev1'); await b.sync();
  await b.edit('destination.md', 'destination rev2'); await b.sync();
  await a.rename('source.md', 'destination.md');
  a.index.set('destination.md', { ...a.index.get('destination.md'), base_path: 'source.md', dirty: true });
  // Gate first pull to the already-consumed cursor: a peer creates the occupied
  // destination after this pull snapshot, so queued rename hits semantic CAS.
  const changes = a.client.changes.bind(a.client); let first = true;
  a.client.changes = async (...args) => { if (first) { first = false; return { entries: [], next_seq: args[0], has_more: false }; } return changes(...args); };
  let renameConflictState;
  a.client.putFile = async (p) => {
    if (p === 'destination.md' && !renameConflictState) renameConflictState = { ...a.index.get(p) };
    throw new Error('injected offline after rename conflict');
  };
  const result = await a.sync();
  const current = renameConflictState;
  t.diagnostic(JSON.stringify({ result, current, afterFinalPull: a.index.get('destination.md'), local: await localContents(a) }));
  assert.equal(current.base_rev, 2);
  assert.equal(current.base_path, undefined, 'source path cannot be paired with destination rev2');
});

for (const [label, raw] of [['truncated', '{"last_seq":'], ['invalid-json', '\u0000not json']]) {
  test(`EDGE ${label} index restart preserves divergent local and remote bytes`, async () => {
    const { a, b } = await pair(); await seed(a, b);
    await a.vault.write('source.md', 'offline edit after saved state');
    await a.vault.write(STATE, raw);
    // Recovery now restores the valid backup, rather than silently resetting.
    const fresh = await restart(a); assert.equal(fresh.index.getSeq(), a.index.getSeq());
    await fresh.sync(); await fresh.sync(); await b.sync();
    const local = await localContents(a);
    for (const content of ['offline edit after saved state', 'original source']) {
      assert.ok(local.some(([, hex]) => hex === Buffer.from(content).toString('hex')), content);
    }
    assert.equal(bytes((await a.client.getFile('source.md', 1)).data).toString(), 'original source');
    assert.equal(bytes((await a.client.getFile('source.md')).data).toString(), 'offline edit after saved state');
  });
}

test('EDGE truncated index cannot silently forget an offline queued rename on restart', async (t) => {
  const { a, b } = await pair(); await seed(a, b);
  await a.rename('source.md', 'moved.md'); await a.index.save();
  await a.vault.write(STATE, '{'); const fresh = await restart(a);
  const result = await fresh.sync();
  t.diagnostic(JSON.stringify({ result, local: await localContents(a), queue: fresh.index.getQueuedRenames() }));
  assert.equal(await a.vault.read('moved.md'), 'original source');
  assert.equal(await a.vault.exists('source.md'), false, 'lost queue must not silently resurrect the renamed source');
});

for (const mutation of ['edit', 'rename', 'cursor']) {
  test(`EDGE index ${mutation} during awaited save is durable after second save and restart`, async (t) => {
    let disk = null; let inject = true; let index;
    const adapter = { read: async () => disk, write: async (_p, payload) => {
      if (inject) {
        inject = false;
        if (mutation === 'edit') index.set('late.md', state());
        if (mutation === 'rename') index.queueRename({ from: 'old.md', to: 'new.md', base_rev: 1 });
        if (mutation === 'cursor') index.setSeq(9);
      }
      disk = payload;
    } };
    index = new LocalIndex(adapter); index.set('initial.md', state());
    await index.save(); await index.save();
    const fresh = new LocalIndex(adapter); await fresh.load();
    t.diagnostic(JSON.stringify({ mutation, disk: JSON.parse(disk), inMemory: { entries: index.allEntries(), seq: index.getSeq(), renames: index.getQueuedRenames() } }));
    if (mutation === 'edit') assert.deepEqual(fresh.get('late.md'), state());
    if (mutation === 'rename') assert.deepEqual(fresh.getQueuedRenames(), [{ from: 'old.md', to: 'new.md', base_rev: 1 }]);
    if (mutation === 'cursor') assert.equal(fresh.getSeq(), 9);
  });
}

test('EDGE failed save retries successfully and restart retains exact state', async () => {
  let disk = null; let fail = true;
  const adapter = { read: async () => disk, write: async (_p, payload) => { if (fail) throw new Error('ENOSPC'); disk = payload; } };
  const index = new LocalIndex(adapter); index.set('note.md', state(3)); index.setSeq(7);
  index.queueRename({ from: 'x.md', to: 'y.md', base_rev: 2 });
  await assert.rejects(index.save(), /ENOSPC/); fail = false; await index.save();
  const fresh = new LocalIndex(adapter); await fresh.load();
  assert.deepEqual(fresh.allEntries(), index.allEntries()); assert.equal(fresh.getSeq(), 7);
  assert.deepEqual(fresh.getQueuedRenames(), index.getQueuedRenames());
});

for (const phase of ['before-accept', 'lost-ack']) {
  test(`EDGE upload ${phase} network failure preserves exact bytes and converges on retry`, async () => {
    const { a, b } = await pair(); await a.edit('net.bin', 'payload\u0000\ufffd');
    const put = a.client.putFile.bind(a.client); let once = true;
    a.client.putFile = async (...args) => {
      if (once) { once = false; if (phase === 'lost-ack') await put(...args); throw new Error('injected connection reset'); }
      return put(...args);
    };
    const first = await a.sync(); assert.ok(first.failed > 0);
    assert.equal(await a.vault.read('net.bin'), 'payload\u0000\ufffd');
    const retry = await a.sync(); await b.sync();
    assert.equal(retry.failed, 0); assert.equal(retry.pending, 0);
    assert.deepEqual(a.vault.files.get('net.bin'), b.vault.files.get('net.bin'));
    assert.deepEqual(bytes((await a.client.getFile('net.bin')).data), a.vault.files.get('net.bin'));
  });
}

test('EDGE rename network failure remains queued across restart then converges', async () => {
  const { a, b } = await pair(); await seed(a, b); await a.rename('source.md', 'moved.md');
  const rename = a.client.rename.bind(a.client);
  a.client.rename = async () => { throw new Error('injected offline'); };
  const first = await a.sync(); assert.equal(first.pending, 1); assert.equal(a.index.getQueuedRenames().length, 1);
  const fresh = await restart(a); assert.equal(fresh.index.getQueuedRenames().length, 1);
  a.client.rename = rename; const result = await fresh.sync(); await b.sync();
  assert.equal(result.pending, 0); assert.equal(await b.vault.read('moved.md'), 'original source');
  assert.equal(await b.vault.exists('source.md'), false);
});

test('EDGE failed remote download leaves cursor retryable and bytes untouched', async () => {
  const { a, b } = await pair(); await seed(a, b); const cursor = a.index.getSeq();
  await b.edit('source.md', 'remote replacement'); await b.sync();
  const get = a.client.getFile.bind(a.client); a.client.getFile = async () => { throw new Error('injected read timeout'); };
  const result = await a.sync(); assert.ok(result.failed > 0); assert.equal(a.index.getSeq(), cursor);
  assert.equal(await a.vault.read('source.md'), 'original source');
  a.client.getFile = get; assert.equal((await a.sync()).failed, 0);
  assert.equal(await a.vault.read('source.md'), 'remote replacement');
});

test('EDGE same-content mtime-only mutation does not create a revision', async () => {
  const { a, b } = await pair(); await seed(a, b);
  const previous = await a.client.getFile('source.md');
  a.vault.stat = async (p) => a.vault.files.has(p) ? { mtime: 999999, size: a.vault.files.get(p).length } : null;
  await a.edit('source.md', 'original source'); const result = await a.sync();
  assert.equal(result.pushed, 0); assert.equal(a.index.get('source.md').dirty, false);
  assert.equal((await a.client.getFile('source.md')).rev, previous.rev);
});

for (const [name, payload] of [['empty.md', Buffer.alloc(0)], ['目录/é e\u0301 🧪 #?.md', Buffer.from('中文\nمرحبا\n👩🏽‍💻\n')], ['raw.bin', Buffer.from(Array.from({ length: 256 }, (_, i) => i))]]) {
  test(`EDGE exact-byte roundtrip and restart: ${name}`, async () => {
    const { a, b } = await pair(); await a.editBinary(name, payload);
    assert.equal((await a.sync()).failed, 0); assert.equal((await b.sync()).failed, 0);
    // Protocol intentionally canonicalizes path spelling to Unicode NFC.
    const canonical = name.normalize('NFC');
    assert.deepEqual(b.vault.files.get(canonical), payload);
    assert.deepEqual(bytes((await a.client.getFile(name)).data), payload);
    const fresh = await restart(b); assert.equal((await fresh.sync()).pending, 0);
    assert.deepEqual(b.vault.files.get(canonical), payload);
  });
}
