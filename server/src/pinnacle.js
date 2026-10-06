import {historyEventMeta} from './history-model.js';
import { forensic, forensicSpan, errorFields, eventCounts } from './collector-forensics.js';
import {randomUUID} from 'node:crypto';
import Games from './game-categories.cjs';
import {fetchJson,readJson,writeJson} from './utils.js';

const slug=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const BASE='https://guest.api.arcadia.pinnacle.com/0.1';
const marketId=m=>[m.key,m.type,m.period,m.side||'',m.isAlternate?1:0].join('|');
export function pinnaclePeriodLabel(period){
 const p=Number(period)||0;
 if(p===0)return 'Матч';
 if(p>=1&&p<=10)return `Карта ${p}`;
 if(p>=11&&p<=17)return `Карта ${p-10} · 1-я половина`;
 if(p>=18){const offset=p-18,map=Math.floor(offset/36)+1,round=offset%36+1;if(map>=1&&map<=7)return `Карта ${map} · Раунд ${round}`;}
 return `Период ${p}`;
}
export function decimalOdds(value){const n=Number(value);return Number.isFinite(n)&&n!==0?Math.round((n>0?1+n/100:1+100/Math.abs(n))*1000)/1000:null;}
export function pinnacleLeague(name){return String(name||'').replace(/^(?:CS\s*2|Counter[- ]Strike(?:\s*2)?|Dota\s*2|League of Legends|LoL|Valorant|Rainbow Six(?: Siege)?|R6|Overwatch(?:\s*2)?|Mobile Legends(?: Bang Bang)?|Rocket League|StarCraft(?:\s*II|\s*2)?)\s*[-–—:]\s*/i,'').replace(/^[\s–—-]+|[\s–—-]+$/g,'');}
function normalizeMarkets(markets,{includeClosed=false}={}){
 const byMatch=new Map();
 for(const m of markets||[]){
  const status=String(m.status||'open').toLowerCase();
  if(!includeClosed&&status!=='open')continue;
  const prices=(m.prices||[]).map(p=>({...p,decimal:decimalOdds(p.price)})).filter(p=>p.decimal);
  if(!prices.length&&status==='open')continue;
  const list=byMatch.get(m.matchupId)||[];
  list.push({key:m.key,type:m.type,period:m.period,side:m.side,isAlternate:!!m.isAlternate,status,version:Number(m.version||0),prices});
  byMatch.set(m.matchupId,list);
 }
 return byMatch;
}
export function parsePinnacle(matchups,markets,at=Date.now(),mode='prematch',options={}){
 const byMatch=normalizeMarkets(markets,options),historyByMatch=normalizeMarkets(markets,{includeClosed:true});
 return (matchups||[]).filter(m=>m.type==='matchup'&&(mode==='live'?m.isLive:!m.parentId&&!m.isLive)&&!['closed','settled','cancelled','deleted'].includes(m.status)).flatMap(m=>{
  const home=m.participants?.find(p=>p.alignment==='home'),away=m.participants?.find(p=>p.alignment==='away'),startAt=Date.parse(m.startTime);if(!home?.name||!away?.name||!Number.isFinite(startAt)||!m.league?.id)return [];
  // Pinnacle period numbers are internal IDs, not map numbers. Also, a
  // market can still carry its last price while the whole period is already
  // suspended/settled. The website disables such prices based on period status.
  const periodStates=new Map((m.periods||[]).map(p=>[Number(p.period)||0,String(p.status||'open').toLowerCase()]));
  const normalized=(byMatch.get(m.id)||[]).map(market=>{
   const periodStatus=periodStates.get(Number(market.period)||0)||'open';
   const effectiveStatus=periodStatus==='open'?String(market.status||'open').toLowerCase():periodStatus;
   return {...market,status:effectiveStatus,periodStatus,periodLabel:pinnaclePeriodLabel(market.period)};
  }).filter(market=>options.includeClosed||market.status==='open');
  // The LIVE incarnation has a new ID; its parent is the original line fixture.
  const id=mode==='live'?(m.parentId||m.id):m.id;
  const statScore=p=>p.stats?.find(x=>Number(x.period)===0&&x.score!=null&&Number.isFinite(Number(x.score)))?.score;
  const hs=statScore(home),as=statScore(away),observedScore=hs!=null&&as!=null?String(hs)+':'+String(as):null;
  return [historyEventMeta({id:'pinnacle-'+id,sourceEventId:String(id),upstreamEventId:String(m.id),source:'pinnacle',provider:'Pinnacle',category:Games.resolve('Esports',m.league.name),league:pinnacleLeague(m.league.name),rawLeague:m.league.name,leagueId:String(m.league.id),team1:home.name,team2:away.name,startAt,bestOf:Number(m.bestOfX)||0,units:String(m.units||'Regular'),marketKind:'main',url:'https://www.pinnacle.com/en/esports/'+slug(m.league.name)+'/'+slug(home.name+' vs '+away.name)+'/'+m.id+'/',odds:{team1:home.name,team2:away.name,units:String(m.units||'Regular'),updatedAt:at,stale:false,transport:mode==='live'?'sport-live':'sport-prematch',markets:normalized}},{eventVersion:m.version??null,score:m.score??m.state?.score??observedScore,clock:m.clock??m.state?.clock??null,gameState:m.status??null,providerState:{state:m.state??null,periods:m.periods??null},markets:(historyByMatch.get(m.id)||[]).map(mm=>({...mm,status:(periodStates.get(Number(mm.period)||0)||'open')==='open'?mm.status:periodStates.get(Number(mm.period)||0)}))})];
 });
}

