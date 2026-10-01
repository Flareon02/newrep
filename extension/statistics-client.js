/* Match-statistics discovery is intentionally separate from card rendering.
   Availability is refreshed periodically, while detail streams are shared and capped.
   The cap matters because the production endpoint is HTTP/1.1: too many EventSource
   connections can consume every per-origin browser socket and block normal fetches. */
const StatisticsClient=(()=>{
 let ctx,loading=false,last=0,key='',available={},availableShape='',error='',statusCode=0,observed=[],queued=false,timer=0;
 const CHECK_MS=15000,HIDDEN_CHECK_MS=60000,MAX_DETAIL_STREAMS=2,streams=new Map(),streamQueue=[];
 const queries=e=>({id:e.id,view:ctx?.view?.()||'',category:e.category,league:e.league,leagueKey:e.leagueKey,team1:e.team1,team2:e.team2,startAt:e.startAt,entityAliases:e.entityAliases,sourceRefs:(e.sourceRefs||[e]).map(r=>({source:r.source,sourceEventId:r.sourceEventId||r.id,aliases:r.aliases}))});
 const messageForStatus=status=>[404,405].includes(status)
  ?'Статистика недоступна на этом сервере (HTTP '+status+'). Проверьте совместимость сервера и расширения.'
  :'Статистика: сервер недоступен (HTTP '+status+').';
 async function observe(rows=observed,{force=false}={}){
  if(!ctx)return;observed=Array.isArray(rows)?rows:[];
  const events=observed.filter(e=>/dota|counter|cs2/i.test(e.category||'')).slice(0,500).map(queries),next=JSON.stringify(events),now=Date.now();
  if(loading){queued=queued||next!==key||force;return;}
  if(!force&&next===key&&now-last<CHECK_MS)return;
  loading=true;last=now;key=next;const priorError=error;
  try{
   const r=await fetch(ctx.base+'/api/statistics/availability',{method:'POST',headers:ServerConfig.headers({'Content-Type':'application/json'}),body:JSON.stringify({events}),cache:'no-store',signal:AbortSignal.timeout(12000)});
   statusCode=r.status||200;if(!r.ok)throw Error(messageForStatus(r.status));
   const raw=await r.json();
   if(!raw||Array.isArray(raw)||typeof raw!=='object'||Object.values(raw).some(v=>!v||!['dota2','cs2','hawk','crossbet'].includes(v.provider)||!v.id))throw Error('Сервер вернул некорректный ответ статистики.');
   const data=Object.fromEntries(Object.entries(raw).map(([id,v])=>[id,{...v,provider:v.provider==='hawk'?'dota2':v.provider==='crossbet'?'cs2':v.provider}]));
   error='';
   const shape=JSON.stringify(Object.entries(data).sort(([a],[b])=>a.localeCompare(b)).map(([eventId,v])=>[eventId,v.provider,String(v.id)]));
   available=data;
   if(shape!==availableShape||priorError){availableShape=shape;ctx.render();}
  }catch(e){error=e.name==='TimeoutError'?'Статистика: сервер не ответил вовремя.':'Статистика: '+ServerConfig.errorText(e)+'.';if(error!==priorError)ctx.render();}
  finally{
   loading=false;
   if(queued){queued=false;queueMicrotask(()=>observe(observed,{force:true}));}
  }
 }
 const info=e=>{const keys=[e?.id,...(e?.entityAliases||[]),...(e?.sourceRefs||[e]||[]).flatMap(r=>[r?.sourceEventId,r?.id,...(r?.aliases||[])])].filter(Boolean).map(String);for(const key of keys)if(available[key])return available[key];return undefined;};
 async function get(e){const v=info(e);if(!v)return {matched:false};const data=await ctx.request('/api/statistics/match?id='+encodeURIComponent(v.id));return {...data,archived:data.archived||!e.inLive};}
 const activeStreamCount=()=>[...streams.values()].filter(s=>s.source).length;
 function removeQueued(entry){const i=streamQueue.indexOf(entry);if(i>=0)streamQueue.splice(i,1);}
 function stopEntry(entry){removeQueued(entry);entry.source?.close();entry.source=null;}
 function startEntry(entry){
  if(entry.source||!entry.listeners.size||!window.EventSource||activeStreamCount()>=MAX_DETAIL_STREAMS)return false;
  const source=new EventSource(ctx.base+'/api/statistics/stream?id='+encodeURIComponent(entry.id));entry.source=source;
  source.onmessage=event=>{let data;try{data={...JSON.parse(event.data),receivedAt:Date.now(),streamConnected:true};}catch{return;}for(const listener of [...entry.listeners])try{listener(data);}catch{}};
  source.onerror=()=>{entry.lastErrorAt=Date.now();};
  return true;
 }
 function pumpStreams(){
  for(const entry of [...streamQueue]){
   if(activeStreamCount()>=MAX_DETAIL_STREAMS)break;
   removeQueued(entry);
   if(entry.listeners.size)startEntry(entry);
  }
 }
 function subscribe(e,update){
  const v=info(e);if(!v||!e.inLive||!window.EventSource)return ()=>{};
  const id=String(v.id);let entry=streams.get(id);
  if(!entry){entry={id,listeners:new Set(),source:null,lastErrorAt:0};streams.set(id,entry);}
  entry.listeners.add(update);
  if(!entry.source&&!streamQueue.includes(entry)){if(!startEntry(entry))streamQueue.push(entry);}
  const unsubscribe=()=>{entry.listeners.delete(update);if(entry.listeners.size)return;if(entry.source)entry.source.close();entry.source=null;removeQueued(entry);streams.delete(id);pumpStreams();};
  Object.defineProperty(unsubscribe,'streaming',{get:()=>!!entry.source});
  return unsubscribe;
 }
 function schedule(){clearTimeout(timer);timer=setTimeout(async()=>{if(!document.hidden&&ctx?.active?.()!==false)await observe(observed);schedule();},document.hidden?HIDDEN_CHECK_MS:CHECK_MS);}
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&ctx?.active?.()!==false)observe(observed,{force:true});schedule();});
 window.addEventListener('pagehide',()=>{for(const entry of streams.values())entry.source?.close();streams.clear();streamQueue.length=0;});
 schedule();
 return {configure:c=>ctx=c,observe,info,get,subscribe,status:()=>({checkedAt:last,error,statusCode,available:Object.keys(available).length,detailStreams:activeStreamCount(),queuedStreams:streamQueue.length}),warning:()=>error,logo:v=>typeof v==='string'&&/^\/api\/team-logos\/[a-f0-9]{32}$/.test(v)?ctx.base+v:v};
})();
