import test from 'node:test';
import assert from 'node:assert/strict';
import {GgbetLiveCollector,mergeGgbetEvent,parseGgbetLiveEvent} from '../src/ggbet.js';
import {SnapshotState} from '../src/state.js';
import {createApi} from '../src/api.js';
import {stopMatcher} from '../src/matcher-client.js';
import {resolveEvents} from '../src/entity-resolver.js';

const dota=()=>({
  id:'5:796fc384-09dd-4927-a24b-92e349f1287d',slug:'moonlight-wispers-vs-project-achilles-28-09',disabled:false,betStop:false,version:'v1',meta:[{name:'bo',value:'3'}],
  fixture:{score:'0:1',title:'Moonlight Wispers vs Project Achilles',status:'LIVE',type:'MATCH',startTime:'2026-09-28T18:00:00+00:00',sportId:'esports_dota_2',sport:{id:'esports_dota_2',name:'Dota 2',tags:['ESPORT','CYBER'],slug:'dota-2'},tournament:{id:'gin:league-1',name:'Mad Dogs League',slug:'mad-dogs-league',sportId:'esports_dota_2'},competitors:[
    {id:'gin:home',name:'Moonlight Wispers',homeAway:'HOME',logo:'cdn.gin.bet/team/home.png',score:[{type:'total',points:'0',number:0},{type:'map',points:'18',number:2}]},
    {id:'gin:away',name:'Project Achilles',homeAway:'AWAY',logo:'cdn.gin.bet/team/away.png',score:[{type:'total',points:'1',number:0},{type:'map',points:'22',number:2}]}
  ]},
  markets:[
    {id:'1',name:'Победитель',status:'ACTIVE',typeId:1,tags:[],specifiers:[],meta:[{name:'provider_source',value:'databet'}],odds:[{id:'1',name:'Moonlight Wispers',value:'3.30',isActive:true,status:'NOT_RESULTED',competitorIds:['gin:home']},{id:'2',name:'Project Achilles',value:'1.28',isActive:true,status:'NOT_RESULTED',competitorIds:['gin:away']}]},
    {id:'17h1_5',name:'Фора по картам',status:'ACTIVE',typeId:17,tags:['hcp'],specifiers:[{name:'hcp',value:'1.5'}],odds:[{id:'1',name:'Moonlight Wispers (+1.5)',value:'1.68',isActive:true,status:'NOT_RESULTED',competitorIds:['gin:home']},{id:'2',name:'Project Achilles (-1.5)',value:'2.04',isActive:true,status:'NOT_RESULTED',competitorIds:['gin:away']}]},
    {id:'14t2_5',name:'Тотал карт',status:'ACTIVE',typeId:14,tags:['total'],specifiers:[{name:'total',value:'2.5'}],odds:[{id:'1',name:'Больше 2.5',value:'1.68',isActive:true,status:'NOT_RESULTED',competitorIds:[]},{id:'2',name:'Меньше 2.5',value:'2.04',isActive:true,status:'NOT_RESULTED',competitorIds:[]}]}
  ]
});

test('GGBET parser keeps stable source ID, score and typed top markets',()=>{
  const event=parseGgbetLiveEvent(dota(),{origin:'https://gg.bet',at:123});
  assert.equal(event.source,'ggbet');assert.equal(event.provider,'GGBET');assert.equal(event.sourceEventId,'796fc384-09dd-4927-a24b-92e349f1287d');
  assert.equal(event.category,'Dota 2');assert.equal(event.league,'Mad Dogs League');assert.deepEqual(event.seriesScore,[0,1]);assert.deepEqual(event.mapScores,[[18,22]]);assert.equal(event.bestOf,3);
  assert.equal(event.odds.transport,'graphql-ws');assert.deepEqual(event.odds.markets.map(m=>[m.type,m.title]),[['moneyline','Победитель'],['map-handicap','Фора по картам'],['map-total','Тотал карт']]);
  assert.equal(event.odds.markets[0].prices[0].designation,'home');assert.equal(event.odds.markets[0].prices[0].decimal,3.3);assert.match(event.url,/gg\.bet\/ru\/esports\/match/);
});

