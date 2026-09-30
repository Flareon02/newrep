import { log } from "./logger.js";
import {scoreLog} from './score-log.js';
import {readJson} from './utils.js';
import {oddsAppend,oddsEntries,oddsStateLoad,oddsStateSave} from './sqlite-storage.js';

const safeId=s=>String(s||'').replace(/[^\w-]/g,'').slice(0,80);
const price=v=>Number.isFinite(Number(v))&&Number(v)>1?Math.round(Number(v)*10000)/10000:null;
const marketId=m=>[Number(m.period)||0,m.rawGroup||m.type||'',m.type||'',...(m.prices||[]).map(p=>[p.rawType||p.designation,p.points??''].join('@')).sort()].join('|');
const polishMarketText=/[ąćęłńóśźż]|\b(?:zwyci[eę]zca|suma|rund|rundy|mapa|powyżej|poniżej|dogrywk[aą]|włącznie)\b/i;

export function normalizeGgbetStoredMarket(market={}){
  // New entries carry the server canonical object. Never reinterpret them from
  // localized text. Legacy entries are kept on the conservative old fallback.
  if(market?.canonical?.title)return {...market,title:market.canonical.title};
  const raw=String(market.title||'').trim();let title=raw;const period=Number(market.period)||0;
  if(/zwyci[eę]zca/i.test(raw))title=period?`Карта ${period} — победитель`:'Победитель';
  else if(/handicap/i.test(raw)){if(/rund/i.test(raw))title='Фора по раундам';else if(/mapa|map/i.test(raw))title=period?`Карта ${period} — фора`:'Фора по картам';else title=period?`Карта ${period} — фора`:'Фора';}
  else if(/suma/i.test(raw)){const overtime=/włącznie\s+z\s+dogrywk/i.test(raw)?' (включая овертайм)':'';if(/rund/i.test(raw)){const n=raw.match(/(\d+)(?:st|nd|rd|th)?\s*mapa/i)?.[1]||period;title=n?`Карта ${Number(n)} — тотал раундов${overtime}`:`Тотал раундов${overtime}`;}else if(/map/i.test(raw))title=period?`Карта ${period} — тотал`:'Тотал карт';else title=period?`Карта ${period} — тотал`:'Тотал';}
  else if(polishMarketText.test(raw))title='Market';
  let prices=Array.isArray(market.prices)?market.prices:[];
  if(/^(?:Тотал|Карта \d+ — тотал)/i.test(title)&&prices.length===2&&prices.every(p=>p?.side==='home'||p?.side==='away'))prices=prices.map((p,i)=>({...p,side:i===0?'over':'under'}));
  return {...market,title,prices};
}

