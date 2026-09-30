(function(root){
'use strict';
const DAY=86400100, finite=Number.isFinite;
const unique=(rows,key)=>[...new Map(rows.map(r=>[key(r),r])).values()];
const snapshotKey=s=>[s.source,s.startDate,s.endDate,JSON.stringify(s.filters||{})].join('|');
function mergePlayer(old={},row={}){
 const latest=(old.at||0)>(row.at||0)?old:row,other=latest===old?row:old;
 const out={...other,...Object.fromEntries(Object.entries(latest).filter(([,v])=>v!=null))};
 // Keep observations with different scopes separately, even if an unrelated
 // team page is newer. A tenure rating must never inherit career map counts.
 const snapshots=[...(old.statSnapshots||[]),...(row.statSnapshots||[])].sort((a,b)=>a.at-b.at);
 const maps=[...(old.mapHistory||[]),...(row.mapHistory||[])].sort((a,b)=>a.observedAt-b.observedAt);
 if(snapshots.length)out.statSnapshots=unique(snapshots,snapshotKey).sort((a,b)=>b.at-a.at).slice(0,40);
 if(maps.length)out.mapHistory=unique(maps,r=>r.id).sort((a,b)=>b.at-a.at).slice(0,2000);
 return out;
}
function recentWindow(s,now){
 const start=Date.parse(s.startDate),end=Date.parse(s.endDate);
 return finite(start)&&finite(end)&&end>=start&&end-start<=184*DAY&&now-end<31*DAY&&end<=now+DAY;
}
function restricted(s){return Object.values(s.filters||{}).some(v=>v&&v!=='All'&&v!=='CS2');}
function derivePlayer(p,now=Date.now()){
 const out={...p},snapshots=(p.statSnapshots||[]).filter(s=>s.at<=now+300000).sort((a,b)=>b.at-a.at);
 const recent=snapshots.filter(s=>(recentWindow(s,now)||(s.period==='past 3 months'&&now-s.at<31*DAY))&&!restricted(s));
 const rating=recent.find(s=>s.ratingVersion==='3.0'&&finite(s.rating))||snapshots.find(s=>s.ratingVersion==='3.0'&&finite(s.rating)&&!restricted(s));
 if(rating){out.rating=rating.rating;out.ratingVersion=rating.ratingVersion;out.ratingPeriod=recentWindow(rating,now)?'date range':rating.period;out.ratingAt=rating.at;out.ratingStartDate=rating.startDate;out.ratingEndDate=rating.endDate;out.ratingMaps=rating.maps??null;}
 const rows=(p.mapHistory||[]).filter(r=>r.at<=now&&r.at>=now-180*DAY&&r.rounds>=13&&finite(r.kills)&&finite(r.deaths));
 const official=recent.find(s=>s.kpr>0&&s.rounds>100);
 if(official){Object.assign(out,{kpr:official.kpr,dpr:official.dpr,rounds:official.rounds,adr:official.adr,statsPeriod:'date range',startDate:official.startDate,endDate:official.endDate,statsAt:official.at,statsUrl:official.source});}
 else if(rows.length>=5){
  const rounds=rows.reduce((n,r)=>n+r.rounds,0),kills=rows.reduce((n,r)=>n+r.kills,0),deaths=rows.reduce((n,r)=>n+r.deaths,0);
  Object.assign(out,{kpr:kills/rounds,dpr:deaths/rounds,rounds,statsPeriod:'observed maps',startDate:new Date(Math.min(...rows.map(r=>r.at))).toISOString().slice(0,10),endDate:new Date(Math.max(...rows.map(r=>r.at))).toISOString().slice(0,10),statsAt:Math.max(...rows.map(r=>r.observedAt)),statsUrl:rows[0].source,observedMaps:rows.length});
 }else if(snapshots.length){
  const fallback=snapshots.find(s=>s.kpr>0&&s.rounds>100&&!restricted(s))||recent.find(s=>s.kpr>0);
  Object.assign(out,{kpr:fallback?.kpr??null,dpr:fallback?.dpr??null,rounds:fallback?.rounds??null,statsPeriod:fallback?.period,statsAt:fallback?.at,statsUrl:fallback?.source});
 }
 // Estimate excess Poisson variation from dated per-map kills and exposure.
 // Shrink the inverse dispersion to the old k=20 prior (20 pseudo-maps).
 // The estimate is descriptive; these selected maps are not a validation set.
 if(rows.length>=20&&out.kpr>0){
  const mean=rows.reduce((n,r)=>n+r.kills,0)/rows.reduce((n,r)=>n+r.rounds,0);
  let numerator=0,denominator=0;
  for(const r of rows){const mu=mean*r.rounds;numerator+=(r.kills-mu)**2-r.kills;denominator+=mu*mu;}
  const alpha=Math.max(0,numerator/denominator),shrunk=(rows.length*alpha+20/20)/(rows.length+20);
  out.killDispersion=Math.max(2,Math.min(200,1/shrunk));out.dispersionMaps=rows.length;
 }
 const hs=recent.find(s=>finite(s.headshots))||snapshots.find(s=>finite(s.headshots)&&!restricted(s));
 if(hs){out.headshots=hs.headshots;out.headshotPeriod=recentWindow(hs,now)?'date range':hs.period;out.headshotAt=hs.at;}
 if(out.ratingMaps==null&&rating&&recentWindow(rating,now)){
  const start=Date.parse(rating.startDate),end=Date.parse(rating.endDate)+DAY;
  const n=rows.filter(r=>r.at>=start&&r.at<end).length;
  if(n)out.ratingMaps=n; // Observed lower bound, never a made-up sample size.
 }
 return out;
}
const api={mergePlayer,derivePlayer};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.HltvPlayerData=api;
})(globalThis);
