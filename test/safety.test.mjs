import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestServer,createTestDevice} from './harness.mjs';

async function pair(){const server=await createTestServer();return {server,a:createTestDevice(server,'A',await server.mintToken('A')),b:createTestDevice(server,'B',await server.mintToken('B'))}}

test('pull checkpoint cannot skip a remote write between pull and push',async()=>{
 const {a,b}=await pair();await a.edit('local.md','A');
 const changes=a.client.changes.bind(a.client);let injected=false;
 a.client.changes=async(...args)=>{const page=await changes(...args);if(!injected){injected=true;await b.edit('remote.md','B');await b.sync()}return page};
 await a.sync();await a.sync();
 assert.equal(await a.vault.exists('remote.md'),true);assert.equal(await a.vault.read('remote.md'),'B');
});

test('edit made while upload awaits must remain pending until its bytes are uploaded',async()=>{
 const {a,b}=await pair();await a.edit('flight.md','old');
 const put=a.client.putFile.bind(a.client);let once=false;
 a.client.putFile=async(...args)=>{const response=await put(...args);if(!once){once=true;await a.edit('flight.md','new during upload')}return response};
 await a.sync();await a.sync();await b.sync();
 assert.equal(await b.vault.read('flight.md'),'new during upload');
});

test('delete made while upload awaits must reach the server next cycle',async()=>{
 const {a,b}=await pair();await a.edit('delete-flight.md','old');
 const put=a.client.putFile.bind(a.client);let once=false;
 a.client.putFile=async(...args)=>{const response=await put(...args);if(!once){once=true;await a.delete('delete-flight.md')}return response};
 await a.sync();await a.sync();await b.sync();
 assert.equal(await b.vault.exists('delete-flight.md'),false);
});

test('directory events cannot send directories through binary upload',async()=>{
 const {a,b}=await pair();
 a.vault.files.set('Folder',Buffer.alloc(0));
 a.index.set('Folder',{base_rev:0,base_hash:'',local_hash:'',mtime:Date.now(),dirty:true,folder:true});
 const list=a.vault.listFiles.bind(a.vault),read=a.vault.readBinary.bind(a.vault);
 a.vault.listFiles=async()=> (await list()).filter(p=>p!=='Folder');
 a.vault.readBinary=async p=>{if(p==='Folder')throw Error('EISDIR');return read(p)};
 await a.edit('Folder/note.md','nested');await a.sync();await b.sync();
 assert.equal(await b.vault.read('Folder/note.md'),'nested');
 assert.equal(a.index.get('Folder'),undefined);
});

test('edit during download cannot be overwritten by a stale clean-state decision',async()=>{
 const {a,b}=await pair();await a.edit('download.md','base');await a.sync();await b.sync();
 await b.edit('download.md','peer edit');await b.sync();
 const get=a.client.getFile.bind(a.client);let once=false;
 a.client.getFile=async(...args)=>{const response=await get(...args);if(!once){once=true;await a.edit('download.md','typed during download')}return response};
 try{await a.sync()}catch{} await a.sync();
 const all=await a.vault.listFiles();const texts=await Promise.all(all.map(p=>a.vault.read(p)));
 assert.ok(texts.some(t=>t==='typed during download'));
});

test('parallel conflict preservation stays distinct even when adapter create is non-exclusive',async()=>{
 const {a}=await pair();
 // Obsidian Vault.createBinary can pass its existence check in both calls.
 // Reproduce that real-native behavior, not an unrealistically atomic mock.
 a.engine.adapter.createBinary=(path,data)=>a.vault.writeBinary(path,data);
 const paths=await Promise.all([
  a.engine.preserveConflict('Parallel.md','peer',new TextEncoder().encode('one').buffer),
  a.engine.preserveConflict('Parallel.md','peer',new TextEncoder().encode('two').buffer),
 ]);
 assert.equal(new Set(paths).size,2);
 assert.equal(await a.vault.read(paths[0]),'one');assert.equal(await a.vault.read(paths[1]),'two');
});
