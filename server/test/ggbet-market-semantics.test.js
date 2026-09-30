import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalizeGgbetMarket} from '../src/market-semantics.js';
import {parseGgbetLiveEvent} from '../src/ggbet.js';

const teams={team1:'MEIA NOITE',team2:'ALKA'};
const market=(rawType,rawTitle,specifiers={},extra={})=>({rawType,rawTitle,title:rawTitle,period:Number(specifiers.mapnr)||0,specifiers,prices:[{designation:'home',label:'MEIA NOITE',decimal:2.1},{designation:'away',label:'ALKA',decimal:1.7}],...extra});

test('GGBET typeId 8 is race-to-rounds, never a generic winner',()=>{
  const c=canonicalizeGgbetMarket(market(8,'Map 1 - Race to rounds',{mapnr:'1',roundnr:'10'}),teams);
  assert.equal(c.family,'race-to-rounds');
  assert.equal(c.category,'rounds');
  assert.equal(c.map,1);assert.equal(c.round,10);
  assert.equal(c.title,'Карта 1 — кто первым возьмёт 10 раундов');
});

test('GGBET map 1X2 typeId 21 excludes overtime while typeId 7 includes it',()=>{
  const noOt=canonicalizeGgbetMarket(market(21,'1st mapa - 1x2 (nie obejmuje dogrywki)',{mapnr:'1'}),teams);
  const withOt=canonicalizeGgbetMarket(market(7,'Map 1 - Winner (incl. overtime)',{mapnr:'1'}),teams);
  assert.equal(noOt.overtime,'exclude');assert.match(noOt.title,/без овертайма/);
  assert.equal(withOt.overtime,'include');assert.match(withOt.title,/с овертаймом/);
});

test('unknown GGBET type is preserved as special instead of guessed from home/away outcomes',()=>{
  const c=canonicalizeGgbetMarket(market(999999,'New bookmaker market',{mapnr:'1'}),teams);
  assert.equal(c.family,'special');assert.equal(c.category,'specials');assert.equal(c.unknown,true);
  assert.equal(c.title,'New bookmaker market');
});

test('GGBET parser exposes exact canonical semantics and native provider tab memberships',()=>{
  const raw={
    id:'5:c96c3d92-1ea7-4ff4-8ada-eaa9a7050f4f',slug:'meia-noite-vs-alka-29-09',disabled:false,betStop:false,version:'v1',meta:[],
    fixture:{score:'0:0',status:'LIVE',startTime:'2026-09-29T20:00:00Z',sportId:'esports_counter_strike',sport:{id:'esports_counter_strike',name:'Counter Strike 2',tags:['ESPORT']},tournament:{id:'league',name:'CCT South America'},competitors:[
      {id:'h',name:'MEIA NOITE',homeAway:'HOME',score:[{type:'total',points:'0',number:0}]},{id:'a',name:'ALKA',homeAway:'AWAY',score:[{type:'total',points:'0',number:0}]}
    ]},
    markets:[{id:'8m1r10',name:'Map 1 - Race to rounds',status:'ACTIVE',typeId:8,tags:[],specifiers:[{name:'mapnr',value:'1'},{name:'roundnr',value:'10'}],meta:[],odds:[
      {id:'1',name:'MEIA NOITE',value:'3.70',isActive:true,status:'NOT_RESULTED',competitorIds:['h']},{id:'2',name:'ALKA',value:'1.25',isActive:true,status:'NOT_RESULTED',competitorIds:['a']}
    ]}]
  };
  const providerTabs={catalog:[{id:'all',name:'All',count:1},{id:'round_markets',name:'Rounds ⚡️',count:1},{id:'mapnr:mapnr:1',name:'Map 1',count:1}],marketToTabs:new Map([['8m1r10',['all','round_markets','mapnr:mapnr:1']]])};
  const e=parseGgbetLiveEvent(raw,{at:123,providerTabs});
  const m=e.odds.markets[0];
  assert.equal(m.rawType,8);assert.equal(m.rawTitle,'Map 1 - Race to rounds');
  assert.equal(m.title,'Карта 1 — кто первым возьмёт 10 раундов');
  assert.equal(m.canonical.family,'race-to-rounds');
  assert.deepEqual(m.providerTabs,['all','round_markets','mapnr:mapnr:1']);
  assert.deepEqual(e.odds.providerTabs.map(x=>x.id),['all','round_markets','mapnr:mapnr:1']);
});

test('GGBET signed handicap odds preserve opposite outcome points',()=>{
  const raw={
    id:'5:c96c3d92-1ea7-4ff4-8ada-eaa9a7050f4f',slug:'meia-noite-vs-alka-29-09',disabled:false,betStop:false,version:'v1',meta:[],
    fixture:{score:'0:0',status:'LIVE',startTime:'2026-09-29T20:00:00Z',sportId:'esports_counter_strike',sport:{id:'esports_counter_strike',name:'Counter Strike 2',tags:['ESPORT']},tournament:{id:'league',name:'CCT South America'},competitors:[
      {id:'h',name:'MEIA NOITE',homeAway:'HOME',score:[{type:'total',points:'0',number:0}]},{id:'a',name:'ALKA',homeAway:'AWAY',score:[{type:'total',points:'0',number:0}]}
    ]},
    markets:[{id:'1590h-0_25m1',name:'Map 1 - Asian round handicap (incl. overtime)',status:'ACTIVE',typeId:1590,tags:['hcp'],specifiers:[{name:'hcp',value:'-0.25'},{name:'mapnr',value:'1'}],meta:[],odds:[
      {id:'1',name:'MEIA NOITE (-0.25)',value:'3.27',isActive:true,status:'NOT_RESULTED',competitorIds:['h']},
      {id:'2',name:'ALKA (+0.25)',value:'1.31',isActive:true,status:'NOT_RESULTED',competitorIds:['a']}
    ]}]
  };
  const e=parseGgbetLiveEvent(raw,{at:123});
  const [home,away]=e.odds.markets[0].prices;
  assert.equal(home.points,-0.25);
  assert.equal(away.points,0.25);
  assert.equal(e.odds.markets[0].canonical.family,'asian-round-handicap');
});