test('partial push merges score/markets without erasing fixture identity',()=>{
  const base=dota(),patch={id:base.id,version:'v2',fixture:{score:'1:1',status:'LIVE',competitors:[{id:'gin:home',score:[{type:'total',points:'1',number:0}]},{id:'gin:away',score:[{type:'total',points:'1',number:0}]}]},markets:base.markets.slice(0,1)};
  const merged=mergeGgbetEvent(base,patch),event=parseGgbetLiveEvent(merged);
  assert.equal(merged.fixture.title,base.fixture.title);assert.equal(merged.fixture.tournament.name,'Mad Dogs League');assert.equal(merged.fixture.competitors[0].name,'Moonlight Wispers');assert.deepEqual(event.seriesScore,[1,1]);assert.equal(event.odds.markets.length,1);
});

class FakeSocket{
  constructor(url,protocol,options={}){this.url=url;this.protocol=protocol;this.options=options;this.readyState=0;this.listeners=new Map();this.sent=[];FakeSocket.last=this;queueMicrotask(()=>{this.readyState=1;this.emit('open',{});});}
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn);}
  emit(name,event){for(const fn of this.listeners.get(name)||[])fn(event);}
  message(obj){this.emit('message',{data:JSON.stringify(obj)});}
  send(body){const msg=JSON.parse(body);this.sent.push(msg);if(msg.type==='connection_init')queueMicrotask(()=>this.message({type:'connection_ack'}));
    else if(msg.payload?.operationName==='GetMarketsTab')queueMicrotask(()=>{this.message({id:msg.id,type:'data',payload:{data:{compiledMarketsTab:{sportEvent:{id:dota().id},marketIds:dota().markets.map(m=>m.id)}}}});this.message({id:msg.id,type:'complete'});});
    else if(String(msg.id).startsWith('s'))queueMicrotask(()=>{this.message({id:msg.id,type:'data',payload:{data:{matches:{sportEvents:[dota()]}}}});this.message({id:msg.id,type:'complete'});});}
  close(code=1000,reason=''){if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>this.emit('close',{code,reason,target:this}));}
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));

test('collector bootstraps guest token, snapshots, subscribes and invalidates token on auth close',async()=>{
  let fetches=0;const token='x'.repeat(389),html=`<script>"bettingClientOptions":{"token":"${token}","endpoint":"//gg-b-gql.gg.bet","scoreboardEndpoint":"//score-board.databet.cloud"}</script>`;
  const state={rows:[],errors:[],async success(rows){this.rows=rows;},async failure(e){this.errors.push(e);}};
  const collector=new GgbetLiveCollector(state,{fetchImpl:async()=>{fetches++;return{ok:true,status:200,text:async()=>html};},WebSocketImpl:FakeSocket});collector.stopped=false;
  await collector.connect();await wait(20);
  assert.equal(fetches,1);assert.equal(state.rows.length,1);assert.equal(state.rows[0].source,'ggbet');assert.equal(FakeSocket.last.options?.headers?.Origin,'https://gg.bet');assert.equal(FakeSocket.last.options?.perMessageDeflate,false);assert.ok(FakeSocket.last.sent.some(x=>x.payload?.operationName==='OnUpdateSportEvent'));
  const subscription=FakeSocket.last.sent.find(x=>x.payload?.operationName==='OnUpdateSportEvent');FakeSocket.last.message({id:subscription.id,type:'data',payload:{data:{onUpdateSportEvent:{id:dota().id,version:'v2',fixture:{score:'1:1',status:'LIVE',competitors:[{id:'gin:home',score:[{type:'total',points:'1',number:0}]},{id:'gin:away',score:[{type:'total',points:'1',number:0}]}]},markets:dota().markets}}}});await wait(10);
  assert.deepEqual(state.rows[0].seriesScore,[1,1]);assert.equal(collector.status().pushes,1);assert.equal('token' in collector.status(),false);
  collector.handleClose({code:4401,reason:'token expired',target:collector.ws});assert.equal(collector.bootstrap,null);assert.match(collector.lastClose,/4401/);await collector.stop();
});

