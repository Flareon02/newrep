import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PinnacleCollector,parsePinnacle,decimalOdds} from '../src/pinnacle.js';
import {resolveEvents} from '../src/entity-resolver.js';
import {compareSchedule} from '../src/comparison.js';
import {leagueStore,LeagueStore} from '../src/league-store.js';
import Model from '../src/league-model.cjs';
import {stableEventSignature} from '../src/utils.js';
import {SnapshotState} from '../src/state.js';
import {createApi} from '../src/api.js';
import {stopMatcher} from '../src/matcher-client.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/pinnacle-public.json',import.meta.url)));

test('Pinnacle HAR: root fixtures only, decimal prices, map periods and IDs preserved',()=>{
 const rows=parsePinnacle(fixture.matchups,fixture.markets,100);assert.equal(rows.length,1);const r=rows[0];assert.equal(r.source,'pinnacle');assert.equal(r.category,'Valorant');assert.equal(r.team1,'Liquid');assert.equal(r.team2,'Paper Rex');assert.equal(r.sourceEventId,'1637194851');assert.ok(r.odds.markets.some(m=>m.period===2));assert.ok(r.odds.markets.every(m=>m.prices.every(p=>p.decimal>1)));
 assert.equal(decimalOdds(123),2.23);assert.equal(decimalOdds(-150),1.667);assert.equal(decimalOdds(0),null);
 assert.equal(parsePinnacle([{...fixture.matchups[0],isLive:true}],fixture.markets).length,0);
 assert.equal(stableEventSignature(rows),stableEventSignature([{...r,odds:{...r.odds,updatedAt:200}}]));
 assert.notEqual(stableEventSignature(rows),stableEventSignature([{...r,odds:{...r.odds,markets:[]}}]));
});

test('three bookmakers become one fixture, Pinnacle odds survive reversed participants',()=>{
 const p=parsePinnacle(fixture.matchups,fixture.markets)[0],a={...p,id:'a1',sourceEventId:'a1',source:'astek',provider:'AstekBet',odds:undefined},f={...a,id:'f1',sourceEventId:'f1',source:'fonbet',provider:'Fonbet'};
 const rows=resolveEvents([a,f,{...p,team1:p.team2,team2:p.team1}]);assert.equal(rows.length,1);assert.deepEqual(rows[0].sourceRefs.map(r=>r.source),['astek','fonbet','pinnacle']);assert.equal(rows[0].sourceRefs[2].team1,a.team1);assert.ok(rows[0].sourceRefs[2].odds.markets.length);
 assert.equal(resolveEvents([f,p]).length,1);assert.equal(resolveEvents([p]).length,1);
 const duplicate={...p,id:'p-duplicate',sourceEventId:'duplicate'};const deduped=resolveEvents([a,p,duplicate]);assert.equal(deduped.length,1);assert.equal(deduped[0].sourceRefs.length,2);assert.ok(deduped[0].sourceRefs.find(r=>r.source==='pinnacle').aliases.some(x=>x.endsWith(':duplicate')));
 const result=compareSchedule([a],rows,{astekEnabled:false,fonbetEnabled:false});assert.equal(result.matches.length,1);assert.equal(result.matches[0].astek.sourceRefs[0].source,'pinnacle');
 assert.equal(compareSchedule([a],rows,{astekEnabled:false,fonbetEnabled:false,pinnacleEnabled:false}).missingInput.length,1);
});

test('published Pinnacle membership and custom discipline remain distinct from Astek IDs',async()=>{
 const a={source:'astek',leagueId:'12',category:'Dota 2',league:'Northern Open'},p={source:'pinnacle',leagueId:'12',category:'Esports',league:'World event'},store=new LeagueStore();await store.remember([a,p]);const links=Model.connect([],[a,p],'third',100,'Dota 2');links[0].name='Shared league';await store.commit(0,{upsert:links,remove:[]});assert.equal(store.catalogSnapshot().providers.pinnacle.length,1);assert.equal(store.state.links[0].pinnacleLeagues.length,1);assert.notEqual(Model.id(a),Model.id(p));
 const old=leagueStore.state;try{leagueStore.state=store.state;const event={id:'a',team1:'Alpha',team2:'Beta',startAt:1800000000000};assert.equal(resolveEvents([{...event,...a},{...event,...p,id:'p'}]).length,1);}finally{leagueStore.state=old;}
});

