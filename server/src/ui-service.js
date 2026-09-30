import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Model=require('./league-model.cjs');
const Ledger=require('./ui-event-ledger.cjs');

const PROVIDERS=['astek','fonbet','pinnacle','ggbet'];
const EXTRA=/\b(?:awp|sniper|player)?\s*(?:kills?|frags?)\s*comparisons?\b|\bcomparisons?\s+(?:by|on)\s+(?:kills?|frags?|maps?|rounds?)\b|\b(?:maps?|rounds?)\s*comparisons?\b|\bplayer\s+(?:kills?|frags?)\b/i;
const refs=e=>e?.sourceRefs?.length?e.sourceRefs:[e].filter(Boolean);
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const sourceRefKey=r=>`${r?.source||''}:${String(r?.sourceEventId||r?.id||'').replace(/^fonbet-(?:result-)?/,'')}`;
const isExtra=e=>[e,...refs(e)].some(r=>r?.marketKind&&r.marketKind!=='main'||EXTRA.test([r?.league,r?.team1,r?.team2,r?.name].filter(Boolean).join(' ')));

export function decorateUiEvent(event,links=[]){
  if(!event)return event;
  const sourceRefs=refs(event).map(r=>({...r,catalogId:r.catalogId||Model.id(r)}));
  const group=sourceRefs.map(r=>Model.groupFor(r,links)).find(Boolean)||Model.groupFor(event,links);
  const e={...event,sourceRefs};
  if(group){e.category=group.category||e.category;e.league=group.name||e.league;e.leagueKey=Model.groupKey(group);}
  e.category=String(e.category||'Esports');
  e.ui={sourceCount:new Set(sourceRefs.map(r=>r.source)).size,providers:[...new Set(sourceRefs.map(r=>r.source))],extra:isExtra(e)};
  return e;
}

export function mergeUiLedger({prematchHistory=[],liveHistory=[],currentPrematch=[],currentLive=[],results=[],date='',links=[]}={}){
  const batches=[];
  if(prematchHistory.length)batches.push({events:prematchHistory,phase:'prematch'});
  if(liveHistory.length)batches.push({events:liveHistory,phase:'live'});
  if(results.length)batches.push({events:results,phase:'results',date});
  if(currentPrematch.length)batches.push({events:currentPrematch,phase:'prematch',current:true});
  if(currentLive.length)batches.push({events:currentLive,phase:'live',current:true});
  return Ledger.build(batches).map(e=>decorateUiEvent(e,links));
}

export function buildUiPrematchEvents(currentPrematch=[],currentLive=[],links=[]){
  return mergeUiLedger({currentPrematch,currentLive,links})
    .filter(e=>e.inPrematch&&!(e.sourceRefs?.length?e.sourceRefs:[e]).some(r=>r.inLive));
}

export function enrichResultsWithPrematch(events,prematchRows=[]){
  const byKey=new Map();
  for(const event of prematchRows)for(const r of refs(event)){
    const key=sourceRefKey(r),old=byKey.get(key),at=Number(r.firstPrematchAt||r.firstSeenAt||0);
    if(!old||at&&at<Number(old.firstPrematchAt||old.firstSeenAt||Infinity))byKey.set(key,r);
  }
  return (events||[]).map(event=>{
    const sourceRefs=refs(event).map(r=>{
      const pre=byKey.get(sourceRefKey(r));if(!pre)return r;
      const at=Number(pre.firstPrematchAt||pre.firstSeenAt||0);
      const lifecycle=[...(r.lifecycle||[])];
      if(at&&!lifecycle.some(x=>x.phase==='prematch'&&x.type==='entered'&&Number(x.at)===at))lifecycle.push({phase:'prematch',type:'entered',at});
      return {...r,firstPrematchAt:at||Number(r.firstPrematchAt||0),lifecycle:lifecycle.sort((a,b)=>Number(a.at)-Number(b.at))};
    });
    const firstPrematchAt=Math.min(...sourceRefs.map(r=>Number(r.firstPrematchAt||0)).filter(Boolean));
    return {...event,sourceRefs,firstPrematchAt:Number.isFinite(firstPrematchAt)?firstPrematchAt:Number(event.firstPrematchAt||0)};
  });
}

