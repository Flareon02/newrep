import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA_VERSION = 3;
const handles = new Map();
const json = value => JSON.stringify(value);
const parse = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); }
  catch { return fallback; }
};
const safeId=s=>String(s||'').replace(/[^\w-]/g,'').slice(0,80);

function databasePath(dir=config.dataDir){return path.join(path.resolve(dir),'monitor-v2.sqlite3');}
function ensureParent(file){fs.mkdirSync(path.dirname(file),{recursive:true});}
function schema(db){
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA foreign_keys=ON;
    PRAGMA temp_store=MEMORY;
    PRAGMA busy_timeout=5000;
    PRAGMA cache_size=-8192;
    CREATE TABLE IF NOT EXISTS meta(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS snapshot_meta(
      name TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS snapshot_current(
      name TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(name,event_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS snapshot_history(
      name TEXT NOT NULL,
      event_id TEXT NOT NULL,
      start_at INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      removed_at INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      PRIMARY KEY(name,event_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS snapshot_history_window ON snapshot_history(name,start_at,removed_at);
    CREATE INDEX IF NOT EXISTS snapshot_history_recent ON snapshot_history(name,last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS snapshot_history_first_seen ON snapshot_history(name,first_seen_at);
    CREATE INDEX IF NOT EXISTS snapshot_history_removed ON snapshot_history(name,removed_at);
    CREATE TABLE IF NOT EXISTS score_meta(
      identity TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS score_entries(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      identity TEXT NOT NULL,
      at INTEGER NOT NULL,
      payload TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS score_entries_identity_at ON score_entries(identity,at DESC,seq DESC);
    CREATE TABLE IF NOT EXISTS odds_state(
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(source,event_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS odds_entries_v3(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      payload BLOB NOT NULL,
      origin TEXT,
      origin_pos INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS odds_entries_v3_event_at ON odds_entries_v3(source,event_id,at DESC,seq DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS odds_entries_v3_origin ON odds_entries_v3(origin,origin_pos) WHERE origin IS NOT NULL;
    CREATE TABLE IF NOT EXISTS archive_blobs(
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `);
  db.prepare(`INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(SCHEMA_VERSION));
}

export function sqlite(){
  const file=databasePath();
  let row=handles.get(file);
  if(row)return row;
  ensureParent(file);
  const db=new DatabaseSync(file,{timeout:5000});schema(db);
  row={db,file};handles.set(file,row);return row;
}
export function checkpointSqliteStorage(){for(const row of handles.values())try{row.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}catch{}}
export function closeSqliteStorage(){checkpointSqliteStorage();for(const row of handles.values())try{row.db.close();}catch{}handles.clear();}
export function sqliteFile(){return sqlite().file;}
export function integrityCheck(){const {db}=sqlite();const row=db.prepare('PRAGMA quick_check').get();return String(Object.values(row||{})[0]||'').toLowerCase()==='ok';}
export function metaGet(key){const row=sqlite().db.prepare('SELECT value FROM meta WHERE key=?').get(String(key));return row?.value??null;}
export function metaSet(key,value){sqlite().db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(String(key),String(value));}

// Parse rows one at a time. `.all()` first materialises every JSON string of the
// table (a year of History is hundreds of thousands of rows), doubling the peak
// RSS at startup on a 1 GiB host; iterating keeps only the parsed objects alive.
function parseRows(statement,...params){
  const out=[];
  if(typeof statement.iterate==='function'){for(const row of statement.iterate(...params)){const value=parse(row.payload);if(value)out.push(value);}}
  else for(const row of statement.all(...params)){const value=parse(row.payload);if(value)out.push(value);}
  return out;
}
// `hotSince` > 0 loads only the History rows with activity (first seen, last seen or removed) at or after that
// instant; older rows stay in SQLite and are read on demand (see the snapshotHistory* queries below).
const ACTIVE = '(first_seen_at>=? OR last_seen_at>=? OR removed_at>=?)';
export function snapshotLoad(name,{hotSince=0}={}){
  const {db}=sqlite(), meta=db.prepare('SELECT payload FROM snapshot_meta WHERE name=?').get(name);
  if(!meta)return null;
  const state=parse(meta.payload,{})||{};
  const events=parseRows(db.prepare('SELECT payload FROM snapshot_current WHERE name=? ORDER BY event_id'),name);
  const history=hotSince>0
    ?parseRows(db.prepare(`SELECT payload FROM snapshot_history WHERE name=? AND ${ACTIVE} ORDER BY first_seen_at,event_id`),name,hotSince,hotSince,hotSince)
    :parseRows(db.prepare('SELECT payload FROM snapshot_history WHERE name=? ORDER BY first_seen_at,event_id'),name);
  return {...state,events,history,historyTotal:snapshotHistoryCount(name)};
}

// Prepared statements live on the handle, so they disappear when the database is closed or another data dir is opened.
function cached(sql){const handle=sqlite();handle.statements??=new Map();let st=handle.statements.get(sql);if(!st){st=handle.db.prepare(sql);handle.statements.set(sql,st);}return st;}
export function snapshotHistoryCount(name){return Number(cached('SELECT COUNT(*) AS n FROM snapshot_history WHERE name=?').get(name)?.n||0);}
export function snapshotHistoryHas(name,id){return !!cached('SELECT 1 AS x FROM snapshot_history WHERE name=? AND event_id=?').get(name,String(id));}
export function snapshotHistoryGet(name,id){const row=cached('SELECT payload FROM snapshot_history WHERE name=? AND event_id=?').get(name,String(id));return row?parse(row.payload):null;}
// Rows with activity >= since, newest first-seen first. `limit` 0 = all.
export function snapshotHistoryActive(name,since,limit=0){
  const sql=`SELECT payload FROM snapshot_history WHERE name=? AND ${ACTIVE} ORDER BY first_seen_at DESC,event_id DESC${limit>0?' LIMIT ?':''}`;
  const params=[name,since,since,since];if(limit>0)params.push(limit);
  return parseRows(cached(sql),...params);
}
// Removed fixtures whose scheduled start lies in [from,to).
export function snapshotHistoryByStart(name,from,to){
  return parseRows(cached('SELECT payload FROM snapshot_history WHERE name=? AND start_at>=? AND start_at<? AND removed_at>0 ORDER BY first_seen_at,event_id'),name,from,to);
}
export function snapshotImport(name,saved){
  if(!saved||typeof saved!=='object')return;
  const {events=[],history=[],...meta}=saved, {db}=sqlite();
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('INSERT INTO snapshot_meta(name,payload,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(name,json(meta),Date.now());
    db.prepare('DELETE FROM snapshot_current WHERE name=?').run(name);
    const current=db.prepare('INSERT INTO snapshot_current(name,event_id,payload) VALUES(?,?,?) ON CONFLICT(name,event_id) DO UPDATE SET payload=excluded.payload');
    for(const e of events||[]){const id=String(e?.id||'');if(id)current.run(name,id,json(e));}
    const hist=db.prepare(`INSERT INTO snapshot_history(name,event_id,start_at,first_seen_at,last_seen_at,removed_at,payload) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(name,event_id) DO UPDATE SET start_at=excluded.start_at,first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at,removed_at=excluded.removed_at,payload=excluded.payload`);
    for(const e of history||[]){const id=String(e?.id||'');if(id)hist.run(name,id,Number(e.startAt)||0,Number(e.firstSeenAt)||0,Number(e.lastSeenAt)||0,Number(e.removedAt)||0,json(e));}
    db.exec('COMMIT');metaSet(`migrated:snapshot:${name}`,'1');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}
export function snapshotSave(name,state,{dirtyIds=null,pruneBefore=0}={}){
  const {events=[],history=[],...meta}=state,{db}=sqlite();
  const byId=new Map((history||[]).map(e=>[String(e?.id||''),e]).filter(([id])=>id));
  const dirty=dirtyIds?new Set([...dirtyIds].map(String)):new Set(byId.keys());
  let pruned=0;
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('INSERT INTO snapshot_meta(name,payload,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(name,json(meta),Date.now());
    db.prepare('DELETE FROM snapshot_current WHERE name=?').run(name);
    const current=db.prepare('INSERT INTO snapshot_current(name,event_id,payload) VALUES(?,?,?) ON CONFLICT(name,event_id) DO UPDATE SET payload=excluded.payload');
    for(const e of events||[]){const id=String(e?.id||'');if(id)current.run(name,id,json(e));}
    const hist=db.prepare(`INSERT INTO snapshot_history(name,event_id,start_at,first_seen_at,last_seen_at,removed_at,payload) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(name,event_id) DO UPDATE SET start_at=excluded.start_at,first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at,removed_at=excluded.removed_at,payload=excluded.payload`);
    for(const id of dirty){const e=byId.get(id);if(e)hist.run(name,id,Number(e.startAt)||0,Number(e.firstSeenAt)||0,Number(e.lastSeenAt)||0,Number(e.removedAt)||0,json(e));}
    if(pruneBefore>0){
      pruned+=Number(db.prepare('DELETE FROM snapshot_history WHERE name=? AND first_seen_at<?').run(name,Number(pruneBefore)).changes);
      pruned+=Number(db.prepare(`DELETE FROM snapshot_history WHERE name=? AND event_id NOT IN (
        SELECT event_id FROM snapshot_history WHERE name=? ORDER BY first_seen_at DESC LIMIT ?
      )`).run(name,name,Number(config.historyMax)||100000).changes);
    }
    db.exec('COMMIT');
    return {pruned};
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}
export function snapshotNames(){return sqlite().db.prepare('SELECT name FROM snapshot_meta ORDER BY name').all().map(r=>r.name);}

export function scoreLoad(identity){
  const {db}=sqlite(),meta=db.prepare('SELECT started_at FROM score_meta WHERE identity=?').get(identity);
  if(!meta)return null;
  const entries=db.prepare('SELECT payload FROM score_entries WHERE identity=? ORDER BY at,seq').all(identity).map(r=>parse(r.payload)).filter(Boolean);
  return {key:identity,startedAt:Number(meta.started_at)||0,entries};
}
export function scoreImport(identity,log){
  if(!log||!Array.isArray(log.entries))return;
  const {db}=sqlite();db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('INSERT INTO score_meta(identity,started_at) VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET started_at=MIN(score_meta.started_at,excluded.started_at)').run(identity,Number(log.startedAt)||Number(log.entries[0]?.at)||0);
    const st=db.prepare('INSERT INTO score_entries(identity,at,payload) VALUES(?,?,?)');
    for(const e of log.entries)st.run(identity,Number(e.at)||0,json(e));
    db.exec('COMMIT');metaSet(`migrated:score:${identity}`,'1');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}
export function scoreAppend(identity,startedAt,entry){
  const {db}=sqlite();db.exec('BEGIN IMMEDIATE');
  try{db.prepare(`INSERT INTO score_meta(identity,started_at) VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET started_at=CASE WHEN score_meta.started_at=0 THEN excluded.started_at ELSE MIN(score_meta.started_at,excluded.started_at) END`).run(identity,Number(startedAt)||Number(entry.at)||0);db.prepare('INSERT INTO score_entries(identity,at,payload) VALUES(?,?,?)').run(identity,Number(entry.at)||0,json(entry));db.exec('COMMIT');}
  catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}
export function scoreReplaceLast(identity,entry){const {db}=sqlite();const row=db.prepare('SELECT seq FROM score_entries WHERE identity=? ORDER BY at DESC,seq DESC LIMIT 1').get(identity);if(row)db.prepare('UPDATE score_entries SET at=?,payload=? WHERE seq=?').run(Number(entry.at)||0,json(entry),row.seq);}
export function scoreIdentities(){return sqlite().db.prepare('SELECT identity FROM score_meta ORDER BY identity').all().map(r=>r.identity);}

function legacyJson(target,fallback){try{return JSON.parse(fs.readFileSync(target,'utf8'));}catch{try{return JSON.parse(fs.readFileSync(target+'.bak','utf8'));}catch{return fallback;}}}
const oddsEncode=value=>deflateRawSync(Buffer.from(json(value)),{level:1});
function oddsDecode(value){
  if(value==null)return null;
  try{
    if(typeof value==='string')return parse(value,null);
    return parse(inflateRawSync(Buffer.from(value)).toString('utf8'),null);
  }catch{return null;}
}
function oddsMarker(source,id){return `migrated:odds:${safeId(source)}:${safeId(id)}`;}
function oddsLegacyPaths(source,id){
  const root=path.resolve(config.dataDir),s=safeId(source),e=safeId(id);
  return {legacy:path.join(root,'odds',s,e+'.json'),state:path.join(root,'odds-state',s,e+'.json'),journal:path.join(root,'odds-journal',s,e+'.ndjson')};
}
function oddsLegacyExists(source,id){const p=oddsLegacyPaths(source,id);return [p.legacy,p.legacy+'.bak',p.state,p.state+'.bak',p.journal].some(f=>{try{return fs.statSync(f).isFile();}catch{return false;}});}
export function oddsEnsureMigrated(source,id){
  source=safeId(source);id=safeId(id);if(!source||!id)return;
  const marker=oddsMarker(source,id);if(metaGet(marker)==='1')return;
  if(!oddsLegacyExists(source,id)){metaSet(marker,'1');return;}
  const paths=oddsLegacyPaths(source,id),files=[paths.legacy,paths.legacy+'.bak',paths.state,paths.state+'.bak',paths.journal];
  let bytes=0;for(const file of files)try{bytes+=fs.statSync(file).size||0;}catch{}
  const lazyLimit=Math.max(0,Number(process.env.ASTEK_LAZY_LEGACY_MAX_BYTES)||8*1024*1024);
  if(bytes>lazyLimit)throw new Error(`Legacy odds ${source}:${id} are ${Math.round(bytes/1048576)} MiB and require streaming migration before server start`);
  const root=path.resolve(config.dataDir),legacy=legacyJson(paths.legacy,{entries:[],last:{}})||{entries:[],last:{}},state=legacyJson(paths.state,null),journalText=(()=>{try{return fs.readFileSync(paths.journal,'utf8');}catch{return '';}})();
  const journal=[];let offset=0;for(const line of journalText.split(/(?<=\n)/)){const text=line.trim();if(text){try{journal.push({value:JSON.parse(text),pos:offset});}catch{}}offset+=Buffer.byteLength(line);}
  const {db}=sqlite(),ins=db.prepare('INSERT OR IGNORE INTO odds_entries_v3(source,event_id,at,payload,origin,origin_pos) VALUES(?,?,?,?,?,?)');
  const legacyOrigin=path.relative(root,paths.legacy).split(path.sep).join('/'),journalOrigin=path.relative(root,paths.journal).split(path.sep).join('/');
  db.exec('BEGIN IMMEDIATE');
  try{
    for(let i=0;i<(legacy.entries||[]).length;i++){const e=legacy.entries[i];if(Number(e?.at)>0)ins.run(source,id,Number(e.at),oddsEncode(e),legacyOrigin,i);}
    for(const row of journal){const e=row.value;if(Number(e?.at)>0)ins.run(source,id,Number(e.at),oddsEncode(e),journalOrigin,row.pos);}
    const lastAt=Math.max(Number((legacy.entries||[]).at(-1)?.at)||0,Number(journal.at(-1)?.value?.at)||0);
    const current=state||((legacy.last&&Object.keys(legacy.last).length)?{last:legacy.last,lastAt,team1:legacy.team1||'',team2:legacy.team2||'',scoreText:legacy.scoreText||''}:null);
    if(current)db.prepare('INSERT INTO odds_state(source,event_id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(source,event_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(source,id,json(current),Number(current.lastAt)||Date.now());
    db.exec('COMMIT');metaSet(marker,'1');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}
export function oddsStateLoad(source,id){oddsEnsureMigrated(source,id);const row=sqlite().db.prepare('SELECT payload FROM odds_state WHERE source=? AND event_id=?').get(safeId(source),safeId(id));return parse(row?.payload,null);}
export function oddsStateSave(source,id,value){sqlite().db.prepare('INSERT INTO odds_state(source,event_id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(source,event_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(safeId(source),safeId(id),json(value),Number(value?.lastAt)||Date.now());}
export function oddsAppend(source,id,entry){
  source=safeId(source);id=safeId(id);oddsEnsureMigrated(source,id);
  sqlite().db.prepare('INSERT INTO odds_entries_v3(source,event_id,at,payload,origin,origin_pos) VALUES(?,?,?,?,NULL,NULL)').run(source,id,Number(entry.at)||Date.now(),oddsEncode(entry));
}
export function oddsEntries(source,id,{before=Infinity,limit=0,ascending=true}={}){
  source=safeId(source);id=safeId(id);oddsEnsureMigrated(source,id);
  const params=[source,id],where=Number.isFinite(before)?' AND at<?':'';if(Number.isFinite(before))params.push(Number(before));
  let sql=`SELECT payload FROM odds_entries_v3 WHERE source=? AND event_id=?${where} ORDER BY at ${ascending?'ASC':'DESC'},seq ${ascending?'ASC':'DESC'}`;
  if(limit>0){sql+=' LIMIT ?';params.push(Number(limit));}
  return sqlite().db.prepare(sql).all(...params).map(r=>oddsDecode(r.payload)).filter(Boolean);
}
export function oddsKeys(){return sqlite().db.prepare(`SELECT source,event_id FROM odds_state UNION SELECT source,event_id FROM odds_entries_v3 ORDER BY source,event_id`).all();}

async function* streamNdjson(file,{start=0}={}){
  let stat;try{stat=await fsp.stat(file);}catch(error){if(error?.code==='ENOENT')return;throw error;}
  if(start<0||start>stat.size)start=0;
  const stream=createReadStream(file,{start,highWaterMark:256*1024});
  let pending=Buffer.alloc(0),pendingStart=start;
  for await(const chunk of stream){
    pending=pending.length?Buffer.concat([pending,chunk]):Buffer.from(chunk);
    while(true){
      const nl=pending.indexOf(10);if(nl<0)break;
      const lineStart=pendingStart,lineEnd=pendingStart+nl+1;let line=pending.subarray(0,nl);if(line.length&&line.at(-1)===13)line=line.subarray(0,-1);
      pending=pending.subarray(nl+1);pendingStart=lineEnd;
      const text=line.toString('utf8').trim();if(!text)continue;
      let value;try{value=JSON.parse(text);}catch(error){throw new Error(`Invalid NDJSON at ${file}:${lineStart}: ${error.message}`);}
      yield {value,startOffset:lineStart,nextOffset:lineEnd};
    }
  }
  if(pending.length){
    let line=pending;if(line.length&&line.at(-1)===13)line=line.subarray(0,-1);const text=line.toString('utf8').trim();
    if(text){let value;try{value=JSON.parse(text);}catch(error){throw new Error(`Invalid NDJSON at ${file}:${pendingStart}: ${error.message}`);}yield {value,startOffset:pendingStart,nextOffset:stat.size};}
  }
}
function migrationProgressKey(origin){return `migration:odds-file:${origin}`;}
function migrationProgress(origin){return parse(metaGet(migrationProgressKey(origin)),null);}
function saveMigrationProgress(origin,value){metaSet(migrationProgressKey(origin),json(value));}
async function importLegacyOddsJson(source,id,file,origin,{batchSize=500}={}){
  let data=legacyJson(file,null);if(!data||!Array.isArray(data.entries))return {rows:0,lastAt:0,legacy:data};
  const {db}=sqlite(),ins=db.prepare('INSERT OR IGNORE INTO odds_entries_v3(source,event_id,at,payload,origin,origin_pos) VALUES(?,?,?,?,?,?)');
  let rows=0,lastAt=0;
  for(let base=0;base<data.entries.length;base+=batchSize){
    db.exec('BEGIN IMMEDIATE');try{for(let i=base;i<Math.min(base+batchSize,data.entries.length);i++){const e=data.entries[i];if(Number(e?.at)>0){ins.run(source,id,Number(e.at),oddsEncode(e),origin,i);rows++;lastAt=Math.max(lastAt,Number(e.at)||0);}}db.exec('COMMIT');}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
  }
  const count=Number(db.prepare('SELECT COUNT(*) AS n FROM odds_entries_v3 WHERE origin=?').get(origin)?.n||0);
  if(count!==rows)throw new Error(`Legacy JSON row verification failed for ${origin}: ${count}/${rows}`);
  return {rows,lastAt,legacy:data};
}
async function importOddsJournal(source,id,file,origin,{batchSize=500,progress=()=>{}}={}){
  let stat;try{stat=await fsp.stat(file);}catch(error){if(error?.code==='ENOENT')return {rows:0,lastAt:0,bytes:0};throw error;}
  const prior=migrationProgress(origin);let offset=0,rows=0,lastAt=0;
  if(prior&&Number(prior.size)===stat.size&&Math.trunc(Number(prior.mtimeMs))===Math.trunc(stat.mtimeMs)){offset=Math.max(0,Number(prior.offset)||0);rows=Math.max(0,Number(prior.rows)||0);lastAt=Math.max(0,Number(prior.lastAt)||0);}
  const {db}=sqlite(),ins=db.prepare('INSERT OR IGNORE INTO odds_entries_v3(source,event_id,at,payload,origin,origin_pos) VALUES(?,?,?,?,?,?)');
  let batch=[],lastReport=Date.now();
  const commit=()=>{if(!batch.length)return;db.exec('BEGIN IMMEDIATE');try{for(const row of batch){const e=row.value;if(Number(e?.at)>0)ins.run(source,id,Number(e.at),oddsEncode(e),origin,row.startOffset);}db.exec('COMMIT');}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}const tail=batch.at(-1);for(const row of batch){if(Number(row.value?.at)>0){rows++;lastAt=Math.max(lastAt,Number(row.value.at)||0);}}offset=tail.nextOffset;saveMigrationProgress(origin,{size:stat.size,mtimeMs:stat.mtimeMs,offset,rows,lastAt,complete:false});batch=[];progress({kind:'odds-checkpoint',source,id,origin,rows,offset,size:stat.size});if(Date.now()-lastReport>1500){progress({kind:'odds-progress',source,id,origin,rows,offset,size:stat.size});lastReport=Date.now();}};
  for await(const row of streamNdjson(file,{start:offset})){batch.push(row);if(batch.length>=batchSize)commit();}
  commit();
  const count=Number(db.prepare('SELECT COUNT(*) AS n FROM odds_entries_v3 WHERE origin=?').get(origin)?.n||0);
  if(count!==rows)throw new Error(`NDJSON row verification failed for ${origin}: ${count}/${rows}`);
  saveMigrationProgress(origin,{size:stat.size,mtimeMs:stat.mtimeMs,offset:stat.size,rows,lastAt,complete:true});progress({kind:'odds-file-complete',source,id,origin,rows,size:stat.size});
  return {rows,lastAt,bytes:stat.size};
}
async function migrateOddsKey(source,id,{compact=false,removed,progress=()=>{}}={}){
  source=safeId(source);id=safeId(id);const marker=oddsMarker(source,id),paths=oddsLegacyPaths(source,id),root=path.resolve(config.dataDir);
  if(metaGet(marker)==='1'){
    if(compact){for(const file of [paths.legacy,paths.state,paths.journal]){await removeWithSize(file,removed);await removeWithSize(file+'.bak',removed);}}
    return {source,id,skipped:true};
  }
  const legacyOrigin=path.relative(root,paths.legacy).split(path.sep).join('/'),journalOrigin=path.relative(root,paths.journal).split(path.sep).join('/');
  progress({kind:'odds-file-start',source,id,origin:journalOrigin});
  const legacyResult=await importLegacyOddsJson(source,id,paths.legacy,legacyOrigin),journalResult=await importOddsJournal(source,id,paths.journal,journalOrigin,{progress});
  const state=legacyJson(paths.state,null),legacy=legacyResult.legacy||{},lastAt=Math.max(legacyResult.lastAt,journalResult.lastAt);
  const current=state||((legacy.last&&Object.keys(legacy.last).length)?{last:legacy.last,lastAt,team1:legacy.team1||'',team2:legacy.team2||'',scoreText:legacy.scoreText||''}:null);
  if(current)sqlite().db.prepare('INSERT INTO odds_state(source,event_id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(source,event_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(source,id,json(current),Number(current.lastAt)||Date.now());
  // Per-file row counts + transaction commits already verify each imported source.
  // A full PRAGMA quick_check here is O(database size) and made migration
  // increasingly slower after every file. Run it once at the end instead.
  metaSet(marker,'1');checkpointSqliteStorage();
  if(compact){for(const file of [paths.legacy,paths.state,paths.journal]){await removeWithSize(file,removed);await removeWithSize(file+'.bak',removed);}checkpointSqliteStorage();}
  progress({kind:'odds-complete',source,id,legacyRows:legacyResult.rows,journalRows:journalResult.rows});
  return {source,id,legacyRows:legacyResult.rows,journalRows:journalResult.rows};
}
export function archiveRead(key,fallback=null){const row=sqlite().db.prepare('SELECT payload FROM archive_blobs WHERE key=?').get(String(key));if(row)return parse(row.payload,fallback);const legacy=legacyJson(path.join(config.dataDir,String(key)),undefined);if(legacy!==undefined){archiveWrite(key,legacy);return legacy;}return fallback;}
export function archiveWrite(key,value){sqlite().db.prepare('INSERT INTO archive_blobs(key,payload,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(String(key),json(value),Date.now());}
export function archiveKeys(prefix=''){return sqlite().db.prepare('SELECT key FROM archive_blobs WHERE key LIKE ? ORDER BY key').all(String(prefix)+'%').map(r=>r.key);}


async function listFiles(root,accept,out=[]){
  let entries=[];try{entries=await fsp.readdir(root,{withFileTypes:true});}catch(error){if(error?.code==='ENOENT')return out;throw error;}
  for(const entry of entries){const target=path.join(root,entry.name);if(entry.isDirectory())await listFiles(target,accept,out);else if(entry.isFile()&&accept(target))out.push(target);}
  return out;
}
async function removeWithSize(file,removed){
  try{const st=await fsp.stat(file);await fsp.rm(file,{force:true});removed.files.push(path.relative(path.resolve(config.dataDir),file));removed.bytes+=Number(st.size)||0;}catch(error){if(error?.code!=='ENOENT')throw error;}
}
export async function migrateLegacy({compact=false,progress=()=>{}}={}){
  sqlite().db.exec('PRAGMA synchronous=FULL');
  const root=path.resolve(config.dataDir),report={snapshots:0,scores:0,odds:0,oddsJournalRows:0,archives:0,compact:!!compact,removedFiles:0,freedMiB:0},removed={files:[],bytes:0};
  const snapshots=['live','prematch','fonbet-live','fonbet-prematch','ggbet-live','pinnacle-live','pinnacle-prematch'];
  for(const name of snapshots){
    const target=path.join(root,name+'.json'),saved=legacyJson(target,null);if(!saved)continue;
    if(!snapshotLoad(name))snapshotImport(name,saved);report.snapshots++;
    if(compact){await removeWithSize(target,removed);await removeWithSize(target+'.bak',removed);}
  }
  const scoreDir=path.join(root,'scores'),scoreFiles=await listFiles(scoreDir,f=>f.endsWith('.json'));
  for(const file of scoreFiles){
    let identity='';try{identity=Buffer.from(path.basename(file,'.json'),'base64url').toString('utf8');}catch{}
    if(!identity)continue;const data=legacyJson(file,null);if(!data)continue;
    if(!scoreLoad(identity))scoreImport(identity,data);report.scores++;
    if(compact){await removeWithSize(file,removed);await removeWithSize(file+'.bak',removed);}
  }
  const oddKeys=new Map();
  for(const [folder,ext] of [['odds','.json'],['odds-state','.json'],['odds-journal','.ndjson']]){
    const base=path.join(root,folder);for(const file of await listFiles(base,f=>f.endsWith(ext))){const rel=path.relative(base,file).split(path.sep);if(rel.length!==2)continue;const source=safeId(rel[0]),id=safeId(path.basename(rel[1],ext));if(source&&id)oddKeys.set(source+':'+id,{source,id});}
  }
  let n=0;for(const {source,id} of oddKeys.values()){
    n++;progress({kind:'odds-key',index:n,total:oddKeys.size,source,id});const result=await migrateOddsKey(source,id,{compact,removed,progress});report.odds++;report.oddsJournalRows+=Number(result.journalRows)||0;
  }
  const resultsRoot=path.join(root,'results'),resultFiles=await listFiles(resultsRoot,f=>f.endsWith('.json'));
  for(const file of resultFiles){const key=path.relative(root,file).split(path.sep).join('/');archiveRead(key,null);report.archives++;if(compact){await removeWithSize(file,removed);await removeWithSize(file+'.bak',removed);}}
  if(!integrityCheck())throw new Error('SQLite quick_check failed after migration');
  checkpointSqliteStorage();
  if(compact){report.removedFiles=removed.files.length;report.freedMiB=Math.round(removed.bytes/104857.6)/10;await atomicJson(path.join(root,'.sqlite-v2-migration.json'),{schemaVersion:SCHEMA_VERSION,completedAt:Date.now(),report,removed:removed.files});}
  sqlite().db.exec('PRAGMA synchronous=NORMAL');
  return report;
}

let fastMetricsCache={at:0,value:null};
function lastVerifiedIntegrity(){
  const marker=legacyJson(path.join(path.resolve(config.dataDir),'.sqlite-v2-migration.json'),null);
  return marker?.completedAt?{integrity:'ok',integrityVerifiedAt:Number(marker.completedAt)||0,integritySource:'migration-final-check'}:{integrity:'not-checked',integrityVerifiedAt:0,integritySource:'none'};
}
export function storageMetrics({checkIntegrity=true,integrityOverride=null}={}){
  const now=Date.now();
  if(!checkIntegrity&&!integrityOverride&&fastMetricsCache.value&&now-fastMetricsCache.at<30000)return {...fastMetricsCache.value};
  const {db,file}=sqlite();let size=0,wal=0;try{size=fs.statSync(file).size;}catch{}try{wal=fs.statSync(file+'-wal').size;}catch{}
  const page=db.prepare('PRAGMA page_count').get(),free=db.prepare('PRAGMA freelist_count').get();const val=o=>Number(Object.values(o||{})[0]||0);
  // COUNT(*) over a million-row odds journal is not part of the health critical
  // path more than once every few seconds. Cache the whole cheap metrics sample.
  const oddsRows=Number(db.prepare('SELECT COUNT(*) AS n FROM odds_entries_v3').get()?.n||0);
  const integrity=integrityOverride?{integrity:String(integrityOverride),integrityVerifiedAt:now,integritySource:'explicit-check'}:(checkIntegrity?{integrity:integrityCheck()?'ok':'failed',integrityVerifiedAt:now,integritySource:'quick-check'}:lastVerifiedIntegrity());
  const value={engine:'sqlite',schemaVersion:SCHEMA_VERSION,file:path.basename(file),sizeMiB:Math.round(size/104857.6)/10,walMiB:Math.round(wal/104857.6)/10,pageCount:val(page),freePages:val(free),oddsRows,...integrity};
  if(!checkIntegrity&&!integrityOverride)fastMetricsCache={at:now,value};
  return value;
}

async function atomicJson(file,value){await fsp.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.export.tmp';await fsp.writeFile(tmp,json(value));await fsp.rename(tmp,file);}
export async function exportLegacy(){
  const root=path.resolve(config.dataDir), report={snapshots:0,scores:0,odds:0,archives:0};
  for(const name of snapshotNames()){const state=snapshotLoad(name);await atomicJson(path.join(root,name+'.json'),state);report.snapshots++;}
  for(const identity of scoreIdentities()){const data=scoreLoad(identity),file=path.join(root,'scores',Buffer.from(identity).toString('base64url')+'.json');await atomicJson(file,data);report.scores++;}
  for(const {source,event_id:id} of oddsKeys()){
    const state=oddsStateLoad(source,id)||{last:{}};const dir=path.join(root,'odds-journal',source);await fsp.mkdir(dir,{recursive:true});const tmp=path.join(dir,id+'.ndjson.export.tmp'),target=path.join(dir,id+'.ndjson');const fh=await fsp.open(tmp,'w');try{const st=sqlite().db.prepare('SELECT payload FROM odds_entries_v3 WHERE source=? AND event_id=? ORDER BY at,seq');for(const row of st.iterate(source,id)){const value=oddsDecode(row.payload);if(value)await fh.write(json(value)+'\n');}}finally{await fh.close();}await fsp.rename(tmp,target);await atomicJson(path.join(root,'odds-state',source,id+'.json'),state);report.odds++;
  }
  for(const key of archiveKeys()){await atomicJson(path.join(root,key),archiveRead(key));report.archives++;}
  return report;
}
