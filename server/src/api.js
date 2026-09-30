import { log } from "./logger.js";
import {StatisticsService} from './statistics-service.js';
import {teamLogos} from './team-logos.js';
import {HawkService} from './hawk.js';
import './odds-pricing.js';
import './live-model.js';
import {identity} from './identity.js';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {scoreLog} from './score-log.js';
import {oddsLog} from './odds-log.js';
import {astekLiveDetail,astekAllMarkets} from './astek-detail.js';
import {upstreamStatus, astekRequestStatus, storageStatus} from './utils.js';
import {matchAsync,matcherStatus} from './matcher-client.js';
import http from "node:http";
import {gzip} from "node:zlib";
import { config } from "./config.js";
import { matcherRevision, canonicalCategory,leagueFamily,orientEvent } from "./entity-resolver.js";
import { leagueStore } from './league-store.js';
import {queryUiEvents,queryLeagueCatalog,enrichResultsWithPrematch,decorateUiEvent,buildUiPrematchEvents,compactUiPayload} from './ui-service.js';
import {enrichEventMarketSemantics} from './market-semantics.js';
import {normalizeErrorBody,publicMessage} from './http-errors.js';
import {safeWrite} from './sse.js';
import {historyCapacity,warnHistoryCapacity} from './capacity.js';
import {createAuthorizer} from './auth.js';
import {randomUUID} from 'node:crypto';

function memoryStatus(){try{const m=process.memoryUsage();return {rssMiB:Math.round(m.rss/1048576),heapUsedMiB:Math.round(m.heapUsed/1048576),heapTotalMiB:Math.round(m.heapTotal/1048576),externalMiB:Math.round(m.external/1048576)};}catch{return {rssMiB:null};}}

const apiTraffic={requests:0,responses:0,uncompressedBytes:0,wireBytes:0,recent:[],requestRecent:[]};
function recordApiResponse(bytes,wireBytes){const now=Date.now();apiTraffic.responses++;apiTraffic.uncompressedBytes+=bytes;apiTraffic.wireBytes+=wireBytes;apiTraffic.recent=apiTraffic.recent.filter(x=>now-x.at<60000);apiTraffic.recent.push({at:now,bytes,wireBytes});}
function apiTrafficStatus(){const now=Date.now();apiTraffic.recent=apiTraffic.recent.filter(x=>now-x.at<60000);apiTraffic.requestRecent=apiTraffic.requestRecent.filter(at=>now-at<60000);return {requests:apiTraffic.requests,requestsLastMinute:apiTraffic.requestRecent.length,responses:apiTraffic.responses,responseBytesLastMinute:apiTraffic.recent.reduce((n,x)=>n+x.bytes,0),wireBytesLastMinute:apiTraffic.recent.reduce((n,x)=>n+x.wireBytes,0),uncompressedBytesTotal:apiTraffic.uncompressedBytes,wireBytesTotal:apiTraffic.wireBytes};}
function applyCommonHeaders(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  const origin=String(req?.headers?.origin||'');
  if(/^chrome-extension:\/\/[a-p]{32}$/.test(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
}
function sendJson(req, res, status, data, etag = "") {
  if(status>=400){
    const normalized=normalizeErrorBody(data,status,req?.requestId);
    data=normalized.body;
    if(normalized.internal)log.error(`[api] ${req?.method||''} ${String(req?.url||'').split('?')[0]} -> ${status} (${req?.requestId||'-'}): ${normalized.original}`);
  }
  const body=Buffer.from(JSON.stringify(data));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if(!res.hasHeader('Cache-Control'))res.setHeader("Cache-Control", "no-cache");
  applyCommonHeaders(req,res);
  if (etag) res.setHeader("ETag", etag);
  const accept=String(req?.headers?.['accept-encoding']||'');
  const healthRequest=/^\/health(?:\?|$)/.test(String(req?.url||''));
  if(!healthRequest&&body.length>=2048&&/\bgzip\b/i.test(accept)){
    const priorVary=String(res.getHeader('Vary')||'');res.setHeader('Vary',[...new Set([...priorVary.split(',').map(x=>x.trim()).filter(Boolean),'Accept-Encoding'])].join(', '));
    gzip(body,{level:1},(error,compressed)=>{if(res.writableEnded)return;const out=error?body:compressed;if(!error)res.setHeader('Content-Encoding','gzip');res.setHeader('Content-Length',String(out.length));recordApiResponse(body.length,out.length);res.end(out);});return;
  }
  res.setHeader('Content-Length',String(body.length));recordApiResponse(body.length,body.length);res.end(body);
}

async function readBody(req,limit=2097152){
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('Слишком большой запрос'),{status:413});chunks.push(chunk);}
  if(!chunks.length)return{};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw Object.assign(new Error('Некорректный JSON'),{status:400});}
}

function decorateLive(event) {
  return { ...event, enteredLiveAt: Number(event.enteredLiveAt || event.firstSeenAt || 0) };
}

const pairs=(a,b,p,g)=>[['astek',a],['fonbet',b],...(p?[['pinnacle',p]]:[]),...(g?[['ggbet',g]]:[])];
async function combinedSnapshot(mode,a,b,p,g){
 const providers=Object.fromEntries(pairs(a,b,p,g).map(([source,state])=>{const snap=state.publicSnapshot(),events=snap.events.map(mode==='live'?decorateLive:e=>e);return [source,{...snap,events,logicalEvents:events}];})),raw=Object.values(providers).flatMap(r=>r.events),capturedRules=leagueStore.rules(),capturedRevision=matcherRevision();
 const events=await matchAsync('resolve',{events:raw,mode});events.sort((a,b)=>Number(mode==='live'?a.enteredLiveAt||a.firstSeenAt:a.startAt)-Number(mode==='live'?b.enteredLiveAt||b.firstSeenAt:b.startAt));
 const statePairs=pairs(a,b,p,g),structureRevision=statePairs.map(([,state])=>matchStateRevision(state)).join('-')+'-'+capturedRevision;
 return {serverVersion:config.version,features:{bookOdds:1,statistics:4,liveGenerator:3,feedPush:1,uiPush:1,thinClient:2,marketSemantics:1,ggbetNativeTabs:1,realtimePriority:1,pagedHistoryWorker:1},leagueRules:capturedRules,revision:statePairs.map(([,state])=>state.revision).join('-')+'-'+capturedRevision,structureRevision,generatedAt:Object.values(providers).map(r=>r.generatedAt).filter(Boolean).sort().at(-1)||null,stale:Object.values(providers).some(r=>r.stale),count:events.length,rawCount:raw.length,events,providers};
}
const combinedCache=new Map(),historyCache=new Map(),pendingSnapshots=new Map();
const matchStateRevision=state=>Number.isFinite(Number(state?.matchRevision))?Number(state.matchRevision):Number(state?.revision||0);
function refreshSnapshot(mode,a,b,p,g){
 // Pairing depends on fixture identity, teams, league and start time, not on
 // every score/odds tick. Volatile provider state is overlaid below.
 const key=pairs(a,b,p,g).map(([,state])=>matchStateRevision(state)).join(':')+':'+matcherRevision();
 if(combinedCache.get(mode)?.key===key)return Promise.resolve();
 if(pendingSnapshots.has(mode))return pendingSnapshots.get(mode);
 const run=combinedSnapshot(mode,a,b,p,g).then(value=>combinedCache.set(mode,{key,value})).finally(()=>pendingSnapshots.delete(mode));pendingSnapshots.set(mode,run);return run;
}
export function freshenResolvedEvents(events,statePairs){
 const latest=new Map();
 for(const [source,state] of statePairs)for(const row of state.events||[])latest.set(identity({...row,source:row.source||source}),row);
 return (events||[]).map(event=>{
  const oldRefs=event.sourceRefs?.length?event.sourceRefs:[event];
  const refs=oldRefs.map(ref=>{const raw=latest.get(identity(ref));if(!raw)return ref;const fresh=orientEvent({...raw,source:ref.source},ref);return {...ref,...fresh,aliases:ref.aliases||fresh.aliases,lifecycle:ref.lifecycle||fresh.lifecycle,firstSeenAt:ref.firstSeenAt||fresh.firstSeenAt,enteredLiveAt:ref.enteredLiveAt||fresh.enteredLiveAt};});
  return event.sourceRefs?.length?{...event,sourceRefs:refs}:refs[0];
 });
}
async function cachedCombinedSnapshot(mode,a,b,p,g){
 const statePairs=pairs(a,b,p,g),wantedKey=statePairs.map(([,state])=>matchStateRevision(state)).join(':')+':'+matcherRevision();
 // Structural invalidations (new/removed fixtures, team/league/start changes)
 // must not return an old logical event list with a new revision. Await the
 // matcher only when the structural key changed; score/odds pushes still use
 // the cheap volatile overlay path below.
 if(!combinedCache.has(mode)||combinedCache.get(mode)?.key!==wantedKey)await refreshSnapshot(mode,a,b,p,g);
 else refreshSnapshot(mode,a,b,p,g).catch(e=>log.error('[snapshot]',e.message));
 const cached=combinedCache.get(mode).value,providers={...cached.providers};
 for(const [source,state] of statePairs){const fresh=state.publicSnapshot(),events=fresh.events||[];providers[source]={...providers[source],...fresh,...state.status(),events,logicalEvents:events};}
 // Matching can legitimately take longer than one feed tick. Overlay the
 // newest provider payload onto already-resolved identities so scores/odds do
 // not wait for the next expensive resolver pass.
 const events=freshenResolvedEvents(cached.events,statePairs);
 const resolverRevision=matcherRevision(),revision=statePairs.map(([,state])=>state.revision).join('-')+'-'+resolverRevision,structureRevision=statePairs.map(([,state])=>matchStateRevision(state)).join('-')+'-'+resolverRevision;
 return {...cached,revision,structureRevision,events,providers,generatedAt:Object.values(providers).map(r=>r.generatedAt).filter(Boolean).sort().at(-1)||null,features:{bookOdds:1,statistics:4,liveGenerator:3,feedPush:1,uiPush:1,thinClient:2,marketSemantics:1,ggbetNativeTabs:1,realtimePriority:1,pagedHistoryWorker:1},stale:Object.values(providers).some(r=>r.stale),updating:pendingSnapshots.has(mode)};
}

