'use strict';
/* Platform layer for the shared Esports Monitor UI (extension 9.3.0) on the web (https://esportsdata.online) and in the
   desktop app (Tauri 2, bundled frontend).

   The UI code is the extension's, unchanged in behaviour. This file supplies what the browser-extension platform gave it:
   - chrome.storage (IndexedDB, one in-memory copy per page, changes shared between tabs), chrome.runtime ports and
     messages (the extension's background feed engine runs in the page), alarms, notifications (Notification API or
     the desktop notification plugin), windows/tabs (window.open or the desktop opener);
   - the Access Key gate and the session: the web uses an HttpOnly cookie that scripts never see; the desktop app keeps
     its opaque session token in its own app storage and sends it as Authorization: Bearer. The Access Key itself is
     sent once to /auth/verify and is not stored anywhere;
   - session loss: any 401 from the gateway with a session_* code (a revoked, replaced or expired session), the final
     `event: session` of a closed stream, or a periodic /auth/session check sends the page back to the gate with the
     reason, after clearing cached data of the signed-out account.
   Build-time settings come from platform-config.js (window.__EDS_BUILD__), written by web/build.mjs. */
(function(){
 const build=window.__EDS_BUILD__||{target:'web',version:'dev',apiBase:'',scripts:[]};
 const desktop=build.target==='tauri';
 const apiBase=desktop?String(build.apiBase||'').replace(/\/+$/,''):'';
 const apiOrigin=desktop?new URL(apiBase).origin:location.origin;
 const TOKEN_KEY='eds-desktop-session',SIGNED_IN='eds-signed-in',ENDED='eds-session-ended';
 const ls={get(k){try{return localStorage.getItem(k);}catch{return null;}},set(k,v){try{localStorage.setItem(k,v);}catch{}},del(k){try{localStorage.removeItem(k);}catch{}}};
 const ss={get(k){try{return sessionStorage.getItem(k);}catch{return null;}},set(k,v){try{sessionStorage.setItem(k,v);}catch{}},del(k){try{sessionStorage.removeItem(k);}catch{}}};
 let token=desktop?(ls.get(TOKEN_KEY)||''):'';
 const tauri=()=>window.__TAURI__||null;

 // ------------------------------------------------------------------------------------------------ fetch ---------
 const nativeFetch=window.fetch.bind(window);
 function isOurs(url){try{return new URL(url,location.href).origin===apiOrigin;}catch{return false;}}
 const SESSION_PATH=/^\/(api\/|health$|downloads\/|auth\/admin\/)/;
 window.fetch=async function(input,init={}){
  const url=typeof input==='string'?input:input instanceof URL?input.href:input?.url||'';
  const ours=isOurs(url);
  if(ours&&!(input instanceof Request)){
   init={...init};
   if(desktop){if(token){const h=new Headers(init.headers||{});if(!h.has('authorization'))h.set('Authorization','Bearer '+token);init.headers=h;}init.credentials='omit';}
   else init.credentials='same-origin';
  }
  const response=await nativeFetch(input,init);
  if(ours&&response.status===401){let path='';try{path=new URL(url,location.href).pathname;}catch{}if(SESSION_PATH.test(path))response.clone().json().then(d=>{if(/^session_/.test(String(d?.code||'')))Platform.sessionEnded(d.reason||'none');}).catch(()=>{});}
  return response;
 };

 // Desktop: EventSource cannot send Authorization, so streams use fetch (same API surface the UI uses).
 if(desktop){
  class FetchEventSource{
   constructor(url){this.url=url;this.readyState=0;this.onmessage=null;this.onerror=null;this.onopen=null;this.listeners=new Map();this.controller=null;this.closed=false;this.run();}
   addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
   removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
   emit(type,event){if(type==='message')this.onmessage?.(event);else if(type==='error')this.onerror?.(event);else if(type==='open')this.onopen?.(event);for(const fn of this.listeners.get(type)||[])try{fn(event);}catch{}}
   async run(){
    while(!this.closed){
     this.controller=new AbortController();
     try{
      const r=await window.fetch(this.url,{headers:{Accept:'text/event-stream'},cache:'no-store',signal:this.controller.signal});
      if(!r.ok||!r.body){this.emit('error',{status:r.status});if(r.status===401||r.status===403||r.status===404){this.close();return;}throw Error('HTTP '+r.status);}
      this.readyState=1;this.emit('open',{});
      const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
      for(;;){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let i;while((i=buffer.search(/\r?\n\r?\n/))>=0){const block=buffer.slice(0,i);buffer=buffer.slice(i+(buffer.match(/\r?\n\r?\n/)[0].length));let type='message';const data=[];for(const line of block.split(/\r?\n/)){if(!line||line.startsWith(':'))continue;const c=line.indexOf(':'),f=c<0?line:line.slice(0,c),v=c<0?'':line.slice(c+1).replace(/^ /,'');if(f==='event')type=v;else if(f==='data')data.push(v);}if(type==='session'){Platform.checkSession();continue;}if(data.length)this.emit(type,{type,data:data.join('\n')});}}
     }catch{if(this.closed)return;}
     if(this.closed)return;
     this.readyState=0;this.emit('error',{});
     await new Promise(r=>setTimeout(r,3000));
    }
   }
   close(){this.closed=true;this.readyState=2;try{this.controller?.abort();}catch{}}
  }
  FetchEventSource.CONNECTING=0;FetchEventSource.OPEN=1;FetchEventSource.CLOSED=2;
  window.EventSource=FetchEventSource;
 }

 // ------------------------------------------------------------------------------------------------ storage -------
 const DB_NAME='esports-monitor',STORE='kv';
 const mem=new Map(),localListeners=new Set();
 let db=null;
 const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('eds-storage'):null;
 const clone=v=>v===undefined?undefined:structuredClone(v);
 function openDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
 const storageReady=(async()=>{
  try{db=await openDb();await new Promise((resolve,reject)=>{const req=db.transaction(STORE,'readonly').objectStore(STORE).openCursor();req.onsuccess=()=>{const c=req.result;if(c){mem.set(c.key,c.value);c.continue();}else resolve();};req.onerror=()=>reject(req.error);});}
  catch{db=null;} // private mode without IndexedDB: memory only, the UI still works
 })();
 function persistWrites(puts,dels){if(!db)return Promise.resolve();return new Promise(resolve=>{try{const tx=db.transaction(STORE,'readwrite'),s=tx.objectStore(STORE);for(const [k,v] of puts)s.put(v,k);for(const k of dels)s.delete(k);tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();}catch{resolve();}});}
 function fire(changes){if(!Object.keys(changes).length)return;setTimeout(()=>{for(const fn of [...localListeners])try{fn(changes,'local');}catch(e){console.error(e);}},0);}
 // Other tabs learn about small keys (prefs, capabilities, seen events); big last-known snapshots stay per tab.
 const shared=k=>!String(k).startsWith('lastKnown');
 channel&&(channel.onmessage=e=>{const {changes}=e.data||{};if(!changes)return;for(const [k,c] of Object.entries(changes)){if('newValue' in c)mem.set(k,c.newValue);else mem.delete(k);}fire(changes);});
 const local={
  async get(keys){await storageReady;const list=keys==null?[...mem.keys()]:typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys);const out={};for(const k of list){if(mem.has(k))out[k]=clone(mem.get(k));else if(keys&&typeof keys==='object'&&!Array.isArray(keys)&&k in keys)out[k]=keys[k];}return out;},
  async set(items){await storageReady;const changes={},puts=[];for(const [k,v] of Object.entries(items||{})){const value=clone(v);changes[k]={oldValue:mem.get(k),newValue:clone(value)};mem.set(k,value);puts.push([k,value]);}fire(changes);const small=Object.fromEntries(Object.entries(changes).filter(([k])=>shared(k)));if(channel&&Object.keys(small).length)try{channel.postMessage({changes:small});}catch{}await persistWrites(puts,[]);},
  async remove(keys){await storageReady;const list=typeof keys==='string'?[keys]:keys||[],changes={};for(const k of list)if(mem.has(k)){changes[k]={oldValue:mem.get(k)};mem.delete(k);}fire(changes);if(channel&&Object.keys(changes).length)try{channel.postMessage({changes});}catch{}await persistWrites([],list);},
  async clear(){await local.remove([...mem.keys()]);}
 };
 const sessionMem=new Map();
 const session={async get(keys){const list=typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys||{});const out={};for(const k of list)if(sessionMem.has(k))out[k]=clone(sessionMem.get(k));return out;},async set(items){for(const [k,v] of Object.entries(items||{}))sessionMem.set(k,clone(v));},async remove(keys){for(const k of typeof keys==='string'?[keys]:keys)sessionMem.delete(k);}};

 // ------------------------------------------------------------------------------------------------ runtime -------
 const connectListeners=[],pendingPorts=[],messageListeners=new Set();
 function portPair(name){
  const make=()=>({name,_listeners:new Set(),_disc:new Set(),_peer:null,_open:true,
   onMessage:{addListener(fn){this._p._listeners.add(fn);},removeListener(fn){this._p._listeners.delete(fn);}},
   onDisconnect:{addListener(fn){this._p._disc.add(fn);},removeListener(fn){this._p._disc.delete(fn);}},
   postMessage(msg){if(!this._open)throw new Error('Attempting to use a disconnected port object');const peer=this._peer,data=clone(msg);queueMicrotask(()=>{if(peer._open)for(const fn of [...peer._listeners])try{fn(data,peer);}catch(e){console.error(e);}});},
   disconnect(){if(!this._open)return;this._open=false;const peer=this._peer;peer._open=false;queueMicrotask(()=>{for(const fn of [...peer._disc])try{fn(peer);}catch{}});}});
  const a=make(),b=make();a._peer=b;b._peer=a;a.onMessage._p=a;a.onDisconnect._p=a;b.onMessage._p=b;b.onDisconnect._p=b;
  return [a,b];
 }
 function openExternal(url){
  try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol))return false;}catch{return false;}
  const t=tauri();
  if(desktop&&t?.opener?.openUrl){t.opener.openUrl(url).catch(()=>{});return true;}
  window.open(url,'_blank','noopener,noreferrer');return true;
 }
 function openWindow(url,width,height){
  const t=tauri();
  if(desktop&&t?.webviewWindow?.WebviewWindow){try{new t.webviewWindow.WebviewWindow('w'+Date.now(),{url:new URL(url,location.href).pathname.replace(/^\//,'')+new URL(url,location.href).search,width,height,title:'Esports Data'});return {id:1};}catch{}}
  window.open(url,'_blank',`popup,width=${width||1040},height=${height||800}`);return {id:1};
 }
 const alarms=new Map(),alarmListeners=new Set();
 const notificationClicks=new Set();
 let notificationLeader=false;
 // One tab shows notifications for this profile (the others would show the same ones).
 try{navigator.locks?.request('eds-notifications',()=>{notificationLeader=true;return new Promise(()=>{});});}catch{notificationLeader=true;}
 if(!navigator.locks)notificationLeader=true;
 async function notify(id,o){
  if(!notificationLeader)return id;
  const title=String(o?.title||'Esports Data'),body=[o?.message,o?.contextMessage].filter(Boolean).join('\n');
  const n=tauri()?.notification;
  if(desktop&&n?.sendNotification){try{if(await n.isPermissionGranted())n.sendNotification({title,body});}catch{}return id;}
  if(typeof Notification!=='function'||Notification.permission!=='granted')return id;
  try{const x=new Notification(title,{body,icon:'icons/icon128.png',tag:id,silent:!!o?.silent});x.onclick=()=>{window.focus();for(const fn of notificationClicks)try{fn(id);}catch{}x.close();};}catch{}
  return id;
 }
 const noop={addListener(){},removeListener(){}};
 window.chrome={
  storage:{local,session,onChanged:{addListener:fn=>localListeners.add(fn),removeListener:fn=>localListeners.delete(fn)}},
  runtime:{
   id:'esportsdata-'+build.target,
   getURL:p=>new URL(String(p).replace(/^\//,''),document.baseURI).href,
   getManifest:()=>({name:'Esports Data',version:build.version}),
   connect({name}={}){const [a,b]=portPair(name);if(connectListeners.length)queueMicrotask(()=>{for(const fn of connectListeners)fn(b);});else pendingPorts.push(b);return a;},
   onConnect:{addListener(fn){connectListeners.push(fn);for(const p of pendingPorts.splice(0))queueMicrotask(()=>fn(p));}},
   sendMessage(message){
    // Like chrome: the first listener that answers wins (later ones must not act on the same message again).
    return new Promise(resolve=>{let async=false,done=false;const respond=v=>{if(!done){done=true;resolve(v);}};for(const fn of messageListeners){if(fn(message,{id:'page'},respond)===true)async=true;if(done||async)break;}if(!async)respond(undefined);});
   },
   onMessage:{addListener:fn=>messageListeners.add(fn),removeListener:fn=>messageListeners.delete(fn)},
   getContexts:async()=>[],
   lastError:undefined,
  },
  permissions:{contains:async()=>false,request:async()=>false,remove:async()=>true},
  alarms:{
   create(name,{periodInMinutes=1}={}){clearInterval(alarms.get(name)?.timer);const entry={name,periodInMinutes,timer:setInterval(()=>{for(const fn of alarmListeners)try{fn({name});}catch{}},Math.max(30000,periodInMinutes*60000))};alarms.set(name,entry);},
   async get(name){const a=alarms.get(name);return a?{name,periodInMinutes:a.periodInMinutes}:undefined;},
   async clear(name){const a=alarms.get(name);if(a)clearInterval(a.timer);return alarms.delete(name);},
   onAlarm:{addListener:fn=>alarmListeners.add(fn)}
  },
  notifications:{create:(id,o)=>notify(id,o),onClicked:{addListener:fn=>notificationClicks.add(fn)}},
  action:{onClicked:noop},
  tabs:{create:async({url})=>{openExternal(url);return {};},update:async()=>({}),remove:async()=>{}},
  windows:{create:async({url,width,height})=>openWindow(url,width,height),get:async()=>({type:'popup'}),update:async()=>({})}
 };

 // ------------------------------------------------------------------------------------------------ session -------
 const REASON_TEXT={
  replaced:'Эта сессия была завершена, потому что ключ доступа использован в другом профиле.',
  admin:'Сессия завершена администратором.',
  access_revoked:'Ключ доступа больше не действует. Обратитесь к администратору.',
  expired:'Срок сессии истёк. Введите ключ доступа снова.'
 };
 const SENSITIVE=k=>/^(lastKnown|entitlements9|seenEvents|hltvLocalData|publishedLeagueRevision|sharedVisibilityRevision)/.test(k);
 let ending=false;
 async function forgetAccount(){
  ls.del(SIGNED_IN);if(desktop){token='';ls.del(TOKEN_KEY);}
  try{await storageReady;await local.remove([...mem.keys()].filter(SENSITIVE));}catch{}
 }
 async function sessionEnded(reason){
  if(ending)return;ending=true;
  ss.set(ENDED,String(reason||'none'));
  await forgetAccount();
  location.reload();
 }
 async function sessionInfo(){
  const r=await window.fetch(apiBase+'/auth/session',{cache:'no-store'});
  let data=null;try{data=await r.json();}catch{}
  return {status:r.status,data};
 }
 let checking=null;
 function checkSession(){
  if(checking||ending)return checking;
  checking=sessionInfo().then(({status,data})=>{if(status===401)sessionEnded(data?.reason||'none');}).catch(()=>{}).finally(()=>{checking=null;});
  return checking;
 }
 async function logout(){
  try{await window.fetch(apiBase+'/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}catch{}
  ending=true;ss.del(ENDED);await forgetAccount();location.reload();
 }

 // ------------------------------------------------------------------------------------------------ boot ----------
 const $=id=>document.getElementById(id);
 function loadApp(){
  $('gate').hidden=true;$('boot').hidden=true;$('app').hidden=false;
  document.documentElement.classList.add('signed-in');
  for(const src of build.scripts){const s=document.createElement('script');s.src=src;s.async=false;document.body.appendChild(s);}
  setInterval(()=>{if(!document.hidden)checkSession();},60000);
  scheduleUpdateChecks();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkSession();});
  // A notification switch turned on asks for the browser permission while the click still counts as a user action.
  document.addEventListener('change',e=>{const t=e.target;if(!t?.matches?.('[data-notify]')||!t.checked)return;const n=tauri()?.notification;if(desktop&&n?.requestPermission)n.requestPermission().catch(()=>{});else if(typeof Notification==='function'&&Notification.permission==='default')Notification.requestPermission().catch(()=>{});},true);
 }
 function showGate(reason){
  $('boot').hidden=true;$('app').hidden=true;$('gate').hidden=false;
  const notice=$('gateNotice'),text=REASON_TEXT[reason]||'';
  notice.hidden=!text;notice.textContent=text;
  const input=$('gateKey');input.value='';setTimeout(()=>input.focus(),0);
 }
 function bindGate(){
  const form=$('gateForm'),input=$('gateKey'),error=$('gateError'),button=$('gateSubmit');
  $('gateReveal').onclick=()=>{const show=input.type==='password';input.type=show?'text':'password';$('gateReveal').setAttribute('aria-pressed',String(show));$('gateReveal').textContent=show?'Скрыть':'Показать';input.focus();};
  form.onsubmit=async e=>{
   e.preventDefault();
   const key=input.value.trim();
   if(!key){error.textContent='Введите ключ доступа';input.focus();return;}
   button.disabled=true;error.textContent='';button.textContent='Проверяем…';
   try{
    const r=await window.fetch(apiBase+'/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,client:desktop?'tauri':'web'}),cache:'no-store'});
    input.value='';
    let data=null;try{data=await r.json();}catch{}
    if(r.ok&&data?.ok){
     if(desktop){token=String(data.token||'');ls.set(TOKEN_KEY,token);}
     ls.set(SIGNED_IN,'1');ss.del(ENDED);$('gateNotice').hidden=true;
     loadApp();return;
    }
    error.textContent=data?.error||(r.status===429?'Слишком много попыток. Повторите позже.':'Не удалось войти');
   }catch{error.textContent='Нет связи с сервером. Проверьте подключение к интернету.';}
   finally{button.disabled=false;button.textContent='Войти';}
   input.focus();
  };
 }
 async function boot(){
  // Secondary pages (calculator window): no gate of their own; without a session they go back to the main page.
  if(!$('gate')){try{const {status}=await sessionInfo();if(status===401)location.replace(new URL('./',location.href).href);}catch{}return;}
  bindGate();
  const ended=ss.get(ENDED);
  if(ended){ss.del(ENDED);showGate(ended);return;}
  if(desktop&&!token){showGate('none');return;}
  try{
   const {status,data}=await sessionInfo();
   if(status===200&&data?.authenticated){ls.set(SIGNED_IN,'1');await storageReady;loadApp();protocolCheck(data.protocol);return;}
   if(status===401){await forgetAccount();showGate(data?.reason==='none'?'none':data?.reason);return;}
   throw new Error('HTTP '+status);
  }catch{
   // Offline or the service is restarting: a profile that was signed in opens with its last-known data (as the
   // extension does); the first answer from the server decides whether the session is still valid.
   if(ls.get(SIGNED_IN)==='1'){await storageReady;loadApp();return;}
   showGate('none');$('gateError').textContent='Нет связи с сервером. Проверьте подключение к интернету.';
  }
 }

 // ------------------------------------------------------------------------------------------------ desktop updates
 // Signed updates through the Tauri updater plugin: latest.json (esportsdata.online, GitHub release as fallback) →
 // the per-user NSIS installer, whose signature the plugin verifies against the public key compiled into the app
 // before anything runs. Nothing is installed without the user's click; the session (WebView2 profile of this Windows
 // user) survives the update. Web and server releases do not touch latest.json, so they never trigger an update.
 const UPDATE_CHECKED='eds-update-checked',UPDATE_EVERY=6*3600000;
 const updater={pending:null,state:'idle',error:'',progress:0};
 async function checkForUpdate({manual=false}={}){
  const u=tauri()?.updater;if(!desktop||!u?.check)return null;
  updater.state='checking';updater.error='';
  try{const update=await u.check();updater.pending=update||null;updater.state=update?'available':'current';ls.set(UPDATE_CHECKED,String(Date.now()));if(update)showUpdateBar(update);return update;}
  catch(e){updater.state='error';updater.error=String(e?.message||e);if(manual)throw e;return null;}
 }
 async function installUpdate(){
  const update=updater.pending;if(!update)return;
  updater.state='downloading';updater.progress=0;let total=0,got=0;renderUpdateBar();
  await update.downloadAndInstall(ev=>{if(ev?.event==='Started')total=Number(ev.data?.contentLength)||0;else if(ev?.event==='Progress'){got+=Number(ev.data?.chunkLength)||0;updater.progress=total?Math.round(got*100/total):0;renderUpdateBar();}else if(ev?.event==='Finished'){updater.state='installing';renderUpdateBar();}});
  // On Windows the installer closes the app itself; relaunch covers the other platforms.
  await tauri()?.process?.relaunch?.();
 }
 let updateBar=null,updateRequired=false;
 function renderUpdateBar(){
  if(!updateBar)return;
  const u=updater.pending,busy=updater.state==='downloading'||updater.state==='installing';
  updateBar.innerHTML=`<span>${updateRequired?'Нужна новая версия приложения':'Доступна новая версия'} <b>${escText(u?.version||'')}</b>${busy?` · ${updater.state==='installing'?'установка…':`загрузка ${updater.progress}%`}`:''}</span>${busy?'':`<button type="button" class="btn primary" data-update="install">Обновить</button>${updateRequired?'':'<button type="button" class="btn ghost" data-update="later">Позже</button>'}`}`;
  updateBar.querySelector('[data-update="install"]')?.addEventListener('click',()=>installUpdate().catch(e=>{updater.state='error';updater.error=String(e?.message||e);updateBar.querySelector('span').textContent='Обновление не установлено: '+updater.error;}));
  updateBar.querySelector('[data-update="later"]')?.addEventListener('click',()=>{updateBar.remove();updateBar=null;});
 }
 function showUpdateBar(){if(!updateBar){updateBar=document.createElement('div');updateBar.className='eds-update';updateBar.setAttribute('role','status');document.body.appendChild(updateBar);}renderUpdateBar();}
 function scheduleUpdateChecks(){
  if(!desktop||!tauri()?.updater)return;
  const due=()=>Date.now()-Number(ls.get(UPDATE_CHECKED)||0)>=UPDATE_EVERY;
  setTimeout(()=>{if(due())checkForUpdate();},15000);
  setInterval(()=>{if(due())checkForUpdate();},3600000);
 }
 function protocolCheck(protocol){
  if(!desktop||!protocol)return;
  if(Number(protocol.minClient)>Number(build.protocol||1)){updateRequired=true;checkForUpdate().then(u=>{if(!u){updater.pending={version:''};showUpdateBar();}});}
 }

 // ------------------------------------------------------------------------------------------------ settings UI ---
 const fmt=ms=>ms?new Date(ms).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
 const escText=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 async function renderAccount(body,{toast}={}){
  body.innerHTML=`<h2>Аккаунт</h2><p class="lead">Доступ по ключу и текущая сессия.</p><section class="setting-card"><div class="skeleton" style="height:120px"></div></section>`;
  let info=null,manifest=null;
  try{info=(await sessionInfo()).data;}catch{}
  if(!desktop)try{const r=await window.fetch('/downloads/desktop/manifest.json',{cache:'no-store'});if(r.ok)manifest=await r.json();}catch{}
  if(!body.isConnected)return;
  const s=info?.session;
  const sessionCard=s?`<section class="setting-card"><h3>Доступ</h3><dl class="kv">
    <dt>Ключ доступа</dt><dd>${escText(s.key.label||'—')}${s.key.suffix?` · <code>emu_…${escText(s.key.suffix)}</code>`:''}</dd>
    ${s.key.expiresAt?`<dt>Ключ действует до</dt><dd>${fmt(s.key.expiresAt)}</dd>`:''}
    <dt>Статус сессии</dt><dd><span class="pill on">активна</span></dd>
    <dt>Это устройство</dt><dd>${escText(s.clientType==='tauri'?'Приложение для Windows':'Веб-версия')} · ${escText(s.client||s.platform||'')}</dd>
    <dt>Вход выполнен</dt><dd>${fmt(s.createdAt)}</dd>
    <dt>Последняя активность</dt><dd>${fmt(s.lastSeenAt)}</dd>
    <dt>Сессия истекает</dt><dd>${fmt(Math.min(s.expiresAt,s.absoluteExpiresAt))}<small class="muted"> · продлевается при работе, но не позже ${fmt(s.absoluteExpiresAt)}</small></dd>
   </dl><p class="muted">Один ключ доступа работает только в одном профиле браузера или приложении. Вход этим ключом в другом месте завершит эту сессию.</p>
   <div class="row-actions"><button type="button" class="btn" id="accountLogout">Выйти</button></div></section>`
   :`<section class="setting-card"><p>Не удалось получить данные сессии.</p><div class="row-actions"><button type="button" class="btn" id="accountLogout">Выйти</button></div></section>`;
  let desktopCard='';
  if(desktop)desktopCard=`<section class="setting-card"><h3>Приложение</h3><dl class="kv"><dt>Версия</dt><dd>Esports Data Desktop ${escText(build.version)}</dd><dt>Сборка</dt><dd><code>${escText(build.commit||'—')}</code></dd><dt>Сервер</dt><dd>${escText(apiBase)}</dd><dt>Обновления</dt><dd id="updateState">${updater.state==='available'?'доступна версия '+escText(updater.pending?.version||''):updater.state==='current'?'установлена последняя версия':updater.state==='error'?'проверка не удалась':'проверяются автоматически'}${ls.get(UPDATE_CHECKED)?` <small class="muted">· проверено ${fmt(Number(ls.get(UPDATE_CHECKED)))}</small>`:''}</dd></dl><p class="muted">Обновления подписаны: приложение проверяет подпись перед установкой. Установка не требует прав администратора.</p><div class="row-actions"><button type="button" class="btn" id="updateCheck">Проверить обновления</button>${updater.pending?.version?'<button type="button" class="btn primary" id="updateInstall">Обновить</button>':''}</div></section>`;
  else if(manifest?.url)desktopCard=`<section class="setting-card"><h3>Приложение для Windows</h3><p>Та же программа отдельным окном, без установки и прав администратора: скачайте архив, распакуйте и запустите <code>${escText(manifest.executable||'EsportsData.exe')}</code>. Нужен Microsoft Edge WebView2 (есть в Windows 10/11).</p>
    <dl class="kv"><dt>Версия</dt><dd>${escText(manifest.version)}</dd><dt>Дата выпуска</dt><dd>${fmt(Date.parse(manifest.releasedAt))}</dd><dt>Размер</dt><dd>${manifest.size?(manifest.size/1048576).toFixed(1)+' МБ':'—'}</dd><dt>SHA-256</dt><dd><code class="sha">${escText(manifest.sha256)}</code></dd></dl>
    <div class="row-actions"><a class="btn primary" id="desktopDownload" href="${escText(new URL(manifest.url,location.href).pathname)}" download>Скачать для Windows (portable)</a></div></section>`;
  else desktopCard=`<section class="setting-card"><h3>Приложение для Windows</h3><p class="muted">Сборка готовится и появится здесь.</p></section>`;
  body.innerHTML=`<h2>Аккаунт</h2><p class="lead">Доступ по ключу и текущая сессия.</p>${sessionCard}${desktopCard}`;
  body.querySelector('#updateCheck')?.addEventListener('click',async()=>{const b=body.querySelector('#updateCheck');b.disabled=true;try{const u=await checkForUpdate({manual:true});toast?.(u?'Доступна версия '+u.version:'Установлена последняя версия');}catch(e){toast?.('Не удалось проверить обновления');}renderAccount(body,{toast});});
  body.querySelector('#updateInstall')?.addEventListener('click',()=>installUpdate().catch(()=>toast?.('Обновление не установлено')));
  const out=body.querySelector('#accountLogout');
  if(out)out.onclick=()=>{if(out.dataset.armed!=='1'){out.dataset.armed='1';out.textContent='Нажмите ещё раз, чтобы выйти';toast?.('Сессия будет завершена на этом устройстве');return;}out.disabled=true;logout();};
 }

 // Administrators: Settings → Сессии. Uses /auth/admin/* (the gateway); never shows a key or a session token.
 const adminSessions={status:'active',data:null,error:'',busy:false,armed:''};
 async function renderAdminSessions(body,{toast,report}={}){
  const load=async()=>{const r=await window.fetch(apiBase+'/auth/admin/sessions?status='+adminSessions.status,{cache:'no-store'});const d=await r.json().catch(()=>null);if(!r.ok)throw new Error(d?.error||'HTTP '+r.status);adminSessions.data=d;};
  const post=async(path,payload={})=>{const r=await window.fetch(apiBase+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json().catch(()=>null);if(!r.ok)throw new Error(d?.error||'HTTP '+r.status);return d;};
  const badge=s=>`<span class="pill ${s==='ACTIVE'?'on':'off'}">${{ACTIVE:'активна',REVOKED:'отозвана',EXPIRED:'истекла'}[s]||s}</span>`;
  const reason=r=>({replaced:'вход в другом профиле',logout:'выход',switched:'вход другим ключом',admin:'администратор',admin_key:'администратор (все сессии ключа)',key_disabled:'ключ отключён',key_deleted:'ключ удалён',key_rotated:'ключ заменён',key_expired:'срок ключа',expired:'истёк срок'})[r]||r||'';
  const draw=()=>{
   if(!body.isConnected)return;
   const d=adminSessions.data;
   const rows=!d?'<div class="skeleton" style="height:160px"></div>':d.sessions.length?`<div class="table-scroll"><table class="data-table admin-sessions"><thead><tr><th>Ключ</th><th>Сессия</th><th>Клиент</th><th>Устройство</th><th>Вход</th><th>Активность</th><th>Истекает</th><th>Сеть</th><th>Статус</th><th></th></tr></thead><tbody>${d.sessions.map(s=>`<tr${s.current?' class="current"':''}><td><b>${escText(s.keyLabel)}</b>${s.keyMasked?`<br><code>${escText(s.keyMasked)}</code>`:''}</td><td><code>${escText(s.id.slice(0,8))}…</code>${s.current?'<br><small>это вы</small>':''}</td><td>${escText(s.clientType)}</td><td>${escText(s.client||s.platform)}</td><td>${fmt(s.createdAt)}</td><td>${fmt(s.lastSeenAt)}${s.live?'<br><small>поток открыт</small>':''}</td><td>${s.status==='ACTIVE'?fmt(s.expiresAt):fmt(s.revokedAt)}</td><td>${escText([s.network,s.country].filter(Boolean).join(' · ')||'—')}</td><td>${badge(s.status)}${s.revokeReason?`<br><small>${escText(reason(s.revokeReason))}</small>`:''}</td><td>${s.status==='ACTIVE'&&!s.current?`<button type="button" class="btn" data-revoke="${escText(s.id)}">${adminSessions.armed===s.id?'Подтвердить':'Отозвать'}</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Нет сессий.</p>';
   const keys=d?`<div class="table-scroll"><table class="data-table admin-keys"><thead><tr><th>Ключ</th><th>Роль</th><th>Статус</th><th>Срок действия</th><th>Последний вход</th><th>Активная сессия</th><th>Действия</th></tr></thead><tbody>${d.keys.map(k=>`<tr><td><b>${escText(k.label)}</b>${k.masked?`<br><code>${escText(k.masked)}</code>`:''}</td><td>${k.role==='admin'?'администратор':'пользователь'}</td><td>${k.enabled?(k.expired?'<span class="pill off">истёк</span>':'<span class="pill on">включён</span>'):'<span class="pill off">отключён</span>'}</td><td><input type="date" class="input" data-expiry="${escText(k.id)}" value="${k.expiresAt?new Date(k.expiresAt).toISOString().slice(0,10):''}" aria-label="Срок действия ключа ${escText(k.label)}"></td><td>${fmt(k.lastUsedAt)}</td><td>${k.activeSession?`${escText(k.activeSession.clientType)} · ${escText(k.activeSession.client||k.activeSession.platform)}<br><small>${fmt(k.activeSession.lastSeenAt)}</small>`:'—'}</td><td class="row-actions">${k.activeSession?`<button type="button" class="btn" data-key-revoke="${escText(k.id)}">${adminSessions.armed==='r:'+k.id?'Подтвердить':'Отозвать все сессии'}</button>`:''}${k.self?'<small>ваш ключ</small>':k.enabled?`<button type="button" class="btn danger" data-key-disable="${escText(k.id)}">${adminSessions.armed==='d:'+k.id?'Подтвердить':'Отключить ключ'}</button>`:`<button type="button" class="btn" data-key-enable="${escText(k.id)}">Включить ключ</button>`}</td></tr>`).join('')}</tbody></table></div>`:'';
   body.innerHTML=`<h2>Сессии</h2><p class="lead">Где сейчас используется каждый ключ доступа. Один ключ — одна активная сессия: вход в новом профиле или приложении завершает предыдущую.</p>
    ${adminSessions.error?`<div class="banner bad" role="alert">${escText(adminSessions.error)}</div>`:''}
    <section class="setting-card"><div class="row-actions"><span class="segmented" role="group" aria-label="Показать"><button type="button" data-sess-status="active" aria-pressed="${adminSessions.status==='active'}">Активные</button><button type="button" data-sess-status="all" aria-pressed="${adminSessions.status==='all'}">Все</button></span><span class="spacer"></span><button type="button" class="btn ghost" id="sessRefresh">Обновить</button></div>${rows}</section>
    <section class="setting-card"><h3>Ключи доступа</h3><p class="muted">Новый ключ создаётся в разделе «Пользователи» и показывается один раз. Отключение ключа сразу завершает его сессию.</p>${keys}</section>`;
   body.querySelectorAll('[data-sess-status]').forEach(b=>b.onclick=()=>{adminSessions.status=b.dataset.sessStatus;adminSessions.data=null;draw();refresh();});
   body.querySelector('#sessRefresh').onclick=()=>refresh();
   const act=async(armKey,fn,done)=>{if(adminSessions.armed!==armKey){adminSessions.armed=armKey;draw();return;}adminSessions.armed='';try{await fn();toast?.(done);}catch(e){adminSessions.error=e.message;}await refresh();};
   body.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=()=>act(b.dataset.revoke,()=>post(`/auth/admin/sessions/${encodeURIComponent(b.dataset.revoke)}/revoke`),'Сессия отозвана'));
   body.querySelectorAll('[data-key-revoke]').forEach(b=>b.onclick=()=>act('r:'+b.dataset.keyRevoke,()=>post(`/auth/admin/keys/${encodeURIComponent(b.dataset.keyRevoke)}/revoke-sessions`),'Сессии ключа завершены'));
   body.querySelectorAll('[data-key-disable]').forEach(b=>b.onclick=()=>act('d:'+b.dataset.keyDisable,()=>post(`/auth/admin/keys/${encodeURIComponent(b.dataset.keyDisable)}/disable`),'Ключ отключён'));
   // Enabling is harmless: no confirmation step.
   body.querySelectorAll('[data-key-enable]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await post(`/auth/admin/keys/${encodeURIComponent(b.dataset.keyEnable)}/enable`);toast?.('Ключ включён');}catch(e){adminSessions.error=e.message;}refresh();});
   body.querySelectorAll('[data-expiry]').forEach(i=>i.onchange=async()=>{const v=i.value?Date.parse(i.value+'T23:59:59'):null;try{await post(`/auth/admin/keys/${encodeURIComponent(i.dataset.expiry)}/expiry`,{expiresAt:v});toast?.(v?'Срок действия сохранён':'Срок действия снят');}catch(e){adminSessions.error=e.message;}refresh();});
  };
  const refresh=async()=>{try{await load();adminSessions.error='';}catch(e){adminSessions.error=e.message;report?.(e);}draw();};
  draw();await refresh();
 }

 window.Platform={
  hosted:true,target:build.target,desktop,version:build.version,commit:build.commit||'',apiBase,
  storageReady,sessionEnded,checkSession,logout,openExternal,renderAccount,renderAdminSessions,
  reasonText:r=>REASON_TEXT[r]||''
 };
 // Links always open in the system/current browser here (the extension's native browser helper does not exist);
 // windows (calculator) are opened by the background engine through chrome.windows.create above.
 messageListeners.add((message,sender,respond)=>{
  if(message?.type==='openExternal'){respond(openExternal(message.url)?{ok:true,browser:'current'}:{error:'Некорректная ссылка'});return false;}
  return undefined;
 });
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
