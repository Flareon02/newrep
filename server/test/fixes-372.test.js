import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SnapshotState} from '../src/state.js';

test('SnapshotState reuses its history index across hot collector updates',async()=>{
  const state=new SnapshotState('prematch-optimization-test',60000);
  const at=Date.now();
  state.history=[
    {id:'old-a',source:'astek',category:'Dota 2',league:'L',team1:'A',team2:'B',startAt:at-5000,firstSeenAt:at-5000,lastSeenAt:at-1000,lifecycle:[{type:'entered',at:at-5000}]},
    {id:'old-b',source:'astek',category:'Dota 2',league:'L',team1:'C',team2:'D',startAt:at-4001,firstSeenAt:at-4001,lastSeenAt:at-1000,lifecycle:[{type:'entered',at:at-4001}]}
  ];
  state.historyIndex=new Map(state.history.map(e=>[e.id,e]));
  state.latestHistoryEvent=state.toLatestNewEvent(state.history[1]);
  state.lastHistoryPruneAt=at;
  state.lastPersistAt=at;
  const index=state.historyIndex;
  await state.success([{id:'old-b',source:'astek',category:'Dota 2',league:'L',team1:'C',team2:'D',startAt:at-4001}],{status:200});
  assert.equal(state.historyIndex,index);
  assert.equal(state.historyIndex.size,2);
  assert.equal(state.latestNewEvent().id,'old-b');
});

test('API uses structural refresh plus a low-frequency snapshot watchdog',()=>{
  const api=fs.readFileSync(new URL('../src/api.js',import.meta.url),'utf8');
  assert.match(api,/if\(change\?\.structuralChanged\)\{[\s\S]*?refreshMode\(mode\)/);
  assert.match(api,/setInterval\(prepare,10000\)/);
  assert.doesNotMatch(api,/setInterval\(prepare,1000\)/);
});

test('Pinnacle detail SSE suppresses unchanged payloads',()=>{
  const api=fs.readFileSync(new URL('../src/api.js',import.meta.url),'utf8');
  assert.match(api,/if\(signature!==lastSignature\)\{lastSignature=signature;(?:res\.write|safeWrite\(res,)/);
  assert.doesNotMatch(api,/signature!==lastSignature\|\|payload\.event\?\.odds/);
});

test('feed SSE serializes normal and thin wire payloads once per change, not once per client',()=>{
  const api=fs.readFileSync(new URL('../src/api.js',import.meta.url),'utf8');
  // One wire per (LIVE odds provider, thin|full) and change; clients only pick the cached wire.
  const feed=api.match(/const broadcastFeed=[\s\S]*?\n {2}\};/)?.[0]||'';
  assert.match(feed,/const key=selected\+\(client\.thin\?':thin':':full'\);/);
  assert.match(feed,/if\(!wires\.has\(key\)\)\{const meta=feedMeta\(mode,selected\),payload=client\.thin\?thinFeedPushPayload\(mode,provider,change,meta\):feedPushPayload\(mode,provider,change,meta\);wires\.set\(key,sseEventWire\(payload\.event,payload\.payload\)\);\}/);
  assert.match(feed,/writeSse\(client\.res,wires\.get\(key\)\)/);
  assert.doesNotMatch(feed,/for\(const client of feedClients\)[^\n]*sseEventWire\(payload\.event,payload\.payload\)\);try/);
});


test('history prune invalidates the cached latest-history row',()=>{
  const state=fs.readFileSync(new URL('../src/state.js',import.meta.url),'utf8');
  const prune=state.match(/if \(!this\.lastHistoryPruneAt[\s\S]*?this\.history = \[\.\.\.historyMap\.values\(\)\];/)?.[0]||'';
  assert.match(prune,/this\.latestHistoryEvent = null/);
});