test('collector rotates bootstrap mirrors and never exposes the guest token in diagnostics',async()=>{
  const {config}=await import('../src/config.js');
  const previous=[...config.ggbetOrigins];config.ggbetOrigins=['https://first.invalid','https://gg.bet'];
  const token='z'.repeat(389),html=`<script>"bettingClientOptions":{"token":"${token}","endpoint":"//gg-b-gql.gg.bet","scoreboardEndpoint":"//score-board.databet.cloud"}</script>`;
  const calls=[],state={async success(){},async failure(){}};
  const collector=new GgbetLiveCollector(state,{fetchImpl:async url=>{calls.push(url);if(url.startsWith('https://first.invalid'))return {ok:false,status:503,text:async()=>''};return {ok:true,status:200,text:async()=>html};},WebSocketImpl:FakeSocket,trustedOrigins:['https://first.invalid','https://gg.bet']});
  try{
    const boot=await collector.fetchBootstrap(true);
    assert.equal(boot.origin,'https://gg.bet');assert.equal(calls.length,2);assert.equal(collector.status().bootstrapFailures,1);assert.equal(collector.status().bootstrapFetches,1);
    assert.equal('token' in collector.status(),false);assert.equal(JSON.stringify(collector.status()).includes(token),false);
  }finally{config.ggbetOrigins=previous;await collector.stop();}
});

test('persisted-query failures fall back to plain snapshot and then degraded snapshots if push hash changes',async()=>{
  const token='q'.repeat(389),html=`<script>"bettingClientOptions":{"token":"${token}","endpoint":"//gg-b-gql.gg.bet","scoreboardEndpoint":"//score-board.databet.cloud"}</script>`;
  class FallbackSocket extends FakeSocket{
    send(body){const msg=JSON.parse(body);this.sent.push(msg);
      if(msg.type==='connection_init')queueMicrotask(()=>this.message({type:'connection_ack'}));
      else if(msg.payload?.operationName==='GetMarketsTab')queueMicrotask(()=>{this.message({id:msg.id,type:'data',payload:{data:{compiledMarketsTab:{sportEvent:{id:dota().id},marketIds:dota().markets.map(m=>m.id)}}}});this.message({id:msg.id,type:'complete'});});
      else if(String(msg.id).startsWith('s'))queueMicrotask(()=>{
        if(msg.payload?.extensions?.persistedQuery)this.message({id:msg.id,type:'error',payload:{errors:[{message:'PersistedQueryNotFound'}]}});
        else {this.message({id:msg.id,type:'data',payload:{data:{matches:{sportEvents:[dota()]}}}});this.message({id:msg.id,type:'complete'});}
      });
    }
  }
  const state={rows:[],async success(rows){this.rows=rows;},async failure(){}};
  const collector=new GgbetLiveCollector(state,{fetchImpl:async()=>({ok:true,status:200,text:async()=>html}),WebSocketImpl:FallbackSocket});collector.stopped=false;
  await collector.connect();await wait(30);
  assert.equal(state.rows.length,1);assert.equal(collector.status().plainSnapshots,1);
  const sub=FallbackSocket.last.sent.find(x=>x.payload?.operationName==='OnUpdateSportEvent');assert.ok(sub);
  FallbackSocket.last.message({id:sub.id,type:'error',payload:{errors:[{message:'PersistedQueryNotFound'}]}});await wait(5);
  assert.equal(collector.status().degradedPolling,true);assert.equal(collector.status().pushFallbacks,1);assert.equal(collector.status().subscriptions,0);
  await collector.stop();
});