test('bulk list matches HAR, and uses two requests without league enumeration',async()=>{
 const list=JSON.parse(fs.readFileSync(new URL('./fixtures/pinnacle-list.json',import.meta.url))),state={events:[],async success(rows){this.events=rows;},async failure(e){this.error=e.message;}},c=new PinnacleCollector(state),calls=[];
 c.get=async path=>{calls.push(path);return path.includes('/matchups?')?list:fixture.markets;};await c.collect();
 assert.equal(list.length,49);assert.equal(state.events.length,47);assert.equal(new Set(state.events.map(e=>e.id)).size,47);assert.equal(calls.length,2);assert.ok(calls.every(p=>p.startsWith('/sports/12/')));assert.equal(c.status().requestsPerCycle,2);
});
test('odds failure keeps new fixtures and old prices; match list failure retains snapshot; 429 backs off',async()=>{
 const old=parsePinnacle(fixture.matchups,fixture.markets)[0],state={events:[old],async success(rows){this.events=rows;},async failure(e){this.error=e.message;}},c=new PinnacleCollector(state);
 const added={...fixture.matchups[0],id:987654321};
 c.get=async path=>{if(path.includes('/matchups?'))return [...fixture.matchups,added];throw Error('network');};await c.collect();assert.equal(state.events.length,2);assert.equal(state.events.find(r=>r.id===old.id).odds.stale,true);assert.equal(state.events.find(r=>r.id===old.id).odds.markets.length,old.odds.markets.length);assert.match(state.error,/коэффициенты/);
 c.get=async()=>{throw Error('network');};c.nextAt=0;await c.tick();assert.equal(state.events.length,2);
 let count=0;c.get=async()=>{count++;throw Object.assign(Error('HTTP 429'),{status:429,retryAfterMs:400100});};c.nextAt=0;await c.tick();assert.ok(c.nextAt-Date.now()>390000);await c.tick();assert.equal(count,1);
});

test('Pinnacle boot uses public config and a generated device ID, without browser cookies',async()=>{
 const calls=[],c=new PinnacleCollector({}, {read:async()=>null,write:async()=>{},request:async(url,ref,options)=>{calls.push({url,options});return {payload:url.endsWith('app.json')?{api:{haywire:{apiKey:'test-key'}}}:[]};}});await c.get('/sports/12/leagues?all=false');assert.equal(calls.length,2);assert.equal(calls[1].options.headers['x-api-key'],'test-key');assert.match(calls[1].options.headers['x-device-uuid'],/^[a-f\d-]{36}$/);assert.equal(calls[1].options.headers.Cookie,undefined);
});

test('API and worker include Pinnacle in line, history, catalogue, health and comparison',async()=>{
 const states=Array.from({length:5},(_,i)=>new SnapshotState('prematch-test-'+i,300000));for(const s of states)s.persist=async()=>{};
 const p=parsePinnacle(fixture.matchups,fixture.markets)[0];await states[1].success([{...p,source:'astek',provider:'AstekBet',id:'a',sourceEventId:'a'}]);await states[3].success([{...p,source:'fonbet',provider:'Fonbet',id:'f',sourceEventId:'f'}]);await states[4].success([p]);
 const server=createApi({liveState:states[0],prematchState:states[1],fonbetLiveState:states[2],fonbetPrematchState:states[3],pinnaclePrematchState:states[4],pinnacleCollector:{status:()=>({mode:'prematch'}),catalog:[]},prematchCollector:{status:()=>({}),catalog:[]},fonbetCollector:{status:()=>({})},resultsService:{status:()=>({}),days:new Map()},startedAt:Date.now()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{const get=async path=>(await fetch(base+path)).json();const line=await get('/api/prematch?compact=1');assert.equal(line.events.length,1);assert.equal(line.events[0].sourceRefs.length,3);assert.equal(line.providers.pinnacle.count,1);assert.equal(line.providers.pinnacle.events,undefined);assert.equal((await get('/api/prematch/history')).events[0].sourceRefs.length,3);assert.equal((await get('/health')).prematch.pinnacle.count,1);assert.ok((await get('/api/leagues')).providers.pinnacle.length);const compared=await (await fetch(base+'/api/prematch/compare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events:[p],options:{astekEnabled:false,fonbetEnabled:false}})})).json();assert.equal(compared.matches[0].astek.sourceRefs[0].source,'pinnacle');}finally{await new Promise(r=>server.close(r));await stopMatcher();}
});
