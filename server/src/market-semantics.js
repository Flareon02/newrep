const text=v=>String(v??'').trim();
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};
const clean=v=>{const n=num(v);return n==null?null:Math.round(n*1000)/1000;};
const specs=m=>m?.specifiers&&typeof m.specifiers==='object'&&!Array.isArray(m.specifiers)?m.specifiers:Object.fromEntries((m?.specifiers||[]).map(x=>[text(x?.name),text(x?.value)]).filter(([k])=>k));
const spec=(m,k)=>specs(m)[k];
const period=m=>Math.max(0,Number(m?.period)||Number(spec(m,'mapnr'))||0);
const half=m=>Math.max(0,Number(spec(m,'halfnr'))||0);
const round=m=>Math.max(0,Number(spec(m,'roundnr'))||0);
const line=m=>clean(spec(m,'hcp')??spec(m,'total'));
const prefix=p=>p?`Карта ${p} — `:'';

const GGBET={
  1:{family:'winner',category:'winners',title:()=> 'Победитель',scope:'match'},
  4:{family:'round-parity',category:'rounds',title:({p})=>`${prefix(p)}чёт / нечёт раундов`,overtime:'include'},
  5:{family:'bomb-planted',category:'rounds',title:({p,r})=>`${prefix(p)}раунд${r?` ${r}`:''} — будет установлена бомба`},
  7:{family:'winner',category:'winners',title:({p})=>`${prefix(p)}победитель (с овертаймом)`,overtime:'include'},
  8:{family:'race-to-rounds',category:'rounds',title:({p,r})=>`${prefix(p)}кто первым возьмёт ${r||'?'} раундов`},
  10:{family:'round-handicap',category:'handicaps',title:({p})=>`${prefix(p)}фора по раундам (с овертаймом)`,overtime:'include'},
  11:{family:'overtime',category:'specials',title:({p})=>`${prefix(p)}будет овертайм`},
  13:{family:'round-winner',category:'rounds',title:({p,r})=>`${prefix(p)}раунд${r?` ${r}`:''} — победитель`},
  14:{family:'map-total',category:'totals',title:()=> 'Тотал карт',scope:'match'},
  17:{family:'map-handicap',category:'handicaps',title:()=> 'Фора по картам',scope:'match'},
  21:{family:'winner',category:'winners',title:({p})=>`${prefix(p)}исход 1X2 (без овертайма)`,overtime:'exclude'},
  103:{family:'round-handicap',category:'handicaps',title:()=> 'Фора по раундам матча (с овертаймами)',scope:'match',overtime:'include'},
  194:{family:'round-total',category:'totals',title:()=> 'Тотал раундов матча (с овертаймами)',scope:'match',overtime:'include'},
  292:{family:'map-parity',category:'specials',title:()=> 'Чёт / нечёт карт',scope:'match'},
  293:{family:'pistol-round-winner',category:'rounds',title:({p,r})=>`${prefix(p)}пистолетный раунд${r?` ${r}`:''} — победитель`},
  299:{family:'round-handicap',category:'handicaps',title:({p})=>`${prefix(p)}фора по раундам`},
  300:{family:'round-total',category:'totals',title:({p})=>`${prefix(p)}тотал раундов`},
  349:{family:'exact-score',category:'scores',title:()=> 'Точный счёт по картам',scope:'match'},
  407:{family:'team-round-total',category:'totals',title:({team1})=>`Тотал раундов — ${team1||'команда 1'} (с овертаймами)`,scope:'match',side:'home',overtime:'include'},
  408:{family:'team-round-total',category:'totals',title:({team2})=>`Тотал раундов — ${team2||'команда 2'} (с овертаймами)`,scope:'match',side:'away',overtime:'include'},
  538:{family:'pistol-exact-score',category:'scores',title:({p})=>`${prefix(p)}точный счёт пистолетных раундов`},
  539:{family:'way-to-win',category:'combined',title:()=> 'Способ победы',scope:'match'},
  786:{family:'half-round-handicap',category:'handicaps',title:({p,h})=>`${prefix(p)}половина${h?` ${h}`:''} — фора по раундам`},
  787:{family:'team-round-total',category:'totals',title:({p,team1})=>`${prefix(p)}тотал раундов — ${team1||'команда 1'}`,side:'home'},
  788:{family:'team-round-total',category:'totals',title:({p,team2})=>`${prefix(p)}тотал раундов — ${team2||'команда 2'}`,side:'away'},
  789:{family:'half-winner',category:'winners',title:({p,h})=>`${prefix(p)}половина${h?` ${h}`:''} — исход 1X2`},
  790:{family:'half-exact-score',category:'scores',title:({p,h})=>`${prefix(p)}половина${h?` ${h}`:''} — точный счёт`},
  927:{family:'asian-round-total',category:'totals',title:({p})=>`${prefix(p)}азиатский тотал раундов`},
  929:{family:'round-total-3way',category:'totals',title:({p})=>`${prefix(p)}тотал раундов (3 исхода)`},
  1519:{family:'exact-score',category:'scores',title:({p})=>`${prefix(p)}точный счёт`},
  1564:{family:'team-round-total',category:'totals',title:({p,team1})=>`${prefix(p)}тотал раундов — ${team1||'команда 1'} (с овертаймом)`,side:'home',overtime:'include'},
  1565:{family:'team-round-total',category:'totals',title:({p,team2})=>`${prefix(p)}тотал раундов — ${team2||'команда 2'} (с овертаймом)`,side:'away',overtime:'include'},
  1270:{family:'winner-total-under',category:'combined',title:({p})=>`${prefix(p)}победитель + тотал меньше`,overtime:''},
  1590:{family:'asian-round-handicap',category:'handicaps',title:({p})=>`${prefix(p)}азиатская фора по раундам (с овертаймом)`,overtime:'include'},
  1591:{family:'round-handicap-3way',category:'handicaps',title:({p})=>`${prefix(p)}фора по раундам (3 исхода, с овертаймом)`,overtime:'include'},
  1592:{family:'winning-margin',category:'combined',title:({p,score})=>`${prefix(p)}разница победы${score?` ${score}`:''} (с овертаймом)`,overtime:'include'},
  1593:{family:'winner-total-over',category:'combined',title:({p})=>`${prefix(p)}победитель + тотал больше (с овертаймом)`,overtime:'include'},
  1594:{family:'winner-total-under',category:'combined',title:({p})=>`${prefix(p)}победитель + тотал меньше (с овертаймом)`,overtime:'include'}
};

