import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {LocalIndex} from '../plugin/src/index-store.ts';
import {SyncEngine} from '../plugin/src/sync-engine.ts';
import {createTestServer,createTestDevice} from './harness.mjs';

const require=createRequire(import.meta.url);
const {build}=require('../plugin/node_modules/esbuild');

class TFile{constructor(path){this.path=path}}
const notices=[];
const timerCalls={intervals:[],timeouts:[],clearedIntervals:[],clearedTimeouts:[]};
let nextTimerId=1;
function resetTimers(){timerCalls.intervals.length=0;timerCalls.timeouts.length=0;timerCalls.clearedIntervals.length=0;timerCalls.clearedTimeouts.length=0;nextTimerId=1}
function stubSetTimeout(fn,ms){const id=nextTimerId++;timerCalls.timeouts.push({id,ms,fn});return id}
function stubClearTimeout(id){timerCalls.clearedTimeouts.push(id)}
function stubSetInterval(fn,ms){const id=nextTimerId++;timerCalls.intervals.push({id,ms,fn});return id}
function stubClearInterval(id){timerCalls.clearedIntervals.push(id)}

class Plugin{
  constructor(){this._intervals=[];this._registrations=[];this._data={}}
  registerInterval(id){this._intervals.push(id);return id}
  register(cb){this._registrations.push(cb);return cb}
  registerEvent(){}
  addStatusBarItem(){return {text:'',setText(t){this.text=t},onClickEvent(){}}}
  addRibbonIcon(){}
  addCommand(){}
  addSettingTab(){}
  async loadData(){return this._data}
  async saveData(data){this._saved=data}
}
const obsidian={Plugin,TFile,Notice:class{constructor(text){notices.push(text)}},PluginSettingTab:class{},Setting:class{},requestUrl:async()=>({status:200,json:{},arrayBuffer:new ArrayBuffer(0),headers:{}})};
const bundled=await build({entryPoints:['plugin/src/main.ts'],bundle:true,platform:'node',format:'cjs',external:['obsidian'],write:false});
const context={module:{exports:{}},exports:{},require:n=>{if(n==='obsidian')return obsidian;throw Error(n)},console,crypto,TextEncoder,TextDecoder,setTimeout,clearTimeout,window:{setTimeout:stubSetTimeout,clearTimeout:stubClearTimeout,setInterval:stubSetInterval,clearInterval:stubClearInterval}};
vm.runInNewContext(bundled.outputFiles[0].text,context);
const PluginClass=context.module.exports.default;
function instance(){const p=new PluginClass();p.index=new LocalIndex({async read(){return null},async write(){}});p.settings={autoSync:false,excludes:[]};return p}

function mockApp(files=new Map()){
  const adapter={
    async exists(p){return files.has(p)},
    async read(p){if(!files.has(p))throw Error('missing');return files.get(p)},
    async write(p,d){files.set(p,d)},
    async mkdir(){},
  };
  return {files,vault:{adapter,on:()=>'',getFiles:()=>[]}};
}

async function loadPlugin(data){
  const p=new PluginClass();
  p._data=data;
  p.app=mockApp();
  await p.onload();
  return p;
}

test('folder rename queues renames for each indexed descendant file',()=>{
 const p=instance();p.index.set('Old/note.md',{base_rev:1,base_hash:'abc',local_hash:'abc',mtime:1,dirty:false});
 p.onFileRenamed({path:'New'},'Old');
 assert.equal(p.index.getQueuedRenames()[0]?.from,'Old/note.md');
 assert.equal(p.index.getQueuedRenames()[0]?.to,'New/note.md');
 assert.equal(p.index.get('Old/note.md'),undefined);
 assert.equal(p.index.get('New/note.md')?.base_rev,1);
});

test('B3: moving a tracked file into an excluded folder detaches tracking without a remote deletion',async(t)=>{
 const server=await createTestServer();
 const remote=createTestDevice(server,'remote',await server.mintToken('remote'));
 const phone=createTestDevice(server,'phone',await server.mintToken('phone'));
 await remote.edit('Doc.md','remote doc');await remote.sync();await phone.sync();
 assert.equal(phone.index.get('Doc.md')?.base_rev,1);

 const p=instance();p.index=phone.index;p.settings={autoSync:false,excludes:['Archive']};
 await phone.vault.rename('Doc.md','Archive/Doc.md');
 p.onFileRenamed(new TFile('Archive/Doc.md'),'Doc.md');

 assert.equal(p.index.get('Doc.md'),undefined,'excluded move must not leave a dirty deletion intent');
 assert.deepEqual(p.index.getQueuedRenames(),[]);
 assert.equal(p.index.get('Archive/Doc.md'),undefined);

 const engine=new SyncEngine({adapter:phone.vault,index:phone.index,client:phone.client,deviceName:'phone',excludes:['Archive']});
 const res=await engine.sync();
 await remote.sync();
 t.diagnostic(`sync=${JSON.stringify(res)} remoteHasDoc=${await remote.vault.exists('Doc.md')}`);
 assert.equal(await remote.vault.read('Doc.md'),'remote doc','remote copy must not be deleted by an excluded local move');
});

