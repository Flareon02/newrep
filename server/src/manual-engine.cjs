const OddsPricing=require('./odds-pricing.cjs');
const Pricing=OddsPricing;
const DAY=86400000,clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),sigmoid=x=>1/(1+Math.exp(-clamp(x,-30,30))),logit=p=>Math.log(clamp(p,1e-7,1-1e-7)/(1-clamp(p,1e-7,1-1e-7)));
const average=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
function random(seed){let a=Number(seed)>>>0;return()=>{a+=0x6D2B79F5;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
function normal(rng){return Math.sqrt(-2*Math.log(Math.max(1e-12,rng())))*Math.cos(2*Math.PI*rng());}
function gamma(k,rng){if(k<1)return gamma(k+1,rng)*rng()**(1/k);const d=k-1/3,c=1/Math.sqrt(9*d);for(;;){const x=normal(rng),v=(1+c*x)**3;if(v<=0)continue;const u=rng();if(u<1-.0331*x**4||Math.log(u)<.5*x*x+d*(1-v+Math.log(v)))return d*v;}}
function poisson(mu,rng){let p=1,n=0;const limit=Math.exp(-mu);do{p*=rng();n++;}while(p>limit&&n<1000);return n-1;}
function beta(a,b,rng){const x=gamma(a,rng),y=gamma(b,rng);return x/(x+y);}
function hash(text){let h=2166136261;for(const c of text)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
function seriesProbability(p,bestOf){const target=(bestOf+1)/2;let answer=0;function go(a,b,w){if(a===target){answer+=w;return;}if(b===target)return;go(a+1,b,w*p);go(a,b+1,w*(1-p));}go(0,0,1);return answer;}
// Time-weighted, regularized Bradley-Terry likelihood of map wins. The score
// supplies the number of Bernoulli outcomes, rather than treating a Bo3 as Bo1.
function fitRatings(matches,asOf=Date.now()){
 const rows=matches.filter(m=>m.at<asOf&&m.at>=asOf-180*DAY&&m.teamA!==m.teamB&&m.scoreA>=0&&m.scoreB>=0&&m.scoreA+m.scoreB>0&&Math.max(m.scoreA,m.scoreB)<=3).sort((a,b)=>a.at-b.at).slice(-2500);
 const ratings=new Map();for(const m of rows)for(const id of [m.teamA,m.teamB])if(!ratings.has(id))ratings.set(id,{mu:0,precision:2,effectiveMaps:0,matches:0});
 const input=rows.map(m=>({...m,weight:Math.exp(-Math.LN2*(asOf-m.at)/(45*DAY))}));
 for(let iteration=0;iteration<100;iteration++){
  const d=new Map([...ratings].map(([id,r])=>[id,{gradient:-2*r.mu,precision:2}]));
  for(const m of input){const a=ratings.get(m.teamA),b=ratings.get(m.teamB),p=sigmoid(a.mu-b.mu),n=m.scoreA+m.scoreB,g=m.weight*(m.scoreA-n*p),h=m.weight*n*p*(1-p);d.get(m.teamA).gradient+=g;d.get(m.teamB).gradient-=g;d.get(m.teamA).precision+=h;d.get(m.teamB).precision+=h;}
  let change=0;for(const [id,r] of ratings){const v=d.get(id),step=.45*v.gradient/v.precision;r.mu+=step;r.precision=v.precision;change=Math.max(change,Math.abs(step));}if(change<1e-6)break;
 }
 for(const m of input)for(const id of [m.teamA,m.teamB]){ratings.get(id).effectiveMaps+=m.weight*(m.scoreA+m.scoreB);ratings.get(id).matches++;}
 return {ratings,count:rows.length,asOf};
}
function validation(matches,now){
 const rows=matches.filter(m=>m.at<now&&m.at>now-180*DAY&&m.scoreA!==m.scoreB).sort((a,b)=>a.at-b.at);
 if(rows.length<150)return {status:'insufficient',matches:rows.length,message:'Для независимой проверки и калибровки нужно минимум 150 исторических матчей. Точность полной модели не подтверждена.',temperature:1};
 const cut1=rows[Math.floor(rows.length*.6)].at,cut2=rows[Math.floor(rows.length*.8)].at,train=rows.filter(m=>m.at<cut1),cal=rows.filter(m=>m.at>=cut1&&m.at<cut2),test=rows.filter(m=>m.at>=cut2);
 if(train.length<60||cal.length<20||test.length<20)return {status:'insufficient',matches:rows.length,temperature:1,message:'Недостаточно матчей с разными датами для независимого обучения, калибровки и проверки.'};
 const base=fitRatings(train,cut1),prob=(model,m,t)=>seriesProbability(sigmoid(((model.ratings.get(m.teamA)?.mu||0)-(model.ratings.get(m.teamB)?.mu||0))/t),Math.max(m.scoreA,m.scoreB)*2-1),loss=(p,y)=>-(y?Math.log(clamp(p,1e-9,1)):Math.log(clamp(1-p,1e-9,1)));
 let temperature=1,best=Infinity;for(const t of [.8,1,1.2,1.5,2,3]){const l=average(cal.map(m=>loss(prob(base,m,t),m.scoreA>m.scoreB)));if(l<best){best=l;temperature=t;}}
 const final=fitRatings(rows.filter(m=>m.at<cut2),cut2),pred=test.map(m=>({p:prob(final,m,temperature),y:m.scoreA>m.scoreB?1:0}));
 return {status:'component-only',temperature,train:train.length,calibration:cal.length,test:test.length,logLoss:average(pred.map(x=>loss(x.p,x.y))),brier:average(pred.map(x=>(x.p-x.y)**2)),message:'Хронологическая проверка только рейтинга команд. Рынки карт, раундов и игроков ещё не прошли независимую калибровку.'};
}
function ratingMean(team){const ps=(team.players||[]).filter(p=>p.ratingVersion==='3.0'&&Number.isFinite(p.rating));return {count:ps.length,mean:average(ps.map(p=>1+(p.rating-1)*Math.min(1,(p.ratingMaps||p.maps||0)/30))),players:ps};}
function strength(team,ratings){const base=ratings.get(team.id)||{mu:0,precision:2,effectiveMaps:0,matches:0},r=ratingMean(team),overlap=team.rosterOverlap??1;
 const playerAdjustment=r.count>=3?2*(r.mean-1)*r.count/5:0;
 return {...base,mu:base.mu*overlap+playerAdjustment,sigma:Math.sqrt(1/base.precision+(1-overlap)*.35+(r.count<3?.05:0)),rosterRating:r.mean||null,rosterRated:r.count,playerAdjustment};
}
// Exact absorption probability for MR12 and repeated MR3 overtime. Pistol
// rounds have their own probability. This calibrates round p to map p.
function roundMapProbability(q,pistol=q){
 const dp=Array.from({length:14},()=>new Float64Array(14));dp[0][0]=1;let win=0,tie=0;
 for(let total=0;total<=24;total++)for(let a=0;a<=13;a++){const b=total-a;if(b<0||b>13)continue;const w=dp[a][b];if(!w)continue;if(a===13){win+=w;continue;}if(b===13)continue;if(a===12&&b===12){tie+=w;continue;}const p=total===0||total===12?pistol:q;dp[a+1][b]+=w*p;dp[a][b+1]+=w*(1-p);}
 // Six-round overtime: 4:0, 4:1, 4:2. At 3:3 the same game restarts.
 const otWin=q**4*(1+4*(1-q)+10*(1-q)**2),otTie=20*q**3*(1-q)**3;
 return win+tie*otWin/(1-otTie);
}
const GH_X=[-2.020182870456086,-.9585724646138185,0,.9585724646138185,2.020182870456086],GH_W=[.01995324205904591,.3936193231522412,.9453087204829419,.3936193231522412,.01995324205904591],SQRT_PI=Math.sqrt(Math.PI);
function volatileMapProbability(baseQ,pistol,sigma=.38){let sum=0;for(let i=0;i<GH_X.length;i++){const shock=Math.SQRT2*GH_X[i]*sigma,q=sigmoid(logit(baseQ)+shock),pp=sigmoid(logit(pistol)+shock*.65);sum+=GH_W[i]*roundMapProbability(q,pp);}return sum/SQRT_PI;}
function roundForVolatile(p,pistol,sigma=.38){let lo=.001,hi=.999;for(let i=0;i<30;i++){const mid=(lo+hi)/2;if(volatileMapProbability(mid,pistol,sigma)<p)lo=mid;else hi=mid;}return (lo+hi)/2;}
function mapStats(team,name){return team.maps?.find(m=>m.name===name);}
function mapBias(team,name){const m=mapStats(team,name);if(!m?.played)return {mean:0,sd:.25};const all=team.maps||[],wins=all.reduce((s,m)=>s+m.wins,0),n=all.reduce((s,m)=>s+m.played,0),base=(wins+5)/(n+10),local=(m.wins+10*base)/(m.played+10);return {mean:(logit(local)-logit(base))*.5,sd:Math.sqrt(1/(m.wins+5)+1/(m.losses+5))*.22};}
function pistolChance(a,b,name){const ma=mapStats(a,name),mb=mapStats(b,name);const rate=m=>m?.pistol==null?.5:(m.pistol*2*m.played+10)/(2*m.played+20);return sigmoid(logit(rate(ma))-logit(rate(mb)));}
function choose(weights,rng){const total=weights.reduce((s,x)=>s+x[1],0);let n=rng()*total;for(const [key,w] of weights){n-=w;if(n<=0)return key;}return weights.at(-1)[0];}
function vetoOrder(a,b,pool,selected,bestOf,rng){const available=new Set(pool),out=[];for(let i=0;i<bestOf;i++){
 const explicit=selected?.[i];if(explicit){out.push(explicit);available.delete(explicit);continue;}
 const reserved=new Set((selected||[]).slice(i+1).filter(Boolean)),remaining=[...available].filter(x=>!reserved.has(x));
 const team=i%2===0?a:b,opponent=i%2===0?b:a;const weights=remaining.map(name=>{const m=mapStats(team,name),other=mapStats(opponent,name);return [name,(.1+(m?.pick??.2))*(.2+1-(m?.ban??0))*(.2+1-(other?.ban??0))*Math.sqrt(1+(m?.played||0))];});
 const map=choose(weights,rng);out.push(map);available.delete(map);
 }return out;}
function simulateMap(q,pistol,rng){
 let a=0,b=0;const rounds=[];while(a<13&&b<13&&!(a===12&&b===12)){const p=rounds.length===0||rounds.length===12?pistol:q,v=rng()<p;rounds.push(v);if(v)a++;else b++;}
 const regA=a,regB=b,ot=a===12&&b===12;let blocks=0;
 while(a===b&&ot){let x=0,y=0;while(x<4&&y<4&&!(x===3&&y===3)){const v=rng()<q;rounds.push(v);if(v)x++;else y++;}a+=x;b+=y;if(++blocks>30)throw Error('Не удалось завершить моделирование овертайма');}
 const first=rounds.slice(0,12).filter(Boolean).length,second=rounds.slice(12,regA+regB).filter(Boolean).length;
 return {a,b,total:a+b,winner:a>b?0:1,regA,regB,ot,first,second,secondLength:regA+regB-12,pistol1:rounds[0]?0:1,pistol2:rounds[12]?0:1,rounds};
}
function counter(){return {n:0,samples:[],names:{}};}
function outcomes(samples,key,labels){const c=new Array(labels.length).fill(0);for(const s of samples){const i=key(s);if(Number.isInteger(i)&&i>=0&&i<labels.length)c[i]++;}const n=c.reduce((s,x)=>s+x,0);return n?labels.map((label,i)=>({label,probability:c[i]/n})):null;}
function generateOdds(data,options={},progress=()=>{}){
 const now=Number(options.now)||Date.now(),bestOf=Number(options.bestOf)||3,margin=Number(options.margin??7.5),maxOdds=options.maxOdds==null||options.maxOdds===''?null:Number(options.maxOdds),roundVolatilityRaw=Number(options.roundVolatility??.38),roundVolatility=Number.isFinite(roundVolatilityRaw)?clamp(roundVolatilityRaw,0,.8):.38,samples=clamp(Number(options.samples)||16000,2000,30000);
 if(![1,3,5].includes(bestOf))throw Error('Поддерживаются Bo1, Bo3 и Bo5');Pricing.price([{probability:.5},{probability:.5}],margin,maxOdds);
 const teams=options.teams;if(!Array.isArray(teams)||teams.length!==2)throw Error('Выберите две команды');const [a,b]=teams;if(a.id===b.id)throw Error('Нужны разные команды');
 const playerIds=teams.flatMap(t=>(t.players||[]).map(p=>p.id));if(new Set(playerIds).size<playerIds.length)throw Error('Один игрок не может играть за обе команды или повторяться в составе');
 const fitted={ratings:new Map(),count:0},sa=strength(a,fitted.ratings),sb=strength(b,fitted.ratings);

 const pool=[...new Set([...a.maps||[],...b.maps||[]].map(m=>m.name))].sort();if(pool.length<bestOf)throw Error('Недостаточно данных о пуле карт. Импортируйте страницы команд HLTV со статистикой карт.');
 const selected=Array.from({length:bestOf},(_,i)=>options.maps?.[i]||'');if(selected.some(n=>n&&!pool.includes(n))||new Set(selected.filter(Boolean)).size!==selected.filter(Boolean).length)throw Error('Выберите разные карты из доступного пула');
 const checked={temperature:1},temperature=checked.temperature,delta=sa.mu-sb.mu,sd=Math.sqrt(sa.sigma**2+sb.sigma**2),rng=random(options.seed??hash(JSON.stringify([a.id,b.id,selected,bestOf,now-(now%3600000)])));
 const prepared=new Map(pool.map(name=>{const ba=mapBias(a,name),bb=mapBias(b,name),pistol=pistolChance(a,b,name);return [name,{mean:delta+ba.mean-bb.mean,sd:Math.hypot(ba.sd,bb.sd),pistol,lookup:new Map()}];}));
 const all=[],mapBuckets=Array.from({length:bestOf},counter),ratedPlayers=teams.map(t=>(t.players||[]).filter(p=>p.kpr>0&&p.kpr<2&&p.rounds>100));
 progress(12);
 for(let i=0;i<samples;i++){
  const latent=0,order=selected,series={a:0,b:0,roundA:0,roundB:0,maps:[]};
  for(let j=0;j<bestOf;j++){
   if(series.a===(bestOf+1)/2||series.b===(bestOf+1)/2)break;
   const name=order[j],model=prepared.get(name),mapP=options.manualProbabilities[j],bucket=mapP*500,key=bucket;
   if(!model.lookup.has(key))model.lookup.set(key,roundForVolatile(bucket/500,model.pistol,roundVolatility));
   const baseQ=model.lookup.get(key),shock=normal(rng)*roundVolatility,q=sigmoid(logit(baseQ)+shock),pistol=sigmoid(logit(model.pistol)+shock*.65);
   const m=simulateMap(q,pistol,rng);m.name=name;m.player={};
   for(let side=0;side<2;side++)for(const p of ratedPlayers[side]){
    // Gamma-Poisson, conditional on simulated duration. The dispersion is a
    // stated weak prior, not an empirical claim about an unobserved player.
    const exposure=Math.min(2000,p.rounds),kpr=(p.kpr*exposure+.65*200)/(exposure+200),rate=gamma(20,rng)*kpr/20,kills=Math.min(m.total*5,poisson(rate*m.total,rng));
    let hs=null;if(p.headshots>=0&&p.headshots<=1){const fraction=beta(p.headshots*100+2,(1-p.headshots)*100+2,rng);hs=0;for(let k=0;k<kills;k++)if(rng()<fraction)hs++;}
    m.player[p.id]={kills,headshots:hs};
   }
   if(m.winner===0)series.a++;else series.b++;series.roundA+=m.a;series.roundB+=m.b;series.maps.push(m);mapBuckets[j].samples.push(m);mapBuckets[j].n++;mapBuckets[j].names[name]=(mapBuckets[j].names[name]||0)+1;
  }
  all.push(series);if(i%2000===0)progress(15+Math.round(i/samples*70));
 }
 const categories=[],addCategory=(id,title)=>{const c={id,title,markets:[]};categories.push(c);return c;},match=addCategory('match','Матч'),rounds=addCategory('rounds','Раунды матча');
 let marketId=0;
 function add(c,title,rows,selector,labels,extra={}){const os=outcomes(rows,selector,labels);const m={id:'market-'+(++marketId),title,...extra};if(!os){c.markets.push({...m,available:false,reason:'Нет наблюдений для этого условия'});return;}c.markets.push({...m,available:true,sampleCount:rows.length,outcomes:Pricing.price(os,margin,maxOdds)});}
 function unavailable(c,title,reason){c.markets.push({id:'market-'+(++marketId),title,available:false,reason});}
 function total(c,title,rows,value,line,extra={}){add(c,title,rows,x=>value(x)>line?1:0,['Меньше '+line,'Больше '+line],{line,...extra});}
 function handicap(c,title,rows,value,line,extra={}){add(c,title,rows,x=>value(x)+line>0?0:1,[a.name+' '+(line>0?'+':'')+line,b.name+' '+(-line>0?'+':'')+(-line)],{line,...extra});}
 add(match,'Победитель матча',all,s=>s.a>s.b?0:1,[a.name,b.name]);
 const target=(bestOf+1)/2,scoreLabels=[];for(let i=0;i<target;i++)scoreLabels.push(target+':'+i);for(let i=0;i<target;i++)scoreLabels.push(i+':'+target);
 add(match,'Точный счёт по картам',all,s=>scoreLabels.indexOf(s.a+':'+s.b),scoreLabels);
 if(bestOf>1){for(let t=target+.5;t<bestOf;t++)total(match,'Тотал карт',all,s=>s.a+s.b,t);for(let h=-target+.5;h<target;h++)handicap(match,'Фора по картам',all,s=>s.a-s.b,h);add(match,'Тотал карт: чёт / нечёт',all,s=>(s.a+s.b)%2,['Чёт','Нечёт']);}
 for(const [side,team] of [[0,a],[1,b]])add(match,team.name+' выиграет хотя бы одну карту',all,s=>(side===0?s.a:s.b)>0?0:1,['Да','Нет']);
 const meanTotal=average(all.map(s=>s.roundA+s.roundB)),meanDiff=average(all.map(s=>s.roundA-s.roundB));
 for(let d=-5;d<=5;d++){total(rounds,'Тотал раундов',all,s=>s.roundA+s.roundB,Math.max(12,Math.floor(meanTotal)+d)+.5);handicap(rounds,'Фора по раундам',all,s=>s.roundA-s.roundB,Math.floor(-meanDiff)+d+.5);}
 for(const [side,team] of [[0,a],[1,b]]){const mean=average(all.map(s=>side===0?s.roundA:s.roundB));for(let d=-2;d<=2;d++)total(rounds,'Тотал раундов '+team.name,all,s=>side===0?s.roundA:s.roundB,Math.max(0,Math.floor(mean)+d)+.5);}
 for(let index=0;index<bestOf;index++){
  const bucket=mapBuckets[index],ss=bucket.samples,c=addCategory('map-'+(index+1),'Карта '+(index+1)),pc=addCategory('players-'+(index+1),'Игроки · карта '+(index+1));
  c.condition='При условии, что карта будет сыграна; вероятность '+(bucket.n/samples*100).toFixed(1)+'%';c.mapMix=Object.entries(bucket.names).map(([name,n])=>({name,probability:n/bucket.n}));pc.condition=c.condition;
  add(c,'Победитель карты, включая ОТ',ss,s=>s.winner,[a.name,b.name]);
  add(c,'Исход в основное время',ss,s=>s.regA===s.regB?1:s.regA>s.regB?0:2,[a.name,'Ничья 12:12',b.name]);
  add(c,'Будет овертайм',ss,s=>s.ot?0:1,['Да','Нет']);
  for(let t=16.5;t<=28.5;t++)total(c,'Тотал раундов на карте, включая ОТ',ss,s=>s.total,t);
  for(let h=-10.5;h<=10.5;h++)handicap(c,'Фора по раундам на карте, включая ОТ',ss,s=>s.a-s.b,h);
  for(const [side,team] of [[0,a],[1,b]])for(let t=4.5;t<=14.5;t++)total(c,'Тотал раундов '+team.name,ss,s=>side===0?s.a:s.b,t);
  add(c,'Тотал раундов: чёт / нечёт',ss,s=>s.total%2,['Чёт','Нечёт']);
  const exact=[];for(let i=0;i<12;i++)exact.push('13:'+i);exact.push('12:12');for(let i=0;i<12;i++)exact.push(i+':13');
  add(c,'Точный счёт в основное время',ss,s=>exact.indexOf(s.regA+':'+s.regB),exact);
  add(c,'Победитель первой половины',ss,s=>s.first===6?1:s.first>6?0:2,[a.name,'Ничья',b.name]);
  add(c,'Победитель второй половины (сыгранные раунды без ОТ)',ss,s=>s.second*2===s.secondLength?1:s.second*2>s.secondLength?0:2,[a.name,'Ничья',b.name]);
  const halfScores=Array.from({length:13},(_,i)=>i+':'+(12-i));add(c,'Точный счёт первой половины',ss,s=>s.first,halfScores);
  for(let h=-5.5;h<=5.5;h++)handicap(c,'Фора первой половины',ss,s=>s.first*2-12,h);
  for(let t=2.5;t<=9.5;t++)for(const [side,team] of [[0,a],[1,b]])total(c,'Тотал первой половины '+team.name,ss,s=>side===0?s.first:12-s.first,t);
  for(const n of [1,2])add(c,'Победитель пистолетного раунда '+n,ss,s=>s['pistol'+n],[a.name,b.name]);
  add(c,'Точный счёт пистолетных раундов',ss,s=>(s.pistol1===0?0:1)+(s.pistol2===0?0:1),['2:0','1:1','0:2']);
  for(let n=1;n<=24;n++){const reached=ss.filter(s=>s.rounds.length>=n);add(c,'Победитель раунда '+n,reached,s=>s.rounds[n-1]?0:1,[a.name,b.name],{condition:'Если раунд будет сыгран',reachProbability:reached.length/ss.length});}
  for(const n of [3,5,7,9,11])add(c,'Гонка до '+n,ss,s=>{let x=0,y=0;for(const r of s.rounds){r?x++:y++;if(x===n)return 0;if(y===n)return 1;}return -1;},[a.name,b.name]);
  for(let t=18.5;t<=24.5;t++)add(c,'Победитель карты и тотал '+t,ss,s=>s.winner*2+(s.total>t?1:0),[a.name+' / Меньше',a.name+' / Больше',b.name+' / Меньше',b.name+' / Больше'],{line:t});
  add(c,'Победитель матча / карты',all.filter(s=>s.maps[index]),s=>(s.a>s.b?0:2)+s.maps[index].winner,[a.name+' / '+a.name,a.name+' / '+b.name,b.name+' / '+a.name,b.name+' / '+b.name]);
  add(c,'Победитель карты / первой половины',ss,s=>s.winner*3+(s.first===6?1:s.first>6?0:2),[a.name+' / '+a.name,a.name+' / Ничья',a.name+' / '+b.name,b.name+' / '+a.name,b.name+' / Ничья',b.name+' / '+b.name]);
  add(c,'Победитель карты / первого пистолетного',ss,s=>s.winner*2+s.pistol1,[a.name+' / '+a.name,a.name+' / '+b.name,b.name+' / '+a.name,b.name+' / '+b.name]);
  const bands=[[2,4],[5,7],[8,10],[11,13]],bandLabels=[...bands.map(([lo,hi])=>a.name+' '+lo+'–'+(hi===Infinity?'∞':hi)),...bands.map(([lo,hi])=>b.name+' '+lo+'–'+(hi===Infinity?'∞':hi))];
  add(c,'Разница в счёте, включая ОТ',ss,s=>s.winner*4+bands.findIndex(([lo,hi])=>Math.abs(s.a-s.b)>=lo&&Math.abs(s.a-s.b)<=hi),bandLabels);
  for(const team of teams)for(const p of team.players||[]){if(!ss[0]?.player[p.id]){unavailable(pc,'Тоталы убийств и хэдшотов · '+p.name,'Нет статистики KPR и числа раундов HLTV. Откройте страницу статистики игрока и импортируйте HAR.');continue;}
   for(const [field,label] of [['kills','Убийства'],['headshots','Хэдшоты']]){if(ss[0].player[p.id][field]==null){unavailable(pc,label+' · '+p.name,'Нет доли хэдшотов HLTV');continue;}const mean=average(ss.map(s=>s.player[p.id][field]));for(let d=-2;d<=2;d++)total(pc,label+' · '+p.name,ss,s=>s.player[p.id][field],Math.max(0,Math.floor(mean)+d)+.5,{note:p.statsPeriod==='all time'?'Использована статистика за карьеру; низкая надёжность':'Gamma–Poisson; дисперсия пока не откалибрована'});}
  }
  for(const pa of ratedPlayers[0])for(const pb of ratedPlayers[1]){const unequal=ss.filter(s=>s.player[pa.id].kills!==s.player[pb.id].kills);add(pc,'Больше убийств: '+pa.name+' / '+pb.name,unequal,s=>s.player[pa.id].kills>s.player[pb.id].kills?0:1,[pa.name,pb.name],{condition:'При равенстве — возврат',pushProbability:1-unequal.length/ss.length});}
  for(const [title,reason] of [['Будет убийство ножом','Нужны логи убийств с типом оружия'],['Будет убийство Zeus X27','Нужны логи убийств с типом оружия'],['Будет убийство осколочной гранатой','Нужны логи убийств гранатами'],['Будет убийство Молотовым / зажигательной гранатой','Нужны логи убийств гранатами']])unavailable(c,title,reason+'; агрегатов из HAR недостаточно');
 }
 progress(96);
 const warnings=['Экспериментальная модель. Сгенерированные цены не являются коэффициентами букмекеров.','Пока нет независимой калибровки полной модели. Много симуляций уменьшает вычислительный шум, но не исправляет недостаток данных.','Раунды условно независимы при заданной силе; экономика, выбор стороны и изменения состава в старых матчах полностью не наблюдаются.','Порядок карт при «Авто» — приближённый сценарий по частотам выбора и банов, а не подтверждённый veto.'];
 if(teams.some(t=>!t.at||now-t.at>7*DAY))warnings.unshift('Часть профилей старше 7 дней. Обновите данные HLTV.');
 if(ratedPlayers.flat().some(p=>p.statsPeriod==='all time'))warnings.push('Некоторые рынки игроков используют статистику за карьеру, включая старые составы и возможные матчи CS:GO.');
 if(teams.some(t=>t.custom))warnings.push('Для своего состава используется сглаженный рейтинг игроков и карты их прежних команд. Сыгранность такого состава не наблюдалась.');
 if(options.sourceError)warnings.push(options.sourceError+' Расчёт использует доступный кеш и импортированные данные.');
 const pRange=[seriesProbability(sigmoid((delta-1.645*sd)/temperature),bestOf),seriesProbability(sigmoid((delta+1.645*sd)/temperature),bestOf)];
 return {modelVersion:'CS2-BT-MR12-3',generatedAt:now,bestOf,margin,maxOdds,roundVolatility,samples,teams:teams.map((t,i)=>({id:t.id,name:t.name,at:t.at,url:t.url,rank:t.rank,players:t.players?.map(p=>({id:p.id,name:p.name,rating:p.rating,ratingVersion:p.ratingVersion,ratingPeriod:p.ratingPeriod,ratingMaps:p.ratingMaps,kpr:p.kpr,headshots:p.headshots,statsPeriod:p.statsPeriod,at:p.at})),factors:{...([sa,sb][i]),mapCount:t.maps?.reduce((s,m)=>s+m.played,0)}})),mapPool:pool,selectedMaps:selected,categories,warnings,validation:checked,ratingScenarioRange:pRange,methods:['Bradley–Terry MAP: сила соперников, затухание 45 дней, окно 180 дней','Байесовское сглаживание карт и пистолетных; неопределённость силы','Monte Carlo MR12 + повторные MR3, остановка серии при победе','Калиброванная межкартовая волатильность силы раундов: logit σ '+roundVolatility.toFixed(2),'Gamma–Poisson для убийств, Beta–Binomial для хэдшотов','Power method для заданного overround'],sources:[...new Set(teams.flatMap(t=>[t.url,...(t.players||[]).map(p=>p.url)]).filter(Boolean))]};
}

module.exports={generateManualMarkets:generateOdds};
