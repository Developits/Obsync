import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../plugin/src/diagnostics.ts').catch(() => null);
const ROOT = '.obsidian/plugins/distributed-sync/diagnostics';
function memory() {
  const files = new Map(), reads = [];
  return {files, reads,
    async exists(p) { return files.has(p); }, async mkdir() {},
    async stat(p) { return files.has(p) ? {size: Buffer.byteLength(files.get(p))} : null; },
    async read(p) { reads.push(p); return files.get(p); },
    async write(p, text) { files.set(p, text); }
  };
}
function make(adapter = memory(), options = {}) {
  assert.ok(module?.LocalDiagnostics, 'local diagnostics implementation is available');
  return new module.LocalDiagnostics(adapter, {pluginVersion:'1.0.1', obsidianVersion:'1.8.7', platform:'desktop', ...options});
}
function records(adapter) {
  return ['previous.jsonl','current.jsonl'].flatMap(n => (adapter.files.get(`${ROOT}/${n}`) ?? '').split('\n').filter(Boolean).map(JSON.parse));
}

test('local JSONL diagnostics strictly allowlist metadata, events, fields and safe error context', async () => {
  const a = memory(), d = make(a);
  await d.start();
  const secret = 'PRIVATE_TOKEN /home/user/Secret.md note-content https://private.example';
  const e = Object.assign(new TypeError(secret), {code:'ENOSPC', status:503});
  e.stack = `TypeError: ${secret}\n at privateFunction (plugin:distributed-sync:42:9)\n at other (plugin:other-plugin:2:3)`;
  d.log('sync_failure', {operation:'push', failed:2, message:secret, path:secret, token:secret, ...module.safeError(e)});
  d.log(secret, {message:secret});
  await d.flush();
  const text = [...a.files.values()].join('\n');
  for (const canary of ['PRIVATE_TOKEN','/home/user','Secret.md','note-content','private.example','privateFunction','other-plugin']) assert.ok(!text.includes(canary), canary);
  const row = records(a).find(r => r.event === 'sync_failure');
  assert.equal(row.schema, 1); assert.equal(row.pluginVersion,'1.0.1'); assert.equal(row.obsidianVersion,'1.8.7');
  assert.match(row.session, /^[a-f0-9-]{36}$/); assert.equal(row.platform,'desktop');
  assert.equal(row.failed,2); assert.equal(row.operation,'push'); assert.equal(row.category,'type');
  assert.equal(row.code,'ENOSPC'); assert.equal(row.status,503); assert.deepEqual(row.frames,[{line:42,column:9}]);
  assert.equal(records(a).filter(r=>r.event===secret).length,0);
});

test('rotation stays byte-bounded, preserves order and survives restart without clearing logs', async () => {
  const a = memory(), d = make(a); await d.start();
  for (let batch=0; batch<100; batch++) {
    for (let i=0;i<32;i++) d.log('sync_result',{pushed:batch*32+i});
    await d.flush();
  }
  const before = records(a).filter(r=>r.event==='sync_result');
  assert.ok(a.files.has(`${ROOT}/previous.jsonl`));
  for (const name of ['current.jsonl','previous.jsonl']) assert.ok(Buffer.byteLength(a.files.get(`${ROOT}/${name}`)) <= 256*1024);
  assert.ok(before.every((row,i)=>!i || row.pushed > before[i-1].pushed));
  const next = make(a); await next.start();
  assert.ok(records(a).some(r=>r.event==='sync_result' && r.pushed===3199),'restart retains bounded history');
  assert.ok(records(a).some(r=>r.event==='previous_session_unclean'));
  await next.close();
  const clean = make(a); await clean.start();
  assert.equal(records(a).filter(r=>r.event==='previous_session_unclean').length,1,'clean shutdown does not report another unclean session');
});

test('concurrent backpressure is bounded and records dropped event count', async () => {
  const a = memory(), d = make(a); await d.start();
  const write = a.write; let release;
  const gate = new Promise(r=>release=r); let entered;
  const ready = new Promise(r=>entered=r);
  a.write = async (...args) => { entered(); await gate; return write(...args); };
  d.log('sync_result',{pushed:0}); await ready;
  for (let i=1;i<=1000;i++) d.log('sync_result',{pushed:i});
  assert.ok(d.queue.length<=128);
  release(); await Promise.all([d.flush(),d.flush()]);
  const rows=records(a); assert.equal(rows.find(r=>r.event==='queue_overflow').dropped,872);
  assert.deepEqual(rows.filter(r=>r.event==='sync_result').map(r=>r.pushed),Array.from({length:129},(_,i)=>i));
});

