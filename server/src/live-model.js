(function(root){
'use strict';
const Pricing=root.OddsPricing||(typeof require==='function'?require('./odds-pricing.js'):null),clamp=(x,a,b)=>Math.max(a,Math.min(b,x)),norm=s=>String(s||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
function fair(pair){if(pair.length!==2||pair.some(x=>!Number.isFinite(x)||x<=1))return null;const total=1/pair[0]+1/pair[1];return 1/pair[0]/total;}
function bookInputs(event,source='average',now=Date.now()){
 const out=new Map();for(const r of event.sourceRefs||[]){if(source!=='average'&&r.source!==source)continue;const o=r.odds;if(!o||o.stale||now-Number(o.checkedAt||o.updatedAt||0)>60000)continue;
  const reversed=(norm(o.team1)===norm(event.team2)&&norm(o.team2)===norm(event.team1))||r.scoreReversed===true;
  const seen=new Set();for(const m of o.markets||[]){const period=Number(m.period)||0;if(!['moneyline','winner'].includes(m.type)||period>5||m.isAlternate||m.status&&m.status!=='open'||m.prices?.length!==2||seen.has(period))continue;let pair=['home','away'].map(side=>Number(m.prices.find(p=>p.designation===side)?.decimal));if(reversed)pair.reverse();const p=fair(pair);if(p==null)continue;seen.add(period);if(!out.has(period))out.set(period,[]);out.get(period).push({source:r.source,p,odds:pair,at:o.checkedAt||o.updatedAt});}
 }return Object.fromEntries([...out].map(([period,rows])=>[period,{p:avg(rows.map(r=>r.p)),sources:rows}]));
}
function directLines(event,source,now=Date.now()){
 const rows=new Map();
 for(const ref of event.sourceRefs||[]){if(source!=='average'&&ref.source!==source)continue;
  const odds=ref.odds;if(!odds||odds.stale||now-Number(odds.checkedAt||odds.updatedAt||0)>60000)continue;
  const reversed=(norm(odds.team1)===norm(event.team2)&&norm(odds.team2)===norm(event.team1))||ref.scoreReversed===true;
  for(const market of odds.markets||[]){
   if(market.status&&market.status!=='open'||market.isAlternate||!['total','spread','handicap'].includes(market.type))continue;
   const total=market.type==='total',home=market.prices?.find(p=>p.designation===(total?'under':'home')),away=market.prices?.find(p=>p.designation===(total?'over':'away'));
   if(!home||!away)continue;const first=Number(home.decimal),second=Number(away.decimal),prob=fair([first,second]);if(prob==null)continue;
   const rawLine=Number(home.points),line=total?rawLine:(reversed?-rawLine:rawLine);if(!Number.isFinite(line))continue;
   const p=total?prob:reversed?1-prob:prob,key=[Number(market.period)||0,total?'total':'spread',line].join(':');
   if(!rows.has(key))rows.set(key,[]);rows.get(key).push(p);
  }
 }
 return new Map([...rows].map(([key,probabilities])=>[key,avg(probabilities)]));
}
function seriesPaths(ps,score){const result=[],target=(ps.length+1)/2;function go(a,b,w,path){if(a>=target||b>=target){result.push({a,b,p:w,path});return;}const i=a+b,p=ps[i];go(a+1,b,w*p,[...path,0]);go(a,b+1,w*(1-p),[...path,1]);}go(score[0],score[1],1,[]);return result;}
const win=(ps,score)=>seriesPaths(ps,score).reduce((s,v)=>s+(v.a>v.b?v.p:0),0);
function mapWin(q,a=0,b=0){
 const ot=q**4*(1+4*(1-q)+10*(1-q)**2)/(1-20*q**3*(1-q)**3),memo=new Map();
 function overtime(x,y){if(x===4)return 1;if(y===4)return 0;if(x===3&&y===3)return ot;return q*overtime(x+1,y)+(1-q)*overtime(x,y+1);}
 function go(x,y){if(x>=12&&y>=12){const base=12+3*Math.floor((Math.min(x,y)-12)/3);return overtime(x-base,y-base);}if(x>=13)return 1;if(y>=13)return 0;const key=x+':'+y;if(memo.has(key))return memo.get(key);const v=q*go(x+1,y)+(1-q)*go(x,y+1);memo.set(key,v);return v;}
 return go(a,b);
}
function mapDone(a,b){if(a<12||b<12)return Math.max(a,b)>=13;return Math.max(a,b)>=16+3*Math.floor((Math.min(a,b)-12)/3);}
function roundQ(p,a,b){let lo=.00001,hi=.99999;for(let i=0;i<38;i++){const q=(lo+hi)/2;if(mapWin(q,a,b)<p)lo=q;else hi=q;}return (lo+hi)/2;}
function prepare(event,{source='average',scoreSource,bestOf,margin=7.5,maxOdds=25,manualScore,scoreHistory=[]}={}){
 bestOf=Number(bestOf)||Number(event.bestOf);if(![1,3,5].includes(bestOf))throw Error('Выберите формат Bo1, Bo3 или Bo5');Pricing.price([{probability:.5},{probability:.5}],margin,maxOdds);
 const manual=scoreSource==='manual';
  const rawR=manual?{seriesScore:manualScore?.series,mapScores:manualScore?.maps,lastSeenAt:Date.now(),scoreObserved:true}:(event.sourceRefs||[]).find(r=>r.source===scoreSource);
  const orient=x=>x?.scoreReversed===true?{...x,seriesScore:x.seriesScore?.slice().reverse(),mapScores:x.mapScores?.map(p=>Array.isArray(p)?p.slice().reverse():p)}:x;
  const r=orient(rawR),score=r?.seriesScore;
 if(!r||r.scoreObserved===false||!Array.isArray(score)||score.length!==2||score.some(n=>!Number.isInteger(n)||n<0)||Date.now()-Number(r.lastSeenAt||r.updatedAt||0)>60000)throw Error('Нет свежего подтверждённого счёта выбранной конторы');
 const completed=score[0]+score[1],target=(bestOf+1)/2;if(score.some(n=>n>=target)||completed>=bestOf)throw Error('Матч уже завершён');
 if(r.activeMap&&r.activeMap!==completed+1)throw Error('Контора ещё не согласовала счёт серии и номер карты. Подождите обновления');
 const maps=r.mapScores||[],current=maps[completed];if(!Array.isArray(current)||current.length!==2||current.some(n=>!Number.isInteger(n)||n<0||n>150)||mapDone(...current))throw Error('Нет актуального счёта текущей карты или карта уже завершена');
 const historyComplete=maps.slice(0,completed).length===completed&&Array.from({length:completed},(_,i)=>maps[i]).every(m=>Array.isArray(m)&&m.length===2&&m.every(n=>Number.isInteger(n)&&n>=0&&n<=150)&&mapDone(...m));
 if(!manual&&!historyComplete)throw Error('Не хватает финальных счетов сыгранных карт — можно указать счёт вручную');
 const done=[0,0];if(historyComplete)for(let i=0;i<completed;i++)done[maps[i][0]>maps[i][1]?0:1]++;if(historyComplete&&done.some((n,i)=>n!==score[i]))throw Error('Счёт серии расходится с завершёнными картами. Подождите обновления');
  const conflicts=(event.sourceRefs||[]).filter(x=>x.scoreObserved!==false&&x.seriesScore&&orient(x).seriesScore.some((n,i)=>n!==score[i]));
  const oldRounds=(event.sourceRefs||[]).filter(x=>x!==rawR&&x.scoreObserved!==false&&Array.isArray(x.mapScores?.[completed])&&orient(x).mapScores[completed].some((n,i)=>n!==current[i]));
  const excluded=manual?[]:[...new Set([...conflicts,...oldRounds])];if(source!=='average'&&excluded.some(x=>x.source===source))throw Error('Выбранные конторы показывают разный счёт. Выберите согласованный источник');
 const inputEvent={...event,sourceRefs:(event.sourceRefs||[]).filter(x=>!excluded.includes(x))};
 const books=bookInputs(inputEvent,source),ps=Array(bestOf).fill(null),warnings=excluded.length?['Из усреднения исключены источники с другим счётом серии: '+excluded.map(x=>x.source).join(', ')]:[];if(manual&&conflicts.length)warnings.push('Ручной счёт отличается от счёта конторы. Исходные цены могут относиться к другому состоянию матча.');if(manual)warnings.push('Счёт задан вручную и не изменяется автоматически. Коэффициенты продолжают обновляться.');if(!historyComplete)warnings.push('Счета завершённых карт не заданы: тоталы и форы раундов всего матча не рассчитываются.');for(let i=completed;i<bestOf;i++)ps[i]=books[i+1]?.p??null;
 // The score path is useful when a book exposes only the match line. Read only
 // valid +1 round transitions; corrections/rollbacks are deliberately ignored.
 const hist=(Array.isArray(scoreHistory)?scoreHistory:[]).filter(h=>!manual&&h.source===scoreSource&&String(h.sourceEventId)===String(rawR.sourceEventId||rawR.id)).sort((a,b)=>Number(a.at)-Number(b.at)),roundWinners=[];let prev=null;
 for(const h of hist){const ms=h?.mapScores?.[completed];if(!Array.isArray(ms)||ms.length!==2)continue;const reverse=norm(h.team1)===norm(event.team2)&&norm(h.team2)===norm(event.team1);const cur=(reverse?ms.slice().reverse():ms).map(Number);if(prev){const da=cur[0]-prev[0],db=cur[1]-prev[1];if(da===1&&db===0)roundWinners.push(1);else if(da===0&&db===1)roundWinners.push(0);}prev=cur;}
 const recent=roundWinners.slice(-16),historyQ=recent.length>=4?(recent.reduce((a,b)=>a+b,0)+3)/(recent.length+6):null;
 const match=books[0];if(ps[completed]==null&&historyQ!=null){ps[completed]=mapWin(historyQ,...current);warnings.push('Текущая карта оценена по ходу счёта: '+recent.length+' последних подтверждённых переходов; исправления счёта исключены.');}
 let unknown=ps.slice(completed).some(p=>p==null);if(unknown&&!match)throw Error('Нужны открытые исходы матча/карт либо достаточная история текущей карты');
 if(unknown){const calc=q=>win(ps.map((p,i)=>i<completed?.5:p??q),score);if(match.p<calc(0)-1e-8||match.p>calc(1)+1e-8)throw Error('Исходы, счёт и история не согласованы. Выберите одну контору или дождитесь обновления');let lo=0,hi=1;for(let i=0;i<55;i++){const q=(lo+hi)/2;if(calc(q)<match.p)lo=q;else hi=q;}for(let i=completed;i<bestOf;i++)if(ps[i]==null)ps[i]=(lo+hi)/2;warnings.push(historyQ!=null?'Вероятности будущих карт восстановлены отдельно из исхода матча.':'Для неизвестных оставшихся карт принята одинаковая условная вероятность.');}
 const predicted=win(ps,score);if(match&&!unknown&&Math.abs(predicted-match.p)>.01)warnings.push('Цены всех карт дают исход матча '+(predicted*100).toFixed(1)+'%, а цена матча — '+(match.p*100).toFixed(1)+'%. Приоритет отдан явно заданным картам.');
 return {names:[event.team1,event.team2],bestOf,margin:Number(margin),maxOdds:Number(maxOdds),score,maps,current,completed,ps,books,warnings,scoreSource,historyComplete,quotedRefs:inputEvent.sourceRefs};
}
function generate(event,options={}){
 const v=prepare(event,options),{names,bestOf,score,current,completed,ps}=v,paths=seriesPaths(ps,score),categories=[],direct=directLines({...event,sourceRefs:v.quotedRefs},options.source||'average');
 const market=(title,labels,weights,extra={})=>{const found=title.match(/^(Матч|Карта (\d+)) · (тотал раундов|фора) ([+-]?\d+(?:\.\d+)?)$/),key=found?[found[2]||0,found[3]==='фора'?'spread':'total',Number(found[4])].join(':'):null,exact=key&&direct.get(key),p=exact==null?weights[0]:exact;return {title,available:(exact!=null||weights.filter(w=>w>1e-12).length>1),outcomes:Pricing.price(labels.map((label,i)=>({label,probability:exact==null?weights[i]:i===0?p:1-p})),v.margin,v.maxOdds),...(exact!=null?{note:'На основе открытой линии'}:{}),...extra};};
 const pwin=win(ps,score),match={id:'match',name:'Матч',markets:[]};match.markets.push(market('Победитель матча',names,[pwin,1-pwin]));const scores=[...new Set(paths.map(p=>p.a+':'+p.b))];match.markets.push(market('Точный счёт по картам',scores,scores.map(k=>paths.reduce((s,p)=>s+(p.a+':'+p.b===k?p.p:0),0))));
 for(let line=(bestOf+1)/2+.5;line<bestOf;line++){const under=paths.reduce((s,p)=>s+(p.a+p.b<line?p.p:0),0);match.markets.push(market('Тотал карт '+line,['Меньше','Больше'],[under,1-under]));}
 for(let line=-bestOf+.5;line<bestOf;line++){const p=paths.reduce((s,r)=>s+(r.a-r.b+line>0?r.p:0),0);match.markets.push(market('Фора по картам '+(line>0?'+':'')+line,names,[p,1-p]));}categories.push(match);
 let seed=1234567;const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;},samples=10000,q=ps.map((p,i)=>i<completed?null:roundQ(p,...(i===completed?current:[0,0]))),buckets=Array.from({length:bestOf},()=>[]),series=[];
 function simulate(i){let [a,b]=i===completed?current:[0,0],steps=0;while(!mapDone(a,b)){if(rng()<q[i])a++;else b++;if(++steps>600)throw Error('Не удалось завершить симуляцию карты');}return {a,b,total:a+b,ot:a>=12&&b>=12};}
 for(let n=0;n<samples;n++){let [a,b]=score,ra=0,rb=0;if(v.historyComplete)for(let j=0;j<completed;j++){ra+=v.maps[j][0];rb+=v.maps[j][1];}for(let i=completed;i<bestOf&&a<(bestOf+1)/2&&b<(bestOf+1)/2;i++){const m=simulate(i);buckets[i].push(m);ra+=m.a;rb+=m.b;if(m.a>m.b)a++;else b++;}series.push({a:ra,b:rb,total:ra+rb});}
 // Calibrate the shape of the simulated round distribution to the nearest
 // quoted total and handicap. This corrects neighbouring lines as well as the
 // quoted line, which is priced directly above after removing bookmaker vig.
 for(let i=completed;i<bestOf;i++){
  const rows=buckets[i],references=[...direct].filter(([key])=>key.startsWith((i+1)+':'));
  if(!rows.length||!references.length)continue;
  const median=rows.map(r=>r.total).sort((a,b)=>a-b)[rows.length>>1];
  const chosen=['total','spread'].map(type=>references.filter(([key])=>key.split(':')[1]===type).sort((a,b)=>Math.abs(Number(a[0].split(':')[2])-(type==='total'?median:0))-Math.abs(Number(b[0].split(':')[2])-(type==='total'?median:0)))[0]).filter(Boolean);
  for(const row of rows)row.weight=1;
  for(let step=0;step<6;step++)for(const [key,target] of chosen){const [,type,lineText]=key.split(':'),line=Number(lineText),hit=r=>type==='total'?r.total<line:r.a-r.b+line>0,yes=rows.reduce((n,r)=>n+(hit(r)?r.weight:0),0),no=rows.reduce((n,r)=>n+(!hit(r)?r.weight:0),0);if(!yes||!no)continue;const total=yes+no;for(const r of rows)r.weight*=hit(r)?Math.max(.05,Math.min(20,target*total/yes)):Math.max(.05,Math.min(20,(1-target)*total/no));const sum=rows.reduce((n,r)=>n+r.weight,0);for(const r of rows)r.weight*=rows.length/sum;}
 }
 const probability=(rows,fn)=>rows.reduce((s,r)=>s+Number(fn(r))*(r.weight??1),0)/rows.reduce((s,r)=>s+(r.weight??1),0);
 function roundMarkets(rows,prefix){const out=[],period=Number(prefix.match(/Карта (\d+)/)?.[1])||0,totals=rows.map(r=>r.total).sort((a,b)=>a-b),middle=totals[Math.floor(totals.length/2)],lines=new Set();for(let line=Math.max(.5,middle-5.5);line<=middle+5.5;line++)lines.add(line);for(const key of direct.keys())if(key.startsWith(period+':total:'))lines.add(Number(key.split(':')[2]));for(const line of [...lines].sort((a,b)=>a-b)){const p=probability(rows,r=>r.total<line);out.push(market(prefix+' · тотал раундов '+line,['Меньше','Больше'],[p,1-p]));}const diffs=rows.map(r=>r.a-r.b).sort((a,b)=>a-b),center=-diffs[Math.floor(diffs.length/2)],spreads=new Set();for(let line=center-4.5;line<center+5;line++)spreads.add(line);for(const key of direct.keys())if(key.startsWith(period+':spread:'))spreads.add(Number(key.split(':')[2]));for(const line of [...spreads].sort((a,b)=>a-b)){const p=probability(rows,r=>r.a-r.b+line>0);out.push(market(prefix+' · фора '+(line>0?'+':'')+line,names,[p,1-p]));}return out;}
 if(v.historyComplete)match.markets.push(...roundMarkets(series,'Матч'));
 for(let i=completed;i<bestOf;i++){const rows=buckets[i];if(!rows.length)continue;const ms=[market('Победитель карты',names,[ps[i],1-ps[i]]),...roundMarkets(rows,'Карта '+(i+1))],ot=probability(rows,r=>r.ot);ms.push(market('Будет овертайм',['Да','Нет'],[ot,1-ot]));const counts=new Map();for(const r of rows){const key=r.a+':'+r.b;counts.set(key,(counts.get(key)||0)+1);}const top=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,12);const used=top.reduce((s,x)=>s+x[1],0);ms.push(market('Точный счёт раундов',[...top.map(x=>x[0]),'Другой счёт'],[...top.map(x=>x[1]/rows.length),(rows.length-used)/rows.length]));categories.push({id:'map-'+(i+1),name:'Карта '+(i+1),condition:i===completed?'Текущий счёт '+current.join(':'):'Если будет сыграна · '+(rows.length/samples*100).toFixed(1)+'%',markets:ms});}
 const {quotedRefs,...publicInputs}=v;
 return {categories,generatedAt:Date.now(),inputs:publicInputs,notes:[...v.warnings,'Счёт не усредняется. Усредняются равновзвешенные вероятности после снятия маржи каждой конторы.','Используются исходы матча/карт, текущий счёт и серверная история его изменений. Экономика, стороны и составы не учитываются; производные рынки раундов приблизительные.'],samples};
}
const api={bookInputs,prepare,generate,mapWin,mapDone,seriesPaths};if(typeof module==='object'&&module.exports)module.exports=api;else root.LiveModel=api;
})(globalThis);