export class PinnacleCollector {
 constructor(state,{liveState,request=fetchJson,read=readJson,write=writeJson,interval=60000,liveInterval=15000,detailInterval=2000}={}){this.state=state;this.liveState=liveState;this.request=request;this.read=read;this.write=write;this.interval=Math.max(60000,interval);this.liveInterval=Math.max(15000,liveInterval);this.detailInterval=Math.max(1500,detailInterval);this.running=null;this.nextAt=0;this.nextPrematchAt=0;this.catalog=[];this.failures=[];this.client=null;this.detailCache=new Map();this.detailInflight=new Map();this.detailStreams=0;}
 status(){return {enabled:true,mode:this.liveState?'live+prematch':'prematch',running:!!this.running,nextAttemptAt:this.nextAt,failedLeagues:this.failures,catalogLeagues:this.catalog.length,requestMode:'sport+match-detail',requestsPerCycle:2,prematchIntervalMs:this.interval,liveIntervalMs:this.liveState?this.liveInterval:0,liveDetailIntervalMs:this.detailInterval,activeDetailStreams:this.detailStreams,rawMatchups:this.rawMatchups||0,lastCycleMs:this.lastCycleMs||0};}
 async credentials(){if(this.client?.apiKey)return this.client;this.client=await this.read('pinnacle-client.json',{})||{};this.client.deviceId ||= randomUUID();const override=process.env.PINNACLE_API_KEY;if(override)this.client.apiKey=override;if(!this.client.apiKey){const {payload}=await this.request('https://www.pinnacle.com/config/app.json','https://www.pinnacle.com/',{metricGroup:'pinnaclePrematch',requireSuccess:false});this.client.apiKey=payload?.api?.haywire?.apiKey;if(!this.client.apiKey)throw Error('Pinnacle: гостевой API-ключ отсутствует в конфигурации');}await this.write('pinnacle-client.json',this.client);return this.client;}
 async get(path,metricGroup){const c=await this.credentials();const {payload}=await this.request(BASE+path,'https://www.pinnacle.com/',{metricGroup:metricGroup||(path.includes('/live')?'pinnacleLive':'pinnaclePrematch'),timeoutMs:12000,requireSuccess:false,forensicOperation:path.split('?')[0],headers:{Accept:'application/json',Origin:'https://www.pinnacle.com','x-api-key':c.apiKey,'x-device-uuid':c.deviceId}});if(!Array.isArray(payload))throw Error('Pinnacle: неверный формат списка');return payload;}
 start(){this.tick();this.timer=setInterval(()=>this.tick(),1000);}
 tick(){if(this.running||Date.now()<this.nextAt)return this.running;this.nextAt=Date.now()+(this.liveState?this.liveInterval:this.interval);this.running=this.collect().catch(async error=>{if([401,403].includes(error.status)){this.client=null;await this.write('pinnacle-client.json',{});}if([401,403,429].includes(error.status))this.nextAt=Date.now()+Math.max(300000,error.retryAfterMs||0);forensic('pinnacle','retry',{operation:'feed',...errorFields(error),backoffMs:Math.max(0,this.nextAt-Date.now())});await Promise.all([this.state,this.liveState].filter(Boolean).map(s=>s.failure(error)));}).finally(()=>this.running=null);return this.running;}
 async stop(){clearInterval(this.timer);await this.running;}
 // Fixtures that have ever entered LIVE. History lives in SQLite, so this asks per id instead of copying every id.
 startedIds(){const live=this.liveState;if(!live)return new Set();if(typeof live.hasHistoryId!=='function')return new Set([...(live.history||[]),...(live.events||[])].map(r=>r.sourceEventId));const current=new Set((live.events||[]).map(r=>r.sourceEventId));return {has:sid=>current.has(sid)||live.hasHistoryId('pinnacle-'+sid),get size(){return current.size;}};}
 async feed(mode){
  const started=Date.now(),live=mode==='live',state=live?this.liveState:this.state,suffix=live?'/live':'',matchups=await this.get('/sports/12/matchups'+suffix+'?withSpecials=false');
  if(!live){this.rawMatchups=matchups.length;this.catalog=[...new Map(matchups.filter(m=>m.league?.id).map(m=>[m.league.id,{source:'pinnacle',category:Games.resolve('Esports',m.league.name),league:pinnacleLeague(m.league.name),leagueId:String(m.league.id)}])).values()];}
  let markets=[],marketError=null;
  try{markets=await this.get('/sports/12/markets'+suffix+'/straight?primaryOnly=false&withSpecials=false');}catch(error){if([401,403,429].includes(error.status))throw error;marketError=error;}
  const parsed=forensicSpan('pinnacle',mode+':normalize');
  const old=new Map((state.events||[]).map(e=>[e.id,e])),blocked=this.startedIds(),rows=parsePinnacle(matchups,markets,Date.now(),mode).filter(r=>live||!blocked.has(r.sourceEventId));
  // If this exact LIVE match was watched in the odds dialog, its match-specific
  // feed is newer than the broad sport feed. Never overwrite it with an older version.
  if(live)for(const row of rows){const detail=this.detailCache.get(row.sourceEventId);if(detail?.event?.upstreamEventId===row.upstreamEventId&&Number(detail.at||0)>Number(row.odds?.updatedAt||0))row.odds=detail.event.odds;}
  if(marketError)for(const row of rows)row.odds={...(old.get(row.id)?.odds||row.odds),stale:true};
  parsed({...eventCounts(rows),providerVersion:matchups[0]?.version??null});
  await state.success(rows,{elapsedMs:Date.now()-started});
  if(live){const ids=this.startedIds(),line=(this.state.events||[]).filter(r=>!ids.has(r.sourceEventId));if(line.length!==(this.state.events||[]).length)await this.state.success(line,{elapsedMs:Date.now()-started});}
  if(marketError)await state.failure(Error('Pinnacle: матчи обновлены, коэффициенты задерживаются ('+marketError.message+')'));
 }
 async collect(){const started=Date.now();this.failures=[];if(this.liveState){try{await this.feed('live');}catch(error){await this.liveState.failure(error);if([401,403,429].includes(error.status))throw error;}}
  if(!this.liveState||Date.now()>=this.nextPrematchAt){this.nextPrematchAt=Date.now()+this.interval;await this.feed('prematch');}this.lastCycleMs=Date.now()-started;
 }

