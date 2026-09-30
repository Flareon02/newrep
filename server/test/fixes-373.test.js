import test from 'node:test';
import assert from 'node:assert/strict';
import {liveStatisticsLeagueSimilarity,liveStatisticsMatchScore} from '../src/entity-resolver.js';
import {HawkService} from '../src/hawk.js';
import {CrossbetService} from '../src/crossbet.js';

const T=Date.UTC(2026,8,29,8,0);

test('3.7.3 LIVE statistics ignores time and accepts both teams + league at the 50 percent floor',()=>{
 const hit=liveStatisticsMatchScore('Wiser Warriors','LSG','Wiser Warriors','LSG','Destiny League','Destiny League 2026 Season 52','Dota 2');
 assert.ok(hit);assert.equal(hit.exactPair,true);assert.ok(hit.leagueScore>=.5);
 const swapped=liveStatisticsMatchScore('Kinetix','Xipto Esports','Xipto Esports','Team Kinetix','EPL World Series Southeast Asia','EPL World Series: Southeast Asia Season 18','Dota 2');
 assert.ok(swapped);assert.equal(swapped.swapped,true);assert.ok(swapped.teamMin>=.5);assert.ok(swapped.leagueScore>=.5);
 const badTeam=liveStatisticsMatchScore('Wiser Warriors','Completely Different','Wiser Warriors','LSG','Destiny League','Destiny League 2026 Season 52','Dota 2');
 assert.equal(badTeam,null);
 const badLeague=liveStatisticsMatchScore('Wiser Warriors','LSG','Wiser Warriors','LSG','Destiny League','Totally Unrelated Championship','Dota 2');
 assert.equal(badLeague,null);
});

test('3.7.3 statistics league normalization handles season suffixes, game words and D2SL acronym',()=>{
 assert.ok(liveStatisticsLeagueSimilarity('Space Dota 2 League','Dota 2 Space League 2026 Season 74','Dota 2')>=.5);
 assert.ok(liveStatisticsLeagueSimilarity('Dota 2. D2SL','Dota 2 Space League 2026 Season 74','Dota 2')>=.5);
 assert.ok(liveStatisticsLeagueSimilarity('EPL World Series Southeast Asia','EPL World Series: Southeast Asia Season 18','Dota 2')>=.5);
});

test('3.7.3 Dota live match succeeds even when statistics scheduled time differs by many hours',async()=>{
 const svc=new HawkService();
 const series={id:101111,slug:'wiser-warriors-v-lsg',startAt:new Date(T-8*3600000).toISOString(),bestOf:3,
   team1:{name:'Wiser Warriors'},team2:{name:'LSG'},championship:{name:'Destiny League 2026 Season 52',slug:'destiny-league-2026-season-52'},matches:[],streams:[]};
 svc.catalog=[series];svc.indexAt=Date.now();svc.page=async()=>({seriesPageData:series});
 const hit=await svc.get({team1:'Wiser Warriors',team2:'LSG',league:'Destiny League',category:'Dota 2',startAt:T+9*3600000});
 assert.equal(hit.matched,true);assert.equal(hit.event.id,101111);assert.equal(hit.matchQuality,'exact-pair');svc.close();
});

test('3.7.3 CS2 live statistics uses the same 50 percent team/league rule and ignores time',async()=>{
 const svc=new CrossbetService(),id='12345678',row={matchId:id,game:'csgo',event:'United21 Season 30',startAt:new Date(T-12*3600000).toISOString(),teams:[{name:'Wraith PCIFIC'},{name:'STATE'}]};
 svc.list=[row];svc.listAt=Date.now();svc.catalog={ready:true,ws:null,retryAt:Infinity,lastPacket:Date.now()};
 svc.details.set(id,{...row,pageAttempted:true,savedMaps:{},roundHistory:{},eventHistory:{},liveState:{},scoreboard:{},mapNum:1,updatedAt:Date.now(),clockAt:Date.now()});
 svc.channels.set(id,{id,ready:true,ws:null,retryAt:Infinity,lastPacket:Date.now()});
 const hit=await svc.get({team1:'PCIFIC',team2:'State',league:'United21',category:'Counter Strike 2',startAt:T+12*3600000});
 assert.equal(hit.matched,true);assert.equal(hit.id,id);svc.stop();
});
