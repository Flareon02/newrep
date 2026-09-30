import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolveEvents,eventMatchScore} from '../src/entity-resolver.js';
import {HawkService} from '../src/hawk.js';
import {parseGgbetLiveEvent} from '../src/ggbet.js';

const T=Date.UTC(2026,8,29,8,0);
const base=(o={})=>({id:'a',sourceEventId:'a',source:'astek',provider:'AstekBet',category:'Counter Strike 2',league:'CS 2. United21',leagueId:'u21-a',team1:'Wraith PCIFIC',team2:'State',startAt:T,firstSeenAt:T-1000,lastSeenAt:T,marketKind:'main',...o});

test('3.7.1 real United21 spelling merges even when one provider exposes generic Esports category',()=>{
 const a=base();
 const f=base({id:'f',sourceEventId:'f',source:'fonbet',provider:'Fonbet',category:'Esports',league:'Counter-Strike. United21. Bo3',leagueId:'u21-f',team1:'PCIFIC',team2:'STATE'});
 const rows=resolveEvents([a,f],{mode:'prematch'});
 assert.equal(rows.length,1);
 assert.deepEqual(new Set(rows[0].sourceRefs.map(r=>r.source)),new Set(['astek','fonbet']));
});

test('Dota exact pair stays authoritative when statistics schedule is 28 minutes earlier and league has season suffix',async()=>{
 const svc=new HawkService();
 const series={id:100991,slug:'real-eclipse-v-silent-killer',startAt:'2026-09-28T23:00:00.000Z',bestOf:3,
   team1:{name:'Real Eclipse'},team2:{name:'Silent killer'},championship:{name:'Dota 2 Space League 2026 Season 74',slug:'dota-2-space-league-2026-season-74'},matches:[],streams:[]};
 svc.catalog=[series];svc.indexAt=Date.now();svc.page=async()=>({seriesPageData:series});
 const hit=await svc.get({team1:'Real Eclipse',team2:'Silent killer',league:'Space Dota 2 League',category:'Dota 2',startAt:Date.parse('2026-09-28T23:28:00.000Z')});
 assert.equal(hit.matched,true);
 assert.equal(hit.event.id,100991);
 assert.equal(hit.matchQuality,'exact-pair');
 svc.close();
});

function valorant(markets){return {
 id:'5:valorant-test',slug:'team-hamy-v-players',disabled:false,betStop:false,version:'1',meta:[{name:'bo',value:'1'}],
 fixture:{score:'0:0',title:'Team Hamy vs Players',status:'LIVE',type:'MATCH',startTime:'2026-09-29T02:00:00Z',sportId:'esports_valorant',sport:{id:'esports_valorant',name:'Valorant',tags:['ESPORT']},tournament:{id:'random',name:'Valorant Random Match',slug:'random',sportId:'esports_valorant'},competitors:[
   {id:'home',name:'Team Hamy',homeAway:'HOME',score:[{type:'total',points:'0',number:0}]},
   {id:'away',name:'Players',homeAway:'AWAY',score:[{type:'total',points:'0',number:0}]}
 ]},markets};}
const odd=(id,name,value='2.0',competitorIds=[])=>({id,name,value,isActive:true,status:'NOT_RESULTED',competitorIds});
const m=(id,typeId,name,specifiers=[],odds=[])=>({id,name,status:'ACTIVE',typeId,tags:specifiers.map(x=>x.name).filter(x=>['hcp','total'].includes(x)),specifiers,meta:[],odds});