test('export revalidates prior files, strips unknown fields and skips malformed/oversized records with bounded reads', async () => {
  const a=memory(),d=make(a);await d.start();
  const valid=records(a)[0];
  a.files.set(`${ROOT}/previous.jsonl`,JSON.stringify({...valid, token:'CANARY秘密',path:'/private.md',frames:[{line:4,column:7,name:'CANARY秘密'}]})+'\n'+JSON.stringify({...valid,session:'CANARY秘密'})+'\n{truncated');
  const result=await d.export();
  assert.equal(result.path,`${ROOT}/export.json`);assert.equal(result.unavailable,false);
  const text=a.files.get(result.path);assert.ok(!text.includes('CANARY'));assert.ok(!text.includes('/private.md'));
  const output=JSON.parse(text);assert.ok(output.skippedRecords>=2);assert.equal(output.buildSha256,'unknown');
  assert.ok(Buffer.byteLength(text)<=512*1024+4096);
  a.files.set(`${ROOT}/previous.jsonl`,'秘密'.repeat(100000));a.reads.length=0;
  const oversize=await d.export();assert.equal(oversize.unavailable,true);
  assert.ok(!a.reads.includes(`${ROOT}/previous.jsonl`),'stat cap must precede read');
});

test('installed build SHA256 hashes exact bounded bundle bytes and unavailable identity is explicit', async () => {
  const a=memory(); const bundle=new TextEncoder().encode('/* exact installed bytes 秘密 */');
  a.files.set('.obsidian/plugins/distributed-sync/main.js',new TextDecoder().decode(bundle));
  a.readBinary=async()=>bundle.buffer;
  const d=make(a);await d.start();const result=await d.export();
  const {createHash}=await import('node:crypto');
  const expected=createHash('sha256').update(bundle).digest('hex');
  const exported=JSON.parse(a.files.get(result.path));assert.equal(exported.buildSha256,expected);
  assert.equal(exported.events.find(r=>r.event==='session_start').buildSha256,expected,'each session identifies its own installed bundle');
  a.stat=async p=>p.endsWith('main.js')?{size:8*1024*1024}:null;
  let binaryReads=0;a.readBinary=async()=>{binaryReads++;throw Error('must not read')};
  const other=make(a);await other.start();const unknown=await other.export();
  assert.equal(JSON.parse(a.files.get(unknown.path)).buildSha256,'unknown');assert.equal(binaryReads,0);
});

test('all diagnostics I/O failures are contained, warn once, and export reports unavailable', async () => {
  for(const method of ['exists','mkdir','stat','read','write']) {
    const a=memory();a.files.set(`${ROOT}/session.json`,'{"schema":1,"state":"open"}');
    if(method==='mkdir')a.exists=async()=>false;
    let warnings=0;a[method]=async()=>{throw Object.assign(Error('CANARY credentials'),{code:'ENOSPC'})};
    const d=make(a,{onFailure:()=>warnings++});await d.start();
    d.log('sync_result',{failed:1});await d.flush();
    const result=await d.export();assert.equal(result.unavailable,true,method);assert.equal(warnings,1,method);
    await d.close();
  }
});

test('corrupt session marker is not claimed to prove a crash', async () => {
  const a=memory();a.files.set(`${ROOT}/session.json`,'{broken');
  const d=make(a);await d.start();
  assert.ok(records(a).some(r=>r.event==='marker_invalid'));
  assert.ok(!records(a).some(r=>r.event==='previous_session_unclean'));
});

