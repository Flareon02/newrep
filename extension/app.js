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
const BOOKS=['astek','fonbet','pinnacle','ggbet','databet'];
const providerName=source=>({astek:'AstekBet',fonbet:'Fonbet',pinnacle:'Pinnacle',ggbet:'GGBET',databet:'DataBet'})[source]||source;
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

// ---------------------------------------------------------------------------------------------------- prefs -----
const DEFAULT_PREFS={astek:true,fonbet:true,pinnacle:true,ggbet:true,databet:true,liveOddsProvider:'ggbet',linkBrowser:'current',openMode:'window',dotaStatsEnabled:true,teamLogos:true,favorites:[],hiddenLeagues:[],hiddenLeaguesByView:{},notifications:{live:false,prematch:false,favoritesOnly:false,sound:false},viewFilters:{},liveSort:'league',lineMode:'leagues',compareMode:'odds',compareScope:'live',showExtras:true,hideOdds:false,historyEnabled:true,detailTab:'odds',detailBook:'',onlyFavorites:false};
let prefs={...DEFAULT_PREFS};
let prefsTimer=0;
function savePrefs(){clearTimeout(prefsTimer);prefsTimer=setTimeout(()=>chrome.storage.local.set({prefs}).catch(report),80);}
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
 for(const key of ['favorites','hiddenLeagues'])if(!Array.isArray(prefs[key]))prefs[key]=[];
 prefs.notifications={...DEFAULT_PREFS.notifications,...prefs.notifications};
}
const bookVisible=source=>prefs[source]!==false&&OddsProvider.visible(source,prefs);
const viewBooks=view=>(view==='live'?['astek','fonbet','pinnacle',OddsProvider.selected(prefs)]:view==='results'?['astek','fonbet']:view==='history'?['astek','fonbet','pinnacle']:['astek','fonbet','pinnacle']).filter(s=>prefs[s]!==false);

// ---------------------------------------------------------------------------------------------------- toast/errors
const clientErrors=[];
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,3200);}
function errorText(error){return error?ServerConfig.errorText(error):'Неизвестная ошибка';}
function report(error){if(error?.name==='AbortError')return;const message=errorText(error);clientErrors.push({at:new Date().toISOString(),message});if(clientErrors.length>50)clientErrors.shift();toast(message);}

// ---------------------------------------------------------------------------------------------------- data layer
const client=Store.createClient({base:()=>BASE,headers:()=>ServerConfig.headers(),timeoutFor:url=>url.startsWith('/api/ui/history')||url.startsWith('/api/ui/results')||url.startsWith('/api/prematch/compare')?35000:15000});
// Compatibility wrapper for the reused modules (score dialog, odds timeline, generator, stats panels, league client).
async function request(path,options={}){if(options.method==='POST'){const body=typeof options.body==='string'?JSON.parse(options.body):options.body;return client.post(path,body);}return client.get(path);}
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
 const live=view==='live'||(view==='compare'&&!!event?.inLive),provider=OddsProvider.selected(prefs),id=live&&provider==='ggbet'&&event?String(event.id):'';
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
 if(!event||!['live','prematch'].includes(view)||prefs.hideOdds)return;
 const key=detailKeyFor(event,view),cached=details.peek(key);if(cached?.fresh||details.isLoading(key))return;
 prefetchController?.abort();prefetchController=new AbortController();
 details.load(key,{signal:prefetchController.signal}).catch(()=>{});
}

// Results and history (server-side views): stale-while-revalidate per query.
const resultsRes=Store.createResource({max:24,usable:24*3600000,fresh:key=>key.startsWith(dayKey()+'|')?20000:300000,fetcher:(key,{signal})=>fetchResults(key,signal)});
const historyRes=Store.createResource({max:30,usable:3600000,fresh:60000,fetcher:(key,{signal})=>fetchHistoryPage(key,signal)});

// ---------------------------------------------------------------------------------------------------- feeds -----
const snapshots={live:null,prematch:null};
const liveByProvider=new Map();
let port=null,reconnectDelay=500,reconnectTimer=0;
const quoteTracker=MatchFormat.createPriceTracker({windowMs:20000});
const scoreChanged=new Map();let lastScores=new Map();
function noteScores(snapshot){const now=Date.now();for(const e of snapshot?.events||[])for(const r of refs(e)){const key=`${r.source}:${r.sourceEventId||r.id}`,v=r.scoreText||'';if(lastScores.has(key)&&lastScores.get(key)!==v&&v)scoreChanged.set(key,now);lastScores.set(key,v);}if(lastScores.size>6000)lastScores=new Map([...lastScores].slice(-3000));}
function compactForDisk(s,kind){if(!s?.events)return null;return {events:s.events,providers:s.providers,revision:s.revision,structureRevision:s.structureRevision,leagueRules:s.leagueRules,generatedAt:s.generatedAt,receivedAt:s.receivedAt||Date.now(),liveOddsProvider:kind==='live'?OddsProvider.selected(prefs):undefined};}
function setSnapshot(kind,snapshot,{persisted=false}={}){
 snapshots[kind]=snapshot?{...snapshot,persisted}:null;
 if(kind==='live'&&snapshot&&!persisted){noteScores(snapshot);liveByProvider.set(OddsProvider.selected(prefs),snapshots.live);}
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
 if(message.kind==='freshness'){
  const kind=message.feed,target=snapshots[kind],f=message.freshness||{},failed=!!f.transportError;
  if(target&&!target.offline){Object.assign(target,f);if(!failed&&target.persisted&&f.revision&&String(f.revision)===String(target.revision))target.persisted=false;}
  else if(failed&&(target?.offline||f.failures>=2||!target))snapshots[kind]={events:[],offline:true,...f};
  else if(target?.offline&&!failed)snapshots[kind]=null;
  scheduleChrome();if(target?.offline||snapshots[kind]?.offline)scheduleRender(kind);
  return;
 }
 if(message.kind==='live-provider'){const p=OddsProvider.normalize(message.provider);if(p!==OddsProvider.selected(prefs)){prefs.liveOddsProvider=p;}applyProviderSwitchLocally();return;}
 if(message.kind==='initial'){for(const kind of ['live','prematch']){const s=message.snapshots?.[kind];if(s?.events&&!(kind==='live'&&s.liveOddsProvider&&s.liveOddsProvider!==OddsProvider.selected(prefs)))setSnapshot(kind,s);}scheduleRender('live');scheduleRender('prematch');scheduleChrome();return;}
 if(message.push){
  const kind=message.kind,before=snapshots[kind]?.offline?undefined:snapshots[kind];
  const applied=FeedPush.applyProviderPatches(before,message.patches||[],message.meta||{},Number(message.meta?.receivedAt)||Date.now());
  if(applied.snapshot){snapshots[kind]={...applied.snapshot,persisted:false};if(kind==='live'){noteScores(snapshots.live);liveByProvider.set(OddsProvider.selected(prefs),snapshots.live);}persist.save(kind,compactForDisk(snapshots[kind],kind));invalidateRows(kind);scheduleRender(kind);}
  DetailPanel.onFeedPatches(message.patches);
  window.dispatchEvent(new CustomEvent('monitor-feed-push',{detail:{kind,patches:message.patches||[],snapshot:snapshots[kind]}}));
  return;
 }
 if(message.snapshot){setSnapshot(message.kind,message.snapshot);scheduleRender(message.kind);scheduleChrome();}
}
function sendActivity(){try{port?.postMessage({type:'activity',visible:!document.hidden,tab});}catch{}}

// Switching GGBET <-> DataBet: the rows of the other bookmakers stay on screen; the last list of the chosen provider
// (if this session saw one) is shown at once; the service worker reconnects and the fresh feed patches it in.
function applyProviderSwitchLocally(){
 const next=OddsProvider.selected(prefs),cached=liveByProvider.get(next);
 details.remove(key=>key.startsWith('live:'));
 if(cached)snapshots.live={...cached,persisted:true};
 else if(snapshots.live?.events)snapshots.live={...snapshots.live,events:snapshots.live.events.map(e=>({...e,sourceRefs:refs(e).filter(r=>!OddsProvider.isOddsProvider(r.source)||r.source===next)})).filter(e=>e.sourceRefs.length),persisted:true};
 invalidateRows('live');updateProviderButtons();scheduleRender('live');scheduleRender('compare');scheduleChrome();
 if(DetailPanel.isOpen()&&tab==='live'){const e=findRow('live',DetailPanel.currentId());if(e)DetailPanel.show(e,'live');}
}
function selectLiveOddsProvider(provider){
 const next=OddsProvider.normalize(provider);if(OddsProvider.selected(prefs)===next&&prefs[next]!==false)return;
 const started=performance.now();prefs.liveOddsProvider=next;prefs[next]=true;chrome.storage.local.set({prefs}).catch(report);
 applyProviderSwitchLocally();Perf.frame('provider.switch.paint');Perf.measure('provider.switch.sync',started);
}

