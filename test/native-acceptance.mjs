// Opt-in actual Obsidian acceptance. Only attach to the two named disposable vaults.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {connect} from './obsidian-cdp.mjs';
const out=process.env.NATIVE_EVIDENCE_DIR;
if(!out)throw Error('Set NATIVE_EVIDENCE_DIR to a private test-evidence directory');
await fs.mkdir(out,{recursive:true});
const a=await connect(9223),b=await connect(9224),results=[];
const ev=(c,code)=>c.evaluate(`(async()=>{const p=app.plugins.plugins['obsidian-distributed-sync'];${code.replaceAll('\n','\\n')}})()`);
for(const [c,name] of [[a,'Obsync-QA-A'],[b,'Obsync-QA-B']]){
 assert.equal(await c.evaluate('app.vault.getName()'),name,'Refusing a non-QA vault');
 assert.equal(await c.evaluate("!!app.plugins.plugins['obsidian-distributed-sync']"),true,'QA plugin must be enabled before running acceptance');
}
const sync=(c)=>ev(c,'await p.triggerSync(true);return {status:p.statusBarItem.innerText};');
const get=(c,path)=>ev(c,`return await app.vault.adapter.read(${JSON.stringify(path)});`);
async function run(name,fn){try{const evidence=await fn();results.push({name,status:'PASS',evidence})}catch(error){results.push({name,status:'FAIL',error:String(error)})}console.log(JSON.stringify(results.at(-1)));await fs.writeFile(out+'/native-acceptance.json',JSON.stringify(results,null,2))}
try{
 await run('automatic sync off prevents startup transfers',async()=>{const state=await ev(a,`return {autoSync:p.settings.autoSync,seq:p.index.getSeq(),tracked:p.index.get('QA.md')??null};`);assert.equal(state.autoSync,false);assert.equal(state.tracked,null);return state});
 await run('two native instances exchange notes and binary bytes',async()=>{
  await ev(a,`await app.vault.create('Basic.md','one');await app.vault.createBinary('Bytes.bin',Uint8Array.from([0,255,42,0,128]).buffer);await p.triggerSync(true);return true;`);await sync(b);
  assert.equal(await get(b,'Basic.md'),'one');const bytes=await ev(b,`return Array.from(new Uint8Array(await app.vault.adapter.readBinary('Bytes.bin')));`);assert.deepEqual(bytes,[0,255,42,0,128]);
  await ev(b,`await app.vault.modify(app.vault.getAbstractFileByPath('Basic.md'),'two');await p.triggerSync(true);return true;`);await sync(a);assert.equal(await get(a,'Basic.md'),'two');return {bytes,note:await get(a,'Basic.md')};
 });
 await run('nested folders and folder rename sync their files',async()=>{
  await ev(a,`await app.vault.createFolder('Nested');await app.vault.createFolder('Nested/Inner');await app.vault.create('Nested/Inner/Note.md','nested bytes');await p.triggerSync(true);return true;`);await sync(b);assert.equal(await get(b,'Nested/Inner/Note.md'),'nested bytes');
  await ev(a,`await app.vault.rename(app.vault.getAbstractFileByPath('Nested'),'MovedFolder');await p.triggerSync(true);return true;`);await sync(b);assert.equal(await get(b,'MovedFolder/Inner/Note.md'),'nested bytes');assert.equal(await ev(b,`return await app.vault.adapter.exists('Nested/Inner/Note.md');`),false);return {nested:await get(b,'MovedFolder/Inner/Note.md')};
 });
 await run('offline edit plus rename remains in destination or server history',async()=>{
  await ev(a,`await app.vault.create('Rename.md','base');await p.triggerSync(true);return true;`);await sync(b);
  await ev(a,`await app.vault.modify(app.vault.getAbstractFileByPath('Rename.md'),'UNIQUE OFFLINE EDIT');await app.vault.rename(app.vault.getAbstractFileByPath('Rename.md'),'Renamed.md');await p.triggerSync(true);return true;`);await sync(b);assert.equal(await get(b,'Renamed.md'),'UNIQUE OFFLINE EDIT');
  await ev(b,`await app.vault.modify(app.vault.getAbstractFileByPath('Renamed.md'),'peer rewrite');await p.triggerSync(true);return true;`);await sync(a);
  const history=await ev(a,`const texts=[];for(let r=1;r<=4;r++){try{texts.push(new TextDecoder().decode((await p.client.getFile('Renamed.md',r)).data))}catch{}}return texts;`);assert.ok(history.includes('UNIQUE OFFLINE EDIT'));return {history};
 });
 await run('reusing a local rename source does not delete the new note',async()=>{
  await ev(a,`await app.vault.create('Reuse.md','old note');await p.triggerSync(true);await app.vault.rename(app.vault.getAbstractFileByPath('Reuse.md'),'Reuse-moved.md');await app.vault.create('Reuse.md','NEW UNRELATED NOTE');await p.triggerSync(true);await p.triggerSync(true);return true;`);assert.equal(await get(a,'Reuse.md'),'NEW UNRELATED NOTE');await sync(b);assert.equal(await get(b,'Reuse.md'),'NEW UNRELATED NOTE');return {newNote:await get(b,'Reuse.md')};
 });
 await run('remote-between-pull-and-push cannot be skipped',async()=>{
  await ev(a,`await app.vault.create('Cursor-local.md','local');const orig=p.client.changes.bind(p.client);let once=false;p.client.changes=async(...args)=>{const page=await orig(...args);if(!once){once=true;const peer=new p.client.constructor(p.settings.serverUrl,p.settings.token,'QA-peer',p.client.requestUrlFn);await peer.putFile('Cursor-remote.md',0,new TextEncoder().encode('remote').buffer,Date.now())}return page};try{await p.triggerSync(true)}finally{p.client.changes=orig}await p.triggerSync(true);return true;`);assert.equal(await get(a,'Cursor-remote.md'),'remote');return {note:await get(a,'Cursor-remote.md')};
 });
 await run('edit during upload reaches the other device',async()=>{
  await ev(a,`await app.vault.create('Flight.md','before');const orig=p.client.putFile.bind(p.client);let once=false;p.client.putFile=async(...args)=>{const res=await orig(...args);if(args[0]==='Flight.md'&&!once){once=true;await app.vault.modify(app.vault.getAbstractFileByPath('Flight.md'),'during upload')}return res};try{await p.triggerSync(true)}finally{p.client.putFile=orig}await p.triggerSync(true);return true;`);await sync(b);assert.equal(await get(b,'Flight.md'),'during upload');return {note:await get(b,'Flight.md')};
 });
 await run('edit during download survives a stale remote response',async()=>{
  await ev(a,`await app.vault.create('Download.md','base');await p.triggerSync(true);return true;`);await sync(b);await ev(b,`await app.vault.modify(app.vault.getAbstractFileByPath('Download.md'),'peer');await p.triggerSync(true);return true;`);
  await ev(a,`const orig=p.client.getFile.bind(p.client);let once=false;p.client.getFile=async(...args)=>{const res=await orig(...args);if(args[0]==='Download.md'&&!once){once=true;await app.vault.modify(app.vault.getAbstractFileByPath('Download.md'),'during download')}return res};try{await p.triggerSync(true)}finally{p.client.getFile=orig}await p.triggerSync(true);return true;`);
  const texts=await ev(a,`return await Promise.all(app.vault.getFiles().filter(f=>f.path.startsWith('Download')).map(f=>app.vault.read(f)));`);assert.ok(texts.includes('during download'));return {texts};
 });
 await run('local delete versus remote edit recovers instead of crashing',async()=>{
  await ev(a,`await app.vault.create('Delete.md','base');await p.triggerSync(true);return true;`);await sync(b);await ev(b,`await app.vault.delete(app.vault.getAbstractFileByPath('Delete.md'));return true;`);await ev(a,`await app.vault.modify(app.vault.getAbstractFileByPath('Delete.md'),'remote edit');await p.triggerSync(true);return true;`);await sync(b);assert.equal(await get(b,'Delete.md'),'remote edit');return {note:await get(b,'Delete.md')};
 });
 await run('untracked old filename is not adopted as remote rename lineage',async()=>{
  await ev(a,`await app.vault.create('Origin.md','legitimate');await p.triggerSync(true);await app.vault.rename(app.vault.getAbstractFileByPath('Origin.md'),'Destination.md');await p.triggerSync(true);return true;`);
  await ev(b,`await app.vault.create('Origin.md','unrelated phone note');await p.triggerSync(true);return true;`);assert.equal(await get(b,'Origin.md'),'unrelated phone note');assert.equal(await get(b,'Destination.md'),'legitimate');await sync(a);assert.equal(await get(a,'Destination.md'),'legitimate');return {origin:await get(b,'Origin.md'),destination:await get(a,'Destination.md')};
 });
 await run('moving into excluded folder does not delete the remote copy',async()=>{
  await ev(a,`await app.vault.create('KeepRemote.md','keep on server');await p.triggerSync(true);return true;`);await sync(b);
  await ev(a,`p.settings.excludes.push('Excluded');await app.vault.createFolder('Excluded');await app.vault.rename(app.vault.getAbstractFileByPath('KeepRemote.md'),'Excluded/KeepRemote.md');await p.triggerSync(true);return true;`);await sync(b);assert.equal(await get(b,'KeepRemote.md'),'keep on server');return {remoteCopy:await get(b,'KeepRemote.md')};
 });
 await run('failed upload cannot display fully Synced',async()=>{
  const state=await ev(a,`await app.vault.create('Failure.md','pending bytes');const orig=p.client.putFile.bind(p.client);p.client.putFile=async(...args)=>{if(args[0]==='Failure.md')throw Error('QA injected transport failure');return orig(...args)};try{await p.triggerSync(true);return {status:p.statusBarItem.innerText,dirty:p.index.get('Failure.md')?.dirty}}finally{p.client.putFile=orig}`);
  assert.equal(state.dirty,true);assert.notEqual(state.status,'✓ Synced');await a.screenshot(out+'/native-pending-status.png');await sync(a);return state;
 });
 await a.screenshot(out+'/native-final-a.png');await b.screenshot(out+'/native-final-b.png');
 console.log(JSON.stringify({total:results.length,pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length}));
 if(results.some(r=>r.status!=='PASS'))process.exitCode=1;
}finally{a.close();b.close()}
