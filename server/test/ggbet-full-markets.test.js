import test from 'node:test';
import assert from 'node:assert/strict';
import {GgbetLiveCollector,ggbetTokenExpiry,parseGgbetLiveEvent} from '../src/ggbet.js';
import {config} from '../src/config.js';
import {SnapshotState} from '../src/state.js';
import {createApi} from '../src/api.js';
import {stopMatcher} from '../src/matcher-client.js';

// A GGBET LIVE line of 30 matches. The snapshot carries each event with its 3 top markets; the "All" tab and the
// full OnUpdateSportEvent stream carry 15 markets. The fake socket keeps the set of running operations (start/stop),
// so the tests count what is subscribed upstream, not what the collector believes.
const market=(id,i)=>({id,name:`Market ${id}`,status:'ACTIVE',typeId:i===0?1:500+i,tags:[],specifiers:[],meta:[],odds:[{id:'1',name:'A',value:'1.80',isActive:true,status:'NOT_RESULTED',competitorIds:i===0?['h']:[]},{id:'2',name:'B',value:'1.95',isActive:true,status:'NOT_RESULTED',competitorIds:i===0?['a']:[]}]});
const fullMarkets=n=>Array.from({length:15},(_,i)=>market(i===0?'1':`m${n}-${i}`,i));
const event=n=>({id:`5:00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,slug:`m-${n}`,disabled:false,betStop:false,version:'v1',meta:[],
  fixture:{score:'0:0',title:`Home ${n} vs Away ${n}`,status:'LIVE',type:'MATCH',startTime:'2026-10-02T18:00:00+00:00',sportId:'esports_counter_strike',sport:{id:'esports_counter_strike',name:'CS2',slug:'cs2'},tournament:{id:'t',name:'League',slug:'league',sportId:'esports_counter_strike'},
    competitors:[{id:'h',name:`Home ${n}`,homeAway:'HOME',score:[{type:'total',points:'0',number:0}]},{id:'a',name:`Away ${n}`,homeAway:'AWAY',score:[{type:'total',points:'0',number:0}]}]},
  markets:fullMarkets(n)});
const top=e=>({...e,markets:e.markets.slice(0,3)});
const sid=e=>e.id.replace(/^\d+:/,'');

class LineSocket{
  static all=[];
  constructor(url,protocol,options={}){this.url=url;this.options=options;this.readyState=0;this.listeners=new Map();this.sent=[];this.running=new Map();LineSocket.all.push(this);queueMicrotask(()=>{this.readyState=1;this.emit('open',{});});}
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn);}
  emit(name,e){for(const fn of this.listeners.get(name)||[])fn(e);}
  message(obj){this.emit('message',{data:JSON.stringify(obj)});}
  send(body){
    const msg=JSON.parse(body);this.sent.push(msg);
    if(msg.type==='connection_init')return queueMicrotask(()=>this.message({type:'connection_ack'}));
    if(msg.type==='stop'){this.running.delete(msg.id);return;}
    const op=msg.payload?.operationName,v=msg.payload?.variables||{};
    if(op==='GetSportEventListByFilters')return queueMicrotask(()=>{this.message({id:msg.id,type:'data',payload:{data:{matches:{sportEvents:LineSocket.line.map(top)}}}});this.message({id:msg.id,type:'complete'});});
    if(op==='GetMarketsTabs')return queueMicrotask(()=>{this.message({id:msg.id,type:'data',payload:{data:{compiledMarketsTabs:{tabs:[{id:'all',name:'All'}]}}}});this.message({id:msg.id,type:'complete'});});
    if(op==='GetMarketsTab')return queueMicrotask(()=>{const e=LineSocket.line.find(x=>x.id===v.sportEventID);this.message({id:msg.id,type:'data',payload:{data:{compiledMarketsTab:{sportEvent:{id:e.id},marketIds:e.markets.map(m=>m.id)}}}});this.message({id:msg.id,type:'complete'});});
    this.running.set(msg.id,{op,variables:v});
    if(op==='OnUpdateSportEvent')queueMicrotask(()=>{const e=LineSocket.line.find(x=>x.id===v.sportEventId);if(this.running.has(msg.id))this.message({id:msg.id,type:'data',payload:{data:{onUpdateSportEvent:{...e,markets:e.markets.filter(m=>v.marketIds.includes(m.id))}}}});});
  }
  close(code=1000,reason=''){if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>this.emit('close',{code,reason,target:this}));}
  // Upstream view: full = an OnUpdateSportEvent with more than the top markets; tabs = OnUpdateTab streams.
  count(){const subs=[...this.running.values()];return {full:subs.filter(s=>s.op==='OnUpdateSportEvent'&&s.variables.marketIds.length>3).length,light:subs.filter(s=>s.op==='OnUpdateSportEvent'&&s.variables.marketIds.length<=3).length,tabs:subs.filter(s=>s.op==='OnUpdateTab').length};}
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const html=(token='t'.repeat(389))=>`<script>"bettingClientOptions":{"token":"${token}","endpoint":"//gg-b-gql.gg.bet"}</script>`;
async function line(n=30,{now,token}={}){
  LineSocket.line=Array.from({length:n},(_,i)=>event(i+1));LineSocket.all=[];
  let pages=0;const state={rows:[],async success(rows){this.rows=rows;},async failure(){}};
  const c=new GgbetLiveCollector(state,{fetchImpl:async()=>{pages++;return {ok:true,status:200,text:async()=>html(token)};},WebSocketImpl:LineSocket,...(now?{now}:{})});
  c.stopped=false;await c.connect();await wait(30);
  return {c,state,ws:()=>LineSocket.all.at(-1),pages:()=>pages};
}

test('30 LIVE events: the whole catalog, light top-market streams only, 0 full-market subscriptions while idle', async()=>{
  const {c,state,ws,pages}=await line(30);
  try{
    assert.equal(state.rows.length,30);
    assert.deepEqual(ws().count(),{full:0,light:30,tabs:0});
    assert.equal(ws().sent.filter(x=>x.payload?.operationName==='GetMarketsTab').length,0,'no tab catalog for events nobody opened');
    const s=c.status();assert.equal(s.ggbetCatalogEvents,30);assert.equal(s.ggbetActiveFullMarketEvents,0);assert.equal(s.ggbetActiveFullMarketLeases,0);assert.equal(s.ggbetWsConnectionsCreated,1);assert.equal(pages(),1);
    for(const row of state.rows)assert.equal(row.odds.markets.length,3,'list rows keep their main prices');
  }finally{await c.stop();}
});

test('open A → 1, open B → 2, close A → 1, close B → 0; reopen B shows the cached tree at once; one WebSocket, no bootstrap', async()=>{
  const {c,state,ws,pages}=await line(30);
  const [A,B]=[LineSocket.line[0],LineSocket.line[1]],socket=ws();
  try{
    assert.equal(c.lease('client-one-A',sid(A)).ok,true);await wait(20);
    assert.deepEqual(ws().count(),{full:1,light:29,tabs:1});
    const detailA=await c.detail(sid(A),{full:true,timeoutMs:1000});assert.equal(detailA.odds.markets.length,15);
    assert.equal(state.rows.find(r=>r.sourceEventId===sid(A)).odds.markets.length,15);
    assert.equal(c.lease('client-two-B',sid(B)).ok,true);await wait(20);
    assert.deepEqual(ws().count(),{full:2,light:28,tabs:2});
    assert.equal(c.releaseLease('client-one-A'),true);
    assert.deepEqual(ws().count(),{full:1,light:29,tabs:1},'stop is sent at once, not after a timer');
    await wait(80);assert.equal(state.rows.find(r=>r.sourceEventId===sid(A)).odds.markets.length,3,'the public row is back to its main markets (publish is debounced)');
    assert.equal(c.releaseLease('client-two-B'),true);
    assert.deepEqual(ws().count(),{full:0,light:30,tabs:0});
    // Reopen B within the cache window: the last full tree is answered at once (marked), the stream is back.
    const t0=Date.now();const reopened=await c.detail(sid(B),{full:c.lease('client-two-B2',sid(B)).ok,timeoutMs:3000});
    assert.ok(Date.now()-t0<200,`answered in ${Date.now()-t0} ms`);assert.equal(reopened.odds.markets.length,15);assert.equal(reopened.odds.fromCache,true);
    await wait(20);assert.deepEqual(ws().count(),{full:1,light:29,tabs:1});
    c.releaseLease('client-two-B2');
    assert.equal(ws(),socket);assert.equal(LineSocket.all.length,1);assert.equal(c.status().ggbetWsConnectionsCreated,1);assert.equal(pages(),1);assert.equal(c.status().bootstrapFetches,1);
    const s=c.status();assert.equal(s.ggbetFullMarketSubscribes,3);assert.equal(s.ggbetFullMarketUnsubscribes,3);
  }finally{await c.stop();}
});

test('switch A → B with the same lease moves the subscription; provider switch / empty acquire releases it', async()=>{
  const {c,ws}=await line(30);const [A,B]=LineSocket.line;
  try{
    c.lease('panel-lease-x',sid(A));await wait(20);c.lease('panel-lease-x',sid(B));await wait(20);
    assert.deepEqual(ws().count(),{full:1,light:29,tabs:1});
    assert.equal([...ws().running.values()].find(s=>s.op==='OnUpdateSportEvent'&&s.variables.marketIds.length>3).variables.sportEventId,B.id);
    assert.equal(c.lease('panel-lease-x',null).ok,false);
    assert.deepEqual(ws().count(),{full:0,light:30,tabs:0});
  }finally{await c.stop();}
});

test('two clients on the same match: one upstream subscription, two leases; the last release unsubscribes', async()=>{
  const {c,ws}=await line(30);const A=LineSocket.line[0];
  try{
    c.lease('client-one-A',sid(A));c.lease('client-two-A',sid(A));await wait(20);
    assert.deepEqual(ws().count(),{full:1,light:29,tabs:1});assert.equal(c.status().ggbetActiveFullMarketLeases,2);assert.equal(c.status().ggbetActiveFullMarketEvents,1);
    c.releaseLease('client-one-A');assert.deepEqual(ws().count(),{full:1,light:29,tabs:1});
    c.releaseLease('client-two-A');assert.deepEqual(ws().count(),{full:0,light:30,tabs:0});
  }finally{await c.stop();}
});

test('a client that disappears (no renewal, no release): the lease expires and the subscription is stopped; renewals keep it', async()=>{
  let t=Date.now();const {c,ws}=await line(30,{now:()=>t});const [A,B]=LineSocket.line;
  try{
    c.lease('alive-client',sid(A));c.lease('crashed-client',sid(B));await wait(20);
    assert.deepEqual(ws().count(),{full:2,light:28,tabs:2});
    for(let s=0;s<config.ggbetFullLeaseTtlMs+5000;s+=10000){t+=10000;c.lease('alive-client',sid(A));c.maintenance();}
    assert.deepEqual(ws().count(),{full:1,light:29,tabs:1});
    assert.equal(c.status().ggbetFullMarketLeaseExpirations,1);
    t+=config.ggbetFullLeaseTtlMs+1;c.maintenance();
    assert.deepEqual(ws().count(),{full:0,light:30,tabs:0});assert.equal(c.status().ggbetActiveFullMarketLeases,0);
    t+=config.ggbetFullCacheTtlMs+1;c.maintenance();assert.equal(c.status().ggbetFullCacheEvents,0,'the cached trees are dropped after their TTL');
  }finally{await c.stop();}
});

test('a match that leaves LIVE drops its leases and streams (no zombie subscription)', async()=>{
  const {c,ws}=await line(30);const A=LineSocket.line[0];
  try{
    c.lease('client-one-A',sid(A));await wait(20);assert.equal(ws().count().full,1);
    LineSocket.line=LineSocket.line.slice(1);c.requestSnapshot();await wait(20);
    assert.deepEqual(ws().count(),{full:0,light:29,tabs:0});assert.equal(c.status().ggbetActiveFullMarketLeases,0);assert.equal(c.status().ggbetActiveFullMarketEvents,0);
  }finally{await c.stop();}
});

test('safety cap GGBET_MAX_FULL_EVENTS: further events are refused, the main WebSocket stays', async()=>{
  const {c,ws}=await line(30);
  try{
    for(let i=0;i<config.ggbetMaxFullEvents;i++)assert.equal(c.lease(`client-${i}-lease`,sid(LineSocket.line[i])).ok,true);
    const over=c.lease('one-too-many',sid(LineSocket.line[config.ggbetMaxFullEvents]));
    assert.equal(over.ok,false);assert.equal(over.capped,true);
    assert.equal(c.lease('second-on-open-event',sid(LineSocket.line[0])).ok,true,'a leased event takes more clients');
    await wait(20);assert.equal(ws().count().full,config.ggbetMaxFullEvents);assert.equal(c.status().ggbetFullMarketCapRejects,1);
    assert.equal(ws().readyState,1);assert.equal(c.status().ggbetWsConnectionsCreated,1);
  }finally{await c.stop();}
});

test('a reconnect (real close) restores leased full streams in the new WebSocket and light ones for the rest', async()=>{
  const {c,ws}=await line(30);const A=LineSocket.line[0];
  try{
    c.lease('client-one-A',sid(A));await wait(20);
    c.handleClose({code:1006,target:c.ws});c.lastConnectAt=0;await c.connect();await wait(30);
    assert.equal(LineSocket.all.length,2);assert.deepEqual(ws().count(),{full:1,light:29,tabs:1});
  }finally{await c.stop();}
});

test('no timed session refresh by default: a healthy session lives for hours; the watchdog still reconnects a silent one', async()=>{
  assert.equal(config.ggbetSessionRefreshMs,0);
  let t=Date.now();const {c,ws}=await line(3,{now:()=>t});
  try{
    for(let i=0;i<3*3600;i+=30){t+=30000;c.lastMessageAt=t;c.maintenance();}
    assert.equal(ws().readyState,1);assert.equal(c.status().scheduledRefreshes,0);assert.equal(LineSocket.all.length,1);
    t+=config.ggbetWatchdogMs+1;c.maintenance();await wait(5);
    assert.match(c.lastClose,/4001 watchdog/);
  }finally{await c.stop();}
});

test('a token that declares its expiry is renewed a minute before it, not on a fixed timer', async()=>{
  const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  let t=Date.now();const exp=Math.floor((t+30*60000)/1000),token=`${b64({alg:'dir',enc:'A256GCM',exp})}.${'x'.repeat(80)}.${'y'.repeat(40)}.${'z'.repeat(200)}.${'w'.repeat(30)}`;
  assert.equal(ggbetTokenExpiry(token),exp*1000);assert.equal(ggbetTokenExpiry('t'.repeat(389)),0);
  const {c,ws}=await line(3,{now:()=>t,token});
  try{
    assert.ok(c.status().tokenExpiresAt);assert.equal('token' in c.status(),false);
    t+=20*60000;c.lastMessageAt=t;c.maintenance();assert.equal(ws().readyState,1);
    t+=10*60000-59000;c.lastMessageAt=t;c.maintenance();await wait(5);
    assert.match(c.lastClose,/token-expiry/);assert.equal(c.status().expiryRefreshes,1);assert.equal(c.bootstrap,null);
  }finally{await c.stop();}
});

test('API: POST /api/ui/full-markets acquires/renews/releases for the panel; event-detail without a lease never acquires', async()=>{
  const states=Array.from({length:7},(_,i)=>new SnapshotState('test-ggbet-lease-'+i,60000));for(const s of states)s.persist=async()=>{};
  const raw=event(1),row=parseGgbetLiveEvent(top(raw),{at:Date.now()});await states[6].success([row]);
  const calls=[];
  const ggbetCollector={status:()=>({enabled:true}),lease:(lease,id)=>{calls.push(['lease',lease,id]);return {ok:true};},releaseLease:lease=>{calls.push(['release',lease]);return true;},detail:async(id,opts)=>{calls.push(['detail',id,!!opts.full]);return row;}};
  const server=createApi({liveState:states[0],prematchState:states[1],fonbetLiveState:states[2],fonbetPrematchState:states[3],pinnaclePrematchState:states[4],pinnacleLiveState:states[5],ggbetLiveState:states[6],prematchCollector:{status:()=>({}),catalog:[]},fonbetCollector:{status:()=>({})},pinnacleCollector:{status:()=>({}),catalog:[]},ggbetCollector,resultsService:{status:()=>({}),days:new Map()},startedAt:Date.now()});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const post=async body=>(await fetch(base+'/api/ui/full-markets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
  try{
    const live=await (await fetch(base+'/api/ui/live')).json(),id=live.events[0].id;
    assert.deepEqual(await post({lease:'panel-lease-1',action:'acquire',id,provider:'ggbet'}),{ok:true,active:true,capped:false,ttlMs:config.ggbetFullLeaseTtlMs});
    assert.deepEqual(calls.at(-1),['lease','panel-lease-1',sid(raw)]);
    assert.equal((await post({lease:'panel-lease-1',action:'acquire',id,provider:'databet'})).active,false);assert.deepEqual(calls.at(-1),['release','panel-lease-1'],'provider switch releases');
    assert.equal((await post({lease:'panel-lease-1',action:'release'})).ok,true);
    assert.equal((await fetch(base+'/api/ui/full-markets',{method:'POST',body:JSON.stringify({lease:'x',action:'acquire'})})).status,400);
    calls.length=0;await fetch(base+`/api/ui/event-detail?view=live&id=${encodeURIComponent(id)}&provider=ggbet`);
    assert.deepEqual(calls,[['detail',sid(raw),false]],'a prefetch (no lease) never acquires full markets');
    calls.length=0;await fetch(base+`/api/ui/event-detail?view=live&id=${encodeURIComponent(id)}&provider=ggbet&lease=panel-lease-1`);
    assert.deepEqual(calls,[['lease','panel-lease-1',sid(raw)],['detail',sid(raw),true]]);
  }finally{await new Promise(r=>server.close(r));await stopMatcher();}
});

// ---- Observation: score kept moving while odds stayed frozen until a reload (2026-10-02, browser, network change) ----
test('score and odds travel in the same OnUpdateSportEvent stream (one subscription per event, one WebSocket)', async()=>{
  const {c,state,ws}=await line(3);const A=LineSocket.line[0];
  try{
    const sub=[...ws().running.entries()].find(([,s])=>s.op==='OnUpdateSportEvent'&&s.variables.sportEventId===A.id);
    const push={id:A.id,version:'v2',fixture:{score:'1:0',status:'LIVE',competitors:[{id:'h',score:[{type:'total',points:'1',number:0}]},{id:'a',score:[{type:'total',points:'0',number:0}]}]},markets:[{...A.markets[0],odds:[{...A.markets[0].odds[0],value:'1.71'},{...A.markets[0].odds[1],value:'2.00'}]}]};
    ws().message({id:sub[0],type:'data',payload:{data:{onUpdateSportEvent:push}}});await wait(10);
    const row=state.rows.find(r=>r.sourceEventId===sid(A));
    assert.deepEqual(row.seriesScore,[1,0]);assert.deepEqual(row.odds.markets.find(m=>m.type==='moneyline').prices.map(p=>p.decimal),[1.71,2]);
    assert.equal(LineSocket.all.length,1);
  }finally{await c.stop();}
});

test('a leased full stream that stops pushing while the snapshots move is restarted inside the same session', async()=>{
  let t=Date.now();const {c,state,ws,pages}=await line(3,{now:()=>t});const A=LineSocket.line[0],socket=ws();
  try{
    c.lease('panel-lease-A',sid(A));await wait(20);
    const first=[...ws().running.entries()].find(([,s])=>s.op==='OnUpdateSportEvent'&&s.variables.marketIds.length>3)[0];
    // The event moves on (prices change), the full stream says nothing; the 30 s snapshots see the new prices.
    A.markets[0]={...A.markets[0],odds:[{...A.markets[0].odds[0],value:'1.71'},{...A.markets[0].odds[1],value:'2.00'}]};
    c.requestSnapshot();await wait(20);assert.ok(ws().running.has(first),'one disagreeing snapshot is not enough');
    t+=30000;c.requestSnapshot();await wait(20);
    assert.ok(!ws().running.has(first),'the quiet stream was stopped');
    assert.deepEqual(ws().count(),{full:1,light:2,tabs:1});
    assert.equal(c.status().ggbetFullStreamResyncs,1);
    assert.deepEqual(state.rows.find(r=>r.sourceEventId===sid(A)).odds.markets.find(m=>m.type==='moneyline').prices.map(p=>p.decimal),[1.71,2]);
    assert.equal(ws(),socket);assert.equal(c.status().ggbetWsConnectionsCreated,1);assert.equal(pages(),1);assert.equal(c.status().scheduledRefreshes,0);
  }finally{await c.stop();}
});

test('a full stream that keeps pushing is never restarted, even when a snapshot disagrees for a moment', async()=>{
  let t=Date.now();const {c,ws}=await line(3,{now:()=>t});const A=LineSocket.line[0];
  try{
    c.lease('panel-lease-A',sid(A));await wait(20);
    const id=[...ws().running.entries()].find(([,s])=>s.op==='OnUpdateSportEvent'&&s.variables.marketIds.length>3)[0];
    A.markets[0]={...A.markets[0],odds:[{...A.markets[0].odds[0],value:'1.60'},{...A.markets[0].odds[1],value:'2.20'}]};
    c.requestSnapshot();await wait(20);
    ws().message({id,type:'data',payload:{data:{onUpdateSportEvent:{id:A.id,version:'v3',markets:[A.markets[1]]}}}});await wait(10);
    t+=30000;c.requestSnapshot();await wait(20);
    assert.ok(ws().running.has(id));assert.equal(c.status().ggbetFullStreamResyncs,0);
  }finally{await c.stop();}
});

test('a guest token is reused only through the egress (proxy agent) it was issued through', async()=>{
  let pages=0;const c=new GgbetLiveCollector({async success(){},async failure(){}},{fetchImpl:async()=>{pages++;return {ok:true,status:200,text:async()=>html()};}});
  const agentA={name:'gateway A'},agentB={name:'gateway B'};
  await c.fetchBootstrap(false,agentA);await c.fetchBootstrap(false,agentA);assert.equal(pages,1,'same egress within the cache window: same token');
  await c.fetchBootstrap(false,agentB);assert.equal(pages,2,'another egress: a new token from that egress');
});
