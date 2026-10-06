import {Worker} from 'node:worker_threads';
import {setJournalRowCount} from './sqlite-storage.js';
import {projectEvent} from './history-model.js';
let active;
export function publicationObservation(provider,event,context={}) {
  if(!event||event.odds?.stale)return null;
  const meta=event.__historyMeta||{};
  if(provider==='ggbet-node'||provider==='ggbet') {
    if(!meta.rawEvent||!['ggbet-node','ggbet-browser'].includes(meta.publicationSource))return null;
    const p=projectEvent(meta.publicationSource,meta.rawEvent,{...context,...meta,authority:'published'});
    p.state.sport=event.category;p.state.score=event.scoreText;p.state.seriesScore=event.seriesScore;p.state.mapScores=event.mapScores;
    p.state.map=event.activeMap??p.state.map;p.state.eventName=[event.team1,event.team2].join(' vs ');
    p.team1=event.team1;p.team2=event.team2;return p;
  }
  if(!['astek','fonbet','pinnacle'].includes(provider))return null;
  const p=projectEvent(provider,event,context);if(p){p.team1=event.team1;p.team2=event.team2;p.authority='published';p.oddsOnly=context.oddsOnly===true;}return p;
}
export function historyObserve(provider,events,context={}) {try{active?.observe(provider,events,context);}catch{if(active)active.stats.dropped++;}}
export function sqliteHistoryStatus(){return active?.status()||{enabled:false};}
export class SqliteHistoryClient {
  constructor(options){this.options=options;this.pending=new Map();this.seq=0;this.stats={enabled:true,ready:false,submitted:0,dropped:0,errors:0,pendingBytes:0};this.sigs=new Map();this.sigReset=setInterval(()=>this.sigs.clear(),120000);this.sigReset.unref?.();this.start();}
  start(){this.worker=new Worker(new URL('./sqlite-history-worker.js',import.meta.url),{workerData:this.options,resourceLimits:{maxOldGenerationSizeMb:128}});this.worker.unref();this.worker.on('message',m=>{if(m.type==='ready')this.stats.ready=true;if(m.type==='status')this.stats.writer=m.stats;if(m.type==='rows')setJournalRowCount(m.oddsRows,m.at);if(m.type==='ack'){this.stats.pendingBytes-=this.pending.get(m.id)||0;this.pending.delete(m.id);}if(m.type==='stopped')this.resolveStop?.();});this.worker.on('error',()=>this.stats.errors++);this.worker.on('exit',()=>{this.sigs.clear();this.stats.ready=false;this.stats.dropped+=this.pending.size;this.pending.clear();this.stats.pendingBytes=0;if(!this.stopped){this.retry=setTimeout(()=>this.start(),30000);this.retry.unref();}});}
  // A collector update carries every current event; most did not change since the previous one. The history-relevant
  // part (score state + markets) is serialized once: an unchanged event is not posted (no structured clone of its
  // market tree on the LIVE thread), and the same string gives the size check. The worker still deduplicates; the
  // cache is dropped every 2 minutes and on a worker restart, so a write that failed there is offered again.
  observe(provider,events,context){if(this.stopped)return;for(const event of events){try{if(this.pending.size>=1024||this.stats.pendingBytes>=8*1048576){this.stats.dropped++;continue;}const e=publicationObservation(provider,event,context);if(!e)continue;const s=e.state||{},sig=JSON.stringify([s.score,s.seriesScore,s.mapScores,s.map,s.period,s.gameState,s.betStop,s.competitorScores,e.oddsOnly?1:0,e.markets]),key=e.provider+':'+e.eventId;if(this.sigs.get(key)===sig){this.stats.unchanged=(this.stats.unchanged||0)+1;continue;}const bytes=Buffer.byteLength(sig)+1024;if(bytes>2*1048576||this.stats.pendingBytes+bytes>8*1048576){this.stats.dropped++;continue;}const id=++this.seq;this.worker.postMessage({id,event:e});this.pending.set(id,bytes);this.stats.pendingBytes+=bytes;this.stats.submitted++;this.sigs.delete(key);this.sigs.set(key,sig);if(this.sigs.size>4000)this.sigs.delete(this.sigs.keys().next().value);}catch{this.stats.dropped++;}}}
  status(){return {...this.stats,queueDepth:this.pending.size};}
  async stop(){this.stopped=true;clearInterval(this.sigReset);clearTimeout(this.retry);await Promise.race([new Promise(r=>{this.resolveStop=r;this.worker.postMessage({type:'stop'});}),new Promise(r=>setTimeout(r,8000))]);await this.worker.terminate();}
}
export function startSqliteHistory(options){if(!options.enabled)return null;active=new SqliteHistoryClient(options);return active;}
