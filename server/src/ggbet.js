import fs from 'node:fs';
import https from 'node:https';
import GameCategories from './game-categories.cjs';
import { canonicalCategory, englishize, eventKind } from './entity-resolver.js';
import { config } from './config.js';
import { canonicalizeGgbetMarket } from './market-semantics.js';
import { proxyAgent, proxyDiagnostics, proxyFetch, redact, reportProxySession, netnsAgent, resetNetnsAgent } from './egress.js';

const SNAPSHOT_HASH='44839cf86de25b2875162086620dc57b7bfbb2453b09e6b065f54620c343e40c';
const UPDATE_HASH='d47e6f564612369a803694590f09f1b88cfd5e0c270664e4599b330794de77dd';
const MARKETS_TABS_HASH='04ade0f69bd806382c2abb909f935c1ef69962c8295fb8084e737dae8f529353';
const MARKETS_TAB_HASH='c832d7cf75eeab4ff086ce452afa3a02c8d86a4cce3e0970724f30857b37891a';
const UPDATE_TAB_HASH='eb7b979e4b6fbaf87be18efcce15047677fbe856c5cc602fd9768be6dc77d228';
const MARKET_STATUSES=['ACTIVE','SUSPENDED'];
// GGBET runs on the DATA.BET sportsbook platform. The pure schema/market helpers below are
// exported so the DataBet collector (databet.js) normalizes the same platform data identically.
export const MATCH_STATUSES=['LIVE','SUSPENDED'];
export const LIVE_SPORTS=Object.freeze([
  'esports_counter_strike','esports_dota_2','esports_league_of_legends','esports_valorant',
  'esports_rainbow_six','esports_overwatch','esports_mobile_legends_bang_bang','esports_rocket_league',
  'esports_starcraft','esports_starcraft_1','esports_warcraft_3','esports_call_of_duty','esports_call_of_duty_mobile',
  'esports_call_of_duty_warzone','esports_pubg','esports_battlegrounds','esports_crossfire','esports_quake',
  'esports_age_of_empires','esports_world_of_warcraft','esports_hearthstone','esports_halo','esports_smite',
  'esports_king_of_glory','esports_brawl_stars','esports_clash_royale','esports_free_fire','esports_apex_legends',
  'esports_teamfight_tactics','esports_league_of_legends_wild_rift','esports_deadlock','esports_the_finals'
]);

// Plain-query fallbacks used if GGBET rotates persisted-query hashes.
const MARKETS_TABS_QUERY=`query GetMarketsTabs($sportEvent:String!,$marketStatuses:[MarketStatus!]){compiledMarketsTabs(sportEvent:$sportEvent,marketStatuses:$marketStatuses){tabs{name id}}}`;
const MARKETS_TAB_QUERY=`query GetMarketsTab($sportEventID:String!,$marketTabID:String!,$marketStatuses:[MarketStatus!]){compiledMarketsTab(sportEventID:$sportEventID,marketTabID:$marketTabID,marketStatuses:$marketStatuses){sportEvent{id} marketIds}}`;
const UPDATE_TAB_QUERY=`subscription OnUpdateTab($sportEventId:String!,$marketTabId:String!,$marketStatuses:[MarketStatus!]){onUpdateTab(sportEventId:$sportEventId,marketTabId:$marketTabId,marketStatuses:$marketStatuses){sportEvent{id} marketIds}}`;

// Snapshot intentionally stays lightweight: full event markets are discovered
// through GGBET's "All" compiled market tab and then streamed via OnUpdateSportEvent.
const SNAPSHOT_QUERY=`query GetSportEventListByFilters($offset:Int!,$limit:Int!,$matchStatuses:[SportEventStatus!],$sportIds:[String!],$marketStatusesForSportEvent:[MarketStatus!],$marketStatuses:[MarketStatus!],$marketLimit:Int=3,$isTopMarkets:Boolean=true,$sportEventTypes:[SportEventType!],$order:SportEventOrder,$favorite:Boolean=false){matches:sportEventListByFilters(offset:$offset,limit:$limit,matchStatuses:$matchStatuses,sportIds:$sportIds,marketStatuses:$marketStatusesForSportEvent,sportEventTypes:$sportEventTypes,order:$order,favorite:$favorite){count sportEvents{id disabled providerId slug betStop version meta{name value} fixture{score title status type startTime sportId sport{id name tags slug} tournament{id name slug sportId countryCode} competitors{id name type homeAway logo score{id type points number}}} markets(top:$isTopMarkets,limit:$marketLimit,statuses:$marketStatuses){id name status typeId priority tags specifiers{name value} meta{name value} odds{id name value isActive status competitorIds}}}}}`;

