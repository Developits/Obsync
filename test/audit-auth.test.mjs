import test from 'node:test';
import assert from 'node:assert/strict';
import {createMockD1,createMockR2} from './harness.mjs';
import worker from '../server/src/index.ts';

test('Configured bootstrap API key must be required before minting the first token',async()=>{
 const env={DB:createMockD1('server/schema.sql'),BUCKET:createMockR2(),API_KEY:'qa-only-secret-not-a-real-credential'};
 const response=await worker.fetch(new Request('http://test.local/v1/tokens',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'unauthenticated-outsider'})}),env);
 // Do not print the generated token. Assert only authorization status.
 assert.equal(response.status,401,'A stranger can mint the first token even with API_KEY configured');
});