function eventClock(e,view){
  if(view==='history')return Math.max(...refs(e).map(r=>Number(r.firstPrematchAt||r.firstSeenAt||0)),0);
  if(view==='results')return Number(e.endedAt||e.removedAt||e.lastSeenAt||e.startAt||0);
  return Number(e.startAt||0);
}

export function queryUiEvents(events,params={},rules={},view='results'){
  const links=rules.links||[],q=norm(params.q||''),tokens=q.split(' ').filter(Boolean),category=norm(params.category||''),availability=String(params.availability||'all'),sources=new Set(String(params.sources||PROVIDERS.join(',')).split(',').filter(s=>PROVIDERS.includes(s))),showExtras=String(params.showExtras??'1')!=='0';
  const hidden=String(params.hidden||'').split(',').filter(Boolean),favorites=new Set(String(params.favorites||'').split(',').filter(Boolean));
  const favoriteOnly=String(params.favoriteOnly||'0')==='1';
  const state={publishedLeagueLinks:links,excludedLeagueKeys:[...hidden,...(rules.visibility?.excludedLeagueKeys||[])],excludedCategoryKeys:rules.visibility?.excludedCategoryKeys||[]};
  let rows=(events||[]).map(e=>e?.ui&&Array.isArray(e.sourceRefs)?e:decorateUiEvent(e,links)).filter(e=>{
    const rr=refs(e).filter(r=>sources.has(r.source));if(!rr.length)return false;
    const distinct=new Set(rr.map(r=>r.source));
    if(availability==='both'&&distinct.size<2)return false;
    if(availability==='unique'&&distinct.size!==1)return false;
    if(PROVIDERS.includes(availability)&&!distinct.has(availability))return false;
    if(!showExtras&&isExtra(e))return false;
    if(Model.hidden(e,state,links))return false;
    if(favoriteOnly){const keys=[e.leagueKey,...rr.flatMap(r=>[Model.id(r),sourceRefKey(r)]),...(e.entityAliases||[])];if(!keys.some(k=>favorites.has(k)))return false;}
    if(tokens.length){const hay=norm([e.category,e.league,e.team1,e.team2,...(e.leagueAliases||[]).map(r=>r.league)].join(' '));if(!tokens.every(t=>hay.includes(t)))return false;}
    return true;
  });
  const categoryCounts=new Map();for(const e of rows){const name=String(e.category||'Esports');categoryCounts.set(name,(categoryCounts.get(name)||0)+1);}const facets={categories:[...categoryCounts].map(([name,count])=>({name,count})).sort((a,b)=>a.name.localeCompare(b.name,'en',{sensitivity:'base',numeric:true}))};
  if(category)rows=rows.filter(e=>norm(e.category)===category);
  const now=Date.now(),hours=Number(params.hours||0),end=Number(params.end||0)||now;if(hours>0&&['history','results'].includes(view)){const span=hours*3600000;rows=rows.filter(e=>{const at=eventClock(e,view);return at>0&&at<=end&&at>=end-span;});}
  if(view==='history'){const futureHours=Number(params.historyStartHours||0);if(futureHours>0)rows=rows.filter(e=>{const at=Number(e.startAt||0);return at>=now&&at<=now+futureHours*3600000;});const phase=String(params.phase||'');if(phase)rows=rows.filter(e=>refs(e).some(r=>phase==='live'?r.inLive:phase==='line'?r.inPrematch&&!r.inLive:phase==='removed'?!r.inPrematch&&!r.inLive:true));}
  rows.sort((a,b)=>eventClock(b,view)-eventClock(a,view)||String(a.id).localeCompare(String(b.id)));
  const total=rows.length,offset=Math.max(0,Number(params.offset)||0),limit=Math.max(1,Math.min(500,Number(params.limit)||100));
  return {total,offset,limit,hasMore:offset+limit<total,events:rows.slice(offset,offset+limit),facets};
}


