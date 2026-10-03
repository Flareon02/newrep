import test from 'node:test';
import assert from 'node:assert/strict';
import {astekOdds} from '../src/book-odds.js';
import {config} from '../src/config.js';
import {SnapshotState} from '../src/state.js';
import {feedPushPayload} from '../src/api.js';

test('3.7.1 keeps the retired external feed configuration disabled',()=>{
  assert.equal(config.version,'4.13.0');
  assert.equal(Object.prototype.hasOwnProperty.call(config,'cyberEnabled'),false);
  assert.equal(Object.prototype.hasOwnProperty.call(config,'cyberOrigin'),false);
});

test('HAR-derived official Astek market template decodes Dota kill markets correctly',()=>{
  const raw={I:101,SSN:'Dota 2',O1E:'PARIVISION',O2E:'LEVEL UP',GE:[
    {G:2683,GS:888,E:[
      {G:2683,GS:888,T:3455,P:-31.5,C:1.8},
      {G:2683,GS:888,T:3456,P:31.5,C:1.9}
    ]},
    {G:2685,GS:889,E:[
      {G:2685,GS:889,T:3457,P:101.5,C:1.85},
      {G:2685,GS:889,T:3458,P:101.5,C:1.8}
    ]},
    {G:2850,GS:1005,E:[
      {G:2850,GS:1005,T:3820,C:1.12},
      {G:2850,GS:1005,T:3823,C:10}
    ]}
  ]};
  const odds=astekOdds(raw,[],'live',{category:'Dota 2'});
  assert.ok(odds);
  const handicap=odds.markets.find(m=>m.rawGroup===2683);
  const total=odds.markets.find(m=>m.rawGroup===2685);
  const mapMatch=odds.markets.find(m=>m.rawGroup===2850);
  assert.equal(handicap?.title,'Фраги, фора');
  assert.equal(handicap?.type,'spread');
  assert.deepEqual(handicap?.prices.map(p=>p.designation),['home','away']);
  assert.equal(total?.title,'Фраги, тотал');
  assert.equal(total?.type,'total');
  assert.deepEqual(total?.prices.map(p=>p.designation),['over','under']);
  assert.equal(mapMatch?.title,'Карта/Матч');
  assert.ok(mapMatch?.prices.every(p=>!/^Исход \d+$/.test(p.label)));
});

test('official group captions override unrelated legacy captions while GS fallback stays safe',()=>{
  const raw={I:102,SSN:'Dota 2',O1E:'Alpha',O2E:'Beta',GE:[
    {G:2436,GS:752,E:[{G:2436,GS:752,T:2824,P:2.5,C:1.8},{G:2436,GS:752,T:2825,P:2.5,C:2.0}]},
    {G:2687,GS:890,E:[{G:2687,GS:890,T:3459,C:1.9},{G:2687,GS:890,T:3460,C:1.9}]}
  ]};
  const odds=astekOdds(raw,[],'live',{category:'Dota 2'});
  const mapTotal=odds.markets.find(m=>m.rawGroup===2436);
  const parity=odds.markets.find(m=>m.rawGroup===2687);
  assert.equal(mapTotal?.title,'Тотал по картам');
  assert.doesNotMatch(mapTotal?.title||'',/нокдаун/i);
  assert.equal(parity?.title,'Фраги, тотал чет/нечет');
  assert.doesNotMatch(parity?.title||'',/Иран/i);
});

test('SnapshotState still emits small score patches and structural invalidation',async()=>{
  const state=new SnapshotState('prematch-push-test',60000);state.persist=async()=>{};
  const changes=[];state.onChange(change=>changes.push(change));
  const base={id:'101',source:'astek',sourceEventId:'101',category:'Dota 2',league:'Test',leagueId:'1',team1:'Alpha',team2:'Beta',startAt:1800000000000,scoreText:'0:0',seriesScore:[0,0],mapScores:[]};
  await state.success([base]);
  assert.equal(changes.at(-1).structuralChanged,true);
  await state.success([{...base,scoreText:'1:0',seriesScore:[1,0],mapScores:[[30,20]]}]);
  const change=changes.at(-1);
  assert.equal(change.structuralChanged,false);
  assert.equal(change.patches.length,1);
  const push=feedPushPayload('live','astek',change,{revision:'2-1'});
  assert.equal(push.event,'patch');
  const invalidation=feedPushPayload('live','astek',{type:'snapshot',structuralChanged:true,at:2},{revision:'3-1'});
  assert.equal(invalidation.event,'invalidate');
});
