import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {inflateRawSync} from 'node:zlib';

test('packaged .zip assets are real ZIPs with exact built plugin bytes',()=>{
 execFileSync(process.execPath,['scripts/package.mjs'],{stdio:'pipe'});
 const manifest=JSON.parse(fs.readFileSync('plugin/manifest.json','utf8'));
 for(const name of [`${manifest.id}.zip`,`${manifest.id}-v${manifest.version}.zip`,`${manifest.id}-flat.zip`]){
  const data=fs.readFileSync('dist/'+name);assert.equal(data.readUInt32LE(0),0x04034b50,`${name} is not ZIP (GNU tar does not infer ZIP from -a)`);
  const entries=new Map();let offset=0;
  while(data.readUInt32LE(offset)===0x04034b50){
   const method=data.readUInt16LE(offset+8),size=data.readUInt32LE(offset+18),nameLength=data.readUInt16LE(offset+26),extraLength=data.readUInt16LE(offset+28);
   const entryName=data.subarray(offset+30,offset+30+nameLength).toString();const start=offset+30+nameLength+extraLength;
   const content=data.subarray(start,start+size);entries.set(entryName,method===8?inflateRawSync(content):content);offset=start+size;
  }
  const prefix=name.endsWith('-flat.zip')?'':manifest.id+'/';assert.equal(entries.size,2);
  for(const file of ['main.js','manifest.json'])assert.deepEqual(entries.get(prefix+file),fs.readFileSync('plugin/'+file));
  assert.equal(data.readUInt32LE(offset),0x02014b50,'missing ZIP central directory');
 }
});
