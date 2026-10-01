/* Conservative presentation-only matching; never changes server data. */
(function(root){
 const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 const refs=e=>e.sourceRefs?.length?e.sourceRefs:[e];
 const league=e=>{const raw=String(e.displayLeague||e.league||'');const pattern=root.GameCategories?.entries.find(([re])=>re.test(raw))?.[0];return norm(pattern?raw.replace(pattern,''):raw).replace(/\bbo\s*[1357]\b/g,'').replace(/\b(?:series|season)\s*\d+\b/g,'').trim();};
 const team=s=>{const n=norm(s).replace(/\b(?:team|gaming|esports?|club|squad)\b/g,' ').replace(/\s+/g,' ').trim();return n.length>=7?n.replace(/([a-z])\1{1,2}$/u,'$1'):n;};
 const compact=s=>team(s).replace(/\s+/g,'');
 function teamAlias(a,b){const A=team(a),B=team(b);if(!A||!B)return false;if(A===B)return true;const short=A.length<=B.length?A:B,long=A.length<=B.length?B:A;if(short.length>=5&&(long.split(' ').includes(short)||long.endsWith(' '+short)||long.startsWith(short+' ')))return true;const S=compact(short),L=compact(long);if(S.length<5||S.length>9||L.length<S.length+2)return false;let i=0;for(const ch of L)if(ch===S[i])i++;return i===S.length;}
 function pairAlias(a,b){const d1=team(a.team1)===team(b.team1),d2=team(a.team2)===team(b.team2),s1=team(a.team1)===team(b.team2),s2=team(a.team2)===team(b.team1);if(d1&&teamAlias(a.team2,b.team2)||d2&&teamAlias(a.team1,b.team1))return{ok:true,swapped:false};if(s1&&teamAlias(a.team2,b.team1)||s2&&teamAlias(a.team1,b.team2))return{ok:true,swapped:true};return{ok:false,swapped:false};}
 const signature=e=>JSON.stringify([norm(e.category),...([team(e.team1),team(e.team2)].sort())]);
 function sameLeague(a,b){return !!a.leagueKey&&a.leagueKey===b.leagueKey||league(a).replace(/\bseries\s*\d+\b/g,'').trim()===league(b).replace(/\bseries\s*\d+\b/g,'').trim();}
 function compatible(a,b){return refs(a).length===1&&refs(b).length===1&&refs(a)[0].source!==refs(b)[0].source&&
  ['astek','fonbet','pinnacle','ggbet','databet'].includes(refs(a)[0].source)&&['astek','fonbet','pinnacle','ggbet','databet'].includes(refs(b)[0].source)&&
  (!a.marketKind||a.marketKind==='main')&&(!b.marketKind||b.marketKind==='main')&&
  (!a.bestOf||!b.bestOf||a.bestOf===b.bestOf)&&sameLeague(a,b)&&Number(a.startAt)>0&&Number(b.startAt)>0&&
  Math.abs(a.startAt-b.startAt)<=90*60000;
 }
 function orient(r,base){
  const alias=pairAlias(r,base),exactSwapped=team(r.team1)===team(base.team2)&&team(r.team2)===team(base.team1);
  if(!(exactSwapped||alias.ok&&alias.swapped))return {...r};
  const pair=v=>Array.isArray(v)?[v[1],v[0]]:v;
  return {...r,team1:r.team2,team2:r.team1,team1Logo:r.team2Logo,team2Logo:r.team1Logo,scoreReversed:!r.scoreReversed,seriesScore:pair(r.seriesScore),mapScores:r.mapScores?.map(pair),
   scoreText:r.scoreText?.replace(/(\d+)\s*:\s*(\d+)/g,(_,a,b)=>b+':'+a)};
 }
 function merge(rows){
  const groups=new Map(),candidates=new Map(),out=[],used=new Set();
  for(const e of rows){if(!e.team1||!e.team2)continue;const k=signature(e);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(e);}
  for(const group of groups.values())for(const a of group)candidates.set(a,group.filter(b=>a!==b&&compatible(a,b)));
  for(const e of rows){if(used.has(e))continue;const matches=candidates.get(e)||[],other=matches[0];
   if(matches.length!==1||candidates.get(other)?.length!==1){out.push(e);continue;}
   used.add(e);used.add(other);const base=refs(e)[0].source==='astek'?e:other,second=base===e?other:e;
   out.push({...base,sourceRefs:[...refs(base).map(r=>({...r})),...refs(second).map(r=>orient(r,base))],
    startAt:Math.min(e.startAt,other.startAt),displayMerged:true,startDifferenceMinutes:Math.round(Math.abs(e.startAt-other.startAt)/60000)});
  }
  return out;
 }
 const api={merge,signature,sameLeague,orient,teamAlias,pairAlias};if(typeof module==='object'&&module.exports)module.exports=api;else root.DisplayMatches=api;
})(globalThis);