test('scheduled session refresh discards cached token and reconnects quickly',async()=>{
  const {config}=await import('../src/config.js');const old=config.ggbetSessionRefreshMs;config.ggbetSessionRefreshMs=1;
  const token='r'.repeat(389),html=`<script>"bettingClientOptions":{"token":"${token}","endpoint":"//gg-b-gql.gg.bet","scoreboardEndpoint":"//score-board.databet.cloud"}</script>`;
  const state={async success(){},async failure(){}};const collector=new GgbetLiveCollector(state,{fetchImpl:async()=>({ok:true,status:200,text:async()=>html}),WebSocketImpl:FakeSocket});collector.stopped=false;
  try{await collector.connect();await wait(10);collector.lastConnectAt=Date.now()-100;collector.maintenance();await wait(5);assert.equal(collector.bootstrap,null);assert.ok(collector.status().scheduledRefreshes>=1);assert.match(collector.lastClose,/4001|scheduled-token-refresh/);}finally{config.ggbetSessionRefreshMs=old;await collector.stop();}
});

test('GGBET LIVE reaches combined API, provider endpoint and health without entering prematch',async()=>{
  const states=Array.from({length:7},(_,i)=>new SnapshotState('test-ggbet-'+i,60000));for(const s of states)s.persist=async()=>{};
  const event=parseGgbetLiveEvent(dota(),{at:Date.now()});await states[6].success([event]);
  const server=createApi({liveState:states[0],prematchState:states[1],fonbetLiveState:states[2],fonbetPrematchState:states[3],pinnaclePrematchState:states[4],pinnacleLiveState:states[5],ggbetLiveState:states[6],prematchCollector:{status:()=>({}),catalog:[]},fonbetCollector:{status:()=>({})},pinnacleCollector:{status:()=>({}),catalog:[]},ggbetCollector:{status:()=>({enabled:true,connected:true,transport:'graphql-ws',subscriptions:1})},resultsService:{status:()=>({}),days:new Map()},startedAt:Date.now()});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const get=async path=>{const res=await fetch('http://127.0.0.1:'+server.address().port+path);assert.equal(res.status,200);return res.json();};
  try{
    const live=await get('/api/live?compact=1');assert.equal(live.providers.ggbet.count,1);assert.equal(live.events.length,1);assert.equal(live.events[0].sourceRefs[0].source,'ggbet');assert.equal(live.providers.ggbet.events,undefined);
    const direct=await get('/api/live/ggbet?compact=1');assert.equal(direct.providers.ggbet.count,1);assert.equal(direct.events[0].source,'ggbet');
    const health=await get('/health');assert.equal(health.live.ggbet.count,1);assert.equal(health.ggbetCollector.connected,true);assert.equal(health.prematch.ggbet,undefined);
  }finally{await new Promise(r=>server.close(r));await stopMatcher();}
});

test('four LIVE bookmakers resolve into one fixture without changing the Astek/Fonbet core',()=>{
  const start=Date.parse('2026-09-28T18:00:00Z'),base={category:'Dota 2',league:'Mad Dogs League',team1:'Moonlight Wispers',team2:'Project Achilles',startAt:start,marketKind:'main'};
  const rows=[
    {...base,id:'a',source:'astek',sourceEventId:'a',provider:'AstekBet'},
    {...base,id:'f',source:'fonbet',sourceEventId:'f',provider:'Fonbet',startAt:start+1000},
    {...base,id:'p',source:'pinnacle',sourceEventId:'p',provider:'Pinnacle',startAt:start+2000},
    {...base,id:'g',source:'ggbet',sourceEventId:'g',provider:'GGBET',startAt:start+3000}
  ];
  const merged=resolveEvents(rows,{mode:'live'});assert.equal(merged.length,1);assert.deepEqual(new Set(merged[0].sourceRefs.map(r=>r.source)),new Set(['astek','fonbet','pinnacle','ggbet']));
});


