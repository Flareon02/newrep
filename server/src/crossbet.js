import {responseTextLimited} from './utils.js';
import {liveStatisticsMatchScore} from './entity-resolver.js';
// One Socket.IO/Engine.IO v3 connection for live CS2 fixtures. The public
// match page is read once when somebody opens its panel; updates arrive via WS.
const clean=s=>String(s||'').normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const validLink=s=>{try{const u=new URL(s);if(u.protocol!=='https:')return '';if(u.hostname==='player.twitch.tv'){const name=u.searchParams.get('channel');return name&&/^[\w]{2,30}$/.test(name)?`https://www.twitch.tv/${name}`:'';}if(u.hostname==='player.kick.com'){const name=u.pathname.slice(1);return name&&/^[\w-]{2,50}$/.test(name)?`https://kick.com/${name}`:'';}return ['www.twitch.tv','twitch.tv','kick.com'].includes(u.hostname)?u.href:'';}catch{return '';}};
const validLogo=s=>{try{const u=new URL(s);return u.protocol==='https:'&&u.hostname==='cdn.cross.bet'?u.href:'';}catch{return '';}};
const values=v=>Array.isArray(v)?v:(v&&typeof v==='object'?Object.values(v):[]);
const objects=v=>values(v).filter(x=>x&&typeof x==='object');
const teamRows=v=>{
 if(Array.isArray(v))return objects(v).map((row,index)=>({...row,_slot:index?'away':'home',_teamIndex:index}));
 if(!v||typeof v!=='object')return[];
 const entries=Object.entries(v),numeric=entries.map(([key])=>/^\d+$/.test(key)?Number(key):null).filter(Number.isFinite),zeroBased=numeric.includes(0);
 return entries.flatMap(([key,row])=>{
  const lower=clean(key),numericKey=/^\d+$/.test(key)?Number(key):null;
  const structural=/^(?:home|away|team1|team2|t|ct|0|1|2)$/.test(lower);
  let teamIndex=null;
  if(Number.isFinite(numericKey))teamIndex=zeroBased?numericKey:numericKey-1;
  else if(/^(?:home|team1)$/.test(lower))teamIndex=0;
  else if(/^(?:away|team2)$/.test(lower))teamIndex=1;
  const fallbackName=structural?'':key;
  if(Array.isArray(row))return [{name:fallbackName,members:row,_slot:key,_teamIndex:teamIndex}];
  if(row&&typeof row==='object')return [{...row,name:row.name||fallbackName,_slot:key,_teamIndex:teamIndex}];
  return[];
 });
};
const roundRows=v=>{const rows=Array.isArray(v)?v.map((row,index)=>[String(index+1),row]):v&&typeof v==='object'?Object.entries(v):[];return rows.flatMap(([key,row],index)=>{if(!row||typeof row!=='object')return[];const parsed=String(key).match(/\d+/),number=Number(row.number??row.round??parsed?.[0]??index+1);if(!Number.isFinite(number)||number<=0)return[];return[{number,team:String(row.team||''),side:String(row.side||''),type:String(row.type||'')}];}).sort((a,b)=>a.number-b.number);};

