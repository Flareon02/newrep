import {responseTextLimited} from './utils.js';
import {liveStatisticsMatchScore} from './entity-resolver.js';
// Public Inertia page data. No account, cookies, bookmaker requests or video proxy.
export const hawkName=s=>String(s||'').toLowerCase().replace(/natus\s*vincere|na[’']?vi/g,'navi').replace(/\b(esports|gaming|team)\b/g,'').replace(/[^\p{L}\p{N}]/gu,'');
const decode=s=>s.replace(/&quot;/g,'"').replace(/&#0*39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export function hawkPage(text){try{return JSON.parse(text);}catch{const m=text.match(/\bdata-page=("|')([\s\S]*?)\1/);if(!m)throw Error('Статистика: данные страницы недоступны');return JSON.parse(decode(m[2]));}}
const pathOf=s=>'/dota-2/matches/'+encodeURIComponent(s.championship.slug)+'/'+encodeURIComponent(s.slug);
const assetUrl=value=>{try{const u=new URL(String(value||''));return u.protocol==='https:'&&u.hostname==='hawk.live'?u.href:null;}catch{return null;}};
export function hawkSeries(props){const out=new Map();function walk(v,key='',depth=0){if(depth>8||!v||typeof v!=='object'||/headToHead|latestPosts|odds|partner/i.test(key))return;if(v.id&&v.slug&&v.championship?.slug&&v.team1?.name&&v.team2?.name){out.set(String(v.id),v);return;}for(const [k,x] of Object.entries(v))walk(x,k,depth+1);}walk(props);return [...out.values()];}
function streamLink(s){try{const u=new URL(s.url);if(u.protocol!=='https:')return null;let url;if(u.hostname==='player.twitch.tv'){const c=u.searchParams.get('channel');if(!/^[a-zA-Z0-9_]+$/.test(c||''))return null;url='https://www.twitch.tv/'+c;}else if(u.hostname==='player.kick.com')url='https://kick.com/'+u.pathname.split('/').filter(Boolean)[0];else if(['twitch.tv','www.twitch.tv','kick.com','youtube.com','www.youtube.com','youtu.be'].includes(u.hostname))url=u.href;else return null;return {name:s.name,language:s.languageCodeName,url};}catch{return null;}}
export function hawkGoldTimeline(states,currentTime){
 const ordered=(states||[]).filter(s=>Number.isFinite(Number(s.gameTime))&&Number.isFinite(Number(s.radiantNetWorthAdvantage))).sort((a,b)=>Number(a.id)-Number(b.id));
 const positive=ordered.filter(s=>Number(s.gameTime)>=0);if(!positive.length)return [];
 // Hawk uses both elapsed and countdown-style clocks depending on the live feed.
 // A decreasing clock is therefore not by itself a reset. Detect a real reset only
 // when one large move goes against the established direction and the following
 // state immediately resumes the old direction.
 let start=0,direction=0;
 const sign=n=>n>0?1:n<0?-1:0;
 for(let i=1;i<positive.length;i++){
  const prev=Number(positive[i-1].gameTime),cur=Number(positive[i].gameTime),delta=cur-prev,dir=sign(delta);
  if(!dir||Math.abs(delta)<=2)continue;
  if(!direction){direction=dir;continue;}
  if(dir!==direction&&Math.abs(delta)>15){
   let nextDir=0;for(let j=i+1;j<positive.length;j++){const d=Number(positive[j].gameTime)-Number(positive[j-1].gameTime);if(Math.abs(d)>2){nextDir=sign(d);break;}}
   if(nextDir===direction)start=i;else if(nextDir===dir)direction=dir;
  }
 }
 const end=Number(currentTime),out=[];
 for(const row of positive.slice(start)){
  const t=Number(row.gameTime);
  if(Number.isFinite(end)&&direction>=0&&t>end+2)continue;
  if(Number.isFinite(end)&&direction<0&&t<end-2)continue;
  out.push(row);
 }
 return out.slice(-2400);
}
export function normalizeHawk(series,at=Date.now()){
 const maps=(series.matches||[]).map(m=>{const states=(m.states||[]).filter(x=>Number.isFinite(Number(x.gameTime))).sort((a,b)=>Number(a.id)-Number(b.id)),state=states.at(-1)||null,timeline=hawkGoldTimeline(states,state?.gameTime),radiant=m.isTeam1Radiant===true,side=m.isTeam1Radiant==null?null:radiant;
  const pair=(a,b)=>side==null?null:radiant?[a,b]:[b,a];
  return {id:m.id,number:m.number,isTeam1Radiant:side,winner:m.isRadiantWinner==null||side==null?null:m.isRadiantWinner===radiant?0:1,gameTime:state?.gameTime??null,score:state?pair(state.radiantScore,state.direScore):null,goldAdvantage:state?.radiantNetWorthAdvantage==null||side==null?null:Number(state.radiantNetWorthAdvantage)*(radiant?1:-1),goldHistory:side==null?[]:timeline.map(s=>({time:Number(s.gameTime),value:Number(s.radiantNetWorthAdvantage)*(radiant?1:-1)})),buildings:state?.buildingState||null,picks:(m.picks||[]).map(p=>({team:side==null?null:p.isRadiant===radiant?0:1,hero:p.hero?.name,player:p.player?.officialName||p.player?.name})),stateId:state?.id??null};});
 const observed=maps.filter(m=>m.winner!=null),score=Number.isInteger(series.team1Score)&&Number.isInteger(series.team2Score)?[series.team1Score,series.team2Score]:observed.length?[observed.filter(m=>m.winner===0).length,observed.filter(m=>m.winner===1).length]:maps.length?[0,0]:null;
 return {id:series.id,url:'https://hawk.live'+pathOf(series),team1:series.team1.name,team2:series.team2.name,team1Logo:assetUrl(series.team1?.logoUrl),team2Logo:assetUrl(series.team2?.logoUrl),league:series.championship.name,startAt:Date.parse(series.startAt),bestOf:series.bestOf,score,maps,streams:(series.streams||[]).map(streamLink).filter(Boolean),checkedAt:at};
}
// Event names and public series channel follow Hawk's own SeriesPage client.
export function applyHawkUpdate(series,event,data){
 const kind=String(event).split('\\').at(-1),matches=series.matches||(series.matches=[]),id=String(data.matchId??data.id),i=matches.findIndex(m=>String(m.id)===id);
 if(kind==='SeriesUpdated'){for(const k of ['slug','championship','team1','team2','bestOf','startAt','streams'])if(data[k]!==undefined)series[k]=data[k];return true;}
 if(kind==='MatchCreated'){if(!data.id||!data.number)return false;if(i<0)matches.push({...data,states:data.states||[],picks:data.picks||[]});else matches[i]={...matches[i],...data};matches.sort((a,b)=>a.number-b.number);return true;}
 if(i<0)return false;const m=matches[i];
 if(kind==='MatchStateCreated'&&data.matchState){const state=data.matchState;if(!Number.isFinite(Number(state.gameTime)))return false;m.states=[...(m.states||[]).filter(s=>String(s.id)!==String(state.id)),state].sort((a,b)=>Number(a.id)-Number(b.id)).slice(-4001);return true;}
 if(kind==='MatchFinished'){m.isRadiantWinner=data.isRadiantWinner;return true;}
 if(kind==='MatchPicksUpdated'&&Array.isArray(data.picks)){m.picks=data.picks;return true;}
 if(kind==='MatchUpdated'){matches[i]={...m,...data};return true;}
 if(kind==='MatchDeleted'){matches.splice(i,1);return true;}return false;
}
export class HawkService {
 constructor(){this.onUpdate=()=>{};this.catalog=[];this.indexAt=0;this.cache=new Map();this.pending=new Map();this.cooldown=0;this.wsConfig=null;this.ws=null;this.ready=false;this.retryAt=0;this.retryDelay=2000;this.watch=null;this.connectAt=0;this.lastPacket=0;this.subscribed=new Set();this.wsAttempts=0;this.wsFailures=0;this.lastWsError='';}
 status(){return {transport:this.ready?'websocket':'page',connected:!!this.ws,ready:this.ready,subscribedSeries:this.subscribed.size,cachedSeries:this.cache.size,catalogSeries:this.catalog.length,lastPacketAt:this.lastPacket||null,indexUpdatedAt:this.indexAt||null,cooldownUntil:this.cooldown||0,wsAttempts:this.wsAttempts,wsFailures:this.wsFailures,lastWsError:this.lastWsError};}
 async page(path){if(Date.now()<this.cooldown)throw Error('Статистика временно недоступна; повторим позже');
  // Inertia without the matching asset version may return 409 with no body.
  // A normal document request contains the same public data-page snapshot.
  const r=await fetch('https://hawk.live'+path,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0'},credentials:'omit',signal:AbortSignal.timeout(10000)});
  if(!r.ok){if([403,429].includes(r.status))this.cooldown=Date.now()+300000;throw Error('Статистика: HTTP '+r.status);}const text=await responseTextLimited(r,8*1024*1024);const props=hawkPage(text).props||{};if(props.wsConfig)this.wsConfig=props.wsConfig;return props;
 }
 async once(key,fn){if(this.pending.has(key))return this.pending.get(key);const p=fn().finally(()=>this.pending.delete(key));this.pending.set(key,p);return p;}
 async index(){if(Date.now()-this.indexAt<15000)return this.catalog;return this.once('index',async()=>{const props=await this.page('/');const rows=hawkSeries(props);if(!rows.length)throw Error('Статистика: список матчей пуст');const now=Date.now();
  // The catalog is a current availability set, not an archive. Keeping rows
  // from previous homepage snapshots made a finished/removed series eligible
  // for a later bookmaker fixture with the same teams.
  this.catalog=rows.filter(s=>{const at=Date.parse(s.startAt);return !Number.isFinite(at)||at>now-12*3600000&&at<now+14*86400100;});this.indexAt=now;return this.catalog;});}
 send(event,data){if(this.ws?.readyState===1)this.ws.send(JSON.stringify({event,data}));}
 subscribe(){if(!this.ready)return;for(const [id,c] of this.cache)if(Date.now()-c.touch<90000&&!this.subscribed.has(id)){this.subscribed.add(id);this.send('pusher:subscribe',{channel:'series.'+id});}}
 connect(){const c=this.wsConfig;if(!c||c.host!=='ws.hawk.live'||!/^[\w-]{1,100}$/.test(c.key)||this.ws||Date.now()<this.retryAt||typeof WebSocket==='undefined')return;
  this.wsAttempts++;const ws=this.ws=new WebSocket('wss://ws.hawk.live:8443/app/'+encodeURIComponent(c.key)+'?protocol=7&client=js&version=8.4.0&flash=false');this.connectAt=Date.now();this.lastPacket=Date.now();
  ws.onmessage=({data})=>{try{if(this.ws!==ws||String(data).length>4*1024*1024)return;const m=JSON.parse(data),d=typeof m.data==='string'?JSON.parse(m.data):m.data;this.lastPacket=Date.now();
   if(m.event==='pusher:connection_established'){this.ready=true;this.retryDelay=2000;this.lastWsError='';this.subscribe();return;}
   if(m.event==='pusher:ping'){this.send('pusher:pong',{});return;}
   const id=String(m.channel||'').replace(/^series\./,''),cached=this.cache.get(id);if(!cached)return;
   if(m.event==='pusher_internal:subscription_succeeded'){cached.subscribed=true;cached.subscriptionAt=Date.now();return;}
   if(m.event==='pusher:error'){this.ready=false;this.wsFailures++;this.lastWsError='pusher:error '+String(d?.message||d?.code||'');ws.close();return;}
   if(d&&applyHawkUpdate(cached.series,m.event,d)){cached.changedAt=Date.now();cached.data={matched:true,event:normalizeHawk(cached.series,cached.changedAt)};this.onUpdate(id,this.result(cached));}
  }catch{}};
  const disconnected=()=>{if(this.ws!==ws)return;this.ws=null;this.ready=false;this.subscribed.clear();for(const c of this.cache.values()){c.subscribed=false;c.at=0;}this.retryAt=Date.now()+this.retryDelay;this.retryDelay=Math.min(60000,this.retryDelay*2);};ws.onerror=()=>{this.wsFailures++;this.lastWsError='WebSocket error';disconnected();try{ws.close();}catch{}};ws.onclose=disconnected;
  if(!this.watch){this.watch=setInterval(()=>{const now=Date.now();for(const [id,c] of this.cache)if(now-c.touch>90000){if(c.subscribed)this.send('pusher:unsubscribe',{channel:'series.'+id});this.cache.delete(id);this.subscribed.delete(id);}if(!this.cache.size){this.close();return;}if(this.ws&&(!this.ready&&now-this.connectAt>12000||now-this.lastPacket>90000)){const old=this.ws;this.ws=null;this.ready=false;this.subscribed.clear();for(const c of this.cache.values())c.subscribed=false;old.close();this.retryAt=now+5000;}this.connect();this.subscribe();},5000);this.watch.unref?.();}
 }
 close(){clearInterval(this.watch);this.watch=null;const ws=this.ws;this.ws=null;this.ready=false;this.subscribed.clear();for(const c of this.cache.values())c.subscribed=false;ws?.close();}
 result(c){const streaming=this.ready&&c.subscribed&&Date.now()-this.lastPacket<90000;return {...c.data,transport:streaming?'websocket':'page',stale:!streaming&&Date.now()-c.at>30000};}
 async get({team1,team2,startAt,id,statisticsId,league,category}={}){
  const catalog=await this.index(),a=String(team1||''),b=String(team2||'');
  // Bookmaker/logical event IDs are not Hawk series IDs. Only an explicit
  // numeric statistics ID may bypass automatic team+league matching.
  const manualId=/^\d{1,12}$/.test(String(statisticsId??id??''))?String(statisticsId??id):'';
  // LIVE statistics matching intentionally ignores startAt. Public statistics
  // pages commonly retain the scheduled time while bookmakers expose the real
  // start. Require >=50% similarity for each team and >=50% for the league.
  const pool=manualId?[...new Map([...catalog,...[...this.cache.values()].map(c=>c.series)].filter(Boolean).map(s=>[String(s.id),s])).values()]:catalog;
  const ranked=pool.flatMap(series=>{
    const x=String(series.team1?.name||''),y=String(series.team2?.name||'');if(!a||!b||!x||!y)return[];
    const info=liveStatisticsMatchScore(a,b,x,y,league||'',series.championship?.name||'',category||'Dota 2');
    return info?[{series,...info}]:[];
  }).sort((x,y)=>Number(y.exactPair)-Number(x.exactPair)||y.score-x.score||y.teamMin-x.teamMin||y.leagueScore-x.leagueScore);
  let selected=manualId?(pool.find(s=>String(s.id)===manualId)||this.cache.get(manualId)?.series):ranked[0]?.series||null;
  let matchQuality=manualId&&selected?'manual':selected?(ranked[0]?.exactPair?'exact-pair':'fuzzy-pair'):'';
  // With time removed, repeated fixtures of the same teams in the same league
  // must remain ambiguous unless one candidate is materially better by names.
  if(!manualId&&ranked.length>1&&ranked[0].score-ranked[1].score<.04&&ranked[0].exactPair===ranked[1].exactPair)selected=null;
  if(!selected)return {matched:false,message:ranked.length?'Найдено несколько похожих статистических матчей — автоматическое сопоставление пропущено.':'Точное совпадение статистического матча не найдено.'};
  const key=String(selected.id),cached=this.cache.get(key);if(cached){cached.touch=Date.now();this.connect();this.subscribe();if(Date.now()-cached.at<15000||this.ready&&cached.subscribed&&Date.now()-cached.at<120000)return {...this.result(cached),matchQuality};}
  return this.once(key,async()=>{try{const props=await this.page(pathOf(selected)),series=props.seriesPageData;if(!series||String(series.id)!==key)throw Error('Статистический источник вернул другой матч');const now=Date.now(),c={series,at:now,touch:now,changedAt:now,subscribed:cached?.subscribed||false,data:{matched:true,event:normalizeHawk(series,now)}};this.cache.set(key,c);this.connect();this.subscribe();return {...this.result(c),matchQuality};}catch(error){if(cached)return {...this.result(cached),matchQuality,stale:true,error:error.message};throw error;}});
 }
}
