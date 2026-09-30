import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {eventMatchScore,resolveEvents,stringSimilarity} from '../src/entity-resolver.js';
import {HawkService} from '../src/hawk.js';
import {StatisticsService} from '../src/statistics-service.js';

const at=Date.UTC(2026,8,29,10,0);
const row=(overrides={})=>({
 id:'x',sourceEventId:'x',source:'astek',provider:'AstekBet',category:'Dota 2',
 league:'BLAST Slam',leagueId:'blast-slam',team1:'PARIVISION',team2:'LEVEL UP',
 startAt:at,firstSeenAt:at-86400100,lastSeenAt:at,...overrides
});

test('3.7 screenshot case: PARIVISION and PVISION merge only with exact opponent, tournament and time anchor',()=>{
 const a=row();
 const f=row({id:'f',sourceEventId:'f',source:'fonbet',provider:'Fonbet'});
 const p=row({id:'p',sourceEventId:'p',source:'pinnacle',provider:'Pinnacle',team1:'PVISION'});
 assert.ok(stringSimilarity(a.team1,p.team1,{team:true})<.76,'abbreviation must exercise the guarded alias path');
 const info=eventMatchScore(a,p,{mode:'prematch'});
 assert.ok(info?.oneSideAlias);
 const merged=resolveEvents([a,f,p],{mode:'prematch'});
 assert.equal(merged.length,1);
 assert.deepEqual(new Set(merged[0].sourceRefs.map(r=>r.source)),new Set(['astek','fonbet','pinnacle']));

 const wrongOpponent={...p,id:'bad',sourceEventId:'bad',team2:'LEVEL FIVE'};
 assert.equal(eventMatchScore(a,wrongOpponent,{mode:'prematch'}),null);
 const wrongLeague={...p,id:'bad2',sourceEventId:'bad2',league:'DreamLeague Season 28',leagueId:'dreamleague'};
 assert.equal(eventMatchScore(a,wrongLeague,{mode:'prematch'}),null);
 const far={...p,id:'bad3',sourceEventId:'bad3',startAt:at+20*60000};
 assert.equal(eventMatchScore(a,far,{mode:'prematch'}),null);
});

test('3.7 screenshot case: Wraith PCIFIC and PCIFIC merge with exact State anchor',()=>{
 const a=row({category:'Counter Strike 2',league:'United21',leagueId:'united21',team1:'Wraith PCIFIC',team2:'State'});
 const f=row({id:'f',sourceEventId:'f',source:'fonbet',provider:'Fonbet',category:'Counter Strike 2',league:'United21',leagueId:'fb-united21',team1:'PCIFIC',team2:'STATE'});
 const info=eventMatchScore(a,f,{mode:'prematch'});
 assert.ok(info?.oneSideAlias);
 assert.equal(resolveEvents([a,f],{mode:'prematch'}).length,1);
});

test('Dota current statistics catalog accepts roster spelling differences with time and league context',async()=>{
 const svc=new HawkService();
 const series={id:777,slug:'moonlight-wispers-v-freedom-fighters-team',startAt:new Date(at).toISOString(),bestOf:3,
   team1:{name:'Moonlight Wispers'},team2:{name:'Freedom Fighters Team'},championship:{name:'Mad Dogs League 2026 Season 49',slug:'mad-dogs-league-2026-season-49'},matches:[],streams:[]};
 svc.catalog=[series];svc.indexAt=Date.now();svc.page=async()=>({seriesPageData:series});
 const hit=await svc.get({team1:'Moonlight Wispers',team2:'Freedom Fighters',startAt:at,league:'Mad Dogs League',category:'Dota 2'});
 assert.equal(hit.matched,true);
 assert.equal(hit.event.id,777);
 assert.match(hit.matchQuality,/pair/);
 svc.close();
});

test('Dota matched current series becomes available before map telemetry arrives',async()=>{
 const event={id:'logical-live',view:'live',category:'Dota 2',league:'Mad Dogs League',leagueKey:'logical:dota:mad-dogs',team1:'Moonlight Wispers',team2:'Freedom Fighters',startAt:at,sourceRefs:[{source:'astek',id:'a1',sourceEventId:'a1'}]};
 const service=Object.create(StatisticsService.prototype);
 Object.assign(service,{running:false,stopping:false,lastError:'',lastSweepAt:0,lastCatalogKey:'',providers:{},tracked:new Map(),currentAvailability:new Map(),currentAvailabilityAt:0,
   events:()=>[event],crossbet:null,
   hawk:{status:()=>({indexUpdatedAt:1,catalogSeries:1}),get:async()=>({matched:true,event:{id:777,team1:'Moonlight Wispers',team2:'Freedom Fighters',maps:[]}})},
   store:{record:async()=> 'stats-dota2-777',publicProvider:()=> 'dota2',publicId:x=>x,lookup:async()=>null}
 });
 await service.sweep();
 assert.equal(service.providers.hawk.matched,1);
 assert.equal(service.providers.hawk.ready,0);
 assert.equal(service.providers.hawk.waitingForData,1);
 const available=await service.availability([event]);
 assert.equal(available[event.id]?.provider,'dota2');
 assert.equal(available[event.id]?.ready,false);
});

test('feed state emits normalized snapshot before durable odds journal flush',()=>{
 const source=fs.readFileSync(new URL('../src/state.js',import.meta.url),'utf8');
 const emit=source.indexOf("this.emitChange({type:'snapshot'");
 const odds=source.indexOf('oddsLog.record',emit);
 const persist=source.indexOf('await this.persist(false)',emit);
 assert.ok(emit>=0&&odds>emit&&persist>odds,'latency-sensitive emit must precede disk journals/persist');
});
