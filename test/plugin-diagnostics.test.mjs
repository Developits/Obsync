import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../plugin/package.json',import.meta.url)),{build}=require('esbuild');
const ROOT='.obsidian/plugins/distributed-sync/diagnostics';
const notices=[];
class Plugin {
  constructor(){this.commands=[];this.manifest={id:'distributed-sync',version:'1.0.1'};this._data={autoSync:false,token:'SECRET_TOKEN',deviceName:'SECRET_DEVICE',serverUrl:'https://SECRET_SERVER'};}
  async loadData(){return this._data;} async saveData(d){this._data=d;}
  addCommand(c){this.commands.push(c);}addSettingTab(t){this.tab=t;}addRibbonIcon(){}registerEvent(){}registerInterval(){}register(){}
  addStatusBarItem(){return {setText(t){this.text=t;},onClickEvent(){}};}
}
const buttons=[];
class Setting {
 constructor(){this.name='';}setName(n){this.name=n;return this;}setHeading(){return this;}setDesc(){return this;}
 addText(fn){fn({setPlaceholder(){return this;},setValue(){return this;},onChange(){return this;}});return this;}
 addToggle(fn){fn({setValue(){return this;},onChange(){return this;}});return this;}
 addButton(fn){const b={name:this.name,setButtonText(t){this.text=t;return this;},setCta(){return this;},setDisabled(){return this;},onClick(cb){this.click=cb;return this;}};buttons.push(b);fn(b);return this;}
}
const obsidian={Plugin,Notice:class{constructor(t){notices.push(t);}},TFile:class{},PluginSettingTab:class{constructor(){this.containerEl={empty(){},createEl(){}};}},Setting,requestUrl:async()=>{throw Object.assign(Error('SECRET_TOKEN /Secret.md'),{name:'ApiError',status:503});}};
const bundle=await build({entryPoints:['plugin/src/main.ts'],bundle:true,platform:'node',format:'cjs',external:['obsidian'],write:false});
function instance(options={}){
 const target=new EventTarget(),window=Object.assign(target,{setInterval(){throw Error('unexpected timer');},clearInterval(){},setTimeout(){throw Error('unexpected timer');},clearTimeout(){}});
 const c={module:{exports:{}},exports:{},require:n=>obsidian,console,crypto,TextEncoder,TextDecoder,window,navigator:{clipboard:{writeText:async()=>{}}}};
 vm.runInNewContext(bundle.outputFiles[0].text,c);const p=new c.module.exports.default();
 const files=new Map();const adapter={async exists(p){return files.has(p);},async mkdir(){},async stat(p){return files.has(p)?{size:Buffer.byteLength(files.get(p))}:null;},async read(p){return files.get(p);},async write(p,t){files.set(p,t);}};
 if(options.failLogger)adapter.write=async(p,t)=>{if(p.startsWith(ROOT))throw Error('ENOSPC SECRET_TOKEN');files.set(p,t);};
 if(options.failIndex)adapter.read=async(p)=>{if(p.endsWith('state.json')||p.endsWith('state.json.bak'))throw Error('SECRET_TOKEN index failed');return files.get(p);};
 if(options.failIndex)adapter.exists=async p=>p.endsWith('state.json')||p.endsWith('state.json.bak')||files.has(p);
  p.app={vault:{configDir:options.configDir??'.obsidian',adapter,on(){},getFiles(){return [];}}};Object.assign(p._data,options.settings??{});
 return {p,files,window};
}
function rows(files){return ['previous.jsonl','current.jsonl'].flatMap(n=>(files.get(`${ROOT}/${n}`)??'').split('\n').filter(Boolean).map(JSON.parse));}

test('invalid saved settings use validated defaults instead of unsafe assigned values',async()=>{
 const {p}=instance({settings:{token:42,serverUrl:{},deviceName:[],autoSync:'yes',syncIntervalSeconds:Infinity,excludes:[{}],localDiagnostics:'yes'}});
 await p.onload();
 assert.equal(p.settings.token,'');
 assert.equal(p.settings.serverUrl,'http://localhost:8787');
 assert.equal(p.settings.deviceName,'Desktop');
 assert.equal(p.settings.autoSync,true);
 assert.equal(p.settings.syncIntervalSeconds,30);
 assert.equal(p.settings.excludes.join(','),'.trash,.git');
 assert.equal(p.settings.localDiagnostics,true);
 p.onunload();await p.diagnostics.close();
});

test('declarative searchable settings render the same actionable rows as the legacy display',async()=>{
 const {p}=instance();await p.onload();
 const definitions=p.tab.getSettingDefinitions();
 assert.equal(definitions.length,7);
 assert.ok(definitions.some(d=>d.name==='Device token'));
 assert.ok(definitions.some(d=>d.name==='Local diagnostics'));
 assert.ok(definitions.every(d=>typeof d.desc==='string' && typeof d.render==='function'));
 buttons.length=0;
 for(const d of definitions)d.render(new Setting().setName(d.name));
 assert.equal(buttons.map(b=>b.text).join(','),'Export diagnostics,Generate token');
 buttons.length=0;p.tab.display();
 assert.equal(buttons.map(b=>b.text).join(','),'Export diagnostics,Generate token');
 p.onunload();await p.diagnostics.close();
});

test('unload returns void, detaches listeners immediately, and closes diagnostics asynchronously',async()=>{
 const {p,files,window}=instance();await p.onload();
 assert.equal(p.onunload(),undefined);
 const before=rows(files).filter(r=>r.event==='global_error').length;
 const event=new Event('error');Object.assign(event,{filename:'plugin:distributed-sync',lineno:1,colno:1,error:Error('not captured after unload')});
 window.dispatchEvent(event);
 await p.diagnostics.close();
 assert.equal(rows(files).filter(r=>r.event==='global_error').length,before);
 assert.equal(JSON.parse(files.get(`${ROOT}/session.json`)).state,'closed');
});