function snapshotResponse(req, res, snapshot) {
  const params=new URL(req.url,'http://localhost').searchParams,meta=params.get('meta')==='1',compact=params.get('compact')==='1';
  if(meta){const {events,...rest}=snapshot;snapshot={...rest,providers:Object.fromEntries(Object.entries(snapshot.providers||{}).map(([key,value])=>{const {events,logicalEvents,...status}=value;return [key,status];}))};}
  else if(compact)snapshot={...snapshot,providers:Object.fromEntries(Object.entries(snapshot.providers||{}).map(([key,value])=>{const {events,logicalEvents,...status}=value;return [key,status];}))};
  // ETag describes logical feed data, not timestamps. Clients obtain freshness
  // through the tiny meta response, so unchanged feeds can be a true 304.
  const etag = `W/"feed-${snapshot.revision}"`;
  if (!meta&&req.headers["if-none-match"] === etag) {
    res.statusCode = 304;res.setHeader("ETag", etag);res.setHeader("Cache-Control", "no-cache");applyCommonHeaders(req,res);return res.end();
  }
  sendJson(req, res, 200, snapshot, etag);
}

async function combinedHistory(mode,a,b,since,p,g){
 const key=mode+':'+pairs(a,b,p,g).map(([,state])=>matchStateRevision(state)+'.'+Number(state.history?.length||0)).join(':')+':'+matcherRevision()+':'+since;if(historyCache.has(key))return historyCache.get(key);
 const providers=Object.fromEntries(pairs(a,b,p,g).map(([source,state])=>{const events=state.publicHistory(since).map(mode==='live'?decorateLive:e=>e);return [source,{count:events.length,events,logicalEvents:events}];})),raw=Object.values(providers).flatMap(r=>r.events);
 const events=(await matchAsync('resolve',{events:raw,mode,scope:'history'})).sort((a,b)=>Number(b.firstSeenAt||0)-Number(a.firstSeenAt||0));
 const result={leagueRules:leagueStore.rules(),count:events.length,rawCount:raw.length,events,providers};historyCache.set(key,result);if(historyCache.size>2)historyCache.delete(historyCache.keys().next().value);return result;
}

function singleProviderSnapshot(state, mode) {
  const snap = state.publicSnapshot();
  const decorate = mode === 'live' ? decorateLive : (x)=>x;
  return { ...snap, events: snap.events.map(decorate) };
}

export function feedMetaSnapshot(mode,a,b,p,g){
  const statePairs=pairs(a,b,p,g),providers=Object.fromEntries(statePairs.map(([source,state])=>[source,state.status()]));
  const successful=statePairs.map(([,state])=>Number(state.lastSuccessfulUpdateAt||0)).filter(Boolean);
  const resolverRevision=matcherRevision();
  return {serverVersion:config.version,features:{bookOdds:1,statistics:4,liveGenerator:3,feedPush:1,uiPush:1,thinClient:2,marketSemantics:1,ggbetNativeTabs:1,realtimePriority:1,pagedHistoryWorker:1},leagueRules:leagueStore.rules(),revision:statePairs.map(([,state])=>state.revision).join('-')+'-'+resolverRevision,structureRevision:statePairs.map(([,state])=>matchStateRevision(state)).join('-')+'-'+resolverRevision,generatedAt:successful.length?new Date(Math.max(...successful)).toISOString():null,stale:Object.values(providers).some(r=>r.stale),updating:Object.values(providers).some(r=>r.updating),providers};
}


export function feedPushPayload(mode,provider,change,meta){
  const event=change?.type==='failure'||change?.type==='status'?'status':change?.structuralChanged?'invalidate':'patch';
  return {event,payload:{mode,provider,meta,at:Number(change?.at)||Date.now(),error:change?.error||'',patches:event==='patch'?(change?.patches||[]):[]}};
}
function thinFeedMeta(meta={}){
  const out={};
  for(const key of ['serverVersion','revision','structureRevision','generatedAt','stale','updating'])if(meta?.[key]!==undefined)out[key]=meta[key];
  return out;
}
export function thinFeedPushPayload(mode,provider,change,meta){
  const base=feedPushPayload(mode,provider,change,meta),thinMeta=thinFeedMeta(meta);
  if(base.event!=='patch')return {event:base.event,payload:{...base.payload,meta:thinMeta,thin:true}};
  const visibleFields=new Set(mode==='live'
    ?['scoreText','seriesScore','mapScores','activeMap','updatedAt','broadcast','team1Logo','team2Logo','tournamentStage']
    :['updatedAt','team1Logo','team2Logo','tournamentStage']);
  const patches=(change?.patches||[]).map(patch=>{
    const fields=(patch.fields||[]).filter(field=>visibleFields.has(field));
    const out={source:patch.source,id:patch.id,fields};
    for(const field of fields)out[field]=patch[field];
    if((patch.fields||[]).includes('odds'))out.detailChanged=true;
    return out;
  }).filter(p=>p.fields.length||p.detailChanged);
  return {event:'patch',payload:{...base.payload,meta:thinMeta,patches,thin:true}};
}
export function sseEventWire(event,payload){
  return `event: ${String(event||'message')}\ndata: ${JSON.stringify(payload??{})}\n\n`;
}

