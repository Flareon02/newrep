import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {OddsLog} from '../src/odds-log.js';
import {CrossbetService} from '../src/crossbet.js';
import {config} from '../src/config.js';

test('bookmaker prices persist across restart and only changes are stored',async()=>{
 const prior=config.dataDir,temp=await mkdtemp(join(fileURLToPath(new URL('.',import.meta.url)),'book-odds-'));config.dataDir=temp;
 try{const ref={source:'astek',id:'9001',odds:{updatedAt:Date.now(),markets:[{period:0,title:'Победитель',status:'open',prices:[{designation:'home',decimal:1.8},{designation:'away',decimal:2.05}]}]}};
  const log=new OddsLog();await log.record(ref);await log.record(ref);
  const changed=structuredClone(ref);changed.odds.updatedAt+=1000;changed.odds.markets[0].prices[0].decimal=1.9;await log.record(changed);
  const saved=await new OddsLog().get('astek','9001');assert.equal(saved.entries.length,2);assert.equal(saved.entries[0].changes[0].prices[0].odds,1.9);
 }finally{config.dataDir=prior;await rm(temp,{recursive:true,force:true});}
});

test('new append-only odds journal remains compatible with legacy JSON history',async()=>{
 const prior=config.dataDir,temp=await mkdtemp(join(fileURLToPath(new URL('.',import.meta.url)),'book-odds-legacy-'));config.dataDir=temp;
 try{
  const {mkdir,writeFile}=await import('node:fs/promises');await mkdir(join(temp,'odds','ggbet'),{recursive:true});
  const legacy={entries:[{at:1000,changes:[{key:'0|moneyline|moneyline|away@|home@',period:0,title:'Zwycięzca',status:'open',prices:[{side:'home',points:null,odds:1.8}]}],team1:'A',team2:'B'}],last:{},team1:'A',team2:'B',scoreText:''};
  await writeFile(join(temp,'odds','ggbet','x.json'),JSON.stringify(legacy));
  const log=new OddsLog();await log.record({source:'ggbet',id:'x',team1:'A',team2:'B',odds:{updatedAt:2000,team1:'A',team2:'B',markets:[{type:'moneyline',period:0,title:'Победитель',status:'open',prices:[{designation:'home',decimal:1.9},{designation:'away',decimal:2.1}]}]}});
  const page=await log.get('ggbet','x',{limit:10});assert.equal(page.entries.length,2);assert.equal(page.entries[0].at,2000);assert.equal(page.entries[1].at,1000);
  const timeline=await log.timeline(['ggbet:x']);assert.deepEqual(timeline.times,[1000,2000]);assert.equal(timeline.books[0].markets.length,1);
 }finally{config.dataDir=prior;await rm(temp,{recursive:true,force:true});}
});

