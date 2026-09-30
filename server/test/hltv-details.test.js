import test from 'node:test';
import assert from 'node:assert/strict';
import H from '../src/hltv-data.cjs';
import {safeDataset,HltvService} from '../src/hltv-service.js';
const now=Date.parse('2026-09-24T12:00:00Z'),DAY=86400100;
const source='https://www.hltv.org/stats/players/123/test';
const recent={at:now-1000,source,startDate:'2026-06-24',endDate:'2026-09-24',period:'date range',rating:1.12,ratingVersion:'3.0',kpr:.7};
const career={at:now-2000,source,period:'all time',rounds:10000,maps:500,kpr:.8,headshots:.6};
const maps=Array.from({length:30},(_,i)=>({id:i+1,at:now-(i+1)*DAY,observedAt:now-5000,teamId:1,opponentId:2,map:'Inferno',scoreA:13,scoreB:7,rounds:20,kills:i%2?12:18,deaths:13,source:source.replace('/players/','/players/matches/')}));
test('recent rating cannot borrow exposure from career/tenure snapshots',()=>{
 const p=H.merge({players:[{id:123,at:now-1000,statSnapshots:[career,recent]}]},{players:[{id:123,at:now,name:'Test',rating:1.5,maps:700,rounds:15000}]}).players[0];
 const d=H.derivePlayer(p,now);assert.equal(d.rating,1.12);assert.equal(d.ratingMaps,null);assert.equal(d.kpr,.8);assert.equal(d.rounds,10000);assert.equal(d.statsPeriod,'all time');
 const noCareer=H.derivePlayer({...p,statSnapshots:[recent]},now);assert.equal(noCareer.rounds,null);assert.equal(noCareer.kpr,.7);
});
test('map observations deduplicate by ID, exclude future/old maps and determine exposure',()=>{
 const p={id:123,name:'Test',at:now,statSnapshots:[career,recent],mapHistory:[...maps,{...maps[0],id:90,at:now+DAY},{...maps[1],id:91,at:now-181*DAY}]};
 const merged=H.merge({players:[p]},{players:[{...p,mapHistory:maps}]}).players[0];assert.equal(merged.mapHistory.length,32);
 const d=H.derivePlayer(merged,now);assert.equal(d.observedMaps,30);assert.equal(d.rounds,600);assert.equal(d.kpr,.75);assert.equal(d.dpr,.65);assert.equal(d.ratingMaps,30);assert.equal(d.dispersionMaps,30);assert.ok(d.killDispersion>20);assert.equal(d.headshotPeriod,'all time');
 assert.equal(H.derivePlayer(merged,now).killDispersion,d.killDispersion);
});
test('official exposure for a recent unrestricted window takes priority over partial map logs',()=>{
 const d=H.derivePlayer({id:123,statSnapshots:[{...recent,rounds:3000,kpr:.71,maps:140}],mapHistory:maps},now);assert.equal(d.rounds,3000);assert.equal(d.kpr,.71);assert.equal(d.statsPeriod,'date range');
 const restricted=H.derivePlayer({id:123,statSnapshots:[{...recent,rounds:3000,kpr:.95,filters:{rankingFilter:'Top5'}}],mapHistory:maps},now);assert.equal(restricted.kpr,.75);
});
test('server whitelist keeps observations but discards supplied weights and private URL query fields',()=>{
 const d=safeDataset({players:[{id:123,name:'Test',at:now,killDispersion:999,statSnapshots:[{...recent,source:source+'?token=secret&startDate=2026-06-24',headers:{Cookie:'secret'}}],mapHistory:maps}]},now);
 assert.equal(d.players[0].mapHistory.length,30);assert.equal(d.players[0].killDispersion,undefined);assert.ok(!JSON.stringify(d).includes('secret'));assert.equal(d.players[0].statSnapshots[0].rating,1.12);
});
test('imported sporting data are persisted on server and survive restart',async()=>{
 let saved={};const storage={read:async()=>saved,write:async(path,data)=>{if(path==='hltv/cache.json')saved=structuredClone(data);}};
 const service=new HltvService(storage);await service.ready;service.blockedUntil=Date.now()+DAY;
 const teams=[9565,6667].map(id=>({id}));await service.prepare({teams,data:{players:[{id:123,name:'Test',at:Date.now(),statSnapshots:[{...recent,at:Date.now()}],mapHistory:maps.map((r,i)=>({...r,at:Date.now()-(i+1)*DAY,observedAt:Date.now()}))}]}});
 assert.ok(saved.players.find(p=>p.id===123)?.statSnapshots?.length);
 const restarted=new HltvService(storage);await restarted.ready;assert.ok(restarted.data.players.find(p=>p.id===123)?.mapHistory?.length);
});