test('B3: folder moved out of an excluded tree is picked up by the safe scan',async(t)=>{
 const server=await createTestServer();
 const remote=createTestDevice(server,'remote',await server.mintToken('remote'));
 const phone=createTestDevice(server,'phone',await server.mintToken('phone'));
 await phone.vault.write('Archive/Sub/note.md','note out of excluded');
 // Physical move performed by the user; the excluded source was never indexed.
 await phone.vault.remove('Archive/Sub/note.md');
 await phone.vault.write('Notes/note.md','note out of excluded');

 const p=instance();p.index=phone.index;p.settings={autoSync:false,excludes:['Archive']};
 p.onFileRenamed({path:'Notes'},'Archive/Sub');

 const engine=new SyncEngine({adapter:phone.vault,index:phone.index,client:phone.client,deviceName:'phone',excludes:['Archive']});
 await engine.sync();
 await remote.sync();
 assert.equal(await remote.vault.read('Notes/note.md'),'note out of excluded');
});

test('M2: local modify event preserves the paired base_path',()=>{
 const p=instance();
 p.index.set('New/Y.md',{base_rev:1,base_path:'Old/X.md',base_hash:'abc',local_hash:'abc',mtime:1,dirty:false});
 p.onFileModified({path:'New/Y.md'});
 const state=p.index.get('New/Y.md');
 assert.equal(state?.base_path,'Old/X.md');
 assert.equal(state?.base_rev,1);
 assert.equal(state?.dirty,true);
});

test('M2: destination rename acknowledgement clears a stale base_path',async(t)=>{
 const server=await createTestServer();
 const a=createTestDevice(server,'a',await server.mintToken('a'));
 const b=createTestDevice(server,'b',await server.mintToken('b'));
 await a.edit('Y.md','base Y');await a.sync();await b.sync();
 // Simulate the paired base a rename-follow records (base path X at rev 1).
 b.index.set('Y.md',{...b.index.get('Y.md'),base_path:'X.md',base_rev:1});
 await b.rename('Y.md','Z.md');
 await b.sync();
 const state=b.index.get('Z.md');
 t.diagnostic(`state=${JSON.stringify(state)}`);
 assert.equal(state?.base_path,undefined,'acknowledged destination revision must not keep the source base path');
 assert.ok(state.base_rev>=1);
});

test('N4: manual sync reports failed and pending work honestly',async()=>{
 const p=instance();
 p.settings={autoSync:false,excludes:[],token:'t'};
 p.statusBarItem={text:'',setText(t){this.text=t}};
 p.engine={sync:async()=>({pulled:2,pushed:1,conflicts:0,failed:2,pending:3,errors:[{path:'bad.md',operation:'scan',message:'x'}]})};
 notices.length=0;
 await p.triggerSync(true);
 assert.ok(notices.some((n)=>/2 failed/.test(n)),`notice must report failures: ${notices}`);
 assert.ok(notices.some((n)=>/3 pending/.test(n)),`notice must report pending work: ${notices}`);
 assert.ok(/error|pending|failed/i.test(p.statusBarItem.text),`status bar must not claim success: ${p.statusBarItem.text}`);
});

test('N5: startup timer obeys autoSync',async()=>{
 resetTimers();
 await loadPlugin({token:'t',autoSync:false});
 assert.equal(timerCalls.intervals.length,0,'no polling timer when autoSync is off');
 assert.equal(timerCalls.timeouts.length,0,'no startup sync when autoSync is off');
});

test('N5: settings changes refresh timers and unload cancels them',async()=>{
 resetTimers();
 const p=await loadPlugin({token:'t',autoSync:true,syncIntervalSeconds:30});
 assert.equal(timerCalls.intervals.length,1);
 assert.equal(timerCalls.intervals[0].ms,30000);
 assert.equal(timerCalls.timeouts.length,1);
 const firstInterval=timerCalls.intervals[0].id;
 const startupTimeout=timerCalls.timeouts[0].id;

 p.settings.syncIntervalSeconds=60;
 await p.saveSettings();
 assert.ok(timerCalls.clearedIntervals.includes(firstInterval),'old interval must be cleared on refresh');
 const active=timerCalls.intervals[timerCalls.intervals.length-1];
 assert.equal(active.ms,60000);
 assert.equal(timerCalls.intervals.filter((t)=>!timerCalls.clearedIntervals.includes(t.id)).length,1,'exactly one live interval');

 p.settings.autoSync=false;
 await p.saveSettings();
 assert.ok(timerCalls.clearedIntervals.includes(active.id),'turning autoSync off must clear the interval');

 p.settings.autoSync=true;
 await p.onFileModified({path:'typed.md'});
 const debounce=timerCalls.timeouts[timerCalls.timeouts.length-1];
 p.onunload();
 assert.ok(timerCalls.clearedTimeouts.includes(startupTimeout),'startup timeout must be cancellable');
 assert.ok(timerCalls.clearedTimeouts.includes(debounce.id),'debounce timer must be cancelled on unload');
});
