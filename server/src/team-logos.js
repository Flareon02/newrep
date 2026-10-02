import { log } from "./logger.js";
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readJson,writeJson} from './utils.js';
import {config} from './config.js';
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export class TeamLogos{
 constructor(){this.index={};this.queue=[];this.pending=new Set();this.running=0;this.ready=readJson('teams/logos.json',{}).then(d=>{this.index=d;});this.writes=Promise.resolve();}
 key(category,name){return createHash('sha256').update(norm(category)+'|'+norm(name)).digest('hex').slice(0,32);}
 allowed(raw){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&((u.hostname==='v2l.traincdn.com'&&/^\/sfiles\/logo_teams\/[a-f\d]{32}\.(png|webp|jpe?g)$/i.test(u.pathname))||(u.hostname==='cdn.cross.bet'&&u.pathname.startsWith('/csgo/logo/team/'))||u.hostname==='hawk.live'||(u.hostname==='cdn.gin.bet'&&/\.(png|webp|jpe?g)$/i.test(u.pathname)))?u.href:'';}catch{return '';}}
 decorate(e){const out={...e};for(const n of [1,2]){const key=this.key(e.category,e['team'+n]),old=this.index[key];if(old?.file)out['team'+n+'Logo']='/api/team-logos/'+key;const remote=this.allowed(e['team'+n+'Logo']);if(remote&&!old?.file)out['team'+n+'Logo']='';if(remote&&(!old||old.remote!==remote||Date.now()>=Number(old?.retryAt||0))&&Date.now()-(old?.attempt||0)>300000&&!this.pending.has(key)){this.pending.add(key);this.queue.push({key,remote,name:e['team'+n],category:e.category});this.pump();}}return out;}
 async pump(){await this.ready;while(this.running<2&&this.queue.length){const item=this.queue.shift();this.running++;this.download(item).catch(error=>this.failed(item,error)).finally(()=>{this.running--;this.pending.delete(item.key);this.pump();});}}
 async failed(item,error){const old=this.index[item.key]||{},count=Number(old.failureCount||0)+1,retryMs=Math.min(6*60*60*1000,5*60*1000*Math.pow(2,Math.min(6,count-1))),now=Date.now();this.index[item.key]={...old,...item,attempt:now,failureCount:count,retryAt:now+retryMs,lastError:error.message};this.writes=this.writes.catch(()=>{}).then(()=>writeJson('teams/logos.json',this.index));await this.writes;if(count===1||now-Number(old.lastLoggedAt||0)>60*60*1000){this.index[item.key].lastLoggedAt=now;log.warn('[team-logo]',item.name||item.key,error.message,`retry ${Math.round(retryMs/60000)}m`);}}
 async download(item){const {key,remote}=item;this.index[key]={...this.index[key],attempt:Date.now()};const r=await fetch(remote,{redirect:'error',signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('HTTP '+r.status);const mime=(r.headers.get('content-type')||'').split(';')[0],ext=({'image/png':'png','image/webp':'webp','image/jpeg':'jpg'})[mime];if(!ext)throw Error('Неверный формат логотипа');const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>524288)throw Error('Логотип слишком большой');chunks.push(chunk);}const file=key+'.'+ext,dir=path.join(config.dataDir,'teams','images');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,file),Buffer.concat(chunks));this.index[key]={...item,file,mime,updatedAt:Date.now(),failureCount:0,retryAt:0,lastError:''};this.writes=this.writes.catch(()=>{}).then(()=>writeJson('teams/logos.json',this.index));await this.writes;}
 async read(key){await this.ready;const item=this.index[key];if(!item?.file)return null;return {body:await fs.readFile(path.join(config.dataDir,'teams','images',item.file)),mime:item.mime};}
}
export const teamLogos=new TeamLogos();