test('CS2 scoreboard keeps its own socket and fetches its match page once',async()=>{
 const oldWebSocket=globalThis.WebSocket,oldFetch=globalThis.fetch;let calls=0,ws;const now=Date.now();
 class Socket{readyState=1;listeners={};sent=[];constructor(){ws=this;}addEventListener(k,fn){this.listeners[k]=fn;}send(packet){this.sent.push(packet);}close(){this.readyState=3;this.listeners.close?.();}}
 try{globalThis.WebSocket=Socket;globalThis.fetch=async()=>{calls++;return{ok:true,text:async()=>`var match = ${JSON.stringify({matchId:'00001706601',event:'League',teams:[{name:'Infinite'},{name:'Fluxo W7M'}],streams:[{name:'Live',url:'https://player.twitch.tv/?channel=leonbet_en&parent=cross.bet'}],mapNum:1,map:'Nuke',mapScore_home:0,mapScore_away:0,roundScore_home:1,roundScore_away:0,scoreboard:{currentRound:2,roundTime:'1:20',timeline:{r1:{team:'1',side:'t',type:'eliminated'}},teamStats:{home:{name:'Infinite',side:'t',members:{volt:{name:'volt',alive:true,k:2,a:1,d:1}}},away:{name:'Fluxo W7M',side:'ct',members:{nqz:{name:'nqz',alive:true,k:1,a:0,d:2}}}}}})};`};};
  const service=new CrossbetService();service.connect();ws.listeners.message({data:'40'});ws.listeners.message({data:'42'+JSON.stringify(['setMatches',{live:[{game:'csgo',matchId:'00001706601',event:'League',startAt:new Date(now).toISOString(),teams:[{name:'Infinite'},{name:'Fluxo W7M'}]}]}])});
  const a=await service.get({team1:'Fluxo W7M',team2:'Infinite',startAt:now,league:'League'});ws.listeners.message({data:'40'});assert.equal(a.matched,true);assert.equal(a.streamLinks[0].url,'https://www.twitch.tv/leonbet_en');
  ws.listeners.message({data:'42'+JSON.stringify(['scoreUpdate',{roundScore_home:8,roundScore_away:7}])});
  ws.listeners.message({data:'42'+JSON.stringify(['scoreboardUpdate',{currentRound:2,roundTime:'0:56',timerRunning:true,bomb:'planted',timeline:{r2:{team:'2',side:'ct',type:'defused'}},teamStats:{home:{name:'Infinite',side:'t',members:{volt:{name:'volt',alive:false,k:2,a:1,d:2}}},away:{name:'Fluxo W7M',side:'ct',members:{nqz:{name:'nqz',alive:true,k:2,a:0,d:2}}}}}])});
  ws.listeners.message({data:'42'+JSON.stringify(['setScoreboard',{currentRound:3,roundTime:'1:40',timerRunning:true,bomb:'',teamStats:{home:{name:'Infinite',side:'t',members:{volt:{name:'volt',alive:true,k:2,a:1,d:2}}},away:{name:'Fluxo W7M',side:'ct',members:{nqz:{name:'nqz',alive:true,k:2,a:0,d:2}}}}}])});
  // Real Cross.bet scoreboardUpdate frames can contain teamStats while omitting
  // player identity and unchanged K/A/D fields. They are deltas, not a full roster.
  ws.listeners.message({data:'42'+JSON.stringify(['scoreboardUpdate',{currentRound:3,roundTime:'1:32',teamStats:{home:{members:{volt:{alive:false,d:3}}},away:{members:{nqz:{k:3}}}}}])});
  let b=await service.get({team1:'Infinite',team2:'Fluxo W7M',startAt:now,league:'League'});assert.deepEqual(b.roundScore,[8,7]);assert.equal(b.currentRound,3);assert.equal(b.timeline.length,2);assert.equal(b.timeline[0].number,1);assert.equal(b.timeline[1].number,2);assert.ok(b.eventLog.some(e=>e.type==='death'&&e.player==='volt'));
  let roster=b.players.flatMap(t=>t.members||[]),volt=roster.find(p=>p.name==='volt'),nqz=roster.find(p=>p.name==='nqz');assert.ok(volt);assert.ok(nqz);assert.deepEqual({k:volt.k,a:volt.a,d:volt.d,alive:volt.alive},{k:2,a:1,d:3,alive:false});assert.deepEqual({k:nqz.k,a:nqz.a,d:nqz.d,alive:nqz.alive},{k:3,a:0,d:2,alive:true});
  // Same-map matchInfo can also carry a compact scoreboard and must not wipe
  // the previously learned roster before the next full frame arrives.
  ws.listeners.message({data:'42'+JSON.stringify(['matchInfo',{matchId:'00001706601',mapNum:1,scoreboard:{currentRound:3,roundTime:'1:28',teamStats:{home:{members:{volt:{alive:true}}}}}}])});
  b=await service.get({team1:'Infinite',team2:'Fluxo W7M',startAt:now,league:'League'});roster=b.players.flatMap(t=>t.members||[]);volt=roster.find(p=>p.name==='volt');nqz=roster.find(p=>p.name==='nqz');assert.ok(volt);assert.ok(nqz);assert.equal(volt.alive,true);assert.equal(volt.k,2);assert.equal(nqz.k,3);
  ws.listeners.message({data:'42'+JSON.stringify(['setScoreboard',{currentRound:3,roundTime:'1:25',timerRunning:true,bomb:''}])});
  b=await service.get({team1:'Infinite',team2:'Fluxo W7M',startAt:now,league:'League'});assert.equal(b.players.flatMap(t=>t.members||[]).some(p=>p.name==='volt'),true);assert.equal(b.timeline.length,2);
  ws.listeners.message({data:'42'+JSON.stringify(['matchInfo',{matchId:'00001706601',mapNum:2,map:'Inferno',mapScore_home:1,mapScore_away:0,roundScore_home:0,roundScore_away:0,scoreboard:{currentRound:1,roundTime:'1:55',timerRunning:true,timeline:[],teamStats:{home:{name:'Infinite',side:'ct',members:{}},away:{name:'Fluxo W7M',side:'t',members:{}}}}}])});
  b=await service.get({team1:'Infinite',team2:'Fluxo W7M',startAt:now,league:'League'});const oldMap=b.maps.find(m=>m.mapNum===1);assert.ok(oldMap);assert.equal(oldMap.timeline.length,2);assert.ok(oldMap.eventLog.some(e=>e.type==='death'&&e.player==='volt'));assert.equal(b.mapNum,2);assert.equal(b.players.flatMap(t=>t.members||[]).some(p=>p.name==='volt'||p.name==='nqz'),false);assert.equal(service.status().packetErrors,0);assert.equal(calls,1);assert.equal(ws.sent.filter(x=>x.startsWith('42["getMatch"')).length,1);service.stop();
 }finally{globalThis.WebSocket=oldWebSocket;globalThis.fetch=oldFetch;}
});
