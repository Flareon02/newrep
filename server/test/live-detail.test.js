import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import '../src/odds-pricing.js';
import '../src/live-model.js';
import {astekOdds} from '../src/book-odds.js';

// A reduced copy of the user's GetGameZip example: map 2 at 9:9.
const result={I:756512591,MG:756512589,PN:'2nd map',O1E:'K27',O2E:'Sinners',SC:{FS:{S2:1},PS:[{Key:1,Value:{S1:6,S2:13}},{Key:2,Value:{S1:9,S2:9}}]},GE:[{G:1,E:[[{G:1,T:1,C:2.025}],[{G:1,T:3,C:1.752}]]},{G:17,E:[[{G:17,T:9,P:22.5,C:1.33}],[{G:17,T:10,P:22.5,C:3.19}]]},{G:2,E:[[{G:2,T:7,P:2.5,C:1.525}],[{G:2,T:8,P:-2.5,C:2.455}]]}]};
const parent={I:756512589,O1E:'K27',O2E:'Sinners',BIG:[{I:756512591,P:2,PN:'2nd map'}],GE:[{G:1,E:[[{G:1,T:1,C:2.3}],[{G:1,T:3,C:1.58}]]}]};

test('subgame prices correct current map and preserve score-keyed request cache',async()=>{
 let attempts=0;const server=http.createServer((req,res)=>{attempts++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({Success:true,Value:req.url.includes('id=756512591')?result:parent}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  process.env.ASTEK_ORIGINS=`http://127.0.0.1:${server.address().port}`;
  const {astekLiveDetail}=await import('../src/astek-detail.js');
  const ref={source:'astek',sourceEventId:'756512589',activeMap:2,seriesScore:[0,1],mapScores:[[6,13],[9,9],[0,0]],lastSeenAt:Date.now()};
  const detail=await astekLiveDetail(ref);
  assert.equal(attempts,2);
  assert.equal(detail.markets.find(m=>m.period===2&&m.type==='total').prices.find(p=>p.designation==='over').decimal,1.33);
  await astekLiveDetail(ref);assert.equal(attempts,2);
  const event={team1:'K27',team2:'Sinners',bestOf:3,sourceRefs:[{...ref,scoreObserved:true,odds:{...detail,checkedAt:Date.now(),stale:false}}]};
  const model=globalThis.LiveModel.generate(event,{source:'astek',scoreSource:'astek',bestOf:3,margin:7.5});
  const line=model.categories.find(c=>c.id==='map-2').markets.find(m=>m.title.includes('тотал раундов 22.5'));
  const fairOver=(1/1.33)/(1/1.33+1/3.19);
  assert.ok(Math.abs(line.outcomes[1].probability-fairOver)<1e-8);
  // A changed score triggers fresh requests and must reject an older quote.
  const changed=await astekLiveDetail({...ref,mapScores:[[6,13],[9,10],[0,0]]});
  assert.equal(changed,null);assert.equal(attempts,4);
 }finally{server.close();}
});
