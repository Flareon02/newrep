/* One local entity per fixture. Provider identities and every phase remain available. */
(function(root){
 const DM=root.DisplayMatches||(typeof require==='function'?require('./ui-display-matches.cjs'):null);
 const refs=e=>e.sourceRefs?.length?e.sourceRefs:[e];
 const identity=r=>r.source+':'+String(r.sourceEventId||r.id||'').replace(/^fonbet-(?:result-)?/,'');
 const min=values=>Math.min(...values.map(Number).filter(n=>n>0))||0;
 const first=values=>{const n=min(values);return Number.isFinite(n)?n:0;};
 const time=r=>Number(r.lastSeenAt||r.updatedAt||r.removedAt||r.firstSeenAt||0);
 const unique=rows=>[...new Map(rows.map(r=>[`${r.phase}:${r.type}:${r.at}`,r])).values()].sort((a,b)=>a.at-b.at);
 function combineRef(a,b){
  b=DM.orient(b,a);const fresh=time(b)>=time(a)?b:a,old=fresh===b?a:b;
  const final=[a,b].filter(r=>r.resultVerified).sort((x,y)=>time(y)-time(x))[0];
  const out={...old,...fresh,aliases:[...new Set([...(a.aliases||[]),...(b.aliases||[])])],
   firstPrematchAt:first([a.firstPrematchAt,b.firstPrematchAt]),enteredLiveAt:first([a.enteredLiveAt,b.enteredLiveAt]),
   timeline:unique([...(a.timeline||[]),...(b.timeline||[])]),
   inLive:!!(a.inLive||b.inLive),inPrematch:!!(a.inPrematch||b.inPrematch),
   archiveDates:[...new Set([...(a.archiveDates||[]),...(b.archiveDates||[])])]};
  const priced=[a,b].filter(r=>r.odds).sort((x,y)=>Number(y.inLive)-Number(x.inLive)||Number(y.odds.mode==='live'||y.scorePhase==='live')-Number(x.odds.mode==='live'||x.scorePhase==='live')||Number(y.odds.checkedAt||y.odds.updatedAt||0)-Number(x.odds.checkedAt||x.odds.updatedAt||0));if(priced.length)out.odds=priced[0].odds;
  out.firstSeenAt=out.enteredLiveAt||out.firstPrematchAt||first([a.firstSeenAt,b.firstSeenAt]);
  const scored=final||[a,b].sort((x,y)=>Number(y.scorePhase!=='prematch')-Number(x.scorePhase!=='prematch')||Number(y.scoreAt)-Number(x.scoreAt))[0];
  for(const key of ['scoreText','seriesScore','mapScores','scoreAt','scorePhase','activeMap','scoreObserved','scoreReversed'])out[key]=scored[key];
  if(final)for(const key of ['resultVerified','resultSource','endedAt'])out[key]=final[key];
  return out;
 }
 function observe(original,phase,current){
  const r={...original},mode=phase==='prematch'?'prematch':'live';
  r.aliases=[identity(r)];r.inLive=current&&phase==='live';r.inPrematch=current&&phase==='prematch';r.scorePhase=phase;r.scoreAt=time(r);
  r.firstPrematchAt=phase==='prematch'?first([r.firstSeenAt,r.enteredLiveAt]):0;
  r.enteredLiveAt=phase==='prematch'?0:first([r.enteredLiveAt,r.firstSeenAt]);
  r.timeline=(r.lifecycle||[]).map(c=>({...c,phase:mode}));
  if(!r.timeline.length&&(r.firstPrematchAt||r.enteredLiveAt))r.timeline.push({phase:mode,type:'entered',at:r.firstPrematchAt||r.enteredLiveAt});
  if(phase==='results'&&r.resultVerified)r.timeline.push({phase:'results',type:'verified',at:Number(r.endedAt||r.updatedAt||r.lastSeenAt||0)});
  return r;
 }
 function canAlias(a,b){
  if(a.source!==b.source||!DM.sameLeague(a,b)||a.marketKind&&a.marketKind!=='main'||b.marketKind&&b.marketKind!=='main'||a.bestOf&&b.bestOf&&a.bestOf!==b.bestOf)return false;
  const old=time(a)<=time(b)?a:b,later=old===a?b:a;
  // Only a withdrawn, scoreless placeholder may attach to a later incarnation.
  // Two scored or verified meetings never merge merely because their teams match.
  return !old.resultVerified&&!old.inLive&&!old.inPrematch&&Number(old.removedAt)>0&&
   ((!old.enteredLiveAt&&old.firstPrematchAt>0)||!!String(old.scoreText||'').match(/\d/) && !/[1-9]/.test(old.scoreText))&&
   Number(later.enteredLiveAt)>Number(old.removedAt)&&Number(later.startAt)>=Number(old.startAt)&&
   Math.abs(later.startAt-old.startAt)<=90*60000;
 }
 function build(batches){
  const map=new Map(),edges=[];
  for(const {events=[],phase,current=false,date} of batches)for(const event of events){
   const keys=[];
   for(const raw of refs(event)){
    if(!raw.source||!(raw.sourceEventId||raw.id))continue;
    const r=observe({...event,...raw,sourceRefs:undefined,displayLeague:event.league,leagueKey:event.leagueKey||raw.leagueKey},phase,current);
    r.archiveDates=date?[date]:[];const key=identity(r);keys.push(key);map.set(key,map.has(key)?combineRef(map.get(key),r):r);
   }
   if(keys.length>1)edges.push(keys);
  }
  const parent=new Map([...map.keys()].map(k=>[k,k]));
  const find=k=>{if(!parent.has(k))return null;while(parent.get(k)!==k)k=parent.get(k);return k;};
  for(const keys of edges){const head=find(keys[0]);for(const key of keys.slice(1)){const tail=find(key);if(head&&tail&&head!==tail)parent.set(tail,head);}}
  const components=new Map();for(const [key,r] of map){const k=find(key);if(!components.has(k))components.set(k,[]);components.get(k).push(r);}
  const main=r=>!r.marketKind||r.marketKind==='main';
  const scoreless=r=>!/[1-9]/.test(r.scoreText||'');
  function compatible(a,b){return a.every(x=>b.every(y=>{
   if(!main(x)||!main(y)||!DM.sameLeague(x,y)||x.bestOf&&y.bestOf&&x.bestOf!==y.bestOf||!x.startAt||!y.startAt||Math.abs(x.startAt-y.startAt)>90*60000)return false;
   if(x.source!==y.source)return true;
   if(Math.abs(x.startAt-y.startAt)<=60000)return true;
   // Allow a line placeholder or withdrawn zero-score incarnation to attach
   // to its fixture, even when the provider moved its announced start time.
   if(!x.enteredLiveAt&&x.firstPrematchAt&&y.enteredLiveAt&&scoreless(x)||!y.enteredLiveAt&&y.firstPrematchAt&&x.enteredLiveAt&&scoreless(y))return true;
   if(canAlias(x,y))return true;
   const oriented=DM.orient(y,x);
   return x.resultVerified&&y.resultVerified&&x.scoreText===oriented.scoreText&&x.endedAt>0&&y.endedAt>0&&Math.abs(x.endedAt-y.endedAt)<=15*60000;
  }));}
  const buckets=new Map();for(const list of components.values()){const key=DM.signature(list[0]);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(list);}
  const joined=[];
  for(const bucket of buckets.values()){
   // Collapse all exact provider/start aliases first; pair-only matching leaves
   // three or more incarnations permanently ambiguous.
   let group=[...bucket],changed=true;
   while(changed){changed=false;outer:for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++)if(compatible(group[i],group[j])&&group[i].some(x=>group[j].some(y=>x.source===y.source&&Math.abs(x.startAt-y.startAt)<=60000))){group[i]=[...group[i],...group[j]];group.splice(j,1);changed=true;break outer;}}
   if(group.length>2&&group.every((a,i)=>group.every((b,j)=>i===j||compatible(a,b))))group=[group.flat()];
   changed=true;while(changed){changed=false;const candidates=group.map(a=>group.map((b,i)=>a!==b&&compatible(a,b)?i:-1).filter(i=>i>=0));for(let i=0;i<group.length;i++){const j=candidates[i][0];if(candidates[i].length===1&&candidates[j].length===1){group[i]=[...group[i],...group[j]];group.splice(j,1);changed=true;break;}}}
   joined.push(...group);
  }
  // Server matching remains the source of truth, but historical/current batches
  // can briefly contain two logical rows while a provider changes spelling.
  // Join only the extremely constrained one-side abbreviation case used by the
  // bookmaker feeds: different providers, same tournament, <=10 minutes and one
  // participant exact while the other is a guarded abbreviation (PCIFIC/Wraith
  // PCIFIC, PVISION/PARIVISION). Reciprocal uniqueness prevents arbitrary joins.
  const aliasCompatible=(a,b)=>{
   const sa=new Set(a.map(r=>r.source)),sb=new Set(b.map(r=>r.source));for(const x of sa)if(sb.has(x))return false;
   const A=a[0],B=b[0];if(!A||!B||!DM.sameLeague(A,B)||A.marketKind&&A.marketKind!=='main'||B.marketKind&&B.marketKind!=='main')return false;
   if(A.bestOf&&B.bestOf&&A.bestOf!==B.bestOf||!A.startAt||!B.startAt||Math.abs(Number(A.startAt)-Number(B.startAt))>10*60000)return false;
   return !!DM.pairAlias?.(A,B)?.ok;
  };
  // pairAlias needs one exact participant. Index the rare alias candidates by
  // league + normalized participant + a 10-minute time bucket instead of doing
  // an O(n²) comparison across the entire historical ledger.
  const aliasTeam=s=>{const n=String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\b(?:team|gaming|esports?|club|squad)\b/g,' ').replace(/\s+/g,' ').trim();return n.length>=7?n.replace(/([a-z])\1{1,2}$/u,'$1'):n;};
  const aliasLeague=e=>String(e.displayLeague||e.league||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\bbo\s*[1357]\b/g,'').replace(/\b(?:series|season)\s*\d+\b/g,'').trim();
  const aliasKeys=e=>[...(e.leagueKey?[`id:${e.leagueKey}`]:[]),`name:${aliasLeague(e)}`];
  const aliasIndex=new Map(),aliasCandidates=joined.map(()=>new Set()),bucketMs=10*60000;
  for(let i=0;i<joined.length;i++){
   const e=joined[i][0];if(!e?.startAt)continue;const bucket=Math.floor(Number(e.startAt)/bucketMs),teams=[aliasTeam(e.team1),aliasTeam(e.team2)].filter(Boolean);
   for(const league of aliasKeys(e))for(const team of teams)for(let d=-1;d<=1;d++){
    const key=`${league}|${team}|${bucket+d}`;for(const j of aliasIndex.get(key)||[])if(j!==i){aliasCandidates[i].add(j);aliasCandidates[j].add(i);}
   }
   for(const league of aliasKeys(e))for(const team of teams){const key=`${league}|${team}|${bucket}`;if(!aliasIndex.has(key))aliasIndex.set(key,[]);aliasIndex.get(key).push(i);}
  }
  const choices=aliasCandidates.map((set,i)=>[...set].filter(j=>aliasCompatible(joined[i],joined[j])));
  const aliasUsed=new Set(),aliasJoined=[];
  for(let i=0;i<joined.length;i++){
   if(aliasUsed.has(i))continue;const j=choices[i][0];
   if(choices[i].length===1&&j!=null&&choices[j]?.length===1&&choices[j][0]===i){aliasUsed.add(i);aliasUsed.add(j);aliasJoined.push([...joined[i],...joined[j]]);}else{aliasUsed.add(i);aliasJoined.push(joined[i]);}
  }
  const pack=list=>{const bySource=new Map();for(const r of list)bySource.set(r.source,bySource.has(r.source)?combineRef(bySource.get(r.source),r):r);list=[...bySource.values()].sort((a,b)=>a.source.localeCompare(b.source));const base=list[0],oriented=list.map(r=>DM.orient(r,base)),times=list.map(r=>Number(r.startAt)).filter(t=>t>0),difference=times.length>1?Math.round((Math.max(...times)-Math.min(...times))/60000):0;return {...base,league:base.displayLeague||base.league,sourceRefs:oriented,startAt:first(times),displayMerged:list.length>1,startDifferenceMinutes:difference};};
  let rows=aliasJoined.map(pack);
  return rows.map(e=>{const list=refs(e),aliases=[...new Set(list.flatMap(r=>r.aliases||[identity(r)]))].sort();
   const live=list.some(r=>r.inLive),pre=list.some(r=>r.inPrematch),verified=list.some(r=>r.resultVerified);
   return {...e,id:aliases[0],entityAliases:aliases,inLive:live,inPrematch:pre,
    phase:verified?'results':live?'live':pre?'prematch':list.some(r=>r.enteredLiveAt)?'removed':'prematch-history',
    archiveDates:[...new Set(list.flatMap(r=>r.archiveDates||[]))]};
  });
 }
 const api={build,identity,combineRef};if(typeof module==='object'&&module.exports)module.exports=api;else root.EventLedger=api;
})(globalThis);