const catalogTeams=m=>Array.isArray(m?.teams)&&m.teams.length>=2?m.teams:[{name:m?.team1||m?.homeTeam||m?.home?.name||''},{name:m?.team2||m?.awayTeam||m?.away?.name||''}];
const gameText=m=>clean([m?.game,m?.sport,m?.category,m?.discipline,m?.gameName].filter(Boolean).join(' '));
const catalogLeague=m=>String(m?.event||m?.league||m?.tournament||m?.competition||'');
const catalogStart=m=>{const raw=m?.startAt??m?.startTime??m?.scheduledAt??m?.scheduled??m?.date??m?.time??m?.start;const n=Number(raw);if(Number.isFinite(n)&&n>100000000000)return n;if(Number.isFinite(n)&&n>1000000000)return n*1000;const parsed=Date.parse(String(raw||''));return Number.isFinite(parsed)?parsed:0;};
export const isCrossbetCs2=m=>/^(csgo|cs2)$/.test(gameText(m).replace(/\s/g,''))||/counter strike|cs go|cs 2/.test(gameText(m));
export function crossbetCatalogRows(payload){
 const arrays=[];if(Array.isArray(payload))arrays.push(payload);for(const value of [payload?.live,payload?.matches,payload?.events,payload?.data?.live,payload?.data?.matches,payload?.data?.events])if(Array.isArray(value))arrays.push(value);
 const seen=new Map();for(const row of arrays.flat()){if(!row||typeof row!=='object')continue;const id=String(row.matchId||row.id||row.match_id||'');const teams=catalogTeams(row);if(!/^\d{8,13}$/.test(id)||!teams[0]?.name||!teams[1]?.name||!isCrossbetCs2(row))continue;seen.set(id,{...row,matchId:id,teams});}
 return [...seen.values()];
}
const mapNumber=d=>Math.max(1,Number(d?.mapNum)||1);
const mapKey=d=>String(mapNumber(d));
const teamIndex=(d,row,index)=>{const teams=catalogTeams(d),n=clean(row?.name),exact=teams.findIndex(t=>n&&clean(t?.name)===n);if(exact>=0)return exact;const explicit=Number(row?._teamIndex);if(Number.isInteger(explicit)&&explicit>=0&&explicit<2)return explicit;const k=clean(row?._slot);if(/^(?:home|team1)$/.test(k))return 0;if(/^(?:away|team2)$/.test(k))return 1;return index<2?index:-1;};
const orderedPlayers=(d,board)=>{const out=[null,null],extras=[];teamRows(board?.teamStats).forEach((t,index)=>{const i=teamIndex(d,t,index),row={name:t.name||catalogTeams(d)[i]?.name||'',side:t.side||'',weaponsCost:t.weaponsCost??null,members:objects(t.members).map(m=>({name:m.name||'',k:m.k,a:m.a,d:m.d,alive:typeof m.alive==='boolean'?m.alive:null}))};if(i>=0&&i<2&&!out[i])out[i]=row;else extras.push(row);});for(let i=0;i<2;i++)if(!out[i]&&extras.length)out[i]=extras.shift();return out.filter(Boolean);};
export {orderedPlayers as crossbetOrderedPlayers};
const usefulCollection=v=>Array.isArray(v)?v.length>0:!!(v&&typeof v==='object'&&Object.keys(v).length);
const hasOwn=(o,k)=>!!o&&Object.prototype.hasOwnProperty.call(o,k)&&o[k]!==undefined&&o[k]!==null;
const nonBlank=(o,k)=>hasOwn(o,k)&&String(o[k]).trim()!=='';
function mergePlayerMembers(prev,next){
 const a=objects(prev),b=objects(next);if(!b.length)return prev;
 const used=new Set(),out=b.map((row,index)=>{
  const name=clean(row?.name),byName=name?a.findIndex((old,i)=>!used.has(i)&&clean(old?.name)===name):-1,slot=byName>=0?byName:(!used.has(index)&&a[index]?index:-1),old=slot>=0?a[slot]:{};if(slot>=0)used.add(slot);
  const merged={...old,...row};
  if(!nonBlank(row,'name')&&nonBlank(old,'name'))merged.name=old.name;
  for(const key of ['k','a','d','alive'])if(!hasOwn(row,key)&&hasOwn(old,key))merged[key]=old[key];
  return merged;
 });
 // Partial scoreboardUpdate packets can omit players entirely. Keep any roster
 // rows that were present in the last full frame instead of making them vanish.
 for(let i=0;i<a.length;i++)if(!used.has(i))out.push(a[i]);
 return out;
}
function mergeTeamStats(prev,next){
 const a=teamRows(prev),b=teamRows(next);if(!b.length)return prev;
 const used=new Set(),out=[null,null],extras=[];
 const slotIndex=(row,index)=>{const explicit=Number(row?._teamIndex);if(Number.isInteger(explicit)&&explicit>=0&&explicit<2)return explicit;const k=clean(row?._slot);if(/^(?:home|team1)$/.test(k))return 0;if(/^(?:away|team2)$/.test(k))return 1;const name=clean(row?.name);if(name){const i=a.findIndex((old,j)=>!used.has(j)&&clean(old?.name)===name);if(i>=0)return i;}return index<2?index:-1;};
 b.forEach((row,index)=>{const slot=slotIndex(row,index),old=slot>=0&&a[slot]?a[slot]:{},merged={...old,...row};
  if(!nonBlank(row,'name')&&nonBlank(old,'name'))merged.name=old.name;if(!nonBlank(row,'side')&&nonBlank(old,'side'))merged.side=old.side;if(!hasOwn(row,'weaponsCost')&&hasOwn(old,'weaponsCost'))merged.weaponsCost=old.weaponsCost;
  merged.members=mergePlayerMembers(old.members,row?.members);delete merged._slot;if(slot>=0&&slot<2&&!out[slot]){out[slot]=merged;used.add(slot);}else extras.push(merged);
 });
 for(let i=0;i<2;i++)if(!out[i]&&a[i]){const row={...a[i]};delete row._slot;out[i]=row;used.add(i);}
 for(const row of extras)if(out.includes(null))out[out.indexOf(null)]=row;else out.push(row);
 return out.filter(Boolean);
}
function mergeScoreboard(prev,next){
 const a=prev&&typeof prev==='object'?prev:{},b=next&&typeof next==='object'?next:{},out={...a,...b};
 // Cross.bet emits both full and compact scoreboard frames. A compact frame may
 // contain teamStats but omit player names/KAD/alive fields, so a shallow replace
 // destroys the roster. Deep-merge roster identity and only replace fields that
 // are actually present in the packet.
 if(usefulCollection(a.teamStats)||usefulCollection(b.teamStats))out.teamStats=mergeTeamStats(a.teamStats,b.teamStats);
 if(!usefulCollection(b.timeline)&&usefulCollection(a.timeline))out.timeline=a.timeline;
 return out;
}
function ensureHistory(d){d.roundHistory||={};d.eventHistory||={};d.liveState||={};}
function mergeRounds(d,at=Date.now()){ensureHistory(d);const key=mapKey(d),current=new Map((d.roundHistory[key]||[]).map(r=>[Number(r.number),r]));for(const row of roundRows(d.scoreboard?.timeline)){const old=current.get(row.number)||{};current.set(row.number,{...old,...row,observedAt:old.observedAt||at});}d.roundHistory[key]=[...current.values()].sort((a,b)=>a.number-b.number).slice(-120);return d.roundHistory[key];}
function addEvent(d,key,event){ensureHistory(d);const list=d.eventHistory[key]||(d.eventHistory[key]=[]),signature=[event.type,event.round,event.player,event.killer,event.team,event.side,event.clock,event.method].join('|');if(list.some(x=>x.signature===signature&&Math.abs(Number(x.at||0)-Number(event.at||0))<1500))return;list.push({...event,signature});if(list.length>600)list.splice(0,list.length-600);}
function captureState(d,packetName='',at=Date.now()){
 ensureHistory(d);const board=d.scoreboard&&typeof d.scoreboard==='object'?d.scoreboard:{},key=mapKey(d),rounds=mergeRounds(d,at),state=d.liveState[key]||(d.liveState[key]={round:null,bomb:'',players:{},sides:{},seenRounds:{}}),round=Number(board.currentRound)||null,clock=String(board.roundTime||'');
 const players=orderedPlayers(d,board),currentPlayers={},killers=[];
 for(let ti=0;ti<players.length;ti++){const team=players[ti],side=String(team.side||'').toLowerCase(),priorSide=state.sides[ti];if(priorSide&&side&&priorSide!==side)addEvent(d,key,{type:'side_switch',round,team:String(ti+1),side,clock,at});if(side)state.sides[ti]=side;for(const p of team.members||[]){const id=ti+'|'+clean(p.name),prev=state.players[id],now={team:String(ti+1),side,name:p.name,alive:p.alive,k:Number(p.k),a:Number(p.a),d:Number(p.d)};currentPlayers[id]=now;if(prev&&Number.isFinite(now.k)&&Number.isFinite(prev.k)&&now.k>prev.k)killers.push({...now,delta:now.k-prev.k});}}
 const deaths=[];for(const [id,now] of Object.entries(currentPlayers)){const prev=state.players[id];if(prev?.alive===true&&now.alive===false)deaths.push(now);}for(let i=0;i<deaths.length;i++){const victim=deaths[i],killer=killers.length===1?killers[0]:killers[i]||null;addEvent(d,key,{type:'death',round,player:victim.name,team:victim.team,side:victim.side,killer:killer?.name||'',killerTeam:killer?.team||'',clock,at});}
 if(state.round!=null&&round!=null&&state.round!==round)addEvent(d,key,{type:'round_start',round,clock,at});if(round!=null)state.round=round;
 const bomb=String(board.bomb||'').toLowerCase();if(bomb&&bomb!==state.bomb&&['planted','defusing'].includes(bomb))addEvent(d,key,{type:bomb==='planted'?'bomb_planted':'bomb_defusing',round,clock,at});state.bomb=bomb;
 for(const r of rounds){if(state.seenRounds[r.number])continue;if(Object.keys(state.seenRounds).length)addEvent(d,key,{type:'round_end',round:r.number,team:r.team,side:r.side,method:r.type,clock:'',at:r.observedAt||at});state.seenRounds[r.number]=true;}
 if(Object.keys(currentPlayers).length)state.players=currentPlayers;state.packet=packetName;state.at=at;
}
const view=(d,connected)=>{const board=d.scoreboard&&typeof d.scoreboard==='object'?d.scoreboard:{},key=mapKey(d),players=orderedPlayers(d,board),timeline=(d.roundHistory?.[key]?.length?d.roundHistory[key]:roundRows(board.timeline));return {matched:true,provider:'Статистика',id:d.matchId,league:d.event,team1:d.teams?.[0]?.name,team2:d.teams?.[1]?.name,team1Logo:validLogo(d.teams?.[0]?.logo),team2Logo:validLogo(d.teams?.[1]?.logo),url:'',updatedAt:d.updatedAt||Date.now(),connected:connected===true,
  streamLinks:[...new Map(objects(d.streams).map(s=>({name:s.name||'Трансляция',url:validLink(s.url)})).filter(s=>s.url).map(s=>[s.url,s])).values()],
  map:d.map,mapNum:mapNumber(d),mapScore:[d.mapScore_home,d.mapScore_away],roundScore:[d.roundScore_home,d.roundScore_away],
  currentRound:board.currentRound??null,roundTime:board.roundTime??null,clockAt:d.clockAt||d.updatedAt,clockAdvancing:d.clockAdvancing===true,serverNow:Date.now(),timerRunning:board.timerRunning??null,bomb:board.bomb??null,sideSwapped:board.swap??null,
  timeline:timeline.slice(-120),eventLog:(d.eventHistory?.[key]||[]).map(({signature,...event})=>event),players};};
