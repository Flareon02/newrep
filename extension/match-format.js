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

 const api={orientQuote,bestPrices,margin,formatPrice,scoreParts,createPriceTracker,openPrice};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.MatchFormat=api;
})(globalThis);
