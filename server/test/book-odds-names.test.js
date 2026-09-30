import test from 'node:test';
import assert from 'node:assert/strict';
import {astekOdds,fonbetOdds} from '../src/book-odds.js';
import {astekTeamLogo} from '../src/parsers.js';

test('CS2 outcomes override borrowed football and medal market captions',()=>{
 const raw={I:900,SSN:'Counter Strike 2',O1:'Fnatic',O2:'Team Nemesis',E:[
  {G:2665,T:191,P:20.5,C:1.4},{G:2665,T:192,P:20.5,C:3},{G:2665,T:211,P:20.5,C:2.7},{G:2665,T:212,P:20.5,C:1.33},
  {G:136,T:3044,P:13.009,C:7},{G:90,T:759,C:3.8},{G:90,T:761,C:1.22}
 ]};
 const markets=astekOdds(raw).markets;
 assert.deepEqual(new Set(markets.map(m=>m.title)),new Set(['Победитель и тотал','Раунд команды 1 в интервале','Будет овертайм']));
 assert.equal(markets.find(m=>m.rawGroup===2665).prices.length,4);
 assert.equal(astekTeamLogo(['1e7803f6c2d1dd38e2919c5034d6b92e.png']),'https://v2l.traincdn.com/sfiles/logo_teams/1e7803f6c2d1dd38e2919c5034d6b92e.png');
 assert.equal(astekTeamLogo(['https://example.com/logo.png']),'');
});

test('Astek esports feed infers handicap/total semantics instead of generic dictionary captions',()=>{
 const raw={O1:'FOKUS',O2:'Iberian Soul',E:[
  {G:1,T:1,C:1.184},{G:1,T:3,C:4.45},
  {G:2,T:7,P:-4.5,C:1.7},{G:2,T:8,P:4.5,C:2.075},
  {G:17,T:9,P:48.5,C:1.79},{G:17,T:10,P:48.5,C:1.955}
 ],AE:[
  {G:2438,ME:[{G:2438,T:2826,P:-1.5,C:1.595},{G:2438,T:2827,P:1.5,C:2.256}]},
  {G:2436,ME:[{G:2436,T:2824,P:2.5,C:2.256},{G:2436,T:2825,P:2.5,C:1.595}]}
 ]};
 const o=astekOdds(raw,1);assert.ok(o);
 assert.deepEqual(o.markets.map(m=>m.title),['Победитель','Фора','Тотал','Фора по картам','Тотал по картам']);
 const h=o.markets.find(m=>m.title==='Фора');assert.equal(h.prices.length,2);assert.deepEqual(h.prices.map(p=>p.designation),['home','away']);
});

test('Fonbet esports factors are grouped into named markets',()=>{
 const payload={events:[{id:7,team1:'FOKUS',team2:'Iberian Soul'}],customFactors:[{e:7,factors:[
  {f:921,v:1.17},{f:923,v:4.4},
  {f:910,pt:-5.5,v:2.1},{f:912,pt:5.5,v:1.65},
  {f:927,pt:-4.5,v:1.68},{f:928,pt:4.5,v:2.05},
  {f:930,pt:48.5,v:1.93},{f:931,pt:48.5,v:1.77},
  {f:3262,pt:-1.5,v:1.58},{f:3263,pt:1.5,v:2.23},
  {f:3274,pt:2.5,v:2.23},{f:3275,pt:2.5,v:1.6}
 ]}]};
 const o=fonbetOdds(payload,7,1);assert.ok(o);
 assert.ok(!o.markets.some(m=>/^Фактор /.test(m.title)));
 assert.deepEqual(new Set(o.markets.map(m=>m.title)),new Set(['Победитель','Фора','Тотал','Фора по картам','Тотал карт']));
 assert.equal(o.markets.filter(m=>m.title==='Фора').length,2);
 assert.equal(o.markets.find(m=>m.title==='Фора по картам').prices.length,2);
});


test('Fonbet rotating adjacent factor ids render as ordinary totals',()=>{
 const payload={events:[{id:9,team1:'LGD Gaming',team2:'Natus Vincere'}],customFactors:[{e:9,factors:[
  {f:1727,pt:47.5,v:1.75},{f:1728,pt:47.5,v:1.95},
  {f:1696,pt:48.5,v:1.95},{f:1697,pt:48.5,v:1.75}
 ]}]};
 const o=fonbetOdds(payload,9,1);assert.ok(o);const totals=o.markets.filter(m=>m.title==='Тотал');assert.equal(totals.length,2);
 for(const m of totals){assert.deepEqual(m.prices.map(p=>p.designation),['over','under']);assert.ok(m.prices.every(p=>!/^Исход /.test(p.label)));assert.deepEqual(m.prices.map(p=>p.label),['Больше','Меньше']);}
});

test('Astek expanded feed deduplicates entries and pairs handicap by opposite team line',()=>{
 const raw={I:99,O1:'INFINITE',O2:'Fluxo W7M',E:[
  {G:1,T:1,C:1.975},{G:1,T:3,C:1.775},{G:2,T:7,P:-2.5,C:2.02},{G:2,T:8,P:2.5,C:1.74}
 ],AE:[{G:2,ME:[
  {G:2,T:7,P:-2.5,C:2.02,CE:1},{G:2,T:8,P:2.5,C:1.74,CE:1},
  {G:2,T:7,P:2.5,C:1.64},{G:2,T:8,P:-2.5,C:2.175}
 ]}],SG:[{I:100,PN:'1st map',E:[
  {G:1,T:1,C:1.79},{G:1,T:3,C:1.955},{G:15,T:11,P:12.5,C:1.64},{G:15,T:12,P:12.5,C:2.175},
  {G:62,T:13,P:12.5,C:1.775},{G:62,T:14,P:12.5,C:1.975},
  {G:2766,T:3653,C:2.01},{G:2766,T:3654,C:5.83},{G:2766,T:3655,C:2.5}
 ]}]};
 const o=astekOdds(raw,Date.now());assert.ok(o);
 const handicaps=o.markets.filter(m=>m.period===0&&m.title==='Фора');assert.equal(handicaps.length,2);assert.ok(handicaps.every(m=>m.prices.length===2));
 assert.deepEqual(handicaps.map(m=>m.prices.map(p=>p.points)),[[-2.5,2.5],[2.5,-2.5]]);
 assert.equal(o.markets.find(m=>m.period===1&&m.title==='Тотал 1').prices.length,2);
 assert.equal(o.markets.find(m=>m.period===1&&m.title==='Тотал 2').prices.length,2);
 assert.deepEqual(o.markets.find(m=>m.period===1&&m.title==='Победитель первой половины').prices.map(p=>p.designation),['home','draw','away']);
});

test('Fonbet winner factors use canonical moneyline type for LIVE generator',()=>{
 const payload={events:[{id:11,team1:'INFINITE',team2:'Fluxo W7M'}],customFactors:[{e:11,factors:[{f:921,v:2.1},{f:923,v:1.65}]}]};
 const o=fonbetOdds(payload,11,Date.now());assert.equal(o.markets[0].type,'moneyline');assert.deepEqual(o.markets[0].prices.map(p=>p.designation),['home','away']);
});