// ---------------------------------------------------------------------------------------------------- rows ------
function rules(){return [settingsState.catalog,snapshots.live?.leagueRules,snapshots.prematch?.leagueRules].filter(Boolean).sort((a,b)=>(b.revision||0)-(a.revision||0))[0]||{};}
function hiddenKeys(view){return [...(prefs.hiddenLeagues||[]),...(prefs.hiddenLeaguesByView?.[view]||[])];}
function canonicalEventCategory(e){if(!GameCategories.generic(e.category)&&GameCategories.info(e.category).key!=='other')return e.category;const exact=refs(e).map(r=>r.category).find(c=>!GameCategories.generic(c)&&GameCategories.info(c).key!=='other');return exact||GameCategories.resolve(e.category,e.league);}
const rowsCache={live:{key:'',rows:[]},prematch:{key:'',rows:[]}};
function invalidateRows(kind){if(rowsCache[kind])rowsCache[kind].key='';}
function feedRows(kind){
 const s=snapshots[kind],key=JSON.stringify([s?.structureRevision??s?.revision,s?.receivedAt,s?.events?.length,rules().revision,s?.persisted]);
 if(rowsCache[kind].key===key)return rowsCache[kind].rows;
 const rows=(s?.events||[]).map(event=>{const sourceRefs=refs(event).map(r=>kind==='live'?{...r,inLive:true,enteredLiveAt:Number(r.enteredLiveAt||r.firstSeenAt||0)}:r);return {...event,sourceRefs,...(kind==='live'?{inLive:true}:{inPrematch:true}),category:canonicalEventCategory({...event,sourceRefs})};});
 rowsCache[kind]={key,rows};return rows;
}
const favoriteKeys=e=>[...(e.entityAliases||[]),...refs(e).flatMap(r=>[...(r.aliases||[]),`${r.source}:${r.sourceEventId||r.id}`])];
const matchFavorite=e=>favoriteKeys(e).some(k=>prefs.favorites.includes(k));
const favorite=e=>[e.leagueKey,...refs(e).map(r=>LeagueModel.id(r)),...favoriteKeys(e)].some(k=>prefs.favorites.includes(k));
function toggleFavorite(e){const keys=favoriteKeys(e);prefs.favorites=matchFavorite(e)?prefs.favorites.filter(k=>!keys.includes(k)):[...new Set([...prefs.favorites,...keys])];savePrefs();markDirty();if(prefs.onlyFavorites&&['results','history'].includes(tab))reloadServerView(tab);}

// filters live in prefs.viewFilters[view] (persisted), never read back from the DOM
const FILTER_DEFAULTS={search:'',category:'',availability:'all',startWindow:'',historyPhase:''};
function filters(view=tab){return {...FILTER_DEFAULTS,...(prefs.viewFilters?.[view]||{})};}
function setFilter(key,value,view=tab){prefs.viewFilters={...prefs.viewFilters,[view]:{...filters(view),[key]:value}};savePrefs();}
function filterCount(view=tab){const f=filters(view);return [!!f.search,!!f.category,f.availability!=='all',!!f.startWindow&&view!=='live',view==='history'&&!!f.historyPhase,!!prefs.onlyFavorites].filter(Boolean).length;}
function inStartWindow(e,view,f){if(view==='live'||!f.startWindow)return true;const date=resultsDate;const end=view==='results'&&date<dayKey()?Date.parse(date+'T23:59:59.999+04:00'):Date.now();return MatchView.inWindow(e,f.startWindow,view,end);}
function visible(rows,view=tab,{ignoreCategory=false}={}){
 const rule=rules(),f=filters(view),state={publishedLeagueLinks:rule.links||[],excludedLeagueKeys:[...hiddenKeys(view),...(rule.visibility?.excludedLeagueKeys||[])],excludedCategoryKeys:rule.visibility?.excludedCategoryKeys||[]};
 const q=norm(f.search).split(' ').filter(Boolean),category=ignoreCategory?'':f.category,availability=f.availability,projectView=view==='compare'?(prefs.compareScope==='live'?'live':'prematch'):view;
 return (rows||[]).map(e=>MatchView.project(e,prefs,projectView)).filter(e=>{if(!e)return false;const sources=new Set(refs(e).map(r=>r.source));const available=availability==='all'||(availability==='both'&&sources.size>1)||(availability==='unique'&&sources.size===1)||(sources.size===1&&sources.has(availability));
  return inStartWindow(e,view,f)&&available&&(!category||norm(e.category)===category)&&!LeagueModel.hidden(e,state)&&(!prefs.onlyFavorites||favorite(e))&&(prefs.showExtras!==false||!isExtraEvent(e))&&q.every(t=>norm([e.category,e.league,e.team1,e.team2,...refs(e).map(r=>r.league)].join(' ')).includes(t));});
}
const leagueText=value=>{let text=(ScheduleImport.leagueInfo(value).league||value||'').replace(/\bbo\s*\d+\b/gi,'').replace(/^[\s.,:;–—-]+|[\s.,:;–—-]+$/g,'').trim();text=text.replace(/\bUnited\s+21\b/gi,'United21');const suffix=/(?:\s*[:.–—-]\s*)(?:division|div\.?|season|stage|group|groups|playoffs?|qualifiers?|qualification|regular season|swiss stage|upper bracket|lower bracket)\b.*$/i;if(suffix.test(text))text=text.replace(suffix,'').trim();text=text.replace(/\s+series$/i,'').trim();return text||String(value||'').trim();};
const leagueTitle=e=>leagueText(e.displayLeague||e.league);
function gameIcon(category){const {key,abbr}=GameCategories.info(category);return '<span class="game-icon icon-'+key+'" aria-hidden="true">'+abbr+'</span>';}
function starIcon(active){return '<svg viewBox="0 0 24 24" fill="'+(active?'currentColor':'none')+'" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.55 4.44 1.08 6.26L12 17.35l-5.63 2.95 1.08-6.26L2.9 9.6l6.3-.9L12 3Z"/></svg>';}
function eventUrl(r){try{const u=new URL(r.url);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}}
function logoUrl(value){if(/^\/api\/team-logos\/[a-f0-9]{32}$/.test(value||''))return BASE+value;try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='v2l.traincdn.com'&&/^\/sfiles\/logo_teams\/[a-f\d]{32}\.(png|webp|jpe?g)$/i.test(u.pathname)?u.href:'';}catch{return '';}}
const rememberedLogos=new Map();
function teamLogo(e,side){if(prefs.teamLogos===false)return '';const key=norm((e?.category||'')+'|'+(e?.['team'+side]||'')),fresh=logoUrl(e?.['team'+side+'Logo']||refs(e).find(r=>r?.['team'+side+'Logo'])?.['team'+side+'Logo']);if(fresh){rememberedLogos.set(key,fresh);if(rememberedLogos.size>3000)rememberedLogos.delete(rememberedLogos.keys().next().value);return fresh;}return rememberedLogos.get(key)||'';}
function copyText(e){return `${stamp(e.startAt)} Киберспорт. ${leagueTitle(e).replace(/[.\s]+$/,'')}. "${e.team1} - ${e.team2}"`;}
async function copy(text){await navigator.clipboard.writeText(text);toast('Скопировано');}

