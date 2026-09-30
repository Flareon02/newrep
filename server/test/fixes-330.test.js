import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {PrematchCollector} from '../src/prematch.js';
import {fetchJson} from '../src/utils.js';
import {LeagueStore} from '../src/league-store.js';
import {freshenResolvedEvents,feedMetaSnapshot} from '../src/api.js';
import {matcherLane} from '../src/matcher-client.js';

test('Astek bulk line falls back only for leagues missing from aggregate response',async()=>{
  const cats={Success:true,Value:[
    {SI:40,LI:11,L:'Counter Strike 2. A',GC:1},
    {SI:40,LI:22,L:'Counter Strike 2. B',GC:1}
  ]};
  const game=(id,league)=>({I:id,LI:league,LE:'CS 2. League',O1E:'Alpha '+league,O2E:'Beta '+league,S:Date.now()/1000});
  const calls=[];
  const state={events:[],success:async function(events){this.events=events;},failure:async function(error){throw error;}};
  const request=async url=>{
    calls.push(url);
    if(url.includes('GetChampsZip'))return {payload:cats,status:200};
    const u=new URL(url),champ=u.searchParams.get('champs');
    if(!champ)return {payload:{Success:true,Value:[game(101,11)]},status:200};
    assert.equal(champ,'22');
    return {payload:{Success:true,Value:[game(202,22)]},status:200};
  };
  const collector=new PrematchCollector(state,{request,sleep:async()=>{},persist:async()=>{}});
  await collector.poll();
  assert.equal(calls.length,3);
  assert.equal(new URL(calls[1]).searchParams.has('champs'),false);
  assert.equal(new URL(calls[2]).searchParams.get('champs'),'22');
  assert.equal(collector.batchSupported,true);
  assert.equal(collector.bulkFallbackLeagues,1);
  assert.deepEqual(new Set(state.events.map(e=>e.leagueId)),new Set(['11','22']));
});

test('upstream fetch aborts oversized bodies before JSON parsing',async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({Success:true,padding:'x'.repeat(8192)}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/payload`;
    await assert.rejects(fetchJson(url,url,{maxBytes:1024,timeoutMs:3000}),/слишком большой|превышает лимит/i);
  }finally{await new Promise(resolve=>server.close(resolve));}
});


test('league publication requires a one-time challenge bound to the client address',async()=>{
  const store=new LeagueStore({read:async()=>null,write:async()=>{}}),address='127.0.0.1';
  const changes={upsert:[],remove:[]};
  await assert.rejects(Promise.resolve().then(()=>store.publish({baseRevision:0,changes},address)),error=>error.status===403);
  const challenge=store.challenge(address);
  const result=await store.publish({nonce:challenge.nonce,baseRevision:0,changes},address);
  assert.equal(result.revision,0);
  await assert.rejects(Promise.resolve().then(()=>store.publish({nonce:challenge.nonce,baseRevision:0,changes},address)),error=>error.status===403);
});


test('Astek aggregate line reuses complete leagues even when the global 50-row window is truncated',async()=>{
  const cats={Success:true,Value:[{SI:40,LI:11,L:'Counter Strike 2. A',GC:1},{SI:40,LI:22,L:'Counter Strike 2. B',GC:60}]};
  const calls=[];
  const make=(id,league)=>({I:id,LI:league,LE:'CS 2. League',O1E:'Alpha '+league,O2E:'Beta '+league,S:Date.now()/1000});
  const state={events:[],success:async function(events){this.events=events;},failure:async function(error){throw error;}};
  const request=async url=>{
    calls.push(url);
    if(url.includes('GetChampsZip'))return {payload:cats,status:200};
    const u=new URL(url),champ=u.searchParams.get('champs');
    if(!champ){assert.equal(Number(u.searchParams.get('count')),50);return {payload:{Success:true,Value:[make(1001,11),...Array.from({length:49},(_,i)=>make(2000+i,22))]},status:200};}
    assert.equal(champ,'22');
    return {payload:{Success:true,Value:Array.from({length:60},(_,i)=>make(3000+i,22))},status:200};
  };
  const collector=new PrematchCollector(state,{request,sleep:async()=>{},persist:async()=>{}});
  await collector.poll();
  assert.equal(collector.batchSupported,true);
  assert.equal(calls.filter(url=>new URL(url).searchParams.get('champs')).length,1);
  assert.equal(collector.bulkFallbackLeagues,1);
  assert.deepEqual(new Set(state.events.map(e=>e.leagueId)),new Set(['11','22']));
});


test('LIVE and prematch matching use independent worker lanes',()=>{
  assert.equal(matcherLane('resolve',{mode:'live'}),'feeds-live');
  assert.equal(matcherLane('resolve',{mode:'prematch'}),'feeds-prematch');
  assert.notEqual(matcherLane('resolve',{mode:'live'}),matcherLane('resolve',{mode:'prematch'}));
});


test('resolved LIVE identities receive current provider score without waiting for another matcher pass',()=>{
  const cached=[{id:'logical',team1:'Alpha',team2:'Beta',sourceRefs:[{source:'astek',sourceEventId:'101',team1:'Alpha',team2:'Beta',scoreText:'0:0',seriesScore:[0,0],firstSeenAt:1,enteredLiveAt:1}]}];
  const state={events:[{source:'astek',id:'101',team1:'Alpha',team2:'Beta',scoreText:'1:0',seriesScore:[1,0],lastSeenAt:2000}]};
  const [row]=freshenResolvedEvents(cached,[['astek',state]]);
  assert.equal(row.sourceRefs[0].scoreText,'1:0');
  assert.deepEqual(row.sourceRefs[0].seriesScore,[1,0]);
  assert.equal(row.sourceRefs[0].firstSeenAt,1);
});


test('feed metadata is cheap and does not expose or enumerate event payloads',()=>{
  const state=(revision,stale=false)=>({revision,lastSuccessfulUpdateAt:1000,status:()=>({revision,stale,updating:false,count:3}),get events(){throw new Error('meta must not touch events');}});
  const meta=feedMetaSnapshot('live',state(1),state(2),state(3));
  assert.match(meta.revision,/^1-2-3-/);
  assert.equal(meta.stale,false);
  assert.equal('events' in meta,false);
  assert.equal('events' in meta.providers.astek,false);
});
