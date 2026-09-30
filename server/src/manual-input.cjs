const OddsPricing=require('./odds-pricing.cjs');
(function(root){
'use strict';
const num=v=>Number(String(v??'').trim().replace(',','.'));
function probability(pair,optional=false){
 const empty=pair.map(v=>String(v??'').trim()==='');if(empty.every(Boolean)&&optional)return null;
 const a=pair.map(num);if(empty.some(Boolean)||a.some(x=>!Number.isFinite(x)||x<=1||x>10000))throw Error('Укажите оба коэффициента от 1 до 10000, строго больше 1');
 const sum=1/a[0]+1/a[1];return {p:(1/a[0])/sum,overround:(sum-1)*100,odds:a};
}
function paths(ps){const out=[],target=(ps.length+1)/2;function step(a,b,p,played){if(a===target||b===target){out.push({a,b,p,played});return;}const q=ps[a+b];step(a+1,b,p*q,[...played,0]);step(a,b+1,p*(1-q),[...played,1]);}step(0,0,1,[]);return out;}
const win=ps=>paths(ps).reduce((s,x)=>s+(x.a>x.b?x.p:0),0);
function prepare({names,odds,bestOf,margin,maxOdds=25,maps=[]}){
 bestOf=Number(bestOf);margin=num(margin);maxOdds=num(maxOdds);if(![1,3,5].includes(bestOf))throw Error('Выберите Bo1, Bo3 или Bo5');if(!Number.isFinite(margin)||margin<0||margin>25)throw Error('Маржа должна быть от 0 до 25%');if(!Number.isFinite(maxOdds)||maxOdds<1.01||maxOdds>10000)throw Error('Максимальный коэффициент должен быть от 1.01 до 10000');
 names=names.map(x=>String(x||'').trim().slice(0,120));if(names.some(x=>!x)||names[0].toLowerCase()===names[1].toLowerCase())throw Error('Укажите названия двух разных команд');
 const named=maps.slice(0,bestOf).map(m=>String(m.name||'').trim().toLowerCase()).filter(Boolean);if(new Set(named).size!==named.length)throw Error('Названия известных карт не должны повторяться');
 const match=probability(odds,true),inputs=Array.from({length:bestOf},(_,i)=>probability(maps[i]?.odds||['',''],true));
 if(!match&&inputs.some(x=>!x))throw Error('Укажите коэффициенты матча или коэффициенты всех карт');
 let ps=inputs.map(x=>x?.p??null),unknown=ps.some(x=>x==null),q=.5;
 if(match&&unknown){const calc=q=>win(ps.map(x=>x??q)),loP=calc(0),hiP=calc(1);if(match.p<loP-1e-10||match.p>hiP+1e-10)throw Error('Коэффициенты матча несовместимы с указанными картами. Исправьте ввод или уберите часть коэффициентов карт');let lo=0,hi=1;for(let i=0;i<60;i++){const m=(lo+hi)/2;if(calc(m)<match.p)lo=m;else hi=m;}q=(lo+hi)/2;ps=ps.map(x=>x??q);}
 if(match&&!unknown&&Math.abs(win(ps)-match.p)>.01)throw Error('Исход матча расходится с расчётом по картам более чем на 1 п.п. Оставьте исход матча пустым или скорректируйте карты');
 if(ps.some(p=>p<.001||p>.999))throw Error('Вероятность карты слишком близка к 0 или 100%. Уточните коэффициенты');
 return {names,bestOf,margin,maxOdds,ps,match,inputs,maps:Array.from({length:bestOf},(_,i)=>String(maps[i]?.name||'').trim().slice(0,60)||'Карта '+(i+1)),paths:paths(ps),probability:win(ps)};
}
function finish(result,manual){
 const price=(labels,weights)=>OddsPricing.price(labels.map((label,i)=>({label,probability:weights[i]})),manual.margin,manual.maxOdds),paths=manual.paths;
 for(const market of result.categories[0].markets){const labels=market.outcomes?.map(x=>x.label);if(!labels)continue;let weights;
 if(market.title==='Победитель матча')weights=[manual.probability,1-manual.probability];
 else if(market.title==='Точный счёт по картам')weights=labels.map(label=>paths.reduce((s,x)=>s+(x.a+':'+x.b===label?x.p:0),0));
 else if(market.title==='Тотал карт')weights=[paths.reduce((s,x)=>s+(x.a+x.b<market.line?x.p:0),0),0];
 else if(market.title==='Фора по картам')weights=[paths.reduce((s,x)=>s+(x.a-x.b+market.line>0?x.p:0),0),0];
 else if(market.title==='Тотал карт: чёт / нечёт')weights=[paths.reduce((s,x)=>s+((x.a+x.b)%2===0?x.p:0),0),0];
 else{const side=manual.names.findIndex(n=>market.title===n+' выиграет хотя бы одну карту');if(side>=0)weights=[paths.reduce((s,x)=>s+((side===0?x.a:x.b)>0?x.p:0),0),0];}
 if(weights){if(weights.length===2&&market.title!=='Победитель матча')weights[1]=1-weights[0];market.outcomes=price(labels,weights);market.note='Точный расчёт по вероятностям карт; независимость исходов карт';}
 }
 for(let i=0;i<manual.bestOf;i++){
 const c=result.categories.find(c=>c.id==='map-'+(i+1)),reach=paths.reduce((s,x)=>s+(x.played.length>i?x.p:0),0);c.condition='Если карта будет сыграна · вероятность '+(reach*100).toFixed(1)+'%';
 for(const m of c.markets){if(m.title==='Победитель карты, включая ОТ'){m.outcomes=price(manual.names,[manual.ps[i],1-manual.ps[i]]);m.note=manual.inputs[i]?'Из введённых коэффициентов карты':'Оценка из исхода матча и допущения о равной силе на неизвестных картах';}
 else if(m.title==='Победитель матча / карты'){const weights=[0,0,0,0];for(const x of paths)if(x.played.length>i)weights[(x.a>x.b?0:2)+x.played[i]]+=x.p/reach;m.outcomes=price(m.outcomes.map(x=>x.label),weights);}
 else if(/пистолет|первого пистолетного/.test(m.title)||/^Победитель раунда (1|13)$/.test(m.title)){m.available=false;m.reason='По коэффициентам исхода нельзя определить силу в пистолетных раундах';delete m.outcomes;}
 }
 }
 result.teams=manual.names.map((name,i)=>({id:i+1,name}));delete result.ratingScenarioRange;result.sources=[];result.manual=manual;result.modelVersion='CS2-MANUAL-2';result.maxOdds=manual.maxOdds;result.validation={message:'Вероятности получены из ручного ввода. Рынки раундов — приближение MR12/MR3, без независимой проверки.'};result.methods=['Пропорциональное снятие маржи входных коэффициентов','Точное дерево независимых исходов карт','Подбор вероятности неизвестных карт под исход матча','MR12/MR3 с калиброванной волатильностью силы раундов для приблизительных рынков','Ограничение итогового коэффициента значением '+manual.maxOdds];result.warnings=['Это расчёт от введённых цен, а не независимый прогноз HLTV.','Вероятности неизвестных карт предполагаются одинаковыми.','Рынки раундов зависят от допущений: исход матча не определяет их однозначно.','Калибровка волатильности раундов настроена по предоставленному снимку букмекерской линии 100 Thieves - Astralis и пока не является независимой валидацией на большой выборке.'];return result;
}
const api={prepare,paths,win,probability,finish};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ManualInput=api;
})(globalThis);
