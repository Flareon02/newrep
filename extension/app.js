'use strict';
/* Esports Monitor 9.0 - application shell.

   Data flow: the service worker owns the LIVE/line feeds (poll + SSE + notifications) and forwards snapshots and
   patches through a port. This page keeps them in memory, saves the last-known copy to disk, and renders every view
   from memory: a tab switch or a cached detail never waits for the network. Results, history and event details go
   through Store resources (stale-while-revalidate, LRU, deduplicated and cancellable requests). */

// ---------------------------------------------------------------------------------------------------- basics ----
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ZONE='Asia/Yerevan',BASE=ServerConfig.base,HISTORY_PAGE_SIZE=200,RESULTS_PAGE_SIZE=150,LINE_SCHEDULE_PAGE=150;
const timeFmt=new Intl.DateTimeFormat('ru-RU',{timeZone:ZONE,hour:'2-digit',minute:'2-digit'}),secondFmt=new Intl.DateTimeFormat('ru-RU',{timeZone:ZONE,hour:'2-digit',minute:'2-digit',second:'2-digit'}),dateFmt=new Intl.DateTimeFormat('ru-RU',{timeZone:ZONE,day:'2-digit',month:'2-digit'}),weekdayFmt=new Intl.DateTimeFormat('ru-RU',{timeZone:ZONE,weekday:'short',day:'numeric',month:'long'});
const stamp=(ms,full=false,seconds=false)=>Number(ms)>0?`${full?dateFmt.format(ms)+' ':''}${(seconds?secondFmt:timeFmt).format(ms)}`:'—';
const dayKey=(ms=Date.now())=>new Date(ms+14400000).toISOString().slice(0,10),shiftDay=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const VIEWS=['live','prematch','results','compare','history'];
// DataBet is not part of the active source set (9.3): it is not shown anywhere.
const BOOKS=['astek','fonbet','pinnacle','ggbet'];
const providerName=source=>({astek:'AstekBet',fonbet:'Fonbet',pinnacle:'Pinnacle',ggbet:'GGBET'})[source]||source;
const providerShort=source=>({astek:'Astek',fonbet:'Fonbet',pinnacle:'Pinn',ggbet:'GG'})[source]||source;
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const refs=e=>e?.sourceRefs?.length?e.sourceRefs:[e].filter(Boolean);
const alphabet=new Intl.Collator('ru',{sensitivity:'base',numeric:true});
const isExtraEvent=e=>PresentationUtils.isExtraEvent(e);

// DEV instrumentation: interaction timings in window.__perf; printed when localStorage.devPerf === '1'.
const Perf=(()=>{const log=[],dev=(()=>{try{return localStorage.getItem('devPerf')==='1';}catch{return false;}})();
 function measure(name,start){const ms=Math.round((performance.now()-start)*10)/10;log.push({name,ms,at:Date.now()});if(log.length>300)log.shift();if(dev)console.debug(`[perf] ${name}: ${ms} ms`);return ms;}
 function frame(name){const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>measure(name,start)));}
 return {measure,frame,log};})();
window.__perf=Perf.log;
// DEV/test hook (read-only): what History has loaded vs what is mounted. Used by tools/ux/ux-harness.mjs.
window.__monitorDebug={history:()=>{const secs=History.sections();return {loaded:secs.reduce((n,s)=>n+s.rows.length,0),sections:secs.map(s=>({id:s.id,state:s.state,rows:s.rows.length,total:s.total})),mounted:viewEl('history')?.querySelectorAll('article.match').length||0,status:History.status()};}};

// ---------------------------------------------------------------------------------------------------- capabilities
// What this user may use (server 4.9+, GET /api/me). The server enforces it; the UI only leaves out what cannot be used.
const Ent=Entitlements.create();
const oddsHidden=view=>prefs.hideOdds||!Ent.oddsFor(view==='compare'?(prefs.compareScope==='prematch'?'prematch':'live'):view);

// ---------------------------------------------------------------------------------------------------- prefs -----
const DEFAULT_PREFS={astek:true,fonbet:true,pinnacle:true,ggbet:true,liveOddsProvider:'ggbet',theme:'dark',linkBrowser:'current',openMode:'window',dotaStatsEnabled:true,teamLogos:true,favorites:[],hiddenLeagues:[],hiddenLeaguesByView:{},notifications:{live:false,prematch:false,favoritesOnly:false,sound:false},viewFilters:{},liveSort:'league',lineMode:'leagues',compareMode:'odds',compareScope:'live',showExtras:true,hideOdds:false,historyEnabled:true,detailTab:'odds',detailBook:'',onlyFavorites:false};
let prefs={...DEFAULT_PREFS};
let prefsTimer=0;
// Personal settings follow the user + key (settings-sync.js): every save reports the keys that changed.
let applyingProfile=false,prefsSeen={};
function changedPrefKeys(){const keys=[];for(const k of new Set([...Object.keys(prefs),...Object.keys(prefsSeen)])){const v=JSON.stringify(prefs[k]);if(v!==prefsSeen[k]){keys.push(k);prefsSeen[k]=v;}}return keys;}
function savePrefs(){clearTimeout(prefsTimer);prefsTimer=setTimeout(()=>chrome.storage.local.set({prefs}).catch(report),80);const keys=changedPrefKeys();if(!applyingProfile&&keys.length&&typeof settingsSync!=='undefined')settingsSync.changed(keys);}
function flushPrefs(){clearTimeout(prefsTimer);prefsTimer=0;return chrome.storage.local.set({prefs}).catch(()=>{});}
function setPref(key,value){prefs[key]=value;savePrefs();}
function migratePrefs(){
 if(typeof prefs.dotaStatsEnabled!=='boolean'){prefs.dotaStatsEnabled=typeof prefs.hawkEnabled==='boolean'?prefs.hawkEnabled:true;delete prefs.hawkEnabled;}
 if(typeof prefs.teamLogos!=='boolean')prefs.teamLogos=true;
 if(!['current','system','chrome','edge','firefox'].includes(prefs.linkBrowser))prefs.linkBrowser='current';
 if(!prefs.scheduleMerged690){const old=prefs.hiddenLeaguesByView?.schedule||[];prefs.hiddenLeaguesByView={...prefs.hiddenLeaguesByView,prematch:[...new Set([...(prefs.hiddenLeaguesByView?.prematch||[]),...old])]};delete prefs.hiddenLeaguesByView.schedule;prefs.scheduleMerged690=true;}
 if(!prefs.splitHistory607){prefs.hiddenLeaguesByView={...prefs.hiddenLeaguesByView,history:[...(prefs.hiddenLeaguesByView?.results||[])]};prefs.splitHistory607=true;}
 // 9.0: odds, History and the detail panel are part of the product; League links moved to Settings.
 if(!prefs.ui900){prefs.hideOdds=false;prefs.historyEnabled=true;prefs.liveSort='league';if(['leagues','debug','schedule'].includes(prefs.lastTab))prefs.lastTab='live';prefs.lineMode=prefs.lineScheduleMode===true?'schedule':'leagues';prefs.ui900=true;}
 if(!['league','asc','desc'].includes(prefs.liveSort))prefs.liveSort='league';
 if(!['leagues','schedule'].includes(prefs.lineMode))prefs.lineMode='leagues';
 if(!['odds','schedule'].includes(prefs.compareMode))prefs.compareMode='odds';
 if(!['live','prematch'].includes(prefs.compareScope))prefs.compareScope='live';
 if(!['time','arb-desc','arb-asc'].includes(prefs.compareSort))prefs.compareSort='time';
 for(const key of ['favorites','hiddenLeagues'])if(!Array.isArray(prefs[key]))prefs[key]=[];
 prefs.notifications={...DEFAULT_PREFS.notifications,...prefs.notifications};
 // 9.3: DataBet retired, GGBET is a bookmaker like the others (its own show/hide switch).
 delete prefs.databet;delete prefs.liveOddsMode;prefs.liveOddsProvider='ggbet';if(prefs.detailBook==='databet')prefs.detailBook='';
 if(!['dark','light','system'].includes(prefs.theme))prefs.theme='dark';
 if(!prefs.ux930){if(prefs.viewFilters?.live?.availability==='databet')prefs.viewFilters.live.availability='all';delete prefs.lineCollapsed;prefs.ux930=true;}
}
const bookVisible=source=>prefs[source]!==false&&OddsProvider.visible(source,prefs)&&Ent.canProvider(source);
const viewBooks=view=>(view==='live'?['astek','fonbet','pinnacle',OddsProvider.selected(prefs)]:view==='results'?['astek','fonbet']:view==='history'?['astek','fonbet','pinnacle']:['astek','fonbet','pinnacle']).filter(s=>prefs[s]!==false&&Ent.canProvider(s));

// ---------------------------------------------------------------------------------------------------- theme -----
// prefs.theme: 'dark' | 'light' | 'system'. The resolved scheme is html[data-theme]; theme-boot.js applies the localStorage
// mirror before the first paint.
const systemDark=matchMedia('(prefers-color-scheme: dark)');
const THEME_LABEL={dark:'Тёмная',light:'Светлая',system:'Как в системе'};
function resolvedTheme(mode=prefs.theme){return mode==='system'?(systemDark.matches?'dark':'light'):mode==='light'?'light':'dark';}
function applyTheme(){
 const mode=['dark','light','system'].includes(prefs.theme)?prefs.theme:'dark',scheme=resolvedTheme(mode);
 document.documentElement.dataset.theme=scheme;try{localStorage.setItem('monitor-theme',mode);}catch{}
 const b=$('themeButton');if(b){const next=scheme==='dark'?'светлую':'тёмную';b.setAttribute('aria-label',`Тема: ${THEME_LABEL[mode].toLowerCase()}. Переключить на ${next}`);b.title=`Тема: ${THEME_LABEL[mode]} · переключить на ${next}`;b.dataset.scheme=scheme;}
}
function setTheme(mode){prefs.theme=mode;savePrefs();applyTheme();Cs2Panel.refreshAppearance?.();}
systemDark.addEventListener('change',()=>{if(prefs.theme==='system')applyTheme();});

// ---------------------------------------------------------------------------------------------------- toast/errors
const clientErrors=[];
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,3200);}
// Plain words for users; the sanitized technical reason only for administrators (user-text.js).
function errorText(error){return error?UserText.error(error,{admin:Ent.isAdmin()}):'Неизвестная ошибка';}
function report(error){if(error?.name==='AbortError')return;const message=errorText(error);clientErrors.push({at:new Date().toISOString(),message});if(clientErrors.length>50)clientErrors.shift();toast(message);}

// ---------------------------------------------------------------------------------------------------- data layer
const client=Store.createClient({base:()=>BASE,headers:()=>ServerConfig.headers(),timeoutFor:url=>url.startsWith('/api/ui/history')||url.startsWith('/api/ui/results')||url.startsWith('/api/prematch/compare')?35000:15000});
// Another user's/key's profile replaces the active one: prefs, theme, logos, folds and every view follow at once.
function applyProfilePrefs(next){applyingProfile=true;try{prefs={...DEFAULT_PREFS,...next};migratePrefs();changedPrefKeys();savePrefs();applyTheme();document.documentElement.classList.toggle('team-logos-off',prefs.teamLogos===false);lineFold=LineCollapse.create({closedGames:Array.isArray(prefs.lineClosedGames)?prefs.lineClosedGames:[]});if(typeof markDirty==='function'){markDirty();renderChrome();if(!$('settingsView').hidden)renderSettings();DetailPanel.render();}}finally{applyingProfile=false;}}
const settingsSync=SettingsSync.create({storage:chrome.storage.local,client,getPrefs:()=>prefs,applyPrefs:applyProfilePrefs,defaults:DEFAULT_PREFS,log:e=>report(e)});
// Compatibility wrapper for the reused modules (score dialog, odds timeline, generator, stats panels, league client).
async function request(path,options={}){if(options.method==='POST'){const body=typeof options.body==='string'?JSON.parse(options.body):options.body;return client.post(path,body);}return client.get(path,options.signal?{signal:options.signal}:{});}
const persist=Store.createPersist({storage:chrome.storage.local,prefix:'lastKnown9:',minIntervalMs:30000});

// Event details: LIVE ones belong to the selected odds provider (never reuse GGBET detail for DataBet).
const detailMeta=new Map();
function hydrateDetail(data){return data?.marketDetailErrors&&Object.keys(data.marketDetailErrors).length?{...data.event,marketDetailErrors:data.marketDetailErrors}:data.event;}
// GGBET full markets (server 4.8+) are leased for the match open in the detail panel only: acquired on open, switch
// and provider change, renewed by the panel's 10 s refresh, released on close; the server also drops a lease that is
// not renewed within its TTL. A hover prefetch never carries the lease, so it never subscribes full markets.
const FULL_LEASE='p'+(globalThis.crypto?.randomUUID?.()||(Math.random().toString(36).slice(2)+Date.now().toString(36))).replace(/-/g,'').slice(0,40);
let fullLeaseId='',panelDetailKey='';
function leaseFull(event,view){
 const live=view==='live'||(view==='compare'&&!!event?.inLive),provider=OddsProvider.selected(prefs),id=live&&provider==='ggbet'&&event&&Ent.can('odds.fullMarkets')&&Ent.canProvider('ggbet')?String(event.id):'';
 if(!id){releaseFull();return;}
 fullLeaseId=id;client.post('/api/ui/full-markets',{lease:FULL_LEASE,action:'acquire',view:'live',id,provider}).catch(()=>{});
}
function releaseFull(){panelDetailKey='';if(!fullLeaseId)return;fullLeaseId='';client.post('/api/ui/full-markets',{lease:FULL_LEASE,action:'release'}).catch(()=>{});}
window.addEventListener('pagehide',()=>{if(!fullLeaseId)return;try{fetch(BASE+'/api/ui/full-markets',{method:'POST',keepalive:true,headers:{...ServerConfig.headers(),'Content-Type':'application/json'},body:JSON.stringify({lease:FULL_LEASE,action:'release'})}).catch(()=>{});}catch{}});
const details=Store.createResource({max:40,usable:10*60000,fresh:key=>key.startsWith('live:')?10000:60000,fetcher:(key,{signal})=>{const m=detailMeta.get(key);return client.get('/api/ui/event-detail?view='+m.view+'&id='+encodeURIComponent(m.id)+(m.view==='live'?'&provider='+m.provider:'')+(m.view==='live'&&key===panelDetailKey&&fullLeaseId===m.id?'&lease='+FULL_LEASE:''),{signal}).then(hydrateDetail);}});
function detailKeyFor(event,view){const key=OddsProvider.detailKey(view,event.id,prefs);detailMeta.set(key,{view,id:String(event.id),provider:OddsProvider.selected(prefs)});if(detailMeta.size>400)detailMeta.delete(detailMeta.keys().next().value);return key;}
function detailSwr(event,view,{force=false,onValue,onError,signal}={}){const started=performance.now(),key=detailKeyFor(event,view);panelDetailKey=key;const res=details.swr(key,{force,signal,onValue:(v)=>{Perf.measure('detail.network',started);onValue?.(v);},onError});return res;}
let prefetchController=null,prefetchTimer=0;
function prefetchDetail(event,view){
 if(!event||!['live','prematch'].includes(view)||oddsHidden(view))return;
 const key=detailKeyFor(event,view),cached=details.peek(key);if(cached?.fresh||details.isLoading(key))return;
 prefetchController?.abort();prefetchController=new AbortController();
 details.load(key,{signal:prefetchController.signal}).catch(()=>{});
}

// Results and history (server-side views): stale-while-revalidate per query.
const resultsRes=Store.createResource({max:24,usable:24*3600000,fresh:key=>key.startsWith(dayKey()+'|')?20000:300000,fetcher:(key,{signal})=>fetchResults(key,signal)});

