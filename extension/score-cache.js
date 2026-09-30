const ScoreCache=(()=>{
 const pending=new Map(),storage=chrome.storage.session||chrome.storage.local;
 async function read(ids){const data=await storage.get('scoreHistoryCache');return data.scoreHistoryCache?.[ids]||null;}
 async function load(ids,{before}={}){const key=ids+':'+(before||'latest');if(pending.has(key))return pending.get(key);
  const run=(async()=>{const response=await fetch('http://87.199.202.237:8080/api/score-history?'+new URLSearchParams({ids,limit:'200',...(before?{before:String(before)}:{})}),{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error(response.status===404?'Журнал счёта недоступен на сервере (HTTP 404)':'Журнал недоступен: HTTP '+response.status);const data=await response.json();if(!before){const saved=await storage.get('scoreHistoryCache'),cache=saved.scoreHistoryCache||{};delete cache[ids];cache[ids]={...data,cachedAt:Date.now()};const keys=Object.keys(cache);for(const key of keys.slice(0,-8))delete cache[key];await storage.set({scoreHistoryCache:cache});}return data;})().finally(()=>pending.delete(key));pending.set(key,run);return run;
 }
 return {read,load};
})();
