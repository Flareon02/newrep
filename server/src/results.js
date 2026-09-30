import { log } from "./logger.js";
import {scoreLog} from './score-log.js';
import {coalesce} from './identity.js';
import {matchAsync} from './matcher-client.js';
import { config, urls } from './config.js';
import './time-utils.js';
import { fetchJson, mapLimit, clean, epochMs, readJson, withAstekRequest } from './utils.js';
import {archiveRead,archiveWrite} from './sqlite-storage.js';
import { canonicalCategory, englishize, eventKind, eventMatchScore, orientEvent, resolveEvents, matcherRevision } from './entity-resolver.js';
import { inferCategoryFromLeague } from './parsers.js';

const DAY=86400100, SCHEMA=4;
const unique=coalesce;
export function dateKey(ms=Date.now()){return new Date(ms+config.resultsTimezoneOffsetMinutes*60000).toISOString().slice(0,10);}
export function shiftDay(day,offset){return new Date(Date.parse(`${day}T12:00:00Z`)+offset*DAY).toISOString().slice(0,10);}
export function dayRange(day){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)!==day)throw new Error('Некорректная дата');
  const from=Date.parse(`${day}T00:00:00Z`)-config.resultsTimezoneOffsetMinutes*60000;
  if(from>Date.now()+DAY)throw new Error('Результаты доступны только за прошедшие дни');
  return {from,to:from+DAY};
}
const bestOfText=(...values)=>Number(values.map(clean).join(' ').match(/\b(?:bo|best\s+of)\s*([1357])\b/i)?.[1]||0);
function parseScore(text){
  const main=clean(text).match(/^\s*(\d+)\s*:\s*(\d+)/);
  const inner=clean(text).match(/\(([^)]*)\)/)?.[1]||'';
  return {seriesScore:main?[Number(main[1]),Number(main[2])]:null,mapScores:[...inner.matchAll(/(\d+)\s*:\s*(\d+)/g)].map(m=>[Number(m[1]),Number(m[2])])};
}
export function formatScore(series,maps=[]){return series?`${series[0]}:${series[1]}${maps.length?` (${maps.map(x=>`${x[0]}:${x[1]}`).join(', ')})`:''}`:'';}
function requireItems(payload,label){
  if(!payload||!Array.isArray(payload.items)||payload.errorCode||payload.Success===false)throw new Error(`${label}: неожиданный формат ответа`);
  if(Number(payload.count)>payload.items.length){const error=new Error(`${label}: неполный ответ (${payload.items.length}/${payload.count})`);error.incomplete=true;throw error;}
  return payload.items;
}
export function parseAstekResultGames(payload,origin='https://astekbet.com'){
  const out=[];
  for(const item of requireItems(payload,'AstekBet results')){
    if(item.sportId!==undefined&&Number(item.sportId)!==40)continue;
    const id=clean(item.id),team1=englishize(item.opp1),team2=englishize(item.opp2),league=englishize(item.champName);
    if(!id||!team1||!team2)continue;
    const parsed=parseScore(item.score);if(!parsed.seriesScore)continue;
    const bestOf=bestOfText(item.matchInfos?.['3'],league);
    out.push({id,sourceEventId:id,source:'astek',provider:'AstekBet',category:inferCategoryFromLeague(league),league,leagueId:clean(item.champId),
      team1,team2,startAt:epochMs(item.dateStart),endedAt:epochMs(item.dateEnd||item.dateFinish),
      marketKind:eventKind({league,team1,team2,name:`${item.gameTypeName||''} ${item.gameVidName||''}`}),
      bestOf,bestOfSource:bestOf?'text':'unknown',...parsed,scoreText:clean(item.score),resultVerified:true,resultSource:'astek-results',url:`${origin}/en/results`});
  }
  return out;
}
export function parseFonbetResultGames(payload){
  if(!payload||!Array.isArray(payload.events)||!Array.isArray(payload.competitions)||!Array.isArray(payload.eventMiscs))throw new Error('Fonbet results: неожиданный формат ответа');
  const competitions=new Map(payload.competitions.map(x=>[String(x.id),x])),miscs=new Map(payload.eventMiscs.map(x=>[String(x.id),x]));
  const out=[];
  for(const e of payload.events){
    const comp=competitions.get(String(e.competitionId)),misc=miscs.get(String(e.id));
    if(String(comp?.sportId)!=='29086'||!misc||misc.score1===undefined||misc.score2===undefined||Number(e.status)!==2)continue;
    const team1=englishize(e.team1),team2=englishize(e.team2),league=englishize(comp.name);if(!e.id||!team1||!team2)continue;
    const seriesScore=[Number(misc.score1),Number(misc.score2)];
    const mapScores=(misc.subScores||[]).filter(x=>x.score1!==undefined&&x.score2!==undefined).sort((a,b)=>Number(a.scoreIndex)-Number(b.scoreIndex)).map(x=>[Number(x.score1),Number(x.score2)]);
    const bestOf=bestOfText(league,e.name);
    out.push({id:`fonbet-${e.id}`,sourceEventId:String(e.id),source:'fonbet',provider:'Fonbet',category:inferCategoryFromLeague(league),league,leagueId:clean(e.competitionId),team1,team2,
      startAt:epochMs(e.startTime),endedAt:epochMs(e.endTime||e.finishTime),marketKind:eventKind({league,team1,team2,name:e.name}),bestOf,bestOfSource:bestOf?'text':'unknown',seriesScore,mapScores,scoreText:formatScore(seriesScore,mapScores),
      resultVerified:true,resultSource:'fonbet-results',url:'https://fon.bet/results'});
  }
  return out;
}
function normalizeScores(event){
  const refs=event.sourceRefs||[event];
  const bestOf=Math.max(0,...refs.map(r=>Number(r.bestOf||0)).filter(n=>[1,3,5,7].includes(n)));
  const normalized=refs.map(ref=>{
    const maps=(ref.mapScores||[]).map(x=>[...x]);
    // An absent final score stays unknown. Zero placeholders only pad maps
    // in a series for which the provider actually reported a score.
    if(ref.seriesScore&&bestOf>1)while(maps.length<bestOf)maps.push([0,0]);
    return {...ref,bestOf:bestOf||ref.bestOf||0,mapScores:maps,scoreText:ref.seriesScore?formatScore(ref.seriesScore,maps):ref.scoreText||''};
  });
  const selected=normalized.find(r=>r.resultVerified)||normalized.find(r=>r.scoreText)||{};
  return {...event,bestOf,sourceRefs:normalized,resultRefs:normalized.filter(r=>r.resultVerified),scoreText:selected.scoreText||'',finalScoreText:selected.resultVerified?selected.scoreText:'',resultVerified:normalized.some(r=>r.resultVerified)};
}
export function archiveSortTime(event){return Number(event.endedAt||event.removedAt||event.startAt||0);}