// ---------------------------------------------------------------------------------------------------- feeds -----
const snapshots={live:null,prematch:null};
let port=null,reconnectDelay=500,reconnectTimer=0;
const quoteTracker=MatchFormat.createPriceTracker({windowMs:20000});
const scoreChanged=new Map();let lastScores=new Map();
function noteScores(snapshot){const now=Date.now();for(const e of snapshot?.events||[])for(const r of refs(e)){const key=`${r.source}:${r.sourceEventId||r.id}`,v=r.scoreText||'';if(lastScores.has(key)&&lastScores.get(key)!==v&&v)scoreChanged.set(key,now);lastScores.set(key,v);}if(lastScores.size>6000)lastScores=new Map([...lastScores].slice(-3000));}
function compactForDisk(s,kind){if(!s?.events)return null;return {events:s.events,providers:s.providers,revision:s.revision,structureRevision:s.structureRevision,leagueRules:s.leagueRules,generatedAt:s.generatedAt,receivedAt:s.receivedAt||Date.now(),liveOddsProvider:kind==='live'?OddsProvider.selected(prefs):undefined};}
function setSnapshot(kind,snapshot,{persisted=false}={}){
 snapshots[kind]=snapshot?{...snapshot,persisted}:null;
 if(kind==='live'&&snapshot&&!persisted)noteScores(snapshot);
 if(snapshot&&!persisted&&!snapshot.offline)persist.save(kind,compactForDisk(snapshot,kind));
 invalidateRows(kind);
}
function connect(){
 clearTimeout(reconnectTimer);
 try{port=chrome.runtime.connect({name:'monitor'});}catch{port=null;reconnectTimer=setTimeout(connect,reconnectDelay);reconnectDelay=Math.min(10000,reconnectDelay*2);return;}
 sendActivity();
 port.onMessage.addListener(onPortMessage);
 port.onDisconnect.addListener(()=>{port=null;clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,reconnectDelay);reconnectDelay=Math.min(10000,reconnectDelay*2);});
}
function onPortMessage(message){
 reconnectDelay=500;
 if(message.kind==='ui-invalidate'){handleUiInvalidate(message);return;}
 if(message.kind==='ui-stream'){reconcileServerViews();return;}
 if(message.kind==='entitlements'){mePending=null;loadEntitlements();return;}
 if(message.kind==='freshness'){
  const kind=message.feed,target=snapshots[kind],f=message.freshness||{},failed=!!f.transportError;
  if(target&&!target.offline){Object.assign(target,f);if(!failed&&target.persisted&&f.revision&&String(f.revision)===String(target.revision))target.persisted=false;}
  else if(failed&&(target?.offline||f.failures>=2||!target))snapshots[kind]={events:[],offline:true,...f};
  else if(target?.offline&&!failed)snapshots[kind]=null;
  scheduleChrome();if(target?.offline||snapshots[kind]?.offline)scheduleRender(kind);
  return;
 }
 if(message.kind==='live-provider'){applyProviderSwitchLocally();return;}
 if(message.kind==='initial'){for(const kind of ['live','prematch']){const s=message.snapshots?.[kind];if(s?.events&&!(kind==='live'&&s.liveOddsProvider&&s.liveOddsProvider!==OddsProvider.selected(prefs)))setSnapshot(kind,s);}scheduleRender('live');scheduleRender('prematch');scheduleChrome();return;}
 if(message.push){
  const kind=message.kind,before=snapshots[kind]?.offline?undefined:snapshots[kind];
  const applied=FeedPush.applyProviderPatches(before,message.patches||[],message.meta||{},Number(message.meta?.receivedAt)||Date.now());
  if(applied.snapshot){snapshots[kind]={...applied.snapshot,persisted:false};if(kind==='live')noteScores(snapshots.live);persist.save(kind,compactForDisk(snapshots[kind],kind));invalidateRows(kind);scheduleRender(kind);}
  DetailPanel.onFeedPatches(message.patches);
  window.dispatchEvent(new CustomEvent('monitor-feed-push',{detail:{kind,patches:message.patches||[],snapshot:snapshots[kind]}}));
  return;
 }
 if(message.snapshot){setSnapshot(message.kind,message.snapshot);scheduleRender(message.kind);scheduleChrome();}
}
function sendActivity(){try{port?.postMessage({type:'activity',visible:!document.hidden,tab});}catch{}}

// The service worker may still announce a provider (older protocol): GGBET is the only LIVE odds provider now.
function applyProviderSwitchLocally(){details.remove(key=>key.startsWith('live:'));invalidateRows('live');scheduleRender('live');scheduleRender('compare');scheduleChrome();}

// ---------------------------------------------------------------------------------------------------- rows ------
function rules(){return [settingsState.catalog,snapshots.live?.leagueRules,snapshots.prematch?.leagueRules].filter(Boolean).sort((a,b)=>(b.revision||0)-(a.revision||0))[0]||{};}
function hiddenKeys(view){return [...(prefs.hiddenLeagues||[]),...(prefs.hiddenLeaguesByView?.[view]||[])];}
function canonicalEventCategory(e){if(!GameCategories.generic(e.category)&&GameCategories.info(e.category).key!=='other')return e.category;const exact=refs(e).map(r=>r.category).find(c=>!GameCategories.generic(c)&&GameCategories.info(c).key!=='other');return exact||GameCategories.resolve(e.category,e.league);}
const rowsCache={live:{key:'',rows:[]},prematch:{key:'',rows:[]}};
// Per-object memos (a feed patch replaces only the events it touches): derived feed row, view projection, row html.
const derivedRows={live:new WeakMap(),prematch:new WeakMap()};
const projectionMemo=new WeakMap(),rowHtmlMemo=new WeakMap();
const projectionSig=view=>view+'|'+BOOKS.map(b=>prefs[b]===false?0:1).join('')+'|'+OddsProvider.selected(prefs);
function projectRow(e,view){const sig=projectionSig(view);let m=projectionMemo.get(e);if(!m||m.sig!==sig){m={sig,value:MatchView.project(e,prefs,view)};projectionMemo.set(e,m);}return m.value;}
function invalidateRows(kind){if(rowsCache[kind])rowsCache[kind].key='';}
function feedRows(kind){
 const s=snapshots[kind],key=JSON.stringify([s?.structureRevision??s?.revision,s?.receivedAt,s?.events?.length,rules().revision,s?.persisted]);
 if(rowsCache[kind].key===key)return rowsCache[kind].rows;
 const memo=derivedRows[kind];
 const rows=(s?.events||[]).map(event=>{const hit=memo.get(event);if(hit)return hit;const sourceRefs=refs(event).map(r=>kind==='live'?{...r,inLive:true,enteredLiveAt:Number(r.enteredLiveAt||r.firstSeenAt||0)}:r);const row={...event,sourceRefs,...(kind==='live'?{inLive:true}:{inPrematch:true}),category:canonicalEventCategory({...event,sourceRefs})};memo.set(event,row);return row;});
 rowsCache[kind]={key,rows};return rows;
}
const favoriteKeys=e=>[...(e.entityAliases||[]),...refs(e).flatMap(r=>[...(r.aliases||[]),`${r.source}:${r.sourceEventId||r.id}`])];
const matchFavorite=e=>favoriteKeys(e).some(k=>prefs.favorites.includes(k));
const favorite=e=>[e.leagueKey,...refs(e).map(r=>LeagueModel.id(r)),...favoriteKeys(e)].some(k=>prefs.favorites.includes(k));
function toggleFavorite(e){if(!Ent.can('favorites'))return;const keys=favoriteKeys(e);prefs.favorites=matchFavorite(e)?prefs.favorites.filter(k=>!keys.includes(k)):[...new Set([...prefs.favorites,...keys])];savePrefs();markDirty();if(prefs.onlyFavorites&&['results','history'].includes(tab))reloadServerView(tab);}

// filters live in prefs.viewFilters[view] (persisted), never read back from the DOM
const FILTER_DEFAULTS={search:'',category:'',availability:'all',startWindow:'',historyPhase:''};
function filters(view=tab){return {...FILTER_DEFAULTS,...(prefs.viewFilters?.[view]||{})};}
function setFilter(key,value,view=tab){prefs.viewFilters={...prefs.viewFilters,[view]:{...filters(view),[key]:value}};savePrefs();}
function filterCount(view=tab){const f=filters(view);return [!!f.search,!!f.category,f.availability!=='all',!!f.startWindow&&view!=='live',view==='history'&&!!f.historyPhase,!!prefs.onlyFavorites].filter(Boolean).length;}
function inStartWindow(e,view,f){if(view==='live'||!f.startWindow)return true;const date=resultsDate;const end=view==='results'&&date<dayKey()?Date.parse(date+'T23:59:59.999+04:00'):Date.now();return MatchView.inWindow(e,f.startWindow,view,end);}
function visible(rows,view=tab,{ignoreCategory=false}={}){
 const rule=rules(),f=filters(view),state={publishedLeagueLinks:rule.links||[],excludedLeagueKeys:[...hiddenKeys(view),...(rule.visibility?.excludedLeagueKeys||[])],excludedCategoryKeys:rule.visibility?.excludedCategoryKeys||[]};
 const q=norm(f.search).split(' ').filter(Boolean),category=ignoreCategory?'':f.category,availability=f.availability,projectView=view==='compare'?(prefs.compareScope==='live'?'live':'prematch'):view;
 return (rows||[]).map(e=>projectRow(e,projectView)).filter(e=>{if(!e)return false;const sources=new Set(refs(e).map(r=>r.source));const available=availability==='all'||(availability==='both'&&sources.size>1)||(availability==='unique'&&sources.size===1)||(sources.size===1&&sources.has(availability));
  return inStartWindow(e,view,f)&&available&&(!category||norm(e.category)===category)&&!LeagueModel.hidden(e,state)&&(!prefs.onlyFavorites||favorite(e))&&(prefs.showExtras!==false||!isExtraEvent(e))&&q.every(t=>norm([e.category,e.league,e.team1,e.team2,...refs(e).map(r=>r.league)].join(' ')).includes(t));});
}
const leagueText=value=>{let text=(ScheduleImport.leagueInfo(value).league||value||'').replace(/\bbo\s*\d+\b/gi,'').replace(/^[\s.,:;–—-]+|[\s.,:;–—-]+$/g,'').trim();text=text.replace(/\bUnited\s+21\b/gi,'United21');const suffix=/(?:\s*[:.–—-]\s*)(?:division|div\.?|season|stage|group|groups|playoffs?|qualifiers?|qualification|regular season|swiss stage|upper bracket|lower bracket)\b.*$/i;if(suffix.test(text))text=text.replace(suffix,'').trim();text=text.replace(/\s+series$/i,'').trim();return text||String(value||'').trim();};
const leagueTitle=e=>leagueText(e.displayLeague||e.league);
// One-node game tile (game-icons.css): a glyph for known games, the abbreviation otherwise.
const GLYPHS=new Set(['cs','dota','lol','wildrift','valorant','overwatch','hearthstone','honor','heroes','rainbow','mobile','rocket','arena','standoff','starcraft','aoe','warcraft','tanks','cod','pubg','quake','cf','fc','basketball','apex','tft']);
function gameIcon(category,{label=false}={}){const {key,abbr,name}=GameCategories.info(category);return `<span class="game-icon gi-${key}"${GLYPHS.has(key)?' data-glyph':''} ${label?`role="img" aria-label="${esc(name)}" title="${esc(name)}"`:'aria-hidden="true"'}>${esc(abbr)}</span>`;}
function starIcon(active){return '<svg viewBox="0 0 24 24" fill="'+(active?'currentColor':'none')+'" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.55 4.44 1.08 6.26L12 17.35l-5.63 2.95 1.08-6.26L2.9 9.6l6.3-.9L12 3Z"/></svg>';}
// List rows use a one-node star (CSS mask), the detail panel and group heads keep the inline SVG.
const favButton=(fav,label=fav?'Убрать из избранного':'В избранное')=>`<button class="icon-btn star fav" data-fav aria-pressed="${fav}" aria-label="${label}" title="${label}"></button>`;
function eventUrl(r){try{const u=new URL(r.url);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}}
const Logos=LogoResolver.create({base:()=>BASE});
function teamLogo(e,side){return prefs.teamLogos===false?'':Logos.pick(e,side);}
const logoPersist=Store.createPersist({storage:chrome.storage.local,prefix:'lastKnown9:',minIntervalMs:60000});let logoSaveTimer=0;
function saveLogosSoon(){if(logoSaveTimer)return;logoSaveTimer=setTimeout(()=>{logoSaveTimer=0;logoPersist.save('logos',Logos.dump());},15000);}
const logoImg=(url,size)=>url?`<img class="team-logo" src="${esc(url)}" alt="" aria-hidden="true" width="${size}" height="${size}" loading="lazy" decoding="async">`:'<span class="logo-ph" aria-hidden="true"></span>';
function copyText(e){return `${stamp(e.startAt)} Киберспорт. ${leagueTitle(e).replace(/[.\s]+$/,'')}. "${e.team1} - ${e.team2}"`;}
async function copy(text,what=''){await navigator.clipboard.writeText(text);toast(what?`Скопировано: ${what}`:'Скопировано');}
const matchName=e=>UiKit.matchName(e);

