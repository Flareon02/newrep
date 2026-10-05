'use strict';
/* History, loaded progressively (9.2 UX).

   The History tab never asks for the whole archive. It is a list of sections, each one a small server query:
     1. «Сейчас в LIVE»   phase=live
     2. «Сейчас в линии»  phase=line
     3. one section per day (today, yesterday, …) of matches already removed from line/LIVE: phase=removed with
        hours=24&end=<end of that day> — the server's existing `hours`/`end` window (server/src/ui-service.js).
   The first screen loads 1-3 and today; older days load one at a time (lazy, when the end of the list is reached, or
   by the explicit button). A small summary request (limit=1) gives the number of removed matches and the game facets,
   so the UI knows how many older matches remain and when the archive ends.

   - Results are cached per query (filters) and per section; a section is refreshed only when it is stale: the current
     sections after a server invalidation or after `freshMs.current`, a past day only after `freshMs.day`.
   - A query change (search, filters) aborts the requests of the previous query; its loaded sections stay cached, so
     going back to it is instant.
   - Pure JavaScript, no DOM: unit-tested in Node (extension/test/history-loader.test.mjs). */
(function(root){
 const DAY=86400000;
 function abortError(){const e=new Error('aborted');e.name='AbortError';return e;}

 function create({fetchPage,clock=()=>Date.now(),zoneOffsetMs=4*3600000,pageSize=200,firstPage={live:100,line:50,day:100},freshMs={current:60000,day:15*60000},maxEmptySkip=6,maxDaysBack=120,maxQueries=4,onChange=()=>{}}={}){
  const dayKey=ms=>new Date(ms+zoneOffsetMs).toISOString().slice(0,10);
  const dayStart=day=>Date.parse(day+'T00:00:00Z')-zoneOffsetMs;
  const shiftDay=(day,n)=>new Date(Date.parse(day+'T12:00:00Z')+n*DAY).toISOString().slice(0,10);
  const cache=new Map();let current=null,version=0;
  const changed=()=>{version++;try{onChange();}catch{}};

  function newQuery(key,{base,phase,hours}){
   return {key,base,phase:['live','line','removed'].includes(phase)?phase:'',hours:Number(hours)>0?Number(hours):0,sections:new Map(),days:[],summary:{state:'idle',total:null,facets:null,at:0,stale:false},controller:new AbortController(),emptyRun:0,paused:false,exhausted:false,createdAt:clock()};
  }
  // base: the URLSearchParams string of every filter except phase/hours/limit/offset (sources, q, category, …).
  function setQuery({base='',phase='',hours=0}={}){
   const key=[base,phase||'',Number(hours)||0].join('#');
   if(current?.key===key)return current;
   if(current){current.controller.abort(abortError());for(const s of current.sections.values())if(s.state==='loading')s.state=s.rows.length?'ready':'idle';if(current.summary.state==='loading')current.summary.state=current.summary.total==null?'idle':'ready';}
   let q=cache.get(key);
   if(q){cache.delete(key);q.controller=new AbortController();}
   else q=newQuery(key,{base,phase,hours});
   cache.set(key,q);while(cache.size>maxQueries)cache.delete(cache.keys().next().value);
   current=q;changed();return q;
  }
  const wantsCurrent=q=>q.phase===''||q.phase==='live'||q.phase==='line';
  const wantsDays=q=>q.phase===''||q.phase==='removed';
  const windowStart=q=>q.hours>0?clock()-q.hours*3600000:0;

  function section(q,id,init){let s=q.sections.get(id);if(!s){s={id,state:'idle',rows:[],total:0,hasMore:false,error:'',at:0,stale:false,facets:null,...init};q.sections.set(id,s);}return s;}
  function paramsFor(q,s,offset,limit){
   const p=new URLSearchParams(q.base);p.delete('phase');p.delete('hours');p.delete('end');p.delete('offset');p.set('limit',String(limit));if(offset>0)p.set('offset',String(offset));
   if(s.kind==='day'){
    const start=Math.max(dayStart(s.day),windowStart(q)),end=dayStart(s.day)+DAY-1;
    p.set('phase','removed');p.set('hours',String(Math.max(1/3600,(end-start)/3600000)));p.set('end',String(end));
   }else{p.set('phase',s.kind);if(q.hours)p.set('hours',String(q.hours));}
   return p.toString();
  }
  function isFresh(s){if(!s.at||s.stale)return false;const today=s.kind!=='day'||s.day===dayKey(clock());return clock()-s.at<(today?freshMs.current:freshMs.day);}

  async function run(q,s,{offset=0,refresh=false}={}){
   if(s.state==='loading')return s.promise;
   const first=Number(firstPage?.[s.kind])||pageSize,limit=refresh?Math.min(500,Math.max(first,s.rows.length)):offset>0?pageSize:first;
   s.state='loading';s.error='';changed();
   const signal=q.controller.signal;
   s.promise=(async()=>{
    try{
     const page=await fetchPage(paramsFor(q,s,offset,limit),{signal});
     if(signal.aborted||!q.sections.has(s.id))return;
     const events=Array.isArray(page?.events)?page.events:[];
     if(offset>0){const seen=new Set(s.rows.map(e=>String(e.id)));s.rows=s.rows.concat(events.filter(e=>!seen.has(String(e.id))));}
     else s.rows=events;
     s.total=Math.max(Number(page?.total)||0,s.rows.length);s.hasMore=s.rows.length<s.total;s.facets=page?.facets?.categories||null;
     s.at=clock();s.stale=false;s.state='ready';
     if(s.kind==='day'){if(s.total===0)q.emptyRun++;else q.emptyRun=0;}
    }catch(error){
     if(error?.name==='AbortError'||signal.aborted){if(s.state==='loading')s.state=s.rows.length?'ready':'idle';return;}
     s.state='error';s.error=error?.message||String(error);s.retryAfterMs=Number(error?.retryAfterMs)||0;
    }finally{s.promise=null;changed();}
    // An empty past day: continue to the next one while matches remain (bounded, see maxEmptySkip).
    if(s.kind==='day'&&s.state==='ready'&&s.total===0&&q===current&&s.id===q.days.at(-1))loadOlder();
   })();
   return s.promise;
  }
  async function loadSummary(q){
   const sm=q.summary;if(sm.state==='loading'||(sm.state==='ready'&&!sm.stale))return;
   sm.state='loading';changed();const signal=q.controller.signal;
   const p=new URLSearchParams(q.base);p.delete('phase');p.delete('offset');p.set('phase','removed');p.set('limit','1');if(q.hours)p.set('hours',String(q.hours));else p.delete('hours');
   try{const page=await fetchPage(p.toString(),{signal});if(signal.aborted)return;sm.total=Number(page?.total)||0;sm.facets=page?.facets?.categories||[];sm.at=clock();sm.stale=false;sm.state='ready';}
   catch(error){if(error?.name==='AbortError'||signal.aborted){sm.state=sm.total==null?'idle':'ready';return;}sm.state='error';sm.error=error?.message||String(error);}
   finally{changed();}
  }

  function addDay(q,day){const id='d:'+day;if(!q.sections.has(id)){section(q,id,{kind:'day',day});q.days.push(id);}return q.sections.get(id);}
  // First screen: LIVE and line now, today's archive and the summary right after them.
  function ensureInitial(){
   const q=current;if(!q)return;
   if(wantsCurrent(q))for(const kind of ['live','line'])if(q.phase===''||q.phase===kind){const s=section(q,kind,{kind});if(s.state!=='loading'&&s.state!=='error'&&!isFresh(s))run(q,s,{refresh:s.rows.length>0});}
   if(wantsDays(q)){
    // The day list starts at today; after midnight a cached query gets the new day on top.
    const todayId='d:'+dayKey(clock());
    if(q.days[0]!==todayId){section(q,todayId,{kind:'day',day:dayKey(clock())});q.days.unshift(todayId);}
    const today=q.sections.get(todayId);if(today.state!=='loading'&&today.state!=='error'&&!isFresh(today))run(q,today,{refresh:today.rows.length>0});
    loadSummary(q);
   }
  }
  function remaining(q=current){
   if(!q||!wantsDays(q)||q.summary.total==null)return null;
   let known=0;for(const id of q.days){const s=q.sections.get(id);if(s.state==='ready'||s.rows.length)known+=s.total;}
   return Math.max(0,q.summary.total-known);
  }
  function nextDay(q){const last=q.sections.get(q.days.at(-1));return last?shiftDay(last.day,-1):dayKey(clock());}
  function canLoadOlder(q=current){
   if(!q||!wantsDays(q)||q.exhausted)return false;
   const rest=remaining(q);if(rest===0)return false;
   const day=nextDay(q),startMs=windowStart(q);if(startMs&&dayStart(day)+DAY-1<startMs)return false;
   if(q.days.length>=maxDaysBack)return false;
   return true;
  }
  // Older history, one day at a time. Never more than one past day in flight.
  function loadOlder({user=false}={}){
   const q=current;if(!q||!wantsDays(q))return null;
   // Only the oldest loaded day (the frontier) blocks: a background refresh of today never swallows the user's click.
   const last=q.sections.get(q.days.at(-1));if(last?.state==='loading')return null;if(last?.state==='error')return run(q,last);
   if(user){q.paused=false;q.emptyRun=0;}
   if(q.paused)return null;
   if(!canLoadOlder(q)){if(q.summary.state==='ready'||q.days.length>=maxDaysBack)q.exhausted=remaining(q)===0||q.days.length>=maxDaysBack;changed();return null;}
   if(q.emptyRun>=maxEmptySkip){q.paused=true;changed();return null;}
   return run(q,addDay(q,nextDay(q)));
  }
  function loadMore(id){const q=current,s=q?.sections.get(id);if(!s||s.state==='loading'||!s.hasMore)return null;return run(q,s,{offset:s.rows.length});}
  function retry(id){const q=current;if(!q)return null;if(id==='summary'){q.summary.state='idle';return loadSummary(q);}const s=q.sections.get(id);if(!s)return null;return run(q,s,{refresh:s.rows.length>0});}
  // The server announced a change: what is happening now (LIVE, line, today) may differ; past days do not. The marked
  // sections are reloaded by refresh() - the caller decides how often (a render never triggers it).
  function invalidate(){for(const q of cache.values()){for(const s of q.sections.values())if(s.kind!=='day'||s.day===dayKey(clock()))s.invalid=true;q.summary.invalid=true;}}
  function refresh(){const q=current;if(!q)return 0;let n=0;for(const s of q.sections.values())if(s.invalid&&s.state!=='loading'){s.invalid=false;n++;run(q,s,{refresh:s.rows.length>0});}if(q.summary.invalid){q.summary.invalid=false;q.summary.stale=true;n++;loadSummary(q);}return n;}
  function sections(){
   const q=current;if(!q)return [];
   const out=[];if(wantsCurrent(q))for(const kind of ['live','line'])if((q.phase===''||q.phase===kind)&&q.sections.has(kind))out.push(q.sections.get(kind));
   for(const id of q.days)out.push(q.sections.get(id));
   return out;
  }
  // Game counts for the game menu. The server counts them before the phase/game/time filters, so one answer already
  // covers LIVE, line and the archive: the summary's when it is there, else the LIVE or line section's.
  function facets(){const q=current;if(!q)return null;return q.summary.facets||q.sections.get('live')?.facets||q.sections.get('line')?.facets||q.sections.get(q.days[0])?.facets||null;}
  function total(){const q=current;if(!q)return 0;let n=0;for(const kind of ['live','line'])n+=q.sections.get(kind)?.total||0;if(wantsDays(q))n+=q.summary.total??sections().filter(s=>s.kind==='day').reduce((a,s)=>a+s.total,0);return n;}
  function status(){const q=current;if(!q)return null;return {key:q.key,loading:[...q.sections.values()].some(s=>s.state==='loading'),loadingOlder:q.sections.get(q.days.at(-1))?.state==='loading',remaining:remaining(q),canLoadOlder:canLoadOlder(q),paused:q.paused,exhausted:q.exhausted||(q.summary.state==='ready'&&remaining(q)===0),summary:q.summary.state,next:wantsDays(q)?nextDay(q):'',total:total()};}
  function find(id){const q=current;if(!q)return null;for(const s of q.sections.values()){const e=s.rows.find(x=>String(x.id)===String(id));if(e)return e;}return null;}
  // A small copy for an instant first paint after a restart (shown as stale, refreshed at once).
  function snapshot(maxRows=300){const q=current;if(!q)return null;let budget=maxRows;const take=s=>{const rows=s.rows.slice(0,Math.max(0,budget));budget-=rows.length;return {id:s.id,kind:s.kind,day:s.day,rows,total:s.total};};return {key:q.key,base:q.base,phase:q.phase,hours:q.hours,at:clock(),sections:sections().filter(s=>s.state==='ready').slice(0,3).map(take),summary:{total:q.summary.total,facets:q.summary.facets}};}
  function restore(snap){
   if(!snap?.key||!Array.isArray(snap.sections)||cache.has(snap.key))return false;
   const q=newQuery(snap.key,snap);for(const x of snap.sections){if(x.kind==='day'&&x.day!==dayKey(clock())&&!q.days.length)continue;const s=section(q,x.id,{kind:x.kind,day:x.day});s.rows=x.rows||[];s.total=Math.max(Number(x.total)||0,s.rows.length);s.hasMore=s.rows.length<s.total;s.state='ready';s.at=Number(snap.at)||1;s.stale=true;if(x.kind==='day')q.days.push(x.id);}
   if(snap.summary?.total!=null){q.summary={state:'ready',total:snap.summary.total,facets:snap.summary.facets||null,at:Number(snap.at)||1,stale:true};}
   cache.set(snap.key,q);return true;
  }
  function abort(){current?.controller.abort(abortError());if(current){for(const s of current.sections.values())if(s.state==='loading')s.state=s.rows.length?'ready':'idle';if(current.summary.state==='loading')current.summary.state='idle';current.controller=new AbortController();}}
  return {setQuery,ensureInitial,loadOlder,loadMore,retry,invalidate,refresh,sections,facets,remaining,status,find,snapshot,restore,abort,version:()=>version,current:()=>current,dayKey,shiftDay,dayStart};
 }
 const api={create};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.HistoryLoader=api;
})(globalThis);