function scopeOf(p,h,r,forced=''){
  if(forced)return forced;
  if(r)return'round';
  if(h)return'half';
  if(p)return'map';
  return'match';
}

export function canonicalizeGgbetMarket(market={},teams={}){
  const rawType=Number(market?.rawType??market?.typeId??0)||0,p=period(market),h=half(market),r=round(market),def=GGBET[rawType],sp=specs(market),ln=line(market),rawTitle=text(market?.rawTitle||market?.name||market?.title),score=text(sp.score);
  if(!def){
    return {provider:'ggbet',rawType,family:'special',category:'specials',scope:scopeOf(p,h,r),map:p||null,half:h||null,round:r||null,line:ln,score:score||null,overtime:'',title:rawTitle||`GGBET market ${rawType||'unknown'}`,unknown:true};
  }
  const ctx={p,h,r,team1:text(teams.team1),team2:text(teams.team2),sp,score};
  return {provider:'ggbet',rawType,family:def.family,category:def.category,scope:scopeOf(p,h,r,def.scope),map:p||null,half:h||null,round:r||null,line:ln,score:score||null,side:def.side||'',overtime:def.overtime||'',title:def.title(ctx),unknown:false};
}

const TYPE_MAP={
  moneyline:['winner','winners'],winner:['winner','winners'],'map-handicap':['map-handicap','handicaps'],spread:['handicap','handicaps'],handicap:['handicap','handicaps'],
  'map-total':['map-total','totals'],total:['total','totals'],'team-round-total':['team-round-total','totals'],'asian-round-total':['asian-round-total','totals'],'round-total-3way':['round-total-3way','totals'],
  'half-exact-score':['half-exact-score','scores'],'exact-score':['exact-score','scores'],'pistol-round-winner':['pistol-round-winner','rounds'],'round-winner':['round-winner','rounds'],
  'winning-margin':['winning-margin','combined'],'half-winner':['half-winner','winners'],overtime:['overtime','specials'],'round-parity':['round-parity','rounds'],'map-parity':['map-parity','specials'],
  'winner-total-over':['winner-total-over','combined'],'winner-total-under':['winner-total-under','combined'],'asian-round-handicap':['asian-round-handicap','handicaps'],'half-round-handicap':['half-round-handicap','handicaps'],'round-handicap':['round-handicap','handicaps']
};
export function canonicalizeGenericMarket(market={},teams={}){
  if(market?.canonical?.family)return market.canonical;
  const t=text(market?.type).toLowerCase().replace(/_/g,'-'),mapped=TYPE_MAP[t],p=period(market),h=half(market),r=round(market),ln=line(market),raw=text(market?.title||market?.rawTitle||market?.name);
  const family=mapped?.[0]||'special',category=mapped?.[1]||'specials';
  return {provider:'generic',rawType:Number(market?.rawType)||0,family,category,scope:scopeOf(p,h,r),map:p||null,half:h||null,round:r||null,line:ln,score:text(spec(market,'score'))||null,overtime:'',title:raw||'Дополнительный рынок',unknown:!mapped};
}
export function canonicalizeMarket(market={},source='',teams={}){
  return source==='ggbet'?canonicalizeGgbetMarket(market,teams):canonicalizeGenericMarket(market,teams);
}
export function enrichOddsSemantics(odds={},source='',teams={}){
  if(!odds||typeof odds!=='object')return odds;
  return {...odds,markets:(odds.markets||[]).map(m=>({...m,canonical:canonicalizeMarket(m,source,teams)}))};
}
export function enrichEventMarketSemantics(event={}){
  const refs=event?.sourceRefs?.length?event.sourceRefs:[event];
  const next=refs.map(r=>r?.odds?{...r,odds:enrichOddsSemantics(r.odds,r.source,{team1:r.odds?.team1||r.team1||event.team1,team2:r.odds?.team2||r.team2||event.team2})}:r);
  if(event?.sourceRefs?.length)return {...event,sourceRefs:next};
  return next[0]||event;
}
