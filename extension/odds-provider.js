/* LIVE odds provider selection: GGBET or DataBet, one at a time.
   Pure helpers shared by the service worker and the app; kept independent from Chrome APIs so the
   selection rules can be regression-tested. The two providers are never merged into one view. */
(function(root){
 const PROVIDERS=Object.freeze(['ggbet','databet']);
 const NAMES=Object.freeze({ggbet:'GGBET',databet:'DataBet'});
 const DEFAULT='ggbet';
 const normalize=value=>{const v=String(value||'').trim().toLowerCase();return PROVIDERS.includes(v)?v:DEFAULT;};
 const selected=prefs=>normalize(prefs?.liveOddsProvider);
 const isOddsProvider=source=>PROVIDERS.includes(String(source||''));
 // A ref of the provider that is not selected never belongs to the current view.
 const visible=(source,prefs)=>!isOddsProvider(source)||String(source)===selected(prefs);
 const withProvider=(path,prefs)=>`${path}${String(path).includes('?')?'&':'?'}provider=${selected(prefs)}`;
 const name=provider=>NAMES[normalize(provider)];
 // Cache key of an event detail: a LIVE detail belongs to one odds provider and is never reused for the other.
 const detailKey=(view,id,prefs)=>`${view}:${view==='live'?selected(prefs)+':':''}${String(id)}`;
 // Status of the selected provider as reported by the server (`providers[provider].oddsProvider`).
 function health(snapshot,prefs){
  const provider=selected(prefs),row=snapshot?.providers?.[provider],status=row?.oddsProvider||null,label=name(provider);
  if(snapshot?.transportError)return {provider,label,ok:false,reason:String(snapshot.transportError)};
  if(!snapshot)return {provider,label,ok:true,reason:''};
  if(!status)return snapshot.liveOddsProvider&&snapshot.liveOddsProvider!==provider?{provider,label,ok:false,reason:'сервер вернул данные другого источника'}:{provider,label,ok:true,reason:''};
  // A server may run without the default provider on purpose: that is not an outage worth a banner.
  if(status.connectionState==='disabled')return provider===DEFAULT?{provider,label,ok:true,reason:''}:{provider,label,ok:false,reason:'источник отключён на сервере'};
  if(status.stale)return {provider,label,ok:false,reason:status.lastUpdateAt?'данные источника устарели':(status.lastError||'ожидаем первые данные источника')};
  // `available` already includes the server's grace window for a quick reconnect (token refresh).
  if(status.available===false||(status.available===undefined&&status.connectionState!=='connected'))return {provider,label,ok:false,reason:status.lastError||'нет соединения с источником, переподключаемся'};
  return {provider,label,ok:true,reason:''};
 }
 const api={PROVIDERS,NAMES,DEFAULT,normalize,selected,isOddsProvider,visible,withProvider,name,detailKey,health};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.OddsProvider=api;
})(globalThis);
