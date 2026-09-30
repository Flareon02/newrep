import test from 'node:test';
import assert from 'node:assert/strict';
import {eventMatchScore,resolveEvents,collapseSourceDuplicates,stringSimilarity,leagueFamily,primaryLeagueName} from '../src/entity-resolver.js';
import {StatisticsStore} from '../src/statistics-store.js';
import {StatisticsService} from '../src/statistics-service.js';
import {HawkService} from '../src/hawk.js';

const base=(overrides={})=>({
  id:'a1',sourceEventId:'a1',source:'astek',provider:'AstekBet',category:'Counter Strike 2',
  league:'CCT South America',leagueId:'cct-eu',team1:'Metanoia Wolves',team2:'MIBR (Women)',
  startAt:Date.UTC(2026,8,27,20,0),firstSeenAt:Date.UTC(2026,8,27,19,50),lastSeenAt:Date.UTC(2026,8,27,22,0),
  resultVerified:true,seriesScore:[2,0],mapScores:[[13,11],[13,10]],scoreText:'2:0 (13:11, 13:10)',...overrides
});

test('3.6.0 treats Women/Female as the same roster division but keeps academy separate',()=>{
  assert.ok(stringSimilarity('MIBR (Women)','MIBR Female (zh)',{team:true})>.9);
  assert.equal(stringSimilarity('MIBR Academy','MIBR Female',{team:true}),0);
});

test('same fixture with Women/Female provider spelling merges across bookmakers',()=>{
  const a=base();
  const f=base({id:'f1',sourceEventId:'f1',source:'fonbet',provider:'Fonbet',league:'CCT South America Series',leagueId:'fb-cct-sa',team2:'MIBR Female (zh)',startAt:a.startAt});
  const info=eventMatchScore(a,f,{mode:'past',inferredLeague:.98});
  assert.ok(info,'fixture should be a match when league identity is established');
  const rows=resolveEvents([a,f],{mode:'past'});
  assert.equal(rows.length,1);
  assert.equal(rows[0].source,'merged');
  assert.equal(rows[0].sourceRefs.length,2);
});

test('strict same-provider dedupe collapses replaced result IDs and preserves aliases',()=>{
  const a=base({id:'a1',sourceEventId:'a1',league:'CCT South America',leagueId:'same-league'});
  const b=base({id:'a2',sourceEventId:'a2',league:'CCT South America',leagueId:'same-league',startAt:a.startAt+15*60000,firstSeenAt:a.firstSeenAt+2*60000,lastSeenAt:a.lastSeenAt+2*60000});
  const rows=collapseSourceDuplicates([a,b],'past');
  assert.equal(rows.length,1);
  assert.ok(rows[0].aliases.includes('astek:a1'));
  assert.ok(rows[0].aliases.includes('astek:a2'));
});


test('replacement Astek id and matching Fonbet result become one logical result card',()=>{
  const at=Date.UTC(2026,8,27,20,0);
  const old=base({id:'bp-old',sourceEventId:'bp-old',league:'CCT: Europe',leagueId:'cct-europe',team1:'Black Phoenix',team2:'ex-RUSTEC',startAt:at,bestOf:3,seriesScore:[0,0],mapScores:[[4,3],[0,0],[0,0]],scoreText:'0:0 (4:3, 0:0, 0:0)',endedAt:at+18*60000,lastSeenAt:at+18*60000});
  const fixed=base({id:'bp-new',sourceEventId:'bp-new',league:'CCT: Europe',leagueId:'cct-europe',team1:'Black Phoenix',team2:'ex-RUSTEC',startAt:at+15*60000,bestOf:3,seriesScore:[2,0],mapScores:[[13,7],[13,6]],scoreText:'2:0 (13:7, 13:6)'});
  const fonbet={...fixed,id:'fb-bp',sourceEventId:'fb-bp',source:'fonbet',provider:'Fonbet',startAt:at+15*60000,leagueId:'fb-cct-europe'};
  const rows=resolveEvents([old,fixed,fonbet],{mode:'past'});
  assert.equal(rows.length,1);
  assert.deepEqual(rows[0].seriesScore,[2,0]);
  assert.equal(rows[0].sourceRefs.length,2);
  const astek=rows[0].sourceRefs.find(r=>r.source==='astek');
  assert.ok(astek.aliases.includes('astek:bp-old'));
  assert.ok(astek.aliases.includes('astek:bp-new'));
});

