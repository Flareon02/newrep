import {config,urls} from './config.js';
import {parseLiveFeed,inferCategoryFromLeague} from './parsers.js';
import {fetchJson,withAstekRequest,readJson,writeJson} from './utils.js';

export function parseChamps(payload){
  if(payload?.Success===false||!Array.isArray(payload?.Value))throw new Error('Некорректный каталог AstekBet');
  return [...new Map(payload.Value.filter(r=>r.LI&&Number(r.SI)===40).map(r=>[String(r.LI),{source:'astek',champId:String(r.LI),leagueId:String(r.LI),league:r.LE||r.L,category:inferCategoryFromLeague(r.LE||r.L),gameCount:Math.max(0,Number(r.GC)||0)}])).values()];
}
export class PrematchCollector {
  constructor(state,{request=fetchJson,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>Date.now(),persist=writeJson}={}){
    Object.assign(this,{state,request,sleep,now,persist,running:false,originIndex:0,catalog:[],champCache:{},batchSupported:null,batchRetryAt:0,bulkAttempts:0,bulkSuccesses:0,bulkFallbackLeagues:0,lastAttemptAt:0,lastUrl:'',failures:[],lastCycleMs:0,requestsInCycle:0,cooldownUntil:0,transport:'astek-line'});
  }
  async load(){this.champCache=await readJson('prematch-champs.json',{});}
  async get(url,origin){this.lastUrl=url;this.requestsInCycle++;const result=await withAstekRequest('prematch',(gateSignal)=>this.request(url,origin+'/line/esports',{timeoutMs:4500,signal:gateSignal}));this.state.progress?.(result);return result;}
  normalizeEvents(events){return events.filter(e=>e.team1&&e.team2).map(e=>({...e,url:e.url.replace('/live/','/line/'),scoreText:'',seriesScore:null,mapScores:[]}));}
  cacheLeague(c,events){this.champCache[c.champId]={champ:c,fetchedAt:this.now(),events:this.normalizeEvents(events.filter(e=>e.leagueId===c.champId))};}
  async games(group,origin){
    const wanted=new Set(group.map(c=>c.champId)),count=Math.min(1000,Math.max(50,group.reduce((n,c)=>n+c.gameCount,0)+1));
    const result=await this.get(urls.prematchGames(origin,[...wanted],count),origin);
    if(!Array.isArray(result.payload?.Value))throw new Error('Некорректный список матчей');
    if(result.payload.Value.length>=count)throw new Error('Ответ достиг лимита: предыдущая линия сохранена');
    let events=parseLiveFeed(result.payload,origin).filter(e=>e.team1&&e.team2);
    if(events.some(e=>!wanted.has(e.leagueId)))throw new Error('Ответ содержит незапрошенную лигу');
    for(const c of group){const rows=events.filter(e=>e.leagueId===c.champId);if(group.length>1&&rows.length<c.gameCount)throw new Error('Неполная лига '+c.champId+': '+rows.length+'/'+c.gameCount);this.cacheLeague(c,events);}
    return result;
  }
  // Browser HAR shows the same Get1x2 endpoint without `champs`. A high-count
  // aggregate request can replace dozens of per-league requests. Completeness
  // is checked league-by-league against raw LI counts; only missing/incomplete
  // leagues fall back to the conservative request used by older releases.
  async bulkGames(active,origin){
    this.bulkAttempts++;
    // The browser HAR confirms this aggregate endpoint with count=50. Astek
    // may reject/alter oversized count values, so probe the known-good window
    // and use it to eliminate only leagues whose full GC is present.
    const count=config.prematchBulkCount;
    const result=await this.get(urls.prematchBulk(origin,count),origin);
    if(!Array.isArray(result.payload?.Value))throw new Error('AstekBet bulk: некорректный список матчей');
    const raw=result.payload.Value,activeIds=new Set(active.map(c=>c.champId));let events=parseLiveFeed(result.payload,origin).filter(e=>activeIds.has(e.leagueId)&&e.team1&&e.team2);const parsedCounts=new Map();
    for(const event of events)parsedCounts.set(event.leagueId,(parsedCounts.get(event.leagueId)||0)+1);
    const limited=raw.length>=count,complete=[],missing=[];
    for(const c of active){
      // GC is the catalog's expected number of games in this league. Even if
      // the global aggregate reached its row limit, a league whose observed
      // LI count equals GC is complete. Only the truncated boundary/missing
      // leagues need a dedicated request.
      const got=parsedCounts.get(c.champId)||0;
      if(got>=Math.max(1,c.gameCount))complete.push(c);else missing.push(c);
    }
    // A valid aggregate answer must cover something unless it was explicitly
    // truncated. This prevents a parser/upstream format change from silently
    // replacing the line with empty caches.
    if(!complete.length&&active.length)throw new Error('AstekBet bulk: ни одна активная лига не подтверждена');
    for(const c of complete)this.cacheLeague(c,events);
    this.batchSupported=true;this.bulkSuccesses++;this.bulkFallbackLeagues+=missing.length;
    return {result,missing,complete,limited};
  }
  async poll(){
    if(this.running||this.now()<this.cooldownUntil)return;this.running=true;this.lastAttemptAt=this.now();this.state.begin?.();this.requestsInCycle=0;this.failures=[];
    const origin=config.origins[this.originIndex],deadline=this.now()+55000;
    try{
      const catalogResult=await this.get(urls.prematchCatalog(origin),origin),catalog=parseChamps(catalogResult.payload);this.catalog=catalog;
      if(!catalog.length&&this.state.events.length)throw new Error('Пустой каталог: сохранена последняя линия');
      const active=catalog.filter(c=>c.gameCount>0).sort((a,b)=>(this.champCache[a.champId]?.fetchedAt||0)-(this.champCache[b.champId]?.fetchedAt||0));
      let fallback=active;
      if(active.length&&this.now()>=this.batchRetryAt){
        try{const bulk=await this.bulkGames(active,origin);fallback=bulk.missing;}
        catch(error){this.batchSupported=false;this.batchRetryAt=this.now()+config.prematchBulkRetryMs;console.warn('[prematch] bulk fallback:',error.message);}
      }
      const queue=fallback.map(c=>[c]);
      for(let i=0;i<queue.length;i++){
        const group=queue[i];if(this.now()>=deadline){this.failures.push(...queue.slice(i).flat().map(c=>({id:c.champId,error:'Не успели за цикл'})));break;}
        // When bulk worked, only a small number of gaps remains. Keep a little
        // spacing to stay friendly to the upstream without spending a minute.
        await this.sleep(this.batchSupported?120:250);
        try{await this.games(group,origin);}catch(error){
          this.failures.push(...group.map(c=>({id:c.champId,error:error.message})));
          if(!error.status||[429,503,529].includes(error.status)){this.cooldownUntil=this.now()+Math.max(60000,error.retryAfterMs||0);this.failures.push(...queue.slice(i+1).flat().map(c=>({id:c.champId,error:'Цикл приостановлен'})));break;}
        }
      }
      const activeIds=new Set(active.map(c=>c.champId));for(const id of Object.keys(this.champCache))if(!activeIds.has(id))delete this.champCache[id];
      await this.persist('prematch-champs.json',this.champCache);
      const events=[...new Map(active.flatMap(c=>this.champCache[c.champId]?.events||this.state.events.filter(e=>e.leagueId===c.champId)).map(e=>[e.id,e])).values()];
      await this.state.success(events,catalogResult);
      if(this.failures.length){await this.state.partialFailure?.(new Error('Прематч частично обновлён: '+this.failures.length+' лиг; '+this.failures[0].error));await this.state.persist?.(true);this.originIndex=(this.originIndex+1)%config.origins.length;}
      console.log('[prematch]',events.length,'events,',active.length,'leagues,',this.requestsInCycle,'requests, bulk',this.batchSupported===true?'on':this.batchSupported===false?'fallback':'unknown');
    }catch(error){this.originIndex=(this.originIndex+1)%config.origins.length;await this.state.failure(error);console.error('[prematch]',error.message);}
    finally{this.lastCycleMs=this.now()-this.lastAttemptAt;this.running=false;}
  }
  start(){this.poll();this.timer=setInterval(()=>this.poll(),config.prematchCatalogIntervalMs);this.timer.unref?.();}
  async stop(){clearInterval(this.timer);while(this.running)await this.sleep(100);}
  status(){return {transport:this.transport,catalogLeagues:this.catalog.length,cachedLeagues:Object.keys(this.champCache).length,lastPollStartedAt:this.lastAttemptAt,running:this.running,lastUrl:this.lastUrl,batchSupported:this.batchSupported,bulkAttempts:this.bulkAttempts,bulkSuccesses:this.bulkSuccesses,bulkFallbackLeagues:this.bulkFallbackLeagues,batchRetryAt:this.batchRetryAt||0,requestsInCycle:this.requestsInCycle,lastCycleMs:this.lastCycleMs,failedLeagues:this.failures,cooldownUntil:this.cooldownUntil};}
}
