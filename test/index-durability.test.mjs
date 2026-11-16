import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalIndex} from '../plugin/src/index-store.ts';
const state=(rev)=>({base_rev:rev,base_hash:'',local_hash:'',mtime:1,dirty:true});
test('index saves serialize so an older write cannot replace newer durable state',async()=>{
 let disk=null,release,started;
 const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);let writes=0;
 const adapter={read:async()=>disk,write:async(_p,payload)=>{writes++;if(writes===1){started();await gate;}disk=payload;}};
 const index=new LocalIndex(adapter);index.set('note.md',state(1));
 const first=index.save();await entered;index.set('note.md',state(2));const second=index.save();
 // Yield to any incorrectly concurrent write before releasing the old one.
 await Promise.resolve();await Promise.resolve();release();await Promise.all([first,second]);await index.save();
 const fresh=new LocalIndex(adapter);await fresh.load();assert.deepEqual(fresh.get('note.md'),state(2));assert.equal(writes,4);
});
