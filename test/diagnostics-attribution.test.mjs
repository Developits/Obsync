import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalDiagnostics,DIAGNOSTICS_DIR} from '../plugin/src/diagnostics.ts';
function setup(){
 const files=new Map();
 const adapter={exists:async p=>files.has(p),mkdir:async()=>{},stat:async p=>files.has(p)?{size:Buffer.byteLength(files.get(p))}:null,read:async p=>files.get(p),write:async(p,v)=>{files.set(p,v);}};
 const d=new LocalDiagnostics(adapter);const target=new EventTarget();
 const records=()=>[...files].filter(([p])=>p.endsWith('.jsonl')).flatMap(([,v])=>v.split('\n').filter(Boolean).map(JSON.parse));
 return {d,target,records,files};
}
test('whitespace @-style foreign throwing frames block attribution to a later plugin caller',async()=>{
 const {d,target,records}=setup();await d.start();d.attachGlobalHandlers(target);
 for(const first of ['foreign throw@plugin:unrelated:1:32','  foreign throw@plugin:unrelated:1:32','foreign throw@foreign plugin.js:1:32']){
  const stack=`Error: foreign\n${first}\ncaller@plugin:obsidian-distributed-sync:9:8`;
  for(const type of ['error','unhandledrejection']){
   const event=new Event(type);Object.assign(event,type==='error'?{error:{stack}}:{reason:{stack}});target.dispatchEvent(event);
  }
 }
 await d.flush();assert.equal(records().filter(r=>r.event==='global_error'||r.event==='unhandled_rejection').length,0);await d.close();
});
test('email-like exception header does not mask a genuine plugin throwing frame or leak its text',async()=>{
 const {d,target,records,files}=setup();await d.start();d.attachGlobalHandlers(target);
 for(const [header,frame] of [['Error: private@example.invalid',' at own (plugin:obsidian-distributed-sync:4:5)'],['TypeError: private@example.invalid','own@plugin:obsidian-distributed-sync:6:7']]){
  const event=new Event('error');event.error={name:'TypeError',stack:`${header}\n${frame}`};target.dispatchEvent(event);
 }
 await d.flush();const captured=records().filter(r=>r.event==='global_error');assert.equal(captured.length,2);assert.deepEqual(captured.map(r=>r.frames),[[{line:4,column:5}],[{line:6,column:7}]]);assert.ok(![...files.values()].join('').includes('private@example.invalid'));assert.ok(files.has(`${DIAGNOSTICS_DIR}/current.jsonl`));await d.close();
});
