import {historyPrice} from './history-model.js';
import {FONBET_FACTORS} from './market-registry.js';
import {readFileSync} from 'node:fs';
const names=JSON.parse(readFileSync(new URL('./astek-market-names.json',import.meta.url),'utf8'));
const official=JSON.parse(readFileSync(new URL('./astek-market-official.json',import.meta.url),'utf8'));
const officialMarketName=id=>clean(official.G?.[String(id)]);
const legacyMarketName=id=>clean(names.G?.[String(id)]);
const marketName=id=>officialMarketName(id)||legacyMarketName(id);
const eventName=id=>clean(official.T?.[String(id)])||clean(names.T?.[String(id)]);

const flatten=rows=>Array.isArray(rows)?rows.flatMap(r=>Array.isArray(r)?flatten(r):r&&typeof r==='object'?[r]:[]):[];
const finite=v=>Number.isFinite(Number(v))?Number(v):null;
const decimal=v=>Number.isFinite(Number(v))&&Number(v)>1?Number(v):null;
const clean=v=>String(v??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
const periodOf=name=>Number(String(name||'').match(/(?:map|карт[аы])\s*(\d+)|(\d+)(?:st|nd|rd|th)?\s*(?:map|карт)/i)?.slice(1).find(Boolean))||0;
const designated={1:'home',2:'draw',3:'away',7:'home',8:'away',9:'over',10:'under',11:'over',12:'under',13:'over',14:'under',2824:'over',2825:'under',2826:'home',2827:'away',3653:'home',3654:'draw',3655:'away',3656:'home-draw',3657:'home-away',3658:'draw-away'};
const designationOf=(type,label='')=>{
  const known=designated[Number(type)];if(known)return known;
  const text=clean(label).toLowerCase();
  // Text inference is deliberately narrow. Team-specific yes/no and
  // map/match combination markets must keep their full outcome caption.
  if(/фора|handicap/i.test(text)){
    if(/(?:\^1\^|команд[аы]\s*1|\bп1\b|перв(?:ая|ой) команд)/i.test(text))return 'home';
    if(/(?:\^2\^|команд[аы]\s*2|\bп2\b|втор(?:ая|ой) команд)/i.test(text))return 'away';
  }
  if(/ничь/i.test(text))return 'draw';
  if(/(?:\bбольше\b|\sб(?:\s|$))/i.test(text))return 'over';
  if(/(?:\bменьше\b|\sм(?:\s|$))/i.test(text))return 'under';
  return undefined;
};
const marketOrder=t=>t==='Победитель'?0:t==='Двойной шанс'?1:t==='Фора'?2:t==='Тотал'?3:/^Тотал [12]$/.test(t)?4:t==='Фора по картам'?5:/^Тотал(?: по)? карт/.test(t)?6:/побед|исход матча/i.test(t)?7:/фора/i.test(t)?8:/тотал/i.test(t)?9:10;
const sideOrder={home:0,draw:1,away:2,over:0,under:1,'home-draw':0,'home-away':1,'draw-away':2};

function astekSemantic(g,t,p,{cs2=false,dota=false,semanticGroup=null}={}){
  g=Number(g);t=Number(t);const sg=Number.isFinite(Number(semanticGroup))?Number(semanticGroup):g,officialTitle=officialMarketName(g);
  // G is an instance/group id. GetGameZip also exposes GS: the semantic market
  // id used by Astek's dictionary. Using G for captions produced unrelated
  // boxing/football names for Dota markets (e.g. G=2436, GS=752).
  if([2663,2665].includes(g)&&[191,192,196,197,206,207,211,212].includes(t))return ['winner-and-total','Победитель и тотал'];
  if(g===403&&[1365,1366].includes(t))return ['round-winner','Победитель раунда'];
  if(cs2&&g===90&&[759,761].includes(t))return ['overtime','Будет овертайм'];
  if(cs2&&g===136&&t===3044)return ['round-interval','Раунд команды 1 в интервале'];
  if([3653,3654,3655].includes(t)||g===2766)return ['first-half-winner','Победитель первой половины'];
  if([3656,3657,3658].includes(t)||g===2768)return ['first-half-double','Двойной шанс первой половины'];
  if(sg===753||[2826,2827].includes(t)||g===2438)return ['map-handicap',officialTitle||'Фора по картам'];
  if(sg===752||[2824,2825].includes(t)||g===2436)return ['map-total',officialTitle||'Тотал по картам'];
  if(dota&&sg===890)return ['kills-parity',officialTitle||'Фраги: чёт/нечёт'];
  if(dota&&sg===4856)return ['winner-kills-parity',officialTitle||'Победитель + чётность фрагов'];
  if(dota&&sg===4927)return ['heroes-alive-at-throne',officialTitle||'Героев в живых при разрушении трона'];
  if(dota&&sg===5476)return ['kills-last-digit',officialTitle||'Последняя цифра общего числа фрагов'];
  if(sg===33)return ['exact-score','Точный счёт'];
  if([7,8].includes(t)&&p!=null)return ['spread','Фора'];
  if([9,10].includes(t)&&p!=null)return ['total','Тотал'];
  if([11,12].includes(t)&&p!=null)return ['team-total-home','Тотал 1'];
  if([13,14].includes(t)&&p!=null)return ['team-total-away','Тотал 2'];
  if(sg===1||g===1)return ['moneyline','Победитель'];
  // If GS is present, never fall back to the unrelated G dictionary entry.
  // The HAR-derived template uses the raw esports group id (G), while older
  // Astek dictionaries often used GS. Prefer the official raw caption when it
  // exists, then the proven semantic GS dictionary. This fixes Dota groups
  // such as 2683/2685 without reviving unrelated football/boxing captions.
  const title=officialMarketName(g)||marketName(sg)||(sg!==g?`Рынок ${sg}`:legacyMarketName(g)||`Рынок ${g}`);
  const type=/побед|исход матча/i.test(title)?'moneyline':/двойной шанс/i.test(title)?'double_chance':/фора|гандикап/i.test(title)?'spread':/тотал/i.test(title)?'total':'other';
  return [type,title];
}

export function astekOdds(raw,all=[],mode='live',context={}){
  // Compatibility: tests/tools may pass astekOdds(raw, timestamp).
  const explicitAt=typeof all==='number'?all:Date.now();
  if(!Array.isArray(all))all=[];
  const groups=new Map(),root=String(raw?.I??''),children=[...flatten(raw?.SG),...all.filter(r=>String(r?.MI??r?.parentId??'')===root)],contextText=[raw?.SSN,raw?.LE,raw?.L,context?.category].filter(Boolean).join(' '),cs2=/\b(?:cs\s*2|counter[ -]?strike\s*2)\b/i.test(contextText),dota=/\bdota\s*2?\b/i.test(contextText);
  for(const r of [raw,...children]){
    if(!r||typeof r!=='object')continue;
    // GetGameZip can return a map as the root event (PN="2nd map").
    const period=periodOf([r.PN,r.TG,r.N].filter(x=>typeof x==='string').join(' '));
    if(r!==raw&&!period)continue;
    const entries=[...flatten(r.E),...flatten(r.AE).flatMap(group=>flatten(group.ME).map(v=>({...v,G:v.G??group.G,GS:v.GS??group.GS}))),...flatten(r.GE).flatMap(group=>flatten(group.E).map(v=>({...v,G:v.G??group.G,GS:v.GS??group.GS})))];
    const unique=new Map();
    for(const e of entries){const g=Number(e?.G),gs=Number(e?.GS??e?.G),t=Number(e?.T),p=finite(e?.P);if(!Number.isFinite(g)||!Number.isFinite(t))continue;const k=[g,gs,t,p??''].join(':');if(!unique.has(k)||e.CE===1)unique.set(k,e);}
    for(const e of unique.values()){
      const g=Number(e.G),semanticGroup=Number(e.GS??e.G),t=Number(e.T),v=decimal(e.C),templateLabel=eventName(t)||`Исход ${t}`,designation=designationOf(t,templateLabel);
      const rawParam=finite(e.P),[type,title]=astekSemantic(g,t,rawParam,{cs2,dota,semanticGroup}),isHandicap=/spread|handicap/.test(type),isTotal=/^total$|^map-total$|^team-total/.test(type);
      // Handicap points in Astek belong to the selected team. Convert the
      // away point to the equivalent home line so only true opposite outcomes
      // share a row: home -2.5 pairs with away +2.5, not away -2.5.
      const param=rawParam==null?'':isHandicap?(designation==='away'?-rawParam:rawParam):isTotal?rawParam:rawParam??'';
      const key=[r.I??root,period,g,semanticGroup,param].join(':');
      const market=groups.get(key)||{key,type,title,period,status:'open',prices:[],rawGroup:g,semanticGroup};
      const blocked=raw.B===true||raw.B===1||r.B===true||r.B===1||e.B===true||e.B===1||e.BL===true||!v;
      let label=templateLabel;
      if(e.P!==undefined)label=label.replace(/\(\)/g,String(e.P));
      market.prices.push(historyPrice({designation,label,points:e.P,decimal:blocked?null:v,rawType:t},e.C));
      if(blocked)market.status='suspended'; groups.set(key,market);
    }
  }
  const markets=[...groups.values()].map(m=>{const prices=[...m.prices].sort((a,b)=>(sideOrder[a.designation]??9)-(sideOrder[b.designation]??9)||Number(a.points??0)-Number(b.points??0));return m.status==='open'?{...m,prices}:{...m,prices:prices.map(p=>historyPrice({...p,decimal:null},p.__historyRaw?.rawOdds??p.decimal))};});
  markets.sort((a,b)=>a.period-b.period||marketOrder(a.title)-marketOrder(b.title)||a.title.localeCompare(b.title,'ru')||a.key.localeCompare(b.key));
  return markets.length?{provider:'AstekBet',team1:clean(raw?.O1E||raw?.O1),team2:clean(raw?.O2E||raw?.O2),mode,updatedAt:explicitAt,stale:false,transport:'existing-feed',markets}:null;
}

// Fonbet's listBase/event feed exposes numeric factor ids without market captions. The factor table is shared with the
// canonical market registry (market-registry.js), where each pair is verified on the journal. A factor that is not in
// the table is never paired by guesswork (opposite points, adjacent ids): it stays its own `unknown` market.
const FONBET=Object.fromEntries(Object.entries(FONBET_FACTORS).map(([id,x])=>[id,{family:x.family==='winner'?'moneyline':x.family,side:x.side}]));
const fonbetTitle=f=>f==='moneyline'?'Победитель':f==='double'?'Двойной шанс':f==='handicap'?'Фора':f==='total'?'Тотал':f==='map-handicap'?'Фора по картам':f==='map-total'?'Тотал карт':null;
const fonbetLabel=(side,id)=>side==='home'?'1':side==='away'?'2':side==='draw'?'Ничья':side==='over'?'Больше':side==='under'?'Меньше':side==='home-draw'?'1X':side==='draw-away'?'X2':side==='home-away'?'12':`Исход ${id}`;
function inferFonbetFactor(f){
  return FONBET[Number(f.f)]||{family:'unknown',side:'other'};
}
function addFonbetEventMarkets(groups,e,containers,blockInfo,period){
  const factors=containers.flatMap(c=>Array.isArray(c?.factors)?c.factors:[]);
  for(const f of factors){
    const v=decimal(f.v); if(!v)continue;
    const id=Number(f.f),spec=inferFonbetFactor(f),p=finite(f.pt??f.p);
    const isHandicap=spec.family.includes('handicap'),isTotal=spec.family.includes('total');
    // Handicap rows are keyed by the home team's line: home -1.5 pairs with away +1.5, never with home +1.5.
    const line=isHandicap&&p!=null?(spec.side==='away'?-p:p):isTotal&&p!=null?p:'main';
    const familyKey=spec.family==='unknown'?`unknown:${id}`:spec.family;
    const key=[e.id,period,familyKey,line].join(':');
    const title=fonbetTitle(spec.family)||`Рынок ${id}`;
    const market=groups.get(key)||{key,type:spec.family,title,period,status:'open',prices:[]};
    const eventBlocked=blockInfo.events.has(String(e.id)),factorBlocked=blockInfo.factors.get(String(e.id))?.has(Number(id))||f.blocked===true||f.b===true;
    market.prices.push(historyPrice({designation:spec.side,label:fonbetLabel(spec.side,id),points:f.pt??f.p,decimal:eventBlocked||factorBlocked?null:v,rawType:id},f.v));
    if(eventBlocked)market.status='suspended'; groups.set(key,market);
  }
}
export function fonbetOdds(arg1,arg2,arg3='live',arg4){
  // Normal collector call: fonbetOdds(rawEvent, payload, mode, prebuiltIndex).
  // Also accept fonbetOdds(payload, eventId, timestamp) for focused tests.
  let raw,payload,mode,index,updatedAt=Date.now();
  if(Array.isArray(arg1?.events)){
    payload=arg1; raw=(payload.events||[]).find(e=>String(e.id)===String(arg2));
    if(typeof arg3==='number')updatedAt=arg3; else mode=arg3||'live';
    index=fonbetOddsIndex(payload);
  }else{
    raw=arg1; payload=arg2||{}; mode=arg3||'live'; index=arg4||fonbetOddsIndex(payload);
  }
  if(!raw)return null;
  const id=String(raw.id),children=index?.children?.get(id)||(payload.events||[]).filter(r=>String(r.parentId??r.parentEventId??'')===id),events=[raw,...children],groups=new Map();
  for(const e of events){
    const period=e===raw?0:periodOf(e.name||e.comment); if(e!==raw&&!period)continue;
    const containers=index?.factors?.get(String(e.id))||(payload.customFactors||[]).filter(c=>String(c.e??c.eventId)===String(e.id));
    addFonbetEventMarkets(groups,e,containers,index?.blocked||{events:new Set(),factors:new Map()},period);
  }
  const markets=[...groups.values()].map(m=>m.status==='open'?m:{...m,prices:m.prices.map(p=>historyPrice({...p,decimal:null},p.__historyRaw?.rawOdds??p.decimal))});
  markets.sort((a,b)=>a.period-b.period||marketOrder(a.title)-marketOrder(b.title)||a.title.localeCompare(b.title,'ru')||a.key.localeCompare(b.key));
  return markets.length?{provider:'Fonbet',team1:clean(raw.team1),team2:clean(raw.team2),mode,updatedAt,stale:false,transport:'existing-feed',markets}:null;
}
export function fonbetOddsIndex(payload,rootIds=null){
  const roots=rootIds?new Set([...rootIds].map(String).filter(Boolean)):null;
  const factors=new Map(),children=new Map(),childIds=new Set();
  for(const e of payload?.events||[]){
    const parent=String(e.parentId??e.parentEventId??'');
    if(roots&&!roots.has(parent))continue;
    if(!children.has(parent))children.set(parent,[]);children.get(parent).push(e);
    const id=String(e.id??'');if(id)childIds.add(id);
  }
  const relevant=roots?new Set([...roots,...childIds]):null;
  for(const c of payload?.customFactors||[]){
    const id=String(c.e??c.eventId);if(relevant&&!relevant.has(id))continue;
    if(!factors.has(id))factors.set(id,[]);factors.get(id).push(c);
  }
  const blocked={events:new Set(),factors:new Map()};
  for(const row of payload?.eventBlocks||[]){
    const id=String(row?.eventId??row?.e??'');if(!id||(relevant&&!relevant.has(id)))continue;const state=String(row?.state??'').toLowerCase();
    if(state==='unblocked'||state==='open'||state==='0'||row?.state===0)continue;
    if(state==='partial'&&Array.isArray(row?.factors)){blocked.factors.set(id,new Set(row.factors.map(Number)));continue;}
    blocked.events.add(id);
  }
  return {factors,children,blocked};
}