// ---------------------------------------------------------------------------------------------------- row markup
function quotesOf(e,books){const out={};for(const r of refs(e))if(books.includes(r.source)&&!out[r.source])out[r.source]=MatchFormat.orientQuote(r);return out;}
function priceCell(e,source,ref,q,bestOf){
 if(!ref)return `<div class="price-col absent" data-short="${esc(providerShort(source))}" aria-label="${providerName(source)}: нет матча"></div>`;
 const key=`${source}:${ref.sourceEventId||ref.id}`;
 if(!q)return `<div class="price-col" data-short="${esc(providerShort(source))}" data-source-ref="${esc(key)}" title="${providerName(source)}: коэффициенты появятся после открытия линии"><span class="price none">—</span><span class="price none">—</span></div>`;
 if(q.s)return `<div class="price-col" data-short="${esc(providerShort(source))}" data-source-ref="${esc(key)}" title="${providerName(source)}: ${q.s==='c'?'рынок закрыт':'приём ставок приостановлен'}"><span class="price closed" aria-label="приостановлено">⏸</span><span class="price closed"></span></div>`;
 // "Best" is marked only when at least two bookmakers price that side; text alternative for screen readers.
 const cell=side=>{const v=MatchFormat.openPrice(q[side]);if(v==null)return '<span class="price none">—</span>';const t=quoteTracker.track(`${key}:${side}`,v),best=bestOf[side]===v&&bestOf.countSide[side]>1;return `<span class="price${best?' best':''}"${best?` aria-label="${esc(MatchFormat.formatPrice(v))}, лучший коэффициент"`:''}>${t.dir?`<span class="chg ${t.dir}" aria-label="${t.dir==='up'?'вырос':'снизился'} с ${esc(MatchFormat.formatPrice(t.was))}">${t.dir==='up'?'▲':'▼'}</span>`:''}${esc(MatchFormat.formatPrice(v))}</span>`;};
 return `<div class="price-col" data-short="${esc(providerShort(source))}" data-source-ref="${esc(key)}" data-book="${esc(source)}" title="${providerName(source)}${q.at?' · обновлено '+stamp(q.at,false,true):''}">${cell('h')}${cell('a')}</div>`;
}
function bestFor(quotes){const best=MatchFormat.bestPrices(quotes),countSide={h:0,a:0,d:0};for(const q of Object.values(quotes))if(q&&!q.s&&!q.stale)for(const side of ['h','a','d'])if(MatchFormat.openPrice(q[side])!=null)countSide[side]++;return {...best,countSide};}
// Score of a fixture from several bookmakers: MatchFormat.canonicalScore (plausible series only, furthest state, then
// the most recent change, then a fixed order). The event keeps its own fields when no bookmaker has a usable score.
function scoreOf(e){
 const list=refs(e).filter(r=>r&&bookVisible(r.source));
 const model=MatchFormat.canonicalScore(list,{changedAt:r=>scoreChanged.get(`${r.source}:${r.sourceEventId||r.id}`)||0});
 const r=model.best?.ref;
 if(!r)return {...e,display:MatchFormat.displayScore(e,e),scoreModel:model};
 return {...e,scoreText:r.scoreText||e.scoreText,seriesScore:r.seriesScore||e.seriesScore,mapScores:r.mapScores||e.mapScores,activeMap:r.activeMap||e.activeMap,bestOf:Number(r.bestOf)||Number(e.bestOf)||0,display:model.best,scoreModel:model};
}
const mapsLine=(d,live)=>d.maps.length?`<span class="maps-line num">(${d.maps.map((m,i)=>i===d.current&&live?`<b>${m.join(':')}</b>`:m.join(':')).join(', ')})</span>`:'';
function scoreCell(e,view){
 const live=view==='live',changed=refs(e).some(r=>Date.now()-(scoreChanged.get(`${r.source}:${r.sourceEventId||r.id}`)||0)<3000);
 if(view==='prematch')return `<div class="start-col"><b>${esc(timeFmt.format(Number(e.startAt)||Date.now()))}</b>${dateFmt.format(Number(e.startAt)||Date.now())===dateFmt.format(Date.now())?'сегодня':esc(dateFmt.format(Number(e.startAt)||Date.now()))}</div>`;
 const d=scoreOf(e).display;
 if(!d.series)return `<div class="score-col"><span class="score-text${changed?' changed':''}">${esc(d.text||'—')}</span></div>`;
 const status=[live&&d.current>=0&&d.maps.length>1?`Карта ${d.current+1}`:'',d.bestOf?`Bo${d.bestOf}`:''].filter(Boolean).join(' · ');
 return `<div class="score-col${changed?' changed':''}" title="${esc(d.text)}" aria-label="счёт ${esc(d.text)}"><span class="series num${changed?' changed':''}">${d.series[0]}:${d.series[1]}</span>${mapsLine(d,live)}${status?`<span class="status">${esc(status)}</span>`:''}</div>`;
}
function teamsCell(e,{meta=true}={}){
 const l1=teamLogo(e,1),l2=teamLogo(e,2),logo=url=>logoImg(url,18);
 return `<div class="teams">${meta?`<div class="meta">${gameIcon(e.category)}<span>${esc(e.category||'')} · ${esc(leagueTitle(e))}</span>${isExtraEvent(e)?'<span class="extra-tag">доп.</span>':''}</div>`:''}<div class="team">${logo(l1)}<span class="name">${esc(e.team1)}</span></div><div class="team">${logo(l2)}<span class="name">${esc(e.team2)}</span></div></div>`;
}
function sourcesCell(e,view){return `<div class="sources-col">${refs(e).filter(r=>bookVisible(r.source)).map(r=>`<span class="chip book ${esc(r.source)}" data-source-ref="${esc(r.source+':'+(r.sourceEventId||r.id))}" data-book-badge="${esc(r.source)}">${esc(providerShort(r.source))}</span>`).join('')}</div>`;}
function cachedRow(e,view,opts){
 const sig=[view,opts.meta!==false,opts.books.join(','),selectedId(view)===String(e.id),matchFavorite(e),oddsHidden(view),teamLogo(e,1),teamLogo(e,2),Ent.can('favorites')].join('|');
 const hit=rowHtmlMemo.get(e);if(hit&&hit.sig===sig)return hit.html;
 const html=matchRow(e,view,opts);if(!/class="chg |changed/.test(html))rowHtmlMemo.set(e,{sig,html});else rowHtmlMemo.delete(e);return html;
}
function matchRow(e,view,{meta=true,books=[]}={}){
 const sel=selectedId(view)===String(e.id),fav=matchFavorite(e),odds=!oddsHidden(view)&&books.length&&['live','prematch'].includes(view);
 let tail='';
 if(odds){const quotes=quotesOf(e,books),best=bestFor(quotes),byBook=new Map(refs(e).map(r=>[r.source,r]));tail=`<div class="prices">${books.map(b=>priceCell(e,b,byBook.get(b),quotes[b],best)).join('')}</div>`;}
 else tail=sourcesCell(e,view);
 const seen=MatchFormat.firstSeen(refs(e)),seenTitle=seen.length?'Появился: '+seen.map(x=>`${providerName(x.source)} ${stamp(x.at,true)}`).join(', '):'';
 return `<article class="match cols${odds?'':' no-odds'}" data-id="${esc(e.id)}" tabindex="0" aria-selected="${sel}" aria-label="${esc(e.team1)} — ${esc(e.team2)}"${seenTitle?` title="${esc(seenTitle)}"`:''}>${favButton(fav)}${teamsCell(e,{meta})}${scoreCell(e,view)}${tail}<span class="go" aria-hidden="true">›</span></article>`;
}
function listHeader(view,books){
 const odds=!oddsHidden(view)&&books.length&&['live','prematch'].includes(view);
 return `<div class="col-head cols${odds?'':' no-odds'}" data-group="head"><span></span><span>Матч</span><span class="right">${view==='prematch'?'Начало':'Счёт'}</span>${odds?'<span class="prices">'+books.map(b=>{const h=bookHealth(b);return `<span class="book-col" title="${esc(providerName(b))}${h&&!h.ok?' — '+esc(h.reason):''}"><span class="book-mark ${b}" aria-hidden="true"></span>${esc(providerName(b))}${h&&!h.ok?' <span aria-label="недоступен">⚠</span>':''}</span>`;}).join('')+'</span>':'<span class="right">Конторы</span>'}<span></span></div>`;
}

// ---------------------------------------------------------------------------------------------------- views -----
let tab='live';
const selectedIds=new Map();const selectedId=view=>selectedIds.get(view)||null;
const viewSignatures=new Map();
const viewEl=view=>document.querySelector(`#content>.list[data-view="${view}"]`);
let renderFrames=new Set(),renderFrame=0,chromeFrame=0;
function scheduleRender(kind){const views=kind==='live'?['live','compare']:kind==='prematch'?['prematch','compare']:[kind];for(const v of views)renderFrames.add(v);if(renderFrame)return;renderFrame=requestAnimationFrame(()=>{renderFrame=0;const list=[...renderFrames];renderFrames.clear();for(const v of list)if(v===tab)renderView(v);else viewSignatures.delete(v);updateNavCounts();});}
function scheduleChrome(){if(chromeFrame)return;chromeFrame=requestAnimationFrame(()=>{chromeFrame=0;renderChrome();});}
function markDirty(){for(const v of VIEWS)viewSignatures.delete(v);renderView(tab);updateNavCounts();}

// keyed DOM morph: rows keep their nodes (focus, hover, scroll) across updates
function morphInto(parent,html){
 const t=document.createElement('template');t.innerHTML=html;
 const key=n=>n.nodeType===1?(n.dataset.id||n.dataset.group||''):'';
 (function morph(target,fresh){
  const keyed=new Map([...target.childNodes].filter(key).map(n=>[key(n),n]));let cursor=target.firstChild;
  for(const desired of [...fresh.childNodes]){
   let node=key(desired)?keyed.get(key(desired)):cursor&&!key(cursor)&&cursor.nodeType===desired.nodeType&&cursor.nodeName===desired.nodeName?cursor:null;
   if(!node||node.nodeName!==desired.nodeName){node=desired.cloneNode(true);target.insertBefore(node,cursor);}
   else{if(node!==cursor)target.insertBefore(node,cursor);
    if(node.nodeType===3){if(node.nodeValue!==desired.nodeValue)node.nodeValue=desired.nodeValue;}
    else if(node.nodeType===1){
     if(node.isEqualNode(desired)){cursor=node.nextSibling;continue;}
     for(const a of [...node.attributes])if(!desired.hasAttribute(a.name)&&!(a.name==='open'&&node.matches('details')))node.removeAttribute(a.name);
     for(const a of desired.attributes)if(a.name!=='open'&&node.getAttribute(a.name)!==a.value)node.setAttribute(a.name,a.value);
     if(node.matches('details[data-group]')&&desired.hasAttribute('open')!==node.open&&!node.dataset.userToggled)node.open=desired.hasAttribute('open');
     morph(node,desired);
    }}
   cursor=node.nextSibling;
  }
  while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
 })(parent,t.content);
}

// Keyed patch of a list described as data: a leaf {key,html} or a group {key,tag,attrs,children}. A leaf is parsed
// only when its html differs from the html it was built from, so a feed update that changes one price touches one row;
// unchanged rows keep their nodes (focus, hover, images, scroll). A focused row that changed is morphed, not replaced.
// In-place sync of a live element to a freshly parsed one with the same structure: attributes and text nodes are
// updated where they differ, children are matched by position and tag (an unmatched fresh child is moved in), so
// unchanged nodes - including loaded <img> logos - are never replaced.
function syncNode(a,b){
 for(const attr of [...a.attributes])if(!b.hasAttribute(attr.name))a.removeAttribute(attr.name);
 for(const attr of b.attributes)if(a.getAttribute(attr.name)!==attr.value)a.setAttribute(attr.name,attr.value);
 let ac=a.firstChild,bc=b.firstChild;
 while(bc){const next=bc.nextSibling;
  if(ac&&ac.nodeType===bc.nodeType&&(ac.nodeType!==1||ac.localName===bc.localName)){
   if(ac.nodeType===1)syncNode(ac,bc);else if(ac.nodeValue!==bc.nodeValue)ac.nodeValue=bc.nodeValue;
   ac=ac.nextSibling;
  }else a.insertBefore(bc,ac);
  bc=next;}
 while(ac){const n=ac.nextSibling;ac.remove();ac=n;}
}
function patchTree(parent,items){
 // Pass 1: find the leaves whose html changed and parse them all at once (one template, not one per row).
 const stale=[];
 (function collect(node,list){
  const existing=new Map();if(node)for(const n of node.children)if(n.__key!=null)existing.set(n.__key,n);
  for(const item of list){const cur=existing.get(item.key);if(item.children)collect(cur&&cur.localName===item.tag?cur:null,item.children);else if(!cur||cur.__html!==item.html)stale.push(item);}
 })(parent,items);
 if(stale.length){const t=document.createElement('template');t.innerHTML=stale.map(x=>x.html).join('');const nodes=[...t.content.children];stale.forEach((x,i)=>{x.fresh=nodes[i];});}
 // Pass 2: reuse unchanged nodes, place everything in order, drop what is gone.
 (function place(parent,items){
  const existing=new Map();for(const n of parent.children)if(n.__key!=null)existing.set(n.__key,n);
  items.forEach((item,i)=>{
   let node=existing.get(item.key);existing.delete(item.key);
   if(item.children){
    if(!node||node.localName!==item.tag){const fresh=document.createElement(item.tag);fresh.__key=item.key;if(node)node.remove();node=fresh;}
    for(const [k,v] of Object.entries(item.attrs||{}))if(node.getAttribute(k)!==v)node.setAttribute(k,v);
   }else if(item.fresh){
    const fresh=item.fresh;item.fresh=null;
    // A changed row is synced in place (only the text/attributes that differ): the row node, its logo images and its
    // geometry stay, so a price tick never rebuilds the row, re-decodes logos or moves the scroll anchor.
    if(node&&node.localName===fresh.localName)syncNode(node,fresh);
    else{if(node)node.remove();node=fresh;}
    node.__key=item.key;node.__html=item.html;
   }
   const at=parent.children[i];if(at!==node)parent.insertBefore(node,at||null);
   if(item.children)place(node,item.children);
  });
  while(parent.children.length>items.length)parent.lastElementChild.remove();
 })(parent,items);
}

function renderView(view,force=false){
 if(view!==tab||$('settingsView').hidden===false)return;
 const started=performance.now();invalidateNav();
 // A user whose administrator has not opened any section yet: say so instead of an empty screen.
 if(!Ent.views().length){$('toolbar').hidden=true;renderState(viewEl(view),Ent.needsKey()?{icon:'🔑',title:'Нужен ключ доступа',text:'Укажите ключ, который выдал администратор.',actions:'<button class="btn" data-open-settings="server">Подключение</button>'}:{title:'Нет доступных разделов',text:'Администратор ещё не открыл вам разделы. Изменения применяются без переустановки.'});updateListHead(view,0);return;}
 if(view==='live')renderLive(force);else if(view==='prematch')renderLine(force);else if(view==='results')renderResults(force);else if(view==='history')renderHistory(force);else if(view==='compare')renderCompare(force);
 renderChrome();Perf.measure('render.'+view,started);
}
function renderState(el,{icon='—',title,text='',kind='',actions=''}){morphInto(el,`<div class="state ${kind}" data-group="state"><div class="state-icon" aria-hidden="true">${icon}</div><strong>${esc(title)}</strong>${text?`<p>${esc(text)}</p>`:''}${actions?`<div class="actions">${actions}</div>`:''}</div>`);}
function skeleton(el,n=8){morphInto(el,`<div data-group="skeleton" aria-busy="true" aria-label="Загрузка">${Array.from({length:n},(_,i)=>`<div class="skeleton-row"><div class="skeleton sk" style="width:16px"></div><div class="skeleton sk two" style="width:${55+(i*13)%40}%"></div><div class="skeleton sk"></div><div class="skeleton sk"></div></div>`).join('')}</div>`);}
function emptyFor(view,current){
 const f=filters(view),none=BOOKS.every(s=>prefs[s]===false);
 if(none)return {title:'Все конторы выключены',text:'Включите хотя бы одну контору в списке источников.',actions:'<button class="btn" data-enable-books>Включить все конторы</button>'};
 if(current?.offline||current?.transportError&&!current?.events?.length)return {kind:'bad',icon:'!',title:'Сервер недоступен',text:`Не удаётся подключиться к ${BASE}. Запросы повторяются автоматически.`,actions:'<button class="btn" data-open-settings="server">Настройки сервера</button>'};
 if(prefs.onlyFavorites&&!f.search)return {title:'В избранном пока пусто',text:'Отметьте ☆ матч или лигу, чтобы видеть их здесь.',actions:'<button class="btn" data-reset-filters>Показать все матчи</button>'};
 if(filterCount(view))return {title:'Ничего не найдено',text:'Измените поиск или фильтры.',actions:'<button class="btn" data-reset-filters>Сбросить фильтры</button>'};
 if(view==='live')return {title:'Сейчас нет матчей в LIVE',text:'Список обновится автоматически, как только матч начнётся.'};
 return {title:'Матчей нет',text:'Список обновится автоматически.'};
}
// Game filter: an icon listbox (ui-kit.js) fed with the counts of the current view (or the server's facets).
const ALL_GAMES_ICON='<span class="game-icon gi-all" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2.5 2.5h4.5V7H2.5zM9 2.5h4.5V7H9zM2.5 9H7v4.5H2.5zM9 9h4.5v4.5H9z" fill="currentColor"/></svg></span>';
const gameMenu=UiKit.listbox({button:$('categoryButton'),list:$('categoryList'),render:{icon:o=>o.value===''?ALL_GAMES_ICON:gameIcon(o.label)},onChange:o=>{setFilter('category',o.value);setFilter('categoryLabel',o.value?o.label:'');filterChanged();}});
function categoryOptions(rows,facets=null,view=tab){
 const value=filters(view).category,groups=new Map();
 if(Array.isArray(facets))for(const f of facets){const label=String(f?.name||'Esports'),key=norm(label),g=groups.get(key)||{label,count:0};g.count+=Number(f?.count)||0;groups.set(key,g);}
 else for(const e of rows||[]){const key=norm(e.category),g=groups.get(key)||{label:e.category||'Esports',count:0};g.count++;groups.set(key,g);}
 if(value&&!groups.has(value))groups.set(value,{label:filters(view).categoryLabel||value,count:0});
 const total=[...groups.values()].reduce((n,g)=>n+g.count,0);
 const options=[{value:'',label:'Все игры',count:total},...[...groups].sort((a,b)=>alphabet.compare(a[1].label,b[1].label)).map(([key,g])=>({value:key,label:g.label,count:g.count}))];
 gameMenu.set(options,groups.has(value)?value:'');
}
let liveVisibleMemo={key:null,value:null};
function liveRowsVisible(){const rows=feedRows('live'),key=JSON.stringify([rowsCache.live.key,projectionSig('live'),filters('live'),prefs.onlyFavorites,prefs.favorites.length,prefs.showExtras,rules().revision,hiddenKeys('live').length]);if(liveVisibleMemo.rows===rows&&liveVisibleMemo.key===key)return liveVisibleMemo.value;const all=visible(rows,'live',{ignoreCategory:true});const value={all,rows:filters('live').category?all.filter(e=>norm(e.category)===filters('live').category):all};liveVisibleMemo={rows,key,value};return value;}
function renderLive(force){
 const el=viewEl('live'),s=snapshots.live,{all,rows}=liveRowsVisible();categoryOptions(all,null,'live');
 const books=viewBooks('live').filter(bookVisible);
 const sig=JSON.stringify([s?.revision,s?.receivedAt,s?.persisted,s?.offline,rows.length,rules().revision,prefs.liveSort,oddsHidden('live'),Ent.list().join(),books,prefs.favorites.length,filters('live'),prefs.onlyFavorites,prefs.teamLogos]);
 if(!force&&viewSignatures.get('live')===sig)return;viewSignatures.set('live',sig);
 el.style.setProperty('--books',books.length);
 if(!rows.length){if(!s)skeleton(el);else renderState(el,emptyFor('live',s));updateListHead('live',0);return;}
 const order=prefs.liveSort==='asc'?1:-1;
 const fav=new Map(rows.map(e=>[e,matchFavorite(e)?1:0])),clock=new Map(rows.map(e=>[e,MatchView.clock(e,'live')]));
 const sorted=[...rows].sort((a,b)=>fav.get(b)-fav.get(a)||order*(clock.get(a)-clock.get(b))||alphabet.compare(String(a.id),String(b.id)));
 const items=[{key:'head',html:listHeader('live',books)}],row=e=>({key:'r:'+e.id,html:cachedRow(e,'live',{books})});
 if(prefs.liveSort==='league'){
  const groups=new Map();for(const e of sorted){const key=norm(e.category)+'|'+norm(leagueTitle(e));if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
  const ordered=[...groups.values()].sort((a,b)=>Number(b.some(x=>fav.get(x)))-Number(a.some(x=>fav.get(x)))||alphabet.compare(a[0].category||'',b[0].category||'')||alphabet.compare(leagueTitle(a[0]),leagueTitle(b[0])));
  for(const list of ordered){const e=list[0],lk=e.leagueKey||LeagueModel.id(refs(e)[0]),lf=prefs.favorites.includes(lk),gk='g:'+norm(e.category)+'|'+norm(leagueTitle(e));
   items.push({key:gk,tag:'section',attrs:{'data-group':gk},children:[{key:'h',html:`<div class="group-head">${gameIcon(e.category)}<span>${esc(e.category||'')}</span><span class="league">${esc(leagueTitle(e))}</span><span class="n">${list.length}</span><button class="icon-btn" data-league-fav="${esc(lk)}" aria-pressed="${lf}" aria-label="${lf?'Убрать лигу из избранного':'Лига в избранное'}">${starIcon(lf)}</button></div>`},...list.map(x=>({key:'r:'+x.id,html:cachedRow(x,'live',{meta:false,books})}))]});}
 }else items.push({key:'flat',tag:'section',attrs:{'data-group':'flat'},children:sorted.map(row)});
 patchTree(el,items);saveLogosSoon();
 updateListHead('live',rows.length);
 scheduleOddsWatch(sorted);
 StatisticsClient.observe(rows);
 if(DetailPanel.isOpen()&&tab==='live'){const sel=rows.find(e=>String(e.id)===DetailPanel.currentId());if(sel)DetailPanel.update(sel);}
}

// Line: grouped by game > league (lazy league bodies) or a flat schedule rendered in pages.
// Collapse model (9.3): closed games are remembered; open leagues live only in this session and are forgotten whenever
// their game (or everything) is collapsed. So every reopen is deterministic: games expanded, leagues collapsed.
// (line-collapse.js)
let lineFold=LineCollapse.create();let lineSchedulePages=1,lineFullRender=false;
function saveLineState(){prefs.lineClosedGames=lineFold.closedGames().slice(-200);savePrefs();}
const plural=(n,[one,few,many])=>{const m=n%10,h=n%100;return `${n} ${m===1&&h!==11?one:m>=2&&m<=4&&(h<12||h>14)?few:many}`;};
function renderLine(force){
 const el=viewEl('prematch'),s=snapshots.prematch,all=visible(feedRows('prematch'),'prematch',{ignoreCategory:true});categoryOptions(all,null,'prematch');
 const cat=filters('prematch').category,rows=cat?all.filter(e=>norm(e.category)===cat):all,books=viewBooks('prematch').filter(bookVisible);
 const sig=JSON.stringify([s?.revision,s?.receivedAt,s?.persisted,s?.offline,rows.length,rules().revision,prefs.lineMode,oddsHidden('prematch'),Ent.list().join(),books,prefs.favorites.length,filters('prematch'),prefs.onlyFavorites,lineFold.signature(),lineSchedulePages,prefs.teamLogos,Math.floor(Date.now()/60000)]);
 if(!force&&viewSignatures.get('prematch')===sig)return;viewSignatures.set('prematch',sig);
 el.style.setProperty('--books',books.length);
 if(!rows.length){if(!s)skeleton(el);else renderState(el,emptyFor('prematch',s));updateListHead('prematch',0);return;}
 const sorted=[...rows].sort((a,b)=>Number(a.startAt||Infinity)-Number(b.startAt||Infinity)||alphabet.compare(String(a.id),String(b.id)));
 // First paint of an empty Line view: the first screen now, everything else right after it has painted.
 const firstScreen=!el.childElementCount&&!lineFullRender&&rows.length>60;
 if(firstScreen){lineFullRender=true;setTimeout(()=>{viewSignatures.delete('prematch');if(tab==='prematch')renderView('prematch',true);lineFullRender=false;},0);}
 let budget=firstScreen?40:Infinity;const take=list=>{const n=Math.max(0,Math.min(list.length,budget));budget-=n;return list.slice(0,n);};
 let html=listHeader('prematch',books);
 if(prefs.lineMode==='schedule'){
  const limit=Math.min(LINE_SCHEDULE_PAGE*lineSchedulePages,budget),shown=sorted.slice(0,limit),days=new Map();for(const e of shown){const d=dayKey(Number(e.startAt)||Date.now());if(!days.has(d))days.set(d,[]);days.get(d).push(e);}
  html+=[...days].map(([d,list])=>`<section data-group="d:${d}"><div class="group-head"><span>${esc(weekdayFmt.format(Date.parse(d+'T12:00:00Z')))}</span><span class="n">${list.length}</span></div>${list.map(e=>matchRow(e,'prematch',{books})).join('')}</section>`).join('');
  if(!firstScreen&&sorted.length>limit)html+=`<div class="list-more" data-group="more"><button class="btn" data-line-more>Показать ещё · осталось ${sorted.length-limit}</button></div>`;
 }else{
  const games=new Map();for(const e of sorted){const g=norm(e.category);if(!games.has(g))games.set(g,{name:e.category||'Esports',leagues:new Map(),count:0});const game=games.get(g),lk=g+'|'+norm(leagueTitle(e));game.count++;if(!game.leagues.has(lk))game.leagues.set(lk,[]);game.leagues.get(lk).push(e);}
  const filtered=!!(filters('prematch').search||prefs.onlyFavorites);
  // Game > league hierarchy: a closed game renders only its header (with its count), a closed league only its summary.
  const gameList=[...games].sort((a,b)=>alphabet.compare(a[1].name,b[1].name));
  const selectedLeague=lk=>(games.get(lk.split('|')[0])?.leagues.get(lk)||[]).some(e=>String(e.id)===selectedId('prematch'));
  const anyOpen=filtered||lineFold.anyOpen(gameList.map(([gk])=>'game:'+gk));
  const leagueCount=gameList.reduce((n,[,g])=>n+g.leagues.size,0);
  html+=`<div class="line-tools" data-group="line-tools"><span>${plural(gameList.length,['игра','игры','игр'])} · ${plural(leagueCount,['лига','лиги','лиг'])}</span>${filtered?'<span class="muted">поиск: всё раскрыто</span>':`<button type="button" class="icon-btn fold-btn" data-line-fold="${anyOpen?'close':'open'}" aria-label="${anyOpen?'Свернуть все игры':'Развернуть все игры'}" title="${anyOpen?'Свернуть все игры':'Развернуть все игры (лиги свёрнуты)'}">${UiKit.foldIcon(anyOpen)}</button>`}</div>`;
  html+=gameList.map(([gk,g])=>{const gameKey='game:'+gk,gameOpen=filtered||lineFold.gameOpen(gameKey)||[...g.leagues.keys()].some(selectedLeague);
   const leagues=gameOpen?[...g.leagues].sort((a,b)=>Number(a[1][0].startAt||0)-Number(b[1][0].startAt||0)||alphabet.compare(leagueTitle(a[1][0]),leagueTitle(b[1][0]))).map(([lk,list])=>{const open=filtered||lineFold.leagueOpen(lk)||selectedLeague(lk),e=list[0],key=e.leagueKey||LeagueModel.id(refs(e)[0]),lf=prefs.favorites.includes(key);return `<details class="group league-group" data-group="l:${esc(lk)}" ${open?'open':''}><summary class="group-head league-head" aria-label="${esc(leagueTitle(e))}: ${plural(list.length,['матч','матча','матчей'])}">${UiKit.chevron('caret')}<span class="league">${esc(leagueTitle(e))}</span><span class="n">${list.length} · с ${esc(stamp(e.startAt,true))}</span><button class="icon-btn" data-league-fav="${esc(key)}" aria-pressed="${lf}" aria-label="${lf?'Убрать лигу из избранного':'Лига в избранное'}" title="${lf?'Убрать лигу из избранного':'Лига в избранное'}">${starIcon(lf)}</button></summary>${open?take(list).map(x=>matchRow(x,'prematch',{meta:false,books})).join(''):''}</details>`;}).join(''):'';
   return `<details class="group game-group" data-group="${esc(gameKey)}" ${gameOpen?'open':''}><summary class="group-head game-head">${UiKit.chevron('caret')}${gameIcon(g.name)}<span>${esc(g.name)}</span><span class="n">${g.leagues.size>1?plural(g.leagues.size,['лига','лиги','лиг'])+' · ':''}${plural(g.count,['матч','матча','матчей'])}</span></summary>${leagues}</details>`;}).join('');
 }
 morphInto(el,html);
 updateListHead('prematch',rows.length);
 if(DetailPanel.isOpen()&&tab==='prematch'){const sel=rows.find(e=>String(e.id)===DetailPanel.currentId());if(sel)DetailPanel.update(sel);}
}

// Results: server view, cached per query (instant), refreshed with deltas.
let resultsDate=dayKey(),resultsLimit=RESULTS_PAGE_SIZE;
function serverQuery(view,limit,offset=0){
 const p=new URLSearchParams(),f=filters(view);p.set('limit',String(limit));if(offset>0)p.set('offset',String(offset));p.set('thin','1');
 if(f.search.trim())p.set('q',f.search.trim());if(f.category)p.set('category',f.category);if(f.availability&&f.availability!=='all')p.set('availability',f.availability);
 p.set('sources',BOOKS.filter(src=>prefs[src]!==false&&bookVisible(src)&&!OddsProvider.isOddsProvider(src)).join(','));
 p.set('showExtras',prefs.showExtras!==false?'1':'0');const hidden=hiddenKeys(view);if(hidden.length)p.set('hidden',hidden.join(','));
 if(prefs.onlyFavorites){p.set('favoriteOnly','1');if(prefs.favorites?.length)p.set('favorites',prefs.favorites.join(','));}
 if(f.startWindow)p.set('hours',f.startWindow);
 if(view==='results'&&f.startWindow){const end=resultsDate<dayKey()?Date.parse(resultsDate+'T23:59:59.999+04:00'):Math.floor(Date.now()/60000)*60000;p.set('end',String(end));}
 if(view==='history'&&f.historyPhase)p.set('phase',f.historyPhase);
 return p;
}
const resultsKey=()=>resultsDate+'|'+serverQuery('results',resultsLimit).toString();
async function fetchResults(key,signal){
 const [date,query]=[key.slice(0,10),key.slice(11)],p=new URLSearchParams(query),cached=resultsRes.peek(key)?.value;p.set('date',date);p.set('timezone',ZONE);
 if(cached&&Number.isFinite(Number(cached.uiRevision)))p.set('deltaSince',String(cached.uiRevision));
 const data=await client.get('/api/ui/results?'+p.toString(),{signal});
 if(!data?.delta)return {...data,receivedAt:Date.now()};
 const map=new Map((cached?.events||[]).map(e=>[String(e.id),e]));for(const id of data.remove||[])map.delete(String(id));for(const event of data.upsert||[])map.set(String(event.id),event);
 const ordered=[],seen=new Set();for(const id of data.order||[]){const ev=map.get(String(id));if(ev){ordered.push(ev);seen.add(String(id));}}for(const [id,ev] of map)if(!seen.has(id))ordered.push(ev);
 return {...cached,...data,events:ordered,receivedAt:Date.now(),delta:false};
}
let resultsError='';
function loadResults(force=false){
 const key=resultsKey(),date=resultsDate;
 const res=resultsRes.swr(key,{force,onValue:value=>{resultsError='';if(date===resultsDate){if(date===dayKey())persist.save('results',{key,value});if(tab==='results')renderView('results',true);}},onError:error=>{resultsError=errorText(error);if(tab==='results')renderView('results',true);}});
 return res;
}
function renderResults(force){
 const el=viewEl('results'),key=resultsKey(),entry=resultsRes.peek(key),current=entry?.value;
 if(!entry||!entry.fresh)loadResults(false);
 const rows=(current?.events||[]).map(e=>MatchView.project(e,prefs,'results')).filter(Boolean).sort((a,b)=>MatchView.clock(b,'results')-MatchView.clock(a,'results')||alphabet.compare(String(a.id),String(b.id)));
 categoryOptions(rows,current?.facets?.categories,'results');
 const sig=JSON.stringify([key,current?.uiRevision,current?.receivedAt,current?.status,resultsError,rows.length,prefs.favorites.length,prefs.teamLogos]);
 if(!force&&viewSignatures.get('results')===sig)return;viewSignatures.set('results',sig);
 if(!rows.length){
  const loading=!current||!current.complete||['loading','queued','preparing'].includes(current.status);
  if(!current&&!resultsError)skeleton(el);
  else if(resultsError&&!current)renderState(el,{kind:'bad',icon:'!',title:'Результаты не загрузились',text:resultsError,actions:'<button class="btn" data-retry-results>Повторить</button>'});
  else if(loading)renderState(el,{icon:'…',title:'Собираем результаты дня',text:current?.status==='retrying'?'Получение прервано, сервер повторит запрос.':'Сервер получает данные контор. Это может занять до минуты для архивных дат.'});
  else renderState(el,emptyFor('results',current));
  updateListHead('results',0,current);return;
 }
 const html=`<div class="col-head cols results" data-group="head"><span></span><span>Матч</span><span class="right">Итог</span><span class="right">Окончание</span><span class="right">Конторы</span><span></span></div><section data-group="rows">${rows.map(e=>resultRow(e)).join('')}</section>${current?.hasMore?`<div class="list-more" data-group="more"><button class="btn" data-more-results>Показать ещё · осталось ${Math.max(0,(current.total||0)-rows.length)}</button></div>`:''}`;
 morphInto(el,html);
 updateListHead('results',current?.total??rows.length,current);
 StatisticsClient.observe(rows);
 if(DetailPanel.isOpen()&&tab==='results'){const sel=rows.find(e=>String(e.id)===DetailPanel.currentId());if(sel)DetailPanel.update(sel);}
}
function lastRemoval(r){const t=(r.timeline||[]).filter(c=>c.type==='removed'&&c.phase==='live').map(c=>Number(c.at)||0),l=t.length?[]:(r.lifecycle||[]).filter(c=>c.type==='removed').map(c=>Number(c.at)||0);return Math.max(0,...t,...l,Number(r.removedAt||0))||Number(r.endedAt||0);}
function resultRow(e){
 const sel=selectedId('results')===String(e.id),fav=matchFavorite(e),d=MatchFormat.canonicalScore(refs(e)).best||MatchFormat.displayScore(refs(e)[0]||e,e),verified=refs(e).some(r=>r.resultVerified),ended=Math.max(0,...refs(e).map(lastRemoval));
 // Same score style as LIVE (series + maps); verification is a compact mark with a tooltip, not a sentence per row.
 const score=d.series?`<span class="series num">${d.series[0]}:${d.series[1]}</span>`:`<span class="score-text">${esc(d.text||'—')}</span>`;
 const maps=d.series?mapsLine(d,false):'';
 const mark=verified?'<span class="res-mark ok" title="Результат подтверждён конторой" aria-label="подтверждён">✓</span>':'<span class="res-mark" title="Счёт ещё не подтверждён конторой" aria-label="не подтверждён">?</span>';
 const sameDay=ended&&e.startAt&&dateFmt.format(ended)===dateFmt.format(e.startAt);
 return `<article class="match cols results" data-id="${esc(e.id)}" tabindex="0" aria-selected="${sel}" aria-label="${esc(e.team1)} — ${esc(e.team2)}">${favButton(fav)}${teamsCell(e)}<div class="score-col final"><span class="final-line">${mark}${score}</span>${maps}</div><div class="when"><span class="strong" title="Окончание">${esc(stamp(ended,false))}</span><small title="Начало матча">начало ${esc(stamp(e.startAt,!sameDay))}</small></div>${sourcesCell(e,'results')}<span class="go" aria-hidden="true">›</span></article>`;
}

// History: progressive sections (history-loader.js) - LIVE, line, then the archive day by day, newest first. Only the
// sections that changed are re-rendered (keyed patch, per-row html memo); older days load one at a time when the end of
// the list comes into view or on the explicit button. A server invalidation refreshes LIVE/line/today, never past days.
const History=HistoryLoader.create({pageSize:HISTORY_PAGE_SIZE,fetchPage:(query,{signal})=>fetchHistory(query,signal),onChange:()=>{if(tab==='history')scheduleRender('history');scheduleHistoryPersist();}});
async function fetchHistory(query,signal){const started=performance.now(),data=await client.get('/api/ui/history?'+query,{signal});Perf.measure('history.request',started);if(data?.deferred)throw Object.assign(new Error('История готовится на сервере'),{deferred:true,retryAfterMs:data.retryAfterMs});return data;}
function historyBase(){const p=serverQuery('history',HISTORY_PAGE_SIZE);for(const k of ['limit','offset','hours','phase'])p.delete(k);return p.toString();}
function syncHistoryQuery(){const f=filters('history'),before=History.current();const q=History.setQuery({base:historyBase(),phase:f.historyPhase||'',hours:Number(f.startWindow)||0});if(q!==before){historyWindow.parked.clear();const el=viewEl('history');if(el)el.scrollTop=0;}return q;}
let historyPersistTimer=0;
function scheduleHistoryPersist(){if(historyPersistTimer)return;historyPersistTimer=setTimeout(()=>{historyPersistTimer=0;const snap=History.snapshot(300);if(snap)persist.save('history',{v:2,snap});},5000);}
const dayTitle=day=>{const today=dayKey(),label=weekdayFmt.format(Date.parse(day+'T12:00:00Z'));return day===today?'Сегодня · '+label:day===shiftDay(today,-1)?'Вчера · '+label:label;};
function historySectionTitle(s){return s.kind==='live'?'Сейчас в LIVE':s.kind==='line'?'Сейчас в линии':dayTitle(s.day);}
// While the server's LIVE / line History query is still running (it can take seconds on a busy server), the section is
// shown from the extension's own LIVE / line feed with the same History filters and projection; the server's answer
// replaces it. Nothing extra is requested.
function historyFeedRows(kind){const rows=visible(feedRows(kind==='live'?'live':'prematch'),'history');return (kind==='line'?rows.filter(e=>!refs(e).some(r=>r.inLive)):rows).sort((a,b)=>MatchView.appearance(b)-MatchView.appearance(a)||alphabet.compare(String(a.id),String(b.id)));}
const historyProvisional=s=>s.kind!=='day'&&!s.rows.length&&['loading','idle'].includes(s.state)?historyFeedRows(s.kind):null;
function historySectionHead(s,provisional=null,shown=null){
 if(provisional)return `<div class="group-head history-head">${s.kind==='live'?'<span class="dot bad" aria-hidden="true"></span>':'<span class="dot accent" aria-hidden="true"></span>'}<span class="title">${esc(historySectionTitle(s))}</span><span class="n">${plural(provisional.length,['матч','матча','матчей'])}</span><span class="sec-state" role="status" title="Показано по ленте ${s.kind==='live'?'LIVE':'линии'}, история сервера ещё загружается"><span class="spinner" aria-hidden="true"></span>уточняется</span></div>`;
 // The count is what the section shows: rows hidden by the History projection (e.g. LIVE-only matches never seen in the
 // line, or a switched-off bookmaker) are not counted; while more pages exist the server total is shown.
 const n=s.rows.length,count=s.state==='ready'||n?plural(s.hasMore||shown==null?s.total:shown,['матч','матча','матчей']):'',mark=s.kind==='live'?'<span class="dot bad" aria-hidden="true"></span>':s.kind==='line'?'<span class="dot accent" aria-hidden="true"></span>':'';
 const state=s.state==='loading'?'<span class="sec-state" role="status"><span class="spinner" aria-hidden="true"></span>загрузка</span>':s.state==='error'?`<span class="sec-state bad" role="alert">не загрузилось</span><button class="btn small" data-history-retry="${esc(s.id)}">Повторить</button>`:'';
 return `<div class="group-head history-head">${mark}<span class="title">${esc(historySectionTitle(s))}</span>${s.kind==='day'?'<span class="sub">сняты с линии и LIVE</span>':''}<span class="n">${count}</span>${state}</div>`;
}
function historyRowCached(e,inDay){
 const sig=[inDay,selectedId('history')===String(e.id),matchFavorite(e),teamLogo(e,1),teamLogo(e,2),Ent.can('favorites')].join('|');
 const hit=rowHtmlMemo.get(e);if(hit&&hit.sig===sig)return hit.html;
 const html=historyRow(e,inDay);rowHtmlMemo.set(e,{sig,html});return html;
}
function renderHistory(force){
 const el=viewEl('history');syncHistoryQuery();History.ensureInitial();
 const sections=History.sections(),st=History.status();
 categoryOptions(null,History.facets()||[],'history');
 const sig=JSON.stringify([History.version(),selectedId('history'),prefs.favorites.length,prefs.teamLogos,Logos.version(),[...historyWindow.parked.keys()].join()]);
 if(!force&&viewSignatures.get('history')===sig)return;viewSignatures.set('history',sig);
 const started=performance.now(),provisional=new Map(sections.map(s=>[s.id,historyProvisional(s)]).filter(([,r])=>r?.length)),any=sections.some(s=>s.rows.length)||provisional.size>0;
 if(!any){
  const err=sections.find(s=>s.state==='error');
  if(sections.some(s=>s.state==='loading'||s.state==='idle')&&!err){skeleton(el,10);updateListHead('history',0);return;}
  if(err&&sections.every(s=>s.state==='error'||!s.rows.length)&&!sections.some(s=>s.state==='loading')){const wait=/готовится/.test(err.error);renderState(el,{kind:wait?'':'bad',icon:wait?'…':'!',title:wait?'История готовится':'История не загрузилась',text:wait?'Сервер собирает историю, список появится автоматически.':err.error,actions:'<button class="btn" data-history-retry-all>Повторить</button>'});if(wait)setTimeout(()=>{if(tab==='history')for(const s of History.sections())if(s.state==='error')History.retry(s.id);},Math.max(3000,Number(err.retryAfterMs)||0));updateListHead('history',0);return;}
  if(!st?.canLoadOlder||st.paused){renderState(el,emptyFor('history',{}));updateListHead('history',0);return;}
 }
 const items=[{key:'head',html:'<div class="col-head cols history" data-group="head"><span></span><span>Матч</span><span class="right">Появился</span><span class="right">Начало</span><span class="right">Конторы</span><span></span></div>'}];
 for(const s of sections){
  if(s.kind==='day'&&s.state==='ready'&&!s.total)continue;          // an empty past day takes no space
  const inDay=s.kind==='day',feed=provisional.get(s.id)||null,list=feed||s.rows,projected=list.map(raw=>projectRow(raw,'history')).filter(Boolean),children=[{key:'h',html:historySectionHead(s,feed,projected.length)}];
  if(s.kind==='day'&&s.state==='ready'&&!s.hasMore&&!projected.length)continue;
  // Windowing: a section far outside the viewport keeps only its header and a placeholder of its measured height.
  if(historyWindow.parked.has(s.id)&&s.rows.length&&!s.rows.some(x=>String(x.id)===selectedId('history')))children.push({key:'ph',html:`<div class="section-ph" style="height:${Math.max(40,historyWindow.parked.get(s.id))}px" aria-hidden="true"></div>`});
  else for(const e of projected)children.push({key:'r:'+e.id,html:historyRowCached(e,inDay)});
  if(!list.length&&s.state==='loading')children.push({key:'sk',html:`<div class="skeleton-rows" aria-hidden="true">${'<div class="skeleton-row"><div class="skeleton sk" style="width:16px"></div><div class="skeleton sk two"></div><div class="skeleton sk"></div><div class="skeleton sk"></div></div>'.repeat(3)}</div>`});
  if(s.state==='ready'&&!projected.length&&!s.hasMore&&!inDay)children.push({key:'empty',html:`<div class="section-empty">${s.kind==='live'?'Сейчас нет матчей в LIVE':'Сейчас нет матчей в линии'}</div>`});
  if(s.hasMore)children.push({key:'more',html:`<div class="list-more inline"><button class="btn" data-history-more="${esc(s.id)}" ${s.state==='loading'?'disabled':''}>${s.state==='loading'?'Загружаем…':`Показать ещё ${Math.min(HISTORY_PAGE_SIZE,s.total-s.rows.length)} · осталось ${s.total-s.rows.length}`}</button></div>`});
  items.push({key:'s:'+s.id,tag:'section',attrs:{'data-group':'s:'+s.id,class:'history-section','aria-label':historySectionTitle(s)},children});
 }
 const loadingDay=sections.some(s=>s.kind==='day'&&s.state==='loading'&&s.rows.length===0&&s!==sections.find(x=>x.kind==='day'));
 const rest=st?.remaining,next=st?.next?weekdayFmt.format(Date.parse(st.next+'T12:00:00Z')):'';
 // The server's count of older matches is exact only when it scanned the whole archive; otherwise it is a lower bound.
 const restText=rest?(st.remainingExact?` · осталось ${plural(rest,['матч','матча','матчей'])}`:` · ещё не менее ${plural(rest,['матча','матчей','матчей'])}`):'';
 let foot;
 if(loadingDay)foot=`<div class="list-more" id="historySentinel"><span class="sec-state"><span class="spinner" aria-hidden="true"></span>Загружаем более ранние матчи…</span></div>`;
 else if(st?.paused)foot=`<div class="list-more" id="historySentinel"><span class="muted">За несколько дней подряд матчей нет${restText}</span><button class="btn" data-history-older>Искать раньше</button></div>`;
 else if(st?.canLoadOlder)foot=`<div class="list-more" id="historySentinel"><button class="btn" data-history-older>Загрузить ${esc(next)}${restText}</button></div>`;
 else foot='<div class="list-end">Это вся история по фильтрам</div>';
 items.push({key:'foot',html:foot});
 patchTree(el,items);saveLogosSoon();observeHistorySections(el);
 updateListHead('history',st?.total||0);
 const sentinel=$('historySentinel');if(sentinel!==historyObserved){historyObserver.disconnect();historyObserved=sentinel;if(sentinel)historyObserver.observe(sentinel);}
 if(sentinel)requestAnimationFrame(()=>{if(tab==='history'&&sentinel.isConnected&&historyNearEnd())historyAutoMore();});
 if(DetailPanel.isOpen()&&tab==='history'){const sel=History.find(DetailPanel.currentId());if(sel){const e=projectRow(sel,'history');if(e)DetailPanel.update(e);}}
 Perf.measure('history.render',started);
}
let historyObserved=null;
// Sections more than ~1.5 screens away are parked (rows unmounted) and restored when they come back near the viewport:
// the DOM holds a few hundred rows however deep the user scrolls.
const historyWindow={parked:new Map(),observed:new Set(),io:null,frame:0};
function observeHistorySections(el){
 if(!historyWindow.io)historyWindow.io=new IntersectionObserver(entries=>{let dirty=false;for(const en of entries){const id=String(en.target.dataset.group||'').slice(2);if(!id)continue;
   if(en.isIntersecting){if(historyWindow.parked.delete(id))dirty=true;}
   else if(!historyWindow.parked.has(id)&&en.target.querySelector('article.match')){historyWindow.parked.set(id,Math.round(en.boundingClientRect.height)-(en.target.querySelector('.group-head')?.offsetHeight||34));dirty=true;}}
  if(dirty&&!historyWindow.frame)historyWindow.frame=requestAnimationFrame(()=>{historyWindow.frame=0;viewSignatures.delete('history');if(tab==='history')renderView('history',true);});},{root:el,rootMargin:'150% 0px 150% 0px'});
 // observe new sections, release the ones a new query removed (no detached nodes kept alive)
 for(const sec of historyWindow.observed)if(!sec.isConnected){historyWindow.io.unobserve(sec);historyWindow.observed.delete(sec);}
 for(const sec of el.querySelectorAll(':scope>section.history-section'))if(!historyWindow.observed.has(sec)){historyWindow.observed.add(sec);historyWindow.io.observe(sec);}
}
const historyObserver=new IntersectionObserver(entries=>{if(tab==='history'&&entries.some(e=>e.isIntersecting))historyAutoMore();},{root:null,rootMargin:'600px'});
// A second trigger next to the observer: when the sentinel already sits inside the observer's margin, further scrolling
// produces no new intersection; one rAF-throttled check per scroll frame covers that case.
let historyScrollFrame=0;
viewEl('history')?.addEventListener('scroll',()=>{if(historyScrollFrame)return;historyScrollFrame=requestAnimationFrame(()=>{historyScrollFrame=0;if(tab==='history'&&historyNearEnd())historyAutoMore();});},{passive:true});
function historyNearEnd(){const el=viewEl('history'),s=$('historySentinel');if(!el||!s)return false;return s.getBoundingClientRect().top-el.getBoundingClientRect().bottom<600;}
// The end of the list is in view: the last section's next page, else the next older day (one request at a time).
function historyAutoMore(){if(document.hidden||$('settingsView').hidden===false)return;const st=History.status();if(!st||st.loadingOlder||st.paused)return;const last=History.sections().filter(s=>s.rows.length).at(-1);if(last?.state==='loading')return;if(last?.hasMore&&last.kind==='day')History.loadMore(last.id);else History.loadOlder();}
function historyRow(e,inDay){
 const sel=selectedId('history')===String(e.id),fav=matchFavorite(e),appeared=MatchView.appearance(e);
 return `<article class="match cols history" data-id="${esc(e.id)}" tabindex="0" aria-selected="${sel}" aria-label="${esc(e.team1)} — ${esc(e.team2)}">${favButton(fav)}${teamsCell(e)}<div class="when strong" title="Появился в линии">${esc(stamp(appeared,!inDay))}</div><div class="when" title="Начало матча">${esc(stamp(e.startAt,true))}</div>${sourcesCell(e,'history')}<span class="go" aria-hidden="true"></span></article>`;
}

function reloadServerView(view){if(view==='results'){resultsLimit=RESULTS_PAGE_SIZE;loadResults(true);}else if(view==='history'){syncHistoryQuery();}viewSignatures.delete(view);renderView(view,true);}
function handleUiInvalidate(message={}){
 const view=String(message.view||'');
 if(view==='results'){resultsRes.invalidate(key=>!message.date||key.startsWith(String(message.date)+'|'));if(tab==='results'&&(!message.date||message.date===resultsDate))setTimeout(()=>loadResults(false),250);}
 else if(view==='history'){History.invalidate();scheduleHistoryRefresh();}
 else if(view==='leagues'&&settingsState.catalog)settingsState.catalog.receivedAt=0;
}
function reconcileServerViews(){if(document.hidden)return;if(tab==='results')loadResults(false);if(tab==='history'){History.ensureInitial();scheduleHistoryRefresh();}}
// Server invalidations come with every structural feed change: refresh the current History sections at most every 30 s,
// and only while History is on screen (another tab refreshes when it is opened).
let historyRefreshTimer=0,historyRefreshedAt=0;
function scheduleHistoryRefresh(){if(historyRefreshTimer)return;const wait=Math.max(900,30000-(Date.now()-historyRefreshedAt));historyRefreshTimer=setTimeout(()=>{historyRefreshTimer=0;if(tab!=='history'||document.hidden)return;historyRefreshedAt=Date.now();History.refresh();},wait);}

// ---------------------------------------------------------------------------------------------------- chrome ----
function bookHealth(source){
 const s=source==='pinnacle'&&!snapshots.live?.providers?.pinnacle?snapshots.prematch:snapshots.live,r=s?.providers?.[source];
 if(OddsProvider.isOddsProvider(source)){if(source!==OddsProvider.selected(prefs))return null;const h=OddsProvider.health(snapshots.live,prefs);return snapshots.live?.transportError?null:{...h,reason:UserText.sourceReason(h.reason,{admin:Ent.isAdmin()})};}
 if(!s||s.transportError||!r)return null;
 const error=String(r.lastError||'').trim(),http=Number(r.lastHttpStatus||0);
 if(error||http>=400)return {ok:false,reason:UserText.sourceReason(error||`HTTP ${http}`,{admin:Ent.isAdmin()})};
 if(r.stale&&!r.updating)return {ok:false,reason:'данные задерживаются'};
 return {ok:true,reason:''};
}
function sourceRows(){
 const serverDown=!!snapshots.live?.transportError;
 return BOOKS.map(source=>{
  const enabled=prefs[source]!==false;
  let state='online',text='работает',detail='';
  const r=(source==='pinnacle'&&!snapshots.live?.providers?.pinnacle?snapshots.prematch:snapshots.live)?.providers?.[source];
  if(!enabled){state='off';text='скрыт';}
  else if(serverDown){state='unknown';text='нет связи с сервером';}
  else if(!snapshots.live&&!snapshots.prematch){state='unknown';text='ожидаем данные';}
  else{const h=bookHealth(source);if(h&&!h.ok){state='bad';text='недоступен';detail=h.reason;}else if(r?.partial){state='warn';text='частичные данные';}
   const at=Date.parse(r?.lastSuccessfulUpdateAt||r?.lastUpdateAt||'');if(at&&state==='online')detail=`обновлено ${stamp(at,false,true)}`;}
  return {source,state,text,detail,enabled};
 });
}
function renderSources(){
 const rows=sourceRows(),active=rows.filter(r=>r.state!=='off'),online=active.filter(r=>r.state==='online').length,bad=active.some(r=>r.state==='bad'),down=!!snapshots.live?.transportError&&!snapshots.live?.events?.length;
 $('sourcesCount').textContent=down?'нет связи':`${online}/${active.length}`;
 $('sourcesDot').className='dot '+(down?'bad':bad||online<active.length?'warn':'good');
 $('sourcesButton').setAttribute('aria-label',`Источники: ${down?'нет связи с сервером':online+' из '+active.length+' работают'}`);
 if($('sourcesPopover').hidden)return;
 const html=`<h3>Источники данных</h3>${rows.map(r=>`<div class="source-row" data-group="${r.source}"><span class="book-mark ${r.source}" aria-hidden="true"></span><span class="who"><span class="name">${esc(providerName(r.source))}</span>${r.detail?`<small title="${esc(r.detail)}">${esc(r.detail)}</small>`:''}</span><span class="src-state ${r.state==='bad'?'bad':r.state==='warn'?'warn':''}"><span class="dot ${r.state==='online'?'good':r.state==='bad'?'bad':r.state==='warn'?'warn':''}" aria-hidden="true"></span>${esc(r.text)}</span><label class="switch" title="Показывать ${esc(providerName(r.source))}"><input type="checkbox" data-book-toggle="${r.source}" ${r.enabled?'checked':''} aria-label="Показывать ${esc(providerName(r.source))}"></label></div>`).join('')}<div class="popover-foot"><span>Сервер: ${esc(BASE.replace(/^https?:\/\//,''))}</span><button class="link-btn" data-open-settings="sources">Настроить</button></div>`;
 morphInto($('sourcesPopover'),html);
}
function connectionState(){const s=snapshots.live;if(!s)return port?{kind:'loading'}:{kind:'loading'};if(s.offline||s.transportError&&!s.events?.length)return {kind:'down',error:s.transportError};if(s.transportError)return {kind:'stale',error:s.transportError,at:s.receivedAt};return {kind:s.persisted?'cached':'ok',at:s.receivedAt};}
function renderBanner(){
 const c=connectionState(),b=$('banner');let html='',cls='';
 if(Ent.needsKey()){cls='warn';html='<strong>Нужен ключ доступа.</strong><span>Укажите ключ, который выдал администратор.</span><button class="btn" data-open-settings="server">Подключение</button>';}
 else if(c.kind==='down'){cls='bad';const why=Ent.isAdmin()&&!/^сервер недоступен$/i.test(String(c.error||'').trim())?UserText.sanitize(c.error||''):'';html=`<strong>Сервер недоступен.</strong><span>${why?esc(why)+' · ':''}Переподключаемся автоматически.</span><button class="btn" data-open-settings="server">Подключение</button>`;}
 else if(c.kind==='stale'){cls='warn';html=`<strong>Нет связи с сервером.</strong><span>Показаны данные от ${esc(stamp(c.at,false,true))}. Переподключаемся…</span>`;}
 b.hidden=!html;if(html&&b.dataset.html!==html){b.dataset.html=html;b.innerHTML=html;}b.className='banner '+cls;
 const pn=$('providerNotice');
 const health=tab==='live'&&!c.kind.match(/down|stale/)?OddsProvider.health(snapshots.live,prefs):null,show=health&&!health.ok&&prefs[OddsProvider.selected(prefs)]!==false;
 // The technical reason stays with administrators; in "Auto" mode the other platform feed is chosen automatically.
 if(show){const reason=UserText.sourceReason(health.reason,{admin:Ent.isAdmin()}),h=`<strong>${esc(health.label)} временно недоступен</strong><span>${reason?esc(reason)+' · ':''}его коэффициенты не показываются, остальные конторы работают.</span>`;if(pn.dataset.html!==h){pn.dataset.html=h;pn.innerHTML=h;}}
 pn.hidden=!show;
}
function updateListHead(view,count,meta=null){
 if(view!==tab)return;
 const s=view==='live'?snapshots.live:view==='prematch'?snapshots.prematch:meta;
 $('viewCount').textContent=count?(view==='live'?`${count} в LIVE`:view==='prematch'?`${count} в линии`:view==='results'?plural(count,['результат','результата','результатов']):plural(count,['матч','матча','матчей'])):'';
 let note='';if(view==='results')note=resultsNote(meta);
 if(['live','prematch'].includes(view)){const stale=Object.entries(s?.providers||{}).filter(([k,r])=>r?.stale&&!r?.updating&&bookVisible(k)&&!OddsProvider.isOddsProvider(k)).map(([k])=>providerName(k));if(stale.length)note=`Задерживаются: ${stale.join(', ')} — показаны последние данные`;}
 $('viewNote').textContent=note;
 const at=s?.receivedAt||Date.parse(s?.generatedAt||'')||0,el=$('viewUpdated');
 if(['live','prematch'].includes(view)){el.textContent=s?.persisted?`сохранено ${stamp(at,false,true)} · обновляем…`:at?`обновлено ${stamp(at,false,true)}`:'';el.classList.toggle('stale',!!s?.persisted||!!s?.transportError);}
 else el.textContent=at?`обновлено ${stamp(at,false,true)}`:'';
}
function resultsNote(current){if(!current)return '';if(current.refreshing||current.queued)return current.queued?'обновление в очереди':'проверяем финальные счета…';const next=current.nextRefreshAt||current.nextRetryAt;if(next&&resultsDate===dayKey()){const s=Math.max(0,Math.ceil((next-Date.now())/1000));return s?`следующая проверка через ${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`:'';}return '';}
function updateNavCounts(){const n=liveRowsVisible().rows.length;$('liveCount').textContent=snapshots.live?String(n):'';}
function renderChrome(){
 for(const b of $('tabs').querySelectorAll('[data-tab]'))b.setAttribute('aria-current',b.dataset.tab===tab&&$('settingsView').hidden?'page':'false');
 if(prefs.compareMode==='schedule'&&!Ent.can('compare.schedule'))prefs.compareMode='odds';
 const t=tab,f=filters(t),inSettings=!$('settingsView').hidden;
 $('toolbar').hidden=inSettings||!Ent.views().length;
 const show=(id,on)=>{$(id).hidden=!on;};
 const cmpSchedule=t==='compare'&&prefs.compareMode==='schedule';
 // search and game keep their place in every section (no layout jump); where they do not apply they are inert
 for(const el of [$('search').closest('.search'),$('gameMenu')]){el.classList.toggle('tb-off',cmpSchedule);el.inert=cmpSchedule;}
show('availability',!['compare'].includes(t));show('startWindow',['prematch','results','history'].includes(t));
 show('historyPhase',t==='history');show('liveSort',t==='live');show('lineMode',t==='prematch');show('dateControl',t==='results');
 show('compareMode',t==='compare'&&Ent.can('compare.schedule'));show('compareScope',t==='compare'&&!cmpSchedule);show('compareSort',t==='compare'&&!cmpSchedule&&Ent.can('compare.arbitrage'));$('compareSort').value=prefs.compareSort||'time';show('favorites',!cmpSchedule);
 if(document.activeElement!==$('search')&&$('search').value!==f.search)$('search').value=f.search;
 $('availability').value=f.availability;$('historyPhase').value=f.historyPhase;$('liveSort').value=prefs.liveSort;
 $('favorites').setAttribute('aria-pressed',String(!!prefs.onlyFavorites));
 for(const b of $('lineMode').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.lineMode===prefs.lineMode));
 for(const b of $('compareMode').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.compareMode===prefs.compareMode));
 for(const b of $('compareScope').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.compareScope===prefs.compareScope));
 {const opt=$('availability').querySelector('option[value=ggbet]');if(opt)opt.hidden=t!=='live';}
 timeOptions(t);
 $('dateButton').textContent=resultsDate===dayKey()?'Сегодня, '+resultsDate.split('-').reverse().slice(0,2).join('.'):resultsDate.split('-').reverse().join('.');$('nextDate').disabled=resultsDate>=dayKey();$('today').hidden=resultsDate===dayKey();
 const n=filterCount(t),reset=$('resetFilters');reset.dataset.off=String(!n);reset.setAttribute('aria-hidden',String(!n));reset.tabIndex=n?0:-1;reset.textContent=n?`Сбросить · ${n}`:'Сбросить';
 renderSources();renderBanner();
}
function timeOptions(view){
 const sel=$('startWindow'),past=['history','results'].includes(view),archived=view==='results'&&resultsDate<dayKey();
 const first=view==='history'?'Любое время появления':view==='results'?'Любое время результата':'Любое время начала';
 const opts=[['',first],...[1,6,12,24].map(h=>[String(h),past?(archived?(h===24?'Весь день':`Последние ${h} ч дня`):(h===1?'За последний час':h===24?'За сутки':`За последние ${h} ч`)):(h===1?'В ближайший час':h===24?'В ближайшие сутки':`В ближайшие ${h} ч`)])];
 const html=opts.map(([v,l])=>`<option value="${v}">${l}</option>`).join('');if(sel.dataset.html!==html){sel.innerHTML=html;sel.dataset.html=html;}sel.value=filters(view).startWindow||'';
}

