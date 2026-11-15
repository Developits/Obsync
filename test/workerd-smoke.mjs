// Explicit opt-in local workerd/D1/R2 validation; never point at production.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const base=process.env.WORKER_URL??'http://127.0.0.1:8787';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Refusing a non-loopback Worker target');
const run='smoke-'+Date.now();const results=[];
async function request(endpoint,method='GET',body,extra={},token){
 const response=await fetch(base+'/v1'+endpoint,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...extra},body});
 const text=await response.text();let json;try{json=JSON.parse(text)}catch{}
 return {status:response.status,text,json};
}
const denied=await request('/tokens','POST','{}',{'Content-Type':'application/json'});
assert.equal(denied.status,401);results.push('unauthenticated enrollment denied');
const enrolled=await request('/tokens','POST',JSON.stringify({name:run}),{'Content-Type':'application/json','X-Api-Key':'qa-only-bootstrap-fixture'});
assert.equal(enrolled.status,200);const token=enrolled.json.token;assert.ok(token);results.push('authenticated enrollment succeeds');
const put=(path,text,rev)=>request('/file?path='+encodeURIComponent(path),'PUT',text,{'X-Base-Rev':String(rev),'Content-Type':'application/octet-stream','X-Device':run},token);
const del=(path,rev)=>request('/file?path='+encodeURIComponent(path),'DELETE',undefined,{'X-Base-Rev':String(rev)},token);
const rename=(from,to,rev)=>request('/rename','POST',JSON.stringify({from,to,base_rev:rev}),{'Content-Type':'application/json'},token);
const get=(path,rev)=>request('/file?path='+encodeURIComponent(path)+(rev===undefined?'':'&rev='+rev),'GET',undefined,{},token);
function oneWinner(responses){assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);return responses.find(r=>r.status===200).json}
async function exactRevision(ack){const [current,historical]=await Promise.all([get(ack.path),get(ack.path,ack.rev)]);if(ack.deleted){assert.equal(current.status,404);assert.equal(historical.status,404)}else{assert.equal(current.status,200);assert.equal(historical.status,200);assert.equal(current.text,historical.text);assert.equal(createHash('sha256').update(current.text).digest('hex'),ack.hash)}}
for(let i=0;i<20;i++){
 const path=`${run}-put-${i}.md`;assert.equal((await put(path,'base',0)).status,200);
 const winner=oneWinner(await Promise.all([put(path,'AAA',1),put(path,'BBB',1)]));await exactRevision(winner);
}results.push('20 PUT/PUT races: exactly one winner and consistent revision bytes');
for(let i=0;i<10;i++){
 const path=`${run}-del-${i}.md`;assert.equal((await put(path,'base',0)).status,200);
 const winner=oneWinner(await Promise.all([put(path,'edited',1),del(path,1)]));await exactRevision(winner);
}results.push('10 PUT/DELETE races: exactly one winner and consistent revision state');
for(let i=0;i<10;i++){
 const from=`${run}-src-${i}.md`,to=`${run}-dst-${i}.md`;assert.equal((await put(from,'source',0)).status,200);
 const winner=oneWinner(await Promise.all([rename(from,to,1),put(to,'other',0)]));await exactRevision(winner);
 const source=await get(from);assert.equal(source.status,winner.hash===createHash('sha256').update('source').digest('hex')?404:200);
}results.push('10 rename/destination-create races: exactly one winner and atomic source state');
const from=`${run}-plain-src.md`,to=`${run}-plain-dst.md`;
await put(from,'first',0);assert.equal((await rename(from,to,1)).status,200);assert.equal((await get(from)).status,404);assert.equal((await get(to)).text,'first');
assert.equal((await rename(from,to+'missing',1)).status,409);results.push('rename CRUD and typed missing-source conflict');
console.log(JSON.stringify({runtime:'local workerd with actual local D1/R2',run,passed:results.length,results},null,2));
