import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {ResultsService,dateKey,dayRange} from '../src/results.js';
import {config} from '../src/config.js';
import {stopMatcher} from '../src/matcher-client.js';
after(stopMatcher);
test('today retries every five minutes despite legacy 30-minute backoff; old days retain daily limit',()=>{
 const service=new ResultsService(),day=dateKey(),now=Date.now();let runs=0;service.drain=()=>runs++;
 service.index[day]={updatedAt:now-299000,complete:false,nextRetryAt:now+1800000};service.enqueue(day);assert.equal(runs,0);
 service.index[day].updatedAt=now-301000;service.enqueue(day);assert.equal(runs,1);
 service.index['2026-01-01']={updatedAt:now,complete:false,nextRetryAt:now+86400100};service.enqueue('2026-01-01');assert.equal(runs,1);
 assert.equal(config.resultsCurrentCacheMs,300000);
});
test('one failed archive window preserves successful finals and exposes the error',async()=>{
 const service=new ResultsService(),day='2026-01-02',start=dayRange(day).from+3600000;
 service.astekPage=async (_day,key)=>{if(key==='catalog-1')throw Error('HTTP 400');return key.startsWith('catalog')?{payload:{items:[{sportId:40,id:'10'}]}}:{origin:'https://astekbet.com',payload:{items:[{id:'match',sportId:40,opp1:'Alpha',opp2:'Beta',champName:'Dota 2. Test',champId:10,dateStart:start/1000,score:'1:2 (23:36, 61:63, 36:49)'}]}};};
 const result=await service.fetchAstekDay(day);assert.equal(result.complete,false);assert.match(result.error,/HTTP 400/);assert.equal(result.games.length,1);assert.equal(result.games[0].scoreText,'1:2 (23:36, 61:63, 36:49)');assert.equal(result.games[0].resultVerified,true);
 service.readDay=async()=>null;service.providerDay=async source=>source==='astek'?{...result,updatedAt:Date.now()}:{games:[],updatedAt:Date.now()};service.persistIndex=async()=>{};
 const row=await service.buildDay(day);assert.equal(row.providers.astek.ready,false);assert.equal(row.providerGames.astek[0].scoreText,result.games[0].scoreText);assert.equal(row.events[0].sourceRefs[0].resultVerified,true);
});