// Scoreboard packets contain no match ID. Each tracked fixture therefore has
// its own socket, shared by all viewers. Mixing rooms would mix unrelated games.
export class CrossbetService {
 constructor(){this.list=[];this.listAt=0;this.catalogAt=0;this.rawCatalogMatches=0;this.catalogPackets=0;this.packetErrors=0;this.lastPacketError='';this.lastPacketErrorAt=0;this.details=new Map();this.channels=new Map();this.pending=new Map();this.onUpdate=()=>{};this.catalog=null;this.retryAt=0;this.lastError='';this.timer=setInterval(()=>this.tick(),2000);this.timer.unref?.();}
 status(){return {connected:this.catalog?.ready===true,catalogMatches:this.list.length,rawCatalogMatches:this.rawCatalogMatches,catalogPackets:this.catalogPackets,lastCatalogAt:this.catalogAt||null,trackedMatches:this.channels.size,packetErrors:this.packetErrors,lastPacketError:this.lastPacketError,lastPacketErrorAt:this.lastPacketErrorAt||null,lastError:this.lastError};}
 openSocket(id=''){
  const c={id,ws:null,ready:false,lastPacket:Date.now(),retryAt:0};
  try{const ws=c.ws=new WebSocket('wss://cross.bet/socket.io/?EIO=3&transport=websocket');
   ws.addEventListener('message',ev=>{let packetName='';try{if(c.ws!==ws)return;const raw=String(ev.data||'');if(raw.length>2500000)return;c.lastPacket=Date.now();
    if(raw==='2'){ws.send('3');return;}if(raw.startsWith('0')){ws.send('40');return;}
    if(raw==='40'){c.ready=true;this.send(c,'room',id||'main');if(id){this.send(c,'room',id+'_scoreboard');this.send(c,'getMatch',id);}else this.send(c,'getMatches');return;}
    if(!raw.startsWith('42'))return;let name,payload;try{[name,payload]=JSON.parse(raw.slice(2));}catch{return;}packetName=String(name||'');
    if(!id&&['setMatches','updateMatches','matches'].includes(name)){const arrays=[payload?.live,payload?.matches,payload?.events,payload?.data?.live,payload?.data?.matches,payload?.data?.events].filter(Array.isArray),rows=crossbetCatalogRows(payload);this.rawCatalogMatches=Array.isArray(payload)?payload.length:arrays.reduce((n,a)=>n+a.length,0);if(name==='updateMatches'&&this.list.length){const map=new Map(this.list.map(row=>[String(row.matchId),row]));for(const row of rows)map.set(String(row.matchId),row);for(const gone of values(payload?.removed||payload?.closed))map.delete(String(gone?.matchId||gone?.id||gone));this.list=[...map.values()];}else this.list=rows;this.listAt=this.catalogAt=Date.now();this.catalogPackets++;this.lastError='';return;}
    if(!id||payload?.matchId&&String(payload.matchId)!==id)return;
    const d=this.details.get(id);if(!d||!payload&&name!=='matchClose')return;
    if(payload?.mapNum&&d.mapNum&&Number(payload.mapNum)!==Number(d.mapNum)){const oldMap=mapNumber(d);captureState(d,'map-transition',Date.now());d.savedMaps={...d.savedMaps,[oldMap]:view(d,c.ready)};d.scoreboard={};}
    const seconds=s=>{const m=String(s||'').match(/^(\d+):(\d{1,2})$/);return m?Number(m[1])*60+Number(m[2]):null;};const before=seconds(d.scoreboard?.roundTime);
    if(name==='matchInfo'){const prior=d.scoreboard;Object.assign(d,payload);if(payload?.scoreboard)d.scoreboard=mergeScoreboard(prior,payload.scoreboard);}
    else if(name==='setScoreboard')d.scoreboard=mergeScoreboard(d.scoreboard,payload);
    else if(name==='scoreboardUpdate')d.scoreboard=mergeScoreboard(d.scoreboard,payload);
    else if(name==='scoreUpdate')Object.assign(d,payload);
    else if(name==='mapScore')Object.assign(d,payload);
    else if(name==='utilsUpdate'&&payload.type==='map')d.map=payload.map;
    else if(name==='matchClose'){d.finished=true;this.list=this.list.filter(m=>String(m.matchId)!==id);}
    else return;
    if(name==='setScoreboard'||name==='matchInfo'&&payload.scoreboard||name==='scoreboardUpdate'&&['roundTime','timerRunning','bomb','currentRound'].some(k=>k in payload)){const after=seconds(d.scoreboard?.roundTime);d.clockAdvancing=before!=null&&after!=null&&after<before&&before-after<=5;d.clockAt=Date.now();}
    d.updatedAt=Date.now();captureState(d,name,d.updatedAt);this.onUpdate(id,this.output(id));
    }catch(error){this.packetErrors++;this.lastPacketError=`${packetName||'unknown'}: ${error?.message||String(error)}`;this.lastPacketErrorAt=Date.now();this.lastError=`Статистика packet ${this.lastPacketError}`;}
   });
   const disconnected=()=>{if(c.ws!==ws)return;c.ws=null;c.ready=false;c.retryAt=Date.now()+5000;};
   ws.addEventListener('close',disconnected);ws.addEventListener('error',()=>{if(c.ws!==ws)return;this.lastError='Статистика: соединение прервано';disconnected();try{ws.close();}catch{}});
  }catch(error){this.lastError=error.message;c.retryAt=Date.now()+15000;}
  return c;
 }
 send(c,name,value){if(c?.ws?.readyState===1)c.ws.send('42'+JSON.stringify(value===undefined?[name]:[name,value]));}
 connect(){if(!this.catalog&&Date.now()>=this.retryAt)this.catalog=this.openSocket();}
 tick(){const now=Date.now();for(const [id,d] of this.details)if(now-(d.touch||0)>6*3600000&&!this.channels.has(id))this.details.delete(id);this.connect();if(this.catalog&&!this.catalog.ws&&now>=this.catalog.retryAt)this.catalog=this.openSocket();
  if(this.catalog?.ready&&now-this.listAt>(this.list.length?30000:10000)){this.listAt=now;this.send(this.catalog,'getMatches');}
  for(const [id,c] of this.channels){const d=this.details.get(id);if(!d||now-(d.touch||0)>150000||d.finished){c.ws?.close();this.channels.delete(id);continue;}if(!c.ws&&now>=c.retryAt)this.channels.set(id,this.openSocket(id));}
  for(const c of [this.catalog,...this.channels.values()])if(c?.ws&&now-c.lastPacket>90000){c.ws.close();c.ws=null;c.ready=false;c.retryAt=now+5000;}
 }
 async firstList(){this.connect();if(this.list.length)return;for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,250));if(this.list.length)break;}}
 output(id){const d=this.details.get(id);if(!d)return null;return {...view(d,this.channels.get(id)?.ready===true),finished:d.finished===true,maps:Object.values({...d.savedMaps,[d.mapNum||1]:view(d,this.channels.get(id)?.ready===true)}).sort((a,b)=>a.mapNum-b.mapNum)};}
 async get({team1,team2,startAt,league,category}={}){
  await this.firstList();const a=String(team1||''),b=String(team2||'');if(!a||!b)return {matched:false};
  // Same LIVE rule as Dota statistics: scheduled time is not an identity
  // signal. Both teams and the league must independently be >=50% similar.
  const ranked=this.list.flatMap(m=>{
    const teams=catalogTeams(m),info=liveStatisticsMatchScore(a,b,teams[0]?.name||'',teams[1]?.name||'',league||'',catalogLeague(m),category||'Counter Strike 2');
    return info?[{m,...info}]:[];
  }).sort((x,y)=>Number(y.exactPair)-Number(x.exactPair)||y.score-x.score||y.teamMin-x.teamMin||y.leagueScore-x.leagueScore);
  if(!ranked.length)return {matched:false,error:'Точное совпадение статистического матча не найдено'};
  if(ranked.length>1&&ranked[0].score-ranked[1].score<.04&&ranked[0].exactPair===ranked[1].exactPair)return {matched:false,error:'Неоднозначное совпадение статистического матча'};
  const m=ranked[0].m,id=String(m.matchId);if(!/^\d{8,13}$/.test(id))return {matched:false};
  if(!this.details.has(id)){
   const teams=catalogTeams(m),now=Date.now(),detail={...m,matchId:id,teams,event:m.event||m.league||m.tournament||'',scoreboard:m.scoreboard||{},savedMaps:{},roundHistory:{},eventHistory:{},liveState:{},updatedAt:now,clockAt:now};captureState(detail,'catalog',now);this.details.set(id,detail);
  }
  const d=this.details.get(id);d.touch=Date.now();
  // Open the live room first. The public HTML page is optional enrichment:
  // Cloudflare can block server-side HTML while Socket.IO remains available.
  if(!this.channels.has(id)&&this.channels.size<24)this.channels.set(id,this.openSocket(id));
  if(!d.pageAttempted&&!this.pending.has(id)){d.pageAttempted=true;this.pending.set(id,(async()=>{try{const r=await fetch(`https://www.cross.bet/match/${id}`,{headers:{accept:'text/html','user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(6000)});if(!r.ok)throw Error('HTTP '+r.status);const html=await responseTextLimited(r,2500000);const json=html.match(/\b(?:var|let|const)\s+match\s*=\s*(\{[\s\S]*?\});(?:\s|<|$)/);if(!json)throw Error('Табло отсутствует');const page=JSON.parse(json[1]);if(String(page.matchId)!==id)throw Error('ID не совпадает');const oldMap=mapNumber(d);if(page.mapNum&&Number(page.mapNum)!==oldMap){captureState(d,'page-map-transition',Date.now());d.savedMaps={...d.savedMaps,[oldMap]:view(d,this.channels.get(id)?.ready===true)};}const now=Date.now();Object.assign(d,page,{updatedAt:now,clockAt:now});captureState(d,'page',now);this.lastError='';}catch(error){this.lastError='Статистика page: '+error.message;}})().finally(()=>this.pending.delete(id)));}
  // Give both transports a short chance to enrich the first frame. A blocked
  // HTML page is swallowed above and never turns a valid socket match into an error.
  await Promise.race([this.pending.get(id)||Promise.resolve(),new Promise(r=>setTimeout(r,500))]);
  for(let i=0;i<4&&!this.channels.get(id)?.ready;i++)await new Promise(r=>setTimeout(r,100));
  const value=this.output(id);this.onUpdate(id,value);return value;
 }
 stop(){clearInterval(this.timer);this.catalog?.ws?.close();for(const c of this.channels.values())c.ws?.close();this.channels.clear();}
}
