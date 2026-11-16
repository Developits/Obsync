import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalIndex} from '../plugin/src/index-store.ts';
const entry={base_rev:1,base_hash:'hash',local_hash:'hash',mtime:1,dirty:false};
function storage(){const files=new Map();return {files,adapter:{read:async p=>files.get(p)??null,write:async(p,v)=>{files.set(p,v);}}};}
test('corrupt primary index recovers checkpoint, entries and queued rename from valid backup',async()=>{
 const {files,adapter}=storage();const i=new LocalIndex(adapter,'state.json');i.set('moved.md',entry);i.setSeq(7);i.queueRename({from:'source.md',to:'moved.md',base_rev:1});await i.save();files.set('state.json','{');
 const fresh=new LocalIndex(adapter,'state.json');await fresh.load();assert.equal(fresh.getSeq(),7);assert.deepEqual(fresh.get('moved.md'),entry);assert.deepEqual(fresh.getQueuedRenames(),i.getQueuedRenames());await fresh.save();assert.equal(JSON.parse(files.get('state.json')).last_seq,7);
});
test('corrupt primary and backup fail closed instead of forgetting sync identity',async()=>{
 const {files,adapter}=storage();files.set('state.json','{');files.set('state.json.bak','null');const i=new LocalIndex(adapter,'state.json');await assert.rejects(i.load(),/index.*(corrupt|invalid)|recover/i);assert.equal(files.get('state.json'),'{');
});
test('schema-invalid primary cannot override a valid backup',async()=>{
 const {files,adapter}=storage();const i=new LocalIndex(adapter,'state.json');i.set('note.md',entry);await i.save();files.set('state.json',JSON.stringify({last_seq:'oops',files:[]}));const fresh=new LocalIndex(adapter,'state.json');await fresh.load();assert.deepEqual(fresh.get('note.md'),entry);
});
test('brand-new empty index is distinct from unreadable storage',async()=>{
 const {adapter}=storage();await new LocalIndex(adapter).load();await assert.rejects(new LocalIndex({read:async()=>{throw Error('EACCES');},write:async()=>{}}).load(),/index|EACCES/i);
});