test('custom vault configuration directory contains diagnostics and index, and is excluded from sync',async()=>{
 const {p,files}=instance({configDir:'.custom-config'});
 await p.onload();
 p.index.set('note.md',{base_rev:0,base_hash:'',local_hash:'',mtime:0,dirty:true});
 await p.index.save();
 await p.exportDiagnostics();
 assert.ok(files.has('.custom-config/plugins/distributed-sync/state.json'));
 assert.ok(files.has('.custom-config/plugins/distributed-sync/diagnostics/export.json'));
 assert.ok(p.engine.excludes.includes('.custom-config'));
 p.onFileModified({path:'.custom-config/private-settings.json'});
 assert.equal(p.index.get('.custom-config/private-settings.json'),undefined);
 assert.ok(![...files.keys()].some(path=>path.startsWith('.obsidian/')));
 await p.onunload();
});

test('bundled plugin records failed/pending results and sanitized operation failures, export command and settings UI',async()=>{
 const {p,files}=instance();await p.onload();
 p.engine={sync:async()=>({pulled:1,pushed:2,conflicts:3,failed:1,pending:4,errors:[{operation:'push',path:'SECRET_PATH.md',message:'SECRET_CONTENT SECRET_TOKEN'}]})};
 await p.triggerSync(true);
 const events=rows(files);assert.equal(events.find(r=>r.event==='sync_result').pending,4);
 assert.equal(events.find(r=>r.event==='sync_failure').operation,'push');
 assert.equal(events.find(r=>r.event==='sync_result').conflicts,3);
 assert.ok(events.find(r=>r.event==='sync_start'));
 const command=p.commands.find(c=>c.id==='export-diagnostics');assert.ok(command);await command.callback();
 assert.ok(files.has(`${ROOT}/export.json`));assert.ok(notices.some(n=>n.includes(`${ROOT}/export.json`)));
 p.tab.display();const button=buttons.find(b=>b.text==='Export diagnostics');assert.ok(button);await button.click();
 const text=[...files.values()].join('\n');for(const v of ['SECRET_PATH','SECRET_CONTENT','SECRET_TOKEN','SECRET_DEVICE','SECRET_SERVER'])assert.ok(!text.includes(v),v);
 await p.onunload();
});

test('bundled plugin records sanitized sync exceptions, API/status and token failures',async()=>{
 const {p,files}=instance();await p.onload();
 p.engine={sync:async()=>{throw Object.assign(Error('SECRET_TOKEN /Secret.md'),{code:'ENOSPC'});}};await p.triggerSync();
 assert.equal(rows(files).find(r=>r.event==='sync_exception').code,'ENOSPC');
 await p.commands.find(c=>c.id==='check-status').callback();
 assert.equal(rows(files).find(r=>r.event==='status_failure').status,503);
 assert.equal(rows(files).find(r=>r.event==='api_failure').status,503);
 p.tab.display();await buttons.findLast(b=>b.text==='Generate token').click();
 assert.equal(rows(files).find(r=>r.event==='token_failure').status,503);
 assert.ok(![...files.values()].join('').includes('SECRET_TOKEN'));await p.onunload();
});

test('startup index failure is durable before engine setup',async()=>{
 const {p,files}=instance({failIndex:true});await assert.rejects(p.onload());
 assert.ok(rows(files).some(r=>r.event==='startup_failure'));assert.equal(p.engine,undefined);await p.onunload();
});

test('logger I/O failure warns once without changing successful sync semantics; export visibly fails',async()=>{
 notices.length=0;const {p}=instance({failLogger:true});await p.onload();let calls=0;
 p.engine={sync:async()=>{calls++;return {pulled:1,pushed:1,conflicts:0,failed:0,pending:0,errors:[]};}};
 await p.triggerSync(true);await p.triggerSync(true);assert.equal(calls,2);assert.equal(p.isSyncing,false);
 assert.match(p.statusBarItem.text,/Synced/);assert.equal(notices.filter(n=>/diagnostics.*unavailable/i.test(n)).length,1);
 await p.exportDiagnostics();assert.ok(notices.some(n=>/export.*failed|failed.*export/i.test(n)));await p.onunload();
});

test('rapid opt-out then enable waits for old logger close and resumes a single live logger',async()=>{
 const {p,files}=instance();await p.onload();
 const adapter=p.app.vault.adapter,write=adapter.write;let release,entered;
 const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 adapter.write=async(path,text)=>{if(path.startsWith(ROOT)){entered();await gate;}return write(path,text);};
 p.settings.localDiagnostics=false;const off=p.saveSettings();await ready;
 p.settings.localDiagnostics=true;const on=p.saveSettings();release();await Promise.all([off,on]);
 p.engine={sync:async()=>({pulled:0,pushed:0,conflicts:0,failed:0,pending:0,errors:[]})};await p.triggerSync();
 assert.ok(p.diagnostics && !p.diagnostics.stopped,'final enabled setting has one live logger');
 assert.ok(rows(files).some(r=>r.event==='sync_result'));await p.onunload();
});

test('disabled diagnostics performs no diagnostic I/O and works without Platform/apiVersion mocks',async()=>{
 const {p,files}=instance({settings:{localDiagnostics:false}});await p.onload();
 p.engine={sync:async()=>({pulled:0,pushed:0,conflicts:0,failed:0,pending:0,errors:[]})};await p.triggerSync();
 assert.equal([...files.keys()].filter(k=>k.startsWith(ROOT)).length,0);
 await p.onunload();
});
