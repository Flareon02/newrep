import {Worker,isMainThread} from 'node:worker_threads';
import {leagueStore} from './league-store.js';
const lanes=new Map();let sequence=0;const stats={timeouts:0,failures:0,lastError:'',lastErrorAt:null};
export function matcherLane(task,payload={}){
  if(task==='compare')return 'compare';
  if(task==='archive')return 'archive';
  if(task==='ui-history-page')return 'history';
  if(task==='resolve'&&payload?.scope==='history')return 'history';
  if(task==='resolve')return payload?.mode==='live'?'feeds-live':'feeds-prematch';
  return 'feeds';
}
function timeoutFor(task,key){return task==='archive'?120000:task==='ui-history-page'?90000:task==='compare'?45000:key==='history'?120000:key==='feeds-prematch'?60000:20000;}
// The production VPS has one CPU core and 1 GiB RAM (768 MiB container limit).
// Worker threads isolate CPU-heavy matching from the HTTP event loop, but large
// per-lane heaps are wasteful on one core. Keep them deliberately small and
// recycle idle workers so History/Results cannot permanently consume RAM.
function workerMemory(key){return key==='feeds-prematch'?112:key==='history'||key==='archive'?112:96;}
function idleMs(key){return key==='feeds-live'?45000:key==='feeds-prematch'?30000:10000;}
function scheduleIdle(key,lane){
  clearTimeout(lane.idleTimer);
  if(lane.pending.size||lane.activeId||lane.closing)return;
  lane.idleTimer=setTimeout(()=>{
    if(lanes.get(key)!==lane||lane.pending.size||lane.activeId)return;
    lane.closing=true;lanes.delete(key);lane.worker.terminate().catch(()=>{});
  },idleMs(key));
  lane.idleTimer.unref?.();
}
function createLane(key){
  const lane={worker:new Worker(new URL('./matcher-worker.js',import.meta.url),{resourceLimits:{maxOldGenerationSizeMb:workerMemory(key),maxYoungGenerationSizeMb:16}}),pending:new Map(),activeId:null,idleTimer:null,closing:false};
  lanes.set(key,lane);
  const fail=error=>{
    if(lane.closing)return;
    if(lanes.get(key)===lane)lanes.delete(key);
    clearTimeout(lane.idleTimer);stats.failures++;stats.lastError=error?.message||String(error);stats.lastErrorAt=Date.now();
    for(const p of lane.pending.values()){clearTimeout(p.timer);p.reject(error);}lane.pending.clear();
  };
  lane.fail=fail;
  lane.worker.on('message',message=>{
    const {id,value,error,started}=message||{},p=lane.pending.get(id);if(!p)return;
    if(started){
      if(p.started)return;p.started=true;lane.activeId=id;
      p.timer=setTimeout(()=>{stats.timeouts++;lane.fail(new Error(`Сопоставление ${key} превысило ${Math.round(p.timeoutMs/1000)} секунд`));lane.closing=true;lane.worker.terminate().catch(()=>{});},p.timeoutMs);
      return;
    }
    lane.pending.delete(id);if(lane.activeId===id)lane.activeId=null;clearTimeout(p.timer);error?p.reject(new Error(error)):p.resolve(value);scheduleIdle(key,lane);
  });
  lane.worker.on('error',fail);
  lane.worker.on('exit',code=>{if(!lane.closing&&lanes.get(key)===lane)fail(new Error('Matcher stopped ('+code+')'));});
  return lane;
}
export function matchAsync(task,payload){
  if(!isMainThread)throw new Error('Nested matcher task');
  const key=matcherLane(task,payload);let lane=lanes.get(key);if(!lane)lane=createLane(key);
  clearTimeout(lane.idleTimer);lane.idleTimer=null;
  if(lane.pending.size>=12)return Promise.reject(new Error('Очередь сопоставления заполнена; повторите позже'));
  return new Promise((resolve,reject)=>{
    const id=++sequence,timeoutMs=timeoutFor(task,key);lane.pending.set(id,{resolve,reject,timer:null,timeoutMs,started:false});
    lane.worker.postMessage({id,task,payload,rules:leagueStore.rules(),...(task==='compare'?{catalog:[...leagueStore.catalog]}:{})});
  });
}
export async function stopMatcher(){const workers=[...lanes.values()];lanes.clear();for(const lane of workers){lane.closing=true;clearTimeout(lane.idleTimer);}await Promise.all(workers.map(lane=>lane.worker.terminate()));}
export function matcherStatus(){return {running:lanes.size>0,workers:lanes.size,pendingTasks:[...lanes.values()].reduce((n,l)=>n+l.pending.size,0),lanes:Object.fromEntries([...lanes].map(([key,l])=>[key,l.pending.size])),active:Object.fromEntries([...lanes].map(([key,l])=>[key,!!l.activeId])),timeouts:stats.timeouts,failures:stats.failures,lastError:stats.lastError,lastErrorAt:stats.lastErrorAt};}
