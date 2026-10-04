import { forensic, forensicSpan, errorFields } from './collector-forensics.js';
import { log } from "./logger.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import {storageMetrics as sqliteMetrics} from "./sqlite-storage.js";

export function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

export function normalizeKey(value) {
  return clean(value).toLowerCase();
}

export function epochMs(value) {
  if (typeof value === "string" && /[T-]/.test(value)) {
    const date = Date.parse(value);
    return Number.isFinite(date) && date > 0 ? date : 0;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 10_000_000_000 ? number * 1000 : number;
}

export function slug(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "");
}

export function iso(ms = Date.now()) {
  return ms ? new Date(ms).toISOString() : null;
}

export function stableEventSignature(events) {
  return JSON.stringify(
    [...events]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((event) => ({
        id: event.id,
        category: event.category,
        league: event.league,
        leagueId: event.leagueId,
        team1: event.team1,
        team2: event.team2,
        startAt: event.startAt,
        marketKind: event.marketKind,
        bestOf: event.bestOf || 0,
        odds: event.odds?{markets:event.odds.markets,stale:event.odds.stale}:null,
        scoreText: event.scoreText || "",
        seriesScore: event.seriesScore || null,
        mapScores: event.mapScores || [],
        activeMap: Number(event.activeMap)||0,
        broadcast: event.broadcast||null,
        team1Logo: event.team1Logo||"",
        team2Logo: event.team2Logo||"",
        tournamentStage: event.tournamentStage||""
      }))
  );
}

// Matching identity is intentionally separate from volatile score/odds state.
// A score tick must not make the server recompute bookmaker pairing for every
// fixture; current score/odds are overlaid onto the cached logical identities.
export function stableMatchEventSignature(events) {
  return JSON.stringify(
    [...events]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((event) => ({
        id: event.id,
        source: event.source,
        sourceEventId: event.sourceEventId,
        category: event.category,
        league: event.league,
        leagueId: event.leagueId,
        leagueKey: event.leagueKey,
        team1: event.team1,
        team2: event.team2,
        startAt: event.startAt,
        marketKind: event.marketKind,
        bestOf: event.bestOf || 0
      }))
  );
}

export async function ensureDataDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

async function parseJsonFile(target) {
  const text = await fs.readFile(target, "utf8");
  return JSON.parse(text);
}