test('same teams with conflicting verified results remain distinct fixtures',()=>{
  const a=base({id:'a1',sourceEventId:'a1',leagueId:'same-league'});
  const b=base({id:'a2',sourceEventId:'a2',leagueId:'same-league',startAt:a.startAt+20*60000,seriesScore:[1,2],mapScores:[[13,11],[10,13],[8,13]],scoreText:'1:2 (13:11, 10:13, 8:13)'});
  assert.equal(collapseSourceDuplicates([a,b],'past').length,2);
});


test('placeholder 0:0 result does not block same-provider replacement dedupe',()=>{
  const good=base({id:'a-good',sourceEventId:'a-good',leagueId:'same-league',bestOf:3,seriesScore:[2,0],mapScores:[[13,7],[13,8]],scoreText:'2:0 (13:7, 13:8)'});
  const placeholder=base({id:'a-old',sourceEventId:'a-old',leagueId:'same-league',bestOf:3,startAt:good.startAt-15*60000,seriesScore:[0,0],mapScores:[[4,3],[0,0],[0,0]],scoreText:'0:0 (4:3, 0:0, 0:0)',endedAt:good.startAt+18*60000,lastSeenAt:good.startAt+18*60000});
  const rows=collapseSourceDuplicates([placeholder,good],'past');
  assert.equal(rows.length,1);
  assert.deepEqual(rows[0].seriesScore,[2,0]);
  assert.ok(rows[0].aliases.includes('astek:a-old'));
  assert.ok(rows[0].aliases.includes('astek:a-good'));
});


test('LIVE statistics availability never falls back to an archived team-pair match',async()=>{
  const service=Object.create(StatisticsService.prototype);
  service.wake=()=>{};
  service.currentAvailability=new Map();
  service.currentAvailabilityAt=Date.now();
  service.store={lookup:async()=>({id:'hawk-old',provider:'hawk',at:Date.now()}),publicId:id=>String(id).replace(/^hawk-/,'stats-dota2-'),publicProvider:provider=>provider==='hawk'?'dota2':provider};
  const live=await service.availability([{id:'live-1',view:'live',team1:'Alpha',team2:'Beta',league:'League A',startAt:Date.now()}]);
  assert.deepEqual(live,{});
  service.currentAvailability.set('live-1',{id:'stats-dota2-current',provider:'dota2',updatedAt:Date.now()});
  const current=await service.availability([{id:'live-1',view:'live',team1:'Alpha',team2:'Beta',league:'League A',startAt:Date.now()}]);
  assert.equal(current['live-1'].id,'stats-dota2-current');assert.equal(current['live-1'].provider,'dota2');
  const result=await service.availability([{id:'result-1',view:'results',team1:'Alpha',team2:'Beta',league:'League A',startAt:Date.now()}]);
  assert.equal(result['result-1'].id,'stats-dota2-old');assert.equal(result['result-1'].provider,'dota2');
});

test('statistics archive fallback requires a close time and compatible league',async()=>{
  const store=new StatisticsStore();await store.ready;clearInterval(store.timer);
  store.index={
    'hawk-x':{id:'hawk-x',provider:'hawk',refs:[],pair:['alpha','beta'].sort().join('|'),team1:'Alpha',team2:'Beta',leagueKey:'logical:dota2:league-a',league:'league a',startAt:Date.UTC(2026,8,27,10,0),at:Date.now()}
  };
  const hit=await store.lookup({source:'astek',sourceEventId:'1',team1:'Alpha',team2:'Beta',leagueKey:'logical:dota2:league-a',league:'League A',startAt:Date.UTC(2026,8,27,10,10)});
  assert.equal(hit?.id,'hawk-x');
  const far=await store.lookup({source:'astek',sourceEventId:'2',team1:'Alpha',team2:'Beta',leagueKey:'logical:dota2:league-a',league:'League A',startAt:Date.UTC(2026,8,27,16,0)});
  assert.equal(far,null);
  const other=await store.lookup({source:'astek',sourceEventId:'3',team1:'Alpha',team2:'Beta',leagueKey:'logical:dota2:league-b',league:'League B',startAt:Date.UTC(2026,8,27,10,10)});
  assert.equal(other,null);
});

