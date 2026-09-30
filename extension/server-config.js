'use strict';
/* Where the extension talks to, and the optional access token for write endpoints.
   The default is the original production address, so installing this version changes nothing
   until the user edits Settings -> Server.
   Extension pages build requests while their scripts load, so they read a localStorage mirror
   synchronously; the service worker has no localStorage and reads chrome.storage.local, which
   is the source of truth. A page reloads itself once if the mirror was stale. */
const ServerConfig=(()=>{
  const DEFAULT_BASE='http://87.199.202.237:8080',KEY='server',MIRROR='monitor-server',inPage=typeof localStorage!=='undefined';
  function normalize(raw){try{const url=new URL(String(raw||'').trim());return ['http:','https:'].includes(url.protocol)&&url.hostname?url.origin:'';}catch{return '';}}
  function sanitize(value){return {base:normalize(value?.base)||DEFAULT_BASE,token:typeof value?.token==='string'?value.token.trim().slice(0,256):''};}
  function readMirror(){if(!inPage)return {};try{return JSON.parse(localStorage.getItem(MIRROR)||'null')||{};}catch{return {};}}
  function writeMirror(value){if(!inPage)return true;try{localStorage.setItem(MIRROR,JSON.stringify(value));return true;}catch{return false;}}
  let current=sanitize(readMirror());
  const same=(a,b)=>a.base===b.base&&a.token===b.token;
  const ready=(async()=>{
    try{
      const next=sanitize((await chrome.storage.local.get(KEY))[KEY]),changed=!same(next,current);
      current=next;
      // Reload a page only if the mirror really was updated, never in a loop.
      return writeMirror(next)&&changed&&inPage&&same(sanitize(readMirror()),next);
    }catch{return false;}
  })();
  if(inPage)ready.then(stale=>{if(stale&&typeof location!=='undefined')location.reload();});
  try{chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes[KEY]){current=sanitize(changes[KEY].newValue);writeMirror(current);}});}catch{}
  return {
    DEFAULT_BASE,ready,normalize,
    get base(){return current.base;},
    get token(){return current.token;},
    headers(extra={}){return current.token?{Authorization:'Bearer '+current.token,...extra}:{...extra};},
    async save({base,token}){const next=sanitize({base,token});await chrome.storage.local.set({[KEY]:next});current=next;writeMirror(next);return next;},
    async reset(){await chrome.storage.local.remove(KEY);current=sanitize({});writeMirror(current);return current;}
  };
})();
