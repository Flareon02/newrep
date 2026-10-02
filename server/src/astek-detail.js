import {fetchJson,withAstekRequest} from './utils.js';
import {astekOdds} from './book-odds.js';
import {astekOrigins,ORIGIN_COOLDOWN_MS} from './astek-origins.js';

const cache=new Map();
const expandedCache=new Map();
const mapIds=new Map();
const number=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?String(v):'';
const url=(origin,id)=>`${origin}/service-api/LiveFeed/GetGameZip?id=${id}&lng=en_GB&isSubGames=true&GroupEvents=true&allEventsGroupSubGames=true&countevents=250&partner=75&grMode=4&country=15&fcountry=15&marketType=1&gr=34&isNewBuilder=true`;
// Mirror order for detail reads (see astek-origins.js). Before, every read started with the -0021 mirror, so while it
// was unreachable each detail cost a failed request (~0.8 s) before the working mirror answered.
export {ORIGIN_COOLDOWN_MS};
export const astekDetailOrigins=(now)=>astekOrigins.order(now);
export const astekDetailOriginStatus=(now)=>astekOrigins.status(now);
export const resetAstekDetailOrigins=()=>astekOrigins.reset();
async function read(id){
  let error;
  for(const origin of astekOrigins.order()){
    let response;
    try{response=await withAstekRequest('detail',(gateSignal)=>fetchJson(url(origin,id),`${origin}/live/esports`,{timeoutMs:6000,metricGroup:'astekLiveDetail',signal:gateSignal}));}
    catch(e){error=e;astekOrigins.fail(origin,e);continue;}
    astekOrigins.ok(origin);
    if(response.payload?.Value?.I)return response.payload.Value;
    error=Error('В подробном ответе нет матча');
  }
  throw error;
}
function mapId(raw,period){
  const child=(raw?.BIG||[]).find(x=>Number(x.P)===period&&number(x.I)&&number(x.I)!==number(raw.I));
  return number(child?.I);
}
function matchScore(raw,period,ref){
  const expected=ref.mapScores?.[period-1],received=raw?.SC?.PS?.find(x=>Number(x.Key)===period)?.Value;
  // Subgame replies may have a local score, or no score at all. Reject an
  // explicitly different state to avoid pricing a previous round as current.
  if(!expected||!received)return true;
  return Number(received.S1||0)===Number(expected[0])&&Number(received.S2||0)===Number(expected[1]);
}
export async function astekLiveDetail(ref){
  const id=number(ref?.sourceEventId||ref?.id),period=Number(ref?.activeMap)||Number(ref?.seriesScore?.[0]||0)+Number(ref?.seriesScore?.[1]||0)+1;
  if(!id||!Number.isInteger(period)||period<1||period>5)return null;
  const signature=JSON.stringify([id,period,ref.seriesScore,ref.mapScores?.[period-1]]),old=cache.get(id);
  if(old?.signature===signature&&(old.odds||Date.now()-old.at<12000))return old.promise||old.odds;
  const promise=(async()=>{
    const root=await read(id);
    if(number(root.I)!==id)throw Error('Не совпал ID игры в ответе');
    const childId=mapId(root,period)||mapIds.get(id)?.[period],child=childId?await read(childId):null;
    if(root.BIG){mapIds.set(id,Object.fromEntries(root.BIG.filter(x=>number(x.I)&&Number(x.P)>0).map(x=>[Number(x.P),number(x.I)])));while(mapIds.size>200)mapIds.delete(mapIds.keys().next().value);}
    if(!matchScore(child||root,period,ref))return null;
    const context={category:ref?.category||root.SSN||root.LE||root.L};const rootOdds=astekOdds(root,[],'live',context),childOdds=child?astekOdds(child,[],'live',context):null;
    const markets=[...(rootOdds?.markets||[]).filter(m=>Number(m.period)===0),...(childOdds?.markets||[]).filter(m=>Number(m.period)===period),...(rootOdds?.markets||[]).filter(m=>Number(m.period)===period&&!childOdds?.markets?.some(c=>c.key===m.key))];
    return markets.length?{team1:rootOdds?.team1||childOdds?.team1,team2:rootOdds?.team2||childOdds?.team2,updatedAt:Date.now(),checkedAt:Date.now(),markets}:null;
  })();
  cache.set(id,{signature,at:Date.now(),promise});
  try{const odds=await promise;cache.set(id,{signature,at:Date.now(),odds});return odds;}
  catch(e){cache.set(id,{signature,at:Date.now(),odds:null});throw e;}
  finally{while(cache.size>32)cache.delete(cache.keys().next().value);}
}

export async function astekAllMarkets(ref){
  const id=number(ref?.sourceEventId||ref?.id);if(!id)return null;
  const key=JSON.stringify([id,ref?.seriesScore,ref?.mapScores]);
  const old=expandedCache.get(id);
  if(old?.key===key&&Date.now()-old.at<15000)return old.promise||old.odds;
  const promise=(async()=>{
    const root=await read(id);
    if(number(root.I)!==id)throw Error('Не совпал ID игры в ответе');
    const childInfo=[...new Map((root.BIG||[]).filter(x=>Number(x.P)>0&&Number(x.P)<=5).map(x=>[number(x.I),Number(x.P)]).filter(([child])=>child&&child!==id)).entries()].slice(0,5);
    const children=await Promise.allSettled(childInfo.map(([child])=>read(child)));
    const markets=[...(astekOdds(root,[],'live')?.markets||[])];
    for(let index=0;index<children.length;index++){const child=children[index];if(child.status!=='fulfilled')continue;const period=childInfo[index][1];markets.push(...(astekOdds(child.value,[],'live',{category:root.SSN||root.LE})?.markets||[]).map(m=>({...m,period:m.period||period})));}
    const unique=new Map();
    for(const market of markets){const prices=market.prices.map(p=>[p.designation,p.points??'',p.rawType??'']).sort();unique.set([market.period,market.rawGroup,market.semanticGroup||'',market.type,JSON.stringify(prices)].join(':'),market);}
    if(!unique.size)return null;
    return {provider:'AstekBet',team1:root.O1E||root.O1,team2:root.O2E||root.O2,updatedAt:Date.now(),checkedAt:Date.now(),stale:false,incompleteMaps:children.filter(c=>c.status==='rejected').length,markets:[...unique.values()].sort((a,b)=>a.period-b.period||a.title.localeCompare(b.title,'ru'))};
  })();
  expandedCache.set(id,{key,at:Date.now(),promise});
  try{const odds=await promise;expandedCache.set(id,{key,at:Date.now(),odds});return odds;}
  catch(error){expandedCache.delete(id);throw error;}
  finally{while(expandedCache.size>12)expandedCache.delete(expandedCache.keys().next().value);}
}
