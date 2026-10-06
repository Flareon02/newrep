'use strict';
/* Extension-side data layer (9.0).

   Navigation never waits for the network: every view reads what is already in memory (or the last-known copy saved
   on disk) and renders it at once; a refresh runs in the background and the view is patched when it lands.

   - Client: GET deduplication (one request per URL in flight), per-request timeout, and shared cancellation - a
     request is aborted only when every caller waiting for it has given up (e.g. the user selected another match).
   - Resource: keyed cache with a "fresh" window (no refetch), a "usable" window (shown at once, refreshed in the
     background) and LRU eviction. swr() = stale-while-revalidate.
   - Persist: last-known snapshots in chrome.storage.local, written at most every `minIntervalMs` per key and on
     page hide, read once at start-up.

   Pure JavaScript: no DOM, chrome.* only through injected functions, so it is unit-tested in Node. */
(function(root){
 const now=()=>Date.now();

 function abortError(){const e=new Error('aborted');e.name='AbortError';return e;}

 function createClient({base,headers=()=>({}),fetchImpl=(...a)=>fetch(...a),timeoutFor=()=>15000}={}){
  const inflight=new Map(); // url -> {promise, controller, waiters}
  async function run(url,timeout,init={}){
   const response=await fetchImpl(base()+url,{cache:'no-store',...init,headers:{...headers(),...(init.headers||{})},signal:init.signal});
   let data=null;try{data=await response.json();}catch{if(response.ok)throw new Error('Ответ сервера не является JSON');}
   if(!response.ok){const error=new Error(data?.error||`HTTP ${response.status}`);error.status=response.status;error.code=data?.code||'';if(data?.current)error.current=data.current;throw error;}
   return data;
  }
  function get(url,{signal=null,timeout=timeoutFor(url)}={}){
   if(signal?.aborted)return Promise.reject(abortError());
   let entry=inflight.get(url);
   if(!entry){
    const controller=new AbortController(),current={controller,waiters:0,timedOut:false,promise:null};
    const timer=setTimeout(()=>{current.timedOut=true;controller.abort();},timeout);
    current.promise=run(url,timeout,{signal:controller.signal}).catch(error=>{
     if(!controller.signal.aborted)throw error;
     const e=new Error(current.timedOut?'сервер не ответил вовремя':'aborted');e.name=current.timedOut?'TimeoutError':'AbortError';throw e;
    }).finally(()=>{clearTimeout(timer);if(inflight.get(url)===current)inflight.delete(url);});
    entry=current;inflight.set(url,entry);
   }
   entry.waiters++;
   if(!signal)return entry.promise;
   return new Promise((resolve,reject)=>{
    let done=false;
    const onAbort=()=>{if(done)return;done=true;entry.waiters--;if(entry.waiters<=0)entry.controller.abort(abortError());reject(abortError());};
    signal.addEventListener('abort',onAbort,{once:true});
    entry.promise.then(v=>{if(done)return;done=true;signal.removeEventListener('abort',onAbort);resolve(v);},e=>{if(done)return;done=true;signal.removeEventListener('abort',onAbort);reject(e);});
   });
  }
  async function post(url,body,{timeout=timeoutFor(url),signal=null}={}){
   let timedOut=false;const controller=new AbortController(),timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
   signal?.addEventListener('abort',()=>controller.abort(),{once:true});
   try{return await run(url,timeout,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});}
   catch(error){if(!controller.signal.aborted)throw error;const e=new Error(timedOut?'сервер не ответил вовремя':'aborted');e.name=timedOut?'TimeoutError':'AbortError';throw e;}
   finally{clearTimeout(timer);}
  }
  return {get,post,pending:()=>inflight.size};
 }

 // fresh(key,value): ms during which the value is used without refetching. usable: ms during which a stale value is
 // still shown immediately (while refreshing). max: LRU size.
 function createResource({fetcher,fresh=15000,usable=10*60000,max=40,clock=now}={}){
  const entries=new Map(); // key -> {value, at, stale:boolean}
  const loading=new Map(); // key -> promise
  const freshFor=typeof fresh==='function'?fresh:()=>fresh;
  function touch(key,entry){entries.delete(key);entries.set(key,entry);while(entries.size>max)entries.delete(entries.keys().next().value);}
  function peek(key){const e=entries.get(key);if(!e)return null;const age=clock()-e.at;if(age>usable)return null;return {value:e.value,at:e.at,fresh:!e.stale&&age<freshFor(key,e.value)};}
  function set(key,value,at=clock()){touch(key,{value,at,stale:false});return value;}
  function load(key,{signal=null}={}){
   if(loading.has(key))return loading.get(key);
   const p=Promise.resolve().then(()=>fetcher(key,{signal})).then(value=>{set(key,value);return value;}).finally(()=>{if(loading.get(key)===p)loading.delete(key);});
   loading.set(key,p);return p;
  }
  // Returns the cached value (or null) synchronously; refreshes when it is not fresh and reports the new value.
  function swr(key,{onValue=()=>{},onError=()=>{},force=false,signal=null}={}){
   const cached=peek(key);
   if(cached){const e=entries.get(key);touch(key,e);}
   const needs=force||!cached||!cached.fresh;
   const promise=needs?load(key,{signal}).then(value=>{onValue(value,{fromCache:false});return value;},error=>{if(error?.name!=='AbortError')onError(error);throw error;}):Promise.resolve(cached.value);
   promise.catch(()=>{});
   return {cached:cached?.value??null,at:cached?.at||0,fresh:!!cached?.fresh,refreshing:needs,promise};
  }
  function get(key,options={}){const cached=peek(key);if(cached?.fresh&&!options.force)return Promise.resolve(cached.value);return load(key,options);}
  function invalidate(match){for(const [key,e] of entries)if(typeof match==='function'?match(key,e.value):key===match)e.stale=true;}
  function remove(match){for(const key of [...entries.keys()])if(typeof match==='function'?match(key,entries.get(key).value):key===match)entries.delete(key);}
  return {peek,set,get,swr,load,invalidate,remove,clear:()=>entries.clear(),keys:()=>[...entries.keys()],isLoading:key=>loading.has(key),size:()=>entries.size};
 }

 // Last-known snapshots on disk: written at most every minIntervalMs per key (and when flushed), read once.
 function createPersist({storage,prefix='lastKnown:',minIntervalMs=30000,clock=now}={}){
  const lastWrite=new Map(),pending=new Map(),timers=new Map();
  async function load(keys){try{const data=await storage.get(keys.map(k=>prefix+k));return Object.fromEntries(keys.map(k=>[k,data?.[prefix+k]??null]));}catch{return Object.fromEntries(keys.map(k=>[k,null]));}}
  function write(key){const value=pending.get(key);pending.delete(key);clearTimeout(timers.get(key));timers.delete(key);lastWrite.set(key,clock());return storage.set({[prefix+key]:value}).catch(()=>{});}
  function save(key,value){pending.set(key,value);if(timers.has(key))return;const last=lastWrite.get(key),wait=last==null?0:Math.max(0,last+minIntervalMs-clock());if(wait===0)return write(key);timers.set(key,setTimeout(()=>write(key),wait));}
  function flush(){return Promise.all([...pending.keys()].map(write));}
  return {load,save,flush,pendingKeys:()=>[...pending.keys()]};
 }

 const api={createClient,createResource,createPersist};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.Store=api;
})(globalThis);
