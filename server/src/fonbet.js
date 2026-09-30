import { log } from "./logger.js";
import { config } from "./config.js";
import { fetchJson } from "./utils.js";
import { parseFonbetLive, parseFonbetPrematch } from "./fonbet-parser.js";

const jitter=(ms)=>Math.max(500,Math.round(ms*(0.9+Math.random()*0.2)));
const ROW_FIELDS=new Set(['sports','events','eventBlocks','eventMiscs','liveEventInfos','customFactors','tournamentInfos','publicPromos','topEvents']);
const mergeRowsInPlace=(base,delta,key)=>{
  const rows=Array.isArray(base)?base:[];
  if(!Array.isArray(delta)||!delta.length)return rows;
  const positions=new Map();
  for(let i=0;i<rows.length;i++){const id=key(rows[i]);if(id!==undefined&&id!==null&&String(id)!=='')positions.set(String(id),i);}
  for(const row of delta){
    const id=key(row);if(id===undefined||id===null||String(id)==='')continue;
    const k=String(id),at=positions.get(k);
    if(at===undefined){positions.set(k,rows.length);rows.push(row);}else rows[at]=row;
  }
  return rows;
};

// Fonbet /events/list responses are change sets keyed by entity IDs. Keep a
// materialized snapshot and periodically rebuild it from listBase so a missed
// or undocumented deletion can never drift forever. Apply small deltas in place
// instead of cloning the complete ~8 MB/8k-event object graph every five seconds;
// the previous implementation created very large short-lived heaps and hit the
// 768 MiB cgroup ceiling under normal traffic.
export function mergeFonbetPayload(base,delta){
  if(!base||!delta)return delta||base;
  const out=base;
  for(const [name,value] of Object.entries(delta))if(!ROW_FIELDS.has(name))out[name]=value;
  out.sports=mergeRowsInPlace(out.sports,delta.sports,r=>r.id);
  out.events=mergeRowsInPlace(out.events,delta.events,r=>r.id);
  out.eventBlocks=mergeRowsInPlace(out.eventBlocks,delta.eventBlocks,r=>r.eventId??r.e);
  out.eventMiscs=mergeRowsInPlace(out.eventMiscs,delta.eventMiscs,r=>r.eventId??r.id);
  out.liveEventInfos=mergeRowsInPlace(out.liveEventInfos,delta.liveEventInfos,r=>r.eventId??r.id);
  out.customFactors=mergeRowsInPlace(out.customFactors,delta.customFactors,r=>r.e??r.eventId);
  for(const [name,key] of [['tournamentInfos',r=>r.id],['publicPromos',r=>r.id],['topEvents',r=>r.id]]){
    if(Array.isArray(out[name])||Array.isArray(delta[name]))out[name]=mergeRowsInPlace(out[name],delta[name],key);
  }
  return out;
}

export function fonbetDeltaUrl(template,version){
  const url=new URL(template);
  url.searchParams.set('lang','en');url.searchParams.set('scopeMarket','1600');url.searchParams.set('version',String(version));
  return url.href;
}

export class FonbetCollector {
  constructor(liveState, prematchState) {
    this.liveState = liveState;
    this.prematchState = prematchState;
    this.running = false;
    this.timer = null;
    this.current = null;
    this.stopped = false;
    this.lastUrl = "";
    this.rawEventCount = 0;
    this.sportsCount = 0;
    this.lastPrematchUpdateAt = 0;
    this.nextPrematchAt = 0;
    this.urlIndex = 0;
    this.deltaUrlIndex=0;
    this.payload=null;
    this.packetVersion=0;
    this.lastFullAt=0;
    this.failures=0;
    this.fullRequests=0;
    this.deltaRequests=0;
    this.deltaFallbacks=0;
    this.lastBytes=0;
    this.lastTransport='none';
  }

  async fetchFull(){
    let error;
    for(let i=0;i<Math.max(1,config.fonbetUrls.length);i++){
      const index=(this.urlIndex+i)%config.fonbetUrls.length,usedUrl=config.fonbetUrls[index];
      try{
        const result=await fetchJson(usedUrl,'https://fon.bet/live/esports',{requireSuccess:false,timeoutMs:12000,metricGroup:'fonbetBase'});
        if(!Array.isArray(result.payload?.events)||!Array.isArray(result.payload?.sports)||!Number(result.payload?.packetVersion))throw Error('Fonbet listBase: неполный ответ');
        this.urlIndex=index;this.lastUrl=usedUrl;this.fullRequests++;this.lastBytes=result.bytes;this.lastTransport='full';this.lastFullAt=Date.now();
        this.payload=result.payload;this.packetVersion=Number(result.payload.packetVersion);return result;
      }catch(e){error=e;}
    }
    throw error||Error('Fonbet listBase недоступен');
  }

