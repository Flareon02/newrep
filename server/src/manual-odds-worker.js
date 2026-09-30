import {parentPort,workerData} from 'node:worker_threads';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const ManualInput=require('./manual-input.cjs');
const {generateManualMarkets}=require('./manual-engine.cjs');
try{
 const m=ManualInput.prepare(workerData),names=m.maps.map((name,i)=>(i+1)+'. '+name),teams=m.names.map((name,i)=>({id:i+1,name,players:[],maps:names.map(name=>({name})),at:Date.now()}));
 const r=generateManualMarkets({}, {teams,bestOf:m.bestOf,margin:m.margin,maxOdds:m.maxOdds,roundVolatility:.38,maps:names,manualProbabilities:m.ps,samples:16000},progress=>parentPort.postMessage({progress}));
 parentPort.postMessage({result:ManualInput.finish(r,m)});
}catch(error){parentPort.postMessage({error:error.message});}
