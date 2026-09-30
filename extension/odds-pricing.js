(function(root){
'use strict';
function price(outcomes,margin=7.5,maxOdds=null){
 margin=Number(margin);if(!Number.isFinite(margin)||margin<0||margin>25)throw Error('Маржа должна быть от 0 до 25%');maxOdds=maxOdds==null||maxOdds===''?null:Number(maxOdds);if(maxOdds!=null&&(!Number.isFinite(maxOdds)||maxOdds<1.01||maxOdds>10000))throw Error('Максимальный коэффициент должен быть от 1.01 до 10000');
 const sum=outcomes.reduce((s,x)=>s+Number(x.probability),0);if(!(sum>0)||outcomes.some(x=>!Number.isFinite(x.probability)||x.probability<0||x.probability>1))throw Error('Неверные вероятности рынка');
 const p=outcomes.map(x=>x.probability/sum),positive=p.filter(x=>x>0),target=1+margin/100;
 if(positive.length<2)return outcomes.map((o,i)=>({...o,probability:p[i],fairOdds:p[i]?1/p[i]:null,odds:null}));
 // Power allocation: exact requested overround without odds below 1.
 let low=0,high=1;for(let i=0;i<60;i++){const k=(low+high)/2;if(positive.reduce((s,x)=>s+x**k,0)>target)low=k;else high=k;}
 const k=margin===0?1:(low+high)/2;
 return outcomes.map((o,i)=>{const raw=p[i]>0?1/p[i]**k:null;return {...o,probability:p[i],fairOdds:p[i]>0?1/p[i]:null,impliedProbability:p[i]**k,odds:raw==null?null:(maxOdds==null?raw:Math.min(raw,maxOdds)),wasCapped:raw!=null&&maxOdds!=null&&raw>maxOdds||undefined};});
}
const api={price};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.OddsPricing=api;
})(typeof globalThis!=='undefined'?globalThis:this);
