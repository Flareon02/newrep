import test from 'node:test';
import assert from 'node:assert/strict';
import {SnapshotState} from '../src/state.js';
import {stableMatchEventSignature} from '../src/utils.js';
import {matcherLane} from '../src/matcher-client.js';
import {resolveEvents} from '../src/entity-resolver.js';

test('matching signature ignores volatile score and odds changes',()=>{
  const base={id:'1',source:'astek',sourceEventId:'1',category:'Counter Strike 2',league:'CCT',leagueId:'10',team1:'Alpha',team2:'Beta',startAt:1800000000000,marketKind:'main',bestOf:3};
  const a=stableMatchEventSignature([{...base,scoreText:'0:0',seriesScore:[0,0],odds:{markets:[{type:'moneyline'}]}}]);
  const b=stableMatchEventSignature([{...base,scoreText:'1:0',seriesScore:[1,0],odds:{markets:[{type:'moneyline'},{type:'total'}]}}]);
  assert.equal(a,b);
  assert.notEqual(a,stableMatchEventSignature([{...base,team2:'Gamma'}]));
});

test('SnapshotState increments feed revision for score but matching revision only for structure',async()=>{
  const state=new SnapshotState('test-structure',60000);state.persist=async()=>{};
  const base={id:'1',source:'astek',category:'Counter Strike 2',league:'CCT',leagueId:'10',team1:'Alpha',team2:'Beta',startAt:1800000000000,scoreText:'0:0'};
  await state.success([base]);const feed1=state.revision,match1=state.matchRevision;
  await state.success([{...base,scoreText:'1:0'}]);
  assert.ok(state.revision>feed1);
  assert.equal(state.matchRevision,match1);
  await state.success([{...base,team2:'Gamma',scoreText:'1:0'}]);
  assert.ok(state.matchRevision>match1);
});

test('full history uses one isolated matcher lane while current feeds remain separate',()=>{
  assert.equal(matcherLane('resolve',{mode:'live',scope:'history'}),'history');
  assert.equal(matcherLane('resolve',{mode:'prematch',scope:'history'}),'history');
  assert.equal(matcherLane('resolve',{mode:'live'}),'feeds-live');
  assert.equal(matcherLane('resolve',{mode:'prematch'}),'feeds-prematch');
});

test('large sparse historical Pinnacle merge avoids dense global assignment',()=>{
  const rows=[],base=Date.parse('2026-01-01T00:00:00Z');
  for(let i=0;i<300;i++){
    const startAt=base+i*4*3600000,team1=`Alpha ${i}`,team2=`Beta ${i}`;
    rows.push({id:'a'+i,source:'astek',sourceEventId:'a'+i,category:'Counter Strike 2',league:'CCT Europe',leagueId:'a1',team1,team2,startAt});
    rows.push({id:'f'+i,source:'fonbet',sourceEventId:'f'+i,category:'Counter Strike 2',league:'CCT Europe',leagueId:'f1',team1,team2,startAt:startAt+60000});
    if(i%2===0)rows.push({id:'p'+i,source:'pinnacle',sourceEventId:'p'+i,category:'Counter Strike 2',league:'CCT Europe',leagueId:'p1',team1,team2,startAt:startAt+120000});
  }
  const started=Date.now(),out=resolveEvents(rows,{mode:'prematch'}),elapsed=Date.now()-started;
  assert.equal(out.length,300);
  assert.ok(elapsed<5000,`sparse resolver took ${elapsed}ms`);
});