test('collector follows GGBET All market tab and keeps the complete market set across lightweight snapshots',async()=>{
  const full=dota();
  for(let i=4;i<=15;i++)full.markets.push({
    id:`extra-${i}`,name:`Map 1 - market ${i}`,status:'ACTIVE',typeId:500+i,tags:[],specifiers:[{name:'mapnr',value:'1'}],meta:[],
    odds:[
      {id:'1',name:`Option A ${i}`,value:'1.80',isActive:true,status:'NOT_RESULTED',competitorIds:[]},
      {id:'2',name:`Option B ${i}`,value:'1.95',isActive:true,status:'NOT_RESULTED',competitorIds:[]}
    ]
  });
  const top={...full,markets:full.markets.slice(0,3)};
  class CatalogSocket extends FakeSocket{
    send(body){const msg=JSON.parse(body);this.sent.push(msg);
      if(msg.type==='connection_init')queueMicrotask(()=>this.message({type:'connection_ack'}));
      else if(String(msg.id).startsWith('s'))queueMicrotask(()=>{this.message({id:msg.id,type:'data',payload:{data:{matches:{sportEvents:[top]}}}});this.message({id:msg.id,type:'complete'});});
      else if(msg.payload?.operationName==='GetMarketsTab')queueMicrotask(()=>{this.message({id:msg.id,type:'data',payload:{data:{compiledMarketsTab:{sportEvent:{id:full.id},marketIds:full.markets.map(m=>m.id)}}}});this.message({id:msg.id,type:'complete'});});
      else if(msg.payload?.operationName==='OnUpdateSportEvent')queueMicrotask(()=>this.message({id:msg.id,type:'data',payload:{data:{onUpdateSportEvent:full}}}));
    }
  }
  const token='f'.repeat(389),html=`<script>"bettingClientOptions":{"token":"${token}","endpoint":"//gg-b-gql.gg.bet"}</script>`;
  const state={rows:[],async success(rows){this.rows=rows;},async failure(){}};
  const collector=new GgbetLiveCollector(state,{fetchImpl:async()=>({ok:true,status:200,text:async()=>html}),WebSocketImpl:CatalogSocket});collector.stopped=false;
  await collector.connect();await wait(30);
  // Not opened: only the light subscription (the snapshot's top markets), no tab catalog.
  assert.equal(CatalogSocket.last.sent.filter(x=>x.payload?.operationName==='GetMarketsTab').length,0);
  const light=CatalogSocket.last.sent.find(x=>x.payload?.operationName==='OnUpdateSportEvent');
  // 4.12 pricing observer: the ONE monitored LIVE Dota event's light stream also lists its odd/even markets (96m1..96m5).
  assert.ok(light);assert.deepEqual(light.payload.variables.marketIds,[...top.markets.map(m=>m.id),'96m1','96m2','96m3','96m4','96m5']);
  // Opened in a detail panel: the full tree is leased inside the same WebSocket.
  const socket=CatalogSocket.last;assert.equal(collector.lease('panel-lease-1',full.id).ok,true);await wait(20);assert.equal(CatalogSocket.last,socket);
  const catalog=CatalogSocket.last.sent.find(x=>x.payload?.operationName==='GetMarketsTab');
  assert.ok(catalog);assert.equal(catalog.payload.variables.marketTabID,'all');
  const tabSub=CatalogSocket.last.sent.find(x=>x.payload?.operationName==='OnUpdateTab');
  assert.ok(tabSub);assert.equal(tabSub.payload.variables.marketTabId,'all');
  const eventSub=CatalogSocket.last.sent.filter(x=>x.payload?.operationName==='OnUpdateSportEvent').at(-1);
  assert.ok(eventSub);assert.equal(eventSub.payload.variables.isTopMarkets,false);assert.equal(eventSub.payload.variables.marketIds.length,15);
  assert.ok(CatalogSocket.last.sent.some(x=>x.type==='stop'&&x.id===light.id),'the light stream is replaced, not doubled');
  assert.equal(state.rows[0].odds.markets.length,15);
  collector.requestSnapshot();await wait(20);
  assert.equal(state.rows[0].odds.markets.length,15,'top-3 snapshot must not overwrite complete markets');
  const nextIds=[...full.markets.map(m=>m.id),'extra-16'];
  CatalogSocket.last.message({id:tabSub.id,type:'data',payload:{data:{onUpdateTab:{sportEvent:{id:full.id},marketIds:nextIds}}}});
  await wait(5);
  const eventSubs=CatalogSocket.last.sent.filter(x=>x.payload?.operationName==='OnUpdateSportEvent');
  assert.equal(eventSubs.at(-1).payload.variables.marketIds.length,16);
  assert.ok(collector.status().marketCatalogUpdates>=1);assert.equal(collector.status().fullMarketEvents,1);
  await collector.stop();
});

