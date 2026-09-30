import { canonicalCategory,leagueFamily,eventMatchScore,maximumAssignment } from './entity-resolver.js';
import { leagueStore } from './league-store.js';
import M from './league-model.cjs';

// The same published groups and oriented event matcher are used by the line,
// history and pasted-schedule comparison. Pasted names never teach new aliases.
export function compareSchedule(inputRows,events,options={}){
  if(!Array.isArray(inputRows)||inputRows.length>500)throw new Error('За одно сравнение можно обработать до 500 матчей');
  const rules=leagueStore.rules(),state={publishedLeagueLinks:rules.links,excludedLeagueKeys:M.unique([...(rules.visibility.excludedLeagueKeys||[]),...(options.excludedLeagueKeys||[])]),excludedCategoryKeys:M.unique([...(rules.visibility.excludedCategoryKeys||[]),...(options.excludedCategoryKeys||[])])};
  const catalog=[...leagueStore.catalog.values()].map(r=>({...r,catalogId:M.id(r),category:leagueStore.group(r)?.category||canonicalCategory(r.category)}));
  const categoryFor=value=>{const category=canonicalCategory(value||'');return category==='Esports'?null:category;};
  const catalogIndex=new Map();
  for(const row of catalog)for(const title of new Set([row.league,leagueStore.group(row)?.name].filter(Boolean))){const key=row.category+'|'+leagueFamily(title,row.category);if(!catalogIndex.has(key))catalogIndex.set(key,[]);catalogIndex.get(key).push(row);}
  const categories=[...new Set(catalog.map(r=>r.category))],definitionCache=new Map();
  const catalogMatches=(input,category)=>{const key=(category||'')+'|'+input.league;if(!definitionCache.has(key))definitionCache.set(key,(category?[category]:categories).flatMap(cat=>catalogIndex.get(cat+'|'+leagueFamily(input.league,cat))||[]));return definitionCache.get(key);};
  const monitorEvents=events.filter(e=>!M.hidden(e,state)).map(e=>({...e,sourceRefs:(e.sourceRefs?.length?e.sourceRefs:[e]).filter(r=>options[r.source+'Enabled']!==false)})).filter(e=>e.sourceRefs.length);
  const inputs=inputRows.map((row,index)=>{
    if(!row||typeof row.team1!=='string'||typeof row.team2!=='string'||row.team1.length>300||row.team2.length>300||String(row.league||'').length>500||!Number.isFinite(Number(row.startAt)))throw new Error(`Некорректный матч в строке ${index+1}`);
    const known=catalogMatches(row,null),groups=[...new Map(known.map(r=>leagueStore.group(r)).filter(Boolean).map(g=>[g.id,g])).values()];return {...row,category:groups.length===1?groups[0].category:row.category,startAt:Number(row.startAt),league:String(row.league||'')};
  }).filter(row=>{const known=catalogMatches(row,categoryFor(row.category));return !known.length||!known.every(ref=>M.hidden(ref,state));});
  const candidates=[];
  const eventGroups=monitorEvents.map(event=>event.sourceRefs.map(r=>leagueStore.group(r)).find(Boolean));
  const groupCache=new Map();
  for(const [i,input] of inputs.entries())for(const [j,event] of monitorEvents.entries()){
    const category=categoryFor(input.category)||event.category;if(category!==event.category)continue;
    if(!event.sourceRefs.some(ref=>Math.abs(Number(ref.startAt)-input.startAt)<=120*60000))continue;
    const definitions=catalogMatches(input,category);if(!groupCache.has(definitions))groupCache.set(definitions,M.unique(definitions.map(ref=>leagueStore.group(ref)?.id)));const groups=groupCache.get(definitions);
    if(groups.length>1)continue; // an ambiguous league abbreviation is not proof
    const eventGroup=eventGroups[j];
    if(groups.length&&groups[0]!==eventGroup?.id)continue;
    if(eventGroup&&definitions.length&&!groups.length)continue;
    const manual=groups.length===1&&groups[0]===eventGroup?.id;
    const attempts=event.sourceRefs.map(ref=>eventMatchScore({...input,source:'external',category},{...ref,category:event.category},{mode:'prematch',manualLeague:manual,inferredLeague:manual?1:0})).filter(Boolean).sort((a,b)=>b.score-a.score);
    const best=attempts[0];if(best)candidates.push({i,j,score:best.score,teams:best.teams.score,league:best.league,time:best.time.score,minutes:best.time.minutes,swapped:best.teams.swapped,method:manual?'manual':'automatic'});
  }
  const accepted=candidates.filter(c=>!candidates.some(other=>other!==c&&(other.i===c.i||other.j===c.j)&&Math.abs(other.score-c.score)<.012&&Math.abs(other.minutes-c.minutes)<3));
  const lookup=new Map(accepted.map(c=>[`${c.i}:${c.j}`,c]));
  const matches=maximumAssignment(inputs.map((_,i)=>monitorEvents.map((_,j)=>lookup.get(`${i}:${j}`)?.score||0))).map(([i,j])=>lookup.get(`${i}:${j}`));
  const usedInput=new Set(matches.map(c=>c.i)),usedEvent=new Set(matches.map(c=>c.j));
  return {revision:rules.revision,hiddenInputs:inputRows.length-inputs.length,inputs,monitorEvents,matches:matches.map(c=>({...c,input:inputs[c.i],astek:monitorEvents[c.j]})),missingInput:inputs.filter((_,i)=>!usedInput.has(i)),onlyAstek:monitorEvents.filter((_,j)=>!usedEvent.has(j))};
}
