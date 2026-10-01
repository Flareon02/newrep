/* Shared with both extensions. Source IDs, not display names, own membership. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.LeagueModel=api;})(globalThis,()=>{
  const norm=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const unique=values=>[...new Set(values.filter(Boolean).map(String))].sort();
  const indexes=new WeakMap(),keyCache=new WeakMap(),exclusionCache=new WeakMap();
  const id=ref=>ref?.catalogId||`${ref?.source||'astek'}:${ref?.leagueId?`id:${ref.leagueId}`:`name:${norm(ref?.category)}:${norm(ref?.league)}`}`;
  const members=set=>[...(set.astekLeagues||[]),...(set.fonbetLeagues||[]),...(set.pinnacleLeagues||[]),...(set.ggbetLeagues||[])];
  const memberIds=set=>unique([...(set.astekLeagueIds||[]),...(set.fonbetLeagueIds||[]),...(set.pinnacleLeagueIds||[]),...(set.ggbetLeagueIds||[]),...members(set).map(id)]);
  const groupKey=set=>`logical:manual:${set.id}`;
  const nameKey=ref=>`name-alias:${ref.source}:${norm(ref.category)}:${norm(ref.league).replace(/\s+bo\s*[1357]$/,'')}`;
  function refKeys(ref={}){
    const source=['fonbet','pinnacle','ggbet','databet'].includes(ref.source)?ref.source:'astek';
    return unique([ref.leagueKey,ref.canonicalLeagueId,id(ref),ref.family?`logical:${String(ref.category).trim().toLowerCase()}:${ref.family}`:'',ref.leagueId?`${source!=='astek'?source+':':''}id:${ref.leagueId}`:'',
      !ref.leagueId?`${source!=='astek'?source+':':''}name:${String(ref.league||'').trim().toLowerCase()}`:'']);
  }
  function groupFor(ref,sets=[]){
    if(!ref)return null;
    let index=indexes.get(sets);if(!index){index=new Map();for(const set of sets)if(set.enabled!==false){for(const key of memberIds(set))index.set(key,set);index.set(groupKey(set),set);for(const member of members(set)){const key=nameKey(member);if(!index.has(key))index.set(key,set);else if(index.get(key)?.id!==set.id)index.set(key,null);}}indexes.set(sets,index);}
    const exact=index.get(id(ref));if(exact)return exact;
    // Astek uses different championship IDs between LIVE and line. A unique
    // provider/category/name alias is therefore a valid bridge. If two groups
    // share the same alias the index stores null and we deliberately refuse to
    // guess, preserving the safety of explicit IDs in ambiguous cases.
    return index.get(ref.canonicalLeagueId)||index.get(ref.leagueKey)||index.get(nameKey(ref))||null;
  }
  function setKeys(set){if(!keyCache.has(set))keyCache.set(set,unique([groupKey(set),...(set.legacyKeys||[]),...memberIds(set),...members(set).flatMap(refKeys)]));return keyCache.get(set);}
  function expandedKeys(keys=[],sets=[]){
    const result=new Set(keys);
    for(const set of sets){const candidates=setKeys(set);if(candidates.some(k=>result.has(k)))for(const k of candidates)result.add(k);}
    return [...result];
  }
  function eventKeys(event={},sets=[]){
    const refs=[event,...(event.sourceRefs||[]),...(event.leagueAliases||[])];
    return unique(refs.flatMap(ref=>{const group=groupFor(ref,sets);return [...refKeys(ref),...(group?setKeys(group):[])];}));
  }
  function hidden(event,state={},sets=state.publishedLeagueLinks||[]){
    const keys=state.excludedLeagueKeys||[];let cached=exclusionCache.get(keys);if(!cached||cached.sets!==sets){cached={sets,keys:new Set(expandedKeys(keys,sets))};exclusionCache.set(keys,cached);}const excluded=cached.keys;
    if(eventKeys(event,sets).some(k=>excluded.has(k)))return true;
    const categories=new Set(state.excludedCategoryKeys||[]);
    return [event,...(event.sourceRefs||[]),...(event.leagueAliases||[])].some(ref=>categories.has(ref.categoryKey)||categories.has(`category:${norm(ref.category||event.category)}`));
  }
  function ref(input,source=input?.source){
    const r={source,category:String(input.category||''),league:String(input.league||''),leagueId:String(input.leagueId||''),leagueKey:String(input.leagueKey||''),categoryKey:String(input.categoryKey||''),family:String(input.family||'')};
    r.catalogId=id(r);return r;
  }
  function shape(set){
    const side=source=>[...new Map((set[`${source}Leagues`]||[]).map(r=>{const row=ref(r,source);return[id(row),row];})).values()].sort((a,b)=>id(a).localeCompare(id(b)));
    const astekLeagues=side('astek'),fonbetLeagues=side('fonbet'),pinnacleLeagues=side('pinnacle'),ggbetLeagues=side('ggbet');
    return {...set,astekLeagues,fonbetLeagues,pinnacleLeagues,ggbetLeagues,pinnacleLeagueIds:pinnacleLeagues.map(id),ggbetLeagueIds:ggbetLeagues.map(id),astekLeagueIds:astekLeagues.map(id),fonbetLeagueIds:fonbetLeagues.map(id),source:'manual',enabled:true};
  }
  function connect(sets,selected,newId,now=Date.now(),category=''){
    const picked=selected.map(r=>ref(r,r.source));
    if(new Set(picked.map(id)).size<2)throw new Error('Выберите минимум два чемпионата.');
    if(!category&&new Set(picked.map(r=>norm(r.category))).size!==1)throw new Error('Связывайте чемпионаты одной дисциплины.');
    const chosen=new Set(picked.map(id));let joined=[],remaining=[...sets],changed=true;
    while(changed){changed=false;remaining=remaining.filter(set=>{if(memberIds(set).some(k=>chosen.has(k))){joined.push(set);memberIds(set).forEach(k=>chosen.add(k));changed=true;return false;}return true;});}
    joined.sort((a,b)=>Number(a.createdAt)-Number(b.createdAt)||a.id.localeCompare(b.id));
    const all=[...picked,...joined.flatMap(members)],anchor=joined[0];
    const set=shape({id:anchor?.id||newId,name:anchor?.name||'',category:category||anchor?.category||picked[0].category,astekLeagues:all.filter(r=>r.source==='astek'),fonbetLeagues:all.filter(r=>r.source==='fonbet'),pinnacleLeagues:all.filter(r=>r.source==='pinnacle'),ggbetLeagues:all.filter(r=>r.source==='ggbet'),
      createdAt:anchor?.createdAt||now,updatedAt:now,publishedAt:anchor?.publishedAt||null,legacyKeys:unique(joined.flatMap(s=>[...(s.legacyKeys||[]),groupKey(s)]))});
    return [...remaining,set];
  }
  const comparable=set=>JSON.stringify({id:set.id,name:set.name||'',category:set.category||'',astek:memberIds({astekLeagueIds:set.astekLeagueIds}),fonbet:memberIds({fonbetLeagueIds:set.fonbetLeagueIds}),pinnacle:memberIds({pinnacleLeagueIds:set.pinnacleLeagueIds}),ggbet:memberIds({ggbetLeagueIds:set.ggbetLeagueIds}),enabled:set.enabled!==false});
  function diff(base=[],working=[]){
    const old=new Map(base.map(s=>[s.id,s])),next=new Map(working.map(s=>[s.id,s]));
    return {upsert:working.filter(s=>!old.has(s.id)||comparable(s)!==comparable(old.get(s.id))),remove:base.filter(s=>!next.has(s.id)).map(s=>s.id)};
  }
  function applyDiff(base=[],changes={}){const map=new Map(base.map(s=>[s.id,s]));for(const id of changes.remove||[])map.delete(id);for(const set of changes.upsert||[])map.set(set.id,set);return [...map.values()];}
  function counts(base,changes){const ids=new Set(base.map(s=>s.id));return {add:changes.upsert.filter(s=>!ids.has(s.id)).length,change:changes.upsert.filter(s=>ids.has(s.id)).length,remove:changes.remove.length};}
  return {norm,unique,id,ref,members,memberIds,groupKey,refKeys,groupFor,setKeys,expandedKeys,eventKeys,hidden,shape,connect,diff,applyDiff,counts,comparable};
});