test('relay bootstrap is preferred, reads credentials from files and never exposes secrets',async()=>{
  const {config}=await import('../src/config.js');
  const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ggbet-relay-test-'));
  const secretPath=path.join(dir,'secret'),caPath=path.join(dir,'ca.pem');
  const secret='s'.repeat(64),ca='-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n';
  fs.writeFileSync(secretPath,secret);fs.writeFileSync(caPath,ca);
  const old={url:config.ggbetBootstrapRelayUrl,secret:config.ggbetBootstrapRelaySecretFile,ca:config.ggbetBootstrapRelayCaFile};
  config.ggbetBootstrapRelayUrl='https://relay.test.invalid:8787/v1/ggbet/bootstrap';config.ggbetBootstrapRelaySecretFile=secretPath;config.ggbetBootstrapRelayCaFile=caPath;
  let directFetches=0,relayCalls=0;
  const token='p'.repeat(389),state={async success(){},async failure(){}};
  const collector=new GgbetLiveCollector(state,{fetchImpl:async()=>{directFetches++;throw Error('direct bootstrap must not run');},WebSocketImpl:FakeSocket,relayRequestImpl:async(url,options)=>{relayCalls++;assert.equal(url,config.ggbetBootstrapRelayUrl);assert.equal(options.secret,secret);assert.equal(options.ca,ca);return{ok:true,token,wsUrl:'wss://gg-b-gql.gg.bet/graphql',origin:'https://gg.bet'};}});
  try{
    const boot=await collector.fetchBootstrap(true);assert.equal(boot.source,'relay');assert.equal(boot.wsUrl,'wss://gg-b-gql.gg.bet/graphql');assert.equal(directFetches,0);assert.equal(relayCalls,1);
    const status=collector.status();assert.equal(status.bootstrapMode,'relay');assert.equal(status.relayConfigured,true);assert.equal(status.relayFetches,1);assert.equal(status.relayFailures,0);assert.equal(JSON.stringify(status).includes(secret),false);assert.equal(JSON.stringify(status).includes(token),false);
  }finally{config.ggbetBootstrapRelayUrl=old.url;config.ggbetBootstrapRelaySecretFile=old.secret;config.ggbetBootstrapRelayCaFile=old.ca;fs.rmSync(dir,{recursive:true,force:true});await collector.stop();}
});

test('relay bootstrap failure is isolated and counted without falling back through blocked local mirrors',async()=>{
  const {config}=await import('../src/config.js');const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ggbet-relay-fail-'));const secretPath=path.join(dir,'secret'),caPath=path.join(dir,'ca.pem');fs.writeFileSync(secretPath,'x'.repeat(64));fs.writeFileSync(caPath,'-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
  const old={url:config.ggbetBootstrapRelayUrl,secret:config.ggbetBootstrapRelaySecretFile,ca:config.ggbetBootstrapRelayCaFile};config.ggbetBootstrapRelayUrl='https://relay.test.invalid:8787/v1/ggbet/bootstrap';config.ggbetBootstrapRelaySecretFile=secretPath;config.ggbetBootstrapRelayCaFile=caPath;
  let directFetches=0;const collector=new GgbetLiveCollector({async success(){},async failure(){}},{fetchImpl:async()=>{directFetches++;return{ok:false,status:403,text:async()=>''};},relayRequestImpl:async()=>{throw Error('relay offline');}});
  try{await assert.rejects(()=>collector.fetchBootstrap(true),/relay offline/);assert.equal(directFetches,0);assert.equal(collector.status().relayFailures,1);assert.match(collector.status().lastRelayError,/relay offline/);}finally{config.ggbetBootstrapRelayUrl=old.url;config.ggbetBootstrapRelaySecretFile=old.secret;config.ggbetBootstrapRelayCaFile=old.ca;fs.rmSync(dir,{recursive:true,force:true});await collector.stop();}
});