export class ResultsService {
  constructor(astekLiveState,fonbetLiveState,astekPrematchState=null,fonbetPrematchState=null,{request=fetchJson,extraLiveStates=[]}={}){
    this.states=[astekLiveState,fonbetLiveState,...extraLiveStates].filter(Boolean);this.request=request;
    this.index={};this.days=new Map();this.raw=new Map();this.inflight=new Map();this.queue=new Map();this.running=new Map();this.stopped=false;this.timer=null;
    this.views=new Map();this.rowVersions=new WeakMap();this.rowSequence=0;this.priming=null;
    this.listeners=new Set();
    this.httpActive=0;this.httpWait=[];this.astekTail=Promise.resolve();this.astekNextAt=0;this.astekPreferences=new Map();this.cooldowns=new Map();
    this.priorityProbe=()=>false;this.drainTimer=0;this.lastWarmStartAt=0;
  }
  onChange(listener){if(typeof listener!=='function')return()=>{};this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  setPriorityProbe(fn){this.priorityProbe=typeof fn==='function'?fn:()=>false;}
  emitChange(change={}){for(const listener of this.listeners)try{listener({...change,at:Number(change.at)||Date.now()});}catch(error){log.error('[results-listener]',error?.message||error);}}
  async load(){
    const saved=archiveRead('results/index.json',{});this.index=[3,SCHEMA].includes(saved.schemaVersion)?saved.days||{}:{};
    // Retain the legacy file unchanged. Previously requested old days are rebuilt
    // once with the corrected parsers/catalog, then kept permanently as well.
    if(saved.schemaVersion!==SCHEMA)for(const meta of Object.values(this.index))meta.rebuild=true;
    this.legacyDays=Object.keys(await readJson('results-cache.json',{})).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x));
  }
  async persistIndex(){archiveWrite('results/index.json',{schemaVersion:SCHEMA,timezoneOffsetMinutes:config.resultsTimezoneOffsetMinutes,days:this.index});}
  remember(map,key,value,limit=48){map.delete(key);map.set(key,value);if(map.size>limit)map.delete(map.keys().next().value);return value;}
  ttl(day){return day<dateKey()&&!(this.viewedDays?.get(day)>Date.now())?86400100:config.resultsCurrentCacheMs;}
  fresh(row,day){return !row?.rebuild&&row?.complete===true&&row.timezoneOffsetMinutes===config.resultsTimezoneOffsetMinutes&&Date.now()-Number(row.updatedAt||0)<this.ttl(day);}
  async requestLimited(url,referer,options={}){
    if(this.httpActive>=config.resultsConcurrency)await new Promise(resolve=>this.httpWait.push(resolve));
    else this.httpActive++;
    try{return await this.request(url,referer,{requireSuccess:false,...options});}
    finally{const next=this.httpWait.shift();if(next)next();else this.httpActive--;}
  }
  async astekRequest(build,kind='catalog'){
    // Serialize archive calls to AstekBet, leaving live polling independent.
    // A failed batch must finish before the next one starts.
    const previous=this.astekTail;let release;this.astekTail=new Promise(r=>release=r);await previous;
    try{
      const wait=this.astekNextAt-Date.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));
      let error;const preferred=this.astekPreferences.get(kind);
      const origins=[...new Set([preferred?.origin,...config.origins].filter(Boolean))];
        for(const origin of origins){
          if((this.cooldowns.get(origin)||0)>Date.now())continue;
          const variants=[...new Set([preferred?.origin===origin?preferred.variant:(kind==='games'?'both':'plural'),'plural','both'])];
          for(const variant of variants){try{
            const result=await withAstekRequest('results',gateSignal=>this.requestLimited(build(origin,variant),`${origin}/en/results`,{signal:gateSignal}));requireItems(result.payload,'AstekBet');
            this.astekPreferences.set(kind,{origin,variant});return {payload:result.payload,origin};
          }catch(e){
            error=e;
            if([429,529,503].includes(e.status)){this.cooldowns.set(origin,Date.now()+Math.max(60000,e.retryAfterMs||0));break;}
            if(e.status!==400)break;
          }}
        }
        throw error||new Error('AstekBet: ожидается повтор после ограничения запросов');
    }finally{this.astekNextAt=Date.now()+config.resultsMinRequestGapMs;release();}
  }
  async astekPage(day,key,load,force=false){
    const file=`results/pages/astek/${day}/${key}.json`,cached=archiveRead(file,null);
    if(!force&&this.fresh(cached,day))return cached;
    const data=await load(),row={...data,complete:true,updatedAt:Date.now(),timezoneOffsetMinutes:config.resultsTimezoneOffsetMinutes};
    archiveWrite(file,row);return row;
  }
  async fetchAstekDay(day,{force=false}={}){
    const {from,to}=dayRange(day),champs=new Set(),all=[],errors=[];
    // The catalog endpoint rejects the current partial window with HTTP 400.
    // Use its full six-hour boundary, including the future end of today's current window.
    // Future windows are skipped; successful pages are cached independently.
    await mapLimit([0,1,2,3],2,async i=>{
      const a=from+i*DAY/4,b=Math.min(to,a+DAY/4);if(a>=Date.now())return;
      try {
      const catalog=await this.astekPage(day,`catalog-${i}`,()=>this.astekRequest((origin,variant)=>urls.resultsChamps(origin,a,b,variant)),force);
      const ids=catalog.payload.items.filter(c=>Number(c.sportId)===40).map(c=>String(c.id)).sort();ids.forEach(id=>champs.add(id));
      const groups=[];for(let j=0;j<ids.length;j+=5)groups.push(ids.slice(j,j+5));
      const games=async(group,left,right,suffix='')=>{
        try{
          const page=await this.astekPage(day,`games-${i}-${group.join('-')}${suffix}`,()=>this.astekRequest((origin,variant)=>urls.results(origin,group.join(','),left,right,variant),'games'),force);
          all.push(...parseAstekResultGames(page.payload,page.origin));
        }catch(error){
          if(!error.incomplete)throw error;
          if(group.length>1){const middle=Math.ceil(group.length/2);await games(group.slice(0,middle),left,right,suffix);await games(group.slice(middle),left,right,suffix);}
          else if(right-left>60000){const middle=Math.floor((left+right)/2000)*1000;await games(group,left,middle,suffix+'-left');await games(group,middle,right,suffix+'-right');}
          else throw error;
        }
      };
      await mapLimit(groups,2,async group=>{try{await games(group,a,b);}catch(error){errors.push(`Лиги ${group.join(',')}: ${error.message}`);}});
      } catch(error){errors.push(`Период ${i+1}: ${error.message}`);}
    });
    return {games:unique(all),queriedLeagues:champs.size,complete:errors.length===0,error:errors.join('; ')};
  }
  async fetchFonbetDay(day){
    let error;
    for(const base of config.fonbetResultsUrls){
      try{const {payload}=await this.requestLimited(urls.fonbetResults(base,day),'https://fon.bet/results');return {games:parseFonbetResultGames(payload)};}catch(e){error=e;}
    }
    throw error||new Error('Fonbet недоступен');
  }
  async providerDay(source,day,{force=false}={}){
    const key=`${source}:${day}`;
    if(this.inflight.has(key))return this.inflight.get(key);
    const run=(async()=>{
      const file=`results/raw/${source}/${day}.json`;
      const cached=this.raw.get(key)||archiveRead(file,null);
      if(!force&&this.fresh(cached,day))return this.remember(this.raw,key,cached,config.resultsRawMemoryCache);
      const fetched=source==='astek'?await this.fetchAstekDay(day,{force}):await this.fetchFonbetDay(day);
      const row={...fetched,games:fetched.complete===false?unique([...(cached?.games||[]),...fetched.games]):fetched.games,complete:fetched.complete!==false,updatedAt:Date.now(),timezoneOffsetMinutes:config.resultsTimezoneOffsetMinutes};
      archiveWrite(file,row);return this.remember(this.raw,key,row,config.resultsRawMemoryCache);
    })();
    this.inflight.set(key,run);try{return await run;}finally{this.inflight.delete(key);}
  }
  history(from,to){
    return this.states.flatMap(s=>typeof s.historyByStart==='function'?s.historyByStart(from,to):(s.history||s.publicHistory?.(from-DAY)||[])).filter(e=>Number(e.startAt)>=from&&Number(e.startAt)<to&&Number(e.removedAt)>0);
  }
  combine(games,from,to){
    const rows=unique(games.filter(r=>r.startAt>=from&&r.startAt<to)).map(r=>({...r}));
    const byId=new Map(rows.map(r=>[`${r.source}:${clean(r.sourceEventId||r.id).replace(/^fonbet-(?:result-)?/,'')}`,r]));
    const history=coalesce(this.history(from,to)),claimed=new Set(),timeBuckets=new Map();
    const slot=event=>Math.floor(Number(event.startAt||0)/300000);
    for(const row of rows){const key=`${row.source}:${slot(row)}`;if(!timeBuckets.has(key))timeBuckets.set(key,[]);timeBuckets.get(key).push(row);}
    for(const observed of history){
      const id=clean(observed.sourceEventId||observed.id).replace(/^fonbet-(?:result-)?/,'');
      let result=byId.get(`${observed.source}:${id}`);
      if(!result){
        // Same provider, same market, a close start and both participants.
        // Results can use a new ID or reverse the provider's original order.
        const nearby=[-1,0,1].flatMap(delta=>timeBuckets.get(`${observed.source}:${slot(observed)+delta}`)||[]);
        const candidates=nearby.filter(r=>!claimed.has(r)).map(r=>({r,info:eventMatchScore({...observed,source:'observed'},r,{mode:'live'})})).filter(x=>x.info?.teams.min>=.94&&x.info.time.minutes<=5).sort((a,b)=>b.info.score-a.info.score);
        if(candidates.length===1||candidates[0]?.info.score>candidates[1]?.info.score+.03)result=candidates[0]?.r;
      }
      if(result&&!claimed.has(result)){
        claimed.add(result);
        Object.assign(result,orientEvent(result,observed));
        Object.assign(result,{firstSeenAt:Number(observed.firstSeenAt||0),enteredLiveAt:Number(observed.enteredLiveAt||observed.firstSeenAt||0),lastSeenAt:Number(observed.lastSeenAt||0),removedAt:Number(observed.removedAt||0),lifecycle:observed.lifecycle||[],bestOf:result.bestOf||observed.bestOf||0});
      }else if(!result){const row={...observed,sourceEventId:id,endedAt:0,resultVerified:false};rows.push(row);byId.set(`${row.source}:${id}`,row);}
    }
    // A full month of results can contain thousands of fixtures. Cross-book
    // matching only makes sense within one discipline. Resolve small independent
    // groups to avoid a quadratic comparison over the complete archive.
    const groups=new Map();for(const row of rows){const key=canonicalCategory(row.category||inferCategoryFromLeague(row.league));if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
    return [...groups.values()].flatMap(group=>resolveEvents(group,{mode:'past'})).map(normalizeScores).sort((a,b)=>archiveSortTime(b)-archiveSortTime(a)||String(a.id).localeCompare(String(b.id)));
  }
  async rangeView(range,rows,prepared=null){
    // The independently archived day already contains resolved, persistent
    // events. Opening the extension must not rematch the entire day on a new
    // worker each time the server starts or a user changes dates.
    if(!prepared&&rows.length===1&&Array.isArray(rows[0]?.events))return rows[0].events.filter(e=>Number(e.startAt)>=range.from&&Number(e.startAt)<range.to);
    const known=this.history(range.from,range.to),key=`${range.from}:${range.to}`;
    const versions=rows.map(row=>{if(!row)return 0;if(!this.rowVersions.has(row))this.rowVersions.set(row,++this.rowSequence);return this.rowVersions.get(row);});
    const history=known.map(r=>[r.source,r.id,r.removedAt,r.scoreText,r.bestOf]);
    const signature=()=>JSON.stringify([versions,matcherRevision(),history]);
    const cached=this.views.get(key);if(cached?.signature===signature())return cached.events;
    const stored=rows.filter(Boolean).flatMap(r=>r.events||[]);
    const events=prepared||((rows.filter(Boolean).length===rows.length&&stored.length)?stored.filter(e=>Number(e.startAt)>=range.from&&Number(e.startAt)<range.to):await matchAsync('archive',{games:rows.filter(Boolean).flatMap(r=>Object.values(r.providerGames||{}).flat()),history:known,from:range.from,to:range.to}));
    this.remember(this.views,key,{signature:signature(),events},config.resultsViewMemoryCache);return events;
  }
  async readDay(day){
    let row=this.days.get(day);if(row)return row;
    row=archiveRead(`results/days/${day}.json`,null);
    const current=this.days.get(day);if(current&&Number(current.updatedAt)>=Number(row?.updatedAt||0))return current;
    if(row?.schemaVersion===3)row={...row,schemaVersion:SCHEMA,events:[]};
    if(row?.schemaVersion!==SCHEMA)return null;
    return this.remember(this.days,day,row,config.resultsDayMemoryCache);
  }
  async prepareViews(day,row){
    await this.rangeView(dayRange(day),[row]);
    for(const selected of [day,shiftDay(day,1)]){
      const range=MonitorTime.dayRange(selected,'Asia/Yerevan'),first=dateKey(range.from),last=dateKey(range.to-1),rows=await Promise.all([...new Set([first,last])].map(d=>this.readDay(d)));
      await this.rangeView(range,rows);
    }
  }
  async buildDay(day){
    const {from,to}=dayRange(day),previous=await this.readDay(day);
    const providerGames={...(previous?.providerGames||{})},providers={...(previous?.providers||{})};
    const errors=[],observed=this.history(from,to),meta=this.index[day]||{};
    const observedThrough=Math.max(0,...observed.map(r=>Number(r.removedAt||0)));
    const forceSources=new Set();
    // Cache expiry controls upstream refresh; observations do not bypass the daily limit.
    await Promise.all(['astek','fonbet'].map(async source=>{
      try{
        let result;
        if(source==='astek')result=await this.providerDay(source,day,{force:forceSources.has(source)});
        else{
          const lineDays=[shiftDay(day,-1),day,shiftDay(day,1)].filter(d=>d<=dateKey());
          const fetched=await Promise.all(lineDays.map(d=>this.providerDay(source,d,{force:forceSources.has(source)})));
          result={games:unique(fetched.flatMap(x=>x.games)),updatedAt:Math.min(...fetched.map(x=>x.updatedAt))};
        }
        providerGames[source]=(result.complete===false?unique([...(providerGames[source]||[]),...result.games]):result.games).filter(g=>g.startAt>=from&&g.startAt<to);
        providers[source]={ready:result.complete!==false,count:providerGames[source].length,updatedAt:result.updatedAt,queriedLeagues:result.queriedLeagues||0,error:result.error||''};
        if(result.complete===false)errors.push({source,error:result.error||'Ответ неполный'});
      }catch(error){
        const message=error?.message||String(error);errors.push({source,error:message});
        providers[source]={...providers[source],ready:false,error:message};
      }
    }));
    const now=Date.now();let events;
    try{events=await matchAsync('archive',{games:Object.values(providerGames).flat(),history:observed,from,to});}
    catch(error){
      errors.push({source:'matcher',error:error.message});
      // Retain both fetched bookmaker results and the previous usable view.
      // The next retry can rematch the saved providerGames without refetching.
      events=previous?.events||[];
    }
    const complete=errors.length===0,attempts=complete?0:Number(this.index[day]?.attempts||0)+1;
    await scoreLog.record(events.flatMap(e=>(e.sourceRefs||[e]).filter(r=>r.resultVerified)),{phase:'results',at:now}).catch(error=>log.error('[score-log]',error.message));
    const pendingFinals=events.flatMap(e=>(e.sourceRefs||[]).filter(r=>!r.resultVerified&&r.removedAt).map(r=>({source:r.source,id:r.sourceEventId||r.id,removedAt:r.removedAt})));
    const row={schemaVersion:SCHEMA,date:day,from,to,timezoneOffsetMinutes:config.resultsTimezoneOffsetMinutes,updatedAt:now,complete,providerGames,providers,events,pendingFinals,observedThrough};
    // Each date is an atomic independent file. A failed/missing upstream never
    // marks an empty day complete and never discards an existing provider's data.
    archiveWrite(`results/days/${day}.json`,row);
    this.remember(this.days,day,row,config.resultsDayMemoryCache);
    this.index[day]={complete,pendingFinals,observedThrough,updatedAt:now,timezoneOffsetMinutes:config.resultsTimezoneOffsetMinutes,count:events.length,providers,attempts,nextRetryAt:complete?0:now+this.ttl(day),error:errors.map(e=>e.error).join('; ')};
    await this.persistIndex();
    // Build a view only when requested.
    if(errors.length)log.error(`[results:${day}] ${errors.map(e=>`${e.source}: ${e.error}`).join('; ')}`);
    else log.enabled('debug')&&log.debug(`[results:${day}] ready: ${events.length} matches`);
    this.emitChange({type:'day-updated',date:day,updatedAt:now,complete,count:events.length,pendingFinals:pendingFinals.length});
    return row;
  }
  needsFinalRefresh(day){return day===dateKey()&&Date.now()-Number(this.index[day]?.updatedAt||0)>=config.resultsCurrentCacheMs;}
  enqueue(day,priority=1){
    if(this.stopped||this.running.has(day))return;
    const meta=this.index[day];
    // A cycle is limited to once per five minutes, including failed cycles.
    if(day===dateKey()&&Number(meta?.updatedAt)>0&&Date.now()-meta.updatedAt<config.resultsCurrentCacheMs)return;
    if((this.fresh(meta,day)&&!this.needsFinalRefresh(day))||(day<dateKey()&&Number(meta?.nextRetryAt)>Date.now()))return;
    if(this.queue.has(day))this.queue.set(day,Math.min(priority,this.queue.get(day)));
    else this.queue.set(day,priority);
    this.drain();
  }
  scheduleDrain(delay=750){
    if(this.stopped||this.drainTimer)return;
    this.drainTimer=setTimeout(()=>{this.drainTimer=0;this.drain();},Math.max(100,delay));this.drainTimer.unref?.();
  }
  drain(){
    if(this.stopped||!this.queue.size||this.running.size>=config.resultsDayConcurrency)return;
    if(this.priorityProbe?.()){this.scheduleDrain(750);return;}
    const [day,priority]=[...this.queue].sort((a,b)=>a[1]-b[1]||b[0].localeCompare(a[0]))[0];
    if(priority>0){const wait=config.resultsWarmIntervalMs-(Date.now()-this.lastWarmStartAt);if(wait>0){this.scheduleDrain(wait);return;}this.lastWarmStartAt=Date.now();}
    this.queue.delete(day);
    const run=this.buildDay(day).catch(async error=>{
      const now=Date.now();this.index[day]={...this.index[day],updatedAt:now,complete:false,nextRetryAt:now+this.ttl(day),error:error.message};
      log.error(`[results:${day}] ${error.message}`);await this.persistIndex().catch(()=>{});
    }).finally(()=>{this.running.delete(day);this.scheduleDrain(priority>0?config.resultsWarmIntervalMs:750);});
    this.running.set(day,run);
  }
  warmDates(){
    const zone='Asia/Yerevan',today=MonitorTime.dateKey(Date.now(),zone),first=dateKey(MonitorTime.dayRange(shiftDay(today,-config.resultsWarmDays),zone).from),last=dateKey(MonitorTime.dayRange(today,zone).to-1),days=[];
    for(let d=first;d<=last;d=shiftDay(d,1))days.push(d);return days;
  }
  warmRecentDays(){
    for(const day of this.warmDates().reverse())this.enqueue(day,day===dateKey()?0:1);
    for(const day of this.legacyDays||[])this.enqueue(day,2);
    for(const [day,row] of Object.entries(this.index))if(!row.complete||row.rebuild||row.pendingFinals?.length)this.enqueue(day,day===dateKey()?0:2);
  }
  start(){
    this.stopped=false;this.warmupStarted=false;
    // LIVE and prematch get a quiet two-minute startup window. Previously the
    // 30-day archive queue started immediately and competed with LiveFeed on
    // the one-CPU VPS.
    const beginWarmup=()=>{this.warmupStarted=true;this.warmRecentDays();};
    if(config.resultsWarmupDelayMs<=0)beginWarmup();
    else {this.warmupTimer=setTimeout(beginWarmup,config.resultsWarmupDelayMs);this.warmupTimer.unref?.();}
    this.priming=Promise.resolve(); // Views are built lazily, never 30 days during startup.
    this.timer=setInterval(()=>{if(this.warmupStarted)this.warmRecentDays();},5000);this.timer.unref?.();
  }
  async stop(){this.stopped=true;clearInterval(this.timer);clearTimeout(this.warmupTimer);clearTimeout(this.drainTimer);await Promise.allSettled([...this.running.values(),this.priming]);await this.persistIndex();}
  async getRange(from,to,lineDate='',timeZone=''){
    if(timeZone&&!MonitorTime.valid(timeZone))throw new Error('Некорректный часовой пояс');
    const day=clean(lineDate)||(Number(from)>0?(timeZone?MonitorTime.dateKey(Number(from),timeZone):dateKey(Number(from))):(timeZone?MonitorTime.dateKey(Date.now(),timeZone):dateKey()));
    const range=timeZone?MonitorTime.dayRange(day,timeZone):dayRange(day);
    if(range.from>Date.now()+DAY)throw new Error('Результаты доступны только за прошедшие дни');
    const days=[dateKey(range.from)];const last=dateKey(range.to-1);if(last!==days[0])days.push(last);
    this.viewedDays??=new Map();for(const d of days){this.viewedDays.set(d,Date.now()+360000);const meta=this.index[d];if(meta?.nextRetryAt>0)meta.nextRetryAt=Math.min(meta.nextRetryAt,Number(meta.updatedAt||0)+config.resultsCurrentCacheMs);}
    const rows=await Promise.all(days.map(d=>this.readDay(d)));
    days.forEach((d,i)=>{if(!rows[i]&&this.index[d]?.complete)this.index[d].complete=false;this.enqueue(d,0);});
    const ready=rows.every(r=>r?.complete&&r.timezoneOffsetMinutes===config.resultsTimezoneOffsetMinutes),available=rows.filter(Boolean),events=await this.rangeView(range,rows);
    const updatedAt=available.length?Math.min(...available.map(r=>r.updatedAt)):0,providers={};
    for(const source of ['astek','fonbet']){
      const details=available.map(r=>r.providers?.[source]).filter(Boolean),errors=[...new Set(details.map(r=>r.error).filter(Boolean))];
      providers[source]={ready:details.length===days.length&&details.every(r=>r.ready),count:events.filter(e=>e.sourceRefs.some(r=>r.source===source&&r.resultVerified)).length,queriedLeagues:Math.max(0,...details.map(r=>r.queriedLeagues||0)),error:errors.join('; ')};
    }
    const nextRetryAt=Math.max(0,...days.map(d=>Number(this.index[d]?.nextRetryAt||0)));
    const refreshing=days.some(d=>this.running.has(d)),queued=days.some(d=>this.queue.has(d));
    const nextRefreshAt=Math.max(0,...days.map(d=>Number(this.index[d]?.updatedAt||0)+this.ttl(d)));
    return {date:day,...range,timeZone:timeZone||'Asia/Yerevan',timezoneOffsetMinutes:timeZone?MonitorTime.offset(range.from,timeZone):config.resultsTimezoneOffsetMinutes,
      status:refreshing?'loading':queued?'queued':ready?'ready':nextRetryAt>Date.now()?'retrying':'preparing',refreshing,queued,nextRefreshAt,refreshIntervalMs:Math.min(...days.map(d=>this.ttl(d))),complete:ready,count:events.length,events,providers,updatedAt,
      pendingFinals:events.reduce((n,e)=>n+e.sourceRefs.filter(r=>r.removedAt&&!r.resultVerified).length,0),
      cache:{hit:available.length>0,updatedAt,permanent:days.every(d=>this.ttl(d)===Infinity),stale:days.some(d=>!this.fresh(this.index[d],d)||this.needsFinalRefresh(d))},
      resultApi:{queriedAstekLeagues:providers.astek.queriedLeagues,parsedAstekGames:providers.astek.count,parsedFonbetGames:providers.fonbet.count,errors:Object.entries(providers).filter(([,v])=>v.error).map(([source,v])=>({source,error:v.error}))},nextRetryAt,retryAfterMs:ready?0:3000};
  }
  status(){
    const required=this.warmDates();
    const ready=required.filter(d=>this.index[d]?.complete).length;
    return {warmDays:config.resultsWarmDays,requiredDays:required.length,readyDays:ready,ready:ready===required.length,activeDays:[...this.running.keys()],queuedDays:this.queue.size,
      pendingFinals:Object.values(this.index).reduce((n,row)=>n+(row.pendingFinals?.length||0),0),astekEndpoints:Object.fromEntries(this.astekPreferences),
      cachedDays:Object.entries(this.index).filter(([,v])=>v.complete).map(([d])=>d).sort(),failedDays:Object.entries(this.index).filter(([,v])=>!v.complete).map(([date,v])=>({date,providers:v.providers,nextRetryAt:v.nextRetryAt,error:v.error})),
      displayTimeZone:'Asia/Yerevan',timezoneOffsetMinutes:config.resultsTimezoneOffsetMinutes,archiveDirectory:'results/days',schemaVersion:SCHEMA};
  }
}
