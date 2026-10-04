import {config} from './config.js';
import {readJson,writeJson} from './utils.js';
import {identity} from './identity.js';
import {scoreAppend,scoreImport,scoreLoad,scoreReplaceLast} from './sqlite-storage.js';

export class ScoreLog {
  constructor(options={}){
    this.sqlite=!Object.prototype.hasOwnProperty.call(options,'read')&&!Object.prototype.hasOwnProperty.call(options,'write');
    this.read=options.read||readJson;this.write=options.write||writeJson;this.pending=new Map();this.cache=new Map();this.loading=new Map();
  }
  filename(key){return `scores/${Buffer.from(key).toString('base64url')}.json`;}
  async load(key){
    if(this.sqlite&&config.sqliteHistoryEnabled){const saved=scoreLoad(key);if(saved)return saved;}
    if(this.cache.has(key))return this.cache.get(key);
    if(!this.loading.has(key))this.loading.set(key,(async()=>{
      let saved;
      if(this.sqlite){
        saved=scoreLoad(key);
        if(!saved){const legacy=await this.read(this.filename(key),null);if(legacy){scoreImport(key,legacy);saved=scoreLoad(key);}}
      }else saved=await this.read(this.filename(key),null);
      const value=saved||{key,entries:[]};if(!this.cache.has(key))this.cache.set(key,value);while(this.cache.size>160)this.cache.delete(this.cache.keys().next().value);return this.cache.get(key)||value;
    })().finally(()=>this.loading.delete(key)));
    return this.loading.get(key);
  }
  async persistAppend(key,next,entry){
    if(this.sqlite)scoreAppend(key,next.startedAt,entry);else await this.write(this.filename(key),next);
  }
  async persistReplaceLast(key,next,last){
    if(this.sqlite)scoreReplaceLast(key,last);else await this.write(this.filename(key),next);
  }
  async record(events,{phase='live',at=Date.now(),event}={}){
    await Promise.all(events.flatMap(e=>e.sourceRefs?.length?e.sourceRefs:[e]).map(r=>{
      if(!['astek','fonbet','pinnacle','ggbet'].includes(r.source)||!(r.sourceEventId||r.id)||(!event&&(!r.scoreText||!/[0-9]/.test(r.scoreText))))return;
      const key=identity(r),run=(this.pending.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
        const old=await this.load(key),last=old.entries.at(-1),verified=r.resultVerified===true;
        const norm=s=>String(s||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
        if(last&&norm(r.team1)===norm(last.team2)&&norm(r.team2)===norm(last.team1)&&norm(r.team1)!==norm(r.team2))r={...r,team1:r.team2,team2:r.team1,scoreText:String(r.scoreText||'').replace(/(\d+)\s*:\s*(\d+)/g,'$2:$1'),seriesScore:r.seriesScore?.slice().reverse(),mapScores:r.mapScores?.map(p=>p.slice().reverse())};
        if(last?.verified&&!verified){if(!event)return;r={...r,scoreText:last.scoreText,seriesScore:last.seriesScore,mapScores:last.mapScores};}
        if(last&&String(last.scoreText||'').replace(/\s+/g,'')===String(r.scoreText||'').replace(/\s+/g,'')&&!event){
          if(verified&&!last.verified){const replacement={...last,verified:true,confirmedAt:at},next={...old,entries:[...old.entries.slice(0,-1),replacement]};await this.persistReplaceLast(key,next,replacement);this.cache.set(key,next);}return;
        }
        if(event&&last?.event===event&&last.at===at)return;
        const entry={at,source:r.source,sourceEventId:String(r.sourceEventId||r.id),team1:r.team1,team2:r.team2,scoreText:r.scoreText||'',seriesScore:r.seriesScore,mapScores:r.mapScores,verified:verified||!!last?.verified,phase,...(event?{event}:{})};
        const next={key,startedAt:old.startedAt||at,entries:[...old.entries,entry]};
        await this.persistAppend(key,next,entry);this.cache.set(key,next);
        if(this.cache.size>160)this.cache.delete(this.cache.keys().next().value);
      });this.pending.set(key,run);run.finally(()=>{if(this.pending.get(key)===run)this.pending.delete(key);}).catch(()=>{});return run;
    }));
  }
  async get(keys,{limit=1000,before=Infinity}={}){const logs=await Promise.all([...new Set(keys)].map(key=>this.load(key))),starts=logs.map(r=>r.startedAt).filter(Boolean),all=logs.flatMap(log=>log.entries.map(r=>({...r,key:log.key}))).filter(r=>r.at<before).sort((a,b)=>b.at-a.at||a.source.localeCompare(b.source));const page=all.slice(0,limit),boundary=page.at(-1)?.at;for(let i=limit;i<all.length&&all[i].at===boundary;i++)page.push(all[i]);return {entries:page,hasMore:all.length>page.length,nextBefore:all.length>page.length?boundary:null,startedAt:starts.length?Math.min(...starts):null};}
}
export const scoreLog=new ScoreLog();