// ---------------------------------------------------------------------------------------------------- navigation
function switchTab(next,{focus=false}={}){
 if(!VIEWS.includes(next))next='live';
 const started=performance.now(),wasSettings=!$('settingsView').hidden;
 closeSettings(false);
 if(next===tab&&!wasSettings){viewEl(tab).scrollTo({top:0,behavior:'smooth'});return;}
 tab=next;prefs.lastTab=next;savePrefs();
 for(const el of document.querySelectorAll('#content>.list'))el.hidden=el.dataset.view!==tab;
 // The detail panel follows the tab: each tab remembers its own selected match.
 const sel=selectedId(tab),row=sel?findRow(tab,sel):null;
 if(row)DetailPanel.show(projected(tab,row),detailView(tab,row));else DetailPanel.hide();
 layoutDetail();
 // A section that is already rendered is shown as it is; newer data is applied right after the switch has painted.
 // requestAnimationFrame + setTimeout: the data refresh runs after the next frame, never before it.
 if(viewEl(tab).childElementCount){renderChrome();const shown=tab;requestAnimationFrame(()=>setTimeout(()=>{if(tab===shown)renderView(shown);},0));}else{renderView(tab);renderChrome();}
 sendActivity();
 if(focus)$('tabs').querySelector(`[data-tab="${tab}"]`)?.focus({preventScroll:true});
 Perf.measure('tab.'+tab+'.sync',started);Perf.frame('tab.'+tab+'.paint');
}
function findRow(view,id){
 if(!id)return null;const match=e=>String(e.id)===String(id);
 if(view==='live')return feedRows('live').find(match)||null;
 if(view==='prematch')return feedRows('prematch').find(match)||null;
 if(view==='results')return (resultsRes.peek(resultsKey())?.value?.events||[]).find(match)||null;
 if(view==='history')return History.find(id)||feedRows('live').find(match)||feedRows('prematch').find(match)||null;
 if(view==='compare')return [...feedRows('live'),...feedRows('prematch')].find(match)||null;
 return null;
}
const detailView=(view,e)=>view==='compare'?(e?.inLive?'live':'prematch'):view;
function projected(view,e){return e?MatchView.project(e,prefs,detailView(view,e))||e:null;}
function selectMatch(id,{focusPanel=false}={}){
 const started=performance.now(),e=projected(tab,findRow(tab,id));if(!e)return;
 selectedIds.set(tab,String(e.id));
 for(const n of viewEl(tab).querySelectorAll('[aria-selected="true"]'))n.setAttribute('aria-selected','false');
 viewEl(tab).querySelector(`[data-id="${CSS.escape(String(e.id))}"]`)?.setAttribute('aria-selected','true');
 DetailPanel.show(e,detailView(tab,e));layoutDetail();
 if(focusPanel)$('detailPane').querySelector('.detail-tabs .tab[aria-selected="true"]')?.focus({preventScroll:true});
 Perf.measure('detail.open.sync',started);Perf.frame('detail.open.paint');
}
const isOpenMatch=id=>DetailPanel.isOpen()&&String(DetailPanel.currentId())===String(id);
function closeDetailTo(row){DetailPanel.hide();row?.focus?.({preventScroll:true});}
function layoutDetail(){const open=DetailPanel.isOpen();$('workspace').classList.toggle('with-detail',open);$('drawerBackdrop').hidden=!open;}
function onDetailClosed(){selectedIds.delete(tab);for(const n of viewEl(tab).querySelectorAll('[aria-selected="true"]'))n.setAttribute('aria-selected','false');layoutDetail();}

