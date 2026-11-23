import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncClient, ApiError, ConflictError} from '../plugin/src/api.ts';

function client(status, json) {
  return new SyncClient('https://sync.example', 'token', 'device', async params => {
    assert.equal(params.url, 'https://sync.example/v1/health');
    assert.equal(params.headers.Authorization, 'Bearer token');
    assert.equal(params.throw, false);
    return {status, json, headers:{}, arrayBuffer:new ArrayBuffer(0)};
  });
}

test('client uses the injected requestUrl transport', async () => {
  assert.deepEqual(await client(200, {ok:true}).health(), {ok:true});
});

test('client requires an explicit transport rather than falling back to fetch', async () => {
  await assert.rejects(new SyncClient('https://sync.example','token').health(), /injected requestUrl/);
});

test('malformed error bodies use safe defaults', async () => {
  for (const body of [null, [], 'error', 42]) {
    await assert.rejects(client(409, body).health(), e => e instanceof ConflictError && e.serverRev === 0);
    await assert.rejects(client(503, body).health(), e => e instanceof ApiError && e.status === 503);
  }
  await assert.rejects(client(409, {path:'note.md',server_rev:2}).health(),
    e => e instanceof ConflictError && e.path === 'note.md' && e.serverRev === 2);
});
