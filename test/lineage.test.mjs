import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestServer,createTestDevice} from './harness.mjs';

test('sticky rename metadata cannot steal a reused tracked source when the destination is already known',async()=>{
 const s=await createTestServer();const a=createTestDevice(s,'A',await s.mintToken('A'));const b=createTestDevice(s,'B',await s.mintToken('B'));
 await a.edit('Source.md','base');await a.sync();await a.rename('Source.md','Destination.md');await a.sync();await b.sync();
 await a.edit('Source.md','same bytes as later destination');await a.sync();await b.sync();
 await b.delete('Destination.md');
 await a.edit('Destination.md','same bytes as later destination');await a.sync();await b.sync();
 assert.equal(await b.vault.exists('Source.md'),true);
 assert.equal(await b.vault.read('Source.md'),'same bytes as later destination');
 assert.equal(await b.vault.read('Destination.md'),'same bytes as later destination');
});
