import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalIndex} from '../plugin/src/index-store.ts';
import {LocalDiagnostics} from '../plugin/src/diagnostics.ts';
import {SyncEngine} from '../plugin/src/sync-engine.ts';
import {createTestServer,createTestDevice} from './harness.mjs';

test('index treats prototype-like file names as ordinary own entries across save/restart',async()=>{
 const files=new Map();
 const adapter={async read(p){return files.get(p)??null;},async write(p,v){files.set(p,v);}};
 const index=new LocalIndex(adapter);
 for(const path of ['__proto__','constructor','toString']){
   assert.equal(index.get(path),undefined);
   index.set(path,{base_rev:1,base_hash:'hash',local_hash:'hash',mtime:1,dirty:true});
 }
 await index.save();
 const restored=new LocalIndex(adapter);await restored.load();
 assert.equal(restored.allEntries().length,3);
 for(const path of ['__proto__','constructor','toString']){
   assert.equal(restored.get(path).base_rev,1);
   restored.remove(path);assert.equal(restored.get(path),undefined);
 }
});

test('diagnostics reject non-object frames and invalid marker types without leaking payloads',async()=>{
 const root='.custom/plugins/distributed-sync/diagnostics';
 const files=new Map([[`${root}/session.json`,JSON.stringify({schema:1,state:{secret:'PRIVATE'}})]]);
 const adapter={
   async exists(p){return files.has(p);},async mkdir(){},
   async stat(p){return files.has(p)?{size:Buffer.byteLength(files.get(p))}:null;},
   async read(p){return files.get(p);},async write(p,t){files.set(p,t);}
 };
 const logger=new LocalDiagnostics(adapter,{pluginDir:'.custom/plugins/distributed-sync'});
 await logger.start();
 logger.log('global_error',{frames:[null,'PRIVATE',[],{line:'1',column:2},{line:3,column:4,secret:'PRIVATE'}]});
 await logger.flush();
 const rows=files.get(`${root}/current.jsonl`).trim().split('\n').map(JSON.parse);
 assert.ok(rows.some(r=>r.event==='marker_invalid'));
 assert.deepEqual(rows.find(r=>r.event==='global_error').frames,[{line:3,column:4}]);
 assert.ok(!files.get(`${root}/current.jsonl`).includes('PRIVATE'));
 await logger.close();
});

test('large uploads use the injected host scheduler without global timers',async()=>{
 const server=await createTestServer();
 const device=createTestDevice(server,'scheduler-test',await server.mintToken('scheduler-test'));
 for(let i=0;i<21;i++)await device.edit(`note-${i}.md`,'content');
 let yields=0;
 const engine=new SyncEngine({adapter:device.vault,index:device.index,client:device.client,deviceName:'scheduler-test',yieldToEventLoop:async()=>{yields++;}});
 const result=await engine.sync();
 assert.equal(result.pushed,21);
 assert.equal(result.failed,0);
 assert.equal(yields,2);
});
