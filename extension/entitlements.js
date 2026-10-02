'use strict';
/* What this user may use (server 4.9+: GET /api/me). The server enforces every capability itself - this copy only hides
   what cannot be used, so a disabled section, bookmaker or tool simply is not there. Shared by the page and the service
   worker; the last answer is kept in chrome.storage.local (`entitlements9`) for an instant first paint.
   A server without /api/me (older than 4.9) has no per-user capabilities: everything except administration. */
(function(root){
 const KEYS=Object.freeze(['live.view','prematch.view','results.view','compare.view','history.view','provider.astek','provider.fonbet','provider.pinnacle','provider.ggbet','provider.databet','odds.live','odds.prematch','odds.fullMarkets','odds.history','scores.history','statistics.view','compare.arbitrage','compare.schedule','tools.generator','leagues.manage','notifications','favorites','admin.panel','admin.diagnostics','admin.users']);
 const LEGACY=Object.freeze(KEYS.filter(k=>!k.startsWith('admin.')));
 const VIEW_KEY=Object.freeze({live:'live.view',prematch:'prematch.view',results:'results.view',compare:'compare.view',history:'history.view'});
 function normalize(me){
  if(!me||typeof me!=='object'||!Array.isArray(me.capabilities))return null;
  return {capabilities:me.capabilities.filter(k=>KEYS.includes(k)),role:String(me.principal?.role||'user'),name:String(me.principal?.name||''),anonymous:!!me.principal?.anonymous,access:String(me.access||'open'),at:Number(me.at)||Date.now()};
 }
 function create(initial=null){
  let state=normalize(initial),caps=new Set(state?state.capabilities:LEGACY);
  const api={
   set(me){const next=normalize(me);if(!next)return false;const before=[...caps].sort().join(',');state=next;caps=new Set(next.capabilities);return before!==[...caps].sort().join(',');},
   legacy(){state=null;const before=[...caps].sort().join(',');caps=new Set(LEGACY);return before!==LEGACY.join(',');},
   can:key=>caps.has(key),
   canView:view=>caps.has(VIEW_KEY[view]),
   canProvider:source=>caps.has('provider.'+source),
   oddsFor:view=>caps.has(view==='prematch'?'odds.prematch':'odds.live'),
   isAdmin:()=>caps.has('admin.panel')||state?.role==='admin',
   needsKey:()=>!!state?.anonymous&&state.access==='enforce'&&!caps.size,
   views:()=>Object.keys(VIEW_KEY).filter(v=>caps.has(VIEW_KEY[v])),
   state:()=>state&&{...state},
   list:()=>[...caps].sort()
  };
  return api;
 }
 const out={KEYS,LEGACY,VIEW_KEY,create,normalize};
 if(typeof module==='object'&&module.exports)module.exports=out;else root.Entitlements=out;
})(globalThis);
