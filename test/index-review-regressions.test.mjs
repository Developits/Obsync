import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalIndex} from '../plugin/src/index-store.ts';
import {SyncEngine} from '../plugin/src/sync-engine.ts';
import {createTestServer,createTestDevice} from './harness.mjs';
const STATE='.index/sync-state.json';
const entry={base_rev:1,base_hash:'hash',local_hash:'hash',mtime:1,dirty:false};
async function pair(paths=['source.md']) {
 const s=await createTestServer();const a=createTestDevice(s,'a',await s.mintToken('a')),b=createTestDevice(s,'b',await s.mintToken('b'));
 for(const p of paths) await a.edit(p,`BASE ${p}`);
 await a.sync();await b.sync();return {a,b};
}
async function restart(a) {
 const index=new LocalIndex({read:async p=>await a.vault.exists(p)?a.vault.read(p):null,write:(p,v)=>a.vault.write(p,v)},STATE);
 await index.load();return {index,engine:new SyncEngine({index,adapter:a.vault,client:a.client,deviceName:'a',excludes:['.index']})};
}
function storage(){const files=new Map();return {files,adapter:{read:async p=>files.get(p)??null,write:async(p,v)=>{files.set(p,v);}}};}
test('source recovery failure also blocks a queued rename without disturbing unrelated progress',async()=>{
 const {a}=await pair();await a.edit('source.md','LOCAL SOURCE');await a.index.save();await a.vault.write(STATE,'{');const current=await restart(a);
 current.index.queueRename({from:'source.md',to:'dest.md',base_rev:1});await a.vault.write('dest.md','LOCAL DESTINATION');current.index.set('dest.md',{...current.index.get('source.md'),base_rev:0,dirty:true});
 const get=a.client.getFile.bind(a.client);a.client.getFile=async(p,rev)=>{if(p==='source.md'&&rev===1)throw Error('historical EIO');return get(p,rev);};let renames=0;const rename=a.client.rename.bind(a.client);a.client.rename=async(...args)=>{renames++;return rename(...args);};
 await a.vault.write('unrelated.md','UNRELATED');const result=await current.engine.sync();assert.ok(result.failed>0);assert.equal(renames,0);assert.equal(current.index.getQueuedRenames().length,1);assert.equal(current.index.get('source.md').base_rev,1);assert.equal(Buffer.from((await get('unrelated.md')).data).toString(),'UNRELATED');
});
function copies(a,text){return [...a.vault.files].filter(([p,v])=>!p.startsWith('.index/')&&p.includes('index-recovery')&&v.toString()===text);}
test('recovery failure retains queued rename identity through retry and restart',async()=>{
 const {a,b}=await pair();await a.rename('source.md','dest.md');await a.edit('dest.md','UNSENT LOCAL');await a.index.save();await a.vault.write(STATE,'{');await b.edit('source.md','PEER CURRENT');await b.sync();
 let current=await restart(a);const get=a.client.getFile.bind(a.client);let fail=true;
 a.client.getFile=async(p,rev)=>{if(fail&&p==='source.md'&&rev===1)throw Error('historical EIO');return get(p,rev);};
 const first=await current.engine.sync();assert.ok(first.failed>0);assert.equal(current.index.needsRecovery(),true);
 assert.deepEqual(current.index.getQueuedRenames(),[{from:'source.md',to:'dest.md',base_rev:1}]);assert.equal(current.index.get('dest.md').base_rev,1);
 current=await restart(a);await current.engine.sync();assert.equal(current.index.getQueuedRenames().length,1);
 fail=false;await current.engine.sync();assert.equal(current.index.needsRecovery(),false);assert.equal(copies(a,'BASE source.md').length,1);assert.equal(await a.vault.read('dest.md'),'UNSENT LOCAL');
});
test('partial recovery success is durable and not duplicated across repeated failure and restart',async()=>{
 const {a}=await pair(['one.md','two.md']);await a.edit('one.md','LOCAL ONE');await a.edit('two.md','LOCAL TWO');await a.index.save();await a.vault.write(STATE,'{');
 let current=await restart(a);const get=a.client.getFile.bind(a.client);let fail=true;
 const put=a.client.putFile.bind(a.client);a.client.putFile=async(p,...args)=>{if(fail&&p==='one.md')throw Error('upload EIO');return put(p,...args);};
 a.client.getFile=async(p,rev)=>{if(fail&&p==='two.md'&&rev===1)throw Error('historical EIO');return get(p,rev);};
 await current.engine.sync();assert.equal(copies(a,'BASE one.md').length,1);
 // Local edits replace FileState while another entry is still recovering.
 await a.vault.write('one.md','LOCAL ONE AGAIN');const {recovery_preserved,...known}=current.index.get('one.md');current.index.set('one.md',{...known,dirty:true});
 await current.engine.sync();assert.equal(copies(a,'BASE one.md').length,1);
 current=await restart(a);await current.engine.sync();assert.equal(copies(a,'BASE one.md').length,1);assert.equal(current.index.needsRecovery(),true);
 fail=false;await current.engine.sync();assert.equal(current.index.needsRecovery(),false);assert.equal(copies(a,'BASE one.md').length,1);assert.equal(copies(a,'BASE two.md').length,1);
});
test('observed excluded rename reports the visible preservation artifact as a conflict',async()=>{
 const {a,b}=await pair();await b.client.rename('source.md','.index/hidden.md',1);const result=await a.sync();assert.equal(result.conflicts,1);
 assert.ok([...a.vault.files].some(([p,v])=>p.includes('excluded-rename')&&v.toString()==='BASE source.md'));
});
test('newer backup wins over valid old primary after interrupted primary publication',async()=>{
 const {files,adapter}=storage();const index=new LocalIndex(adapter,STATE);index.set('source.md',entry);await index.save();
 const old=JSON.parse(files.get(STATE));index.remove('source.md');index.set('dest.md',entry);index.queueRename({from:'source.md',to:'dest.md',base_rev:1});
 const write=adapter.write;adapter.write=async(p,v)=>{if(p===STATE)throw Error('primary EIO');return write(p,v);};await assert.rejects(index.save(),/EIO/);
 const backup=JSON.parse(files.get(STATE+'.bak'));assert.ok(backup.generation>old.generation);
 const fresh=new LocalIndex(adapter,STATE);await fresh.load();assert.deepEqual(fresh.getQueuedRenames(),[{from:'source.md',to:'dest.md',base_rev:1}]);assert.equal(fresh.get('source.md'),undefined);assert.equal(fresh.needsRecovery(),true);
});
for(const failingPath of [STATE+'.bak',STATE]) test(`failed ${failingPath} write stays dirty for retry`,async()=>{
 const {files,adapter}=storage();const index=new LocalIndex(adapter,STATE);index.set('note.md',entry);await index.save();const write=adapter.write;
 index.set('note.md',{...entry,base_rev:2});adapter.write=async(p,v)=>{if(p===failingPath)throw Error('EIO');return write(p,v);};await assert.rejects(index.save(),/EIO/);
 adapter.write=write;await index.save();const fresh=new LocalIndex(adapter,STATE);await fresh.load();assert.equal(fresh.get('note.md').base_rev,2);assert.deepEqual(JSON.parse(files.get(STATE)),JSON.parse(files.get(STATE+'.bak')));
});
for(const blockedPath of [STATE+'.bak',STATE]) test(`mutation during ${blockedPath} write survives overlapping saves`,async()=>{
 const {files,adapter}=storage();let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);const write=adapter.write;let blocked=false;
 adapter.write=async(p,v)=>{if(p===blockedPath&&!blocked){blocked=true;entered();await gate;}return write(p,v);};
 const index=new LocalIndex(adapter,STATE);index.set('note.md',entry);const first=index.save();await started;index.set('note.md',{...entry,base_rev:2});const second=index.save();await Promise.resolve();release();await Promise.all([first,second]);
 const fresh=new LocalIndex(adapter,STATE);await fresh.load();assert.equal(fresh.get('note.md').base_rev,2);assert.equal(JSON.parse(files.get(STATE)).generation,2);
});
test('valid newer primary wins over older backup and legacy snapshots default to generation zero',async()=>{
 const {files,adapter}=storage();files.set(STATE,JSON.stringify({last_seq:2,files:{'new.md':entry},generation:3}));files.set(STATE+'.bak',JSON.stringify({last_seq:1,files:{'old.md':entry},generation:2}));
 const index=new LocalIndex(adapter,STATE);await index.load();assert.ok(index.get('new.md'));assert.equal(index.needsRecovery(),false);
 files.set(STATE,JSON.stringify({last_seq:0,files:{'legacy.md':entry}}));await index.load();assert.ok(index.get('old.md'));assert.equal(index.needsRecovery(),true);
});
for(const field of ['folder','dirty','preserve_on_delete','recovery_preserved']) for(const value of ['false',0,null,{}]) test(`reject invalid entry ${field}=${JSON.stringify(value)}`,async()=>{
 const {files,adapter}=storage();files.set(STATE,JSON.stringify({last_seq:0,files:{'note.md':{...entry,[field]:value}}}));await assert.rejects(new LocalIndex(adapter,STATE).load(),/index|recover/i);
});
for(const value of [null,{},3,false]) test(`reject invalid base_path=${JSON.stringify(value)}`,async()=>{
 const {files,adapter}=storage();files.set(STATE,JSON.stringify({last_seq:0,files:{'note.md':{...entry,base_path:value}}}));await assert.rejects(new LocalIndex(adapter,STATE).load(),/index|recover/i);
});
for(const value of ['false',0,null,{}]) test(`reject invalid recovery_pending=${JSON.stringify(value)}`,async()=>{
 const {files,adapter}=storage();files.set(STATE,JSON.stringify({last_seq:0,files:{'note.md':entry},recovery_pending:value}));await assert.rejects(new LocalIndex(adapter,STATE).load(),/index|recover/i);
});
for(const value of ['1',-1,0.5,null,Number.MAX_SAFE_INTEGER+1]) test(`reject invalid generation=${JSON.stringify(value)}`,async()=>{
 const {files,adapter}=storage();files.set(STATE,JSON.stringify({last_seq:0,files:{'note.md':entry},generation:value}));await assert.rejects(new LocalIndex(adapter,STATE).load(),/index|recover/i);
});
test('invalid optional field primary falls back without trusting corrupt folder or base path',async()=>{
 const {files,adapter}=storage();files.set(STATE,JSON.stringify({last_seq:9,generation:99,files:{'bad.md':{...entry,folder:'false',base_path:{}}}}));files.set(STATE+'.bak',JSON.stringify({last_seq:2,generation:2,files:{'good.md':entry}}));
 const index=new LocalIndex(adapter,STATE);await index.load();assert.equal(index.get('bad.md'),undefined);assert.deepEqual(index.get('good.md'),entry);assert.equal(index.needsRecovery(),true);
});
test('valid optional field values survive parsing without coercion',async()=>{
 const {files,adapter}=storage();const valid={...entry,folder:false,dirty:true,preserve_on_delete:false,recovery_preserved:true,base_path:'source.md'};
 files.set(STATE,JSON.stringify({last_seq:0,files:{'note.md':valid},recovery_pending:true,generation:0}));const index=new LocalIndex(adapter,STATE);await index.load();assert.deepEqual(index.get('note.md'),valid);assert.equal(index.needsRecovery(),true);
});
for(const failedPath of [STATE+'.bak',STATE]) for(const afterWrite of [false,true]) test(`mutation while ${failedPath} fails ${afterWrite?'after':'before'} publication remains pending for retry`,async()=>{
 const {files,adapter}=storage();const index=new LocalIndex(adapter,STATE);index.set('note.md',entry);await index.save();
 const write=adapter.write;let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let injected=false;
 adapter.write=async(p,v)=>{if(p===failedPath&&!injected){injected=true;entered();await gate;if(afterWrite)await write(p,v);throw Error('EIO');}return write(p,v);};
 index.set('note.md',{...entry,base_rev:2});const saving=index.save();await started;index.set('note.md',{...entry,base_rev:3});const rejected=assert.rejects(saving,/EIO/);release();await rejected;
 adapter.write=write;await index.save();const fresh=new LocalIndex(adapter,STATE);await fresh.load();assert.equal(fresh.get('note.md').base_rev,3);assert.deepEqual(JSON.parse(files.get(STATE)),JSON.parse(files.get(STATE+'.bak')));
});