export async function readJson(filename, fallback) {
  const target = path.join(config.dataDir, filename), backup = `${target}.bak`;
  try {
    return await parseJsonFile(target);
  } catch (primaryError) {
    try {
      const recovered = await parseJsonFile(backup);
      if (primaryError?.code !== "ENOENT") log.error(`[storage] recovered ${filename} from .bak: ${primaryError.message}`);
      // Self-heal the primary generation from the already-validated backup.
      // Copy to a temporary file first, then atomically replace the damaged
      // primary. The backup itself is never modified by recovery.
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.${Date.now()}.recover.tmp`;
        await fs.copyFile(backup, temp);
        await fs.rename(temp, target);
      } catch (healError) {
        log.error(`[storage] could not self-heal ${filename}: ${healError.message}`);
      }
      return recovered;
    } catch {
      return fallback;
    }
  }
}

const pendingWrites = new Map();
// `mode` (e.g. 0o600) is for files that must never be readable by others: it applies to the new generation and the
// kept .bak (the service umask 0022 would otherwise make both world-readable; a umask can only narrow it).
export function writeJson(filename, value, { mode } = {}) {
  const target = path.join(config.dataDir, filename), backup = `${target}.bak`;
  const body = JSON.stringify(value);
  const run = (pendingWrites.get(target) || Promise.resolve()).catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, body, mode == null ? "utf8" : { encoding: "utf8", mode });
    // Keep the previous complete generation. rename() is metadata-only on the
    // same filesystem, so even a power loss between both renames leaves either
    // target or target.bak readable instead of silently resetting state.
    try { await fs.rename(target, backup); if (mode != null) await fs.chmod(backup, mode); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    try { await fs.rename(temp, target); }
    catch (error) {
      try { await fs.rename(backup, target); } catch {}
      try { await fs.rm(temp, { force: true }); } catch {}
      throw error;
    }
  });
  pendingWrites.set(target, run);
  run.finally(() => { if (pendingWrites.get(target) === run) pendingWrites.delete(target); }).catch(() => {});
  return run;
}

export async function flushJsonWrites() {
  await Promise.allSettled([...pendingWrites.values()]);
}

const upstreamMetrics=new Map();
export function upstreamStatus(){
  const now=Date.now();
  return Object.fromEntries([...upstreamMetrics].map(([key,m])=>{
    m.recent=(m.recent||[]).filter(x=>now-x.at<60000);
    return [key,{attempts:m.attempts,successes:m.successes,failures:m.failures,inFlight:m.inFlight,lastElapsedMs:m.lastElapsedMs,requestsLastMinute:m.recent.length,bytesLastMinute:m.recent.reduce((n,x)=>n+Number(x.bytes||0),0),bytesTotal:m.bytesTotal||0}];
  }));
}

// Astek has one upstream quota. LIVE is latency-sensitive: a score/market
// update must never sit behind the long prematch sweep. Detail requests remain
// last so opening dialogs cannot make the core feeds stale.
let astekActive = false;
let astekActiveKind = '';
let astekActiveStartedAt = 0;
const astekQueue = [];
const ASTEK_QUEUE_LIMIT = 300;
// Lower number wins. LIVE deliberately outranks prematch.
const priority = { live: 0, prematch: 1, detail: 2, results: 3 };
function astekGateTimeout(kind){
  if(kind==='live')return config.astekGateLiveTimeoutMs;
  if(kind==='prematch')return config.astekGatePrematchTimeoutMs;
  if(kind==='detail')return config.astekGateDetailTimeoutMs;
  if(kind==='results')return config.astekGateResultsTimeoutMs;
  return Math.max(5000,Math.min(config.requestTimeoutMs+1500,30000));
}
function runAstekJob(job){
  const controller=new AbortController();
  const timeoutMs=astekGateTimeout(job.kind);
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      const error=Object.assign(new Error(`AstekBet ${job.kind}: gate timeout ${timeoutMs} ms`),{status:504,code:'ASTEK_GATE_TIMEOUT'});
      try{controller.abort(error);}catch{}
      reject(error);
    },timeoutMs);
  });
  return Promise.race([Promise.resolve().then(()=>job.task(controller.signal)),timeout]).finally(()=>clearTimeout(timer));
}
function drainAstekQueue(){
  if(astekActive||!astekQueue.length)return;
  let index=0;
  for(let i=1;i<astekQueue.length;i++)if((priority[astekQueue[i].kind]??9)<(priority[astekQueue[index].kind]??9))index=i;
  const job=astekQueue.splice(index,1)[0];
  forensic('astek','queue_complete',{operation:job.kind+':gate-wait',durationMs:Date.now()-job.queuedAt,queued:astekQueue.length});
  astekActive=true;astekActiveKind=job.kind;astekActiveStartedAt=Date.now();
  runAstekJob(job).then(job.resolve,job.reject).finally(()=>{astekActive=false;astekActiveKind='';astekActiveStartedAt=0;drainAstekQueue();});
}
export function withAstekRequest(kind,task){
  return new Promise((resolve,reject)=>{
    if(kind==='detail'&&astekQueue.length>=ASTEK_QUEUE_LIMIT)return reject(Object.assign(new Error('Очередь AstekBet перегружена'),{status:503}));
    forensic('astek','queue_start',{operation:kind+':gate-wait',queued:astekQueue.length});astekQueue.push({kind,task,resolve,reject,queuedAt:Date.now()});
    drainAstekQueue();
  });
}
export function astekRequestStatus(){
  let prematchWaiting=0;const byKind={};
  for(const job of astekQueue){if(job.kind==='prematch')prematchWaiting++;byKind[job.kind]=(byKind[job.kind]||0)+1;}
  return {active:astekActive,activeKind:astekActiveKind,activeForMs:astekActiveStartedAt?Math.max(0,Date.now()-astekActiveStartedAt):0,queued:astekQueue.length,prematchWaiting,oldestWaitMs:astekQueue.length?Math.max(0,Date.now()-Math.min(...astekQueue.map(j=>j.queuedAt))):0,byKind};
}
export async function responseTextLimited(response,maxBytes){
  const declared=Number(response.headers?.get?.('content-length')||0);
  if(declared>maxBytes)throw Object.assign(new Error(`Ответ слишком большой: ${declared} байт`),{status:response.status});
  if(!response.body||typeof response.body[Symbol.asyncIterator]!=='function'){const text=await response.text();if(Buffer.byteLength(text)>maxBytes)throw Object.assign(new Error('Ответ слишком большой'),{status:response.status});return text;}
  const chunks=[];let size=0;for await(const chunk of response.body){const b=Buffer.from(chunk);size+=b.length;if(size>maxBytes)throw Object.assign(new Error(`Ответ превышает лимит ${maxBytes} байт`),{status:response.status});chunks.push(b);}
  return Buffer.concat(chunks,size).toString('utf8');
}

export async function fetchJson(url, referer, options = {}) {
  const group=options.metricGroup||(/result/i.test(url)?(/\/results\/v2\//i.test(url)?'fonbetResults':/\/champs(?:\?|$)/.test(url)?'astekResultsCatalog':'astekResultsGames'):/LiveFeed/i.test(url)?'astekLive':/LineFeed/i.test(url)?'astekPrematch':'fonbetFeed');
  const provider=/^astek/i.test(group)?'astek':/^fonbet/i.test(group)?'fonbet':/^pinnacle/i.test(group)?'pinnacle':null;
  const operation=options.forensicOperation||group, operationId=forensicSpan(provider,operation,'upstream_request'); let transportDone=false;
  const metric=upstreamMetrics.get(group)||{attempts:0,successes:0,failures:0,inFlight:0,recent:[],bytesTotal:0};upstreamMetrics.set(group,metric);
  metric.attempts++;metric.inFlight++;metric.recent=(metric.recent||[]).filter(x=>Date.now()-x.at<60000);metric.recent.push({at:Date.now(),bytes:0});
  const controller = new AbortController();
  const externalSignal=options.signal;
  const onExternalAbort=()=>{try{controller.abort(externalSignal?.reason);}catch{controller.abort();}};
  if(externalSignal?.aborted)onExternalAbort();else externalSignal?.addEventListener?.('abort',onExternalAbort,{once:true});
  const timeoutMs = Number(options.timeoutMs) >= 0 ? Number(options.timeoutMs) : config.requestTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": referer,
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",...options.headers
      }
    });

    forensic(provider,'upstream_response_received',{operation,httpStatus:response.status,durationMs:Date.now()-started});
    const text = await responseTextLimited(response, Number(options.maxBytes)||config.upstreamMaxBytes);
    const elapsedMs = Date.now() - started;
    forensic(provider,'payload_received',{operation,httpStatus:response.status,payloadBytes:Buffer.byteLength(text),durationMs:elapsedMs});
    operationId({result:response.ok?'ok':'error',httpStatus:response.status,payloadBytes:Buffer.byteLength(text)});transportDone=true;

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      const retryAfter = response.headers.get('retry-after');
      error.retryAfterMs = retryAfter ? (Number(retryAfter) * 1000 || Math.max(0, Date.parse(retryAfter) - Date.now())) : 0;
      error.elapsedMs = elapsedMs;
      error.bodyPreview = text.slice(0, 180);
      throw error;
    }

    let payload; const decode=forensicSpan(provider,operation+':json-decode');
    try {
      payload = JSON.parse(text);
      decode({payloadBytes:Buffer.byteLength(text),providerVersion:payload?.packetVersion??payload?.version??null});
    } catch {
      decode({result:'error',errorCategory:'parse'});
      const error = new Error("Ответ не является JSON");
      error.status = response.status;
      error.elapsedMs = elapsedMs;
      error.bodyPreview = text.slice(0, 180);
      throw error;
    }

    const requireSuccess = options.requireSuccess !== false;
    if (!payload || (requireSuccess && payload.Success === false)) {
      const error = new Error(clean(payload?.Error) || "API Success=false");
      error.status = response.status;
      error.elapsedMs = elapsedMs;
      throw error;
    }

    const bytes=Buffer.byteLength(text);metric.successes++;metric.bytesTotal=(metric.bytesTotal||0)+bytes;if(metric.recent?.length)metric.recent[metric.recent.length-1].bytes=bytes;
    return { payload, status: response.status, elapsedMs:Date.now()-started, bytes, fingerprint:createHash("sha1").update(text).digest("hex") };
  } catch(error){if(!transportDone)operationId(errorFields(error));metric.failures++;error.elapsedMs=Date.now()-started;throw error;} finally {
    metric.inFlight--;metric.lastElapsedMs=Date.now()-started;
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort',onExternalAbort);
  }
}

// "ok" | "low" | "critical" | "unknown". /health reports it and a throttled log
// line warns before the 10 GB disk fills up (a full disk corrupts nothing in
// SQLite/WAL but stops every write).
export function diskLevel(freeMiB){
  if(!Number.isFinite(freeMiB))return 'unknown';
  return freeMiB<config.diskCriticalFreeMiB?'critical':freeMiB<config.diskWarnFreeMiB?'low':'ok';
}
let lastDiskWarnAt=0;
function warnDisk(level,freeMiB){
  const now=Date.now();if(level==='ok'||level==='unknown'||now-lastDiskWarnAt<3600000)return;
  lastDiskWarnAt=now;log.warn(`[storage] disk space ${level}: ${freeMiB} MiB free in ${config.dataDir}. Consider ODDS_RETENTION_DAYS / STATISTICS_RETENTION_DAYS and removing old backups/images.`);
}
export async function storageStatus(){
  try{const stat=await fs.statfs(config.dataDir);const block=Number(stat.bsize||stat.frsize||4096);const freeMiB=Math.round(Number(stat.bavail||0)*block/1048576),level=diskLevel(freeMiB);warnDisk(level,freeMiB);return {freeMiB,totalMiB:Math.round(Number(stat.blocks||0)*block/1048576),diskLevel:level,pendingWrites:pendingWrites.size,...sqliteMetrics({checkIntegrity:false})};}
  catch{return {freeMiB:null,totalMiB:null,diskLevel:'unknown',pendingWrites:pendingWrites.size,...sqliteMetrics({checkIntegrity:false})};}
}

export async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const results = [];
  let failure;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length && !failure) {
      const item = queue.shift();
      if (item === undefined) return;
      try { results.push(await worker(item)); }
      catch (error) { failure ||= error; }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}

export function pruneHistory(history, now = Date.now()) {
  const cutoff = now - config.historyTtlMs;
  const filtered = (Array.isArray(history) ? history : [])
    .filter((item) => Number(item?.firstSeenAt || 0) >= cutoff)
    .sort((a, b) => Number(b.firstSeenAt || 0) - Number(a.firstSeenAt || 0));
  return filtered.slice(0, config.historyMax);
}
