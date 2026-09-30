import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parsePinnacle,PinnacleCollector,pinnacleLeague} from '../src/pinnacle.js';
import {SnapshotState} from '../src/state.js';
import {ScoreLog} from '../src/score-log.js';
import {createApi} from '../src/api.js';
import {stopMatcher} from '../src/matcher-client.js';
const live=JSON.parse(fs.readFileSync(new URL('./fixtures/pinnacle-live.json',import.meta.url))),one=live.matchups[0];
const line=live.matchups.map(m=>({...m,...m.parent,isLive:false,type:'matchup',parentId:null,parent:null,status:'pending'}));
const fake=()=>({events:[],history:[],success:async function(rows){this.events=rows;this.history.push(...rows);this.error='';},failure:async function(e){this.error=e.message;}});

test('actual LIVE HAR: child IDs attach to line parent, odds use live ID, absent score is never invented',()=>{
 const pre=parsePinnacle(line,[]),rows=parsePinnacle(live.matchups,live.markets,100,'live');
 assert.equal(rows.length,2);assert.equal(rows[0].sourceEventId,String(one.parentId));assert.equal(rows[0].id,pre[0].id);assert.equal(rows[0].upstreamEventId,String(one.id));assert.match(rows[0].url,new RegExp('/'+one.id+'/$'));assert.ok(rows[0].odds.markets.length>0);assert.equal(rows[0].scoreText,undefined);assert.equal(rows[0].league,'Logitech G Play Connect');assert.equal(rows[0].category,'Counter Strike 2');
 assert.equal(parsePinnacle(live.matchups,live.markets).length,0);assert.ok(rows[1].odds.markets.some(r=>r.period===2));
 for(const [name,expected] of [['LoL - CBLOL','CBLOL'],['CS2 - - CCT South America Series','CCT South America Series'],['Rainbow Six Siege - Asia Pacific League - North','Asia Pacific League - North']])assert.equal(pinnacleLeague(name),expected);
});

test('LIVE transition removes parent from line immediately and after disappearance/restart; line cadence remains 60s',async()=>{
 const pre=fake(),playing=fake();await pre.success(parsePinnacle(line,[]));const c=new PinnacleCollector(pre,{liveState:playing});const calls=[];
 c.get=async path=>{calls.push(path);return path.includes('/matchups')?(path.includes('/live')?live.matchups:line):live.markets;};
 await c.collect();assert.equal(playing.events.length,2);assert.equal(pre.events.length,0);assert.equal(calls.length,4);
 calls.length=0;await c.collect();assert.equal(calls.length,2);assert.ok(calls.every(p=>p.includes('/live')));
 c.get=async path=>path.includes('/matchups')?(path.includes('/live')?[]:line):[];c.nextPrematchAt=0;await c.collect();assert.equal(playing.events.length,0);assert.equal(pre.events.length,0);
 const reboot=new PinnacleCollector(pre,{liveState:playing});reboot.get=c.get;await reboot.collect();assert.equal(pre.events.length,0);
});

test('LIVE network error preserves last feed and odds; 429 respects backoff',async()=>{
 const pre=fake(),playing=fake(),c=new PinnacleCollector(pre,{liveState:playing});await playing.success(parsePinnacle(live.matchups,live.markets,100,'live'));c.nextPrematchAt=Date.now()+60000;
 c.get=async()=>{throw Error('network');};await c.collect();assert.equal(playing.events.length,2);assert.match(playing.error,/network/);
 c.get=async path=>{if(path.includes('matchups'))return live.matchups;throw Error('prices unavailable');};await c.collect();assert.equal(playing.events[0].odds.stale,true);assert.ok(playing.events[0].odds.markets.length>0);
 c.get=async()=>{throw Object.assign(Error('HTTP 429'),{status:429,retryAfterMs:360000});};await c.tick();assert.ok(c.nextAt>Date.now()+350000);assert.equal(playing.events.length,2);
});

test('journal keeps entered/removed markers at unchanged score, including a scoreless Pinnacle LIVE event',async()=>{
 const disk=new Map(),io={read:async(k,d)=>disk.get(k)||d,write:async(k,v)=>disk.set(k,v)},log=new ScoreLog(io),r={source:'astek',id:'abc',team1:'Alpha',team2:'Beta',scoreText:'1:0'};
 await log.record([r],{at:100,event:'entered'});await log.record([r],{at:110});await log.record([r],{at:120,event:'removed'});await log.record([r],{at:130,event:'entered'});await log.record([{...r,scoreText:'1:1'}],{at:140});
 const entries=(await new ScoreLog(io).get(['astek:abc'])).entries;assert.deepEqual(entries.map(r=>r.event||'score'),['score','entered','removed','entered']);assert.equal(entries[1].scoreText,'1:0');
 const p=parsePinnacle(live.matchups,live.markets,100,'live')[0];await log.record([p],{at:150,event:'entered'});assert.equal((await log.get(['pinnacle:'+p.sourceEventId])).entries[0].scoreText,'');
});

test('Pinnacle LIVE reaches compact API, history, health and score journal',async()=>{
 const states=Array.from({length:6},(_,i)=>new SnapshotState('test-prematch-live-'+i,60000));for(const s of states)s.persist=async()=>{};
 await states[5].success(parsePinnacle(live.matchups,live.markets,100,'live'));
 const server=createApi({liveState:states[0],prematchState:states[1],fonbetLiveState:states[2],fonbetPrematchState:states[3],pinnaclePrematchState:states[4],pinnacleLiveState:states[5],prematchCollector:{status:()=>({}),catalog:[]},fonbetCollector:{status:()=>({})},pinnacleCollector:{status:()=>({mode:'live+prematch'}),catalog:[]},resultsService:{status:()=>({}),days:new Map()},startedAt:Date.now()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const get=async path=>{const res=await fetch('http://127.0.0.1:'+server.address().port+path);assert.equal(res.status,200);return res.json();};
 try{const snap=await get('/api/live?compact=1');assert.equal(snap.providers.pinnacle.count,2);assert.equal(snap.events.length,2);assert.equal(snap.providers.pinnacle.events,undefined);assert.ok(snap.events[0].sourceRefs[0].odds.markets.length);assert.equal((await get('/api/live/history')).events.length,2);assert.equal((await get('/health')).intervalsMs.pinnacleLive,15000);await get('/api/score-history?ids=pinnacle:'+one.parentId);}finally{await new Promise(r=>server.close(r));await stopMatcher();}
});
