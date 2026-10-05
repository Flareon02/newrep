'use strict';
/* ServerConfig for the web and desktop builds (replaces extension/server-config.js there).
   The address is fixed by the build: the web app talks to its own origin, the desktop app to https://esportsdata.online.
   There is no token here: the web session is an HttpOnly cookie, and the desktop session header is added by
   platform.js. Same interface as the extension's ServerConfig, so the shared UI code is unchanged. */
const ServerConfig=(()=>{
  const base=globalThis.Platform?.apiBase||'';
  function errorText(error){const name=error?.name,text=error?.message||String(error);if(name==='TimeoutError'||name==='AbortError'||/timed out|aborted/i.test(text))return 'сервер не ответил вовремя';if(/failed to fetch|networkerror|network error|load failed/i.test(text))return 'сервер недоступен';return text;}
  return {
    DEFAULT_BASE:base,ready:Promise.resolve(false),errorText,
    normalize:value=>String(value||''),permissionPattern:()=>'',
    get base(){return base;},
    get token(){return '';},
    headers(extra={}){return {...extra};},
    async save(){return {base,token:''};},
    async reset(){return {base,token:''};}
  };
})();
