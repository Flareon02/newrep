// Only sporting facts and approved public HLTV statistics URLs are persisted.
export function safePlayerDetails(p,now){
 const num=(v,a,b)=>v!=null&&Number.isFinite(Number(v))&&Number(v)>=a&&Number(v)<=b?Number(v):null;
 const at=v=>num(v,946684800000,now+300000),label=v=>String(v||'').replace(/[\u0000-\u001f]/g,'').slice(0,80);
 const date=v=>/^\d{4}-\d\d-\d\d$/.test(v)?v:null;
 const filterKeys=['csVersion','matchType','rankingFilter','maps','event','teamId'];
 const source=v=>{try{const u=new URL(v);if(u.origin!=='https://www.hltv.org'||!/^\/(?:team|player|matches|stats\/players)\//.test(u.pathname))return undefined;const clean=new URL(u.origin+u.pathname);for(const k of [...filterKeys,'startDate','endDate'])if(u.searchParams.has(k))clean.searchParams.set(k,label(u.searchParams.get(k)));return clean.href;}catch{return undefined;}};
 const statSnapshots=(Array.isArray(p.statSnapshots)?p.statSnapshots:[]).slice(0,40).map(s=>({
  at:at(s.at),source:source(s.source),startDate:date(s.startDate),endDate:date(s.endDate),period:['all time','date range','team tenure','past 3 months'].includes(s.period)?s.period:undefined,
  filters:Object.fromEntries(filterKeys.filter(k=>s.filters?.[k]).map(k=>[k,label(s.filters[k])])),
  rating:num(s.rating,0,3),ratingVersion:['3.0','older'].includes(s.ratingVersion)?s.ratingVersion:undefined,
  maps:num(s.maps,0,10000),rounds:num(s.rounds,0,1e7),kpr:num(s.kpr,0,2),dpr:num(s.dpr,0,2),adr:num(s.adr,0,300),headshots:num(s.headshots,0,1),kast:num(s.kast,0,1),multiKillRating:num(s.multiKillRating,0,4),roundSwing:num(s.roundSwing,-1,1),
  openingKills:num(s.openingKills,0,1e7),openingDeaths:num(s.openingDeaths,0,1e7),openingWinRate:num(s.openingWinRate,0,1),multikills:Array.isArray(s.multikills)&&s.multikills.length===6?s.multikills.map(v=>num(v,0,1e7)):undefined
 })).filter(s=>s.at&&s.source);
 const mapHistory=(Array.isArray(p.mapHistory)?p.mapHistory:[]).slice(0,2000).map(r=>({id:num(r.id,1,1e10),at:at(r.at),observedAt:at(r.observedAt),teamId:num(r.teamId,1,1e10),opponentId:num(r.opponentId,1,1e10),map:label(r.map),scoreA:num(r.scoreA,0,100),scoreB:num(r.scoreB,0,100),kills:num(r.kills,0,1000),deaths:num(r.deaths,0,1000),rating:num(r.rating,0,4),source:source(r.source)}))
  .filter(r=>r.id&&Number.isSafeInteger(r.id)&&r.at&&r.at<=now&&r.observedAt&&r.teamId&&r.opponentId&&r.teamId!==r.opponentId&&r.scoreA!=null&&r.scoreB!=null&&r.kills!=null&&r.deaths!=null&&r.source)
  .map(r=>({...r,rounds:r.scoreA+r.scoreB})).filter(r=>r.rounds>=13&&r.kills<=r.rounds*5&&r.deaths<=r.rounds);
 return {...(statSnapshots.length?{statSnapshots}:{}),...(mapHistory.length?{mapHistory}:{})};
}