export function createApi({ authToken=config.apiToken, authTrustLoopback=true, liveCollector,crossbetService,hltvService,oddsService,pinnacleLiveState,pinnaclePrematchState,pinnacleCollector,ggbetLiveState,ggbetCollector,liveState, prematchState, fonbetLiveState, fonbetPrematchState, prematchCollector, fonbetCollector, resultsService, startedAt }) {
  const authorizer=createAuthorizer(authToken,{trustLoopback:authTrustLoopback});
  if(!authorizer.enabled)log.warn('[api] API_TOKEN is not set: write and compute endpoints are open to any client that can reach this port');
  const lag=monitorEventLoopDelay({resolution:20});lag.enable();
  const lagTimer=setInterval(()=>lag.reset(),60000);lagTimer.unref();
  // Build current views in the background; GET reads the prepared snapshot.
  const snapshotErrorLog=new Map();
  const prepare=()=>{for(const [mode,a,b] of [['live',liveState,fonbetLiveState],['prematch',prematchState,fonbetPrematchState]]){
    if(pendingSnapshots.has(mode))continue;
    refreshSnapshot(mode,a,b,mode==='prematch'?pinnaclePrematchState:pinnacleLiveState,mode==='live'?ggbetLiveState:null).catch(e=>{const now=Date.now(),last=snapshotErrorLog.get(mode)||0;if(now-last>=10000){snapshotErrorLog.set(mode,now);log.error('[snapshot '+mode+']',e.message);}});
  }};
  // Structural changes also trigger an immediate refresh below. The timer is a
  // low-frequency watchdog now; polling the matcher every second added CPU/GC
  // pressure even when no fixture identity changed.
  prepare();const snapshotTimer=setInterval(prepare,10000);snapshotTimer.unref();
  const states=[liveState,prematchState,fonbetLiveState,fonbetPrematchState,pinnaclePrematchState,pinnacleLiveState,ggbetLiveState].filter(Boolean);
  const rememberCatalog=()=>leagueStore.remember([
    ...states.flatMap(s=>s.events||[]),
    ...(pinnacleCollector?.catalog||[]),
    ...(prematchCollector.catalog||[]).map(r=>({...r,source:'astek'})),
    ...[...(resultsService.days?.values?.()||[])].flatMap(day=>Object.values(day.providerGames||{}).flat())
  ].map(r=>({...r,category:canonicalCategory(r.category||r.sportName),family:leagueFamily(r.league,canonicalCategory(r.category||r.sportName))}))).catch(e=>log.error('[league-catalog]',e.message));
  const catalogReady=rememberCatalog(),catalogTimer=setInterval(rememberCatalog,120000);catalogTimer.unref();
  const hawkService=new HawkService();
  const statistics=new StatisticsService(crossbetService,hawkService,()=>combinedCache.get('live')?.value?.events||[]);
  const rateState=new Map(),sseState=new Map();
  const clientIp=req=>String(req.socket?.remoteAddress||'unknown').replace(/^::ffff:/,'');
  const allowRequest=(req,limit)=>{const ip=clientIp(req),now=Date.now(),old=rateState.get(ip),row=old&&now-old.at<60000?old:{at:now,get:0,post:0};const field=req.method==='POST'?'post':'get';row[field]++;rateState.set(ip,row);return row[field]<=limit;};
  const rateTimer=setInterval(()=>{const now=Date.now();for(const [ip,row] of rateState)if(now-row.at>120000)rateState.delete(ip);},60000);rateTimer.unref?.();
  let sseTotal=0;const acquireSse=req=>{const ip=clientIp(req),n=sseState.get(ip)||0;if(n>=config.apiSseLimitPerIp||sseTotal>=config.apiSseLimitTotal)return null;sseState.set(ip,n+1);sseTotal++;let released=false;return()=>{if(released)return;released=true;sseTotal=Math.max(0,sseTotal-1);const left=Math.max(0,(sseState.get(ip)||1)-1);if(left)sseState.set(ip,left);else sseState.delete(ip);};};
  const oddsWatch=(()=>{const TTL=45000,MAX_CLIENTS=64,rows=new Map();
    const prune=now=>{for(const [ip,row] of rows)if(now-row.at>TTL)rows.delete(ip);};
    return {
      set(ip,ids){const now=Date.now();prune(now);if(ids.length){rows.delete(ip);rows.set(ip,{ids,at:now});while(rows.size>MAX_CLIENTS)rows.delete(rows.keys().next().value);}else rows.delete(ip);return {ok:true,accepted:ids.length,ttlMs:TTL,warming:false};},
      status(){prune(Date.now());return {clients:rows.size,ids:new Set([...rows.values()].flatMap(r=>r.ids)).size,warming:false};}
    };})();
  const feedClients=new Set();
  const feedMeta=mode=>mode==='live'?feedMetaSnapshot('live',liveState,fonbetLiveState,pinnacleLiveState,ggbetLiveState):feedMetaSnapshot('prematch',prematchState,fonbetPrematchState,pinnaclePrematchState);
  const writeSse=(res,wire)=>{safeWrite(res,wire);};

  // Thin-client views are revisioned separately from raw provider feeds. The
  // same SSE connection carries small invalidations so Results/History/Leagues
  // never need a periodic browser poll.
  const uiResultsCache=new Map(),historyPageCache=new Map(),historyStaleCache=new Map(),uiRevisions={results:0,history:0,leagues:0};
  const realtimeBusy=()=>{const gate=astekRequestStatus();return !!(liveCollector?.running||prematchCollector?.running||fonbetCollector?.running||['live','prematch','detail'].includes(gate.activeKind));};
  const waitForLowPrioritySlot=async(maxMs=config.lowPriorityIdleWaitMs)=>{const end=Date.now()+maxMs;while(realtimeBusy()&&Date.now()<end)await new Promise(r=>setTimeout(r,100));return !realtimeBusy();};
  const broadcastUi=(view,reason,extra={})=>{
    if(!(view in uiRevisions))return;
    uiRevisions[view]++;
    if(view==='results')uiResultsCache.clear();
    // History is request-driven and low priority. Never rebuild it just because
    // a LIVE fixture was added/removed; the next History request gets a fresh page.
    if(!feedClients.size)return;
    const payload={view,revision:uiRevisions[view],reason:String(reason||'changed'),at:Date.now(),...extra};
    const wire=sseEventWire('ui-invalidate',payload);
    for(const client of feedClients)if(client.modes.has(view))try{writeSse(client.res,wire);}catch{}
  };
  const refreshMode=mode=>refreshSnapshot(mode,mode==='live'?liveState:prematchState,mode==='live'?fonbetLiveState:fonbetPrematchState,mode==='live'?pinnacleLiveState:pinnaclePrematchState,mode==='live'?ggbetLiveState:null).catch(e=>{const now=Date.now(),last=snapshotErrorLog.get(mode)||0;if(now-last>=10000){snapshotErrorLog.set(mode,now);log.error('[snapshot '+mode+']',e.message);}});
  const broadcastModeInvalidate=(mode,reason='server')=>{
    refreshMode(mode);
    if(!feedClients.size)return;
    const payload={mode,provider:'server',meta:feedMeta(mode),at:Date.now(),error:'',patches:[],reason};
    const wire=sseEventWire('invalidate',payload);
    for(const client of feedClients)if(client.modes.has(mode))try{writeSse(client.res,wire);}catch{}
  };
  const broadcastFeed=(mode,provider,change)=>{
    // New/removed fixtures should be resolved immediately instead of waiting for
    // the watchdog tick. Volatile score/odds patches continue to use the cheap
    // overlay path and never wake the matcher.
    if(change?.structuralChanged){
      refreshMode(mode);
      broadcastUi('history',`feed:${mode}:${provider}`);
      broadcastUi('leagues',`feed:${mode}:${provider}`);
    }
    if(!feedClients.size)return;
    const normal=feedPushPayload(mode,provider,change,feedMeta(mode));
    const thin=thinFeedPushPayload(mode,provider,change,feedMeta(mode));
    const normalWire=sseEventWire(normal.event,normal.payload),thinWire=sseEventWire(thin.event,thin.payload);
    for(const client of feedClients)if(client.modes.has(mode))try{writeSse(client.res,client.thin?thinWire:normalWire);}catch{}
  };
  const feedUnsub=[
    liveState.onChange?.(c=>broadcastFeed('live','astek',c)),fonbetLiveState.onChange?.(c=>broadcastFeed('live','fonbet',c)),pinnacleLiveState?.onChange?.(c=>broadcastFeed('live','pinnacle',c)),ggbetLiveState?.onChange?.(c=>broadcastFeed('live','ggbet',c)),
    prematchState.onChange?.(c=>broadcastFeed('prematch','astek',c)),fonbetPrematchState.onChange?.(c=>broadcastFeed('prematch','fonbet',c)),pinnaclePrematchState?.onChange?.(c=>broadcastFeed('prematch','pinnacle',c)),
    resultsService?.onChange?.(c=>broadcastUi('results','results-service',{date:c?.date||'',updatedAt:Number(c?.updatedAt||0),complete:c?.complete!==false,count:Number(c?.count||0)}))
  ].filter(Boolean);

  // Thin-client views: expensive archive/history/league preparation lives here.
  // The extension only receives the rows needed for the current screen.
  const cachePut=(cache,key,value,limit=16)=>{cache.delete(key);cache.set(key,value);while(cache.size>limit)cache.delete(cache.keys().next().value);return value;};
  const uiRuleState=()=>leagueStore.rules();
  const uiParams=url=>Object.fromEntries(url.searchParams.entries());
  const uiResultRows=async(payload)=>{
    const rules=uiRuleState(),since=Math.max(0,Number(payload.from||0)-14*86400000),statePairs=pairs(prematchState,fonbetPrematchState,pinnaclePrematchState,null);
    const key=[payload.date,payload.updatedAt,payload.events?.length,statePairs.map(([,state])=>`${matchStateRevision(state)}.${state.history?.length||0}`).join(':'),rules.revision].join('|');
    if(uiResultsCache.has(key))return uiResultsCache.get(key);
    // Recover the first line appearance by the same provider ID directly.
    // Cross-book history matching here was expensive and unnecessary because
    // enrichResultsWithPrematch intentionally joins by provider identity.
    const pre=statePairs.flatMap(([,state])=>state.publicHistory(since));
    const events=enrichResultsWithPrematch(payload.events||[],pre).map(e=>decorateUiEvent({...e,phase:e.resultVerified?'results':'removed',archiveDates:[payload.date]},rules.links||[]));
    return cachePut(uiResultsCache,key,events,8);
  };
  const uiPrematchSnapshot=async()=>{
    const rules=uiRuleState();
    const [pre,live]=await Promise.all([
      cachedCombinedSnapshot('prematch',prematchState,fonbetPrematchState,pinnaclePrematchState,null),
      cachedCombinedSnapshot('live',liveState,fonbetLiveState,pinnacleLiveState,ggbetLiveState)
    ]);
    const events=buildUiPrematchEvents(pre.events||[],live.events||[],rules.links||[]);
    const revision=`${pre.revision}|line:${live.structureRevision}`;
    const structureRevision=`${pre.structureRevision}|line:${live.structureRevision}`;
    return {...pre,revision,structureRevision,events,count:events.length,rawCount:pre.rawCount,leagueRules:rules,serverUi:true,uiSchemaVersion:2,serverVersion:config.version,features:{...(pre.features||{}),thinClient:2,marketSemantics:1,ggbetNativeTabs:1}};
  };
  const uiHistoryPage=async(since=0,params={})=>{
    const offset=Math.max(0,Number(params.offset)||0),limit=Math.max(1,Math.min(500,Number(params.limit)||100)),rules=uiRuleState();
    const cleanParams=Object.fromEntries(Object.entries(params).filter(([k])=>k!=='thin').sort(([a],[b])=>a.localeCompare(b)));
    const stateKey=[...pairs(prematchState,fonbetPrematchState,pinnaclePrematchState,null),...pairs(liveState,fonbetLiveState,pinnacleLiveState,ggbetLiveState)].map(([,state])=>`${matchStateRevision(state)}.${state.history?.length||0}`).join(':');
    const staleKey=[Math.floor(Number(since||0)/60000),JSON.stringify(cleanParams),rules.revision].join('|');
    const key=[staleKey,stateKey,matcherRevision()].join('|'),cached=historyPageCache.get(key);
    if(cached&&Date.now()-cached.at<config.historyPageCacheMs)return cached.value;
    // History must never steal the only CPU core from LIVE/prematch/odds. Wait
    // for a quiet slot; if one does not arrive, serve the most recent page if
    // available rather than launching a competing CPU-heavy worker.
    if(!(await waitForLowPrioritySlot())){
      const stale=historyStaleCache.get(staleKey);if(stale)return {...stale.value,stale:true,retryable:true};
      throw Object.assign(new Error('History is waiting for the realtime queue to become idle'),{status:503,retryAfterMs:1000});
    }
    let take=Math.max(800,Math.ceil((offset+limit+100)*1.5)),attempt=0,page=null,exhausted=false;
    while(attempt++<4){
      const preStates=pairs(prematchState,fonbetPrematchState,pinnaclePrematchState,null),liveStates=pairs(liveState,fonbetLiveState,pinnacleLiveState,ggbetLiveState);
      const preParts=preStates.map(([,state])=>state.recentHistory?state.recentHistory(since,take):{events:state.publicHistory(since).slice(-take),exhausted:state.publicHistory(since).length<=take});
      const liveParts=liveStates.map(([,state])=>state.recentHistory?state.recentHistory(since,take):{events:state.publicHistory(since).slice(-take),exhausted:state.publicHistory(since).length<=take});
      exhausted=[...preParts,...liveParts].every(x=>x.exhausted);
      page=await matchAsync('ui-history-page',{prematchHistory:preParts.flatMap(x=>x.events),liveHistory:liveParts.flatMap(x=>x.events),currentPrematch:preStates.flatMap(([,state])=>state.events||[]),currentLive:liveStates.flatMap(([,state])=>state.events||[]),params});
      if(page.events?.length>=limit||exhausted||take>=8000)break;
      if(realtimeBusy())break;
      take=Math.min(8000,take*2);
    }
    if(!exhausted)page={...page,totalExact:false,hasMore:true,total:Math.max(Number(page.total)||0,offset+(page.events?.length||0)+1)};else page={...page,totalExact:true};
    const row={at:Date.now(),value:page};historyPageCache.delete(key);historyPageCache.set(key,row);historyStaleCache.set(staleKey,row);
    while(historyPageCache.size>8)historyPageCache.delete(historyPageCache.keys().next().value);while(historyStaleCache.size>8)historyStaleCache.delete(historyStaleCache.keys().next().value);
    return page;
  };
  const server=http.createServer(async (req, res) => {
    try {
    req.requestId=randomUUID().slice(0,8);res.setHeader('X-Request-Id',req.requestId);
    apiTraffic.requests++;apiTraffic.requestRecent.push(Date.now());if(apiTraffic.requestRecent.length>5000)apiTraffic.requestRecent.splice(0,apiTraffic.requestRecent.length-5000);
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if(req.method!=='OPTIONS'){
      const limit=req.method==='POST'?config.apiPostRateLimitPerMinute:config.apiRateLimitPerMinute;
      if(!allowRequest(req,limit)){res.setHeader('Retry-After','60');return sendJson(req,res,429,{error:'Слишком много запросов. Повторите позже.'});}
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204;applyCommonHeaders(req,res);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-None-Match, Authorization, X-API-Token");
      res.setHeader("Access-Control-Max-Age", "86400");
      return res.end();
    }
    if(!authorizer.allows(req,url.pathname)){res.setHeader('WWW-Authenticate','Bearer realm="esports-monitor"');return sendJson(req,res,401,{error:'Требуется токен доступа. Укажите токен сервера в настройках расширения.'});}
    if(req.method==='POST'&&url.pathname==='/api/league-links')return sendJson(req,res,410,{error:'Прямое редактирование отключено. Обновите расширение и используйте защищённую публикацию.'});
    if(req.method==='POST'&&url.pathname==='/api/league-links/publish'){
      try{
        await catalogReady;const body=await readBody(req);const result=await leagueStore.publish(body,req.socket.remoteAddress);
        broadcastUi('leagues','league-rules',{leagueRevision:leagueStore.revision()});broadcastUi('history','league-rules',{leagueRevision:leagueStore.revision()});broadcastUi('results','league-rules',{leagueRevision:leagueStore.revision()});
        broadcastModeInvalidate('prematch','league-rules');broadcastModeInvalidate('live','league-rules');
        return sendJson(req,res,200,{ok:true,...result});
      }
      catch(error){return sendJson(req,res,error.status||400,{ok:false,error:error?.message||String(error)});}
    }
    if(req.method==='POST'&&url.pathname==='/api/prematch/compare'){
      try{const body=await readBody(req);const snapshot=await cachedCombinedSnapshot('prematch',prematchState,fonbetPrematchState,pinnaclePrematchState);return sendJson(req,res,200,await matchAsync('compare',{input:body.events,events:snapshot.events,options:body.options||{}}));}
      catch(error){return sendJson(req,res,400,{error:error?.message||String(error)});}
    }
    if(req.method==='POST'&&url.pathname==='/api/odds/generate'){
      try{if(!oddsService)return sendJson(req,res,503,{error:'Генератор ещё не запущен'});const body=await readBody(req,16*1024*1024);return sendJson(req,res,202,oddsService.create(body));}
      catch(error){return sendJson(req,res,error.status||400,{error:error.message});}
    }
    if(req.method==='POST'&&url.pathname==='/api/odds/manual'){
      try{if(!oddsService)return sendJson(req,res,503,{error:'Генератор ещё не запущен'});const body=await readBody(req,256*1024);return sendJson(req,res,202,oddsService.createManual(body));}
      catch(error){return sendJson(req,res,error.status||400,{error:error.message});}
    }
    if(req.method==='POST'&&url.pathname==='/api/live-generator'){
      try{
        const body=await readBody(req,512*1024),event=body?.event,options=body?.options||{};
        if(!event||!Array.isArray(event.sourceRefs)||event.sourceRefs.length>8)return sendJson(req,res,400,{error:'Неверные данные матча'});
        const keys=[...new Set(event.sourceRefs.filter(r=>['astek','fonbet','pinnacle','ggbet'].includes(r.source)&&String(r.sourceEventId||r.id||'')).map(identity))];
        const history=keys.length?await scoreLog.get(keys,{limit:600}):{entries:[]};
        let pricedEvent=event,detailError='';
        const astek=event.sourceRefs.find(r=>r.source==='astek');
        const serverAstek=astek&&liveState.events?.find(r=>String(r.id)===String(astek.sourceEventId||astek.id)&&r.category==='Counter Strike 2');
        if(astek&&serverAstek&&(options.source==='astek'||options.source==='average')&&/counter.strike|\bcs\s*2\b/i.test(event.category||'')){
          try{
            const detail=await astekLiveDetail(serverAstek);
            if(detail){
              const old=astek.odds||{},specific=new Set(detail.markets.map(m=>`${m.period}:${m.type}:${m.key?.split(':').at(-1)||''}`));
              const other=(old.markets||[]).filter(m=>!specific.has(`${m.period}:${m.type}:${m.key?.split(':').at(-1)||''}`));
              pricedEvent={...event,sourceRefs:event.sourceRefs.map(r=>r===astek?{...r,odds:{...old,...detail,markets:[...detail.markets,...other],stale:false}}:r)};
            }
          }catch(error){detailError=error.message;}
        }
        const result=globalThis.LiveModel.generate(pricedEvent,{...options,scoreHistory:history.entries||[]});
        if(detailError)result.notes.push('Подробная линия AstekBet недоступна: '+detailError);
        return sendJson(req,res,200,{result,historyEntries:(history.entries||[]).length,serverCalculated:true});
      }catch(error){return sendJson(req,res,400,{error:error.message});}
    }

    if(req.method==='POST'&&url.pathname==='/api/statistics/availability'){
      const body=await readBody(req,512000);if(!Array.isArray(body.events)||body.events.length>500)return sendJson(req,res,400,{error:'Слишком много матчей'});
      return sendJson(req,res,200,await statistics.availability(body.events));
    }
    if(req.method==='POST'&&url.pathname==='/api/ui/odds-watch'){
      // Extension 8.1.x reports up to 8 visible LIVE fixtures here. Server 4.3.3+
      // deliberately no longer keeps their full odds "warm" (that path caused the
      // 4.3.2 CPU/RAM regression), so the list is only validated, remembered for
      // a short TTL and exposed in /health. Answering 200 keeps the contract whole.
      const body=await readBody(req,8192),ids=body?.ids;
      if(!Array.isArray(ids)||ids.length>8||ids.some(id=>!['string','number'].includes(typeof id)||String(id).length>300))return sendJson(req,res,400,{error:'Неверный список матчей'});
      return sendJson(req,res,200,oddsWatch.set(clientIp(req),ids.map(String)));
    }
    if (req.method !== "GET") return sendJson(req, res, 405, { error: "Method not allowed" });
    if(url.pathname==='/api/odds/job'){
      const job=oddsService?.get(url.searchParams.get('id'));return sendJson(req,res,job?200:404,job||{error:'Расчёт не найден. Запустите генерацию ещё раз.'});
    }
    if(url.pathname.startsWith('/api/hltv/')){
      try{if(!hltvService)return sendJson(req,res,503,{error:'HLTV ещё не запущен'});await hltvService.ready;
        if(url.pathname==='/api/hltv/data')return sendJson(req,res,200,{data:hltvService.data,status:hltvService.status()});
        if(url.pathname==='/api/hltv/search')return sendJson(req,res,200,await hltvService.search(url.searchParams.get('q')||''));
        if(url.pathname==='/api/hltv/team')return sendJson(req,res,200,{team:await hltvService.team(url.searchParams.get('id'),url.searchParams.get('refresh')==='1'),data:hltvService.data,status:hltvService.status()});
        if(url.pathname==='/api/hltv/player')return sendJson(req,res,200,{player:await hltvService.player(url.searchParams.get('id'),url.searchParams.get('refresh')==='1'),data:hltvService.data,status:hltvService.status()});
      }catch(error){return sendJson(req,res,400,{error:error.message});}
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return sendJson(req, res, 200, {
        ok: true, features:{bookOdds:1,statistics:4,liveGenerator:3,feedPush:1,uiPush:1,thinClient:2,marketSemantics:1,ggbetNativeTabs:1,realtimePriority:1,pagedHistoryWorker:1}, service: "astek-fonbet-monitor-server", version: config.version,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        intervalsMs: {
          astekLive: config.liveIntervalMs,
          fonbetLive: config.fonbetLiveIntervalMs,
          ggbetLiveSnapshot: config.ggbetSnapshotIntervalMs,
          astekPrematch: config.prematchCatalogIntervalMs,
          fonbetPrematch: config.fonbetPrematchIntervalMs,pinnaclePrematch:60000,pinnacleLive:15000,pinnacleLiveDetail:pinnacleCollector?.detailInterval||2000
        },
        language: "en",
        runtime:{...memoryStatus(),history:(()=>{const capacity=historyCapacity(states.reduce((n,state)=>n+(state.history?.length||0),0));warnHistoryCapacity(capacity);return capacity;})(),eventLoopMaxMs:Math.round(lag.max/1e6),matcher:matcherStatus(),astekGate:astekRequestStatus(),priority:{order:['live','prematch','odds','results','history'],singleCore:true,historyMode:'paged-worker-idle-only',historyAutoWarm:false,historyPagesCached:historyPageCache.size,resultsYield:true},storage:await storageStatus()},upstreamRequests:upstreamStatus(),apiTraffic:apiTrafficStatus(),oddsWatch:oddsWatch.status(),sse:{open:sseTotal,limit:config.apiSseLimitTotal,feedClients:feedClients.size},
        hltv:hltvService?.status(),
        statistics:{archivedMatches:Object.keys(statistics.store.index).length,lastError:statistics.lastError,providers:{dota2:statistics.providers.hawk||{},cs2:statistics.providers.crossbet||{}},sources:{dota2:hawkService.status(),cs2:crossbetService?.status?.()||{enabled:false,available:false}},running:statistics.running,lastSweepAt:statistics.lastSweepAt,currentAvailability:statistics.currentAvailability?.size||0},
        live: { astek: liveState.status(), fonbet: fonbetLiveState.status(),...(pinnacleLiveState?{pinnacle:{...pinnacleLiveState.status(),...pinnacleCollector?.status()}}:{}),...(ggbetLiveState?{ggbet:{...ggbetLiveState.status(),...ggbetCollector?.status()}}:{}) },
        prematch: { astek: { ...prematchState.status(), ...(prematchCollector?.status?.()||{}) }, fonbet: fonbetPrematchState.status(),...(pinnaclePrematchState?{pinnacle:{...pinnaclePrematchState.status(),...pinnacleCollector?.status()}}:{}) },
        fonbetCollector: fonbetCollector?.status?.()||{enabled:false},
        ggbetCollector: ggbetCollector?.status?.()||{enabled:false},
        results: resultsService?.status?.()||{enabled:false}
        ,leagueRules:{revision:leagueStore.revision(),groups:leagueStore.state.links.length,catalogLeagues:leagueStore.catalog.size,hiddenLeagueKeys:leagueStore.state.visibility.excludedLeagueKeys.length,publishAuth:'one-time-challenge'},security:{cors:'extension-only',writeAuth:authorizer.enabled?'token':'open',getRateLimitPerMinute:config.apiRateLimitPerMinute,postRateLimitPerMinute:config.apiPostRateLimitPerMinute,sseLimitPerIp:config.apiSseLimitPerIp,upstreamMaxBytes:config.upstreamMaxBytes}
      });
    }

    if(url.pathname==='/api/feed-stream'){
      const releaseSse=acquireSse(req);if(!releaseSse)return sendJson(req,res,429,{error:'Слишком много потоковых соединений'});
      const allowed=new Set(['live','prematch','results','history','leagues']);
      const requested=new Set(String(url.searchParams.get('modes')||'live,prematch,results,history,leagues').split(',').filter(x=>allowed.has(x)));if(!requested.size){releaseSse();return sendJson(req,res,400,{error:'Неверный режим потока'});}
      res.statusCode=200;res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');applyCommonHeaders(req,res);res.flushHeaders?.();
      const client={res,modes:requested,thin:url.searchParams.get('thin')==='1'},hello={serverVersion:config.version,features:{feedPush:1,uiPush:1,thinClient:2,marketSemantics:1,ggbetNativeTabs:1,realtimePriority:1,pagedHistoryWorker:1},feeds:{},ui:{},thin:client.thin};
      for(const mode of requested){if(mode==='live'||mode==='prematch')hello.feeds[mode]=feedMeta(mode);else hello.ui[mode]={revision:uiRevisions[mode]||0};}
      feedClients.add(client);writeSse(res,sseEventWire('hello',hello));
      const heartbeat=setInterval(()=>{safeWrite(res,`: ping ${Date.now()}\n\n`);},15000);heartbeat.unref?.();let closed=false;const close=()=>{if(closed)return;closed=true;clearInterval(heartbeat);feedClients.delete(client);releaseSse();};req.on('close',close);res.on('close',close);return;
    }

    if(url.pathname==='/api/pinnacle/live-markets'){
      try{
        if(!pinnacleCollector)return sendJson(req,res,503,{error:'Pinnacle ещё не запущен'});
        const id=url.searchParams.get('id')||'';
        return sendJson(req,res,200,await pinnacleCollector.liveDetail(id,{force:url.searchParams.get('force')==='1'}));
      }catch(error){return sendJson(req,res,error.status||502,{ok:false,error:error.message});}
    }
    if(url.pathname==='/api/pinnacle/live-stream'){
      if(!pinnacleCollector)return sendJson(req,res,503,{error:'Pinnacle ещё не запущен'});
      const id=url.searchParams.get('id')||'';
      if(!/^\d{5,20}$/.test(String(id).replace(/^pinnacle-/,'')))return sendJson(req,res,400,{error:'Pinnacle: неверный ID матча'});
      const releaseSse=acquireSse(req);if(!releaseSse)return sendJson(req,res,429,{error:'Слишком много потоковых соединений'});
      res.statusCode=200;
      res.setHeader('Content-Type','text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control','no-cache, no-transform');
      res.setHeader('Connection','keep-alive');applyCommonHeaders(req,res);res.setHeader('X-Accel-Buffering','no');
      res.flushHeaders?.();
      pinnacleCollector.detailStreams++;
      let closed=false,timer=null,lastSignature='';
      const heartbeat=setInterval(()=>{if(!closed)safeWrite(res,': ping\n\n');},15000);heartbeat.unref?.();
      const cleanup=()=>{if(closed)return;closed=true;releaseSse();clearTimeout(timer);clearInterval(heartbeat);pinnacleCollector.detailStreams=Math.max(0,pinnacleCollector.detailStreams-1);};
      req.on('close',cleanup);res.on('close',cleanup);
      const pump=async()=>{
        if(closed)return;
        try{
          const payload=await pinnacleCollector.liveDetail(id);
          const markets=payload?.event?.odds?.markets||[];
          const signature=JSON.stringify([payload.live,payload.upstreamEventId,payload.event?.seriesScore,payload.event?.mapScores,markets.map(m=>[m.key,m.type,m.period,m.side,m.isAlternate,m.status,m.version,m.closedAt||0,m.prices])]);
          if(signature!==lastSignature){lastSignature=signature;safeWrite(res,`data: ${JSON.stringify(payload)}\n\n`);}
        }catch(error){safeWrite(res,`event: warning\ndata: ${JSON.stringify({error:publicMessage(error.message,502).message})}\n\n`);}
        if(!closed){timer=setTimeout(pump,pinnacleCollector.detailInterval);timer.unref?.();}
      };
      pump();return;
    }

    if(req.method==='GET'&&url.pathname.startsWith('/api/team-logos/')){
      const key=url.pathname.split('/').at(-1);if(!/^[a-f0-9]{32}$/.test(key))return sendJson(req,res,400,{error:'Неверный логотип'});
      const image=await teamLogos.read(key);if(!image)return sendJson(req,res,404,{error:'Логотип не сохранён'});
      applyCommonHeaders(req,res);res.writeHead(200,{'Content-Type':image.mime,'Cache-Control':'public, max-age=2592000, immutable','X-Content-Type-Options':'nosniff','Content-Length':String(image.body.length)});return res.end(image.body);
    }
    if(req.method==='GET'&&['/api/statistics/match','/api/statistics/stream'].includes(url.pathname)){
      const id=url.searchParams.get('id'),value=await statistics.store.get(id);if(!value)return sendJson(req,res,404,{matched:false,error:'Статистика ещё не сохранена'});
      if(url.pathname.endsWith('/match'))return sendJson(req,res,200,value);
      const releaseSse=acquireSse(req);if(!releaseSse)return sendJson(req,res,429,{error:'Слишком много потоковых соединений'});
      res.statusCode=200;res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');applyCommonHeaders(req,res);res.flushHeaders?.();
      const send=d=>{safeWrite(res,'data: '+JSON.stringify({...d,serverNow:Date.now()})+'\n\n');};send(value);
      statistics.store.on(statistics.store.channel(id),send);const heartbeat=setInterval(()=>{safeWrite(res,': keep-alive\n\n');},20000);heartbeat.unref();
      let closed=false;const close=()=>{if(closed)return;closed=true;releaseSse();clearInterval(heartbeat);statistics.store.off(statistics.store.channel(id),send);};req.on('close',close);res.on('close',close);return;
    }
    if(req.method==='GET'&&url.pathname==='/api/cs2/match'){
      const team1=url.searchParams.get('team1')||'',team2=url.searchParams.get('team2')||'';
      if(team1.length>150||team2.length>150)return sendJson(req,res,400,{error:'Название команды слишком длинное'});
      if(!crossbetService)return sendJson(req,res,503,{matched:false,error:'Статистика CS2 ещё не запущена'});
      try{return sendJson(req,res,200,await crossbetService.get({team1,team2}));}catch(error){return sendJson(req,res,502,{matched:false,error:error.message});}
    }
    if (url.pathname === "/api/live") {
      if(url.searchParams.get('meta')==='1')return sendJson(req,res,200,feedMetaSnapshot('live',liveState,fonbetLiveState,pinnacleLiveState,ggbetLiveState));
      return snapshotResponse(req, res, await cachedCombinedSnapshot("live", liveState, fonbetLiveState,pinnacleLiveState,ggbetLiveState));
    }
    if (url.pathname === "/api/prematch") {
      if(url.searchParams.get('meta')==='1')return sendJson(req,res,200,feedMetaSnapshot('prematch',prematchState,fonbetPrematchState,pinnaclePrematchState));
      return snapshotResponse(req, res, await cachedCombinedSnapshot("prematch", prematchState, fonbetPrematchState,pinnaclePrematchState));
    }
    if(url.pathname==='/api/league-links/challenge'){
      try{res.setHeader('Cache-Control','no-store');return sendJson(req,res,200,leagueStore.challenge(req.socket.remoteAddress));}catch(error){return sendJson(req,res,error.status||400,{error:error.message});}
    }

    if(req.method==='GET'&&url.pathname==='/api/ui/live'){
      try{
        const rules=uiRuleState(),snap=await cachedCombinedSnapshot('live',liveState,fonbetLiveState,pinnacleLiveState,ggbetLiveState);
        const payload={...snap,events:(snap.events||[]).map(e=>decorateUiEvent(e,rules.links||[])),serverUi:true,uiSchemaVersion:2,serverVersion:config.version,features:{...(snap.features||{}),thinClient:2,marketSemantics:1,ggbetNativeTabs:1}};
        return snapshotResponse(req,res,url.searchParams.get('thin')==='1'?compactUiPayload(payload):payload);
      }catch(error){return sendJson(req,res,500,{error:error?.message||String(error)});}
    }
    if(req.method==='GET'&&url.pathname==='/api/ui/prematch'){
      try{
        const payload=await uiPrematchSnapshot();
        return snapshotResponse(req,res,url.searchParams.get('thin')==='1'?compactUiPayload(payload):payload);
      }
      catch(error){return sendJson(req,res,500,{error:error?.message||String(error)});}
    }
    if(req.method==='GET'&&url.pathname==='/api/ui/event-detail'){
      try{
        const view=String(url.searchParams.get('view')||''),id=String(url.searchParams.get('id')||'');
        if(!['live','prematch'].includes(view)||!id||id.length>300)return sendJson(req,res,400,{error:'Неверный матч'});
        const rules=uiRuleState(),snap=view==='live'
          ?await cachedCombinedSnapshot('live',liveState,fonbetLiveState,pinnacleLiveState,ggbetLiveState)
          :await uiPrematchSnapshot();
        let event=(snap.events||[]).find(e=>String(e.id)===id);
        if(!event)return sendJson(req,res,404,{error:'Матч уже не доступен'});
        // Thin snapshots intentionally omit heavy odds. The detail endpoint is
        // the single hydration boundary for the UI: the extension asks once and
        // the server obtains provider-specific full markets in parallel. This
        // keeps Astek/GGBET protocol knowledge out of the thin client.
        const marketDetailErrors={};
        if(view==='live'){
          const sourceRefs=event.sourceRefs?.length?event.sourceRefs:[event];
          const hydrated=await Promise.all(sourceRefs.map(async ref=>{
            if(ref?.source==='astek'){
              try{
                const odds=await astekAllMarkets(ref);
                if(odds){await oddsLog.record(ref,odds);return {...ref,odds:{...(ref.odds||{}),...odds,markets:odds.markets||[]}};}
              }catch(error){marketDetailErrors.astek=error?.message||String(error);log.warn('[astek-detail]',marketDetailErrors.astek);}
            }
            if(ref?.source==='ggbet'&&ggbetCollector?.detail){
              try{
                const fresh=await ggbetCollector.detail(ref.sourceEventId||ref.id,{timeoutMs:6500});
                if(fresh)return {...ref,...fresh,scoreReversed:ref.scoreReversed||false,aliases:ref.aliases||fresh.aliases,lifecycle:ref.lifecycle||fresh.lifecycle,firstSeenAt:ref.firstSeenAt||fresh.firstSeenAt,enteredLiveAt:ref.enteredLiveAt||fresh.enteredLiveAt};
              }catch(error){marketDetailErrors.ggbet=error?.message||String(error);log.warn('[ggbet-detail]',marketDetailErrors.ggbet);}
            }
            return ref;
          }));
          event=event.sourceRefs?.length?{...event,sourceRefs:hydrated}:hydrated[0];
        }
        // The detail response belongs to the requested view. Keep this phase
        // explicit because current thin feed refs may omit inLive/inPrematch.
        const phaseKey=view==='live'?'inLive':'inPrematch';
        if(event?.sourceRefs?.length)event={...event,[phaseKey]:true,sourceRefs:event.sourceRefs.map(ref=>({...ref,[phaseKey]:true}))};
        else if(event)event={...event,[phaseKey]:true};
        event=enrichEventMarketSemantics(event);
        return sendJson(req,res,200,{ok:true,view,event:decorateUiEvent(event,rules.links||[]),marketDetailErrors,serverVersion:config.version,uiSchemaVersion:3,marketSemantics:1,ggbetNativeTabs:1});
      }catch(error){return sendJson(req,res,500,{error:error?.message||String(error)});}
    }
    if(req.method==='GET'&&url.pathname==='/api/ui/results'){
      const from=Number(url.searchParams.get('from')||0),to=Number(url.searchParams.get('to')||0),date=String(url.searchParams.get('date')||'').trim();
      try{
        const payload=await resultsService.getRange(from,to,date,url.searchParams.get('timezone')||'');
        const rows=await uiResultRows(payload),page=queryUiEvents(rows,uiParams(url),uiRuleState(),'results');
        const response={...payload,...page,count:page.total,events:page.events,serverUi:true,uiSchemaVersion:2,uiRevision:uiRevisions.results,serverVersion:config.version,features:{bookOdds:1,statistics:4,liveGenerator:3,feedPush:1,uiPush:1,thinClient:2,marketSemantics:1,ggbetNativeTabs:1,realtimePriority:1,pagedHistoryWorker:1},leagueRules:uiRuleState()};
        return sendJson(req,res,payload.complete?200:202,url.searchParams.get('thin')==='1'?compactUiPayload(response):response);
      }catch(error){return sendJson(req,res,400,{error:error?.message||String(error)});}
    }
    if(req.method==='GET'&&url.pathname==='/api/ui/history'){
      try{
        const since=Math.max(0,Number(url.searchParams.get('since')||0)),params=uiParams(url),page=await uiHistoryPage(since,params);
        const response={...page,count:page.total,events:page.events,generatedAt:Date.now(),serverUi:true,uiSchemaVersion:3,uiRevision:uiRevisions.history,serverVersion:config.version,features:{feedPush:1,uiPush:1,thinClient:2,marketSemantics:1,ggbetNativeTabs:1,realtimePriority:1,pagedHistoryWorker:1},leagueRules:uiRuleState()};
        return sendJson(req,res,200,url.searchParams.get('thin')==='1'?compactUiPayload(response):response);
      }catch(error){if(error?.retryAfterMs)res.setHeader('Retry-After',String(Math.max(1,Math.ceil(error.retryAfterMs/1000))));return sendJson(req,res,Number(error?.status)||503,{error:error?.message||String(error),retryable:true,retryAfterMs:Number(error?.retryAfterMs)||1000});}
    }
    if(req.method==='GET'&&url.pathname==='/api/ui/leagues'){
      await rememberCatalog();
      try{
        const [live,prematch]=await Promise.all([cachedCombinedSnapshot('live',liveState,fonbetLiveState,pinnacleLiveState,ggbetLiveState),cachedCombinedSnapshot('prematch',prematchState,fonbetPrematchState,pinnaclePrematchState,null)]);
        const base=leagueStore.catalogSnapshot(states.flatMap(s=>s.events||[])),view=queryLeagueCatalog(base,[...(live.events||[]),...(prematch.events||[])],uiParams(url));
        return sendJson(req,res,200,{...view,serverUi:true,uiSchemaVersion:2,uiRevision:uiRevisions.leagues,serverVersion:config.version,features:{feedPush:1,uiPush:1,thinClient:2,marketSemantics:1,ggbetNativeTabs:1,realtimePriority:1,pagedHistoryWorker:1}});
      }catch(error){return sendJson(req,res,500,{error:error?.message||String(error)});}
    }
    if (url.pathname === "/api/leagues" || url.pathname === "/api/league-links") {
      // The first request may arrive before the collectors complete their
      // initial poll. Refresh the catalog here so the league screen contains
      // all known tournaments instead of an empty first snapshot.
      await rememberCatalog();
      return sendJson(req,res,200,leagueStore.catalogSnapshot(states.flatMap(s=>s.events||[])));
    }
    if (url.pathname === "/api/live/astek") return snapshotResponse(req,res,{...singleProviderSnapshot(liveState,'live'),providers:{astek:singleProviderSnapshot(liveState,'live')}});
    if (url.pathname === "/api/live/fonbet") return snapshotResponse(req,res,{...singleProviderSnapshot(fonbetLiveState,'live'),providers:{fonbet:singleProviderSnapshot(fonbetLiveState,'live')}});
    if (url.pathname === "/api/live/ggbet" && ggbetLiveState) return snapshotResponse(req,res,{...singleProviderSnapshot(ggbetLiveState,'live'),providers:{ggbet:singleProviderSnapshot(ggbetLiveState,'live')}});

    if(url.pathname==='/api/score-history'){
      const keys=(url.searchParams.get('ids')||'').split(',').filter(Boolean);
      if(!keys.length||keys.length>200||keys.some(k=>!(/^(astek|fonbet|pinnacle|ggbet):[a-zA-Z0-9_-]{1,100}$/).test(k)))return sendJson(req,res,400,{error:'Неверные ID матчей'});
      return sendJson(req,res,200,await scoreLog.get(keys,{limit:Math.max(1,Math.min(1000,Number(url.searchParams.get('limit'))||200)),before:Number(url.searchParams.get('before'))||Infinity}));
    }
    if(req.method==='GET'&&url.pathname==='/api/prematch/odds'){
      const ids=new Set((url.searchParams.get('ids')||'').split(',').slice(0,30));
      const events=[prematchState,fonbetPrematchState,pinnaclePrematchState].filter(Boolean).flatMap(state=>state.events||[]).filter(e=>ids.has(e.source+':'+(e.sourceEventId||e.id)));
      return sendJson(req,res,200,{events});
    }
    if(req.method==='GET'&&url.pathname==='/api/odds/timeline'){
      const keys=[...new Set((url.searchParams.get('ids')||'').split(',').filter(Boolean))];
      if(!keys.length||keys.length>30||keys.some(k=>!/^(astek|fonbet|pinnacle|ggbet):[\w-]{1,80}$/.test(k)))return sendJson(req,res,400,{error:'Неверные матчи'});
      return sendJson(req,res,200,await oddsLog.timeline(keys,url.searchParams.has('at')?Number(url.searchParams.get('at')):undefined));
    }
    if(req.method==='GET'&&url.pathname==='/api/odds/history'){
      const source=url.searchParams.get('source'),id=url.searchParams.get('id');
      if(!['astek','fonbet','pinnacle','ggbet'].includes(source)||!(/^[\w-]{1,80}$/).test(id||''))return sendJson(req,res,400,{error:'Неверный ID'});
      return sendJson(req,res,200,await oddsLog.get(source,id,{before:Number(url.searchParams.get('before'))||Infinity,limit:Math.min(100,Number(url.searchParams.get('limit'))||50)}));
    }
    if(req.method==='GET'&&url.pathname==='/api/astek/markets'){
      const id=url.searchParams.get('id');
      if(!/^\d{1,15}$/.test(id||''))return sendJson(req,res,400,{error:'Неверный ID'});
      const liveRef=liveState.events.find(e=>String(e.id)===id),prematchRef=prematchState.events.find(e=>String(e.id)===id),ref=liveRef||prematchRef;
      if(!ref)return sendJson(req,res,404,{error:'Событие уже отсутствует в фиде'});
      // Prematch already carries the bookmaker's current market groups. Return
      // them directly instead of reaching another upstream just to redraw the
      // same line. LIVE may request GetGameZip on demand for expanded markets.
      if(!liveRef){
        const odds=ref.odds?.markets?.length?ref.odds:null;
        if(!odds)return sendJson(req,res,404,{error:'Для события пока нет доступных рынков'});
        await oddsLog.record(ref,odds);
        return sendJson(req,res,200,{odds,transport:'line-feed'});
      }
      try{const odds=await astekAllMarkets(ref);if(odds)await oddsLog.record(ref,odds);return sendJson(req,res,200,{odds,transport:'astek-detail'});}
      catch(error){return sendJson(req,res,502,{error:error.message});}
    }
    if (url.pathname === "/api/live/history") {
      const since = Math.max(0,Math.floor(Number(url.searchParams.get("since") || 0)/60000)*60000);
      return sendJson(req, res, 200, await combinedHistory("live", liveState, fonbetLiveState, since,pinnacleLiveState,null));
    }
    if (url.pathname === "/api/prematch/history") {
      const since = Math.max(0,Math.floor(Number(url.searchParams.get("since") || 0)/60000)*60000);
      return sendJson(req, res, 200, await combinedHistory("prematch", prematchState, fonbetPrematchState, since,pinnaclePrematchState));
    }
    if (url.pathname === "/api/live/past") {
      const from = Number(url.searchParams.get("from") || 0);
      const to = Number(url.searchParams.get("to") || 0);
      const date = String(url.searchParams.get("date") || "").trim();
      try {
        const payload = await resultsService.getRange(from,to,date,url.searchParams.get("timezone")||"");
        return sendJson(req,res,payload.complete?200:202,{...payload,serverVersion:config.version,features:{bookOdds:1,statistics:4,liveGenerator:3,feedPush:1,uiPush:1,thinClient:2,marketSemantics:1,ggbetNativeTabs:1,realtimePriority:1,pagedHistoryWorker:1},leagueRules:leagueStore.rules()});
      } catch (error) {
        return sendJson(req,res,400,{error:error?.message||String(error)});
      }
    }
    if (url.pathname === "/api/status") {
      return sendJson(req, res, 200, {
        version: config.version,
        astekOrigins: config.origins,
        fonbetUrls: config.fonbetUrls,
        intervalsMs: {
          astekLive: config.liveIntervalMs,
          fonbetLive: config.fonbetLiveIntervalMs,
          ggbetLiveSnapshot: config.ggbetSnapshotIntervalMs,
          astekPrematch: config.prematchCatalogIntervalMs,
          fonbetPrematch: config.fonbetPrematchIntervalMs,pinnaclePrematch:60000,pinnacleLive:15000,pinnacleLiveDetail:pinnacleCollector?.detailInterval||2000
        },
        live: { astek: liveState.status(), fonbet: fonbetLiveState.status(),...(pinnacleLiveState?{pinnacle:{...pinnacleLiveState.status(),...pinnacleCollector?.status()}}:{}),...(ggbetLiveState?{ggbet:{...ggbetLiveState.status(),...ggbetCollector?.status()}}:{}) },
        prematch: { astek: { ...prematchState.status(), ...(prematchCollector?.status?.()||{}) }, fonbet: fonbetPrematchState.status(),...(pinnaclePrematchState?{pinnacle:{...pinnaclePrematchState.status(),...pinnacleCollector?.status()}}:{}) },
        fonbetCollector: fonbetCollector?.status?.()||{enabled:false},
        ggbetCollector: ggbetCollector?.status?.()||{enabled:false},
        results: resultsService?.status?.()||{enabled:false}
      });
    }
    sendJson(req, res, 404, { error: "Not found" });
    }catch(error){log.error('[api]',error.message);if(!res.headersSent)sendJson(req,res,Number(error?.status)||503,{error:error.message});else res.end();}
  });
  server.stopStatistics=()=>statistics.stop();
  server.statistics=statistics;
  server.on("close",()=>{clearInterval(snapshotTimer);clearInterval(catalogTimer);clearInterval(lagTimer);clearInterval(rateTimer);for(const fn of feedUnsub)try{fn();}catch{}for(const client of feedClients)try{client.res.end();}catch{}feedClients.clear();lag.disable();});server.maxConnections=config.apiMaxConnections;server.headersTimeout=15000;server.requestTimeout=30000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=500;return server;
}
