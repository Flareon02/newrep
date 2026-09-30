/* Canonical sportsbook market vocabulary shared by every provider UI.
   Provider ids/names remain audit metadata; user-facing grouping and linking
   are derived from semantics (scope + family + sub-scope + line + outcomes). */
const MarketCanonical=(()=>{
 const norm=s=>String(s??'').normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g,'').replace(/ё/g,'е').replace(/[^\p{L}\p{N}:+.\-]+/gu,' ').replace(/\s+/g,' ').trim();
 const n=v=>Number.isFinite(Number(v))?Number(v):null;
 const cleanNumber=v=>{const x=n(v);return x==null?'':String(Math.round(x*1000)/1000);};
 // GGBET now preserves rawTitle/specifiers. Prefer those for semantics and use
 // translated title only as presentation fallback.
 const nativeTitle=m=>String(m?.rawTitle||m?.title||'').trim();
 const displayTitle=m=>String(m?.title||m?.rawTitle||'').trim();
 const serverCanonical=m=>m?.canonical&&typeof m.canonical==='object'&&m.canonical.family?m.canonical:null;
 const periodOf=m=>Math.max(0,Number(serverCanonical(m)?.map)||Number(m?.period)||Number(m?.specifiers?.mapnr)||0);
 const typeOf=m=>String(m?.type||'').toLowerCase().replace(/_/g,'-');
 const labels=m=>(m?.prices||[]).map(p=>norm(p?.label||p?.designation||''));
 const designations=m=>(m?.prices||[]).map(p=>String(p?.designation||'').toLowerCase()).filter(Boolean);
 const spec=(m,key)=>m?.specifiers&&typeof m.specifiers==='object'?m.specifiers[key]:undefined;
 const exactScoreLike=m=>{const ls=labels(m).filter(Boolean);return ls.length>=3&&ls.filter(x=>/^\d+\s*:\s*\d+$/.test(x.replace(/\s+/g,''))).length>=Math.min(3,ls.length);};
 const textNumber=(...values)=>{for(const value of values){const hit=String(value??'').replace(',','.').match(/(?:^|[^\d])([+-]?\d+(?:\.\d+)?)(?!\d)/);if(hit)return Number(hit[1]);}return null;};
 const has=(m,re)=>re.test(norm(nativeTitle(m)));
 function roundNumber(m){return Number(serverCanonical(m)?.round)||Number(spec(m,'roundnr'))||Number(norm(nativeTitle(m)).match(/(?:round|rund|раунд)\s*(\d+)/)?.[1]||norm(nativeTitle(m)).match(/(\d+)\s*(?:round|rund|раунд)/)?.[1])||0;}
 function halfNumber(m){return Number(serverCanonical(m)?.half)||Number(spec(m,'halfnr'))||Number(norm(nativeTitle(m)).match(/(?:half|polovin|половин)\s*(\d+)/)?.[1])||0;}
 function overtimeMode(m){const exact=String(serverCanonical(m)?.overtime||'');if(exact)return exact;const t=norm(nativeTitle(m));return /overtimes?\s+not\s+include|not include|nie obejmuj.*dogrywk|bez dogrywk|bez ucheta|без учета|без учёта/.test(t)?'exclude':/incl\.?\s*overtime|including overtime|wlacznie.*dogrywk|włącznie.*dogrywk|включ.*овертайм/.test(t)?'include':'';}
 function family(m={}){
  const exact=serverCanonical(m);if(exact)return String(exact.family);
  // A GGBET market without server canonical metadata is deliberately *not*
  // guessed from two home/away outcomes or localized text. Showing the raw
  // bookmaker title is safer than silently turning Race-to-rounds into Winner.
  if(/^ggbet:/i.test(String(m?.key||'')))return'special';
  const type=typeOf(m),title=norm(nativeTitle(m)),ds=new Set(designations(m)),ls=labels(m).join(' | ');
  // Specific semantics first. Generic `spread`/`total` types are intentionally
  // last because GGBET uses the same hcp/total tags for many distinct markets.
  if(type==='half-exact-score'||/half.*correct score|половин.*точн.*счет|половин.*точн.*счёт/.test(title))return'half-exact-score';
  if(['exact-score'].includes(type)||exactScoreLike(m)||/correct (?:map )?score|точн.*счет|точн.*счёт|dokladn.*wynik/.test(title))return'exact-score';
  if(type==='pistol-round-winner'||/pistol round winner|пистолетн.*раунд.*побед/.test(title))return'pistol-round-winner';
  if(type==='round-winner'||/round winner|побед.*раунд/.test(title))return'round-winner';
  if(type==='winning-margin'||/winning margin|разниц.*побед/.test(title))return'winning-margin';
  if(type==='half-winner'||/half.*1x2|половин.*1x2/.test(title))return'half-winner';
  if(type==='overtime'||/will there be overtime|будет.*овертайм/.test(title))return'overtime';
  if(type==='round-parity'||/odd.*even.*round|чет.*нечет.*раунд|чёт.*нечёт.*раунд/.test(title))return'round-parity';
  if(type==='map-parity'||/odd.*even.*map|чет.*нечет.*карт|чёт.*нечёт.*карт/.test(title))return'map-parity';
  if(type==='winner-total-over'||/total over.*win|побед.*тотал.*больше/.test(title))return'winner-total-over';
  if(type==='winner-total-under'||/total under.*win|побед.*тотал.*меньше/.test(title))return'winner-total-under';
  if(type==='asian-round-handicap'||/asian round handicap|азиат.*фор.*раунд/.test(title))return'asian-round-handicap';
  if(type==='half-round-handicap'||/half.*round handicap|половин.*фор.*раунд/.test(title))return'half-round-handicap';
  if(type==='round-handicap'||/round handicap|фор.*раунд/.test(title))return'round-handicap';
  if(type==='asian-round-total'||/asian total rounds|азиат.*тотал.*раунд/.test(title))return'asian-round-total';
  if(type==='round-total-3way'||/total rounds.*3 way|тотал.*раунд.*3/.test(title))return'round-total-3way';
  if(type==='team-round-total'||(/total rounds/.test(title)&&(/team|competitor/.test(title))))return'team-total';
  if(['double','double-chance','doublechance'].includes(type)||/double chance|двойн.*шанс|podwojn/.test(title))return'double-chance';
  if(['map-handicap','maps-handicap'].includes(type))return'map-handicap';
  if(['map-total','maps-total'].includes(type))return'map-total';
  if(type.startsWith('team-total'))return'team-total';
  if(['moneyline','winner'].includes(type)||/\b1x2\b/.test(title)||/winner|zwycie|побед/.test(title))return'winner';
  if(['spread','handicap'].includes(type)||/handicap|hcp|фора/.test(title))return /map|карт|kart/.test(title)&&!periodOf(m)?'map-handicap':'handicap';
  if(type==='total'||/suma|total|тотал/.test(title)){
   if(/map|карт|kart/.test(title)&&!periodOf(m)&&!/rund|round|раунд/.test(title))return'map-total';
   if(/team|команд/.test(title))return'team-total';
   return'total';
  }
  if(type==='kills-parity')return'kills-parity';
  if(type==='winner-kills-parity')return'winner-kills-parity';
  if(type==='kills-last-digit')return'kills-last-digit';
  if(type==='heroes-alive-at-throne')return'heroes-alive';
  if(type==='winner-and-total')return'winner-total';
  if(type==='round-interval')return'round-interval';
  if(/parzyst|nieparzyst|odd|even|чет|нечет|чёт|нечёт/.test(title+' '+ls))return /frag|kill/.test(title+' '+ls)?'kills-parity':'parity';
  if(ds.has('over')&&ds.has('under'))return'total';
  if(ds.has('home')&&ds.has('away')&&ds.size<=3)return'winner';
  if(/\b(?:tak|nie|yes|no|да|нет)\b/.test(ls))return'yes-no';
  return'special';
 }
 function line(m,fam=family(m)){
  const exact=serverCanonical(m);if(exact&&exact.line!=null&&Number.isFinite(Number(exact.line)))return Number(exact.line);
  const prices=m?.prices||[];
  if(['total','map-total','team-total','asian-round-total','round-total-3way','winner-total-over','winner-total-under'].includes(fam)){
   const fromSpec=n(spec(m,'total'));if(fromSpec!=null)return fromSpec;
   const p=prices.find(x=>['over','under'].includes(String(x.designation||'').toLowerCase()));return n(p?.points)??textNumber(p?.label,nativeTitle(m),m?.key);
  }
  if(['handicap','map-handicap','round-handicap','asian-round-handicap','half-round-handicap'].includes(fam)){
   const fromSpec=n(spec(m,'hcp'));if(fromSpec!=null)return fromSpec;
   const home=prices.find(x=>String(x.designation||'').toLowerCase()==='home'),away=prices.find(x=>String(x.designation||'').toLowerCase()==='away');const hp=n(home?.points),ap=n(away?.points);return hp??(ap==null?textNumber(home?.label,away?.label,nativeTitle(m),m?.key):-ap);
  }
  return null;
 }
 function teamSide(m,event={},teams={}){
  const exact=serverCanonical(m);if(exact?.side)return String(exact.side);
  const type=typeOf(m),title=norm(nativeTitle(m)),home=norm(teams.team1||event.team1||''),away=norm(teams.team2||event.team2||'');
  if(type.endsWith('-home')||m?.side==='home'||/тотал\s*1\b|team\s*1/.test(title))return'home';
  if(type.endsWith('-away')||m?.side==='away'||/тотал\s*2\b|team\s*2/.test(title))return'away';
  if(home&&title.includes(home))return'home';if(away&&title.includes(away))return'away';return'';
 }
 const cap=s=>String(s||'').replace(/^./,x=>x.toUpperCase());
 function title(m,event={},teams={}){
  const exact=serverCanonical(m);if(exact?.title)return String(exact.title);
  const fam=family(m),p=periodOf(m),prefix=p?`Карта ${p} — `:'',home=teams.team1||event.team1||'',away=teams.team2||event.team2||'',side=teamSide(m,event,teams),round=roundNumber(m),half=halfNumber(m),ot=overtimeMode(m),otText=ot==='include'?' (с овертаймом)':ot==='exclude'?' (без овертайма)':'';
  if(fam==='winner'){const three=designations(m).includes('draw')||/\b1x2\b/.test(norm(nativeTitle(m)));return cap(prefix+(three?'исход 1X2':'победитель')+otText);}
  if(fam==='double-chance')return cap(prefix+'двойной шанс');
  if(fam==='handicap')return cap(prefix+'фора');
  if(fam==='map-handicap')return'Фора по картам';
  if(fam==='total')return cap(prefix+(/round|rund|раунд/.test(norm(nativeTitle(m)))?'тотал раундов':'тотал'));
  if(fam==='map-total')return'Тотал карт';
  if(fam==='team-total'){const rounds=/round|rund|раунд/.test(norm(nativeTitle(m)));return cap(prefix+(rounds?'тотал раундов ':'тотал ')+(side==='home'?home:side==='away'?away:'команды'));}
  if(fam==='half-exact-score')return cap(prefix+`половина${half?' '+half:''} — точный счёт`);
  if(fam==='exact-score')return p?`Карта ${p} — точный счёт`:/map|карт/.test(norm(nativeTitle(m)))?'Точный счёт по картам':'Точный счёт';
  if(fam==='round-winner')return cap(prefix+`раунд${round?' '+round:''} — победитель`);
  if(fam==='pistol-round-winner')return cap(prefix+`пистолетный раунд${round?' '+round:''} — победитель`);
  if(fam==='winning-margin')return cap(prefix+'разница победы'+otText);
  if(fam==='half-winner')return cap(prefix+`половина${half?' '+half:''} — исход 1X2`);
  if(fam==='half-round-handicap')return cap(prefix+`половина${half?' '+half:''} — фора по раундам`);
  if(fam==='round-handicap')return cap(prefix+'фора по раундам'+(/3 way/.test(norm(nativeTitle(m)))?' (3 исхода)':'')+otText);
  if(fam==='asian-round-handicap')return cap(prefix+'азиатская фора по раундам'+otText);
  if(fam==='asian-round-total')return cap(prefix+'азиатский тотал раундов');
  if(fam==='round-total-3way')return cap(prefix+'тотал раундов (3 исхода)');
  if(fam==='overtime')return cap(prefix+'будет овертайм');
  if(fam==='round-parity')return cap(prefix+'чёт / нечёт раундов');
  if(fam==='map-parity')return 'Чёт / нечёт карт';
  if(fam==='parity')return cap(prefix+'чёт / нечёт');
  if(fam==='kills-parity')return'Фраги — чёт / нечёт';
  if(fam==='winner-kills-parity')return'Победитель + чётность фрагов';
  if(fam==='kills-last-digit')return'Последняя цифра общего числа фрагов';
  if(fam==='heroes-alive')return'Героев в живых при разрушении трона';
  if(fam==='winner-total-over')return cap(prefix+'победитель + тотал больше'+otText);
  if(fam==='winner-total-under')return cap(prefix+'победитель + тотал меньше'+otText);
  if(fam==='winner-total')return'Победитель + тотал';
  if(fam==='round-interval')return'Раунд — интервал';
  if(fam==='yes-no')return cap(prefix+'да / нет');
  let raw=displayTitle(m)
   .replace(/Zwycięzca/gi,'Победитель').replace(/Suma map/gi,'Тотал карт').replace(/Suma rund/gi,'Тотал раундов')
   .replace(/Handicap rund/gi,'Фора по раундам').replace(/Mapa handicap/gi,'Фора по картам')
   .replace(/Powyżej/gi,'Больше').replace(/Poniżej/gi,'Меньше');
  if(!raw||/^market\s*\d+$/i.test(raw)||/^rynek\s*\d+$/i.test(raw))raw=m?.rawType?`Рынок ${m.rawType}`:'Дополнительный рынок';return raw;
 }
 function category(fam){
  if(['winner','double-chance','half-winner','round-winner','pistol-round-winner'].includes(fam))return'winners';
  if(['handicap','map-handicap','round-handicap','asian-round-handicap','half-round-handicap'].includes(fam))return'handicaps';
  if(['total','map-total','team-total','asian-round-total','round-total-3way','winner-total-over','winner-total-under'].includes(fam))return'totals';
  if(['exact-score','half-exact-score'].includes(fam))return'scores';
  if(['overtime','parity','round-parity','map-parity','kills-parity','yes-no'].includes(fam))return'main';return'specials';
 }
 const categoryLabel={all:'Все рынки',winners:'Победители',rounds:'Раунды',handicaps:'Форы',totals:'Тоталы',scores:'Счёт',combined:'Комбо',main:'Основные',specials:'Спец.'};
 const categoryOrder={winners:0,rounds:1,handicaps:2,totals:3,scores:4,combined:5,main:6,specials:7};
 const familyOrder={winner:0,'double-chance':1,'half-winner':2,'race-to-rounds':3,'round-winner':4,'pistol-round-winner':5,'bomb-planted':6,'map-handicap':10,handicap:11,'round-handicap':12,'round-handicap-3way':13,'asian-round-handicap':14,'half-round-handicap':15,'map-total':20,total:21,'round-total':22,'team-total':23,'team-round-total':23,'asian-round-total':24,'round-total-3way':25,'winner-total-over':26,'winner-total-under':27,'exact-score':30,'half-exact-score':31,'pistol-exact-score':32,overtime:40,'round-parity':41,'map-parity':42,parity:43,'kills-parity':44,'yes-no':45,'winning-margin':60,'way-to-win':61,special:99};
 function outcomeShape(m){const fam=family(m);if(['exact-score','half-exact-score'].includes(fam))return'score';if(fam==='winning-margin')return'margin';return [...new Set(designations(m).map(x=>x.replace(/^outcome-.*/,'other')))].sort().join(',')||String((m?.prices||[]).length);}
 function describe(m,event={},source='',teams={}){
  const exact=serverCanonical(m),fam=family(m),p=periodOf(m),ln=line(m,fam),cat=String(exact?.category||category(fam)),side=String(exact?.side||teamSide(m,event,teams)),shape=outcomeShape(m),round=roundNumber(m),half=halfNumber(m),special=fam==='special'?norm(nativeTitle(m)).slice(0,80):'';
  const key=[p,half,round,fam,side,cleanNumber(ln),shape,special].join('|');return {family:fam,category:cat,period:p,line:ln,side,shape,key,title:title(m,event,teams),order:(categoryOrder[cat]??9)*100+(familyOrder[fam]??90),source,serverCanonical:!!exact};
 }
 function scopeLabel(period){return Number(period)>0?`Карта ${period}`:'Матч';}
 function translateLabel(raw=''){return String(raw).replace(/Powyżej/gi,'Больше').replace(/Poniżej/gi,'Меньше').replace(/Zwycięzca/gi,'Победитель').replace(/Remis/gi,'Ничья').replace(/^Tak$/i,'Да').replace(/^Nie$/i,'Нет').replace(/Parzyste/gi,'Чёт').replace(/Nieparzyste/gi,'Нечёт').trim();}
 function outcomeLabel(price,m,event={},teams={}){
  const home=teams.team1||event.team1||'',away=teams.team2||event.team2||'',d=String(price?.designation||'').toLowerCase(),point=n(price?.points),fam=family(m),raw=translateLabel(price?.label||price?.designation||'Исход');
  if(fam==='winning-margin')return raw||({home,away}[d]||'Исход');
  if(fam==='winner-total-over'&&['home','away'].includes(d))return `${d==='home'?home:away} + Больше${point!=null?' '+cleanNumber(point):''}`;
  if(fam==='winner-total-under'&&['home','away'].includes(d))return `${d==='home'?home:away} + Меньше${point!=null?' '+cleanNumber(point):''}`;
  const base={home,away,draw:'Ничья',over:'Больше',under:'Меньше',yes:'Да',no:'Нет','home-draw':`${home} / ничья`,'draw-away':`Ничья / ${away}`,'home-away':`${home} / ${away}`,even:'Чёт',odd:'Нечёт'}[d];
  if(base){if(['over','under'].includes(d)&&point!=null)return `${base} ${cleanNumber(point)}`;if(['home','away'].includes(d)&&point!=null&&point!==0&&['handicap','map-handicap','round-handicap','asian-round-handicap','half-round-handicap'].includes(fam))return `${base} (${point>0?'+':''}${cleanNumber(point)})`;return base;}
  return raw.replace(/\^1\^/g,home).replace(/\^2\^/g,away).replace(/\bП1\b/g,home).replace(/\bП2\b/g,away)||'Исход';
 }
 function compare(a,b,event={},teams={}){const A=describe(a,event,'',teams),B=describe(b,event,'',teams);return A.period-B.period||A.order-B.order||(A.line??0)-(B.line??0)||A.title.localeCompare(B.title,'ru')||String(a.key||'').localeCompare(String(b.key||''));}
 return {norm,family,line,describe,title,outcomeLabel,scopeLabel,categoryLabel,categoryOrder,compare,roundNumber,halfNumber};
})();
