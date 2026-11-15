// Small deterministic ZIP writer for release assets; no shell/archive utility.
import {deflateRawSync} from 'node:zlib';
function crc32(data){
 let crc=0xffffffff;
 for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
 return (crc^0xffffffff)>>>0;
}
export function makeZip(entries){
 if(entries.length>65535)throw Error('ZIP64 is not supported');
 const local=[],central=[];let offset=0;
 for(const [path,content] of entries){
  if(path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='..'||p==='.'))throw Error('Unsafe archive path');
  const name=Buffer.from(path),data=Buffer.from(content),compressed=deflateRawSync(data),crc=crc32(data);
  if(name.length>65535||data.length>0xffffffff||compressed.length>0xffffffff||offset>0xffffffff)throw Error('ZIP64 is not supported');
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE((1<<5)|1,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
  local.push(header,name,compressed);
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(8,10);record.writeUInt16LE((1<<5)|1,14);record.writeUInt32LE(crc,16);record.writeUInt32LE(compressed.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);
  central.push(record,name);offset+=header.length+name.length+compressed.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
