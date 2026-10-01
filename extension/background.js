importScripts('server-config.js','league-model.js','feed-push.js');
const PUSH_CHECKPOINT_MS=120000,STREAM_STALL_MS=50000;
// Bumped whenever the server address/token changes; a response that belongs to an older epoch is discarded instead of
// polluting the cache of the new server with the old server's data or failure.
let epoch=0;
const inflight=new Map(),lastAttempt={},ports=new Set(),portActivity=new WeakMap(),seenSets=new Map(),failures={},retryAfter={};let cache={},prefs={},seen={},lastPersistAt=0,schedulerTimer=null,streamAbort=null,streamRetryTimer=null,streamHealthy=false,streamRunning=false,streamFailures=0,streamLastAt=0;
const boot=Promise.all([chrome.storage.local.get(['prefs','seenEvents']),ServerConfig.ready]).then(([data])=>{cache={};prefs=data.prefs||{};seen=data.seenEvents||{};chrome.storage.local.remove(['historyCache','snapshots']).catch(()=>{});});
function wantsBackgroundFeeds(){return !!(prefs.notifications?.live||prefs.notifications?.prematch);}
async function configureBackgroundAlarm(){if(wantsBackgroundFeeds()){const alarm=await chrome.alarms.get('feeds');if(!alarm)chrome.alarms.create('feeds',{periodInMinutes:0.5});}else await chrome.alarms.clear('feeds');}
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.prefs){prefs=changes.prefs.newValue||{};configureBackgroundAlarm().catch(()=>{});if((changes.prefs.oldValue?.generatorEnabled===true||!changes.prefs.oldValue?.features630)&&(prefs.hideOdds!==false||prefs.generatorEnabled!==true))chrome.tabs.query({url:chrome.runtime.getURL('odds.html')+'*'}).then(tabs=>Promise.all(tabs.map(t=>chrome.tabs.remove(t.id)))).catch(()=>{});}});
// A changed server address or token invalidates everything received so far: drop the cache and reconnect.
chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local'||!changes.server)return;epoch++;inflight.clear();cache={};for(const key of Object.keys(failures))delete failures[key];for(const key of Object.keys(retryAfter))delete retryAfter[key];if(ports.size){stopFeedStream();setTimeout(()=>{startFeedStream();scheduleFeeds(0);},300);}});
async function open(){await boot;const url=chrome.runtime.getURL('app.html'),tabs=await chrome.tabs.query({url}),type=prefs.openMode==='tab'?'normal':'popup';for(const tab of tabs){const win=await chrome.windows.get(tab.windowId);if(win.type===type){await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(win.id,{focused:true});return;}}if(type==='popup')await loadedWindow(url,1060,850);else await chrome.tabs.create({url});}
chrome.action.onClicked.addListener(open);
chrome.notifications.onClicked.addListener(open);
function logicalKey(e){const clean=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');return 'match:'+JSON.stringify([clean(e.category),...([e.team1,e.team2].map(clean).sort()),Number(e.startAt||0)]);}
function notificationLeague(e){let title=String(e.league||e.category||'Киберспорт').replace(/\b(?:bo|best[ -]*of)\s*[1357]\b/gi,'').replace(/[.\s]+$/g,'');const category=String(e.category||'');for(const prefix of [category,category==='Counter Strike 2'?'CS 2':'',category==='Dota 2'?'Dota 2':''])if(prefix&&title.toLowerCase().startsWith(prefix.toLowerCase())){title=title.slice(prefix.length).replace(/^[. :–—-]+/,'');break;}return title||category||'Киберспорт';}
async function notifyNew(kind,snapshot){
 const before=seenSets.get(kind)||new Set(seen[kind]||[]);if(!seenSets.has(kind))seenSets.set(kind,before);const all=snapshot.events||[];
 const ids=all.flatMap(e=>[logicalKey(e),...(e.sourceRefs||[e]).map(r=>`${r.source}:${r.sourceEventId||r.id}`)]);
 if(seen[kind]&&prefs.notifications?.[kind]){
  const rules=snapshot.leagueRules||{},hidden={publishedLeagueLinks:rules.links||[],excludedLeagueKeys:[...(prefs.hiddenLeagues||[]),...(prefs.hiddenLeaguesByView?.[kind]||[]),...(rules.visibility?.excludedLeagueKeys||[])],excludedCategoryKeys:rules.visibility?.excludedCategoryKeys||[]};
  let fresh=all.filter(e=>(e.sourceRefs||[e]).some(r=>prefs[r.source]!==false&&!before.has(`${r.source}:${r.sourceEventId||r.id}`))&&!LeagueModel.hidden(e,hidden));
  if(prefs.notifications.deduplicate)fresh=fresh.filter(e=>{
   const refs=e.sourceRefs||[e];
   return !refs.some(r=>before.has(`${r.source}:${r.sourceEventId||r.id}`))&&!before.has(logicalKey(e));
  });
  if(prefs.notifications.favoritesOnly)fresh=fresh.filter(e=>[e.leagueKey,...(e.sourceRefs||[e]).map(r=>`${r.source}:${r.sourceEventId||r.id}`)].some(id=>(prefs.favorites||[]).includes(id)));
  for(const [index,e] of fresh.slice(0,8).entries()){
   const newRefs=(e.sourceRefs||[e]).filter(r=>prefs[r.source]!==false&&!before.has(`${r.source}:${r.sourceEventId||r.id}`));
   const books=[...new Set((newRefs.length?newRefs:e.sourceRefs||[e]).map(r=>({astek:'AstekBet',fonbet:'Fonbet',pinnacle:'Pinnacle',ggbet:'GGBET'})[r.source]||r.provider||r.source).filter(Boolean))].join(' + ');
   await chrome.notifications.create(`${kind}-${Date.now()}-${index}`,{type:'basic',iconUrl:'icons/icon128.png',title:notificationLeague(e),message:`${e.team1} - ${e.team2}`,contextMessage:books,priority:0,silent:prefs.notifications.sound!==true});
  }
  if(fresh.length>8)await chrome.notifications.create(`${kind}-${Date.now()}-more`,{type:'basic',iconUrl:'icons/icon128.png',title:kind==='live'?'Ещё новые LIVE':'Ещё новые в линии',message:`Ещё событий: ${fresh.length-8}`,priority:0,silent:true});
 }
 let changed=false;for(const id of ids)if(!before.has(id)){before.add(id);changed=true;}
 if(before.size>20000){const trimmed=[...before].slice(-20000);before.clear();for(const id of trimmed)before.add(id);changed=true;}
 if(changed||!seen[kind])seen[kind]=[...before];
 return changed;
}

function activeMonitorState(){
 const states=[...ports].map(port=>portActivity.get(port)||{visible:true,tab:'live'}),visible=states.filter(state=>state.visible!==false);
 return {connected:states.length,visible:visible.length,liveVisible:visible.some(state=>state.tab==='live')};
}
function pollInterval(kind){const state=activeMonitorState();if(streamHealthy&&state.connected)return kind==='live'?60000:120000;if(kind==='prematch')return 60000;return state.liveVisible?5000:state.visible?8000:state.connected?15000:30000;}
function retryDelay(kind,count){const base=kind==='live'?5000:15000,max=kind==='live'?60000:300000;return Math.min(max,base*Math.pow(2,Math.max(0,count-1)))+Math.floor(Math.random()*750);}
function nextSchedulerDelay(){const now=Date.now(),due=['live','prematch'].map(kind=>Math.max((lastAttempt[kind]||0)+pollInterval(kind),retryAfter[kind]||0));return Math.max(250,Math.min(60000,Math.min(...due)-now));}
function scheduleFeeds(delay){clearTimeout(schedulerTimer);schedulerTimer=null;if(!ports.size)return;schedulerTimer=setTimeout(async()=>{schedulerTimer=null;await poll('live');await poll('prematch');scheduleFeeds(nextSchedulerDelay());},Math.max(0,delay??nextSchedulerDelay()));}
async function poll(kind,force=false){
 await boot;const now=Date.now(),interval=pollInterval(kind);
 if(inflight.has(kind))return inflight.get(kind);
 if(!force&&now<(retryAfter[kind]||0))return cache[kind];
 if(!force&&now-(lastAttempt[kind]||0)<interval)return cache[kind];
 lastAttempt[kind]=now;
 const run=(async()=>{
  const myEpoch=epoch;
  try{
   // LIVE is already server-resolved. The line uses the thin-client endpoint,
   // where the server also removes fixtures that have already entered LIVE.
   const endpoint=kind==='prematch'?'/api/ui/prematch':'/api/ui/live';
   // Tiny metadata probe keeps freshness/status current without downloading the
   // whole feed when its logical revision has not changed.
   const metaResponse=await fetch(`${ServerConfig.base}${endpoint}?meta=1&thin=1`,{cache:'no-store',headers:ServerConfig.headers(),signal:AbortSignal.timeout(8000)});
   if(!metaResponse.ok)throw new Error(`HTTP ${metaResponse.status}`);
   const meta=await metaResponse.json(),previous=cache[kind];
   const rulesChanged=Number(previous?.leagueRules?.revision||0)!==Number(meta?.leagueRules?.revision||0);
   const needsFull=!Array.isArray(previous?.events)||String(previous?.revision||'')!==String(meta?.revision||'')||rulesChanged;
   let next,changed=false;
   if(needsFull){
    const headers=ServerConfig.headers();if(previous?._etag)headers['If-None-Match']=previous._etag;
    const response=await fetch(`${ServerConfig.base}${endpoint}?compact=1&thin=1`,{cache:'no-store',headers,signal:AbortSignal.timeout(10000)});
    if(response.status===304&&previous){next={...previous,...meta,events:previous.events,_etag:previous._etag};}
    else{
     if(!response.ok)throw new Error(`HTTP ${response.status}`);
     const data=await response.json();if(!Array.isArray(data.events))throw new Error('Нет списка событий');
     next={...data,_etag:response.headers.get('etag')||'',receivedAt:Date.now(),transportError:''};changed=true;
    }
   }else next={...previous,...meta,events:previous.events,_etag:previous._etag||'',receivedAt:Date.now(),transportError:''};
   if(myEpoch!==epoch)return cache[kind];
   const previousStructure=previous?.structureRevision;
   failures[kind]=0;retryAfter[kind]=0;cache[kind]=next;
   let seenChanged=false;if(changed)seenChanged=await notifyNew(kind,next).catch(error=>{console.warn('[notification]',error.message);return false;});
   if(kind==='live'&&String(previousStructure||'')!==String(next?.structureRevision||'')&&cache.prematch)queueMicrotask(()=>poll('prematch',true));
   const received=Date.now();
   if(changed||seenChanged||received-lastPersistAt>=60000){lastPersistAt=received;await chrome.storage.local.set({seenEvents:seen});}
   const freshness={revision:next.revision,receivedAt:next.receivedAt,transportError:'',stale:next.stale,updating:next.updating,providers:next.providers};
   for(const port of ports)try{port.postMessage(changed?{kind,snapshot:next}:{kind:'freshness',feed:kind,freshness});}catch{}
  }catch(error){
   if(myEpoch!==epoch)return cache[kind];
   const message=ServerConfig.errorText(error),before=cache[kind]?.transportError,count=(failures[kind]||0)+1;failures[kind]=count;retryAfter[kind]=Date.now()+retryDelay(kind,count);
   cache[kind]={...cache[kind],transportError:message,failedAt:Date.now()};
   const freshness={receivedAt:cache[kind]?.receivedAt,transportError:message,failures:count,failedAt:cache[kind]?.failedAt,stale:cache[kind]?.stale,providers:cache[kind]?.providers};
   if(message!==before||count===2)for(const port of ports)try{port.postMessage({kind:'freshness',feed:kind,freshness});}catch{}
  }
  return cache[kind];
 })().finally(()=>inflight.delete(kind));inflight.set(kind,run);return run;
}

function applyProviderPatches(kind,patches,meta){
 const previous=cache[kind],now=Date.now(),result=FeedPush.applyProviderPatches(previous,patches,meta,now);if(!result.snapshot)return false;cache[kind]=result.snapshot;
 if(result.changed){
  // Feed snapshots are deliberately memory-only in the thin client. Persisting
  // them was one of the main causes of structured-clone/storage stalls in 6.x.
  // Never structured-clone the whole feed snapshot for every realtime packet.
  // The app already has the snapshot and can apply the same small provider patch locally.
  // This is critical on HTTP/1.1/low-memory systems where pushes may arrive many times/sec.
  const pushMeta={...meta,revision:cache[kind]?.revision,structureRevision:cache[kind]?.structureRevision,receivedAt:cache[kind]?.receivedAt,pushAt:cache[kind]?.pushAt,transportError:''};
  for(const port of ports)try{port.postMessage({kind,push:true,patches,meta:pushMeta});}catch{}
 }
 else for(const port of ports)try{port.postMessage({kind:'freshness',feed:kind,freshness:{...meta,receivedAt:now,pushAt:now}});}catch{}
 return result.ok;
}
async function handleStreamEvent(type,data){
 streamLastAt=Date.now();
 if(type==='hello'){
  streamHealthy=true;streamFailures=0;
  for(const kind of ['live','prematch']){const meta=data?.feeds?.[kind],current=cache[kind];if(meta&&(!current||String(current.revision||'')!==String(meta.revision||'')))poll(kind,true);}
  for(const port of ports)try{port.postMessage({kind:'ui-stream',hello:data?.ui||{},serverVersion:data?.serverVersion||''});}catch{}
  return;
 }
 if(type==='ui-invalidate'){
  streamHealthy=true;
  const view=String(data?.view||'');if(!['results','history','leagues'].includes(view))return;
  for(const port of ports)try{port.postMessage({kind:'ui-invalidate',view,revision:Number(data?.revision||0),reason:String(data?.reason||''),at:Number(data?.at)||Date.now(),date:String(data?.date||''),updatedAt:Number(data?.updatedAt||0)});}catch{}
  return;
 }
 const kind=data?.mode;if(!['live','prematch'].includes(kind))return;
 if(type==='invalidate'){streamHealthy=true;poll(kind,true);return;}
 if(type==='patch'){
  streamHealthy=true;
  const beforeStructure=cache[kind]?.structureRevision,patches=Array.isArray(data.patches)?data.patches:[],ok=applyProviderPatches(kind,patches,data.meta||{});
  if(!ok&&patches.some(p=>(p.fields||[]).length))poll(kind,true);
  else if(kind==='live'&&String(beforeStructure||'')!==String(cache.live?.structureRevision||''))poll('prematch',true);
  return;
 }
 if(type==='status'){
  const current=cache[kind];if(current){cache[kind]={...current,...(data.meta||{}),transportError:data.error?ServerConfig.errorText(data.error):'',receivedAt:Date.now()};for(const port of ports)try{port.postMessage({kind:'freshness',feed:kind,freshness:{...(data.meta||{}),transportError:data.error?ServerConfig.errorText(data.error):'',receivedAt:Date.now()}});}catch{}}
 }
}
async function streamLoop(){
 if(streamRunning||!ports.size)return;await boot;if(streamRunning||!ports.size)return;streamRunning=true;clearTimeout(streamRetryTimer);streamRetryTimer=null;const controller=new AbortController();streamAbort=controller;let stalled=false,lastByteAt=Date.now();
 // The server pings every 15 s. Nothing received for STREAM_STALL_MS - before the response headers or after them - means a
 // half-dead connection (frozen server, vanished NAT entry): abort it so the normal reconnect-with-backoff path runs.
 const stallTimer=setInterval(()=>{if(Date.now()-lastByteAt>STREAM_STALL_MS){stalled=true;controller.abort();}},5000);
 try{
  const response=await fetch(`${ServerConfig.base}/api/feed-stream?modes=live,prematch,results,history,leagues&thin=1`,{cache:'no-store',headers:ServerConfig.headers({Accept:'text/event-stream'}),signal:controller.signal});if(!response.ok||!response.body)throw Error(`HTTP ${response.status}`);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';streamHealthy=true;streamFailures=0;
  lastByteAt=Date.now();
  while(ports.size&&!controller.signal.aborted){const {value,done}=await reader.read();lastByteAt=Date.now();if(done)throw Error('Поток закрыт сервером');buffer+=decoder.decode(value,{stream:true});let index;while((index=buffer.search(/\r?\n\r?\n/))>=0){const block=buffer.slice(0,index),sep=buffer.match(/\r?\n\r?\n/)?.[0]?.length||2;buffer=buffer.slice(index+sep);const event=FeedPush.parseSseBlock(block);if(event)await handleStreamEvent(event.type,event.data);}}
 }catch(error){if(!controller.signal.aborted||stalled){streamHealthy=false;streamFailures++;}}
 finally{
  clearInterval(stallTimer);
  if(streamAbort===controller)streamAbort=null;streamRunning=false;
  if(ports.size&&(!controller.signal.aborted||stalled)){
   // Do not wait for the long reconciliation interval after a stream loss.
   // Resume normal polling immediately while SSE reconnects independently.
   scheduleFeeds(0);
   const delay=Math.min(30000,1000*Math.pow(2,Math.min(5,streamFailures)))+Math.floor(Math.random()*500);streamRetryTimer=setTimeout(streamLoop,delay);
  }
 }
}
function startFeedStream(){if(ports.size&&!streamRunning)streamLoop();}
function stopFeedStream(){clearTimeout(streamRetryTimer);streamRetryTimer=null;streamHealthy=false;streamAbort?.abort();streamAbort=null;}

chrome.runtime.onConnect.addListener(port=>{if(port.name!=='monitor')return;ports.add(port);portActivity.set(port,{visible:true,tab:'live',at:Date.now()});startFeedStream();port.onDisconnect.addListener(()=>{ports.delete(port);if(!ports.size){clearTimeout(schedulerTimer);schedulerTimer=null;stopFeedStream();}else{scheduleFeeds(0);startFeedStream();}});port.onMessage.addListener(message=>{if(message?.type==='activity'||message?.type==='heartbeat'){portActivity.set(port,{visible:message.visible!==false,tab:String(message.tab||'live'),at:Date.now()});scheduleFeeds(0);}});boot.then(async()=>{port.postMessage({kind:'initial',snapshots:cache,feedStream:{healthy:streamHealthy,lastAt:streamLastAt}});await poll('live',true);await poll('prematch',true);scheduleFeeds(nextSchedulerDelay());});});
async function openExternal(url){
 await boot;
 let parsed;try{parsed=new URL(url);}catch{return{error:'Некорректная ссылка'};}
 if(!['http:','https:'].includes(parsed.protocol))return{error:'Разрешены только http/https ссылки'};
 const browser=['current','system','chrome','edge','firefox'].includes(prefs.linkBrowser)?prefs.linkBrowser:'current';
 if(browser==='current'){await chrome.tabs.create({url:parsed.href});return{ok:true,browser};}
 try{
  const response=await chrome.runtime.sendNativeMessage('com.esportsmonitor.browser',{url:parsed.href,browser});
  if(response?.ok)return response;
  throw new Error(response?.error||'Помощник браузера не ответил');
 }catch(error){
  await chrome.tabs.create({url:parsed.href});
  return{ok:false,fallback:true,error:error.message};
 }
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{if(message.type==='openExternal'){openExternal(message.url).then(respond,e=>respond({error:e.message}));return true;}if(message.type==='openOddsWindow'){const expected=chrome.runtime.getURL('odds.html');if(typeof message.url!=='string'||message.url.split('?')[0]!==expected)return;boot.then(async()=>{if(prefs.generatorEnabled!==true||prefs.hideOdds!==false){respond({error:'Генератор выключен в настройках'});return;}await loadedWindow(message.url,1040,800);respond({ok:true});}).catch(e=>respond({error:e.message}));return true;}if(message.type==='openScoreWindow'){const expected=chrome.runtime.getURL('score-history.html');if(typeof message.url!=='string'||message.url.split('?')[0]!==expected)return;loadedWindow(message.url,720,650).then(()=>respond({ok:true}),e=>respond({error:e.message}));return true;}if(message.type==='snapshots'){boot.then(()=>respond(cache));return true;}if(message.type==='refresh'){(async()=>{await poll('live',true);await poll('prematch',true);return cache;})().then(respond);return true;}});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='feeds'&&wantsBackgroundFeeds())(async()=>{await poll('live');await poll('prematch');})().catch(()=>{});});
boot.then(async()=>{await configureBackgroundAlarm();if(wantsBackgroundFeeds()){await poll('live',true);await poll('prematch',true);}}).catch(()=>{});

async function loadedWindow(url,width,height){
 // Create the popup directly. Creating a hidden normal tab first caused a
 // visible browser-tab flash before every monitor/calculator window.
 const win=await chrome.windows.create({url,type:'popup',width,height,focused:true});
 if(!win?.id)throw new Error('Не удалось открыть окно');
 return win;
}