test('connection_init rejection invalidates cached relay token so the next reconnect asks for a fresh one',async()=>{
  const {config}=await import('../src/config.js');const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ggbet-init-reject-'));const secretPath=path.join(dir,'secret'),caPath=path.join(dir,'ca.pem');fs.writeFileSync(secretPath,'y'.repeat(64));fs.writeFileSync(caPath,'-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
  const old={url:config.ggbetBootstrapRelayUrl,secret:config.ggbetBootstrapRelaySecretFile,ca:config.ggbetBootstrapRelayCaFile};config.ggbetBootstrapRelayUrl='https://relay.test.invalid:8787/v1/ggbet/bootstrap';config.ggbetBootstrapRelaySecretFile=secretPath;config.ggbetBootstrapRelayCaFile=caPath;
  class RejectSocket extends FakeSocket{send(body){const msg=JSON.parse(body);this.sent.push(msg);if(msg.type==='connection_init')queueMicrotask(()=>{this.message({type:'connection_error',payload:{message:'hook failed: Unexpected response code: 400'}});});}}
  let relayCalls=0;const collector=new GgbetLiveCollector({async success(){},async failure(){}},{WebSocketImpl:RejectSocket,relayRequestImpl:async()=>{relayCalls++;return{token:'z'.repeat(389),wsUrl:'wss://gg-b-gql.gg.bet/graphql',origin:'https://gg.bet'};}});collector.stopped=false;
  try{await assert.rejects(()=>collector.connect(),/connection_init rejected/);assert.equal(relayCalls,1);assert.equal(collector.bootstrap,null);assert.ok(collector.status().authRefreshes>=1);}finally{config.ggbetBootstrapRelayUrl=old.url;config.ggbetBootstrapRelaySecretFile=old.secret;config.ggbetBootstrapRelayCaFile=old.ca;fs.rmSync(dir,{recursive:true,force:true});await collector.stop();}
});

test('GGBET Polish market locale is normalized to Russian without changing stable keys',()=>{
  const row=dota();
  row.markets=[
    {id:'1',name:'Zwycięzca',status:'ACTIVE',typeId:1,tags:[],specifiers:[],meta:[],odds:[
      {id:'1',name:'Moonlight Wispers',value:'2.60',isActive:true,status:'NOT_RESULTED',competitorIds:['gin:home']},
      {id:'2',name:'Project Achilles',value:'1.46',isActive:true,status:'NOT_RESULTED',competitorIds:['gin:away']}
    ]},
    {id:'17h1_5',name:'Mapa handicap',status:'ACTIVE',typeId:17,tags:['hcp'],specifiers:[{name:'hcp',value:'1.5'}],meta:[],odds:[
      {id:'1',name:'Moonlight Wispers (+1.5)',value:'1.83',isActive:true,status:'NOT_RESULTED',competitorIds:['gin:home']},
      {id:'2',name:'Project Achilles (-1.5)',value:'1.91',isActive:true,status:'NOT_RESULTED',competitorIds:['gin:away']}
    ]},
    {id:'14t2_5',name:'Suma map',status:'ACTIVE',typeId:14,tags:['total'],specifiers:[{name:'total',value:'2.5'}],meta:[],odds:[
      {id:'1',name:'Powyżej 2.5',value:'2.17',isActive:true,status:'NOT_RESULTED',competitorIds:[]},
      {id:'2',name:'Poniżej 2.5',value:'1.64',isActive:true,status:'NOT_RESULTED',competitorIds:[]}
    ]}
  ];
  const event=parseGgbetLiveEvent(row,{at:123});
  assert.deepEqual(event.odds.markets.map(m=>[m.key,m.type,m.title]),[
    ['ggbet:1','moneyline','Победитель'],
    ['ggbet:17h1_5','map-handicap','Фора по картам'],
    ['ggbet:14t2_5','map-total','Тотал карт']
  ]);
  assert.deepEqual(event.odds.markets[2].prices.map(p=>[p.designation,p.label]),[['over','Больше 2.5'],['under','Меньше 2.5']]);
});

