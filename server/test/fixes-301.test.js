import test from 'node:test';
import assert from 'node:assert/strict';
import {withAstekRequest,astekRequestStatus} from '../src/utils.js';
import {PrematchCollector} from '../src/prematch.js';

test('LIVE takes priority over prematch and errors release the gate',async()=>{
 const seen=[];let release;
 const first=withAstekRequest('live',async()=>{seen.push('first');await new Promise(r=>release=r);});
 await Promise.resolve();
 const live=withAstekRequest('live',async()=>{seen.push('live');});
 const pre=withAstekRequest('prematch',async()=>{seen.push('prematch');throw Error('test');});
 const rejected=assert.rejects(pre,/test/);
 assert.equal(astekRequestStatus().queued,2);release();
 await Promise.all([first,live,rejected]);
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(seen,['first','live','prematch']);
 assert.deepEqual(astekRequestStatus(),{active:false,activeKind:'',activeForMs:0,queued:0,prematchWaiting:0,oldestWaitMs:0,byKind:{}});
});