test('GGBET preserves raw semantic metadata and correctly classifies Valorant map/round/half markets',()=>{
 const markets=[
  m('rpar',4,'Map 1 - Odd/even rounds (incl. overtime)',[{name:'mapnr',value:'1'}],[odd('1','Odd'),odd('2','even')]),
  m('ot',11,'Map 1 - Will there be overtime',[{name:'mapnr',value:'1'}],[odd('1','yes'),odd('2','no')]),
  m('half1x2',789,'Map 1 - half - 1x2',[{name:'mapnr',value:'1'},{name:'halfnr',value:'2'}],[odd('1','Team Hamy','1.3',['home']),odd('2','draw','7'),odd('3','Players','4',['away'])]),
  m('halfscore',790,'Map 1 - 1 half correct score',[{name:'mapnr',value:'1'},{name:'halfnr',value:'1'}],[odd('1','7:5'),odd('2','6:6'),odd('3','5:7')]),
  m('halfhandicap',786,'Map 1 - half round handicap',[{name:'mapnr',value:'1'},{name:'halfnr',value:'2'},{name:'hcp',value:'-2.5'}],[odd('1','Team Hamy (-2.5)','3.5',['home']),odd('2','Players (+2.5)','1.3',['away'])]),
  m('asian',927,'Map 1 - Asian total rounds',[{name:'mapnr',value:'1'},{name:'total',value:'20.25'}],[odd('1','over 20.25'),odd('2','under 20.25')]),
  m('teamtotal',1564,'Map 1 - Team Hamy total rounds (incl. overtime)',[{name:'mapnr',value:'1'},{name:'total',value:'8.5'}],[odd('1','over 8.5','1.7',['home']),odd('2','under 8.5','2.0',['home'])]),
  m('margin',1592,'Map 1 - Winning margin (incl. overtime)',[{name:'mapnr',value:'1'},{name:'score',value:'2-4'}],[odd('1','Team Hamy 2-4','2.1',['home']),odd('2','Players 2-4','1.6',['away'])]),
  m('overwin',1593,'Map 1 - Total over + Win (incl. overtime)',[{name:'mapnr',value:'1'},{name:'total',value:'20.5'}],[odd('1','Team Hamy 20.5','2.5',['home']),odd('2','Players 20.5','2.4',['away'])]),
  m('underwin',1594,'Map 1 - Total under + Win (incl. overtime)',[{name:'mapnr',value:'1'},{name:'total',value:'20.5'}],[odd('1','Team Hamy 20.5','4.3',['home']),odd('2','Players 20.5','1.2',['away'])])
 ];
 const parsed=parseGgbetLiveEvent(valorant(markets),{at:1});
 const byKey=Object.fromEntries(parsed.odds.markets.map(x=>[x.key.split(':').at(-1),x]));
 assert.equal(byKey.rpar.type,'round-parity');assert.match(byKey.rpar.title,/раундов/);
 assert.equal(byKey.ot.type,'overtime');
 assert.equal(byKey.half1x2.type,'half-winner');assert.match(byKey.half1x2.title,/половина 2/);
 assert.equal(byKey.halfscore.type,'half-exact-score');assert.match(byKey.halfscore.title,/половина 1/);
 assert.equal(byKey.halfhandicap.type,'half-round-handicap');assert.match(byKey.halfhandicap.title,/половина 2/);
 assert.equal(byKey.asian.type,'asian-round-total');
 assert.equal(byKey.teamtotal.type,'team-round-total');
 assert.deepEqual(byKey.teamtotal.prices.map(x=>x.designation),['over','under']);
 assert.deepEqual(byKey.teamtotal.prices.map(x=>x.points),[8.5,8.5]);
 assert.equal(byKey.margin.type,'winning-margin');
 assert.equal(byKey.overwin.type,'winner-total-over');assert.equal(byKey.underwin.type,'winner-total-under');
 for(const row of parsed.odds.markets){assert.ok(row.rawTitle);assert.equal(typeof row.specifiers,'object');assert.ok(Array.isArray(row.tags));}
});

test('GGBET remains LIVE-only in archive/results until ENDED final-result transport is verified',()=>{
 const index=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const api=fs.readFileSync(new URL('../src/api.js',import.meta.url),'utf8');
 assert.match(index,/new ResultsService\(liveState, fonbetLiveState, prematchState, fonbetPrematchState\);/);
 assert.doesNotMatch(index,/extraLiveStates:\[ggbetLiveState\]/);
 assert.match(api,/combinedHistory\("live", liveState, fonbetLiveState, since,pinnacleLiveState,null\)/);
});
