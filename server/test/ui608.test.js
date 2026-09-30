import test from 'node:test';
import assert from 'node:assert/strict';
import {ScoreLog} from '../src/score-log.js';
import {leagueStore} from '../src/league-store.js';
import Model from '../src/league-model.cjs';
import {resolveEvents} from '../src/entity-resolver.js';
import {compareSchedule} from '../src/comparison.js';

test('explicit discipline links retain raw membership and work in resolver and comparison',async()=>{
 const oldState=leagueStore.state,oldCatalog=leagueStore.catalog;
 leagueStore.state={...oldState,revision:0,links:[],audit:[]};leagueStore.catalog=new Map();
 try {
  const a={source:'astek',category:'Dota 2',league:'Northern Open',id:'101',team1:'Alpha',team2:'Beta',startAt:1800000000000,url:'https://example.org/a'};
  const f={...a,source:'fonbet',category:'Esports',league:'Autumn Finals. Bo3',id:'202',url:'https://example.org/f'};
  await leagueStore.remember([a,f]);
  assert.throws(()=>Model.connect([],[a,f],'mixed'),/дисциплины/);
  const links=Model.connect([],[a,f],'mixed',100,'Dota 2');links[0].name='Shared championship';
  assert.equal(Model.members(links[0])[1].category,'Esports');
  await leagueStore.commit(0,{upsert:links,remove:[]});
  const events=resolveEvents([a,f]);assert.equal(events.length,1);assert.equal(events[0].category,'Dota 2');assert.equal(events[0].league,'Shared championship');
  assert.deepEqual(events[0].sourceRefs.map(r=>r.source),['astek','fonbet']);
  assert.equal(events[0].sourceRefs[1].catalogId,Model.id(f));
  for(const league of [a.league,f.league,'Shared championship']){
   const result=compareSchedule([{...f,league}],events);
   assert.equal(result.matches.length,1,league);assert.equal(result.matches[0].method,'manual');assert.equal(result.matches[0].astek.sourceRefs.length,2);
  }
  assert.equal(compareSchedule([{...f,league:f.league}],events,{fonbetEnabled:false}).matches[0].astek.sourceRefs[0].source,'astek');
  const next=structuredClone(leagueStore.state.links);next[0].category='Overwatch';assert.equal(Model.diff(leagueStore.state.links,next).upsert.length,1);
 } finally {leagueStore.state=oldState;leagueStore.catalog=oldCatalog;}
});

test('score reads do not wait for disk writes, and pagination keeps timestamp ties',async()=>{
 let release,started;const writing=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);
 const row={source:'astek',id:'1',team1:'A',team2:'B',scoreText:'0:0'},log=new ScoreLog({read:async()=>null,write:async()=>{}});
 await log.record([row],{at:10});
 log.write=async()=>{started();await blocked;};
 const pending=log.record([{...row,scoreText:'1:0'}],{at:20});await writing;
 const read=await Promise.race([log.get(['astek:1']),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('read waited for write')),200);t.unref();})]);
 assert.equal(read.entries[0].scoreText,'0:0');release();await pending;
 log.write=async()=>{};
 await log.record([{...row,source:'fonbet',scoreText:'0:1'}],{at:20});
 const page=await log.get(['astek:1','fonbet:1'],{limit:1});assert.equal(page.entries.length,2);assert.equal(page.nextBefore,20);assert.equal(page.hasMore,true);
 const older=await log.get(['astek:1','fonbet:1'],{limit:1,before:page.nextBefore});assert.equal(older.entries[0].at,10);assert.equal(older.hasMore,false);
});

test('confirmation and team orientation alone create no new score change',async()=>{
 const log=new ScoreLog({read:async()=>null,write:async()=>{}}),row={source:'astek',id:'1',team1:'Alpha',team2:'Beta',scoreText:'1:0 (13:5, 0:0)',seriesScore:[1,0],mapScores:[[13,5],[0,0]]};
 await log.record([row],{at:10});
 await log.record([{...row,team1:'Beta',team2:'Alpha',scoreText:'0:1 (5:13, 0:0)',seriesScore:[0,1],mapScores:[[5,13],[0,0]]}],{at:20});
 await log.record([{...row,resultVerified:true}],{phase:'results',at:30});
 const result=await log.get(['astek:1']);assert.equal(result.entries.length,1);assert.equal(result.entries[0].at,10);assert.equal(result.entries[0].verified,true);assert.equal(result.entries[0].confirmedAt,30);
});
