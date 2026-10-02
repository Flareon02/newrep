'use strict';
/* Pure presentation helpers for 9.0 list rows, detail header and odds comparison. No DOM; unit-tested in Node. */
(function(root){
 const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};
 const pair=v=>Array.isArray(v)&&v.length>=2&&num(v[0])!=null&&num(v[1])!=null?[num(v[0]),num(v[1])]:null;

 // A ref's quote is in the bookmaker's own team order (server convention, like score patches): flip it for refs whose
 // teams are reversed relative to the logical event.
 function orientQuote(ref){
  const q=ref?.quote;if(!q||typeof q!=='object')return null;
  return ref.scoreReversed===true?{...q,h:q.a??null,a:q.h??null}:{...q};
 }
 const openPrice=v=>{const n=num(v);return n!=null&&n>1?n:null;};

 // Best price per side across bookmakers; ties keep every bookmaker that offers it.
 function bestPrices(quotes){
  const best={h:null,a:null,d:null},by={h:[],a:[],d:[]};
  for(const [source,q] of Object.entries(quotes||{})){
   if(!q||q.s||q.stale)continue;
   for(const side of ['h','a','d']){const v=openPrice(q[side]);if(v==null)continue;if(best[side]==null||v>best[side]+1e-9){best[side]=v;by[side]=[source];}else if(Math.abs(v-best[side])<1e-9)by[side].push(source);}
  }
  return {...best,by};
 }
 // Bookmaker margin in percent for a 2-way (or 3-way) market.
 function margin(q){
  if(!q||q.s)return null;const sides=[q.h,q.a,...(q.d!=null?[q.d]:[])].map(openPrice);
  if(sides.some(v=>v==null))return null;return Math.round((sides.reduce((s,v)=>s+1/v,0)-1)*1000)/10;
 }
 // Decimal odds as bookmakers print them: 1.833, 2.05, 2.00, 11.50, 101.
 const formatPrice=v=>{const n=openPrice(v);if(n==null)return '';if(n>=100)return n.toFixed(0);if(n>=10)return n.toFixed(2);return n.toFixed(3).replace(/0$/,'');};

 // Score of one fixture: series (maps won), the map being played and its score; plain text for other formats.
 function scoreParts(source={},event={}){
  const text=String(source.scoreText||'').trim();
  let series=pair(source.seriesScore),maps=Array.isArray(source.mapScores)?source.mapScores.map(pair).filter(Boolean):[];
  if(!series){const m=text.match(/^\s*(\d+)\s*:\s*(\d+)/);if(m)series=[Number(m[1]),Number(m[2])];}
  if(!maps.length){const inside=text.match(/\(([^)]*)\)/);if(inside)maps=[...inside[1].matchAll(/(\d+)\s*:\s*(\d+)/g)].map(m=>[Number(m[1]),Number(m[2])]);}
  const bestOf=Number(source.bestOf)||Number(event.bestOf)||0;
  let index=-1;const active=Number(source.activeMap||event.activeMap||0);
  if(active>0&&maps[active-1])index=active-1;
  else if(series&&maps.length){
   const played=series[0]+series[1],finished=bestOf>0&&Math.max(...series)>=Math.ceil(bestOf/2);
   index=finished?Math.max(0,played-1):Math.min(maps.length-1,played);
  }else if(maps.length)index=maps.length-1;
  const map=index>=0?maps[index]:null;
  return {series,map,mapNumber:index>=0?index+1:0,maps,bestOf,text};
 }

 // One display score for every view: "1:0 (13:6, 5:3, 0:0)" - maps won, then every map of the series: played maps,
 // the current one, and (only while the series is undecided and its format BoN is known) the maps still to come as
 // 0:0. A decided series lists only the maps played. Without a usable series score: the provider's own text.
 function validSeries(series,bestOf){
  if(!series)return false;const [a,b]=series;if(a<0||b<0)return false;
  if(bestOf>0)return Math.max(a,b)<=Math.ceil(bestOf/2)&&a+b<=bestOf;
  return Math.max(a,b)<=4;   // without a format a "series" of 16:11 is rounds or kills, not maps
 }
 function displayScore(source={},event={}){
  const p=scoreParts(source,event),bo=p.bestOf;
  if(!validSeries(p.series,bo))return {text:p.series?'':p.text||'',series:null,maps:[],current:-1,bestOf:bo,valid:false};
  const played=p.series[0]+p.series[1],decided=bo>0&&Math.max(...p.series)>=Math.ceil(bo/2);
  const started=p.maps.reduce((n,m,i)=>m[0]||m[1]?i+1:n,0);   // maps up to the last one with points
  let count=bo>0?(decided?played:bo):Math.max(started,p.maps.length>played?played+1:0);   // unknown format: maps with points + the current one if the provider lists it
  count=Math.max(0,Math.min(count,bo>0?bo:p.maps.length||count));
  const maps=Array.from({length:count},(_,i)=>p.maps[i]||[0,0]);
  const current=!decided&&played<count?played:-1;
  const text=`${p.series[0]}:${p.series[1]}`+(maps.length?` (${maps.map(m=>m.join(':')).join(', ')})`:'');
  return {text,series:p.series,maps,current,bestOf:bo,decided,valid:true};
 }
 // Canonical score of a fixture from several bookmakers. Only plausible series scores take part; the one furthest in
 // the series wins (maps won, then maps with points), then the most recently changed, then a fixed provider order.
 // A provider without a score never replaces one that has it. `disagree` lists differing providers (diagnostics).
 const SCORE_ORDER=['astek','fonbet','pinnacle','ggbet','databet'];
 function canonicalScore(refs=[],{changedAt=()=>0}={}){
  const providers=[];
  for(const r of refs||[]){const d=displayScore(r);if(!d.valid)continue;providers.push({source:r.source,ref:r,...d,changed:Number(changedAt(r))||0,startedMaps:d.maps.filter(m=>m[0]||m[1]).length});}
  if(!providers.length)return {best:null,providers:[],disagree:false};
  const rank=x=>SCORE_ORDER.includes(x.source)?SCORE_ORDER.indexOf(x.source):99;
  providers.sort((a,b)=>(b.series[0]+b.series[1])-(a.series[0]+a.series[1])||b.startedMaps-a.startedMaps||b.changed-a.changed||rank(a)-rank(b));
  const disagree=new Set(providers.map(x=>x.text)).size>1;
  return {best:providers[0],providers,disagree};
 }

 // When the match first appeared at each bookmaker (line or LIVE, whichever was first) - not the last update.
 function firstSeen(refs=[]){
  return (refs||[]).map(r=>({source:r.source,at:Math.min(...[r.firstPrematchAt,r.firstSeenAt,r.enteredLiveAt].map(Number).filter(t=>t>0))})).filter(x=>Number.isFinite(x.at)).sort((a,b)=>a.at-b.at);
 }

 // Remembers the last price per key and reports the direction of a change for `windowMs`.
 function createPriceTracker({windowMs=20000,max=4000,clock=()=>Date.now()}={}){
  const last=new Map();
  function track(key,value){
   const v=openPrice(value),now=clock(),prev=last.get(key);
   if(v==null)return {dir:null,was:null};
   if(!prev){last.set(key,{value:v,was:null,dir:null,changedAt:0});return {dir:null,was:null};}
   if(Math.abs(prev.value-v)>1e-9){const next={value:v,was:prev.value,dir:v>prev.value?'up':'down',changedAt:now};last.delete(key);last.set(key,next);while(last.size>max)last.delete(last.keys().next().value);return {dir:next.dir,was:next.was};}
   return now-prev.changedAt<windowMs?{dir:prev.dir,was:prev.was}:{dir:null,was:null};
  }
  return {track,clear:()=>last.clear(),size:()=>last.size};
 }

 const api={orientQuote,bestPrices,margin,formatPrice,scoreParts,displayScore,canonicalScore,validSeries,firstSeen,createPriceTracker,openPrice};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.MatchFormat=api;
})(globalThis);