// ---------------------------------------------------------------------------------------------------- row markup
function quotesOf(e,books){const out={};for(const r of refs(e))if(books.includes(r.source)&&!out[r.source])out[r.source]=MatchFormat.orientQuote(r);return out;}
function priceCell(e,source,ref,q,bestOf){
 if(!ref)return `<div class="price-col absent" aria-label="${providerName(source)}: нет матча"></div>`;
 const key=`${source}:${ref.sourceEventId||ref.id}`;
 if(!q)return `<div class="price-col" data-source-ref="${esc(key)}" title="${providerName(source)}: коэффициенты появятся после открытия линии"><span class="price none">—</span><span class="price none">—</span></div>`;
 if(q.s)return `<div class="price-col" data-source-ref="${esc(key)}" title="${providerName(source)}: ${q.s==='c'?'рынок закрыт':'приём ставок приостановлен'}"><span class="price closed" aria-label="приостановлено">⏸</span><span class="price closed"></span></div>`;
 // "Best" is marked only when at least two bookmakers price that side; text alternative for screen readers.
 const cell=side=>{const v=MatchFormat.openPrice(q[side]);if(v==null)return '<span class="price none">—</span>';const t=quoteTracker.track(`${key}:${side}`,v),best=bestOf[side]===v&&bestOf.countSide[side]>1;return `<span class="price${best?' best':''}"${best?` aria-label="${esc(MatchFormat.formatPrice(v))}, лучший коэффициент"`:''}>${t.dir?`<span class="chg ${t.dir}" aria-label="${t.dir==='up'?'вырос':'снизился'} с ${esc(MatchFormat.formatPrice(t.was))}">${t.dir==='up'?'▲':'▼'}</span>`:''}${esc(MatchFormat.formatPrice(v))}</span>`;};
 return `<div class="price-col" data-source-ref="${esc(key)}" data-book="${esc(source)}" title="${providerName(source)}${q.at?' · обновлено '+stamp(q.at,false,true):''}">${cell('h')}${cell('a')}</div>`;
}
function bestFor(quotes){const best=MatchFormat.bestPrices(quotes),countSide={h:0,a:0,d:0};for(const q of Object.values(quotes))if(q&&!q.s&&!q.stale)for(const side of ['h','a','d'])if(MatchFormat.openPrice(q[side])!=null)countSide[side]++;return {...best,countSide};}
// Live score of a fixture: SSE patches update the bookmaker refs, so take the most recently changed visible ref
// (AstekBet first when none changed yet); the logical event only carries the score of its last full snapshot.
const SCORE_ORDER={astek:0,fonbet:1,pinnacle:2,ggbet:3,databet:3};
function scoreOf(e){
 const list=refs(e).filter(r=>r&&bookVisible(r.source)&&(r.scoreText||r.seriesScore));if(!list.length)return e;
 const changedAt=r=>scoreChanged.get(`${r.source}:${r.sourceEventId||r.id}`)||0;
 const r=[...list].sort((a,b)=>changedAt(b)-changedAt(a)||(SCORE_ORDER[a.source]??9)-(SCORE_ORDER[b.source]??9))[0];
 return {...e,scoreText:r.scoreText||e.scoreText,seriesScore:r.seriesScore||e.seriesScore,mapScores:r.mapScores||e.mapScores,activeMap:r.activeMap||e.activeMap,bestOf:Number(r.bestOf)||Number(e.bestOf)||0};
}
function scoreCell(e,view){
 const live=view==='live',parts=MatchFormat.scoreParts(scoreOf(e),e),changed=refs(e).some(r=>Date.now()-(scoreChanged.get(`${r.source}:${r.sourceEventId||r.id}`)||0)<3000);
 if(view==='prematch')return `<div class="start-col"><b>${esc(timeFmt.format(Number(e.startAt)||Date.now()))}</b>${dateFmt.format(Number(e.startAt)||Date.now())===dateFmt.format(Date.now())?'сегодня':esc(dateFmt.format(Number(e.startAt)||Date.now()))}</div>`;
 if(!parts.series)return `<div class="score-col"><span class="score-text${changed?' changed':''}">${esc(parts.text||'—')}</span></div>`;
 const status=live?[parts.mapNumber&&parts.maps.length>1?`Карта ${parts.mapNumber}`:'',parts.bestOf?`Bo${parts.bestOf}`:''].filter(Boolean).join(' · '):(parts.bestOf?`Bo${parts.bestOf}`:'');
 const maps=parts.map&&parts.maps.length>0&&live?`<span class="maps num" aria-label="счёт на карте ${parts.mapNumber}"><span>${parts.map[0]}</span><span>${parts.map[1]}</span></span>`:'<span class="maps"></span>';
 return `<div class="score-col${changed?' changed':''}" title="${esc(parts.text)}" aria-label="счёт ${esc(parts.text)}">${maps}<span class="series num${changed?' changed':''}"><span>${parts.series[0]}</span><span>${parts.series[1]}</span></span>${status?`<span class="status">${esc(status)}</span>`:''}</div>`;
}
function teamsCell(e,{meta=true}={}){
 const l1=teamLogo(e,1),l2=teamLogo(e,2),logo=url=>url?`<img class="team-logo" src="${esc(url)}" alt="" aria-hidden="true" width="18" height="18" loading="lazy" decoding="async">`:'<span class="logo-ph"></span>';
 return `<div class="teams">${meta?`<div class="meta">${gameIcon(e.category)}<span>${esc(e.category||'')} · ${esc(leagueTitle(e))}</span>${isExtraEvent(e)?'<span class="extra-tag">доп.</span>':''}</div>`:''}<div class="team">${logo(l1)}<span class="name">${esc(e.team1)}</span></div><div class="team">${logo(l2)}<span class="name">${esc(e.team2)}</span></div></div>`;
}
function sourcesCell(e,view){return `<div class="sources-col">${refs(e).filter(r=>bookVisible(r.source)).map(r=>`<span class="chip" data-source-ref="${esc(r.source+':'+(r.sourceEventId||r.id))}"><span class="book-mark ${esc(r.source)}" aria-hidden="true"></span>${esc(providerName(r.source))}</span>`).join('')}</div>`;}
function matchRow(e,view,{meta=true,books=[]}={}){
 const sel=selectedId(view)===String(e.id),fav=matchFavorite(e),odds=!prefs.hideOdds&&books.length&&['live','prematch'].includes(view);
 let tail='';
 if(odds){const quotes=quotesOf(e,books),best=bestFor(quotes),byBook=new Map(refs(e).map(r=>[r.source,r]));tail=books.map(b=>priceCell(e,b,byBook.get(b),quotes[b],best)).join('');}
 else tail=sourcesCell(e,view);
 return `<article class="match cols${odds?'':' no-odds'}" data-id="${esc(e.id)}" tabindex="0" aria-selected="${sel}" aria-label="${esc(e.team1)} — ${esc(e.team2)}"><div class="fav"><button class="icon-btn" data-fav aria-pressed="${fav}" aria-label="${fav?'Убрать из избранного':'В избранное'}">${starIcon(fav)}</button></div>${teamsCell(e,{meta})}${scoreCell(e,view)}${tail}<span class="go" aria-hidden="true">›</span></article>`;
}
function listHeader(view,books){
 const odds=!prefs.hideOdds&&books.length&&['live','prematch'].includes(view);
 return `<div class="col-head cols${odds?'':' no-odds'}" data-group="head"><span></span><span>Матч</span><span class="right">${view==='prematch'?'Начало':'Счёт'}</span>${odds?books.map(b=>{const h=bookHealth(b);return `<span class="book-col" title="${esc(providerName(b))}${h&&!h.ok?' — '+esc(h.reason):''}"><span class="book-mark ${b}" aria-hidden="true"></span>${esc(providerName(b))}${h&&!h.ok?' <span aria-label="недоступен">⚠</span>':''}</span>`;}).join(''):'<span class="right">Конторы</span>'}<span></span></div>`;
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

function renderView(view,force=false){
 if(view!==tab||$('settingsView').hidden===false)return;
 const started=performance.now();
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
function categoryOptions(rows,facets=null,view=tab){
 const select=$('category'),value=filters(view).category,groups=new Map();
 if(Array.isArray(facets))for(const f of facets){const label=String(f?.name||'Esports');groups.set(norm(label),{label,count:Number(f?.count)||0});}
 else for(const e of rows){const key=norm(e.category),g=groups.get(key)||{label:e.category||'Esports',count:0};g.count++;groups.set(key,g);}
 if(value&&!groups.has(value))groups.set(value,{label:filters(view).categoryLabel||value,count:0});
 const total=[...groups.values()].reduce((n,g)=>n+g.count,0);
 const html=`<option value="">Все игры · ${total}</option>`+[...groups].sort((a,b)=>a[1].label.localeCompare(b[1].label)).map(([key,g])=>`<option value="${esc(key)}">${esc(g.label)} · ${g.count}</option>`).join('');
 if(select.dataset.html!==html){select.innerHTML=html;select.dataset.html=html;}
 select.value=groups.has(value)?value:'';
}

function liveRowsVisible(){const all=visible(feedRows('live'),'live',{ignoreCategory:true});return {all,rows:filters('live').category?all.filter(e=>norm(e.category)===filters('live').category):all};}
function renderLive(force){
 const el=viewEl('live'),s=snapshots.live,{all,rows}=liveRowsVisible();categoryOptions(all,null,'live');
 const books=viewBooks('live').filter(bookVisible);
 const sig=JSON.stringify([s?.revision,s?.receivedAt,s?.persisted,s?.offline,rows.length,rules().revision,prefs.liveSort,prefs.hideOdds,books,prefs.favorites.length,filters('live'),prefs.onlyFavorites,prefs.teamLogos,selectedId('live')]);
 if(!force&&viewSignatures.get('live')===sig)return;viewSignatures.set('live',sig);
 el.style.setProperty('--books',books.length);
 if(!rows.length){if(!s)skeleton(el);else renderState(el,emptyFor('live',s));updateListHead('live',0);return;}
 const order=prefs.liveSort==='asc'?1:-1;
 const sorted=[...rows].sort((a,b)=>Number(matchFavorite(b))-Number(matchFavorite(a))||order*(MatchView.clock(a,'live')-MatchView.clock(b,'live'))||alphabet.compare(String(a.id),String(b.id)));
 let html=listHeader('live',books);
 if(prefs.liveSort==='league'){
  const groups=new Map();for(const e of sorted){const key=norm(e.category)+'|'+norm(leagueTitle(e));if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
  const ordered=[...groups.values()].sort((a,b)=>Number(b.some(matchFavorite))-Number(a.some(matchFavorite))||alphabet.compare(a[0].category||'',b[0].category||'')||alphabet.compare(leagueTitle(a[0]),leagueTitle(b[0])));
  html+=ordered.map(list=>{const e=list[0],lk=e.leagueKey||LeagueModel.id(refs(e)[0]),lf=prefs.favorites.includes(lk);return `<section data-group="g:${esc(norm(e.category)+'|'+norm(leagueTitle(e)))}"><div class="group-head">${gameIcon(e.category)}<span>${esc(e.category||'')}</span><span class="league">${esc(leagueTitle(e))}</span><span class="n">${list.length}</span><button class="icon-btn" data-league-fav="${esc(lk)}" aria-pressed="${lf}" aria-label="${lf?'Убрать лигу из избранного':'Лига в избранное'}">${starIcon(lf)}</button></div>${list.map(x=>matchRow(x,'live',{meta:false,books})).join('')}</section>`;}).join('');
 }else html+=`<section data-group="flat">${sorted.map(e=>matchRow(e,'live',{books})).join('')}</section>`;
 morphInto(el,html);
 updateListHead('live',rows.length);
 scheduleOddsWatch(sorted);
 StatisticsClient.observe(rows);
 if(DetailPanel.isOpen()&&tab==='live'){const sel=rows.find(e=>String(e.id)===DetailPanel.currentId());if(sel)DetailPanel.update(sel);}
}

// Line: grouped by game > league (lazy league bodies) or a flat schedule rendered in pages.
let lineClosed=new Set();let lineSchedulePages=1,lineFullRender=false;
const plural=(n,[one,few,many])=>{const m=n%10,h=n%100;return `${n} ${m===1&&h!==11?one:m>=2&&m<=4&&(h<12||h>14)?few:many}`;};
function renderLine(force){
 const el=viewEl('prematch'),s=snapshots.prematch,all=visible(feedRows('prematch'),'prematch',{ignoreCategory:true});categoryOptions(all,null,'prematch');
 const cat=filters('prematch').category,rows=cat?all.filter(e=>norm(e.category)===cat):all,books=viewBooks('prematch').filter(bookVisible);
 const sig=JSON.stringify([s?.revision,s?.receivedAt,s?.persisted,s?.offline,rows.length,rules().revision,prefs.lineMode,prefs.hideOdds,books,prefs.favorites.length,filters('prematch'),prefs.onlyFavorites,[...lineClosed].join('|'),lineSchedulePages,prefs.teamLogos,selectedId('prematch'),Math.floor(Date.now()/60000)]);
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
  html+=[...games].sort((a,b)=>a[1].name.localeCompare(b[1].name)).map(([gk,g])=>`<section data-group="game:${esc(gk)}"><div class="group-head">${gameIcon(g.name)}<span>${esc(g.name)}</span><span class="n">${plural(g.count,['матч','матча','матчей'])}</span></div>${[...g.leagues].sort((a,b)=>Number(a[1][0].startAt||0)-Number(b[1][0].startAt||0)||alphabet.compare(leagueTitle(a[1][0]),leagueTitle(b[1][0]))).map(([lk,list])=>{const open=filtered||!lineClosed.has(lk)||list.some(e=>String(e.id)===selectedId('prematch')),e=list[0],key=e.leagueKey||LeagueModel.id(refs(e)[0]),lf=prefs.favorites.includes(key);return `<details class="group" data-group="l:${esc(lk)}" ${open?'open':''}><summary class="group-head" style="top:31px;background:var(--surface);font-weight:500"><span class="caret" aria-hidden="true">›</span><span class="league" style="color:var(--text)">${esc(leagueTitle(e))}</span><span class="n">${list.length} · с ${esc(stamp(e.startAt,true))}</span><button class="icon-btn" data-league-fav="${esc(key)}" aria-pressed="${lf}" aria-label="${lf?'Убрать лигу из избранного':'Лига в избранное'}">${starIcon(lf)}</button></summary>${open?take(list).map(x=>matchRow(x,'prematch',{meta:false,books})).join(''):''}</details>`;}).join('')}</section>`).join('');
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
 const sig=JSON.stringify([key,current?.uiRevision,current?.receivedAt,current?.status,resultsError,rows.length,prefs.favorites.length,selectedId('results'),prefs.teamLogos]);
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
 const sel=selectedId('results')===String(e.id),fav=matchFavorite(e),parts=MatchFormat.scoreParts(refs(e)[0]||e,e),verified=refs(e).some(r=>r.resultVerified),ended=Math.max(0,...refs(e).map(lastRemoval));
 const score=parts.series?`<span class="fs num">${parts.series[0]} : ${parts.series[1]}</span>`:`<span class="fs num">${esc(parts.text||'—')}</span>`;
 const maps=parts.maps.length>1?`<span class="maps-line num">${esc(parts.maps.filter(m=>m[0]||m[1]).map(m=>m.join(':')).join(', '))}</span>`:'';
 return `<article class="match cols results" data-id="${esc(e.id)}" tabindex="0" aria-selected="${sel}" aria-label="${esc(e.team1)} — ${esc(e.team2)}"><div class="fav"><button class="icon-btn" data-fav aria-pressed="${fav}" aria-label="${fav?'Убрать из избранного':'В избранное'}">${starIcon(fav)}</button></div>${teamsCell(e)}<div class="final">${score}${maps}<span class="${verified?'verified':'unverified'}">${verified?'✓ подтверждён':'не подтверждён'}</span></div><div class="when"><b>${esc(stamp(ended,false))}</b>${esc(stamp(e.startAt,true))} начало</div>${sourcesCell(e,'results')}<span class="go" aria-hidden="true">›</span></article>`;
}

// History: first page from the bounded fast path, more pages while scrolling.
let historyPagesShown=1,historyError='';
const historyBaseKey=()=>serverQuery('history',HISTORY_PAGE_SIZE).toString();
async function fetchHistoryPage(key,signal){const [base,offset]=key.split('#'),p=new URLSearchParams(base);p.set('offset',offset);if(Number(offset)===0)p.set('fast','1');const data=await client.get('/api/ui/history?'+p.toString(),{signal});if(data?.deferred)throw Object.assign(new Error('История готовится на сервере'),{deferred:true,retryAfterMs:data.retryAfterMs});return {...data,receivedAt:Date.now()};}
function loadHistoryPage(index,force=false){
 const key=historyBaseKey()+'#'+(index*HISTORY_PAGE_SIZE);
 return historyRes.swr(key,{force,onValue:value=>{historyError='';if(index===0)persist.save('history',{key,value});if(tab==='history')renderView('history',true);},onError:error=>{historyError=errorText(error);if(error?.deferred){setTimeout(()=>{if(tab==='history')loadHistoryPage(index,true);},Math.max(3000,Number(error.retryAfterMs||0)));}if(tab==='history')renderView('history',true);}});
}
function historyRows(){const base=historyBaseKey(),out=[],seen=new Set();let meta=null;for(let i=0;i<historyPagesShown;i++){const entry=historyRes.peek(base+'#'+(i*HISTORY_PAGE_SIZE));if(!entry)break;if(i===0)meta=entry.value;for(const e of entry.value.events||[]){const id=String(e.id);if(!seen.has(id)){seen.add(id);out.push(e);}}}return {rows:out,meta};}
function renderHistory(force){
 const el=viewEl('history'),base=historyBaseKey();
 for(let i=0;i<historyPagesShown;i++){const entry=historyRes.peek(base+'#'+(i*HISTORY_PAGE_SIZE));if(!entry||!entry.fresh)loadHistoryPage(i);if(!entry)break;}
 const {rows:raw,meta}=historyRows(),rows=raw.map(e=>MatchView.project(e,prefs,'history')).filter(Boolean).sort((a,b)=>MatchView.appearance(b)-MatchView.appearance(a)||alphabet.compare(String(a.id),String(b.id)));
 categoryOptions(rows,meta?.facets?.categories,'history');
 const total=Number(meta?.total||meta?.totalHint||rows.length);
 const sig=JSON.stringify([base,historyPagesShown,meta?.receivedAt,rows.length,historyError,prefs.favorites.length,selectedId('history'),prefs.teamLogos]);
 if(!force&&viewSignatures.get('history')===sig)return;viewSignatures.set('history',sig);
 if(!rows.length){if(!meta&&!historyError)skeleton(el,10);else if(historyError&&!meta)renderState(el,{kind:historyError.includes('готовится')?'':'bad',icon:historyError.includes('готовится')?'…':'!',title:historyError.includes('готовится')?'История готовится':'История не загрузилась',text:historyError.includes('готовится')?'Сервер собирает историю, страница появится автоматически.':historyError,actions:'<button class="btn" data-retry-history>Повторить</button>'});else renderState(el,emptyFor('history',meta));updateListHead('history',0);return;}
 const more=rows.length<total;
 const html=`<div class="col-head cols history" data-group="head"><span></span><span>Матч</span><span class="right">В линии</span><span class="right">Начало</span><span class="right">Конторы</span><span></span></div><section data-group="rows">${rows.map(e=>historyRow(e)).join('')}</section>${more?`<div class="list-more" data-group="more" id="historySentinel"><button class="btn" data-more-history>Показать ещё · осталось ${Math.max(0,total-rows.length)}</button></div>`:'<div class="list-end" data-group="end">Это вся история по фильтрам</div>'}`;
 morphInto(el,html);
 updateListHead('history',total);
 const sentinel=$('historySentinel');historyObserver.disconnect();if(sentinel)historyObserver.observe(sentinel);
 if(DetailPanel.isOpen()&&tab==='history'){const sel=rows.find(e=>String(e.id)===DetailPanel.currentId());if(sel)DetailPanel.update(sel);}
}
const historyObserver=new IntersectionObserver(entries=>{if(tab==='history'&&entries.some(e=>e.isIntersecting))showMoreHistory();},{rootMargin:'400px'});
function showMoreHistory(){const base=historyBaseKey(),last=historyRes.peek(base+'#'+((historyPagesShown-1)*HISTORY_PAGE_SIZE));if(!last)return;historyPagesShown++;renderView('history',true);}
function historyRow(e){
 const sel=selectedId('history')===String(e.id),fav=matchFavorite(e),r=refs(e),live=r.some(x=>x.inLive),line=r.some(x=>x.inPrematch&&!x.inLive),phase=live?'<span class="phase live"><span class="dot bad" aria-hidden="true"></span>в LIVE</span>':line?'<span class="phase line"><span class="dot" style="background:var(--accent)" aria-hidden="true"></span>в линии</span>':'<span class="phase">снят</span>';
 return `<article class="match cols history" data-id="${esc(e.id)}" tabindex="0" aria-selected="${sel}" aria-label="${esc(e.team1)} — ${esc(e.team2)}"><div class="fav"><button class="icon-btn" data-fav aria-pressed="${fav}" aria-label="${fav?'Убрать из избранного':'В избранное'}">${starIcon(fav)}</button></div>${teamsCell(e)}<div class="when"><b>${esc(stamp(MatchView.appearance(e),true))}</b>${phase}</div><div class="when"><b>${esc(stamp(e.startAt,true))}</b></div>${sourcesCell(e,'history')}<span class="go" aria-hidden="true">›</span></article>`;
}

function reloadServerView(view){if(view==='results'){resultsLimit=RESULTS_PAGE_SIZE;loadResults(true);}else if(view==='history'){historyPagesShown=1;loadHistoryPage(0,true);}viewSignatures.delete(view);renderView(view,true);}
function handleUiInvalidate(message={}){
 const view=String(message.view||'');
 if(view==='results'){resultsRes.invalidate(key=>!message.date||key.startsWith(String(message.date)+'|'));if(tab==='results'&&(!message.date||message.date===resultsDate))setTimeout(()=>loadResults(false),250);}
 else if(view==='history'){historyRes.invalidate(()=>true);if(tab==='history')setTimeout(()=>loadHistoryPage(0,false),900);}
 else if(view==='leagues'&&settingsState.catalog)settingsState.catalog.receivedAt=0;
}
function reconcileServerViews(){if(document.hidden)return;if(tab==='results')loadResults(false);if(tab==='history')loadHistoryPage(0,false);}

// ---------------------------------------------------------------------------------------------------- chrome ----
function bookHealth(source){
 const s=source==='pinnacle'&&!snapshots.live?.providers?.pinnacle?snapshots.prematch:snapshots.live,r=s?.providers?.[source];
 if(OddsProvider.isOddsProvider(source)){if(source!==OddsProvider.selected(prefs))return null;const h=OddsProvider.health(snapshots.live,prefs);return snapshots.live?.transportError?null:h;}
 if(!s||s.transportError||!r)return null;
 const error=String(r.lastError||'').trim(),http=Number(r.lastHttpStatus||0);
 if(error||http>=400)return {ok:false,reason:error||`HTTP ${http}`};
 if(r.stale&&!r.updating)return {ok:false,reason:'данные задерживаются'};
 return {ok:true,reason:''};
}
function sourceRows(){
 const serverDown=!!snapshots.live?.transportError;
 return BOOKS.map(source=>{
  const enabled=prefs[source]!==false,isOdds=OddsProvider.isOddsProvider(source),selectedOdds=!isOdds||source===OddsProvider.selected(prefs);
  let state='online',text='работает',detail='';
  const r=(source==='pinnacle'&&!snapshots.live?.providers?.pinnacle?snapshots.prematch:snapshots.live)?.providers?.[source];
  if(!enabled){state='off';text='скрыт';}
  else if(!selectedOdds){state='off';text='не выбран';detail='Коэффициенты LIVE: выбран '+OddsProvider.name(OddsProvider.selected(prefs));}
  else if(serverDown){state='unknown';text='нет связи с сервером';}
  else if(!snapshots.live&&!snapshots.prematch){state='unknown';text='ожидаем данные';}
  else{const h=bookHealth(source);if(h&&!h.ok){state='bad';text='недоступен';detail=h.reason;}else if(r?.partial){state='warn';text='частичные данные';}
   const at=Date.parse(r?.lastSuccessfulUpdateAt||r?.lastUpdateAt||'');if(at&&state==='online')detail=`обновлено ${stamp(at,false,true)}`;}
  return {source,state,text,detail,enabled,isOdds};
 });
}
function renderSources(){
 const rows=sourceRows(),active=rows.filter(r=>r.state!=='off'),online=active.filter(r=>r.state==='online').length,bad=active.some(r=>r.state==='bad'),down=!!snapshots.live?.transportError&&!snapshots.live?.events?.length;
 $('sourcesCount').textContent=down?'нет связи':`${online}/${active.length}`;
 $('sourcesDot').className='dot '+(down?'bad':bad||online<active.length?'warn':'good');
 $('sourcesButton').setAttribute('aria-label',`Источники: ${down?'нет связи с сервером':online+' из '+active.length+' работают'}`);
 if($('sourcesPopover').hidden)return;
 const html=`<h3>Источники данных</h3>${rows.map(r=>`<div class="source-row" data-group="${r.source}"><span class="book-mark ${r.source}" aria-hidden="true"></span><span class="who"><span class="name">${esc(providerName(r.source))}</span>${r.detail?`<small title="${esc(r.detail)}">${esc(r.detail)}</small>`:''}</span><span class="src-state ${r.state==='bad'?'bad':r.state==='warn'?'warn':''}"><span class="dot ${r.state==='online'?'good':r.state==='bad'?'bad':r.state==='warn'?'warn':''}" aria-hidden="true"></span>${esc(r.text)}</span>${r.isOdds?'<span></span>':`<label class="switch" title="Показывать ${esc(providerName(r.source))}"><input type="checkbox" data-book-toggle="${r.source}" ${r.enabled?'checked':''} aria-label="Показывать ${esc(providerName(r.source))}"></label>`}</div>`).join('')}<div class="popover-foot"><span>Сервер: ${esc(BASE.replace(/^https?:\/\//,''))}</span><button class="link-btn" data-open-settings="sources">Настроить</button></div>`;
 morphInto($('sourcesPopover'),html);
}
function connectionState(){const s=snapshots.live;if(!s)return port?{kind:'loading'}:{kind:'loading'};if(s.offline||s.transportError&&!s.events?.length)return {kind:'down',error:s.transportError};if(s.transportError)return {kind:'stale',error:s.transportError,at:s.receivedAt};return {kind:s.persisted?'cached':'ok',at:s.receivedAt};}
function renderBanner(){
 const c=connectionState(),b=$('banner');let html='',cls='';
 if(c.kind==='down'){cls='bad';const why=/^сервер недоступен$/i.test(String(c.error||'').trim())?'':String(c.error||'');html=`<strong>Сервер недоступен.</strong><span>${why?esc(why)+' · ':''}Переподключаемся автоматически.</span><button class="btn" data-open-settings="server">Настройки сервера</button>`;}
 else if(c.kind==='stale'){cls='warn';html=`<strong>Нет связи с сервером.</strong><span>Показаны данные от ${esc(stamp(c.at,false,true))}. Переподключаемся…</span>`;}
 b.hidden=!html;if(html&&b.dataset.html!==html){b.dataset.html=html;b.innerHTML=html;}b.className='banner '+cls;
 const pn=$('providerNotice');
 const health=tab==='live'&&!c.kind.match(/down|stale/)?OddsProvider.health(snapshots.live,prefs):null,show=health&&!health.ok&&prefs[OddsProvider.selected(prefs)]!==false;
 if(show){const other=OddsProvider.PROVIDERS.find(p=>p!==health.provider),h=`<strong>${esc(health.label)} временно недоступен</strong><span>${health.reason?esc(health.reason)+' · ':''}его коэффициенты не показываются; AstekBet, Fonbet и Pinnacle работают.</span><button class="btn" data-switch-provider="${esc(other)}">Переключиться на ${esc(OddsProvider.name(other))}</button>`;if(pn.dataset.html!==h){pn.dataset.html=h;pn.innerHTML=h;}}
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
function updateProviderButtons(){const sel=OddsProvider.selected(prefs);for(const p of OddsProvider.PROVIDERS){$(p).setAttribute('aria-pressed',String(p===sel&&prefs[p]!==false));const h=p===sel?OddsProvider.health(snapshots.live,prefs):null;$(p).title=`${OddsProvider.name(p)}${h&&!h.ok?' — недоступен: '+h.reason:''}`;}}
function renderChrome(){
 for(const b of $('tabs').querySelectorAll('[data-tab]'))b.setAttribute('aria-current',b.dataset.tab===tab&&$('settingsView').hidden?'page':'false');
 const t=tab,f=filters(t),inSettings=!$('settingsView').hidden;
 $('toolbar').hidden=inSettings;
 const show=(id,on)=>{$(id).hidden=!on;};
 const cmpSchedule=t==='compare'&&prefs.compareMode==='schedule';
 show('search',!cmpSchedule);$('search').closest('.search').hidden=cmpSchedule;
 show('category',!cmpSchedule);show('availability',!['compare'].includes(t));show('startWindow',['prematch','results','history'].includes(t));
 show('historyPhase',t==='history');show('liveSort',t==='live');show('lineMode',t==='prematch');show('dateControl',t==='results');
 show('compareMode',t==='compare');show('compareScope',t==='compare'&&!cmpSchedule);show('favorites',!cmpSchedule);
 show('oddsSource',(t==='live'||t==='compare'&&prefs.compareScope==='live'&&!cmpSchedule)&&!prefs.hideOdds);
 if(document.activeElement!==$('search')&&$('search').value!==f.search)$('search').value=f.search;
 $('availability').value=f.availability;$('historyPhase').value=f.historyPhase;$('liveSort').value=prefs.liveSort;
 $('favorites').setAttribute('aria-pressed',String(!!prefs.onlyFavorites));
 for(const b of $('lineMode').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.lineMode===prefs.lineMode));
 for(const b of $('compareMode').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.compareMode===prefs.compareMode));
 for(const b of $('compareScope').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.compareScope===prefs.compareScope));
 for(const p of OddsProvider.PROVIDERS){const opt=$('availability').querySelector(`option[value=${p}]`);if(opt)opt.hidden=t!=='live'||p!==OddsProvider.selected(prefs);}
 timeOptions(t);
 $('dateButton').textContent=resultsDate===dayKey()?'Сегодня, '+resultsDate.split('-').reverse().slice(0,2).join('.'):resultsDate.split('-').reverse().join('.');$('nextDate').disabled=resultsDate>=dayKey();$('today').hidden=resultsDate===dayKey();
 const n=filterCount(t);$('resetFilters').hidden=!n;$('resetFilters').textContent=`Сбросить · ${n}`;
 updateProviderButtons();renderSources();renderBanner();
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
 if(view==='history')return historyRows().rows.find(match)||null;
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
function layoutDetail(){const open=DetailPanel.isOpen();$('workspace').classList.toggle('with-detail',open);$('drawerBackdrop').hidden=!open;}
function onDetailClosed(){selectedIds.delete(tab);for(const n of viewEl(tab).querySelectorAll('[aria-selected="true"]'))n.setAttribute('aria-selected','false');layoutDetail();}

// ---------------------------------------------------------------------------------------------------- odds watch
let oddsWatchIds=[],oddsWatchSig='',oddsWatchTimer=0;
function scheduleOddsWatch(rows){const sel=selectedId('live'),ids=[...new Set([...(sel?[sel]:[]),...rows.slice(0,8).map(e=>String(e.id))])].slice(0,9),sig=ids.join('|');oddsWatchIds=ids;if(sig===oddsWatchSig)return;oddsWatchSig=sig;clearTimeout(oddsWatchTimer);oddsWatchTimer=setTimeout(pushOddsWatch,150);}
async function pushOddsWatch(){const ids=tab==='live'&&!document.hidden&&!prefs.hideOdds?oddsWatchIds:[];try{await client.post('/api/ui/odds-watch',{ids});}catch{}}
setInterval(()=>{if(tab==='live'&&!document.hidden&&oddsWatchIds.length)pushOddsWatch();},15000);

// ---------------------------------------------------------------------------------------------------- events ----
$('tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(b)switchTab(b.dataset.tab);});
document.addEventListener('keydown',event=>{
 if(event.defaultPrevented||document.querySelector('dialog[open]'))return;
 if(event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey&&/^[1-5]$/.test(event.key)){event.preventDefault();switchTab(VIEWS[Number(event.key)-1],{focus:true});return;}
 if(event.key==='Escape'){if(!$('sourcesPopover').hidden){toggleSources(false);return;}if(DetailPanel.isOpen()){const id=DetailPanel.currentId();DetailPanel.hide();viewEl(tab)?.querySelector(`[data-id="${CSS.escape(String(id))}"]`)?.focus({preventScroll:true});return;}}
 if(event.target.closest('input,textarea,select,[contenteditable="true"]'))return;
 if(event.target.closest('#tabs')&&['ArrowLeft','ArrowRight'].includes(event.key)){const pos=VIEWS.indexOf(tab),next=VIEWS[(pos+(event.key==='ArrowRight'?1:-1)+VIEWS.length)%VIEWS.length];event.preventDefault();switchTab(next,{focus:true});return;}
 if(!['ArrowDown','ArrowUp','Enter'].includes(event.key)||!event.target.closest('#content'))return;
 const rows=[...viewEl(tab).querySelectorAll('article.match,tr[data-id]')].filter(n=>n.offsetParent!==null),current=event.target.closest('[data-id]'),index=rows.indexOf(current);
 if(event.key==='Enter'){if(current&&!event.target.closest('button')){event.preventDefault();selectMatch(current.dataset.id,{focusPanel:true});}return;}
 event.preventDefault();const next=rows[Math.max(0,Math.min(rows.length-1,index+(event.key==='ArrowDown'?1:-1)))]||rows[0];if(!next)return;next.focus({preventScroll:false});next.scrollIntoView({block:'nearest'});if(DetailPanel.isOpen())selectMatch(next.dataset.id);
});
$('content').addEventListener('click',event=>{
 const t=event.target;
 if(t.closest('[data-reset-filters]')){resetFilters();return;}
 if(t.closest('[data-enable-books]')){for(const s of BOOKS)prefs[s]=true;savePrefs();markDirty();return;}
 if(t.closest('[data-retry-results]')){loadResults(true);return;}
 if(t.closest('[data-retry-history]')){loadHistoryPage(0,true);return;}
 if(t.closest('[data-more-results]')){resultsLimit+=RESULTS_PAGE_SIZE;loadResults(true);return;}
 if(t.closest('[data-more-history]')){showMoreHistory();return;}
 if(t.closest('[data-line-more]')){lineSchedulePages++;renderView('prematch',true);return;}
 const settingsLink=t.closest('[data-open-settings]');if(settingsLink){openSettings(settingsLink.dataset.openSettings);return;}
 const lf=t.closest('[data-league-fav]');if(lf){event.preventDefault();event.stopPropagation();const k=lf.dataset.leagueFav;prefs.favorites=prefs.favorites.includes(k)?prefs.favorites.filter(x=>x!==k):[...prefs.favorites,k];savePrefs();markDirty();return;}
 const row=t.closest('[data-id]');if(!row)return;
 if(t.closest('[data-fav]')){const e=findRow(tab,row.dataset.id);if(e)toggleFavorite(e);return;}
 const cell=t.closest('[data-book]');selectMatch(row.dataset.id);
 if(cell&&DetailPanel.isOpen()){const e=projected(tab,findRow(tab,row.dataset.id));if(e)DetailPanel.show(e,detailView(tab,e),{source:cell.dataset.book});}
});
$('content').addEventListener('toggle',event=>{const d=event.target;if(!d.matches?.('details[data-group]'))return;const key=d.dataset.group.slice(2);if(d.open)lineClosed.delete(key);else lineClosed.add(key);prefs.lineCollapsed=[...lineClosed].slice(-400);savePrefs();d.dataset.userToggled='1';viewSignatures.delete('prematch');if(d.open&&!d.querySelector('article'))renderView('prematch',true);},true);
for(const type of ['pointerover','focusin'])$('content').addEventListener(type,event=>{const row=event.target.closest?.('[data-id]');if(!row||!['live','prematch','compare'].includes(tab))return;clearTimeout(prefetchTimer);prefetchTimer=setTimeout(()=>{const e=findRow(tab,row.dataset.id);if(e)prefetchDetail(e,tab==='compare'?(e.inLive?'live':'prematch'):tab);},140);});
$('content').addEventListener('pointerout',event=>{if(!event.relatedTarget?.closest?.('[data-id]'))clearTimeout(prefetchTimer);});
$('drawerBackdrop').addEventListener('click',()=>DetailPanel.hide());

function filterChanged(){viewSignatures.delete(tab);if(['results','history'].includes(tab))reloadServerView(tab);else renderView(tab,true);renderChrome();updateNavCounts();}
let searchTimer=0;
$('search').addEventListener('input',()=>{setFilter('search',$('search').value);clearTimeout(searchTimer);searchTimer=setTimeout(filterChanged,['results','history'].includes(tab)?250:60);});
$('category').addEventListener('change',()=>{setFilter('category',$('category').value);setFilter('categoryLabel',$('category').selectedOptions[0]?.textContent.replace(/ · \d+$/,'')||'');filterChanged();});
$('availability').addEventListener('change',()=>{setFilter('availability',$('availability').value);filterChanged();});
$('startWindow').addEventListener('change',()=>{setFilter('startWindow',$('startWindow').value);filterChanged();});
$('historyPhase').addEventListener('change',()=>{setFilter('historyPhase',$('historyPhase').value);filterChanged();});
$('liveSort').addEventListener('change',()=>{setPref('liveSort',$('liveSort').value);filterChanged();});
$('lineMode').addEventListener('click',e=>{const b=e.target.closest('[data-line-mode]');if(!b)return;setPref('lineMode',b.dataset.lineMode);lineSchedulePages=1;filterChanged();});
$('compareMode').addEventListener('click',e=>{const b=e.target.closest('[data-compare-mode]');if(!b)return;setPref('compareMode',b.dataset.compareMode);filterChanged();});
$('compareScope').addEventListener('click',e=>{const b=e.target.closest('[data-compare-scope]');if(!b)return;setPref('compareScope',b.dataset.compareScope);DetailPanel.hide();filterChanged();});
$('favorites').addEventListener('click',()=>{prefs.onlyFavorites=!prefs.onlyFavorites;savePrefs();for(const v of VIEWS)viewSignatures.delete(v);filterChanged();});
$('resetFilters').addEventListener('click',resetFilters);
function resetFilters(){prefs.viewFilters={...prefs.viewFilters,[tab]:{...FILTER_DEFAULTS}};prefs.onlyFavorites=false;savePrefs();$('search').value='';filterChanged();}
for(const p of OddsProvider.PROVIDERS)$(p).addEventListener('click',()=>{if(OddsProvider.selected(prefs)!==p||prefs[p]===false)selectLiveOddsProvider(p);});
$('providerNotice').addEventListener('click',e=>{const b=e.target.closest('[data-switch-provider]');if(b)selectLiveOddsProvider(b.dataset.switchProvider);});
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

// ---------------------------------------------------------------------------------------------------- dialogs ---
let modalReturnFocus=null,calendarMonth='';
$('modal').addEventListener('click',event=>{if(event.target!==$('modal'))return;const r=$('modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('modal').close();});
$('modal').addEventListener('close',()=>{const node=modalReturnFocus;if(node?.isConnected)requestAnimationFrame(()=>{if(!$('modal').open)node.focus({preventScroll:true});});});
function modal(html,kind=''){modalReturnFocus=document.activeElement;if($('modal').open)$('modal').close();$('modal').dataset.kind=kind;$('modal').classList.toggle('data-dialog',['scores','odds','book-odds','live-generator'].includes(kind));$('modal').innerHTML=html;$('modal').showModal();}
function calendar(){const first=calendarMonth+'-01',month=new Date(first+'T12:00:00Z'),start=shiftDay(first,-((month.getUTCDay()+6)%7));$('modal').innerHTML=`<div class="calendar-header"><button id="calPrev" aria-label="Предыдущий месяц">‹</button><b>${month.toLocaleDateString('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'})}</b><button id="calNext" aria-label="Следующий месяц">›</button></div><div class="calendar">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d=>`<span>${d}</span>`).join('')}${Array.from({length:42},(_,i)=>{const d=shiftDay(start,i);return `<button data-day="${d}" class="${d===resultsDate?'active':''} ${d.slice(0,7)!==calendarMonth?'outside':''}" ${d>dayKey()?'disabled':''}>${Number(d.slice(-2))}</button>`;}).join('')}</div><div class="dialog-actions"><button id="calClose">Закрыть</button></div>`;$('calPrev').onclick=()=>{month.setUTCMonth(month.getUTCMonth()-1);calendarMonth=month.toISOString().slice(0,7);calendar();};$('calNext').onclick=()=>{month.setUTCMonth(month.getUTCMonth()+1);calendarMonth=month.toISOString().slice(0,7);calendar();};$('calClose').onclick=()=>$('modal').close();$('modal').querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{$('modal').close();shiftResults(b.dataset.day);});}
function scoreIds(e){const selected=new Set(refs(e).filter(r=>prefs[r.source]!==false).map(r=>r.source)),identity=r=>r.source+':'+String(r.sourceEventId||r.id||'').replace(/^fonbet-(?:result-)?/,'');return (e.entityAliases||refs(e).map(identity)).filter(k=>selected.has(k.split(':')[0])).join(',');}
function openScoreHistory(e,view=tab){ScoreDialog.open(e,{ids:scoreIds(e),refs:refs(e).filter(r=>prefs[r.source]!==false),getCurrent:()=>{const fresh=findRow(view,e.id);return fresh?refs(fresh).filter(r=>prefs[r.source]!==false):null;},modal,esc,stamp,providerName});}
function openOddsTimeline(e){OddsTimeline.open(e,{refs:refs(e),esc,stamp,modal,request});}
async function openGenerator(e){if(!prefs.generatorEnabled)return;if(e&&(e.inLive||tab==='live')){try{const full=await details.get(detailKeyFor(e,'live'));LiveGenerator.open(full,{modal,esc,base:BASE,request,load:()=>details.peek(detailKeyFor(e,'live'))?.value||full,reload:()=>details.get(detailKeyFor(e,'live'),{force:true})});}catch(error){report(error);}return;}const url=new URL(chrome.runtime.getURL('odds.html'));if(e){url.searchParams.set('team1',e.team1);url.searchParams.set('team2',e.team2);const bo=Number(e.bestOf)||0;if([1,3,5].includes(bo))url.searchParams.set('bo',bo);url.searchParams.set('ids',refs(e).map(r=>r.source+':'+(r.sourceEventId||r.id)).join(','));url.searchParams.set('auto','1');}chrome.runtime.sendMessage({type:'openOddsWindow',url:url.href}).then(r=>{if(r?.error)throw Error(r.error);}).catch(report);}
function openUrl(url){chrome.runtime.sendMessage({type:'openExternal',url}).then(r=>{if(r?.fallback)toast('Выбранный браузер недоступен — ссылка открыта в текущем');if(r?.error&&!r?.fallback)throw Error(r.error);}).catch(report);}

DetailPanel.configure({esc,stamp,providerName,refsOf:refs,scoreOf,bookVisible,bookHealth,prefs:()=>prefs,setPref,errorText,base:()=>BASE,gameIcon,starIcon,leagueTitle,logo:teamLogo,eventUrl,isFavorite:matchFavorite,toggleFavorite:e=>{toggleFavorite(e);},copyMatch:e=>copy(copyText(e)).catch(report),openScoreHistory,openOddsTimeline,openGenerator,openUrl,
 generatorAvailable:(e,view)=>!!prefs.generatorEnabled&&!prefs.hideOdds&&['live','prematch'].includes(view)&&GameCategories.info(e.category).key==='cs'&&!isExtraEvent(e),
 statsAvailable:(e,view)=>['live','results'].includes(view)&&!isExtraEvent(e)&&((StatisticsClient.info(e)?.provider==='dota2'&&prefs.dotaStatsEnabled&&GameCategories.info(e.category).key==='dota')||(StatisticsClient.info(e)?.provider==='cs2'&&GameCategories.info(e.category).key==='cs')),
 detail:(e,view,opts)=>detailSwr(e,view,opts),leaseFull,releaseFull,invalidateDetail:(e,view)=>details.invalidate(detailKeyFor(e,view==='compare'?'live':view)),onClosed:onDetailClosed});
StatisticsClient.configure({base:BASE,request,view:()=>tab,active:()=>['live','results'].includes(tab),render:()=>{DetailPanel.render();}});
Cs2Panel.configure({esc,request,logosEnabled:()=>prefs.teamLogos!==false,render:()=>DetailPanel.refreshStats()});
DotaStatsPanel.configure({enabled:()=>prefs.dotaStatsEnabled===true,logosEnabled:()=>prefs.teamLogos!==false,esc,request,render:()=>DetailPanel.refreshStats()});

// ---------------------------------------------------------------------------------------------------- boot ------
document.addEventListener('visibilitychange',()=>{sendActivity();if(!document.hidden)reconcileServerViews();else persist.flush();});
window.addEventListener('pagehide',()=>{flushPrefs();persist.flush();});
setInterval(()=>{renderChrome();sendActivity();if(tab==='prematch')renderView('prematch');},20000);
setInterval(()=>{if(tab==='results'&&$('settingsView').hidden)updateListHead('results',Number($('viewCount').textContent.split(' ')[0])||0,resultsRes.peek(resultsKey())?.value);},1000);
document.addEventListener('error',event=>{const image=event.target;if(!(image instanceof HTMLImageElement))return;if(image.classList.contains('team-logo')){image.replaceWith(Object.assign(document.createElement('span'),{className:'logo-ph'}));return;}if(image.matches('.hawk-team-logo,.cs2-logo')){const name=image.closest('.hawk-board-team,.cs2-team')?.querySelector('strong')?.textContent||'?';const fallback=document.createElement('span');fallback.className=image.className+' fallback';fallback.textContent=name.trim().slice(0,2).toUpperCase();image.replaceWith(fallback);}else if(image.closest('.hawk-hero')){const fallback=document.createElement('div');fallback.className='hawk-hero-fallback';fallback.textContent=(image.closest('.hawk-hero').querySelector('b')?.textContent||'?').slice(0,2);image.replaceWith(fallback);}},true);
document.addEventListener('copy',event=>{if(event.defaultPrevented)return;const text=getSelection()?.toString();if(text&&event.clipboardData){event.clipboardData.setData('text/plain',text);event.preventDefault();}});

async function init(){
 const started=performance.now();
 // One storage read: prefs + last-known feeds/results/history (instant first paint, refreshed right after).
 // Small keys first (prefs + LIVE, the default screen); the big Line/History copies load right after the first paint.
 const saved=await chrome.storage.local.get(['prefs','lastKnown9:live','lastKnown9:results']);
 prefs={...DEFAULT_PREFS,...saved.prefs};migratePrefs();savePrefs();lineClosed=new Set(Array.isArray(prefs.lineCollapsed)?prefs.lineCollapsed:[]);
 document.documentElement.classList.toggle('team-logos-off',prefs.teamLogos===false);
 const live=saved['lastKnown9:live'];
 if(live?.events&&!snapshots.live)setSnapshot('live',live,{persisted:true});
 const lr=saved['lastKnown9:results'];if(lr?.key&&lr.value)resultsRes.set(lr.key,lr.value,Number(lr.value.receivedAt)||0);
 const restoreRest=async()=>{const more=await chrome.storage.local.get(['lastKnown9:prematch','lastKnown9:history']);const pre=more['lastKnown9:prematch'];if(pre?.events&&!snapshots.prematch){setSnapshot('prematch',pre,{persisted:true});scheduleRender('prematch');}const lh=more['lastKnown9:history'];if(lh?.key&&lh.value&&!historyRes.peek(lh.key)){historyRes.set(lh.key,lh.value,Number(lh.value.receivedAt)||0);if(tab==='history')renderView('history',true);}};
 tab=VIEWS.includes(prefs.lastTab)?prefs.lastTab:'live';
 for(const el of document.querySelectorAll('#content>.list'))el.hidden=el.dataset.view!==tab;
 if(['prematch','history'].includes(tab))await restoreRest();
 updateProviderButtons();renderView(tab,true);renderChrome();updateNavCounts();
 Perf.measure('boot.firstRender',started);
 connect();
 if(!['prematch','history'].includes(tab))requestAnimationFrame(()=>setTimeout(()=>restoreRest().catch(()=>{}),0));
}
init().catch(error=>report(error));
