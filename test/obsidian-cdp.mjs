import fs from 'node:fs/promises';
export async function connect(port=9223) {
 const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const target=targets.find(t=>t.type==='page' && t.url.startsWith('app://obsidian')) || targets.find(t=>t.type==='page');
 if(!target) throw new Error('No Obsidian page target');
 const ws=new WebSocket(target.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 let id=0; const pending=new Map();
 ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id; pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
 return {target,call,close:()=>ws.close(),async evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value},async screenshot(path){const r=await call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path,Buffer.from(r.data,'base64'))}};
}
if(process.argv[1]===new URL(import.meta.url).pathname){const c=await connect();try{console.log(JSON.stringify(await c.evaluate(process.argv[2]||'({title:document.title,text:document.body.innerText.slice(0,4000),hasApp:typeof app!=="undefined"})'),null,2))}finally{c.close()}}
