import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PrematchCollector,parseChamps} from '../src/prematch.js';
import {compareSchedule} from '../src/comparison.js';
import {resolveEvents} from '../src/entity-resolver.js';
import {leagueStore} from '../src/league-store.js';
import M from '../src/league-model.cjs';
import {matchAsync,stopMatcher} from '../src/matcher-client.js';
const catalog=JSON.parse(await fs.readFile(new URL('./fixtures/astek-champs.json',import.meta.url)));
const games=JSON.parse(await fs.readFile(new URL('./fixtures/astek-prematch-games.json',import.meta.url)));
after(stopMatcher);
test('actual Astek fixtures: 46 leagues, 198 games',()=>{
 const champs=parseChamps(catalog);assert.equal(champs.length,46);assert.equal(champs.reduce((n,c)=>n+c.gameCount,0),198);
});
test('actual league feed uses HAR-confirmed aggregate endpoint and keeps snapshot after network error',async()=>{
 const calls=[],state={events:[],success:async function(e){this.events=e;},failure:async function(e){this.error=e.message;}};
 const request=async url=>{calls.push(url);return {payload:url.includes('GetChampsZip')?{...catalog,Value:catalog.Value.filter(c=>c.LI===3026226)}:games,status:200};};
 const c=new PrematchCollector(state,{request,sleep:async()=>{},persist:async()=>{}});await c.poll();assert.equal(state.events.length,6);assert.equal(calls.length,2);assert.doesNotMatch(calls[1],/[?&]champs=/);assert.equal(c.batchSupported,true);assert.ok(state.events.every(e=>e.url.includes('/line/')&&e.leagueId==='3026226'));
 c.request=async()=>{throw Error('network');};await c.poll();assert.equal(state.events.length,6);assert.equal(state.error,'network');
});
test('failed aggregate probe falls back to serial per-league requests and backs off bulk retry',async()=>{
 const cats={Success:true,Value:[{SI:40,LI:1,L:'Dota 2. A',GC:1},{SI:40,LI:2,L:'Dota 2. B',GC:1}]};let inflight=0,max=0,batchCalls=0,bulkCalls=0;
 const state={events:[],success:async function(e){this.events=e;},failure:async function(e){throw e;}};
 const request=async url=>{inflight++;max=Math.max(max,inflight);await Promise.resolve();inflight--;if(url.includes('GetChampsZip'))return {payload:cats};const champs=new URL(url).searchParams.get('champs');if(!champs){bulkCalls++;throw Error('bulk unavailable');}const ids=champs.split(',');if(ids.length>1)batchCalls++;return {payload:{Success:true,Value:[{...games.Value[0],I:Number(ids[0]),LI:Number(ids[0])}]}};};
 const c=new PrematchCollector(state,{request,sleep:async()=>{},persist:async()=>{}});await c.poll();assert.equal(state.events.length,2);assert.equal(c.batchSupported,false);assert.equal(bulkCalls,1);await c.poll();assert.equal(bulkCalls,1);assert.equal(batchCalls,0);assert.equal(max,1);
});
test('league links transfer between LIVE and line IDs; conflicting names stay unlinked',()=>{
 const a={source:'astek',category:'Dota 2',league:'Dota 2. Example',leagueId:'pre'},b={...a,source:'fonbet',leagueId:'fb'};
 const group={...M.connect([],[a,b],'g')[0],name:'Моя лига'};
 const old=leagueStore.state;leagueStore.state={...old,links:[group],revision:1};try{
 const live={...a,id:'event',sourceEventId:'event',leagueId:'live',team1:'Alpha',team2:'Beta',startAt:Date.now()};assert.equal(resolveEvents([live],{mode:'live'})[0].league,'Моя лига');
 const second={...group,id:'other',astekLeagues:[{...a,leagueId:'other'}],fonbetLeagues:[],astekLeagueIds:['astek:id:other'],fonbetLeagueIds:[]};assert.equal(M.groupFor(live,[group,second]),null);
 }finally{leagueStore.state=old;}
});
test('partial cycle keeps successful refresh time while marking the snapshot partial',async()=>{
 const state={events:[{id:'old2',leagueId:'2'}],lastSuccessfulUpdateAt:100,async success(events){this.events=events;this.lastSuccessfulUpdateAt=200;},async partialFailure(e){this.partial=true;this.error=e.message;}};
 const c=new PrematchCollector(state,{sleep:async()=>{},persist:async()=>{},request:async url=>{
  if(url.includes('GetChampsZip'))return {payload:{Success:true,Value:[{SI:40,LI:1,L:'Dota 2. A',GC:1},{SI:40,LI:2,L:'Dota 2. B',GC:1}]}};
  if(new URL(url).searchParams.get('champs')==='2')throw Error('network');
  return {payload:{Success:true,Value:[{...games.Value[0],I:1,LI:1}]}};
 }});c.batchSupported=false;await c.poll();assert.deepEqual(state.events.map(e=>e.id),['1','old2']);assert.equal(state.lastSuccessfulUpdateAt,200);assert.equal(state.partial,true);assert.match(state.error,/частично/);
});
test('133-row comparison stays responsive and works through its dedicated worker',async()=>{
 const now=Date.now(),events=Array.from({length:133},(_,i)=>({id:String(i),source:'astek',category:'Dota 2',league:'Dota 2. League '+i,leagueId:String(i),team1:'Alpha '+i,team2:'Beta '+i,startAt:now+(i%12)*3600000}));
 const old=leagueStore.catalog;leagueStore.catalog=new Map(Array.from({length:500},(_,i)=>{const r={...events[i%events.length],league:'Dota 2. League '+i,leagueId:String(i)};return [M.id(r),r];}));
 try{const input=events.map(({source,id,...r})=>r),start=performance.now(),result=compareSchedule(input,events);assert.equal(result.matches.length,133);assert.ok(performance.now()-start<2500);const remote=await matchAsync('compare',{input,events,options:{}});assert.equal(remote.matches.length,133);console.log('133-row compare + worker:',Math.round(performance.now()-start),'ms');}finally{leagueStore.catalog=old;}
});
