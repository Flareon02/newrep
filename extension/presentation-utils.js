(function(root){
 const refs=e=>e?.sourceRefs?.length?e.sourceRefs:[e].filter(Boolean);
 const text=v=>String(v??'');
 const extraPattern=/\b(?:awp|sniper|player)?\s*(?:kills?|frags?)\s*comparisons?\b|\bcomparisons?\s+(?:by|on)\s+(?:kills?|frags?|maps?|rounds?)\b|\b(?:maps?|rounds?)\s*comparisons?\b|\bplayer\s+(?:kills?|frags?)\b/i;
 function isExtraEvent(event={}){
  const rows=[event,...refs(event)];
  if(rows.some(r=>r&&r.marketKind&&r.marketKind!=='main'))return true;
  return rows.some(r=>extraPattern.test([r?.league,r?.team1,r?.team2,r?.name].filter(Boolean).join(' ')));
 }
 function pair(value){return Array.isArray(value)&&value.length>=2?[Number(value[0])||0,Number(value[1])||0]:null;}
 function parseScore(value){const raw=text(value),series=raw.match(/^\s*(\d+)\s*:\s*(\d+)/),inside=raw.match(/\(([^)]*)\)/),maps=inside?[...inside[1].matchAll(/(\d+)\s*:\s*(\d+)/g)].map(m=>[Number(m[1]),Number(m[2])]):[];return{series:series?[Number(series[1]),Number(series[2])]:null,maps};}
 function scoreText(source={},event={}){
  const parsed=parseScore(source.scoreText),series=pair(source.seriesScore)||parsed.series;if(!series)return text(source.scoreText||'');
  let maps=(Array.isArray(source.mapScores)?source.mapScores.map(pair).filter(Boolean):[]);if(!maps.length)maps=parsed.maps;
  const bestOf=Number(source.bestOf)||Number(event.bestOf)||0;
  if([1,3,5,7].includes(bestOf)){while(maps.length<bestOf)maps.push([0,0]);if(maps.length>bestOf)maps=maps.slice(0,bestOf);}
  return `${series[0]}:${series[1]}${maps.length?` (${maps.map(m=>`${m[0]}:${m[1]}`).join(', ')})`:''}`;
 }
 function matchPairText(event={}){return `${text(event.team1).trim()} - ${text(event.team2).trim()}`.trim();}
 const api={isExtraEvent,scoreText,matchPairText};if(typeof module==='object'&&module.exports)module.exports=api;else root.PresentationUtils=api;
})(globalThis);
