import {parentPort,workerData} from 'node:worker_threads';
import {generateOdds} from './odds-model.js';
try{const result=generateOdds(workerData.data,workerData.options,n=>parentPort.postMessage({progress:n}));parentPort.postMessage({result});}catch(error){parentPort.postMessage({error:error.message});}
