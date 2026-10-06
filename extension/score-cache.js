const ScoreCache=(()=>{
 const pending=new Map(),storage=chrome.storage.session||chrome.storage.local;
 // The history request carries the access key (it was sent without one: HTTP 401 for every user under enforced access).
 // Cached copies are kept per key, so another key never sees them.
 const who=()=>(ServerConfig.token?ServerConfig.token.slice(-8):'open')+'|';
 const accessText=status=>status===401?'Нужен действующий ключ доступа (Настройки → Подключение).':status===403?'История счёта недоступна для вашего ключа. Обратитесь к администратору.':'';
 async function read(ids){const data=await storage.get('scoreHistoryCache');return data.scoreHistoryCache?.[who()+ids]||null;}
 async function load(ids,{before}={}){const key=ids+':'+(before||'latest');if(pending.has(key))return pending.get(key);
  const run=(async()=>{const response=await fetch(ServerConfig.base+'/api/score-history?'+new URLSearchParams({ids,limit:'200',...(before?{before:String(before)}:{})}),{cache:'no-store',headers:ServerConfig.headers(),signal:AbortSignal.timeout(10000)});if(!response.ok)throw Object.assign(new Error(accessText(response.status)||(response.status===404?'Журнал счёта недоступен на сервере (HTTP 404)':'Журнал недоступен: HTTP '+response.status)),{status:response.status});const data=await response.json();if(!before){const saved=await storage.get('scoreHistoryCache'),cache=saved.scoreHistoryCache||{};delete cache[who()+ids];cache[who()+ids]={...data,cachedAt:Date.now()};const keys=Object.keys(cache);for(const key of keys.slice(0,-8))delete cache[key];await storage.set({scoreHistoryCache:cache});}return data;})().finally(()=>pending.delete(key));pending.set(key,run);return run;
 }
 return {read,load};
})();