// ---------------------------------------------------------------------------------------------------- odds watch
let oddsWatchIds=[],oddsWatchSig='',oddsWatchTimer=0;
function scheduleOddsWatch(rows){const sel=selectedId('live'),ids=[...new Set([...(sel?[sel]:[]),...rows.slice(0,8).map(e=>String(e.id))])].slice(0,9),sig=ids.join('|');oddsWatchIds=ids;if(sig===oddsWatchSig)return;oddsWatchSig=sig;clearTimeout(oddsWatchTimer);oddsWatchTimer=setTimeout(pushOddsWatch,150);}
async function pushOddsWatch(){if(!Ent.canView('live'))return;const ids=tab==='live'&&!document.hidden&&!oddsHidden('live')?oddsWatchIds:[];try{await client.post('/api/ui/odds-watch',{ids});}catch{}}
setInterval(()=>{if(tab==='live'&&!document.hidden&&oddsWatchIds.length)pushOddsWatch();},15000);

// ---------------------------------------------------------------------------------------------------- keyboard --
// Arrow navigation over long lists. A held key fires ~30 events a second: each one only adds to a pending step; once
// per frame the focus moves (no layout reads per row, scroll only when the row left the viewport) and the selection
// mark follows. The detail panel (render + network) catches up when the key is released or the repeat pauses.
const nav={step:0,frame:0,rows:null,detailTimer:0,detailId:''};
function navRows(){
 if(nav.rows&&nav.rows.view===tab&&nav.rows.el===viewEl(tab))return nav.rows.list;
 const el=viewEl(tab),list=[...el.querySelectorAll('article.match,tr[data-id],details.group>summary')].filter(n=>!(n.localName==='summary'?n.parentElement.parentElement:n).closest('details:not([open])'));
 nav.rows={view:tab,el,list};return list;
}
function invalidateNav(){nav.rows=null;}
function revealRow(row){
 const box=viewEl(tab),r=row.getBoundingClientRect(),b=box.getBoundingClientRect();
 // sticky column + group headers cover the top of the list
 const top=b.top+(box.querySelector('.col-head')?.offsetHeight||0)+(row.closest('section,details')?.querySelector('.group-head')?.offsetHeight||0);
 if(r.top<top)box.scrollTop-=top-r.top;else if(r.bottom>b.bottom)box.scrollTop+=r.bottom-b.bottom;
}
function markSelected(id){
 const el=viewEl(tab);for(const n of el.querySelectorAll('[aria-selected="true"]'))if(n.dataset.id!==id)n.setAttribute('aria-selected','false');
 el.querySelector(`[data-id="${CSS.escape(id)}"]`)?.setAttribute('aria-selected','true');
}
function queueNav(step,repeat){
 nav.step+=step;if(nav.frame)return;
 nav.frame=requestAnimationFrame(()=>{
  nav.frame=0;const rows=navRows();if(!rows.length){nav.step=0;return;}
  const at=()=>document.activeElement?.closest?.('[data-id],summary');let index=rows.indexOf(at());
  if(index<0||!rows[index].isConnected){invalidateNav();const fresh=navRows();index=fresh.indexOf(at());if(index<0)index=nav.step>0?-1:fresh.length;}
  const list=navRows(),next=list[Math.max(0,Math.min(list.length-1,index+nav.step))];nav.step=0;if(!next)return;
  next.focus({preventScroll:true});revealRow(next);
  if(DetailPanel.isOpen()&&next.dataset.id){markSelected(next.dataset.id);selectedIds.set(tab,next.dataset.id);nav.detailId=next.dataset.id;clearTimeout(nav.detailTimer);nav.detailTimer=setTimeout(flushNavDetail,repeat?220:60);}
 });
}
function flushNavDetail(){clearTimeout(nav.detailTimer);nav.detailTimer=0;const id=nav.detailId;nav.detailId='';if(id&&DetailPanel.isOpen()&&DetailPanel.currentId()!==id)selectMatch(id);}

