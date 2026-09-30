import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {matchAsync,stopMatcher} from '../src/matcher-client.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>fs.readFileSync(path.join(ROOT,name),'utf8');

test('single-core production profile keeps background concurrency deliberately low',()=>{
  const compose=read('docker-compose.yml');
  assert.match(compose,/PREMATCH_CONCURRENCY:\s*"1"/);
  assert.match(compose,/UV_THREADPOOL_SIZE:\s*"2"/);
  assert.match(compose,/--max-old-space-size=320/);
  assert.match(compose,/RESULTS_DAY_CONCURRENCY:\s*"1"/);
  assert.match(compose,/RESULTS_CONCURRENCY:\s*"1"/);
  assert.match(compose,/RESULTS_WARM_INTERVAL_MS:\s*"10000"/);
});

test('4.3.2 unbounded odds write regression is not present',()=>{
  const state=read('src/state.js'),sqlite=read('src/sqlite-storage.js');
  assert.match(state,/await Promise\.all\(incoming\.filter\(e=>e\.odds\?\.markets\?\.length\)\.map\(e=>oddsLog\.record\(e\)\)\)/);
  assert.doesNotMatch(state,/for\(const event of incoming\).*oddsLog\.record\(event\)\.catch/);
  assert.doesNotMatch(state,/schedulePersist\(/);
  assert.match(sqlite,/deflateRawSync/);
  assert.doesNotMatch(sqlite,/deflateRawAsync|promisify\(deflateRaw\)/);
});

test('history is request-driven, cached, and gated behind realtime work',()=>{
  const api=read('src/api.js');
  assert.match(api,/waitForLowPrioritySlot/);
  assert.match(api,/historyPageCache/);
  assert.match(api,/historyMode:'paged-worker-idle-only'/);
  assert.doesNotMatch(api,/scheduleHistoryWarm/);
});

test('health endpoint avoids compression work and updater cannot hang forever',()=>{
  const api=read('src/api.js'),upgrade=read('upgrade.sh');
  assert.match(api,/healthRequest/);
  assert.match(api,/gzip\(body,\{level:1\}/);
  assert.match(upgrade,/AbortSignal\.timeout\(5000\)/);
  assert.match(read('src/deploy-health-probe.js'),/loop > 3000/);
});

test('CPU-heavy history matching stays off the HTTP event loop',async()=>{
  const mk=(source,i,phase)=>({source,id:`${source}-${i}`,sourceEventId:String(i),category:i%2?'Dota 2':'Counter Strike 2',league:`League ${i%40}`,team1:`A${i%700}`,team2:`B${(i+17)%700}`,startAt:1700000000000+i*1000,firstSeenAt:1699990000000+i*1000,lastSeenAt:1700000000000+i*1000,...(phase==='live'?{enteredLiveAt:1700000000000+i*1000}:{})});
  const prematchHistory=Array.from({length:7000},(_,i)=>mk('astek',i,'prematch'));
  const liveHistory=Array.from({length:7000},(_,i)=>mk('fonbet',i,'live'));
  let maxLag=0,last=performance.now();
  const timer=setInterval(()=>{const now=performance.now();maxLag=Math.max(maxLag,now-last-10);last=now;},10);
  const result=await matchAsync('ui-history-page',{prematchHistory,liveHistory,currentPrematch:[],currentLive:[],params:{limit:'500',offset:'0',sources:'astek,fonbet,pinnacle,ggbet'}});
  clearInterval(timer);await stopMatcher();
  assert.ok(Array.isArray(result.events));
  // Even under taskset -c 0 the worker must let the main event loop run often.
  assert.ok(maxLag<1000,`main event loop stalled ${Math.round(maxLag)} ms`);
});
