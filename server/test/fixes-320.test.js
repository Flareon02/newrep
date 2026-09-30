import test from 'node:test';
import assert from 'node:assert/strict';
import {astekOdds,fonbetOdds} from '../src/book-odds.js';
import {mergeFonbetPayload,fonbetDeltaUrl} from '../src/fonbet.js';

test('Astek GetGameZip uses GS semantic id for Dota market names, not unrelated G caption',()=>{
  const raw={I:100,SSN:'Dota 2',O1E:'Alpha',O2E:'Beta',GE:[
    {G:2436,GS:752,E:[{G:2436,T:2824,P:2.5,C:1.8},{G:2436,T:2825,P:2.5,C:2.0}]},
    {G:2687,GS:890,E:[{G:2687,T:3459,C:1.9},{G:2687,T:3460,C:1.9}]}
  ]};
  const odds=astekOdds(raw,[],'live',{category:'Dota 2'});
  const total=odds.markets.find(m=>m.semanticGroup===752),parity=odds.markets.find(m=>m.semanticGroup===890);
  assert.equal(total?.title,'Тотал по картам');
  assert.equal(total?.type,'map-total');
  assert.equal(parity?.title,'Фраги, тотал чет/нечет');
  assert.doesNotMatch(total?.title||'',/нокдаун/i);
});

test('Fonbet unblocked does not suspend market and partial blocks only listed factor',()=>{
  const raw={id:1,team1:'A',team2:'B'};
  const base={events:[raw],customFactors:[{e:1,factors:[{f:921,v:1.5},{f:923,v:2.5}]}],eventBlocks:[{eventId:1,state:'unblocked'}]};
  const open=fonbetOdds(raw,base,'live');
  assert.deepEqual(open.markets[0].prices.map(p=>p.decimal),[1.5,2.5]);
  const partial=fonbetOdds(raw,{...base,eventBlocks:[{eventId:1,state:'partial',factors:[921]}]},'live');
  assert.deepEqual(partial.markets[0].prices.map(p=>p.decimal),[null,2.5]);
  assert.equal(partial.markets[0].status,'open');
});

test('Fonbet delta merge replaces changed entities and preserves untouched snapshot rows',()=>{
  const base={packetVersion:10,sports:[{id:1,name:'Esports'},{id:2,name:'Dota'}],events:[{id:100,place:'live',team1:'A'},{id:200,place:'line',team1:'C'}],customFactors:[{e:100,factors:[{f:921,v:2}]},{e:200,factors:[{f:921,v:3}]}],eventBlocks:[{eventId:100,state:'partial',factors:[921]}],eventMiscs:[{id:100,score1:0}],liveEventInfos:[{eventId:100,timer:'1:00'}]};
  const delta={packetVersion:11,fromVersion:10,sports:[{id:2,name:'Dota 2'}],events:[{id:100,place:'live',team1:'AA'}],customFactors:[{e:100,factors:[{f:921,v:1.8}]}],eventBlocks:[{eventId:100,state:'unblocked'}],eventMiscs:[{id:100,score1:1}],liveEventInfos:[{eventId:100,timer:'2:00'}]};
  const merged=mergeFonbetPayload(base,delta);
  assert.equal(merged.packetVersion,11);
  assert.equal(merged.events.length,2);
  assert.equal(merged.events.find(x=>x.id===100).team1,'AA');
  assert.equal(merged.events.find(x=>x.id===200).team1,'C');
  assert.equal(merged.sports.find(x=>x.id===2).name,'Dota 2');
  assert.equal(merged.customFactors.find(x=>x.e===100).factors[0].v,1.8);
  assert.equal(merged.eventBlocks.find(x=>x.eventId===100).state,'unblocked');
});

test('Fonbet delta URL preserves endpoint and advances version parameter',()=>{
  const url=new URL(fonbetDeltaUrl('https://example.test/ma/events/list?lang=ru&scopeMarket=1600',123));
  assert.equal(url.pathname,'/ma/events/list');assert.equal(url.searchParams.get('lang'),'en');assert.equal(url.searchParams.get('version'),'123');
});

test('JSON storage keeps previous generation and recovers from a damaged primary file',async()=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const {config}=await import('../src/config.js');const {writeJson,readJson}=await import('../src/utils.js');
  const old=config.dataDir,tmp=await fs.mkdtemp(path.join(os.tmpdir(),'astek-storage-'));
  try{
    config.dataDir=tmp;await writeJson('state.json',{generation:1});await writeJson('state.json',{generation:2});
    await fs.writeFile(path.join(tmp,'state.json'),'{broken','utf8');
    assert.deepEqual(await readJson('state.json',null),{generation:1});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(tmp,'state.json'),'utf8')),{generation:1});
  }finally{config.dataDir=old;await fs.rm(tmp,{recursive:true,force:true});}
});

test('Crossbet websocket error closes once and cannot recurse during network failure',async()=>{
 const original=globalThis.WebSocket;
 class FakeWebSocket{
  constructor(){this.readyState=1;this.handlers=new Map();this.closeCalls=0;}
  addEventListener(name,fn){if(!this.handlers.has(name))this.handlers.set(name,[]);this.handlers.get(name).push(fn);}
  send(){}
  close(){this.closeCalls++;for(const fn of this.handlers.get('error')||[])fn({type:'error'});}
  emit(name,value={}){for(const fn of this.handlers.get(name)||[])fn(value);}
 }
 globalThis.WebSocket=FakeWebSocket;
 try{
  const {CrossbetService}=await import('../src/crossbet.js');
  const service=new CrossbetService(),channel=service.openSocket('12345678'),socket=channel.ws;
  socket.emit('error');
  assert.equal(socket.closeCalls,1);
  assert.equal(channel.ws,null);
  service.stop();
 }finally{globalThis.WebSocket=original;}
});