// ---------------------------------------------------------------------------------------------------- events ----
$('tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(b)switchTab(b.dataset.tab);});
document.addEventListener('keydown',event=>{
 if(event.defaultPrevented||document.querySelector('dialog[open]'))return;
 if(event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey&&/^[1-5]$/.test(event.key)){event.preventDefault();switchTab(VIEWS[Number(event.key)-1],{focus:true});return;}
 if(event.key==='Escape'){if(!$('sourcesPopover').hidden){toggleSources(false);return;}if(DetailPanel.isOpen()){const id=DetailPanel.currentId();DetailPanel.hide();viewEl(tab)?.querySelector(`[data-id="${CSS.escape(String(id))}"]`)?.focus({preventScroll:true});return;}}
 if(event.target.closest('input,textarea,select,[contenteditable="true"]'))return;
 if(event.target.closest('#tabs')&&['ArrowLeft','ArrowRight'].includes(event.key)){const pos=VIEWS.indexOf(tab),next=VIEWS[(pos+(event.key==='ArrowRight'?1:-1)+VIEWS.length)%VIEWS.length];event.preventDefault();switchTab(next,{focus:true});return;}
 if(!['ArrowDown','ArrowUp','Enter'].includes(event.key)||!event.target.closest('#content'))return;
 const current=event.target.closest('[data-id]');
 if(event.key==='Enter'&&event.target.closest('summary'))return;   // native: toggles the game/league
 if(event.key==='Enter'){if(current&&!event.target.closest('button')){event.preventDefault();flushNavDetail();if(isOpenMatch(current.dataset.id))closeDetailTo(current);else selectMatch(current.dataset.id,{focusPanel:true});}return;}
 event.preventDefault();queueNav(event.key==='ArrowDown'?1:-1,event.repeat);
});
document.addEventListener('keyup',event=>{if(['ArrowDown','ArrowUp'].includes(event.key))flushNavDetail();});
$('content').addEventListener('click',event=>{
 const t=event.target;
 if(t.closest('[data-reset-filters]')){resetFilters();return;}
 if(t.closest('[data-enable-books]')){for(const s of BOOKS)prefs[s]=true;savePrefs();markDirty();return;}
 if(t.closest('[data-retry-results]')){loadResults(true);return;}
 const hr=t.closest('[data-history-retry]');if(hr){History.retry(hr.dataset.historyRetry);return;}
 if(t.closest('[data-history-retry-all]')){for(const x of History.sections())if(x.state==='error')History.retry(x.id);History.retry('summary');return;}
 const hm=t.closest('[data-history-more]');if(hm){History.loadMore(hm.dataset.historyMore);return;}
 if(t.closest('[data-history-older]')){History.loadOlder({user:true});return;}
 if(t.closest('[data-more-results]')){resultsLimit+=RESULTS_PAGE_SIZE;loadResults(true);return;}
 if(t.closest('[data-line-more]')){lineSchedulePages++;renderView('prematch',true);return;}
 const fold=t.closest('[data-line-fold]');if(fold){const open=fold.dataset.lineFold==='open';lineFold.setAll(open,[...viewEl('prematch').querySelectorAll('details.game-group')].map(d=>d.dataset.group));saveLineState();viewSignatures.delete('prematch');renderView('prematch',true);viewEl('prematch').querySelector('[data-line-fold]')?.focus({preventScroll:true});return;}
 const settingsLink=t.closest('[data-open-settings]');if(settingsLink){openSettings(settingsLink.dataset.openSettings);return;}
 const lf=t.closest('[data-league-fav]');if(lf){event.preventDefault();event.stopPropagation();const k=lf.dataset.leagueFav;prefs.favorites=prefs.favorites.includes(k)?prefs.favorites.filter(x=>x!==k):[...prefs.favorites,k];savePrefs();markDirty();return;}
 const row=t.closest('[data-id]');if(!row)return;
 if(t.closest('[data-fav]')){const e=findRow(tab,row.dataset.id);if(e)toggleFavorite(e);return;}
 const cell=t.closest('[data-book]');
 // The open match clicked again closes the panel (a price cell of another bookmaker switches the bookmaker instead).
 if(UiKit.panelClick({openId:DetailPanel.isOpen()?DetailPanel.currentId():null,id:row.dataset.id,cellBook:cell?.dataset.book,source:DetailPanel.state()?.source})==='close'){closeDetailTo(row);return;}
 selectMatch(row.dataset.id);
 if(cell&&DetailPanel.isOpen()){const e=projected(tab,findRow(tab,row.dataset.id));if(e)DetailPanel.show(e,detailView(tab,e),{source:cell.dataset.book});}
});
$('content').addEventListener('toggle',event=>{const d=event.target;if(!d.matches?.('details[data-group]')||tab!=='prematch')return;invalidateNav();const g=d.dataset.group;
 if(g.startsWith('l:')){const key=g.slice(2);if(d.open===lineFold.leagueOpen(key))return;lineFold.setLeague(key,d.open);}
 else{if(d.open===lineFold.gameOpen(g))return;lineFold.setGame(g,d.open);saveLineState();}
 viewSignatures.delete('prematch');renderView('prematch',true);},true);
for(const type of ['pointerover','focusin'])$('content').addEventListener(type,event=>{const row=event.target.closest?.('[data-id]');if(!row||!['live','prematch','compare'].includes(tab))return;clearTimeout(prefetchTimer);prefetchTimer=setTimeout(()=>{const e=findRow(tab,row.dataset.id);if(e)prefetchDetail(e,tab==='compare'?(e.inLive?'live':'prematch'):tab);},140);});
$('content').addEventListener('pointerout',event=>{if(!event.relatedTarget?.closest?.('[data-id]'))clearTimeout(prefetchTimer);});
$('drawerBackdrop').addEventListener('click',()=>DetailPanel.hide());
// Wide layout: a click on empty list space (not a match, not a control) closes the detail as well.
$('listPane').addEventListener('click',event=>{if(!DetailPanel.isOpen())return;if(event.target.closest('[data-id],button,a,input,select,label,summary,.group-head,.col-head,.list-head,[role="button"]'))return;DetailPanel.hide();});

function filterChanged(){viewSignatures.delete(tab);if(['results','history'].includes(tab))reloadServerView(tab);else renderView(tab,true);renderChrome();updateNavCounts();}
let searchTimer=0;
$('search').addEventListener('input',()=>{setFilter('search',$('search').value);clearTimeout(searchTimer);searchTimer=setTimeout(filterChanged,['results','history'].includes(tab)?250:60);});
$('availability').addEventListener('change',()=>{setFilter('availability',$('availability').value);filterChanged();});
$('startWindow').addEventListener('change',()=>{setFilter('startWindow',$('startWindow').value);filterChanged();});
$('historyPhase').addEventListener('change',()=>{setFilter('historyPhase',$('historyPhase').value);filterChanged();});
$('liveSort').addEventListener('change',()=>{setPref('liveSort',$('liveSort').value);filterChanged();});
$('lineMode').addEventListener('click',e=>{const b=e.target.closest('[data-line-mode]');if(!b)return;setPref('lineMode',b.dataset.lineMode);lineSchedulePages=1;filterChanged();});
$('compareMode').addEventListener('click',e=>{const b=e.target.closest('[data-compare-mode]');if(!b)return;setPref('compareMode',b.dataset.compareMode);filterChanged();});
$('compareScope').addEventListener('click',e=>{const b=e.target.closest('[data-compare-scope]');if(!b)return;setPref('compareScope',b.dataset.compareScope);DetailPanel.hide();filterChanged();});
$('compareSort').addEventListener('change',()=>{setPref('compareSort',$('compareSort').value);filterChanged();});
$('favorites').addEventListener('click',()=>{prefs.onlyFavorites=!prefs.onlyFavorites;savePrefs();for(const v of VIEWS)viewSignatures.delete(v);filterChanged();});
$('resetFilters').addEventListener('click',resetFilters);
function resetFilters(){prefs.viewFilters={...prefs.viewFilters,[tab]:{...FILTER_DEFAULTS}};prefs.onlyFavorites=false;savePrefs();$('search').value='';filterChanged();}
$('providerNotice').addEventListener('click',e=>{const o=e.target.closest('[data-open-settings]');if(o)openSettings(o.dataset.openSettings);});
$('banner').addEventListener('click',e=>{const b=e.target.closest('[data-open-settings]');if(b)openSettings(b.dataset.openSettings);});
function shiftResults(date){resultsDate=date;resultsLimit=RESULTS_PAGE_SIZE;DetailPanel.hide();selectedIds.delete('results');viewSignatures.delete('results');renderView('results',true);renderChrome();}
$('prevDate').addEventListener('click',()=>shiftResults(shiftDay(resultsDate,-1)));
$('nextDate').addEventListener('click',()=>{if(resultsDate<dayKey())shiftResults(shiftDay(resultsDate,1));});
$('today').addEventListener('click',()=>shiftResults(dayKey()));
$('dateButton').addEventListener('click',()=>{calendarMonth=resultsDate.slice(0,7);modal('','calendar');calendar();});
function toggleSources(open=$('sourcesPopover').hidden){$('sourcesPopover').hidden=!open;$('sourcesButton').setAttribute('aria-expanded',String(open));if(open){renderSources();$('sourcesPopover').querySelector('input,button')?.focus({preventScroll:true});}}
$('sourcesButton').addEventListener('click',e=>{e.stopPropagation();toggleSources();});
$('sourcesPopover').addEventListener('change',e=>{const s=e.target.dataset.bookToggle;if(!s)return;prefs[s]=e.target.checked;if(!BOOKS.some(b=>prefs[b]!==false)){prefs[s]=true;e.target.checked=true;toast('Оставьте хотя бы одну контору');return;}savePrefs();markDirty();});
$('sourcesPopover').addEventListener('click',e=>{const b=e.target.closest('[data-open-settings]');if(b){toggleSources(false);openSettings(b.dataset.openSettings);}});
document.addEventListener('click',e=>{if(!$('sourcesPopover').hidden&&!e.target.closest('#sourcesPopover,#sourcesButton'))toggleSources(false);});
$('settingsButton').addEventListener('click',()=>{if($('settingsView').hidden)openSettings();else closeSettings();});
$('themeButton').addEventListener('click',()=>setTheme(resolvedTheme()==='dark'?'light':'dark'));

// ---------------------------------------------------------------------------------------------------- context menu
// Right click (or the Menu key / Shift+F10 on a focused row): copy the match name "Team A - Team B", one team, or the long
// form; on a bookmaker badge or price: open / copy that bookmaker's match URL when the feed has one (never a made-up URL).
function matchMenuItems(e){
 return [...UiKit.matchCopies(e).map(c=>({label:c.label,hint:c.id==='match'?c.value:'',run:()=>copy(c.value,c.value).catch(report)})),{label:'Копировать с временем и лигой',hint:copyText(e).slice(0,48)+(copyText(e).length>48?'…':''),run:()=>copy(copyText(e)).catch(report)}];
}
function bookMenuItems(e,ref){
 const name=providerName(ref.source),url=UiKit.bookLink(ref),none='Контора не передала ссылку на этот матч';
 return [{label:`Открыть у ${name}`,disabled:!url,note:url?url:none,run:()=>openUrl(url)},{label:`Копировать ссылку ${name}`,hint:url?url.replace(/^https?:\/\//,'').slice(0,44):'ссылка недоступна',disabled:!url,note:url?'':none,run:()=>copy(url,`ссылка ${name}`).catch(report)},{label:'Копировать матч',hint:matchName(e),run:()=>copy(matchName(e),matchName(e)).catch(report)}];
}
function contextFor(target){
 if(target.closest('input,textarea,select,[contenteditable="true"],.ctx-menu'))return null;
 const inDetail=target.closest('#detailPane');
 const event=inDetail?DetailPanel.event():(()=>{const row=target.closest('[data-id]');return row?projected(tab,findRow(tab,row.dataset.id)):null;})();
 if(!event)return null;
 const badge=target.closest('[data-source-ref],[data-book],[data-dp-book],[data-src-book]');
 if(badge){const key=badge.dataset.sourceRef||'',source=badge.dataset.book||badge.dataset.dpBook||badge.dataset.srcBook||key.split(':')[0];
  const ref=(inDetail?DetailPanel.refFor(source):null)||refs(event).find(r=>key?`${r.source}:${r.sourceEventId||r.id}`===key:r.source===source);
  if(ref)return {title:`${providerName(ref.source)} · ${matchName(event)}`,items:bookMenuItems(event,ref)};}
 if(inDetail&&!target.closest('.detail-head'))return null;
 return {title:matchName(event),items:matchMenuItems(event)};
}
for(const host of [$('content'),$('detailPane')])host.addEventListener('contextmenu',event=>{
 if(getSelection()?.toString())return;                      // a text selection keeps the browser menu (copy)
 const menu=contextFor(event.target);if(!menu)return;
 event.preventDefault();UiKit.contextMenu({x:event.clientX,y:event.clientY,title:menu.title,items:menu.items,returnFocus:event.target.closest('[tabindex],button,a')||null});
});
document.addEventListener('keydown',event=>{
 if(!(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')))return;
 const el=document.activeElement;if(!el||!el.closest?.('#content,#detailPane'))return;
 const menu=contextFor(el);if(!menu)return;event.preventDefault();const r=el.getBoundingClientRect();
 UiKit.contextMenu({x:r.left+Math.min(40,r.width/2),y:r.top+Math.min(r.height,28),title:menu.title,items:menu.items,returnFocus:el});
},true);

// ---------------------------------------------------------------------------------------------------- dialogs ---
let modalReturnFocus=null,calendarMonth='';
$('modal').addEventListener('click',event=>{if(event.target!==$('modal'))return;const r=$('modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('modal').close();});
$('modal').addEventListener('close',()=>{const node=modalReturnFocus;if(node?.isConnected)requestAnimationFrame(()=>{if(!$('modal').open)node.focus({preventScroll:true});});});
function modal(html,kind=''){modalReturnFocus=document.activeElement;if($('modal').open)$('modal').close();$('modal').dataset.kind=kind;$('modal').classList.toggle('data-dialog',['scores','odds','book-odds','live-generator'].includes(kind));$('modal').innerHTML=html;$('modal').showModal();}
function calendar(){const first=calendarMonth+'-01',month=new Date(first+'T12:00:00Z'),start=shiftDay(first,-((month.getUTCDay()+6)%7));$('modal').innerHTML=`<div class="calendar-header"><button id="calPrev" aria-label="Предыдущий месяц">‹</button><b>${month.toLocaleDateString('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'})}</b><button id="calNext" aria-label="Следующий месяц">›</button></div><div class="calendar">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d=>`<span>${d}</span>`).join('')}${Array.from({length:42},(_,i)=>{const d=shiftDay(start,i);return `<button data-day="${d}" class="${d===resultsDate?'active':''} ${d.slice(0,7)!==calendarMonth?'outside':''}" ${d>dayKey()?'disabled':''}>${Number(d.slice(-2))}</button>`;}).join('')}</div><div class="dialog-actions"><button id="calClose">Закрыть</button></div>`;$('calPrev').onclick=()=>{month.setUTCMonth(month.getUTCMonth()-1);calendarMonth=month.toISOString().slice(0,7);calendar();};$('calNext').onclick=()=>{month.setUTCMonth(month.getUTCMonth()+1);calendarMonth=month.toISOString().slice(0,7);calendar();};$('calClose').onclick=()=>$('modal').close();$('modal').querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{$('modal').close();shiftResults(b.dataset.day);});}
function scoreIds(e){const selected=new Set(refs(e).filter(r=>prefs[r.source]!==false).map(r=>r.source)),identity=r=>r.source+':'+String(r.sourceEventId||r.id||'').replace(/^fonbet-(?:result-)?/,'');return (e.entityAliases||refs(e).map(identity)).filter(k=>selected.has(k.split(':')[0])).join(',');}
function openScoreHistory(e,view=tab){ScoreDialog.open(e,{ids:scoreIds(e),refs:refs(e).filter(r=>prefs[r.source]!==false),getCurrent:()=>{const fresh=findRow(view,e.id);return fresh?refs(fresh).filter(r=>prefs[r.source]!==false):null;},modal,esc,stamp,providerName});}
function openMatchHistory(e){MatchHistory.open(e,{modal,request});}
function openOddsTimeline(e){OddsTimeline.open(e,{refs:refs(e),esc,stamp,modal,request});}
async function openGenerator(e){if(!prefs.generatorEnabled)return;if(e&&(e.inLive||tab==='live')){try{const full=await details.get(detailKeyFor(e,'live'));LiveGenerator.open(full,{modal,esc,base:BASE,request,load:()=>details.peek(detailKeyFor(e,'live'))?.value||full,reload:()=>details.get(detailKeyFor(e,'live'),{force:true})});}catch(error){report(error);}return;}const url=new URL(chrome.runtime.getURL('odds.html'));if(e){url.searchParams.set('team1',e.team1);url.searchParams.set('team2',e.team2);const bo=Number(e.bestOf)||0;if([1,3,5].includes(bo))url.searchParams.set('bo',bo);url.searchParams.set('ids',refs(e).map(r=>r.source+':'+(r.sourceEventId||r.id)).join(','));url.searchParams.set('auto','1');}chrome.runtime.sendMessage({type:'openOddsWindow',url:url.href}).then(r=>{if(r?.error)throw Error(r.error);}).catch(report);}
function openUrl(url){chrome.runtime.sendMessage({type:'openExternal',url}).then(r=>{if(r?.fallback)toast('Выбранный браузер недоступен — ссылка открыта в текущем');if(r?.error&&!r?.fallback)throw Error(r.error);}).catch(report);}

DetailPanel.configure({timelineAvailable:()=>Ent.feature('timeline'),esc,stamp,providerName,refsOf:refs,scoreOf,bookVisible,bookHealth,prefs:()=>prefs,setPref,errorText,base:()=>BASE,gameIcon,starIcon,leagueTitle,logo:teamLogo,eventUrl,isFavorite:matchFavorite,toggleFavorite:e=>{toggleFavorite(e);},copyMatch:e=>copy(copyText(e)).catch(report),openScoreHistory,openMatchHistory,openOddsTimeline,openGenerator,openUrl,
 generatorAvailable:(e,view)=>Ent.can('tools.generator')&&!!prefs.generatorEnabled&&!oddsHidden(view)&&['live','prematch'].includes(view)&&GameCategories.info(e.category).key==='cs'&&!isExtraEvent(e),
 statsAvailable:(e,view)=>Ent.can('statistics.view')&&['live','results'].includes(view)&&!isExtraEvent(e)&&((StatisticsClient.info(e)?.provider==='dota2'&&prefs.dotaStatsEnabled&&GameCategories.info(e.category).key==='dota')||(StatisticsClient.info(e)?.provider==='cs2'&&GameCategories.info(e.category).key==='cs')),
 detail:(e,view,opts)=>detailSwr(e,view,opts),learnLogos:v=>{Logos.learn(v);saveLogosSoon();},leaseFull,releaseFull,can:key=>Ent.can(key),isAdmin:()=>Ent.isAdmin(),oddsHidden,invalidateDetail:(e,view)=>details.invalidate(detailKeyFor(e,view==='compare'?'live':view)),onClosed:onDetailClosed});
// «Таймлайн» tab: same request client (key, abort), same canonical comparison grid as «Коэффициенты».
TimelinePanel.configure({esc,stamp,refsOf:refs,bookVisible,errorText,toast,request,patch:(node,html)=>StableDOM.patch(node,html),compareHtml:(...a)=>DetailPanel.compareHtml(...a)});
StatisticsClient.configure({base:BASE,request,view:()=>tab,active:()=>['live','results'].includes(tab),render:()=>{DetailPanel.render();}});
Cs2Panel.configure({esc,request,logosEnabled:()=>prefs.teamLogos!==false,learnLogos:v=>{Logos.learn(v);saveLogosSoon();},render:()=>DetailPanel.refreshStats()});
DotaStatsPanel.configure({enabled:()=>prefs.dotaStatsEnabled===true,logosEnabled:()=>prefs.teamLogos!==false,esc,request,render:()=>DetailPanel.refreshStats()});

// ---------------------------------------------------------------------------------------------------- capabilities
let mePending=null;
async function loadEntitlements(){
 if(mePending)return mePending;
 mePending=(async()=>{try{const me=await client.get('/api/me');me.at=Date.now();chrome.storage.local.set({entitlements9:me}).catch(()=>{});if(Ent.set(me))applyEntitlements();settingsSync.attach(me).catch(report);}
  catch(error){if(error?.status===404&&Ent.legacy())applyEntitlements();}
  finally{mePending=null;renderBanner();}})();
 return mePending;
}
// A change of capabilities applies at once (no reinstall): sections, bookmakers, prices and tools appear or go.
function applyEntitlements(){
 document.documentElement.classList.toggle('no-favorites',!Ent.can('favorites'));
 for(const b of $('tabs').querySelectorAll('[data-tab]'))b.hidden=!Ent.canView(b.dataset.tab);
 if(!Ent.can('favorites')&&prefs.onlyFavorites)prefs.onlyFavorites=false;
 details.remove(()=>true);for(const v of VIEWS)viewSignatures.delete(v);invalidateRows('live');invalidateRows('prematch');
 if(!Ent.canView(tab)&&Ent.views().length)switchTab(Ent.views()[0]);
 if(DetailPanel.isOpen()&&!Ent.canView(tab))DetailPanel.hide();
 renderView(tab,true);renderChrome();updateNavCounts();if(!$('settingsView').hidden)renderSettings();DetailPanel.render();
}
setInterval(()=>{if(!document.hidden)loadEntitlements();},60000);

// ---------------------------------------------------------------------------------------------------- boot ------
document.addEventListener('visibilitychange',()=>{sendActivity();if(!document.hidden)reconcileServerViews();else persist.flush();});
window.addEventListener('pagehide',()=>{flushPrefs();persist.flush();settingsSync.flush().catch(()=>{});});
setInterval(()=>{renderChrome();sendActivity();if(tab==='prematch')renderView('prematch');},20000);
setInterval(()=>{if(tab==='results'&&$('settingsView').hidden)updateListHead('results',Number($('viewCount').textContent.split(' ')[0])||0,resultsRes.peek(resultsKey())?.value);},1000);
// A logo that does not load: remembered as broken (never requested again), replaced by the placeholder at once, and the
// rows are re-rendered so another bookmaker's logo for that team is tried. Statistics boards fall back to initials.
let logoFailFrame=0;
document.addEventListener('error',event=>{const image=event.target;if(!(image instanceof HTMLImageElement))return;
 if(image.classList.contains('team-logo')){Logos.fail(image.getAttribute('src'));image.replaceWith(Object.assign(document.createElement('span'),{className:'logo-ph'}));if(!logoFailFrame)logoFailFrame=setTimeout(()=>{logoFailFrame=0;for(const v of VIEWS)viewSignatures.delete(v);scheduleRender(tab);DetailPanel.render();},120);return;}
 if(image.matches('.hawk-team-logo,.cs2-logo')){Logos.fail(image.getAttribute('src'));const name=image.closest('.hawk-board-team,.cs2-team')?.querySelector('strong')?.textContent||'?';const fallback=document.createElement('span');fallback.className=image.className+' fallback';fallback.textContent=name.trim().slice(0,2).toUpperCase();image.replaceWith(fallback);}
 else if(image.closest('.hawk-hero')){const fallback=document.createElement('div');fallback.className='hawk-hero-fallback';fallback.textContent=(image.closest('.hawk-hero').querySelector('b')?.textContent||'?').slice(0,2);image.replaceWith(fallback);}},true);
document.addEventListener('copy',event=>{if(event.defaultPrevented)return;const text=getSelection()?.toString();if(text&&event.clipboardData){event.clipboardData.setData('text/plain',text);event.preventDefault();}});

async function init(){
 const started=performance.now();
 // One storage read: prefs + last-known feeds/results/history (instant first paint, refreshed right after).
 // Small keys first (prefs + LIVE, the default screen); the big Line/History copies load right after the first paint.
 const saved=await chrome.storage.local.get(['prefs','lastKnown9:live','lastKnown9:results','entitlements9','lastKnown9:logos']);Logos.load(saved['lastKnown9:logos']);
 prefs={...DEFAULT_PREFS,...saved.prefs};migratePrefs();applyingProfile=true;changedPrefKeys();savePrefs();applyingProfile=false;applyTheme();if(saved.entitlements9){Ent.set(saved.entitlements9);settingsSync.attach(saved.entitlements9).catch(report);}document.documentElement.classList.toggle('no-favorites',!Ent.can('favorites'));for(const b of $('tabs').querySelectorAll('[data-tab]'))b.hidden=!Ent.canView(b.dataset.tab);lineFold=LineCollapse.create({closedGames:Array.isArray(prefs.lineClosedGames)?prefs.lineClosedGames:[]});
 document.documentElement.classList.toggle('team-logos-off',prefs.teamLogos===false);
 const live=saved['lastKnown9:live'];
 if(live?.events&&!snapshots.live)setSnapshot('live',live,{persisted:true});
 const lr=saved['lastKnown9:results'];if(lr?.key&&lr.value)resultsRes.set(lr.key,lr.value,Number(lr.value.receivedAt)||0);
 const restoreRest=async()=>{const more=await chrome.storage.local.get(['lastKnown9:prematch','lastKnown9:history']);const pre=more['lastKnown9:prematch'];if(pre?.events&&!snapshots.prematch){setSnapshot('prematch',pre,{persisted:true});scheduleRender('prematch');}const lh=more['lastKnown9:history'];if(lh?.v===2&&History.restore(lh.snap)&&tab==='history')renderView('history',true);};
 tab=VIEWS.includes(prefs.lastTab)&&Ent.canView(prefs.lastTab)?prefs.lastTab:(Ent.views()[0]||'live');
 for(const el of document.querySelectorAll('#content>.list'))el.hidden=el.dataset.view!==tab;
 if(['prematch','history'].includes(tab))await restoreRest();
 renderView(tab,true);renderChrome();updateNavCounts();
 Perf.measure('boot.firstRender',started);
 connect();loadEntitlements();
 if(!['prematch','history'].includes(tab))requestAnimationFrame(()=>setTimeout(()=>restoreRest().catch(()=>{}),0));
}
init().catch(error=>report(error));