test('global handlers capture only attributable plugin frames, exclude message lookalikes and remove listeners', async () => {
  const a=memory(),d=make(a);await d.start();
  const target=new EventTarget();d.attachGlobalHandlers(target);
  function dispatch(type,props){const e=new Event(type);Object.assign(e,props);target.dispatchEvent(e);}
  const own=Object.assign(new Error('CANARY'),{stack:'Error: CANARY\n at secretFunction (plugin:distributed-sync:80:3)'});
  dispatch('error',{error:own});dispatch('unhandledrejection',{reason:own});
  dispatch('error',{filename:'plugin:distributed-sync',lineno:90,colno:2});
  dispatch('error',{error:{stack:'Error: plugin:distributed-sync:1:2\n at another (plugin:unrelated:5:1)'}});
  dispatch('unhandledrejection',{reason:{stack:'Error CANARY\n at another (plugin:unrelated:5:1)'}});
  await d.flush();
  assert.equal(records(a).filter(r=>r.event==='global_error').length,2);
  assert.equal(records(a).filter(r=>r.event==='unhandled_rejection').length,1);
  assert.ok(![...a.files.values()].join('').includes('secretFunction'));
  await d.close();dispatch('error',{error:own});await d.flush();
  assert.equal(records(a).filter(r=>r.event==='global_error').length,2);
  assert.doesNotThrow(()=>make(memory()).attachGlobalHandlers({}),'missing browser event APIs are harmless');
});

test('restart caps normalized rows even when compact numeric JSON expands', async () => {
  const a=memory(),seed=make(a);await seed.start();
  const base={...records(a)[0],event:'sync_result',pulled:1e9,pushed:1e9,failed:1e9,pending:1e9,conflicts:1e9,dropped:1e9};
  const line=JSON.stringify(base).replaceAll('1000000000','1e9')+'\n';
  a.files.set(`${ROOT}/current.jsonl`,line.repeat(Math.floor(256*1024/Buffer.byteLength(line))));
  const d=make(a);await d.start();await d.flush();
  for(const name of ['current.jsonl','previous.jsonl'])assert.ok(Buffer.byteLength(a.files.get(`${ROOT}/${name}`)??'')<=256*1024,name);
});

test('global attribution uses throwing source, never function text or another plugin caller chain', async () => {
  const a=memory(),d=make(a);await d.start();const target=new EventTarget();d.attachGlobalHandlers(target);
  for(const stack of [
    'Error: other\n at plugin:distributed-sync:9:8 (plugin:unrelated:1:2)',
    'Error: other\n at fail (plugin:unrelated:1:2)\n at caller (plugin:distributed-sync:9:8)',
    'Error: other\n at fail (https://other/plugin:distributed-sync:9:8)',
  ]){const e=new Event('error');e.error={stack};target.dispatchEvent(e);}
  await d.flush();assert.equal(records(a).filter(r=>r.event==='global_error').length,0);await d.close();
});

test('close during asynchronous startup leaves a closed marker and does not reopen the session', async()=>{
 const a=memory(),read=a.stat;let entered,release;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 a.stat=async p=>{if(p.endsWith('current.jsonl')){entered();await gate;}return read(p);};
 const d=make(a),starting=d.start();await ready;const closing=d.close();release();await Promise.all([starting,closing]);
 assert.equal(JSON.parse(a.files.get(`${ROOT}/session.json`)).state,'closed');
});

test('unknown throwing-frame formats fail closed instead of attributing a later own-plugin caller', async()=>{
 const a=memory(),d=make(a);await d.start();const target=new EventTarget();d.attachGlobalHandlers(target);
 const e=new Event('error');e.error={stack:'Error: foreign\n at foreignThrow (foreign plugin.js:1:32)\n at plugin:distributed-sync:1:1'};target.dispatchEvent(e);
 await d.flush();assert.equal(records(a).filter(r=>r.event==='global_error').length,0);await d.close();
});

test('events queued during delayed startup reads are retained after reconstruction', async()=>{
 const a=memory(),old=make(a);await old.start();await old.close();
 const read=a.read;let entered,release;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 a.read=async p=>{const text=await read(p);if(p.endsWith('current.jsonl')){entered();await gate;}return text;};
 const d=make(a),starting=d.start();await ready;
 d.log('global_error',{category:'type'});const flushing=d.flush();
 release();await Promise.all([starting,flushing]);
 assert.equal(records(a).filter(r=>r.event==='global_error').length,1);await d.close();
});

test('export rejects non-string metadata rather than trusting string coercion',async()=>{
 const a=memory(),d=make(a);await d.start();const valid=records(a)[0];
 a.files.set(`${ROOT}/previous.jsonl`,JSON.stringify({...valid,platform:['desktop']})+'\n');
 const report=await d.export();const result=JSON.parse(a.files.get(report.path));
 assert.equal(result.skippedRecords,1);assert.ok(result.events.every(r=>typeof r.platform==='string'));
});

export {memory, make, records, ROOT};