const jitter=(ms)=>Math.max(250,Math.round(ms*(0.85+Math.random()*0.3)));
// A session that lived at least this long counts as healthy: its auth/refresh close may reconnect at once. Shorter
// sessions in a row (token rejected, closed right after the ack...) back off exponentially instead of looping.
export const MIN_HEALTHY_SESSION_MS=60000;
// Bootstrap statuses that are not specific to one mirror (proxy auth, anti-bot/forbidden, rate limit): trying the
// next mirror at once would only multiply requests; the next attempt (after back-off) starts with the next mirror.
const ORIGIN_WIDE_STATUSES=new Set([403,407,429]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const text=v=>String(v??'').trim();
const finite=v=>{if(v==null||String(v).trim()==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const safeUuid=id=>text(id).replace(/^\d+:/,'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,100);
export const absoluteAsset=value=>{const v=text(value);if(!v)return'';if(/^https:\/\//i.test(v))return v;if(/^\/\//.test(v))return'https:'+v;if(/^cdn\.gin\.bet\//i.test(v))return'https://'+v;return'';};
const spec=(market,name)=>text((market?.specifiers||[]).find(x=>text(x?.name)===name)?.value);
const meta=(row,name)=>text((row?.meta||[]).find(x=>text(x?.name)===name)?.value);
const isAuthError=value=>/auth|token|unauthor|forbidden|permission|401|403/i.test(text(value));
const isPersistedError=value=>/persistedquery|persisted query|not found/i.test(text(value));

export function scoreParts(fixture={}){
  const competitors=Array.isArray(fixture.competitors)?fixture.competitors:[];
  const home=competitors.find(c=>c?.homeAway==='HOME')||competitors[0]||{},away=competitors.find(c=>c?.homeAway==='AWAY')||competitors[1]||{};
  const points=(c,type,number)=>finite((c?.score||[]).find(s=>s?.type===type&&(number==null||Number(s?.number)===number))?.points);
  let series=[points(home,'total'),points(away,'total')];
  if(series.some(v=>v==null)){
    const m=text(fixture.score).match(/(\d+)\s*:\s*(\d+)/);series=m?[Number(m[1]),Number(m[2])]:null;
  } else series=series.map(v=>v??0);
  const mapNumbers=[...new Set(competitors.flatMap(c=>(c?.score||[]).filter(s=>s?.type==='map'&&Number(s?.number)>0).map(s=>Number(s.number))))].sort((a,b)=>a-b);
  const mapScores=mapNumbers.map(n=>[points(home,'map',n)??0,points(away,'map',n)??0]);
  const activeMap=mapNumbers.length?mapNumbers.at(-1):0;
  const scoreText=series?`${series[0]}:${series[1]}${mapScores.length?` (${mapScores.map(x=>x.join(':')).join(', ')})`:''}`:text(fixture.score);
  return {home,away,seriesScore:series,mapScores,activeMap,scoreText,scoreObserved:!!(series||mapScores.length||text(fixture.score))};
}

export function marketPeriod(market={}){
  const p=finite(spec(market,'mapnr'));if(p!=null&&p>=1&&p<=20)return p;
  const name=text(market.name);
  let m=name.match(/(?:карта|map|mapa)\s*(\d+)/i);
  if(!m)m=name.match(/(\d+)(?:st|nd|rd|th)?\s*(?:карта|map|mapa)\b/i);
  return m?Number(m[1]):0;
}
export function marketType(market={}){
  const name=text(market.name),tags=(market.tags||[]).map(x=>text(x).toLowerCase()),period=marketPeriod(market),rawType=Number(market?.typeId)||0;
  // Keep semantic families before generic hcp/total detection. GGBET reuses
  // the same specifier tags for very different markets, so raw title/typeId is
  // part of the identity rather than decoration.
  if(/half.*correct score|половин.*точн.*сч[её]т/i.test(name)||rawType===790)return'half-exact-score';
  if(/correct (?:map )?score|точн.*сч[её]т/i.test(name)||[349,1519].includes(rawType))return'exact-score';
  if(/pistol round winner|пистолетн.*раунд/i.test(name)||rawType===293)return'pistol-round-winner';
  if(/round winner|победител.*раунд/i.test(name)||rawType===13)return'round-winner';
  if(/winning margin|разниц.*побед/i.test(name)||rawType===1592)return'winning-margin';
  if(/half.*1x2|половин.*1x2/i.test(name)||rawType===789)return'half-winner';
  if(/will there be overtime|будет.*овертайм/i.test(name)||rawType===11)return'overtime';
  if(/odd\s*\/\s*even rounds?|odd.*even.*round|ч[её]т.*неч[её]т.*раунд/i.test(name)||rawType===4)return'round-parity';
  if(/odd\s*\/\s*even maps?|odd.*even.*map|ч[её]т.*неч[её]т.*карт/i.test(name)||rawType===292)return'map-parity';
  if(/total over\s*\+\s*win|тотал.*больше.*побед/i.test(name)||rawType===1593)return'winner-total-over';
  if(/total under\s*\+\s*win|тотал.*меньше.*побед/i.test(name)||[1270,1594].includes(rawType))return'winner-total-under';
  if(/asian round handicap|азиат.*фор.*раунд/i.test(name)||rawType===1590)return'asian-round-handicap';
  if(/half.*round handicap|половин.*фор.*раунд/i.test(name)||rawType===786)return'half-round-handicap';
  if(/round handicap|фор.*раунд/i.test(name)||[10,103,299,1591].includes(rawType))return'round-handicap';
  if(/asian total rounds?|азиат.*тотал.*раунд/i.test(name)||rawType===927)return'asian-round-total';
  if(/total rounds.*3\s*way|тотал.*раунд.*3/i.test(name)||rawType===929)return'round-total-3way';
  if(/total rounds/i.test(name)&&([407,408,787,788,1564,1565].includes(rawType)||/\$?\{?competitor|team /i.test(name)))return'team-round-total';
  if(rawType===1||rawType===7||/победитель|winner|zwyci[eę]zca/i.test(name)&&!/(раунд|round|rund)/i.test(name))return'moneyline';
  if([20,21].includes(rawType)||/1x2/i.test(name))return'moneyline';
  if(tags.includes('hcp')||/фора|handicap/i.test(name))return /по картам|maps?|mapa/i.test(name)&&!period?'map-handicap':'spread';
  if(tags.includes('total')||/тотал|total|suma/i.test(name))return /карт|maps?|mapa/i.test(name)&&!period&&!/rund/i.test(name)?'map-total':'total';
  return'other';
}

const POLISH_TEXT=/[ąćęłńóśźż]|\b(?:zwyci[eę]zca|suma|rund|rundy|mapa|powyżej|poniżej|remis|dogrywk[aą]|włącznie|tak|nie)\b/i;
const overtimeSuffix=raw=>/overtimes?\s+not\s+include|nie\s+obejmuj\w*\s+dogrywk|bez\s+dogrywk|без учета овертайм|без учёта овертайм/i.test(raw)?' (без овертайма)':/incl\.?\s*overtime|including overtime|włącznie\s+z\s+dogrywk|включ.*овертайм/i.test(raw)?' (с овертаймом)':'';
export function localizedMarketTitle(market={},type='other',period=0){
  const raw=text(market?.name),rawType=Number(market?.typeId)||0,mapPrefix=period?`Карта ${period} — `:'',half=Number(spec(market,'halfnr'))||Number(raw.match(/(?:half|половин)\s*(\d+)/i)?.[1])||0,round=Number(spec(market,'roundnr'))||0,ot=overtimeSuffix(raw);
  if(!raw)return type==='other'?`Рынок ${rawType||''}`.trim():({moneyline:'Победитель','map-handicap':'Фора по картам',spread:'Фора','map-total':'Тотал карт',total:'Тотал'}[type]||'Рынок');
  if(type==='half-exact-score')return `${mapPrefix}${half?`половина ${half} — `:'половина — '}точный счёт`;
  if(type==='pistol-round-winner')return `${mapPrefix}пистолетный раунд${round?` ${round}`:''} — победитель`;
  if(type==='round-winner')return `${mapPrefix}раунд${round?` ${round}`:''} — победитель`;
  if(type==='winning-margin')return `${mapPrefix}разница победы${ot}`;
  if(type==='half-winner')return `${mapPrefix}${half?`половина ${half} — `:'половина — '}исход 1X2`;
  if(type==='overtime')return `${mapPrefix}будет овертайм`;
  if(type==='round-parity')return `${mapPrefix}чёт / нечёт раундов`;
  if(type==='map-parity')return 'Чёт / нечёт карт';
  if(type==='winner-total-over')return `${mapPrefix}победитель + тотал больше${ot}`;
  if(type==='winner-total-under')return `${mapPrefix}победитель + тотал меньше${ot}`;
  if(type==='asian-round-handicap')return `${mapPrefix}азиатская фора по раундам${ot}`;
  if(type==='half-round-handicap')return `${mapPrefix}${half?`половина ${half} — `:'половина — '}фора по раундам`;
  if(type==='round-handicap')return `${mapPrefix}фора по раундам${/3\s*way/i.test(raw)?' (3 исхода)':''}${ot}`;
  if(type==='asian-round-total')return `${mapPrefix}азиатский тотал раундов`;
  if(type==='round-total-3way')return `${mapPrefix}тотал раундов (3 исхода)`;
  if(type==='team-round-total'){
    const stripped=raw.replace(/^.*?Map\s*\d+\s*-\s*/i,'').replace(/\s+total rounds.*$/i,'').trim();
    return `${mapPrefix}тотал раундов${stripped?` — ${stripped}`:''}${ot}`;
  }
  if(type==='exact-score')return period?`${mapPrefix}точный счёт`:/(?:map|карт)/i.test(raw)?'Точный счёт по картам':'Точный счёт';
  if(/1x2/i.test(raw))return `${mapPrefix}исход 1X2${ot}`;
  if(/winner|zwyci[eę]zca|победител/i.test(raw))return period?`${mapPrefix}победитель${ot}`:'Победитель';
  if(/handicap/i.test(raw)){
    if(/rund/i.test(raw))return`${mapPrefix}фора по раундам${ot}`;
    if(/mapa|map/i.test(raw))return period?`${mapPrefix}фора`:'Фора по картам';
    return period?`${mapPrefix}фора`:'Фора';
  }
  if(/suma/i.test(raw)){
    const overtime=/włącznie\s+z\s+dogrywk/i.test(raw)?' (с овертаймом)':'';
    if(/rund/i.test(raw))return period?`${mapPrefix}тотал раундов${overtime}`:`Тотал раундов${overtime}`;
    if(/map/i.test(raw))return period?`${mapPrefix}тотал`:'Тотал карт';
    return period?`${mapPrefix}тотал`:'Тотал';
  }
  if(!POLISH_TEXT.test(raw))return raw;
  if(type==='moneyline')return period?`${mapPrefix}победитель`:'Победитель';
  if(type==='map-handicap')return'Фора по картам';
  if(type==='spread')return period?`${mapPrefix}фора`:'Фора';
  if(type==='map-total')return'Тотал карт';
  if(type==='total')return period?`${mapPrefix}тотал`:'Тотал';
  return `Market ${rawType||text(market?.id)||''}`.trim();
}
export function outcomeDesignation(name='',current=''){
  const value=text(name);
  // Total markets often carry the team competitor id on both Over and Under
  // outcomes. Explicit outcome text is therefore stronger than competitorIds.
  if(/^(?:больше|over|powyżej)\b/i.test(value))return'over';
  if(/^(?:меньше|under|poniżej)\b/i.test(value))return'under';
  if(/^(?:ничья|draw|remis)\b/i.test(value))return'draw';
  if(/^(?:да|yes|tak)\b/i.test(value))return'yes';
  if(/^(?:нет|no|nie)\b/i.test(value))return'no';
  if(/^(?:odd|неч[её]т|nieparzyste)\b/i.test(value))return'odd';
  if(/^(?:even|ч[её]т|parzyste)\b/i.test(value))return'even';
  if(current)return current;
  return'';
}
export function localizedOutcomeLabel(name='',designation='',points){
  const raw=text(name),num=raw.match(/([+-]?\d+(?:[.,]\d+)?)\s*$/)?.[1]?.replace(',','.');
  const value=num??(Number.isFinite(Number(points))?String(Number(points)):'');
  if(designation==='over')return `Больше${value?` ${value}`:''}`;
  if(designation==='under')return `Меньше${value?` ${value}`:''}`;
  if(designation==='draw')return'Ничья';
  if(designation==='yes')return'Да';
  if(designation==='no')return'Нет';
  if(designation==='even')return'Чёт';
  if(designation==='odd')return'Нечёт';
  if(/^(?:parzyste|even)\b/i.test(raw))return'Чёт';
  if(/^(?:nieparzyste|odd)\b/i.test(raw))return'Нечёт';
  if(POLISH_TEXT.test(raw)&&!raw.match(/[A-Z0-9_.-]{2,}/))return designation||'Outcome';
  return raw||designation;
}
export function pricePoint(odd,market){
  // GGBET handicap specifiers describe the market line, while the individual
  // outcome names carry the signed side (+/-). Parse the outcome first so the
  // away side never inherits the home handicap by mistake. Totals can safely
  // share the market-level number.
  const paren=text(odd?.name).match(/\(([+-]?\d+(?:[.,]\d+)?)\)\s*$/);if(paren)return Number(paren[1].replace(',','.'));
  const overUnder=text(odd?.name).match(/^(?:over|under|больше|меньше|powyżej|poniżej)\s+([+-]?\d+(?:[.,]\d+)?)\s*$/i);if(overUnder)return Number(overUnder[1].replace(',','.'));
  const h=finite(spec(market,'hcp')),t=finite(spec(market,'total'));return h??t??undefined;
}
function ggbetOdds(raw,home,away,at,providerTabs=null){
  const homeId=text(home?.id),awayId=text(away?.id),markets=[];
  for(const m of Array.isArray(raw?.markets)?raw.markets:[]){
    const status=text(m?.status).toUpperCase()==='ACTIVE'&&!raw?.betStop?'open':'suspended',type=marketType(m),period=marketPeriod(m),title=localizedMarketTitle(m,type,period);
    const prices=(m?.odds||[]).map((o,index)=>{
      const ids=(o?.competitorIds||[]).map(String);let designation=ids.includes(homeId)?'home':ids.includes(awayId)?'away':'';const name=text(o?.name),points=pricePoint(o,m);
      designation=outcomeDesignation(name,designation);
      if(!designation&&(m?.odds||[]).length===2){
        if(['total','map-total','team-round-total','asian-round-total'].includes(type))designation=index===0?'over':'under';
        else designation=index===0?'home':'away';
      }
      const decimal=finite(o?.value),open=status==='open'&&o?.isActive!==false&&text(o?.status||'NOT_RESULTED')==='NOT_RESULTED'&&decimal>1;
      return {designation:designation||`outcome-${o?.id||index+1}`,label:localizedOutcomeLabel(name,designation,points),rawLabel:name,points,decimal:open?decimal:null,rawType:Number(m?.typeId)||0};
    });
    const row={key:`ggbet:${text(m?.id)||Number(m?.typeId)||markets.length}`,type,title,rawTitle:text(m?.name),period,status,prices,rawType:Number(m?.typeId)||0,tags:[...(m?.tags||[])].map(text),specifiers:Object.fromEntries((m?.specifiers||[]).map(x=>[text(x?.name),text(x?.value)]).filter(([k])=>k)),upstreamProvider:meta(m,'provider_source')};
    row.providerTabs=[...(providerTabs?.marketToTabs?.get(text(m?.id))||['all'])];
    row.canonical=canonicalizeGgbetMarket(row,{team1:text(home?.name),team2:text(away?.name)});
    // From 4.3.0 onward the server is the semantic authority. Keep rawTitle and
    // rawType for audit, but expose the exact canonical family/title so clients
    // never have to guess from localized GGBET text or outcome shape.
    row.title=row.canonical.title;
    markets.push(row);
  }
  return markets.length?{provider:'GGBET',team1:text(home?.name),team2:text(away?.name),mode:'live',updatedAt:at,checkedAt:at,stale:false,transport:'graphql-ws',providerTabs:(providerTabs?.catalog||[]).map(t=>({id:t.id,name:t.name,count:Number(t.count)||0})),markets}:null;
}

export function parseGgbetLiveEvent(raw,{origin='https://gg.bet',at=Date.now(),providerTabs=null}={}){
  if(!raw?.id||!raw?.fixture)return null;const fixture=raw.fixture,status=text(fixture.status).toUpperCase();if(!MATCH_STATUSES.includes(status)||raw.disabled===true)return null;
  const sport=fixture.sport||{},tags=(sport.tags||[]).map(x=>text(x).toUpperCase());if(tags.includes('PLASTIC'))return null;
  const score=scoreParts(fixture),team1=englishize(score.home?.name),team2=englishize(score.away?.name);if(!team1||!team2)return null;
  const sportId=text(fixture.sportId||sport.id),league=englishize(fixture.tournament?.name)||'Unknown league',category=canonicalCategory(GameCategories.resolve(englishize(sport.name)||sportId,league));
  const upstreamEventId=text(raw.id),sourceEventId=safeUuid(upstreamEventId);if(!sourceEventId)return null;
  const bestOf=Math.max(0,Number(meta(raw,'bo'))||0),base=String(origin||'https://gg.bet').replace(/\/+$/,'');
  return {id:`ggbet-${sourceEventId}`,sourceEventId,upstreamEventId,source:'ggbet',provider:'GGBET',category,categoryKey:`ggbet:sport:${sportId||category.toLowerCase()}`,subSportId:sportId,league,leagueId:text(fixture.tournament?.id),leagueKey:`ggbet:id:${text(fixture.tournament?.id)||league.toLowerCase()}`,team1,team2,team1Logo:absoluteAsset(score.home?.logo),team2Logo:absoluteAsset(score.away?.logo),sportName:englishize(sport.name)||category,marketKind:eventKind({league,team1,team2}),startAt:Date.parse(fixture.startTime)||Date.now(),updatedAt:at,bestOf,bestOfSource:bestOf?'ggbet:meta.bo':'unknown',bestOfEvidence:bestOf?String(bestOf):'',seriesScore:score.seriesScore,mapScores:score.mapScores,activeMap:score.activeMap,scoreText:score.scoreText,scoreObserved:score.scoreObserved,odds:ggbetOdds(raw,score.home,score.away,at,providerTabs),url:raw.slug?`${base}/ru/esports/match/${encodeURIComponent(raw.slug)}`:`${base}/ru/live`};
}

function mergeCompetitors(oldRows=[],nextRows=[]){const old=new Map(oldRows.map(r=>[text(r?.id),r]));return nextRows.map(r=>({...old.get(text(r?.id)),...r})).concat(oldRows.filter(r=>!nextRows.some(n=>text(n?.id)===text(r?.id))));}
const mergeMarketsById=(base=[],fresh=[])=>{const next=new Map((fresh||[]).map(m=>[text(m?.id),m]));return (base||[]).map(m=>next.get(text(m?.id))||m);};
export function mergeGgbetEvent(previous={},patch={}){
  const pf=previous.fixture||{},nf=patch.fixture||{};return {...previous,...patch,meta:patch.meta||previous.meta,markets:patch.markets||previous.markets,fixture:{...pf,...nf,sport:nf.sport||pf.sport,tournament:nf.tournament||pf.tournament,competitors:nf.competitors?mergeCompetitors(pf.competitors||[],nf.competitors):pf.competitors}};
}

function normalizeWsUrl(endpoint){
  const raw=text(endpoint);const normalized=raw.startsWith('//')?'wss:'+raw:raw.replace(/^https:/,'wss:').replace(/^http:/,'ws:');
  const wsUrl=normalized?`${normalized.replace(/\/+$/,'').replace(/\/graphql$/,'')}/graphql`:'';
  if(!/^wss:\/\/([a-z0-9-]+\.)*gg\.bet(?::443)?\/graphql$/i.test(wsUrl))throw Error('GGBET: неожиданный betting endpoint');
  return wsUrl;
}
// Origins the bootstrap may use, exact (scheme + host): the public LIVE page that issues the guest token. A configured
// origin outside this list is ignored (and reported), and a redirect may only lead to one of these hosts. The mirrors of
// the old default list (gg397.bet, gg253.bet, gg284.bet, ggbets.co, ggbet242.com, ggbet24.com) never passed the
// origin check (it only accepted *.gg.bet): each was fetched and then rejected, so they were removed.
export const GGBET_TRUSTED_ORIGINS=Object.freeze(['https://gg.bet']);
const extractionError=(message,reason)=>Object.assign(Error(message),{tokenExtraction:reason});
function bootstrapResult({token,endpoint,wsUrl,scoreboardEndpoint='',origin='https://gg.bet',at=Date.now(),source='direct'}={},trusted=GGBET_TRUSTED_ORIGINS){
  if(!token||String(token).length<100)throw extractionError('GGBET: guest token не найден',token?'token-short':'token-missing');
  const normalizedOrigin=(text(origin)||'https://gg.bet').replace(/\/+$/,'').toLowerCase();if(!trusted.includes(normalizedOrigin))throw extractionError(`GGBET: неожиданный origin (${normalizedOrigin.slice(0,80)})`,'origin-untrusted');
  let ws;try{ws=normalizeWsUrl(wsUrl||endpoint);}catch(e){throw extractionError(e.message,'endpoint-invalid');}
  return {token:String(token),wsUrl:ws,scoreboardEndpoint:text(scoreboardEndpoint),origin:normalizedOrigin,at:Number(at)||Date.now(),expiresAt:ggbetTokenExpiry(token),source};
}
// Expiry the guest token itself declares, if any: `exp` in the public JWE/JWT protected header, or in the payload of a
// plain (3-part, unencrypted) JWT. Nothing else of the token is read, logged or exposed. 0 = none declared.
export function ggbetTokenExpiry(token){
  const parts=String(token||'').split('.'),json=part=>{try{return JSON.parse(Buffer.from(part,'base64url').toString('utf8'));}catch{return null;}};
  const exp=Number(json(parts[0])?.exp??(parts.length===3?json(parts[1])?.exp:undefined));
  return Number.isFinite(exp)&&exp>1e9?(exp<1e12?exp*1000:exp):0;
}
function bootstrapFromHtml(html,origin,trusted=GGBET_TRUSTED_ORIGINS){
  const marker='"bettingClientOptions"',i=html.indexOf(marker);if(i<0)throw extractionError('GGBET: bettingClientOptions не найден','marker-missing');const block=html.slice(i,i+12000);
  const token=block.match(/"token"\s*:\s*"([^"]+)"/)?.[1],endpoint=block.match(/"endpoint"\s*:\s*"([^"]+)"/)?.[1],scoreboardEndpoint=block.match(/"scoreboardEndpoint"\s*:\s*"([^"]+)"/)?.[1];
  return bootstrapResult({token,endpoint,scoreboardEndpoint,origin,source:'html'},trusted);
}
// Bootstrap diagnostics read headers only: never a cookie name or value, never the body beyond its kind and size.
const headerOf=(res,name)=>{const h=res?.headers;if(!h)return '';if(typeof h.get==='function')return text(h.get(name));const v=h[name];return Array.isArray(v)?v.join(', '):text(v);};
const setCookiesOf=res=>{const h=res?.headers;if(!h)return [];if(typeof h.getSetCookie==='function')return h.getSetCookie();if(typeof h.get==='function'){const v=h.get('set-cookie');return v?[v]:[];}const v=h['set-cookie'];return Array.isArray(v)?v:v?[String(v)]:[];};
// Would a browser send this Set-Cookie to `toHost` on the next request? Only its Domain attribute is read.
const cookieReaches=(setCookie,fromHost,toHost)=>{const domain=String(setCookie).split(';').slice(1).map(x=>x.trim().split('=')).find(([k])=>k.toLowerCase()==='domain')?.[1]?.trim().toLowerCase().replace(/^\./,'');return domain?(toHost===domain||toHost.endsWith('.'+domain)):toHost===fromHost;};
const bodyKind=(body,contentType)=>{const t=String(body||'').trim();if(!t)return 'empty';if(/json/i.test(contentType)||/^[[{]/.test(t))return 'json';if(/html/i.test(contentType)||/^<(!doctype|html)/i.test(t)||/<html[\s>]/i.test(t.slice(0,4000)))return 'html';return 'other';};
const REDIRECT_STATUSES=new Set([301,302,303,307,308]);
function relayJson(url,{secret,ca,force=false,timeoutMs=12000,maxBytes=128*1024}={}){
  return new Promise((resolve,reject)=>{let parsed;try{parsed=new URL(url);}catch{return reject(Error('GGBET relay URL invalid'));}if(parsed.protocol!=='https:')return reject(Error('GGBET relay requires HTTPS'));
    const req=https.request(parsed,{method:'GET',headers:{Authorization:`Bearer ${secret}`,'X-Relay-Force':force?'1':'0',Accept:'application/json','User-Agent':'astek-monitor/3.5.3'},ca,rejectUnauthorized:true,timeout:timeoutMs},res=>{
      const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){req.destroy(Error('GGBET relay response too large'));return;}chunks.push(chunk);});res.on('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');let data;try{data=JSON.parse(raw||'{}');}catch{return reject(Error(`GGBET relay invalid JSON (HTTP ${res.statusCode||0})`));}if((res.statusCode||0)<200||(res.statusCode||0)>=300)return reject(Error(`GGBET relay HTTP ${res.statusCode||0}: ${text(data?.error).slice(0,200)}`));resolve(data);});
    });req.on('timeout',()=>req.destroy(Error('GGBET relay timeout')));req.on('error',reject);req.end();
  });
}

export class GgbetLiveCollector {
  constructor(state,{fetchImpl=globalThis.fetch,WebSocketImpl=null,now=()=>Date.now(),relayRequestImpl=null,trustedOrigins=GGBET_TRUSTED_ORIGINS,observer=null}={}){
    // observer (ggbet-supervisor.js): forensic/session hooks only; it never steers the collector except for the clean
    // session after an operator-selected egress change (resetForEgressChange). Its errors never reach the collector.
    this.observer=observer;
    this.trusted=[...trustedOrigins].map(o=>String(o).replace(/\/+$/,'').toLowerCase());this.bootstrapLog=[];
    this.state=state;this.fetch=fetchImpl;this.WebSocket=WebSocketImpl;this.WebSocketPromise=null;this.now=now;this.ws=null;this.stopped=true;this.connecting=null;this.bootstrap=null;this.originIndex=0;this.failures=0;this.reconnects=0;this.snapshots=0;this.pushes=0;this.snapshotSeq=0;this.subSeq=1000;this.catalogSeq=0;this.events=new Map();this.subscriptions=new Map();this.marketTabs=new Map();this.requests=new Map();this.lastMessageAt=0;this.lastConnectAt=0;this.lastAckAt=0;this.lastSnapshotAt=0;this.lastPushAt=0;this.lastError='';this.lastClose='';this.degradedPolling=false;this.catalogPushFallback=false;this.bootstrapFetches=0;this.bootstrapFailures=0;this.authRefreshes=0;this.scheduledRefreshes=0;this.plainSnapshots=0;this.pushFallbacks=0;this.marketCatalogFetches=0;this.marketCatalogFailures=0;this.marketCatalogUpdates=0;this.fullMarketSubscriptions=0;this.relayFetches=0;this.relayFailures=0;this.lastRelayAt=0;this.lastRelayError='';this.relayRequestImpl=relayRequestImpl;this.metadataPublishTimer=null;this.shortSessions=0;
    // Full market trees are leased by clients (an open detail panel): lease id -> {eventId, until}; events with a
    // lease get the full subscription, every other LIVE event only a light one (its top markets from the snapshot).
    this.leases=new Map();this.fullEvents=new Set();this.lightIds=new Map();this.fullCache=new Map();this.fullStale=new Map();this.fullResyncs=0;
    this.fullSubscribes=0;this.fullUnsubscribes=0;this.leaseExpirations=0;this.fullCapRejects=0;this.wsConnectionsCreated=0;this.expiryRefreshes=0;
  }
  status(){const mode=this.networkMode(),proxy=mode==='proxy'?proxyDiagnostics():null;return {enabled:config.ggbetLiveEnabled,transport:'graphql-ws',networkMode:mode,bootstrapMode:mode,...(proxy?{proxyEnabled:proxy.proxyEnabled,proxyHost:proxy.proxyHost,proxyPort:proxy.proxyPort}:{}),relayConfigured:!!config.ggbetBootstrapRelayUrl,relayInUse:mode==='relay',freshnessMs:this.lastMessageAt?Math.max(0,this.now()-this.lastMessageAt):null,connected:this.ws?.readyState===1,acknowledged:!!this.lastAckAt&&this.ws?.readyState===1,origin:this.bootstrap?.origin||'',endpoint:this.bootstrap?.wsUrl?.replace(/\/graphql$/,'')||'',tokenRefreshedAt:this.bootstrap?.at?new Date(this.bootstrap.at).toISOString():null,sessionStartedAt:this.lastConnectAt?new Date(this.lastConnectAt).toISOString():null,lastMessageAt:this.lastMessageAt?new Date(this.lastMessageAt).toISOString():null,lastSnapshotAt:this.lastSnapshotAt?new Date(this.lastSnapshotAt).toISOString():null,lastPushAt:this.lastPushAt?new Date(this.lastPushAt).toISOString():null,reconnects:this.reconnects,failures:this.failures,shortSessions:this.shortSessions,snapshots:this.snapshots,pushes:this.pushes,subscriptions:this.subscriptions.size,marketCatalogSubscriptions:[...this.marketTabs.values()].filter(x=>x.updateId).length,fullMarketEvents:[...this.marketTabs.values()].filter(x=>x.marketIds?.length).length,fullMarketIds:[...this.marketTabs.values()].reduce((n,x)=>n+(x.marketIds?.length||0),0),marketCatalogFetches:this.marketCatalogFetches,marketCatalogFailures:this.marketCatalogFailures,marketCatalogUpdates:this.marketCatalogUpdates,fullMarketSubscriptions:this.fullMarketSubscriptions,catalogPushFallback:this.catalogPushFallback,degradedPolling:this.degradedPolling,lastError:redact(this.lastError),lastClose:redact(this.lastClose),snapshotIntervalMs:this.degradedPolling?config.ggbetDegradedSnapshotMs:config.ggbetSnapshotIntervalMs,sessionRefreshMs:config.ggbetSessionRefreshMs,bootstrapFetches:this.bootstrapFetches,bootstrapFailures:this.bootstrapFailures,relayFetches:this.relayFetches,relayFailures:this.relayFailures,lastRelayAt:this.lastRelayAt?new Date(this.lastRelayAt).toISOString():null,lastRelayError:redact(this.lastRelayError),authRefreshes:this.authRefreshes,scheduledRefreshes:this.scheduledRefreshes,expiryRefreshes:this.expiryRefreshes,tokenExpiresAt:this.bootstrap?.expiresAt?new Date(this.bootstrap.expiresAt).toISOString():null,plainSnapshots:this.plainSnapshots,pushFallbacks:this.pushFallbacks,...this.fullMarketStatus()};}
  fullMarketStatus(now=this.now()){
    const leases=[...this.leases.values()].filter(l=>l.until>now);
    return {ggbetCatalogEvents:this.events.size,ggbetLightSubscriptions:[...this.subscriptions.values()].filter(x=>x.mode==='light').length,ggbetActiveFullMarketEvents:this.fullEvents.size,ggbetActiveFullMarketSubscriptions:[...this.subscriptions.values()].filter(x=>x.mode==='full').length,
      ggbetActiveFullMarketLeases:leases.length,ggbetFullMarketSubscribes:this.fullSubscribes,ggbetFullMarketUnsubscribes:this.fullUnsubscribes,ggbetFullMarketLeaseExpirations:this.leaseExpirations,ggbetFullMarketCapRejects:this.fullCapRejects,ggbetFullStreamResyncs:this.fullResyncs,
      ggbetMaxFullEvents:config.ggbetMaxFullEvents,ggbetFullLeaseTtlMs:config.ggbetFullLeaseTtlMs,ggbetFullCacheTtlMs:config.ggbetFullCacheTtlMs,ggbetFullCacheEvents:this.fullCache.size,
      ggbetRootBootstrapFetches:0,ggbetRootBootstrapFailures:0,ggbetWsConnectionsCreated:this.wsConnectionsCreated,ggbetReconnects:this.reconnects,ggbetBootstrapFetches:this.bootstrapFetches,ggbetAuthRefreshes:this.authRefreshes};
  }
  async fetchRelayBootstrap(force=false){
    const secretPath=config.ggbetBootstrapRelaySecretFile,caPath=config.ggbetBootstrapRelayCaFile;let secret='',ca='';try{secret=fs.readFileSync(secretPath,'utf8').trim();ca=fs.readFileSync(caPath,'utf8');}catch(e){throw Error(`GGBET relay credentials unavailable: ${e.code||e.message}`);}if(secret.length<32||!ca.includes('BEGIN CERTIFICATE'))throw Error('GGBET relay credentials invalid');
    try{const payload=this.relayRequestImpl?await this.relayRequestImpl(config.ggbetBootstrapRelayUrl,{secret,ca,force}):await relayJson(config.ggbetBootstrapRelayUrl,{secret,ca,force,timeoutMs:config.ggbetRequestTimeoutMs});const data=bootstrapResult({token:payload?.token,wsUrl:payload?.wsUrl||payload?.endpoint,origin:payload?.origin||payload?.sourceOrigin||'https://gg.bet',at:this.now(),source:'relay'},this.trusted);this.relayFetches++;this.lastRelayAt=this.now();this.lastRelayError='';this.bootstrapFetches++;this.bootstrap=data;return data;}catch(e){this.relayFailures++;this.bootstrapFailures++;this.lastRelayError=e?.message||String(e);throw e;}
  }
  // Bootstrap origins = GGBET_ORIGINS ∩ the trusted list (exact); the rest is ignored and shown in the diagnostics.
  bootstrapOrigins(){const all=config.ggbetOrigins.map(o=>String(o).replace(/\/+$/,'').toLowerCase());return {use:all.filter(o=>this.trusted.includes(o)),ignored:all.filter(o=>!this.trusted.includes(o))};}
  recordBootstrap(row){this.bootstrapLog.push(row);if(this.bootstrapLog.length>10)this.bootstrapLog.shift();this.notify('bootstrap',row,row.reason==='ok'?this.bootstrap:null);}
  notify(hook,...args){try{this.observer?.[hook]?.(...args);}catch{}}
  // Effective network path: the configured mode, unless the egress supervisor runs the last-resort proxy fallback.
  networkMode(){try{return this.observer?.networkMode?.()||config.ggbetNetworkMode;}catch{return config.ggbetNetworkMode;}}
  // Operator selected another egress: drop the token, cookies-free agent and WebSocket; the next connect is a clean session.
  resetForEgressChange(reason='egress changed'){this.bootstrap=null;this.bootstrapAgent=null;resetNetnsAgent();const ws=this.ws;if(ws){try{ws.close(4000,String(reason).slice(0,100));}catch{}}}
  // Admin-only (token-protected endpoint): the last bootstrap attempts, per origin. No token, cookie or body.
  bootstrapDiagnostics(){const o=this.bootstrapOrigins();return {trustedOrigins:this.trusted,configuredOrigins:config.ggbetOrigins,usedOrigins:o.use,ignoredOrigins:o.ignored,networkMode:this.networkMode(),bootstrapFetches:this.bootstrapFetches,bootstrapFailures:this.bootstrapFailures,attempts:this.bootstrapLog.map(x=>({...x,redirectChain:[...x.redirectChain]}))};}
  // One GET of the public LIVE page, redirects followed by hand: each hop only to a trusted host (an untrusted target is
  // never requested). viaProxy: through the session's proxy agent - the same agent the WebSocket uses.
  async bootstrapPage(origin,get,diag){
    const trustedHosts=new Set(this.trusted.map(o=>new URL(o).hostname));
    let url=origin+'/ru/live',host=new URL(url).hostname;
    for(;;){
      const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),config.ggbetRequestTimeoutMs);timer.unref?.();let res;
      try{res=await get(url,{headers:{'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36','accept-language':'ru-RU,ru;q=0.9,en;q=0.8','accept':'text/html,application/xhtml+xml'},signal:ctrl.signal});}
      catch(e){diag.reason=ctrl.signal.aborted||/abort|timeout/i.test(`${e?.name} ${e?.message}`)?'timeout':'network';diag.detail=redact(String(e?.message||e)).slice(0,160);throw e;}
      finally{clearTimeout(timer);}
      const status=Number(res?.status)||0,cookies=setCookiesOf(res);diag.status=status;diag.finalHost=host;if(cookies.length)diag.setCookie=true;
      const location=REDIRECT_STATUSES.has(status)?headerOf(res,'location'):'';
      if(location){
        let next=null;try{next=new URL(location,url);}catch{}
        diag.redirects++;diag.redirectChain.push(next?next.hostname.toLowerCase():'(invalid)');
        if(next&&cookies.some(c=>cookieReaches(c,host,next.hostname.toLowerCase())))diag.cookieOnRedirect=true;
        if(!next||next.protocol!=='https:'||!trustedHosts.has(next.hostname.toLowerCase())){diag.reason='redirect-untrusted';throw Object.assign(Error(`GGBET bootstrap: redirect to an untrusted host (${next?next.hostname.slice(0,80):'invalid'})`),{status,redirectRejected:true});}
        if(diag.redirects>5){diag.reason='too-many-redirects';throw Object.assign(Error('GGBET bootstrap: too many redirects'),{status,redirectRejected:true});}
        url=next.href;host=next.hostname.toLowerCase();continue;
      }
      diag.contentType=headerOf(res,'content-type').split(';')[0].trim().slice(0,60);
      const body=String(await res.text());diag.bodyBytes=Buffer.byteLength(body);diag.bodyKind=bodyKind(body,diag.contentType);
      if(!res.ok){diag.reason='http-status';throw Object.assign(Error(`GGBET bootstrap HTTP ${status}`),{status,originWide:ORIGIN_WIDE_STATUSES.has(status)});}
      if(/not accepting visitors from your region|dummy-country/i.test(body)){diag.reason='geo-blocked';throw Object.assign(Error('GGBET bootstrap blocked by region'),{geoBlocked:true});}
      if(body.length>2_500_000){diag.reason='too-large';throw Error('GGBET: bootstrap HTML слишком большой');}
      try{const data=bootstrapFromHtml(body,origin,this.trusted);diag.tokenExtraction='ok';return data;}
      catch(e){diag.tokenExtraction=e.tokenExtraction||'failed';diag.reason='token-extraction';throw e;}
    }
  }
  async fetchDirectBootstrap(viaProxy=false,agent=null){let error;if(viaProxy)agent=agent||await proxyAgent();
    const origins=this.bootstrapOrigins().use;if(!origins.length)throw Error('GGBET: в GGBET_ORIGINS нет доверенного origin');
    const get=viaProxy?(url,options)=>proxyFetch(url,{headers:options.headers,signal:options.signal,timeoutMs:config.ggbetRequestTimeoutMs,agent,followRedirects:false}):(url,options)=>this.fetch(url,{...options,redirect:'manual'});
    for(let n=0;n<origins.length;n++){
      const idx=(this.originIndex+n)%origins.length,origin=origins[idx],started=Date.now();
      const diag={at:new Date(this.now()).toISOString(),via:viaProxy?(this.networkMode()==='netns'?'netns':'proxy'):'direct',requestedHost:new URL(origin).hostname,finalHost:'',status:0,redirects:0,redirectChain:[],setCookie:false,cookieOnRedirect:false,contentType:'',bodyKind:'',bodyBytes:0,tokenExtraction:'',reason:'',detail:'',elapsedMs:0};
      try{const data=await this.bootstrapPage(origin,get,diag);diag.reason='ok';this.originIndex=idx;this.bootstrap=data;this.bootstrapAgent=agent;this.bootstrapFetches++;return data;}
      catch(e){this.bootstrapFailures++;error=e;if(!diag.reason)diag.reason='failed';if(!diag.detail)diag.detail=redact(String(e?.message||e)).slice(0,160);
        if(e?.geoBlocked)break;
        // One request per attempt unless the failure is this mirror's own HTTP answer (404/5xx) or, direct only, its
        // network: a proxy failure, an origin-wide status, a page without the token or a refused redirect never walks the list.
        if(e?.originWide||e?.tokenExtraction||e?.redirectRejected||(viaProxy&&!e?.status)){this.originIndex=(idx+1)%origins.length;break;}}
      finally{diag.elapsedMs=Date.now()-started;this.recordBootstrap(diag);}
    }throw error||Error('GGBET: bootstrap недоступен');
  }
  // agent: proxy sessions reuse a cached token only if it was fetched through the same agent (= the same egress IP).
  async fetchBootstrap(force=false,agent=null){if(!force&&this.bootstrap&&this.now()-this.bootstrap.at<config.ggbetBootstrapCacheMs&&(!agent||this.bootstrapAgent===agent))return this.bootstrap;const mode=this.networkMode();if(mode==='relay')return this.fetchRelayBootstrap(force);return this.fetchDirectBootstrap(mode==='proxy'||mode==='netns',agent);}
  send(data){if(this.ws?.readyState!==1)throw Error('GGBET: WebSocket не подключён');this.ws.send(JSON.stringify(data));this.notify('sent',data);}
  snapshotPayload(id,{plain=false}={}){const payload={operationName:'GetSportEventListByFilters',variables:{marketLimit:3,isTopMarkets:true,isClient:true,favorite:false,order:'RANK_RECOMMENDED',offset:0,limit:250,sportEventTypes:['MATCH'],marketStatuses:MARKET_STATUSES,matchStatuses:MATCH_STATUSES,marketStatusesForSportEvent:MARKET_STATUSES,sportIds:LIVE_SPORTS}};if(plain)payload.query=SNAPSHOT_QUERY;else payload.extensions={persistedQuery:{version:1,sha256Hash:SNAPSHOT_HASH}};return {id,type:'start',payload};}
  requestSnapshot({plain=false}={}){if(this.ws?.readyState!==1||!this.lastAckAt||[...this.requests.values()].some(r=>r.kind==='snapshot'))return;const id=`s${++this.snapshotSeq}`;if(plain)this.plainSnapshots++;this.requests.set(id,{kind:'snapshot',plain,at:this.now()});this.send(this.snapshotPayload(id,{plain}));}

  marketTabsPayload(id,eventId,{plain=false}={}){const payload={operationName:'GetMarketsTabs',variables:{sportEvent:eventId,marketStatuses:MARKET_STATUSES}};if(plain)payload.query=MARKETS_TABS_QUERY;else payload.extensions={persistedQuery:{version:1,sha256Hash:MARKETS_TABS_HASH}};return{id,type:'start',payload};}
  marketCatalogPayload(id,eventId,{plain=false,tabId='all'}={}){const payload={operationName:'GetMarketsTab',variables:{sportEventID:eventId,marketTabID:tabId,marketStatuses:MARKET_STATUSES}};if(plain)payload.query=MARKETS_TAB_QUERY;else payload.extensions={persistedQuery:{version:1,sha256Hash:MARKETS_TAB_HASH}};return{id,type:'start',payload};}
  marketCatalogUpdatePayload(id,eventId,{plain=false}={}){const payload={operationName:'OnUpdateTab',variables:{sportEventId:eventId,marketTabId:'all',marketStatuses:MARKET_STATUSES}};if(plain)payload.query=UPDATE_TAB_QUERY;else payload.extensions={persistedQuery:{version:1,sha256Hash:UPDATE_TAB_HASH}};return{id,type:'start',payload};}
  eventSubscriptionPayload(id,raw,marketIds){return{id,type:'start',payload:{operationName:'OnUpdateSportEvent',variables:{isTopMarkets:false,skipMarkets:false,sportEventId:text(raw?.id),marketIds,marketStatuses:MARKET_STATUSES,version:raw?.version},extensions:{persistedQuery:{version:1,sha256Hash:UPDATE_HASH}}}};}

  ensureTabState(eventId,version=''){let tab=this.marketTabs.get(eventId);if(!tab){tab={queryId:'',updateId:'',tabsQueryId:'',marketIds:[],marketKey:'',version,providerTabs:[],memberships:new Map(),membershipPending:new Map(),marketToTabs:new Map()};this.marketTabs.set(eventId,tab);}else tab.version=version||tab.version;return tab;}
  rebuildProviderTabs(tab){
    const marketToTabs=new Map();
    const add=(tabId,ids)=>{for(const id of ids||[]){const key=text(id);if(!key)continue;if(!marketToTabs.has(key))marketToTabs.set(key,new Set());marketToTabs.get(key).add(tabId);}};
    add('all',tab.marketIds||[]);
    for(const [tabId,ids] of tab.memberships||[])add(tabId,ids);
    tab.marketToTabs=new Map([...marketToTabs].map(([id,set])=>[id,[...set]]));
  }
  providerTabInfo(eventId){const tab=this.marketTabs.get(eventId);if(!tab)return null;return {catalog:(tab.providerTabs||[]).map(row=>({id:row.id,name:row.name,count:row.id==='all'?(tab.marketIds?.length||0):(tab.memberships?.get(row.id)?.length||0)})),marketToTabs:tab.marketToTabs||new Map()};}
  scheduleMetadataPublish(){clearTimeout(this.metadataPublishTimer);this.metadataPublishTimer=setTimeout(()=>{this.metadataPublishTimer=null;this.publish().catch(e=>{this.lastError=e?.message||String(e);});},60);this.metadataPublishTimer.unref?.();}
  requestProviderTabs(raw,{plain=false,force=false}={}){const eventId=text(raw?.id);if(!eventId||!raw?.version||this.degradedPolling||!this.fullEvents.has(eventId))return;const tab=this.ensureTabState(eventId,raw.version);if(tab.tabsQueryId||(!force&&tab.providerTabs.length))return;const id=`u${++this.catalogSeq}`;tab.tabsQueryId=id;this.requests.set(id,{kind:'provider-tabs',eventId,plain,at:this.now()});this.send(this.marketTabsPayload(id,eventId,{plain}));}
  requestProviderTabMembership(eventId,tabId,{plain=false,force=false}={}){const tab=this.marketTabs.get(eventId);if(!tab||!tabId||tabId==='all')return;if(tab.membershipPending.has(tabId)||(!force&&tab.memberships.has(tabId)))return;const id=`b${++this.catalogSeq}`;tab.membershipPending.set(tabId,id);this.requests.set(id,{kind:'provider-tab-membership',eventId,tabId,plain,at:this.now()});this.send(this.marketCatalogPayload(id,eventId,{plain,tabId}));}
  applyProviderTabs(eventId,rows=[]){const tab=this.marketTabs.get(eventId);if(!tab)return;tab.providerTabs=(rows||[]).map(row=>({id:text(row?.id),name:text(row?.name)})).filter(row=>row.id&&row.name);if(!tab.providerTabs.some(row=>row.id==='all'))tab.providerTabs.unshift({id:'all',name:'All'});for(const row of tab.providerTabs)this.requestProviderTabMembership(eventId,row.id);this.rebuildProviderTabs(tab);this.scheduleMetadataPublish();}
  applyProviderTabMembership(eventId,tabId,marketIds=[]){const tab=this.marketTabs.get(eventId);if(!tab)return;tab.memberships.set(tabId,[...new Set((marketIds||[]).map(text).filter(Boolean))]);tab.membershipPending.delete(tabId);this.rebuildProviderTabs(tab);this.scheduleMetadataPublish();}
  requestMarketCatalog(raw,{plain=false,force=false}={}){const eventId=text(raw?.id);if(!eventId||!raw?.version||this.degradedPolling||!this.fullEvents.has(eventId))return;const tab=this.ensureTabState(eventId,raw.version);
    if(tab.queryId)return;if(!force&&tab.marketIds.length)return;const id=`m${++this.catalogSeq}`;tab.queryId=id;this.marketCatalogFetches++;this.requests.set(id,{kind:'market-catalog',eventId,plain,at:this.now()});this.send(this.marketCatalogPayload(id,eventId,{plain,tabId:'all'}));
    if(!tab.updateId&&!this.catalogPushFallback){const updateId=`t${++this.catalogSeq}`;tab.updateId=updateId;this.requests.set(updateId,{kind:'market-catalog-subscription',eventId,plain:false,at:this.now()});this.send(this.marketCatalogUpdatePayload(updateId,eventId));}
  }
  subscribeEvent(eventId,marketIds,mode='full'){const raw=this.events.get(eventId),ids=[...new Set((marketIds||[]).map(text).filter(Boolean))];if(!raw?.version||!ids.length||this.degradedPolling)return;this.unsubscribeEvent(eventId);const id=String(++this.subSeq);this.subscriptions.set(eventId,{id,version:raw.version,marketIds:ids,mode,key:ids.slice().sort().join('\n')});this.requests.set(id,{kind:'subscription',eventId,at:this.now()});if(mode==='full')this.fullMarketSubscriptions++;this.send(this.eventSubscriptionPayload(id,raw,ids));}
  // Light subscription: the same OnUpdateSportEvent stream, limited to the top markets the snapshot lists for the event
  // (score, status and main prices stay pushed; the full tree is not).
  syncLight(eventId){if(this.fullEvents.has(eventId)||this.degradedPolling||this.ws?.readyState!==1)return;const ids=this.lightIds.get(eventId)||[],cur=this.subscriptions.get(eventId),key=ids.slice().sort().join('\n');if(!ids.length){if(cur)this.unsubscribeEvent(eventId);return;}if(cur?.mode==='light'&&cur.key===key)return;this.subscribeEvent(eventId,ids,'light');}
  leasedEvents(now=this.now()){const ids=new Set();for(const l of this.leases.values())if(l.until>now)ids.add(l.eventId);return ids;}
  // A client (detail panel) holds a lease on one event; renewing it with another event moves the lease (A -> B).
  // Returns {ok,capped}. Never touches the WebSocket or the session.
  lease(leaseId,sourceEventId,now=this.now()){
    const key=text(leaseId);if(!key)return {ok:false};const raw=sourceEventId?this.findRawEvent(sourceEventId):null,old=this.leases.get(key);
    if(!raw){if(old)this.releaseLease(key);return {ok:false,missing:true};}
    const eventId=text(raw.id);
    if(old&&old.eventId!==eventId)this.releaseLease(key);
    if(!this.fullEvents.has(eventId)&&this.fullEvents.size>=config.ggbetMaxFullEvents){this.fullCapRejects++;return {ok:false,capped:true};}
    this.leases.delete(key);this.leases.set(key,{eventId,until:now+config.ggbetFullLeaseTtlMs});
    if(this.leases.size>500)this.releaseLease(this.leases.keys().next().value);
    if(!this.fullEvents.has(eventId))this.activateFull(eventId);
    return {ok:true};
  }
  releaseLease(leaseId){const key=text(leaseId),row=this.leases.get(key);if(!row)return false;this.leases.delete(key);if(!this.leasedEvents().has(row.eventId))this.deactivateFull(row.eventId);return true;}
  hasLease(sourceEventId){const raw=this.findRawEvent(sourceEventId);return !!raw&&this.fullEvents.has(text(raw.id));}
  activateFull(eventId){this.fullEvents.add(eventId);this.fullSubscribes++;const raw=this.events.get(eventId);if(raw&&this.ws?.readyState===1&&this.lastAckAt){try{this.requestMarketCatalog(raw,{force:true});this.requestProviderTabs(raw);}catch{}}}
  // Last lease gone: stop the full stream and the tab catalog at once, keep the last full tree in RAM for a short
  // reopen, trim the event back to its top markets and resume the light subscription.
  deactivateFull(eventId){
    if(!this.fullEvents.delete(eventId))return;this.fullUnsubscribes++;this.fullStale.delete(eventId);
    const raw=this.events.get(eventId);
    if(raw&&config.ggbetFullCacheTtlMs>0){const event=parseGgbetLiveEvent(raw,{origin:this.bootstrap?.origin,at:raw.__updatedAt||this.now(),providerTabs:this.providerTabInfo(eventId)});if(event?.odds?.markets?.length)this.fullCache.set(eventId,{event,at:this.now()});}
    this.unsubscribe(eventId);
    if(raw){const keep=new Set(this.lightIds.get(eventId)||[]);this.events.set(eventId,{...raw,markets:(raw.markets||[]).filter(m=>keep.has(text(m?.id)))});}
    try{this.syncLight(eventId);}catch{}
    this.scheduleMetadataPublish();
  }
  expireLeases(now=this.now()){
    for(const [key,row] of [...this.leases])if(row.until<=now){this.leases.delete(key);this.leaseExpirations++;if(!this.leasedEvents(now).has(row.eventId))this.deactivateFull(row.eventId);}
    for(const [id,row] of [...this.fullCache])if(now-row.at>config.ggbetFullCacheTtlMs)this.fullCache.delete(id);
  }
  applyMarketCatalog(eventId,marketIds,{fromPush=false}={}){const tab=this.marketTabs.get(eventId);if(!tab||!this.fullEvents.has(eventId))return;const ids=[...new Set((marketIds||[]).map(text).filter(Boolean))];const key=ids.slice().sort().join('\n');if(!ids.length){if(!this.subscriptions.has(eventId)){const raw=this.events.get(eventId),fallback=(raw?.markets||[]).map(m=>text(m?.id)).filter(Boolean);if(fallback.length)this.subscribeEvent(eventId,fallback,'full');}return;}const changed=key!==tab.marketKey;tab.marketIds=ids;tab.marketKey=key;this.rebuildProviderTabs(tab);if(fromPush)this.marketCatalogUpdates++;if(changed||this.subscriptions.get(eventId)?.mode!=='full')this.subscribeEvent(eventId,ids,'full');if(changed&&tab.providerTabs.length)for(const row of tab.providerTabs)this.requestProviderTabMembership(eventId,row.id,{force:true});}
  unsubscribeEvent(eventId){const row=this.subscriptions.get(eventId);if(!row)return;this.subscriptions.delete(eventId);this.requests.delete(row.id);try{this.send({id:row.id,type:'stop'});}catch{}}
  unsubscribeCatalog(eventId){const tab=this.marketTabs.get(eventId);if(!tab)return;this.marketTabs.delete(eventId);for(const id of [tab.queryId,tab.updateId,tab.tabsQueryId,...(tab.membershipPending?.values?.()||[])])if(id){this.requests.delete(id);try{this.send({id,type:'stop'});}catch{}}}
  unsubscribe(eventId){this.unsubscribeEvent(eventId);this.unsubscribeCatalog(eventId);}
  // The event left the LIVE list (finished/removed): its streams stop and its leases end with it.
  forgetEvent(eventId){this.unsubscribe(eventId);for(const [key,row] of [...this.leases])if(row.eventId===eventId)this.leases.delete(key);if(this.fullEvents.delete(eventId))this.fullUnsubscribes++;this.lightIds.delete(eventId);this.fullCache.delete(eventId);this.fullStale.delete(eventId);}
  findRawEvent(sourceEventId){const key=safeUuid(sourceEventId);return [...this.events.values()].find(raw=>safeUuid(raw?.id)===key)||null;}
  // Detail hydration. Full markets only for an event a client holds a lease on (an open detail panel); everything
  // else (hover prefetch, a capped request) gets the light event, or the full tree cached after a recent release.
  async detail(sourceEventId,{timeoutMs=5000,full=null}={}){
    const raw=this.findRawEvent(sourceEventId);if(!raw)return null;
    const eventId=text(raw.id),wantFull=full??this.fullEvents.has(eventId),cached=this.fullCache.get(eventId);
    const light=()=>{const current=this.events.get(eventId)||raw,event=parseGgbetLiveEvent(current,{origin:this.bootstrap?.origin,at:current.__updatedAt||this.now(),providerTabs:this.providerTabInfo(eventId)});
      // A recently released full tree: shown at once (marked), the live one follows through the lease.
      if(event&&cached&&this.now()-cached.at<=config.ggbetFullCacheTtlMs&&cached.event?.odds?.markets?.length>(event.odds?.markets?.length||0))return {...event,odds:{...cached.event.odds,cachedAt:cached.at,fromCache:true}};
      return event;};
    if(!wantFull||!this.fullEvents.has(eventId))return light();
    const tab=this.ensureTabState(eventId,raw.version);
    if(this.ws?.readyState===1&&this.lastAckAt){this.requestMarketCatalog(raw,{force:!tab.marketIds.length});this.requestProviderTabs(raw,{force:!tab.providerTabs.length});}
    // Reopened within the cache window: answer now; the full stream is (re)subscribed and its first push invalidates.
    if(cached&&!(this.events.get(eventId)?.markets?.length>(this.lightIds.get(eventId)?.length||0)))return light();
    const start=this.now();
    while(this.now()-start<timeoutMs){
      const state=this.marketTabs.get(eventId),row=this.events.get(eventId),expected=state?.marketIds?.length||0,have=row?.markets?.length||0;
      const marketsReady=expected>0&&have>=Math.max(1,expected-3);
      const tabsReady=(state?.providerTabs?.length||0)>0&&(state?.membershipPending?.size||0)===0;
      if(marketsReady&&tabsReady)break;
      if(!this.fullEvents.has(eventId))break;
      await sleep(50);
    }
    const current=this.events.get(eventId)||raw;
    return parseGgbetLiveEvent(current,{origin:this.bootstrap?.origin,at:current.__updatedAt||this.now(),providerTabs:this.providerTabInfo(eventId)});
  }
  async publish(at=this.now()){const rows=[...this.events.values()].map(raw=>parseGgbetLiveEvent(raw,{origin:this.bootstrap?.origin,at:raw.__updatedAt||at,providerTabs:this.providerTabInfo(raw.id)})).filter(Boolean);await this.state.success(rows,{status:200,elapsedMs:0});}
  // A leased full stream that went quiet while the event moves on: the snapshot (every 30 s) shows other prices for
  // markets the full tree also has. If two snapshots at least 10 s apart disagree and the stream pushed nothing in
  // between, only this stream is restarted inside the same WebSocket (the session is never torn down for it), and
  // the snapshot's newer top-market prices are applied at once. Returns true when it resubscribed.
  checkFullStream(eventId,snap,old,now){
    const sub=this.subscriptions.get(eventId);if(sub?.mode!=='full'){this.fullStale.delete(eventId);return false;}
    const price=m=>JSON.stringify((m?.odds||[]).map(o=>[text(o?.id),text(o?.value),!!o?.isActive]));
    const have=new Map((old?.markets||[]).map(m=>[text(m?.id),price(m)]));
    if(!(snap?.markets||[]).some(m=>have.has(text(m?.id))&&have.get(text(m?.id))!==price(m))){this.fullStale.delete(eventId);return false;}
    const mark=this.fullStale.get(eventId),pushes=sub.pushes||0;
    if(!mark||mark.subId!==sub.id||mark.pushes!==pushes||now-mark.at<10000){if(!mark||mark.subId!==sub.id||mark.pushes!==pushes)this.fullStale.set(eventId,{at:now,subId:sub.id,pushes});return false;}
    this.fullStale.delete(eventId);this.fullResyncs++;
    try{this.subscribeEvent(eventId,sub.marketIds,'full');}catch{}
    return true;
  }
  async applySnapshot(list){const now=this.now(),next=new Map();for(const raw of Array.isArray(list)?list:[]){if(!raw?.id)continue;this.lightIds.set(raw.id,(raw.markets||[]).map(m=>text(m?.id)).filter(Boolean));const old=this.events.get(raw.id),tab=this.marketTabs.get(raw.id),keepFull=!!(this.fullEvents.has(raw.id)&&tab?.marketIds?.length&&old?.markets?.length),resync=keepFull&&this.checkFullStream(raw.id,raw,old,now);const patch=keepFull?{...raw,markets:resync?mergeMarketsById(old.markets,raw.markets):undefined}:raw,merged=mergeGgbetEvent(old,patch);merged.__updatedAt=old?.version===merged.version?(old.__updatedAt||now):now;next.set(raw.id,merged);}for(const id of this.events.keys())if(!next.has(id))this.forgetEvent(id);this.events=next;for(const raw of this.events.values()){if(this.fullEvents.has(raw.id)){if(!this.marketTabs.get(raw.id)?.providerTabs?.length)this.requestProviderTabs(raw);this.requestMarketCatalog(raw,{force:this.catalogPushFallback});}else this.syncLight(raw.id);}this.snapshots++;this.lastSnapshotAt=now;this.failures=0;this.lastError='';await this.publish(now);}
  async applyPush(patch){if(!patch?.id)return;const old=this.events.get(patch.id);if(!old){this.scheduleSnapshot(250);return;}const now=this.now(),merged=mergeGgbetEvent(old,patch);merged.__updatedAt=now;this.events.set(patch.id,merged);const sub=this.subscriptions.get(patch.id);if(sub){sub.version=merged.version||sub.version;sub.pushes=(sub.pushes||0)+1;}const tab=this.marketTabs.get(patch.id);if(tab)tab.version=merged.version||tab.version;this.pushes++;this.lastPushAt=now;this.failures=0;this.lastError='';await this.publish(now);}
  async onMessage(raw){this.lastMessageAt=this.now();let msg;try{msg=JSON.parse(typeof raw==='string'?raw:String(raw));}catch{return;}this.notify('message',raw,msg);if(msg.type==='connection_ack'){this.lastAckAt=this.now();this.failures=0;this.requestSnapshot();return;}if(msg.type==='ka'||msg.type==='connection_keep_alive')return;
    const id=String(msg.id||''),req=this.requests.get(id);if(msg.type==='data'){
      if(req?.kind==='snapshot'){const matches=msg?.payload?.data?.matches?.sportEvents;if(Array.isArray(matches)){this.requests.delete(id);await this.applySnapshot(matches);}}
      else if(req?.kind==='provider-tabs'){const rows=msg?.payload?.data?.compiledMarketsTabs?.tabs;if(Array.isArray(rows)){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab&&tab.tabsQueryId===id)tab.tabsQueryId='';this.applyProviderTabs(req.eventId,rows);}}
      else if(req?.kind==='provider-tab-membership'){const ids=msg?.payload?.data?.compiledMarketsTab?.marketIds;if(Array.isArray(ids)){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab?.membershipPending?.get(req.tabId)===id)tab.membershipPending.delete(req.tabId);this.applyProviderTabMembership(req.eventId,req.tabId,ids);}}
      else if(req?.kind==='market-catalog'){const ids=msg?.payload?.data?.compiledMarketsTab?.marketIds;if(Array.isArray(ids)){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab&&tab.queryId===id)tab.queryId='';this.applyMarketCatalog(req.eventId,ids);}}
      else if(req?.kind==='market-catalog-subscription'){const ids=msg?.payload?.data?.onUpdateTab?.marketIds;if(Array.isArray(ids))this.applyMarketCatalog(req.eventId,ids,{fromPush:true});}
      else if(req?.kind==='subscription'){const patch=msg?.payload?.data?.onUpdateSportEvent;if(patch)await this.applyPush(patch);}
      return;
    }
    if(msg.type==='error'||msg?.payload?.errors){const detail=JSON.stringify(msg.payload||msg).slice(0,1000);
      if(req?.kind==='snapshot'&&isPersistedError(detail)&&!req.plain){this.requests.delete(id);this.requestSnapshot({plain:true});return;}
      if(req?.kind==='snapshot'){this.requests.delete(id);this.lastError='GGBET snapshot: '+detail;await this.state.failure(Error(this.lastError));return;}
      if(req?.kind==='provider-tabs'&&isPersistedError(detail)&&!req.plain){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab&&tab.tabsQueryId===id)tab.tabsQueryId='';this.requestProviderTabs(this.events.get(req.eventId),{plain:true,force:true});return;}
      if(req?.kind==='provider-tabs'){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab&&tab.tabsQueryId===id)tab.tabsQueryId='';this.marketCatalogFailures++;return;}
      if(req?.kind==='provider-tab-membership'&&isPersistedError(detail)&&!req.plain){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab?.membershipPending?.get(req.tabId)===id)tab.membershipPending.delete(req.tabId);this.requestProviderTabMembership(req.eventId,req.tabId,{plain:true,force:true});return;}
      if(req?.kind==='provider-tab-membership'){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab?.membershipPending?.get(req.tabId)===id)tab.membershipPending.delete(req.tabId);this.marketCatalogFailures++;return;}
      if(req?.kind==='market-catalog'&&isPersistedError(detail)&&!req.plain){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab&&tab.queryId===id)tab.queryId='';this.requestMarketCatalog(this.events.get(req.eventId),{plain:true,force:true});return;}
      if(req?.kind==='market-catalog'){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab&&tab.queryId===id)tab.queryId='';this.marketCatalogFailures++;this.lastError='GGBET market catalog: '+detail;const fallback=(this.events.get(req.eventId)?.markets||[]).map(m=>text(m?.id)).filter(Boolean);if(fallback.length)this.applyMarketCatalog(req.eventId,fallback);return;}
      if(req?.kind==='market-catalog-subscription'&&isPersistedError(detail)){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab&&tab.updateId===id)tab.updateId='';this.catalogPushFallback=true;this.marketCatalogFailures++;this.scheduleSnapshot(1000);this.lastError='GGBET: market catalog push hash changed, using snapshot catalog refresh';return;}
      if(req?.kind==='subscription'&&isPersistedError(detail)){this.degradedPolling=true;this.pushFallbacks++;for(const eventId of [...this.subscriptions.keys()])this.unsubscribeEvent(eventId);this.scheduleSnapshot(1000);this.lastError='GGBET: push hash изменился, включён snapshot fallback';return;}
      if(isAuthError(detail)){this.lastError='GGBET: guest token отклонён';this.bootstrap=null;try{this.ws?.close(4401,'refresh-token');}catch{}return;}this.lastError='GGBET GraphQL: '+detail;return;
    }
    if(msg.type==='complete'&&req?.kind==='snapshot'){this.requests.delete(id);return;}
    if(msg.type==='complete'&&req?.kind==='provider-tabs'){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab&&tab.tabsQueryId===id)tab.tabsQueryId='';return;}
    if(msg.type==='complete'&&req?.kind==='provider-tab-membership'){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab?.membershipPending?.get(req.tabId)===id)tab.membershipPending.delete(req.tabId);return;}
    if(msg.type==='complete'&&req?.kind==='market-catalog'){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab&&tab.queryId===id)tab.queryId='';return;}
    if(msg.type==='complete'&&req?.kind==='market-catalog-subscription'){this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(tab&&tab.updateId===id)tab.updateId='';this.catalogPushFallback=true;this.scheduleSnapshot(500);return;}
    if(msg.type==='complete'&&req?.kind==='subscription'){this.subscriptions.delete(req.eventId);this.requests.delete(id);const tab=this.marketTabs.get(req.eventId);if(this.fullEvents.has(req.eventId)&&tab?.marketIds?.length)this.subscribeEvent(req.eventId,tab.marketIds,'full');else if(!this.fullEvents.has(req.eventId)&&this.lightIds.get(req.eventId)?.length)this.syncLight(req.eventId);else this.scheduleSnapshot(500);}
  }
  scheduleSnapshot(delay){clearTimeout(this.snapshotSoon);this.snapshotSoon=setTimeout(()=>this.requestSnapshot(),delay);this.snapshotSoon.unref?.();}
  scheduleReconnect(delay){if(this.stopped)return;clearTimeout(this.reconnectTimer);this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this.connect().catch(()=>{});},delay);this.reconnectTimer.unref?.();}
  async webSocketClass(){if(this.WebSocket)return this.WebSocket;if(!this.WebSocketPromise)this.WebSocketPromise=import('ws').then(m=>m.WebSocket||m.default);return this.WebSocketPromise;}
  async connect(){if(this.stopped||!config.ggbetLiveEnabled||this.connecting)return this.connecting;this.connecting=(async()=>{try{
      // Proxy mode: one agent for the whole session - the token and the WebSocket leave through the same gateway.
      const agent=this.networkMode()==='proxy'?await proxyAgent():this.networkMode()==='netns'?netnsAgent(config.ggbetEgressSocket):null;const bootstrap=await this.fetchBootstrap(!this.bootstrap,agent);if(this.stopped)return;const WebSocketClass=await this.webSocketClass();const ws=new WebSocketClass(bootstrap.wsUrl,'graphql-ws',{headers:{Origin:bootstrap.origin,'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'},handshakeTimeout:config.ggbetRequestTimeoutMs,perMessageDeflate:false,maxPayload:config.upstreamMaxBytes,...(agent?{agent}:{})});this.ws=ws;this.wsConnectionsCreated++;this.lastAckAt=0;this.lastConnectAt=this.now();this.lastMessageAt=this.now();this.requests.clear();this.subscriptions.clear();this.marketTabs.clear();
      await new Promise((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>{try{ws.close();}catch{};reject(Error('GGBET: timeout подключения WebSocket'));},config.ggbetRequestTimeoutMs);timer.unref?.();
        const open=()=>{try{ws.send(JSON.stringify({type:'connection_init',payload:{headers:{'X-Auth-Token':bootstrap.token}}}));}catch(e){reject(e);}};
        const message=e=>{this.onMessage(e?.data).catch(err=>{this.lastError=err.message;});if(!settled){try{const x=JSON.parse(String(e?.data));if(x.type==='connection_ack'){settled=true;clearTimeout(timer);resolve();}else if(x.type==='connection_error'){settled=true;clearTimeout(timer);this.authRefreshes++;this.bootstrap=null;const detail=text(x?.payload?.message||x?.payload||'init rejected').slice(0,200);try{ws.close(4401,'refresh-token');}catch{};reject(Error(`GGBET connection_init rejected: ${detail}`));}}catch{}}};
        const error=()=>{if(!settled){settled=true;clearTimeout(timer);reject(Error('GGBET: ошибка WebSocket'));}};
        const close=e=>{this.handleClose(e);if(!settled){settled=true;clearTimeout(timer);reject(Error(`GGBET: WebSocket закрыт ${e?.code||''}`));}};
        ws.addEventListener('open',open);ws.addEventListener('message',message);ws.addEventListener('error',error);ws.addEventListener('close',close);
      });
      this.reconnects+=this.reconnects||this.failures?1:0;this.failures=0;this.lastError='';if(agent&&this.networkMode()==='proxy')reportProxySession(true);this.notify('wsConnected');
    }catch(error){if(this.networkMode()==='proxy')reportProxySession(false);this.notify('wsFailed',error);this.failures++;this.lastError=redact(error?.message||String(error));await this.state.failure({message:this.lastError,status:error?.status||0});if(isAuthError(this.lastError))this.bootstrap=null;const delay=jitter(Math.min(config.ggbetMaxBackoffMs,1000*(2**Math.min(6,this.failures))));this.scheduleReconnect(delay);throw error;}finally{this.connecting=null;}})();return this.connecting;}
  handleClose(event){if(this.ws&&event?.target&&this.ws!==event.target)return;this.lastClose=`${event?.code||0} ${event?.reason||''}`.trim();this.notify('wsClosed',event?.code||0,event?.reason||'');this.lastAckAt=0;this.ws=null;this.requests.clear();this.subscriptions.clear();this.marketTabs.clear();if(this.stopped)return;this.failures++;
    // Reconnect pacing: only a healthy, long session may refresh at once; a streak of short sessions or failures backs off
    // (the connection_error path already scheduled a back-off before this close event - never shorten it to 500 ms).
    const lived=this.lastConnectAt?this.now()-this.lastConnectAt:0;this.shortSessions=lived<MIN_HEALTHY_SESSION_MS?this.shortSessions+1:0;
    const streak=Math.max(this.failures,this.shortSessions),paced=jitter(Math.min(config.ggbetMaxBackoffMs,1000*(2**Math.min(6,streak)))),refresh=streak<=1?jitter(500):paced;
    if([4401,4403,1008].includes(Number(event?.code))||isAuthError(event?.reason)){this.authRefreshes++;this.bootstrap=null;this.scheduleReconnect(refresh);}else if(Number(event?.code)===4001){this.bootstrap=null;this.scheduleReconnect(refresh);}else this.scheduleReconnect(paced);}
  // Session renewal only for a real reason: the watchdog (no message for ggbetWatchdogMs), a declared token expiry
  // (renewed a minute before it), or an explicitly configured GGBET_SESSION_REFRESH_MS. No timer by default.
  maintenance(){if(this.stopped||!config.ggbetLiveEnabled)return;const now=this.now();this.expireLeases(now);if(this.ws?.readyState===1&&this.lastAckAt){const interval=this.degradedPolling?config.ggbetDegradedSnapshotMs:config.ggbetSnapshotIntervalMs;if(now-this.lastSnapshotAt>=interval)this.requestSnapshot();if(now-this.lastMessageAt>config.ggbetWatchdogMs){this.lastError='GGBET: watchdog reconnect';try{this.ws.close(4001,'watchdog');}catch{}}else if(this.bootstrap?.expiresAt&&now>=this.bootstrap.expiresAt-60000&&now-this.lastConnectAt>=MIN_HEALTHY_SESSION_MS){this.expiryRefreshes++;this.bootstrap=null;try{this.ws.close(4001,'token-expiry');}catch{}}else if(config.ggbetSessionRefreshMs>0&&now-this.lastConnectAt>config.ggbetSessionRefreshMs){this.scheduledRefreshes++;this.bootstrap=null;try{this.ws.close(4001,'scheduled-token-refresh');}catch{}}}else if(!this.connecting&&!this.reconnectTimer)this.scheduleReconnect(0);}
  start(){if(!config.ggbetLiveEnabled)return;this.stopped=false;this.maintenanceTimer=setInterval(()=>this.maintenance(),1000);this.maintenanceTimer.unref?.();this.connect().catch(()=>{});}
  async stop(){this.stopped=true;clearInterval(this.maintenanceTimer);clearTimeout(this.reconnectTimer);clearTimeout(this.snapshotSoon);clearTimeout(this.metadataPublishTimer);this.reconnectTimer=null;this.snapshotSoon=null;try{if(this.ws?.readyState===1)this.ws.close(1000,'shutdown');}catch{};if(this.connecting)await this.connecting.catch(()=>{});this.ws=null;}
}
