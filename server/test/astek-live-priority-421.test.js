import test from 'node:test';
import assert from 'node:assert/strict';
import {withAstekRequest,astekRequestStatus} from '../src/utils.js';
import {config} from '../src/config.js';

test('queued LIVE jumps ahead of queued prematch work',async()=>{
  const seen=[];let release;
  const blocker=withAstekRequest('prematch',async()=>{seen.push('blocker');await new Promise(r=>release=r);});
  await Promise.resolve();
  const pre=withAstekRequest('prematch',async()=>{seen.push('prematch');});
  const live=withAstekRequest('live',async()=>{seen.push('live');});
  release();
  await Promise.all([blocker,pre,live]);
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(seen,['blocker','live','prematch']);
});

test('gate watchdog aborts a stuck prematch and releases queued LIVE',async()=>{
  const original=config.astekGatePrematchTimeoutMs;
  config.astekGatePrematchTimeoutMs=35;
  try{
    let aborted=false;
    const stuck=withAstekRequest('prematch',signal=>new Promise((resolve,reject)=>{
      signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason||new Error('aborted'));},{once:true});
    }));
    const live=withAstekRequest('live',async()=>42);
    await assert.rejects(stuck,/gate timeout|aborted/i);
    assert.equal(await live,42);
    assert.equal(aborted,true);
    await new Promise(r=>setImmediate(r));
    assert.equal(astekRequestStatus().active,false);
  } finally {config.astekGatePrematchTimeoutMs=original;}
});