// 3.6.2 storage model:
// - legacy odds/<book>/<id>.json stays untouched/readable;
// - new changes append to odds-journal/<book>/<id>.ndjson;
// - only the current market fingerprint lives in odds-state/<book>/<id>.json.
// This prevents full-market GGBET sessions from retaining and re-stringifying
// an ever-growing entries[] array on every websocket push.
export class OddsLog{
  constructor(){this.cache=new Map();this.loading=new Map();this.pending=new Map();}
  legacyFile(source,id){return `odds/${safeId(source)}/${safeId(id)}.json`;}
  stateFile(source,id){return `odds-state/${safeId(source)}/${safeId(id)}.json`;}
  async state(source,id){
    const key=source+':'+id;if(this.cache.has(key))return this.cache.get(key);
    if(!this.loading.has(key))this.loading.set(key,Promise.resolve().then(()=>{
      const saved=oddsStateLoad(source,id);
      const value=saved&&typeof saved==='object'?saved:{last:{},team1:'',team2:'',scoreText:''};
      if(!value.last||typeof value.last!=='object')value.last={};
      this.cache.set(key,value);return value;
    }).finally(()=>this.loading.delete(key)));
    return this.loading.get(key);
  }
  async append(source,id,entry){oddsAppend(source,id,entry);}
  async legacy(source,id){return readJson(this.legacyFile(source,id),{entries:[],last:{}});}
  async *journal(source,id){for(const row of oddsEntries(source,id,{ascending:true}))yield row;}
  record(ref,odds=ref?.odds){
    const source=ref?.source,id=safeId(ref?.sourceEventId||ref?.id);
    if(!['astek','fonbet','pinnacle','ggbet'].includes(source)||!id||!odds||odds.stale||!Array.isArray(odds.markets)||!odds.markets.length)return Promise.resolve();
    const key=source+':'+id;
    const run=(this.pending.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const data=await this.state(source,id),next={...data.last},changes=[];
      for(const market of odds.markets){const code=marketId(market),prices=(market.prices||[]).map(p=>({side:p.designation||'',points:p.points??null,odds:market.status==='open'?price(p.decimal):null}));
        if(!prices.length)continue;const value=JSON.stringify([market.status||'open',prices]);
        if(next[code]===value&&data.team1===(odds.team1||ref.team1)&&data.team2===(odds.team2||ref.team2))continue;
        next[code]=value;changes.push({key:code,period:Number(market.period)||0,title:market.canonical?.title||market.title||market.type||'Рынок',rawTitle:market.rawTitle||'',rawType:Number(market.rawType)||0,type:market.canonical?.family||market.type||'',canonical:market.canonical||null,specifiers:market.specifiers||undefined,providerTabs:market.providerTabs||undefined,status:market.status||'open',prices});
      }
      if(!changes.length&&data.scoreText===(ref.scoreText||''))return;
      const floor=Number(data.lastAt||0)+1,at=Math.max(Number(odds.updatedAt||odds.checkedAt)||Date.now(),floor);
      const entry={at,changes,scoreText:ref.scoreText||'',seriesScore:ref.seriesScore,mapScores:ref.mapScores,team1:odds.team1||ref.team1,team2:odds.team2||ref.team2};
      await this.append(source,id,entry);
      const saved={last:next,lastAt:at,team1:entry.team1,team2:entry.team2,scoreText:entry.scoreText};
      oddsStateSave(source,id,saved);this.cache.set(key,saved);
      if(this.cache.size>60)this.cache.delete(this.cache.keys().next().value);
    });this.pending.set(key,run);run.finally(()=>{if(this.pending.get(key)===run)this.pending.delete(key);}).catch(error=>log.error('[odds-log]',error.message));return run;
  }
  async readAll(source,id){
    const legacy=await this.legacy(source,id),entries=oddsEntries(source,id,{ascending:true});
    return {entries,legacy};
  }
  async timeline(keys,at){
    const logs=await Promise.all(keys.map(async key=>{const sep=key.indexOf(':'),source=key.slice(0,sep),id=key.slice(sep+1),all=await this.readAll(source,id);return {key,source,id,...all};}));
    const times=[...new Set(logs.flatMap(log=>log.entries.map(e=>Number(e.at)).filter(Number.isFinite)))].sort((a,b)=>a-b);
    const target=Number.isFinite(at)?at:times.at(-1)||Date.now();
    const books=await Promise.all(logs.map(async ({key,source,id,entries,legacy})=>{
      const state=new Map();let last=null;
      for(const entry of entries){if(entry.at>target)break;last=entry;for(const m of entry.changes||[])state.set(m.key,{...m,at:entry.at,team1:entry.team1||legacy.team1,team2:entry.team2||legacy.team2});}
      const scores=await scoreLog.load(key),score=[...scores.entries].reverse().find(e=>e.at<=target);
      const markets=[...state.values()].map(m=>source==='ggbet'?normalizeGgbetStoredMarket(m):m);
      return {source,id,at:last?.at||null,team1:score?.team1||last?.team1||legacy.team1,team2:score?.team2||last?.team2||legacy.team2,scoreText:score?.scoreText||last?.scoreText||legacy.scoreText||'',scoreAt:score?.at||last?.at||null,markets};
    }));
    return {times,at:target,books};
  }
  async get(source,id,{before=Infinity,limit=100}={}){
    if(!['astek','fonbet','pinnacle','ggbet'].includes(source)||!safeId(id))throw Error('Неверный источник');
    const take=Math.min(300,Math.max(1,limit)),rows=oddsEntries(source,safeId(id),{before,limit:take+1,ascending:false}),hasMore=rows.length>take;
    let entries=rows.slice(0,take);
    if(source==='ggbet')entries=entries.map(e=>({...e,changes:(e.changes||[]).map(normalizeGgbetStoredMarket)}));
    return {source,id,entries,hasMore,nextBefore:hasMore?entries.at(-1)?.at||null:null};
  }}
export const oddsLog=new OddsLog();