test('public statistics identifiers are neutral while legacy storage ids remain readable',async()=>{
  const store=new StatisticsStore();await store.ready;clearInterval(store.timer);
  assert.equal(store.publicId('hawk-123'),'stats-dota2-123');
  assert.equal(store.publicId('crossbet-456'),'stats-cs2-456');
  assert.equal(store.internalId('stats-dota2-123'),'hawk-123');
  assert.equal(store.internalId('stats-cs2-456'),'crossbet-456');
  assert.equal(store.publicProvider('hawk'),'dota2');
  assert.equal(store.publicProvider('crossbet'),'cs2');
});


test('CCT South America and provider Series suffix share one league family',()=>{
  assert.equal(leagueFamily('CCT South America','Counter Strike 2'),leagueFamily('CCT South America Series','Counter Strike 2'));
  assert.equal(primaryLeagueName('CCT South America Series','Counter Strike 2'),'CCT South America');
  assert.notEqual(leagueFamily('CCT European Series 10','Counter Strike 2'),leagueFamily('CCT European Series 11','Counter Strike 2'));
});

test('screenshot-style replaced Astek result collapses before Fonbet assignment',()=>{
  const final=base({id:'a-final',sourceEventId:'a-final',league:'CCT: Europe',leagueId:'cct-europe',team1:'Black Phoenix',team2:'ex-RUSTEC',startAt:Date.UTC(2026,8,27,20,0),bestOf:3,seriesScore:[2,0],mapScores:[[13,7],[13,6]],scoreText:'2:0 (13:7, 13:6)',endedAt:Date.UTC(2026,8,27,21,42)});
  const old=base({id:'a-old',sourceEventId:'a-old',league:'CCT: Europe',leagueId:'cct-europe',team1:'Black Phoenix',team2:'ex-RUSTEC',startAt:Date.UTC(2026,8,27,20,15),bestOf:3,seriesScore:[0,0],mapScores:[[4,3],[0,0],[0,0]],scoreText:'0:0 (4:3, 0:0, 0:0)',resultVerified:false,endedAt:Date.UTC(2026,8,27,20,18)});
  const fon=base({id:'f-final',sourceEventId:'f-final',source:'fonbet',provider:'Fonbet',league:'CCT Europe',leagueId:'fb-cct-europe',team1:'Black Phoenix',team2:'ex-RUSTEC',startAt:Date.UTC(2026,8,27,20,0),bestOf:3,seriesScore:[2,0],mapScores:[[13,7],[13,6]],scoreText:'2:0 (13:7, 13:6)'});
  const rows=resolveEvents([old,final,fon],{mode:'past'});
  assert.equal(rows.length,1);
  assert.equal(rows[0].sourceRefs.length,2);
  const astek=rows[0].sourceRefs.find(r=>r.source==='astek');
  assert.ok(astek.aliases.includes('astek:a-old'));
  assert.ok(astek.aliases.includes('astek:a-final'));
});

test('removed Dota series is not retained as an automatic LIVE statistics candidate',async()=>{
  const svc=new HawkService();
  svc.catalog=[{id:'old',slug:'alpha-v-beta',startAt:new Date().toISOString(),team1:{name:'Alpha'},team2:{name:'Beta'},championship:{name:'League A',slug:'league-a'}}];
  svc.indexAt=0;
  svc.page=async()=>({current:{id:'current',slug:'gamma-v-delta',startAt:new Date().toISOString(),team1:{name:'Gamma'},team2:{name:'Delta'},championship:{name:'League A',slug:'league-a'}}});
  const result=await svc.get({team1:'Alpha',team2:'Beta',startAt:Date.now(),league:'League A',category:'Dota 2'});
  assert.equal(result.matched,false);
  assert.equal(svc.catalog.some(row=>String(row.id)==='old'),false);
  svc.close();
});
