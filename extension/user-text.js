'use strict';
/* What a user reads when something fails. Ordinary users get plain words ("GGBET временно недоступен", "Сервер не
   ответил вовремя"); the technical reason (proxy, environment variables, upstream URLs, tokens...) is never shown to
   them. Administrators see a sanitized reason (no URLs with credentials, no tokens, no IP:port). Pure; unit-tested. */
(function(root){
 const TECHNICAL=/[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}|https?:\/\/|\bwss?:\/\/|\bproxy\b|прокси|\bHTTP\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|:\d{2,5}\b|\btoken\b|токен|cookie|\bENOTFOUND\b|\bECONN\w*|\bETIMEDOUT\b|fetch failed|graphql|websocket|bootstrap|upstream|stack|undefined|null\b|\{|\}/i;
 function sanitize(text){
  return String(text??'').replace(/\b[a-z][\w+.-]*:\/\/[^\s/@]+@/gi,m=>m.replace(/\/\/[^@]+@/,'//***@')).replace(/\bBearer\s+\S+/gi,'Bearer ***').replace(/\b(?:emu_|eyJ)[\w.-]{12,}/g,'***').replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/g,'<адрес>').slice(0,240);
 }
 const plain=text=>{const t=String(text||'').trim();return !!t&&/[а-яё]/i.test(t)&&!TECHNICAL.test(t)&&t.length<=160;};
 function error(err,{admin=false}={}){
  const name=err?.name,status=Number(err?.status)||0,text=String(err?.message||err||'').trim();
  if(name==='TimeoutError'||name==='AbortError'||/timed out|aborted|не ответил вовремя/i.test(text))return 'Сервер не ответил вовремя';
  if(/failed to fetch|fetch failed|networkerror|network error|load failed|сервер недоступен/i.test(text))return 'Сервер недоступен';
  if(status===401)return 'Нужен ключ доступа — укажите его в настройках подключения';
  if(status===403)return 'Нет доступа к этому разделу';
  if(status===429)return 'Слишком много запросов — повторите через минуту';
  if(status>=500)return admin&&text?`Сервер временно недоступен (${sanitize(text)})`:'Сервер временно недоступен';
  if(plain(text))return text;
  if(status===404)return 'Данные не найдены';
  return admin&&text?sanitize(text):'Не удалось загрузить данные';
 }
 // Why a bookmaker is unavailable: administrators get the sanitized reason, everybody else nothing (callers show
 // "<bookmaker> временно недоступен").
 const sourceReason=(reason,{admin=false}={})=>admin?sanitize(reason):'';
 const api={error,sourceReason,sanitize,plain};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.UserText=api;
})(globalThis);