const THIN_REF_KEYS=[
  'id','sourceEventId','source','catalogId','category','categoryKey','league','leagueId','leagueKey','url','startAt',
  'firstSeenAt','enteredLiveAt','firstPrematchAt','removedAt','endedAt','resultVerified','scoreText','seriesScore',
  'mapScores','activeMap','bestOf','scoreReversed','aliases','inLive','inPrematch','marketKind'
];
const THIN_EVENT_KEYS=[
  'id','category','categoryKey','league','leagueKey','team1','team2','team1Logo','team2Logo','startAt','firstSeenAt',
  'enteredLiveAt','firstPrematchAt','removedAt','endedAt','resultVerified','scoreText','seriesScore','mapScores','activeMap',
  'bestOf','inLive','inPrematch','phase','entityAliases','displayLeague','marketKind'
];
const ZERO_DEFAULT_KEYS=new Set(['enteredLiveAt','firstPrematchAt','removedAt','endedAt','activeMap','bestOf']);
function pickKeys(value,keys){
  const out={};
  for(const key of keys){
    const v=value?.[key];
    if(v===undefined||v===null||v===''||v===false)continue;
    if(Array.isArray(v)&&v.length===0)continue;
    if(ZERO_DEFAULT_KEYS.has(key)&&Number(v)===0)continue;
    if(key==='marketKind'&&v==='main')continue;
    out[key]=v;
  }
  return out;
}
function compactTimeline(ref){
  const rows=Array.isArray(ref?.timeline)&&ref.timeline.length?ref.timeline:Array.isArray(ref?.lifecycle)?ref.lifecycle:[];
  const seen=new Set(),out=[];
  for(const row of rows){
    if(!row||typeof row!=='object')continue;
    const type=String(row.type||''),phase=String(row.phase||''),at=Number(row.at||0);if(!type||!(at>0))continue;
    const key=`${phase}:${type}:${at}`;if(seen.has(key))continue;seen.add(key);
    out.push(phase?{phase,type,at}:{type,at});
  }
  return out;
}
export function compactUiRef(ref){
  if(!ref||typeof ref!=='object')return ref;
  const out=pickKeys(ref,THIN_REF_KEYS),timeline=compactTimeline(ref);
  const canonical=`${ref.source||''}:${ref.sourceEventId||ref.id||''}`;
  if(Array.isArray(out.aliases)){
    const aliases=[...new Set(out.aliases.map(String).filter(Boolean))].filter(x=>x!==canonical);
    if(aliases.length)out.aliases=aliases;else delete out.aliases;
  }
  if(timeline.length)out.timeline=timeline;
  return out;
}
export function compactUiEvent(event){
  if(!event||typeof event!=='object')return event;
  const out=pickKeys(event,THIN_EVENT_KEYS),sourceRefs=refs(event).map(compactUiRef);
  out.sourceRefs=sourceRefs;
  const logo1=out.team1Logo||refs(event).find(r=>r.team1Logo)?.team1Logo||'';
  const logo2=out.team2Logo||refs(event).find(r=>r.team2Logo)?.team2Logo||'';
  if(logo1)out.team1Logo=logo1;else delete out.team1Logo;
  if(logo2)out.team2Logo=logo2;else delete out.team2Logo;
  if(out.displayLeague===out.league)delete out.displayLeague;
  return out;
}
export function compactUiPayload(payload){
  if(!payload||typeof payload!=='object')return payload;
  return {...payload,events:Array.isArray(payload.events)?payload.events.map(compactUiEvent):payload.events,thin:true,uiSchemaVersion:2};
}

