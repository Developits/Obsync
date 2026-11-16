import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestServer,createTestDevice} from './harness.mjs';
import {LocalIndex} from '../plugin/src/index-store.ts';
import {SyncEngine} from '../plugin/src/sync-engine.ts';
async function setup(){const s=await createTestServer();const a=createTestDevice(s,'a',await s.mintToken('a')),b=createTestDevice(s,'b',await s.mintToken('b'));await a.edit('source.md','keep exact bytes');await a.sync();await b.sync();await b.client.rename('source.md','.index/hidden.md',b.index.get('source.md').base_rev);return {a,b};}
const texts=a=>[...a.vault.files].filter(([p])=>!p.startsWith('.index/')).map(([,v])=>v.toString());
test('excluded-rename preservation intent survives page checkpoint and index restart',async()=>{
 const {a}=await setup();const page=await a.client.changes(a.index.getSeq(),1);assert.equal(page.entries.length,1);await a.engine.applyRemoteChange(page.entries[0]);a.index.setSeq(page.next_seq);await a.index.save();
 const index=new LocalIndex({read:async p=>await a.vault.exists(p)?a.vault.read(p):null,write:(p,v)=>a.vault.write(p,v)},'.index/sync-state.json');await index.load();
 const engine=new SyncEngine({adapter:a.vault,index,client:a.client,deviceName:'a',excludes:['.index']});await engine.sync();assert.ok(texts(a).includes('keep exact bytes'));assert.equal(await a.vault.exists('.index/hidden.md'),false);
});
test('failed excluded-rename artifact creation cannot delete the source',async()=>{
 const {a}=await setup();const write=a.vault.writeBinary.bind(a.vault);a.vault.writeBinary=async(p,v)=>{if(p.includes('(conflict'))throw Error('ENOSPC');return write(p,v);};
 const result=await a.sync();assert.ok(result.failed>0);assert.equal(await a.vault.read('source.md'),'keep exact bytes');a.vault.writeBinary=write;await a.sync();assert.ok(texts(a).includes('keep exact bytes'));
});