test('GGBET Polish round totals keep map period and Russian labels',()=>{
  const row=dota();
  row.markets=[{id:'300m2t19_5',name:'2nd mapa - suma rund',status:'ACTIVE',typeId:300,tags:['total'],specifiers:[{name:'mapnr',value:'2'},{name:'total',value:'19.5'}],meta:[],odds:[
    {id:'1',name:'Powyżej 19.5',value:'1.77',isActive:true,status:'NOT_RESULTED',competitorIds:[]},
    {id:'2',name:'Poniżej 19.5',value:'1.99',isActive:true,status:'NOT_RESULTED',competitorIds:[]}
  ]}];
  const market=parseGgbetLiveEvent(row,{at:123}).odds.markets[0];
  assert.equal(market.type,'total');
  assert.equal(market.period,2);
  assert.equal(market.title,'Карта 2 — тотал раундов');
  assert.deepEqual(market.prices.map(p=>p.designation),['over','under']);
});

test('stored Polish GGBET odds history is normalized on read',async()=>{
  const {normalizeGgbetStoredMarket}=await import('../src/odds-log.js');
  const old=normalizeGgbetStoredMarket({title:'Suma map',period:0,prices:[{side:'home',odds:2.1},{side:'away',odds:1.7}]});
  assert.equal(old.title,'Тотал карт');
  assert.deepEqual(old.prices.map(p=>p.side),['over','under']);
  assert.equal(normalizeGgbetStoredMarket({title:'Handicap rund',period:0,prices:[]}).title,'Фора по раундам');
});

test('relay bootstrap in the real relay response shape is used as-is; a mirror origin is rejected with the origin named',async()=>{
  const {config}=await import('../src/config.js');const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ggbet-relay-shape-'));const secretPath=path.join(dir,'secret'),caPath=path.join(dir,'ca.pem');fs.writeFileSync(secretPath,'x'.repeat(64));fs.writeFileSync(caPath,'-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
  const old={url:config.ggbetBootstrapRelayUrl,secret:config.ggbetBootstrapRelaySecretFile,ca:config.ggbetBootstrapRelayCaFile};config.ggbetBootstrapRelayUrl='https://relay.invalid/v1/ggbet/bootstrap';config.ggbetBootstrapRelaySecretFile=secretPath;config.ggbetBootstrapRelayCaFile=caPath;
  const token='t'.repeat(389);let payload={ok:true,token,wsUrl:'wss://gg-b-gql.gg.bet/graphql',origin:'https://gg.bet',sourceOrigin:'https://gg.bet',issuedAt:1790854381697};
  const collector=new GgbetLiveCollector({async success(){},async failure(){}},{fetchImpl:async()=>{throw Error('direct bootstrap must not run');},relayRequestImpl:async()=>payload});
  try{
    const boot=await collector.fetchBootstrap(true);assert.equal(boot.token,token);assert.equal(boot.wsUrl,'wss://gg-b-gql.gg.bet/graphql');assert.equal(boot.origin,'https://gg.bet');
    payload={ok:true,token,wsUrl:'wss://gg-b-gql.gg.bet/graphql',sourceOrigin:'https://gg.bet'};assert.equal((await collector.fetchBootstrap(true)).origin,'https://gg.bet','sourceOrigin is used when origin is absent');
    payload={ok:true,token,wsUrl:'wss://gg-b-gql.gg.bet/graphql',origin:'https://gg397.bet'};await assert.rejects(()=>collector.fetchBootstrap(true),/неожиданный origin \(https:\/\/gg397\.bet\)/);
  }finally{config.ggbetBootstrapRelayUrl=old.url;config.ggbetBootstrapRelaySecretFile=old.secret;config.ggbetBootstrapRelayCaFile=old.ca;fs.rmSync(dir,{recursive:true,force:true});await collector.stop();}
});
