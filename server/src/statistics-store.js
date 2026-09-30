import { log } from "./logger.js";
import {EventEmitter} from 'node:events';
import {readJson,writeJson} from './utils.js';
import {teamLogos} from './team-logos.js';
const norm=s=>String(s||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const leagueNorm=s=>String(s||'').normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/\b(dota\s*2|counter[ -]?strike\s*2|cs\s*2|esports?)\b/gi,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
export const referenceKeys=e=>(e.sourceRefs||[e]).flatMap(r=>[r.source+':'+(r.sourceEventId||r.id),...(r.aliases||[])]).filter(k=>/^(astek|fonbet|pinnacle|ggbet):[\w-]{1,100}$/.test(k));
const pair=e=>[norm(e.team1),norm(e.team2)].sort().join('|');
export class StatisticsStore extends EventEmitter{
 publicProvider(provider){return provider==='hawk'?'dota2':provider==='crossbet'?'cs2':provider;}
 publicId(id=''){const value=String(id);if(value.startsWith('hawk-'))return 'stats-dota2-'+value.slice(5);if(value.startsWith('crossbet-'))return 'stats-cs2-'+value.slice(9);return value;}
 internalId(id=''){const value=String(id);if(value.startsWith('stats-dota2-'))return 'hawk-'+value.slice(12);if(value.startsWith('stats-cs2-'))return 'crossbet-'+value.slice(10);return value;}
 channel(id=''){return this.internalId(id);}
 constructor(){super();this.index={};this.cache=new Map();this.dirty=new Set();this.ready=readJson('statistics/index.json',{}).then(index=>{this.index=index;});this.writing=null;this.timer=setInterval(()=>this.flush().catch(e=>log.error('[statistics]',e.message)),5000);this.timer.unref?.();}
 // Payloads are durable on disk (statistics/<id>.json); only a small working set stays in RAM. Unsaved rows are never evicted.
 trimCache(limit=50,keep=''){for(const id of this.cache.keys()){if(this.cache.size<=limit)break;if(id!==keep&&!this.dirty.has(id))this.cache.delete(id);}}
 async record(provider,e,payload){await this.ready;if(!payload?.matched)return;const d=provider==='hawk'?payload.event:payload;if(!d?.id)return;const id=provider+'-'+String(d.id).replace(/[^\w-]/g,''),old=this.index[id],category=provider==='hawk'?'Dota 2':'Counter Strike 2';
  const decorated=teamLogos.decorate({...d,category});delete decorated.url;if(provider==='crossbet'&&decorated.maps)decorated.maps=decorated.maps.map(m=>teamLogos.decorate({...m,category}));payload=provider==='hawk'?{...payload,event:decorated}:{...payload,...decorated,provider:'Статистика'};
  const refs=[...new Set([...(old?.refs||[]),...referenceKeys(e||{})])];this.index[id]={id,provider,refs,pair:pair(e||d),team1:e?.team1||d.team1,team2:e?.team2||d.team2,leagueKey:String(e?.leagueKey||old?.leagueKey||''),league:leagueNorm(e?.league||old?.league||d.league||''),startAt:Number(e?.startAt||old?.startAt||d.startAt)||Date.now(),at:Date.now()};
  this.cache.set(id,payload);this.dirty.add(id);this.trimCache(50,id);this.emit(id,{...payload,archiveId:this.publicId(id)});return this.publicId(id);
 }
 async lookup(e){await this.ready;const refs=referenceKeys(e),entries=Object.values(this.index),direct=entries.filter(r=>r.refs.some(k=>refs.includes(k)));if(direct.length===1)return direct[0];if(direct.length>1)return direct.sort((a,b)=>b.at-a.at)[0];
  if(!e.startAt)return null;const wantedLeague=leagueNorm(e.league),wantedKey=String(e.leagueKey||''),candidates=entries.filter(r=>{if(r.pair!==pair(e)||Math.abs(r.startAt-Number(e.startAt))>20*60000)return false;const sameKey=wantedKey&&r.leagueKey&&wantedKey===r.leagueKey,sameLeague=wantedLeague&&r.league&&wantedLeague===r.league;return sameKey||sameLeague||(!r.league&&!r.leagueKey&&Math.abs(r.startAt-Number(e.startAt))<=5*60000);});return candidates.length===1?candidates[0]:null;
 }
 async get(id){await this.ready;const internal=this.internalId(id);if(!/^(crossbet|hawk)-[\w-]{1,80}$/.test(internal)||!this.index[internal])return null;if(!this.cache.has(internal)){const data=await readJson('statistics/'+internal+'.json',null);if(data){this.cache.set(internal,data);this.trimCache(50,internal);}}const data=this.cache.get(internal);if(!data)return null;const safe={...data};if('provider' in safe)safe.provider='Статистика';if('url' in safe)safe.url='';if(safe.event&&typeof safe.event==='object')safe.event={...safe.event,url:''};return {...safe,archiveId:this.publicId(internal),serverNow:Date.now(),archived:Date.now()-this.index[internal].at>150000};}
 async flush(){await this.ready;if(this.writing)return this.writing;const ids=[...this.dirty];if(!ids.length)return;this.dirty.clear();const snapshots=ids.map(id=>[id,this.cache.get(id)]),index={...this.index};this.writing=(async()=>{try{for(const [id,value] of snapshots)await writeJson('statistics/'+id+'.json',value);await writeJson('statistics/index.json',index);}catch(error){ids.forEach(id=>this.dirty.add(id));throw error;}finally{this.writing=null;this.trimCache();}})();return this.writing;}
 async stop(){clearInterval(this.timer);await this.flush();await this.flush();}
}