function leagueText(s){return String(s||'').toLowerCase().replace(/\b(?:bo|best of)\s*[1357]\b/g,'').replace(/(?:counter[ -]?strike(?: 2)?|cs\s*2|dota\s*2|esports)\s*[-.:]?/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
function categoryOk(a,b){return a.category===b.category||a.category==='Esports'||b.category==='Esports';}
function rankLeagues(catalog,currentEvents,selected=[]){
  const all=Object.values(catalog.providers||{}).flat(),fixtures=new Map(),rows=new Map();
  for(const r of all){const clean=leagueText(r.league),tokens=new Set(clean?clean.split(' '):[]);rows.set(r.id||Model.id(r),{r,clean,tokens});}
  for(const e of currentEvents||[])for(const r of refs(e)){const id=Model.id(r);if(!fixtures.has(id))fixtures.set(id,[]);fixtures.get(id).push({key:[leagueText(e.team1),leagueText(e.team2)].sort().join('|'),at:r.startAt||e.startAt});}
  const selectedRows=all.filter(r=>selected.includes(r.id||Model.id(r))),score=new Map(),tokenIndex=new Map(),fixtureIndex=new Map();
  if(!selectedRows.length){for(const r of all){const meta=rows.get(r.id||Model.id(r));for(const token of meta.tokens){if(!tokenIndex.has(token))tokenIndex.set(token,[]);tokenIndex.get(token).push(r);}}for(const r of all){const id=r.id||Model.id(r);for(const f of fixtures.get(id)||[]){if(!fixtureIndex.has(f.key))fixtureIndex.set(f.key,[]);fixtureIndex.get(f.key).push({r,at:f.at});}}}
  for(const a of all){const aid=a.id||Model.id(a),am=rows.get(aid),aa=fixtures.get(aid)||[];let best=0,candidates;if(selectedRows.length)candidates=selectedRows;else{const set=new Set();for(const token of am.tokens)for(const r of tokenIndex.get(token)||[])set.add(r);for(const f of aa)for(const item of fixtureIndex.get(f.key)||[])if(Math.abs(f.at-item.at)<10800000)set.add(item.r);candidates=[...set];}for(const b of candidates){if(a.source===b.source||!categoryOk(a,b))continue;const bid=b.id||Model.id(b),bm=rows.get(bid),bb=fixtures.get(bid)||[];const common=aa.filter(x=>bb.some(y=>x.key===y.key&&Math.abs(x.at-y.at)<10800000)).length;let n=0;if(am.clean&&bm.clean){if(am.clean===bm.clean)n=1;else{let shared=0;for(const t of am.tokens)if(bm.tokens.has(t))shared++;n=shared/new Set([...am.tokens,...bm.tokens]).size;}}best=Math.max(best,common?Math.min(100,75+25*common/Math.max(1,aa.length)):Math.round(n*70));}score.set(aid,Math.round(best));}
  return score;
}

export function queryLeagueCatalog(catalog,currentEvents=[],params={}){
  const q=norm(params.q||''),tokens=q.split(' ').filter(Boolean),selected=String(params.selected||'').split(',').filter(Boolean),score=rankLeagues(catalog,currentEvents,selected),metrics=new Map();
  for(const event of currentEvents||[]){const multi=new Set(refs(event).map(x=>x.source)).size>1;for(const ref of refs(event)){const id=Model.id(ref),m=metrics.get(id)||{events:0,matched:0};m.events++;if(multi)m.matched++;metrics.set(id,m);}}
  const limit=Math.max(20,Math.min(500,Number(params.limit)||120)),providers={};const totals={};
  for(const source of PROVIDERS){let rows=(catalog.providers?.[source]||[]).filter(r=>!tokens.length||tokens.every(t=>norm(r.league+' '+r.category).includes(t))).map(r=>{const id=r.id||Model.id(r),m=metrics.get(id)||{events:0,matched:0};return {...r,id,suggestion:score.get(id)||0,fixtureEvents:m.events,fixtureMatched:m.matched,matchedPercent:m.events?Math.round(m.matched/m.events*100):null};});rows.sort((a,b)=>b.suggestion-a.suggestion||Number(b.current||0)-Number(a.current||0)||String(a.league).localeCompare(String(b.league),'en',{sensitivity:'base',numeric:true}));totals[source]=rows.length;providers[source]=rows.slice(0,limit);}
  return {schemaVersion:2,revision:catalog.revision,visibilityRevision:catalog.visibilityRevision,links:catalog.links||[],visibility:catalog.visibility||{},generatedAt:Date.now(),providers,totals,limit,query:q};
}
