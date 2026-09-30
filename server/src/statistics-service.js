import {StatisticsStore} from './statistics-store.js';
// A provider match and actual map data are separate states: subscribe during
// draft so that its first live packet can make statistics available immediately.
export function usableStatistics(provider,d){
 if(!d?.matched)return false;
 if(provider==='hawk')return !!(d.event?.id&&d.event?.team1&&d.event?.team2&&d.event.maps?.some(m=>m.stateId!=null||m.picks?.length||m.buildings&&Object.keys(m.buildings).length||Array.isArray(m.score)&&m.score.length===2&&m.score.every(v=>v!=null&&Number.isFinite(Number(v)))&&m.gameTime!=null));
 return !!(d.map&&((d.players||[]).length||(d.timeline||[]).length));
}
export class StatisticsService{
 constructor(crossbet,hawk,events){this.store=new StatisticsStore();this.crossbet=crossbet;this.hawk=hawk;this.events=events;this.tracked=new Map();this.currentAvailability=new Map();this.currentAvailabilityAt=0;this.running=false;this.stopping=false;this.lastError='';this.lastSweepAt=0;this.lastCatalogKey='';this.providers={};
  const update=(provider,id,value)=>{const e=this.tracked.get(provider+'-'+id);if(e&&usableStatistics(provider,value))this.store.record(provider,e,value).catch(error=>{this.lastError=error.message;});};
  if(crossbet)crossbet.onUpdate=(id,value)=>update('crossbet',id,value);
  if(hawk)hawk.onUpdate=(id,value)=>update('hawk',id,value);
  this.timer=setInterval(()=>this.wake(),10000);this.timer.unref();this.wake();
 }
 valid(provider,d){return usableStatistics(provider,d);}
 wake(){this.sweep().catch(error=>{this.lastError=error.message;});}
 async sweep(){
  if(this.running||this.stopping)return;
  const seen=new Set(),rows=this.events().filter(e=>{if(e.marketKind&&e.marketKind!=='main'||/comparisons? by kills|kills? comparison|player kills/i.test(e.league||''))return false;
   // LIVE statistics identity deliberately ignores scheduled time. Collapse
   // duplicate bookmaker representations by category + league + participant pair.
   const league=String(e.leagueKey||e.league||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' '),key=[e.category,league,...[e.team1,e.team2].sort()].join('|');if(seen.has(key))return false;seen.add(key);return /dota|counter|cs2/i.test(e.category||'');});
  // Bookmaker fixtures may stay unchanged while the external statistics catalog
  // changes underneath us (match removed/finished/provider reconnect). Include
  // the provider catalog watermark so stale LIVE availability is cleared on the
  // next 10s sweep instead of surviving solely because bookmaker IDs did not move.
  const hs=this.hawk?.status?.()||{},cs=this.crossbet?.status?.()||{};
  const providerMark=[hs.indexUpdatedAt||0,hs.catalogSeries||0,cs.lastCatalogAt||0,cs.catalogMatches||0].join(':');
  const catalogKey=rows.map(e=>[e.id,e.category,e.league,e.team1,e.team2].join('~')).sort().join('|')+'#'+providerMark;if(catalogKey===this.lastCatalogKey&&Date.now()-this.lastSweepAt<30000)return;
  this.running=true;this.lastSweepAt=Date.now();this.lastCatalogKey=catalogKey;
  const nextAvailability=new Map(),nextTracked=new Map(),eventKeys=e=>[e?.id,...(e?.entityAliases||[]),...(e?.sourceRefs||[e]||[]).flatMap(r=>[r?.sourceEventId,r?.id,...(r?.aliases||[])])].filter(Boolean).map(String);
  try{await Promise.all(['hawk','crossbet'].filter(provider=>provider==='hawk'?!!this.hawk:!!this.crossbet).map(async provider=>{
   const pending=rows.filter(e=>(/dota/i.test(e.category)?'hawk':'crossbet')===provider),status={requested:pending.length,matched:0,ready:0,notMatched:0,waitingForData:0,lastError:'',checkedAt:Date.now()};let next=0;this.providers[provider]=status;
   const worker=async()=>{while(next<pending.length&&!this.stopping){const e=pending[next++];try{
    const query={team1:e.team1,team2:e.team2,league:e.league,category:e.category,startAt:e.startAt};
    const value=await (provider==='hawk'?this.hawk:this.crossbet).get(query);
    if(!value?.matched){status.notMatched++;continue;}
    status.matched++;const id=provider==='hawk'?value.event?.id:value.id;
    if(id!=null)nextTracked.set(provider+'-'+id,e);
    const usable=usableStatistics(provider,value);
    // For Dota the current series identity is useful before map telemetry has
    // arrived. Record the matched current series immediately so the UI can show
    // the statistics button and subscribe before the first map/state packet.
    // CS2 keeps the stricter ready-data requirement.
    if(provider!=='hawk'&&!usable){status.waitingForData++;continue;}
    const archiveId=await this.store.record(provider,e,value);
    if(usable)status.ready++;else status.waitingForData++;
    if(archiveId){const live={id:archiveId,provider:this.store.publicProvider(provider),updatedAt:Date.now(),ready:usable};for(const key of eventKeys(e))nextAvailability.set(key,live);}
   }catch(error){status.lastError=error.message;this.lastError=provider+': '+error.message;}}};
   await worker();
  }));this.tracked=nextTracked;this.currentAvailability=nextAvailability;this.currentAvailabilityAt=Date.now();}finally{this.running=false;}
 }
 async availability(events){this.wake();const currentFresh=Date.now()-this.currentAvailabilityAt<45000,eventKeys=e=>[e?.id,...(e?.entityAliases||[]),...(e?.sourceRefs||[e]||[]).flatMap(r=>[r?.sourceEventId,r?.id,...(r?.aliases||[])])].filter(Boolean).map(String);return Object.fromEntries((await Promise.all(events.map(async e=>{
   if(e?.view==='live'){const live=currentFresh?eventKeys(e).map(k=>this.currentAvailability.get(k)).find(Boolean):null;return [e.id,live||null];}
   const item=await this.store.lookup(e);return [e.id,item?{id:this.store.publicId(item.id),provider:this.store.publicProvider(item.provider),updatedAt:item.at}:null];
  }))).filter(([,v])=>v));}
 async stop(){this.stopping=true;clearInterval(this.timer);while(this.running)await new Promise(r=>setTimeout(r,100));this.hawk?.close?.();await this.crossbet?.stop?.();await this.store.stop();}
}
