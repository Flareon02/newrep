'use strict';
/* Where the extension talks to, and the optional access token for write endpoints.
   The default is the public API behind Cloudflare (HTTPS); another server can be set in Settings -> Server.
   Extension pages build requests while their scripts load, so they read a localStorage mirror
   synchronously; the service worker has no localStorage and reads chrome.storage.local, which
   is the source of truth. A page reloads itself once if the mirror was stale. */
const ServerConfig=(()=>{
  // DEFAULT_TOKEN stays empty in the repository; tools/build-staging-extension.mjs fills it in for a private STAGING build only.
  const DEFAULT_BASE='https://api.esportsdata.online',DEFAULT_TOKEN='',KEY='server',MIRROR='monitor-server',inPage=typeof localStorage!=='undefined';
  // Keeps scheme, host, port and a reverse-proxy path prefix (https://host/monitor); drops trailing slashes, query and hash.
  function normalize(raw){try{const url=new URL(String(raw||'').trim());if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)return '';return url.origin+url.pathname.replace(/\/+$/,'');}catch{return '';}}
  // Chrome match patterns carry no port, so the optional host permission is requested for scheme + host.
  function permissionPattern(base){try{const url=new URL(base);return url.protocol+'//'+url.hostname+'/*';}catch{return '';}}
  function sanitize(value){return {base:normalize(value?.base)||DEFAULT_BASE,token:(typeof value?.token==='string'?value.token.trim().slice(0,256):'')||DEFAULT_TOKEN};}
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
  // Network failures reach the UI as plain Russian text instead of the browser's English wording ("signal timed out", "Failed to fetch").
  function errorText(error){const name=error?.name,text=error?.message||String(error);if(name==='TimeoutError'||name==='AbortError'||/timed out|aborted/i.test(text))return 'сервер не ответил вовремя';if(/failed to fetch|networkerror|network error|load failed/i.test(text))return 'сервер недоступен';return text;}
  return {
    DEFAULT_BASE,ready,errorText,normalize,permissionPattern,
    get base(){return current.base;},
    get token(){return current.token;},
    headers(extra={}){return current.token?{Authorization:'Bearer '+current.token,...extra}:{...extra};},
    async save({base,token}){const next=sanitize({base,token});await chrome.storage.local.set({[KEY]:next});current=next;writeMirror(next);return next;},
    async reset(){await chrome.storage.local.remove(KEY);current=sanitize({});writeMirror(current);return current;}
  };
})();
