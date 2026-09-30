import { log } from "./logger.js";
import { createHash, randomBytes } from 'node:crypto';
import { readJson, writeJson } from './utils.js';
import Model from './league-model.cjs';
import GameCategories from './game-categories.cjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
async function strictRead(filename,fallback){const target=path.join(config.dataDir,filename),backup=target+'.bak';try{return JSON.parse(await fs.readFile(target,'utf8'));}catch(error){try{const recovered=JSON.parse(await fs.readFile(backup,'utf8'));log.error('[storage] recovered '+filename+' from .bak: '+error.message);try{const temp=target+'.'+process.pid+'.'+Date.now()+'.recover.tmp';await fs.copyFile(backup,temp);await fs.rename(temp,target);}catch(healError){log.error('[storage] could not self-heal '+filename+': '+healError.message);}return recovered;}catch{if(error.code==='ENOENT')return fallback;throw error;}}}
export class LeagueStore {
  constructor({read=strictRead,write=writeJson}={}){
    this.read=read;this.write=write;this.state={schemaVersion:1,revision:0,visibilityRevision:0,links:[],visibility:{excludedLeagueKeys:[],excludedCategoryKeys:[]},audit:[]};
    this.catalog=new Map();this.persist=false;this.queue=Promise.resolve();this.challenges=new Map();this.attempts=new Map();
  }
  async load(legacy=[]){
    const saved=await this.read('league-links.json',null);
    if(saved&&(!Array.isArray(saved.links)||!Number.isInteger(saved.revision)))throw new Error('league-links.json повреждён: восстановите его из резервной копии');
    if(saved)this.state={...this.state,...saved};
    else if(legacy.length){
      let links=[];
      for(const row of legacy)if(row.astek&&row.fonbet){links=Model.connect(links,[row.astek,row.fonbet],`migrated-${createHash('sha256').update(row.id).digest('hex').slice(0,20)}`,row.createdAt||Date.now());
        const set=Model.groupFor(row.astek,links);set.legacyKeys=Model.unique([...(set.legacyKeys||[]),`logical:manual:${String(row.id).toLowerCase()}`]);set.publishedAt=row.updatedAt||Date.now();}
      this.state={...this.state,revision:1,links,audit:[{at:Date.now(),action:'migration',count:legacy.length,revision:1}]};
      await this.write('league-links.json',this.state);
    }
    const catalog=await this.read('league-catalog.json',[]);for(const row of catalog)if(row?.source&&row?.league)this.catalog.set(Model.id(row),row);
    this.persist=true;
  }
  snapshot(){return structuredClone(this.state);}
  rules(){return {revision:this.state.revision,visibilityRevision:this.state.visibilityRevision,links:this.state.links,visibility:this.state.visibility};}
  revision(){return this.state.revision;}
  group(ref){return Model.groupFor(ref,this.state.links);}
  relation(a,b){const x=this.group(a),y=this.group(b);return {linked:!!x&&x.id===y?.id,blocked:!!(x||y)&&x?.id!==y?.id};}
  async remember(rows){
    let changed=false;
    for(const input of rows){if(!input?.source||!input?.league||!['astek','fonbet','pinnacle','ggbet'].includes(input.source))continue;
      const row=Model.ref(input),key=Model.id(row),old=this.catalog.get(key);
      if(!old||JSON.stringify(old)!==JSON.stringify(row)){this.catalog.set(key,row);changed=true;}}
    for(const set of this.state.links)for(const row of Model.members(set)){if(!this.catalog.has(Model.id(row))){this.catalog.set(Model.id(row),row);changed=true;}}
    if(changed&&this.persist)await this.write('league-catalog.json',[...this.catalog.values()]);
  }
  catalogSnapshot(current=[]){
    const counts=new Map();for(const r of current){const key=Model.id(r);counts.set(key,(counts.get(key)||0)+1);}
    const rows=[...this.catalog.values()].map(row=>({...row,id:Model.id(row),provider:({astek:'AstekBet',fonbet:'Fonbet',pinnacle:'Pinnacle',ggbet:'GGBET'})[row.source],canonicalLeagueId:this.group(row)?Model.groupKey(this.group(row)):null,current:counts.get(Model.id(row))||0}));
    rows.sort((a,b)=>a.category.localeCompare(b.category)||a.league.localeCompare(b.league));
    return {...this.snapshot(),generatedAt:Date.now(),providers:{astek:rows.filter(r=>r.source==='astek'),fonbet:rows.filter(r=>r.source==='fonbet'),pinnacle:rows.filter(r=>r.source==='pinnacle'),ggbet:rows.filter(r=>r.source==='ggbet')}};
  }
  challenge(address=''){
    const now=Date.now();for(const [key,value] of this.challenges)if(value.expiresAt<now)this.challenges.delete(key);
    if(this.challenges.size>=2000)throw fail('Слишком много запросов. Повторите позже.',429);
    const nonce=randomBytes(32).toString('hex');this.challenges.set(nonce,{address,expiresAt:now+60000});return {nonce,expiresAt:now+60000};
  }
  publish(body,address=''){
    const now=Date.now(),nonce=String(body?.nonce||''),challenge=this.challenges.get(nonce);
    // Publication is rare and state-changing. Require a short-lived one-time
    // challenge bound to the same client address so stale/replayed POSTs and
    // casual cross-origin abuse cannot mutate league rules.
    if(!challenge||challenge.expiresAt<now||challenge.address!==address)throw fail('Публикация устарела. Обновите каталог и повторите.',403);
    this.challenges.delete(nonce);
    const prior=this.attempts.get(address),attempt=prior&&now-prior.start<60000?prior:{start:now,count:0};if(++attempt.count>30)throw fail('Слишком много публикаций. Подождите минуту.',429);this.attempts.set(address,attempt);for(const [key,value] of this.attempts)if(now-value.start>120000)this.attempts.delete(key);
    const run=this.queue.catch(()=>{}).then(()=>this.commit(body.baseRevision,body.changes));this.queue=run;return run;
  }
  async commit(baseRevision,changes){
    if(baseRevision!==this.state.revision)throw fail('Правила изменены в другом окне. Обновите каталог и проверьте черновик.',409);
    if(!changes||!Array.isArray(changes.upsert)||!Array.isArray(changes.remove)||changes.upsert.length>2000||changes.remove.length>2000)throw fail('Некорректный список изменений');
    const now=Date.now(),old=new Map(this.state.links.map(s=>[s.id,s]));
    const upsert=changes.upsert.map(raw=>{
      if(typeof raw.id!=='string'||!/^[\w-]{1,100}$/.test(raw.id))throw fail('Некорректный ID группы');
      if(!Array.isArray(raw.astekLeagues)||!Array.isArray(raw.fonbetLeagues)||raw.astekLeagues.length>500||raw.fonbetLeagues.length>500||!Array.isArray(raw.pinnacleLeagues||[])||(raw.pinnacleLeagues||[]).length>500||!Array.isArray(raw.ggbetLeagues||[])||(raw.ggbetLeagues||[]).length>500)throw fail('Некорректный состав группы');
      const fromCatalog=(rows,source)=>rows.map(r=>{const known=this.catalog.get(Model.id(Model.ref(r,source)));if(!known)throw fail('Чемпионат отсутствует в каталоге сервера');return known;});
      const set=Model.shape({id:raw.id,name:String(raw.name||'').trim().slice(0,150),astekLeagues:fromCatalog(raw.astekLeagues,'astek'),fonbetLeagues:fromCatalog(raw.fonbetLeagues,'fonbet'),pinnacleLeagues:fromCatalog(raw.pinnacleLeagues||[],'pinnacle'),ggbetLeagues:fromCatalog(raw.ggbetLeagues||[],'ggbet'),createdAt:old.get(raw.id)?.createdAt||now,updatedAt:now,publishedAt:now,legacyKeys:old.get(raw.id)?.legacyKeys||[]});
      if(Model.members(set).length<2)throw fail('Выберите минимум два чемпионата');
      const all=Model.members(set);const chosen=String(raw.category||'').trim();if(chosen&&!GameCategories.entries.some(([,name])=>name===chosen)&&chosen!=='Esports'&&!all.every(r=>r.category===chosen))throw fail('Выберите дисциплину из списка');if(new Set(all.map(r=>Model.norm(r.category))).size!==1&&(!chosen||chosen==='Esports'))throw fail('Выберите общую дисциплину');
      for(const r of all){if(!r.category||!r.league||r.league.length>500||r.category.length>100||r.leagueId.length>100)throw fail('Некорректный чемпионат');if(!this.catalog.has(Model.id(r)))throw fail('Чемпионат отсутствует в каталоге сервера');}
      // Preserve canonical filter keys of any groups explicitly absorbed by this one.
      set.legacyKeys=Model.unique([...set.legacyKeys,...changes.remove.flatMap(key=>{const row=old.get(key);return row&&Model.memberIds(row).some(id=>Model.memberIds(set).includes(id))?[Model.groupKey(row),...(row.legacyKeys||[])]:[];})]);
      set.category=chosen||all[0].category;return set;
    });
    if(new Set(upsert.map(s=>s.id)).size!==upsert.length||new Set(changes.remove).size!==changes.remove.length||upsert.some(s=>changes.remove.includes(s.id)))throw fail('Повторяющиеся изменения');
    for(const id of changes.remove)if(!old.has(id))throw fail('Удаляемая группа уже отсутствует');
    const links=Model.applyDiff(this.state.links,{upsert,remove:changes.remove}),used=new Set();
    for(const set of links)for(const id of Model.memberIds(set)){if(used.has(id))throw fail('Чемпионат уже в другой группе: объедините группы локально');used.add(id);}
    let visibility=this.state.visibility;
    if(changes.visibility){
      for(const key of ['excludedLeagueKeys','excludedCategoryKeys'])if(!Array.isArray(changes.visibility[key])||changes.visibility[key].length>30000||changes.visibility[key].some(v=>typeof v!=='string'||v.length>1000))throw fail('Некорректный фильтр');
      visibility={excludedLeagueKeys:Model.unique(changes.visibility.excludedLeagueKeys),excludedCategoryKeys:Model.unique(changes.visibility.excludedCategoryKeys)};
    }
    const actions=[...upsert.map(s=>({at:now,action:old.has(s.id)?'updated':'created',id:s.id,before:old.get(s.id)||null,after:s})),...changes.remove.map(id=>({at:now,action:'deleted',id,before:old.get(id)}))];
    if(JSON.stringify(visibility)!==JSON.stringify(this.state.visibility))actions.push({at:now,action:'visibility',before:this.state.visibility,after:visibility});
    if(!actions.length)return this.snapshot();
    const revision=this.state.revision+1,next={...this.state,revision,links,visibility,visibilityRevision:changes.visibility?revision:this.state.visibilityRevision,audit:[...this.state.audit,...actions.map(a=>({...a,revision}))]};
    if(this.persist)await this.write('league-links.json',next); // commit only after durable write
    this.state=next;return this.snapshot();
  }
}
export const leagueStore=new LeagueStore();
