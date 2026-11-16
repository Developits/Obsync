import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestServer,createTestDevice} from './harness.mjs';
async function pair(){const s=await createTestServer();const a=createTestDevice(s,'a',await s.mintToken('a')),b=createTestDevice(s,'b',await s.mintToken('b'));await a.edit('source.md','source bytes');await a.sync();await b.sync();return {a,b};}
test('queued destination cannot be pushed under source revision while rename transport fails',async()=>{
 const {a,b}=await pair();await a.rename('source.md','dest.md');await a.edit('dest.md','UNSENT EDIT');await b.edit('dest.md','unrelated destination');await b.sync();
 const rename=a.client.rename.bind(a.client);a.client.rename=async()=>{throw Error('network down');};const first=await a.sync();
 assert.equal(await a.vault.read('dest.md'),'UNSENT EDIT');assert.equal(Buffer.from((await a.client.getFile('dest.md')).data).toString(),'unrelated destination');assert.equal(a.index.getQueuedRenames().length,1);assert.ok(first.pending>0);
 a.client.rename=rename;await a.sync();await a.sync();await b.sync();assert.equal(await a.vault.read('dest.md'),'UNSENT EDIT');
 const texts=[...a.vault.files].filter(([p])=>!p.startsWith('.index/')).map(([,b])=>b.toString());assert.ok(texts.includes('unrelated destination'));assert.equal(a.index.getQueuedRenames().length,0);
});
test('remote destination tombstone cannot delete a locally queued rename destination',async()=>{
 const {a,b}=await pair();await b.edit('dest.md','old destination');await b.sync();await b.delete('dest.md');await b.sync();await a.rename('source.md','dest.md');await a.sync();await b.sync();assert.equal(await a.vault.read('dest.md'),'source bytes');assert.equal(await b.vault.read('dest.md'),'source bytes');
});
