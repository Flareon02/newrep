import {readFile} from 'node:fs/promises';
import {readJson,writeJson} from './utils.js';
import HltvData from './hltv-data.cjs';
const HOUR=3600000,DAY=24*HOUR;
import {safePlayerDetails} from './hltv-player-schema.js';
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0&&Number(v)<1e10?Number(v):0;
const num=(v,a,b)=>v!=null&&Number.isFinite(Number(v))&&Number(v)>=a&&Number(v)<=b?Number(v):null;
const name=v=>String(v||'').replace(/[\u0000-\u001f]/g,'').slice(0,120);
export function safeDataset(data={},now=Date.now()){
 const at=v=>num(v,946684800000,now+300000),player=p=>({...safePlayerDetails(p,now),id:positive(p.id),name:name(p.name),slug:HltvData.slug(p.slug||p.name),at:at(p.at),rating:num(p.rating,0,3),ratingVersion:['3.0','older'].includes(p.ratingVersion)?p.ratingVersion:undefined,ratingPeriod:name(p.ratingPeriod),ratingMaps:num(p.ratingMaps,0,10000),maps:num(p.maps,0,10000),rounds:num(p.rounds,0,1e7),kpr:num(p.kpr,0,2),dpr:num(p.dpr,0,2),headshots:num(p.headshots,0,1),adr:num(p.adr,0,300),statsPeriod:['all time','date range'].includes(p.statsPeriod)?p.statsPeriod:undefined,startDate:/^\d{4}-\d\d-\d\d$/.test(p.startDate)?p.startDate:null,endDate:/^\d{4}-\d\d-\d\d$/.test(p.endDate)?p.endDate:null,url:'https://www.hltv.org/'+(p.kpr?'stats/players/':'player/')+positive(p.id)+'/'+HltvData.slug(p.slug||p.name)});
 const players=(data.players||[]).slice(0,3000).map(player).filter(p=>p.id&&p.name),teams=(data.teams||[]).slice(0,1200).map(t=>({id:positive(t.id),name:name(t.name),slug:HltvData.slug(t.slug||t.name),at:at(t.at),rank:num(t.rank,1,1000),url:'https://www.hltv.org/team/'+positive(t.id)+'/'+HltvData.slug(t.slug||t.name),players:(t.players||[]).slice(0,5).map(player).filter(p=>p.id),maps:(t.maps||[]).slice(0,20).map(m=>({name:name(m.name),at:at(m.at),wins:num(m.wins,0,5000)||0,losses:num(m.losses,0,5000)||0,draws:num(m.draws,0,5000)||0,played:(num(m.wins,0,5000)||0)+(num(m.losses,0,5000)||0)+(num(m.draws,0,5000)||0),pistol:num(m.pistol,0,1),pick:num(m.pick,0,1),ban:num(m.ban,0,1),startDate:name(m.startDate),endDate:name(m.endDate)})).filter(m=>m.name)})).filter(t=>t.id&&t.name);
 const matches=(data.matches||[]).slice(0,5000).map(m=>({id:positive(m.id),at:at(m.at),teamA:positive(m.teamA),teamB:positive(m.teamB),scoreA:num(m.scoreA,0,3),scoreB:num(m.scoreB,0,3),nameA:name(m.nameA),nameB:name(m.nameB)})).filter(m=>m.id&&m.at&&m.at<=now&&m.teamA&&m.teamB&&m.teamA!==m.teamB&&m.scoreA!==null&&m.scoreB!==null&&m.scoreA!==m.scoreB);
 return {teams,players,matches};
}
export class HltvService{
 constructor({request=fetch,read=readJson,write=writeJson,seedPath=new URL('./hltv-seed.json',import.meta.url),gap=2000}={}){this.request=request;this.read=read;this.write=write;this.seedPath=seedPath;this.gap=gap;this.data={teams:[],players:[],matches:[]};this.pending=new Map();this.lastError='';this.blockedUntil=0;this.requests=0;this.queue=Promise.resolve();this.next=0;this.searchCache=new Map();this.ready=this.load();}
 async load(){const [seed,saved]=await Promise.all([readFile(this.seedPath,'utf8').then(JSON.parse).catch(()=>({})),this.read('hltv/cache.json',{})]);this.data=HltvData.merge(safeDataset(seed),safeDataset(saved));}
 status(){return {teams:this.data.teams.filter(t=>t.at).length,players:this.data.players.filter(p=>p.rating||p.kpr).length,matches:this.data.matches.length,lastError:this.lastError,blockedUntil:this.blockedUntil,requests:this.requests,pending:this.pending.size};}
 async fetchPage(path){
  if(this.pending.has(path))return this.pending.get(path);
  const run=this.queue.catch(()=>{}).then(async()=>{
   if(Date.now()<this.blockedUntil)throw Error(this.lastError||'HLTV временно недоступен. Используйте импорт HAR.');
   if(this.next>Date.now())await new Promise(r=>setTimeout(r,this.next-Date.now()));this.next=Date.now()+this.gap;this.requests++;
   const response=await this.request('https://www.hltv.org'+path,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{Accept:path.startsWith('/search?')?'application/json':'text/html','User-Agent':'EsportsMonitor/3.1 (personal statistics viewer)'}});
   if(!response.ok){if([403,429,503].includes(response.status))this.blockedUntil=Date.now()+Math.max(30*60000,Number(response.headers.get('retry-after')||0)*1000);throw Error('HLTV: HTTP '+response.status+'. Можно импортировать HAR со страниц команд и игроков.');}
   const reader=response.body.getReader();let bytes=0,chunks=[];for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>10*1024*1024){await reader.cancel();throw Error('Страница HLTV слишком большая');}chunks.push(Buffer.from(value));}
   const body=Buffer.concat(chunks).toString('utf8');if(/Just a moment|Checking your browser|cf-chl-widget/i.test(body.slice(0,12000))){this.blockedUntil=Date.now()+30*60000;throw Error('HLTV требует проверку браузера. Используйте импорт HAR.');}
   const parsed=safeDataset(HltvData.parsePage('https://www.hltv.org'+path,body));this.data=HltvData.merge(this.data,parsed);this.lastError='';await this.write('hltv/cache.json',this.data);return parsed;
  }).catch(error=>{this.lastError=error.message;if(this.blockedUntil<Date.now())this.blockedUntil=Date.now()+60000;throw error;}).finally(()=>this.pending.delete(path));
  this.pending.set(path,run);this.queue=run;return run;
 }
 async search(q){await this.ready;q=name(q);if(q.length<2)return {teams:[],players:[],status:this.status()};const key=HltvData.norm(q),cached=this.searchCache.get(key);if(!cached||Date.now()-cached>HOUR){try{await this.fetchPage('/search?term='+encodeURIComponent(q));}catch{}this.searchCache.set(key,Date.now());while(this.searchCache.size>500)this.searchCache.delete(this.searchCache.keys().next().value);}
  return {teams:this.data.teams.filter(t=>HltvData.norm(t.name).includes(key)).slice(0,30),players:this.data.players.filter(p=>HltvData.norm(p.name).includes(key)).slice(0,30),status:this.status()};
 }
 async team(id,refresh=false){await this.ready;id=positive(id);if(!id)throw Error('Неверный ID команды');let value=this.data.teams.find(t=>t.id===id);if(!value?.at||refresh){try{await this.fetchPage('/team/'+id+'/'+HltvData.slug(value?.slug||value?.name));}catch(error){if(!value?.at)throw error;}value=this.data.teams.find(t=>t.id===id);}
  if(!value)throw Error('Команда не найдена в доступных данных HLTV');return value;
 }
 async player(id,refresh=false){await this.ready;id=positive(id);if(!id)throw Error('Неверный ID игрока');let p=this.data.players.find(x=>x.id===id);if(!p?.kpr||refresh){const end=new Date().toISOString().slice(0,10),start=new Date(Date.now()-90*DAY).toISOString().slice(0,10);try{await this.fetchPage('/stats/players/'+id+'/'+HltvData.slug(p?.slug||p?.name)+'?startDate='+start+'&endDate='+end);}catch(error){if(!p?.rating)throw error;}p=this.data.players.find(x=>x.id===id);}
  if(!p)throw Error('Игрок не найден в доступных данных HLTV');return p;
 }
 async prepare(body){
  await this.ready;const input=body.teams;if(!Array.isArray(input)||input.length!==2)throw Error('Выберите две команды');
  const local=safeDataset(body.data||{});if(local.teams.length||local.players.length||local.matches.length){this.data=HltvData.merge(this.data,local);await this.write('hltv/cache.json',this.data);}
  let data=HltvData.merge(this.data,local);const selected=[];
  for(let side=0;side<2;side++){
   const pick=input[side];let t;
   if(pick.custom){if(!Array.isArray(pick.playerIds)||pick.playerIds.length!==5)throw Error('Для своего состава выберите пять игроков');t={id:-(side+1),name:name(pick.name)||'Состав '+(side+1),players:[],maps:[],at:Date.now(),custom:true};}
   else{const id=positive(pick.id);t=data.teams.find(x=>x.id===id&&x.at);if(!t||((Date.now()-t.at>6*HOUR)&&Date.now()>=this.blockedUntil)){await this.team(id,!!t);data=HltvData.merge(this.data,local);t=data.teams.find(x=>x.id===id&&x.at);}if(!t)throw Error('Нужен профиль команды HLTV');t={...t};}
   const ids=pick.playerIds||t.players.map(p=>p.id);if(ids.length!==5||new Set(ids.map(Number)).size!==5)throw Error('В составе должны быть пять разных игроков HLTV');
   const ps=[];for(const id of ids){let p=data.players.find(p=>p.id===Number(id));if(p)p=HltvData.derivePlayer(p);if((!p?.kpr||!(p.rounds>100)||p.statsPeriod==='all time'||Date.now()-(p.statsAt||p.at)>6*HOUR)&&Date.now()>=this.blockedUntil){try{await this.player(id,!!p?.kpr);data=HltvData.merge(this.data,local);p=data.players.find(p=>p.id===Number(id));}catch{}}if(!p)throw Error('Нет данных игрока HLTV '+id);ps.push(HltvData.derivePlayer(p,Date.now()));}
   t.rosterOverlap=t.custom?0:ids.filter(id=>t.players.some(p=>p.id===Number(id))).length/5;t.players=ps;
   if(t.custom){const contributing=data.teams.filter(x=>x.maps?.length&&x.players?.some(p=>ids.includes(p.id)));const maps=new Map();for(const old of contributing)for(const m of old.maps){const fraction=old.players.filter(p=>ids.includes(p.id)).length/5,prev=maps.get(m.name)||{...m,wins:0,losses:0,draws:0,played:0};prev.wins+=m.wins*fraction;prev.losses+=m.losses*fraction;prev.draws+=(m.draws||0)*fraction;prev.played=prev.wins+prev.losses+prev.draws;maps.set(m.name,prev);}t.maps=[...maps.values()];}
   selected.push(t);
  }
  return {data,options:{teams:selected,bestOf:body.bestOf,margin:body.margin,maxOdds:body.maxOdds,roundVolatility:body.roundVolatility,maps:body.maps,sourceError:this.lastError,now:Date.now()}};
 }
}