  async fetchDelta(){
    if(!this.payload||!this.packetVersion||!config.fonbetDeltaUrls.length)return null;
    let error;
    for(let i=0;i<config.fonbetDeltaUrls.length;i++){
      const index=(this.deltaUrlIndex+i)%config.fonbetDeltaUrls.length,usedUrl=fonbetDeltaUrl(config.fonbetDeltaUrls[index],this.packetVersion);
      try{
        const result=await fetchJson(usedUrl,'https://fon.bet/live/esports',{requireSuccess:false,timeoutMs:10000,metricGroup:'fonbetDelta'});
        const next=Number(result.payload?.packetVersion);
        if(!next||next<=this.packetVersion)throw Error('Fonbet delta: версия не продвинулась');
        this.payload=mergeFonbetPayload(this.payload,result.payload);this.packetVersion=next;this.deltaUrlIndex=index;this.lastUrl=usedUrl;this.deltaRequests++;this.lastBytes=result.bytes;this.lastTransport='delta';return result;
      }catch(e){error=e;}
    }
    throw error||Error('Fonbet delta недоступен');
  }

  async updateFeed(){
    const fullDue=!this.payload||!this.packetVersion||Date.now()-this.lastFullAt>=config.fonbetFullResyncMs;
    if(fullDue)return this.fetchFull();
    try{return await this.fetchDelta();}
    catch(error){
      this.deltaFallbacks++;log.warn(`[fonbet] delta failed, full resync: ${error.message}`);
      // Discard materialized state only after a full snapshot succeeds; until
      // then callers keep the last-known-good public SnapshotState.
      return this.fetchFull();
    }
  }

  async poll() {
    if (this.running || this.stopped) return false;
    this.running = true;
    const started = Date.now();
    const prematchDueAtStart = !this.nextPrematchAt || started >= this.nextPrematchAt;
    try {
      const result=await this.updateFeed(),payload=this.payload;
      const live = parseFonbetLive(payload);
      this.rawEventCount = live.rawEventCount;
      this.sportsCount = live.sportsCount;
      await this.liveState.success(live.events, { status: result.status, elapsedMs: result.elapsedMs });

      let prematchCount = this.prematchState.events.length;
      if (prematchDueAtStart) {
        try{
          const prematch = parseFonbetPrematch(payload);
          prematchCount = prematch.events.length;
          await this.prematchState.success(prematch.events, { status: result.status, elapsedMs: result.elapsedMs });
          this.lastPrematchUpdateAt = started;
          this.nextPrematchAt ||= started;
          do {this.nextPrematchAt += config.fonbetPrematchIntervalMs;} while(this.nextPrematchAt<=started);
        }catch(error){
          // LIVE and line are independent public states even though Fonbet sends
          // them in one packet. A line parser failure must not mark fresh LIVE stale.
          await this.prematchState.failure(error);
          log.warn(`[fonbet:prematch] ${error.message}`);
        }
      }
      this.failures=0;
      log.debug(`[fonbet] ${this.lastTransport} LIVE ${live.events.length}, prematch ${prematchCount}${prematchDueAtStart ? " checked" : " cached"}, raw ${live.rawEventCount}, ${result.bytes||0} bytes, ${Date.now()-started} ms`);
      return true;
    } catch (error) {
      this.failures++;
      await this.liveState.failure(error);
      if (prematchDueAtStart) await this.prematchState.failure(error);
      log.warn(`[fonbet] ${error.message}`);
      return false;
    } finally { this.running = false; }
  }

  nextDelay(ok){
    if(ok)return jitter(this.packetVersion&&config.fonbetDeltaUrls.length?config.fonbetDeltaIntervalMs:Math.max(config.fonbetLiveIntervalMs,config.fonbetFullFallbackIntervalMs));
    return jitter(Math.min(config.fonbetMaxBackoffMs,Math.max(config.fonbetDeltaIntervalMs,5000)*(2**Math.min(6,Math.max(1,this.failures)))));
  }
  schedule(delay=0){
    if(this.stopped)return;clearTimeout(this.timer);
    this.timer=setTimeout(async()=>{this.current=this.poll();const ok=await this.current;this.current=null;this.schedule(this.nextDelay(ok));},delay);this.timer.unref?.();
  }
  start() { this.stopped=false;this.schedule(0); }
  async stop(){this.stopped=true;clearTimeout(this.timer);if(this.current)await this.current.catch(()=>{});}

  status() {
    return {
      lastUrl: this.lastUrl, transport:this.lastTransport,packetVersion:this.packetVersion||null,lastFullAt:this.lastFullAt?new Date(this.lastFullAt).toISOString():null,
      fullRequests:this.fullRequests,deltaRequests:this.deltaRequests,deltaFallbacks:this.deltaFallbacks,lastBytes:this.lastBytes,failures:this.failures,
      rawEventCount: this.rawEventCount, sportsCount: this.sportsCount,
      liveIntervalMs: config.fonbetLiveIntervalMs,deltaIntervalMs:config.fonbetDeltaIntervalMs,fullFallbackIntervalMs:config.fonbetFullFallbackIntervalMs,fullResyncMs:config.fonbetFullResyncMs,
      prematchIntervalMs: config.fonbetPrematchIntervalMs,
      lastPrematchUpdateAt: this.lastPrematchUpdateAt ? new Date(this.lastPrematchUpdateAt).toISOString() : null
    };
  }
}