 async liveDetail(sourceId,{force=false}={}){
  const id=String(sourceId||'').replace(/^pinnacle-/,'');
  if(!/^\d{5,20}$/.test(id))throw Object.assign(Error('Pinnacle: неверный ID матча'),{status:400});
  const now=Date.now(),cached=this.detailCache.get(id);
  if(!force&&cached&&now-cached.at<this.detailInterval-150)return cached.payload;
  if(this.detailInflight.has(id))return this.detailInflight.get(id);
  const run=(async()=>{
   let related=cached?.related||null,liveId=cached?.liveId||'';
   // Match metadata changes less often than prices. Fetch it initially, every
   // 30 seconds, or when a LIVE child cannot be found.
   if(!related||!liveId||now-Number(cached?.relatedAt||0)>30000){
    related=await this.get(`/matchups/${id}/related`,'pinnacleLiveDetail');
    const liveRows=related.filter(m=>m.type==='matchup'&&m.isLive&&(String(m.parentId||m.id)===id));
    const liveMatch=liveRows.sort((a,b)=>Number(b.version||0)-Number(a.version||0))[0];
    liveId=liveMatch?String(liveMatch.id):'';
   }
   const markets=await this.get(`/matchups/${id}/markets/related/straight`,'pinnacleLiveDetail');
   let event=null;
   if(liveId){
    event=parsePinnacle(related,markets,Date.now(),'live',{includeClosed:true}).find(r=>String(r.upstreamEventId)===liveId)||null;
   }
   const previous=cached?.event?.odds?.markets||[],previousSignature=JSON.stringify(previous);
   if(event){
    const current=new Map((event.odds.markets||[]).map(m=>[marketId(m),m]));
    // A market disappearing from the match-specific response is how Pinnacle
    // commonly represents suspension/closure. Preserve its last price and mark it.
    for(const old of previous)if(!current.has(marketId(old)))current.set(marketId(old),old.status==='open'?{...old,status:'closed',closedAt:Date.now()}:old);
    const nextMarkets=[...current.values()],changed=JSON.stringify(nextMarkets)!==previousSignature;
    event.odds={...event.odds,updatedAt:changed||!cached?.event?.odds?.updatedAt?Date.now():cached.event.odds.updatedAt,checkedAt:Date.now(),transport:'match-detail',markets:nextMarkets,stale:false};
   }else if(cached?.event){
    const nextMarkets=(previous||[]).map(m=>m.status==='closed'?m:{...m,status:'closed',closedAt:Date.now()});
    const changed=JSON.stringify(nextMarkets)!==previousSignature;
    event={...cached.event,odds:{...cached.event.odds,updatedAt:changed?Date.now():cached.event.odds.updatedAt,checkedAt:Date.now(),transport:'match-detail',markets:nextMarkets}};
   }
   const payload={ok:true,live:!!event,sourceEventId:id,upstreamEventId:event?.upstreamEventId||liveId||null,updatedAt:event?.odds?.updatedAt||Date.now(),checkedAt:Date.now(),transport:'match-detail',event};
   const next={at:Date.now(),relatedAt:related===cached?.related?cached?.relatedAt:Date.now(),related,liveId,event,payload};
   this.detailCache.set(id,next);
   if(this.detailCache.size>40)this.detailCache.delete(this.detailCache.keys().next().value);
   // Update the in-memory LIVE row so the broad snapshot also receives the freshest prices.
   if(event&&this.liveState){
    const rows=(this.liveState.events||[]).map(row=>String(row.sourceEventId)===id?{...row,odds:event.odds,upstreamEventId:event.upstreamEventId,url:event.url}:row);
    await this.liveState.success(rows,{elapsedMs:0});
   }
   return payload;
  })().finally(()=>this.detailInflight.delete(id));
  this.detailInflight.set(id,run);return run;
 }
}
