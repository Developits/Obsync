import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from './harness.mjs';

async function setup() {
  const s = await createTestServer();
  const req = (route, options = {}) => s.dispatch('http://test.local/v1' + route, {
    ...options, headers: { Authorization: `Bearer ${s.adminToken}`, ...options.headers },
  });
  const put = (path, body, headers = {}) => req('/file?path=' + encodeURIComponent(path), {method:'PUT', body, headers});
  return {s, req, put};
}

test('unsafe path publication is rejected without rejecting opaque safe names or excluded settings keys', async () => {
  const {req, put} = await setup();
  const invalid = ['../outside.md','/absolute.md','a/../b','a/./b','a//b','a/','a\\b','C:/absolute.md','nul\u0000.md','e\u0301.md'];
  const before = await (await req('/stats')).json();
  for (const path of invalid) {
    assert.equal((await put(path, 'never publish')).status, 400, path);
    assert.equal((await req('/file?path='+encodeURIComponent(path), {method:'DELETE'})).status, 400, path);
    assert.equal((await req('/rename', {method:'POST',body:JSON.stringify({from:'source',to:path,base_rev:1})})).status, 400, path);
    assert.equal((await req('/rename', {method:'POST',body:JSON.stringify({from:path,to:'target',base_rev:1})})).status, 400, path);
  }
  assert.deepEqual(await (await req('/stats')).json(), before);
  for (const path of ['.obsidian/plugins/fake/config.json','__proto__','constructor','বাংলা 中文 🌌 #?%.md','é.md']) {
    assert.equal((await put(path, 'safe '+path)).status, 200, path);
    assert.equal(await (await req('/file?path='+encodeURIComponent(path))).text(), 'safe '+path);
  }
});

test('retention accepts only JSON integers 0..36500 and preserves the last valid setting', async () => {
  const {req} = await setup();
  for (const days of [14, 36500]) {
    assert.equal((await req('/retention', {method:'PUT',body:JSON.stringify({days})})).status, 200);
    assert.equal((await (await req('/retention')).json()).days, days);
  }
  for (const days of [-5, 1.5, 36501, 9007199254740992, '14', null, true]) {
    assert.equal((await req('/retention', {method:'PUT',body:JSON.stringify({days})})).status, 400, String(days));
    assert.equal((await (await req('/retention')).json()).days, 36500);
  }
  assert.equal((await req('/retention', {method:'PUT',body:'{"days":0}'})).status, 200);
  assert.equal((await (await req('/retention')).json()).days, 0);
  assert.equal((await req('/retention', {method:'PUT',body:'{}'})).status, 400);
});

test('strict safe integer protocol inputs reject coercion before any mutation', async () => {
  const {s, req, put} = await setup();
  await put('numeric', 'one');
  const before = await (await req('/stats')).json();
  const blobCount = s.env.BUCKET._store.size;
  const invalid = ['nope','1junk','1.5','-1','9007199254740992','1e2','0x10',''];
  for (const value of invalid) {
    for (const route of ['/changes?since=', '/changes?limit=', '/deleted?limit=', '/file?path=numeric&rev=']) {
      assert.equal((await req(route + encodeURIComponent(value))).status, 400, route + value);
    }
    for (const header of ['X-Base-Rev', 'X-Mtime']) {
      assert.equal((await put('numeric', 'must not publish', {[header]:value})).status, 400, header + value);
    }
    assert.equal((await req('/file?path=numeric', {method:'DELETE',headers:{'X-Base-Rev':value}})).status, 400);
  }
  for (const base_rev of ['1', '1junk', -1, 1.5, 9007199254740992, null, true]) {
    assert.equal((await req('/rename', {method:'POST',body:JSON.stringify({from:'numeric',to:'destination',base_rev})})).status, 400);
  }
  for (const route of ['/changes?limit=0','/changes?limit=1001','/deleted?limit=501','/file?path=numeric&rev=0']) {
    assert.equal((await req(route)).status, 400, route);
  }
  assert.deepEqual(await (await req('/stats')).json(), before);
  assert.equal(s.env.BUCKET._store.size, blobCount);
  assert.equal(await (await req('/file?path=numeric')).text(), 'one');
  assert.equal((await req('/changes?since=9007199254740991&limit=1000')).status, 200);
  assert.equal((await req('/deleted?limit=500')).status, 200);
  assert.equal((await put('timestamp', 'ok', {'X-Mtime':'9007199254740991'})).status, 200);
});

test('malformed JSON and non-object bodies are controlled 400s without mutation', async () => {
  const {req} = await setup();
  for (const [route, method] of [['/tokens','POST'], ['/rename','POST'], ['/retention','PUT']]) {
    for (const body of ['{','null','[]','1','"text"']) {
      const r = await req(route, {method, body});
      assert.equal(r.status, 400, route + ' ' + body);
      assert.ok((await r.json()).error);
    }
  }
  for (const body of [{from:2,to:'b',base_rev:1}, {from:'a',to:'a',base_rev:1}]) {
    assert.equal((await req('/rename', {method:'POST',body:JSON.stringify(body)})).status, 400);
  }
  assert.equal((await req('/tokens', {method:'POST',body:'{"name":4}'})).status, 400);
  assert.equal((await req('/tokens', {method:'POST',body:'{}'})).status, 200);
  assert.equal((await req('/stats')).status, 200);
});

test('single byte ranges describe exact bounded, open-ended and suffix bytes; HEAD ignores Range', async () => {
  const {req, put} = await setup();
  assert.equal((await put('range', '0123456789')).status, 200);
  for (const [range, text, contentRange] of [
    ['bytes=2-4','234','bytes 2-4/10'], ['bytes=4-','456789','bytes 4-9/10'],
    ['bytes=-3','789','bytes 7-9/10'], ['bytes=8-99','89','bytes 8-9/10'],
    ['bytes=-99','0123456789','bytes 0-9/10'],
  ]) {
    const r = await req('/file?path=range', {headers:{Range:range}});
    assert.equal(r.status, 206, range);
    assert.equal(r.headers.get('Content-Range'), contentRange, range);
    assert.equal(r.headers.get('Content-Length'), String(text.length), range);
    assert.equal(await r.text(), text, range);
  }
  for (const range of ['bytes=99-100','bytes=5-2','bytes=x-y','bytes=0-1,4-5','bytes=-0','bytes=-','items=0-1','bytes=9007199254740992-']) {
    const r = await req('/file?path=range', {headers:{Range:range}});
    assert.equal(r.status, 416, range);
    assert.equal(r.headers.get('Content-Range'), 'bytes */10', range);
  }
  await put('empty', '');
  assert.equal((await req('/file?path=empty', {headers:{Range:'bytes=0-'}})).status, 416);
  const head = await req('/file?path=range', {method:'HEAD', headers:{Range:'bytes=x-y'}});
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '10');
  assert.equal(head.headers.get('Content-Range'), null);
  assert.equal(await head.text(), '');
});
