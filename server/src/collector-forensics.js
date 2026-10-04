// Observe-only telemetry. No collector ever awaits a disk write through this module.
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { sanitize, registerSecret } from './ggbet-forensics.js';

export const FORENSIC_VERSION = 1;
export const PROVIDERS = ['astek', 'fonbet', 'pinnacle', 'ggbet-node', 'ggbet-browser'];
const HOUR = 3600000, MIB = 1048576;
const hourKey = at => new Date(at).toISOString().slice(0, 13).replace(/[-:]/g, '');
export const hourStart = name => { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})/.exec(name); return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:00:00Z`) : NaN; };
export const providerForState = name => name?.startsWith('fonbet') ? 'fonbet' : name?.startsWith('pinnacle') ? 'pinnacle' : name?.startsWith('ggbet') ? 'ggbet-node' : ['live', 'prematch'].includes(name) ? 'astek' : null;
export function safeTelemetry(value) {
  const clean = sanitize(value, { allow: [] });
  const walk = x => {
    if (typeof x === 'string') return x.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<redacted>@').replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>').replace(/\b(?:Cookie|Authorization|PrivateKey)\s*[:=][^\r\n]*/gi, '<redacted>');
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    return x;
  };
  return walk(clean);
}
export function errorFields(error) {
  const text = String(error?.message || error || '');
  return { result: 'error', errorCategory: error?.status === 429 ? 'rate-limit' : error?.status >= 500 ? 'upstream-5xx' : error?.status >= 400 ? 'upstream-4xx' : /timeout|abort/i.test(text) ? 'timeout' : /JSON|parse/i.test(text) ? 'parse' : /proxy|ECONN|ENOTFOUND|socket|network/i.test(text) ? 'transport' : 'collector', httpStatus: Number(error?.status) || null, errorCode: String(error?.code || '').slice(0, 50) || null };
}
export function eventCounts(events = []) {
  let markets = 0, outcomes = 0;
  if(!Array.isArray(events))return {eventCount:0,marketCount:0,outcomeCount:0};
  for(const e of events){const tree=e?.odds?.markets??e?.markets;if(!Array.isArray(tree))continue;for(const m of tree){markets++;const prices=m?.prices??m?.odds;outcomes+=Array.isArray(prices)?prices.length:0;}}
  return { eventCount: events.length, marketCount: markets, outcomeCount: outcomes };
}
let active = null;
export function setCollectorForensics(logger) { active = logger; }
export function forensic(provider, phase, details = {}) { try { return active?.record(provider, phase, details); } catch { return false; } }
export function forensicSpan(provider, operation, phase = 'parse') {
  const started = performance.now();let operationId=null;try{operationId=active?.nextOperation?.()??null;}catch{}
  forensic(provider, phase + '_start', { operation, operationId });
  return (details = {}) => forensic(provider, phase + '_complete', { operation, operationId, durationMs: +(performance.now() - started).toFixed(3), ...details });
}

export class CollectorForensics {
  constructor({ dir, now = Date.now, retentionMs = 72 * HOUR, incidentRetentionMs = 14 * 24 * HOUR, maxBytes = 1024 * MIB, minFreeMiB = 4096, segmentBytes = 16 * MIB, queueBytes = 2 * MIB, flushMs = 250, heartbeatMs = 15000, statfs = p => fs.statfs(p), append = (p, data) => fs.appendFile(p, data, { mode: 0o600 }) } = {}) {
    Object.assign(this, { dir, now, retentionMs, incidentRetentionMs, maxBytes, minFreeMiB, segmentBytes, queueLimit: queueBytes, flushMs, heartbeatMs, statfs, append });
    this.instance = `${process.pid}-${randomUUID()}`; this.seq = 0; this.operations = 0; this.queue = []; this.queueBytes = 0; this.files = new Map(); this.current = new Map(); this.providers = new Map(); this.readers = new Map(); this.incidents = new Map(); this.context = [];this.contextBytes=0;this.recordSizes=new WeakMap();this.recentPhaseBytes=new Map(); this.recentPhases = new Map(); this.stopped = false;
    this.io = Promise.resolve(); this.startedAt = this.now();
    this.stats = { recordsWritten: 0, recordsDropped: 0, writeErrors: 0, bytesWritten: 0, hookCalls: 0, hookTimeMs: 0, diskUsageBytes: 0, diskFreeMiB: null, retentionState: 'starting', maxQueueBytes: 0 };
    for (const [key, value] of Object.entries(process.env)) {
      if (/TOKEN|PASSWORD|SECRET|PRIVATE.?KEY|AUTH|CREDENTIAL/i.test(key)) registerSecret(value);
      if (/PROXY.*URL/i.test(key)) try { const u = new URL(value); registerSecret(decodeURIComponent(u.username)); registerSecret(decodeURIComponent(u.password)); } catch {}
    }
    this.ready = this.initialize().catch(() => { this.stats.writeErrors++; this.stats.retentionState = 'unavailable'; });
  }
  withIO(fn) { const pending=this.io.then(fn,fn);this.io=pending.catch(()=>{});return pending; }
  nextOperation() { return `${this.instance}:${++this.operations}`; }
  async initialize() {
    for (const d of [this.dir, ...PROVIDERS.map(p => path.join(this.dir, 'providers', p)), ...['system', 'incidents', 'indexes'].map(p => path.join(this.dir, p))]) await fs.mkdir(d, { recursive: true, mode: 0o700 });
    await this.maintain();
    // Continue incidents across process restarts instead of silently losing open outages.
    for (const f of await fs.readdir(path.join(this.dir, 'incidents'))) if (f.endsWith('.json')) try {
      const i = JSON.parse(await fs.readFile(path.join(this.dir, 'incidents', f), 'utf8'));
      if (i.state === 'OPEN' && PROVIDERS.includes(i.provider)) this.incidents.set(i.provider, i);
    } catch {}
  }
  register(provider, read) { if (PROVIDERS.includes(provider)) this.readers.set(provider, read); }
  record(provider, phase, details = {}) {
    const hookStarted=performance.now();
    if (this.stopped || (!PROVIDERS.includes(provider) && provider !== 'system')) return false;
    try {
      const at = this.now(), p = this.providers.get(provider) || { errorCount: 0, reconnectCount: 0, retryCount: 0 };
      const record = safeTelemetry({ ...details, schemaVersion: FORENSIC_VERSION, timestamp: new Date(at).toISOString(), monotonicMs: +performance.now().toFixed(3), instance: this.instance, sequence: ++this.seq, provider, phase, operation: details.operation || phase, result: details.result || 'ok', durationMs: details.durationMs ?? null, errorCategory: details.errorCategory ?? null, httpStatus: details.httpStatus ?? null,
        eventCount:details.eventCount??p.eventCount??null, marketCount:details.marketCount??p.marketCount??null, outcomeCount:details.outcomeCount??p.outcomeCount??null, providerVersion:details.providerVersion??null,lastProviderVersion:p.providerVersion??null, providerTimestamp:details.providerTimestamp??null, connectionState:details.connectionState??details.transportState??p.connectionState??null,retryCount:details.retryCount??p.retryCount??0,reconnectCount:details.reconnectCount??p.reconnectCount??0,
        lastUpstreamAgeMs:details.upstreamAgeMs??(p.receiveAt?at-p.receiveAt:null),lastReceiveAgeMs: p.receiveAt ? at - p.receiveAt : null, lastParseAgeMs: p.parseAt ? at - p.parseAt : null, lastPublishAgeMs: p.publishAt ? at - p.publishAt : null });
      const line = JSON.stringify(record) + '\n', bytes = Buffer.byteLength(line);
      if (phase === 'payload_received' || phase === 'ws_frame_received') p.receiveAt = at;
      if (phase === 'parse_complete' && record.result === 'ok') p.parseAt = at;
      if (phase === 'state_update') { p.stateAt = at; if (details.changed) p.changedAt = at; }
      if (phase === 'publish_complete' && record.result === 'ok') p.publishAt = at;
      if (record.result === 'error') p.errorCount++;
      if (phase === 'retry') p.retryCount++;
      if (phase === 'reconnect') p.reconnectCount++;
      for(const key of ['eventCount','marketCount','outcomeCount','providerVersion','connectionState'])if(record[key]!=null)p[key]=record[key];
      this.providers.set(provider, p);
      if(bytes>32768){this.stats.recordsDropped++;return false;}this.recordSizes.set(record,bytes);
      if(phase==='heartbeat'||phase==='telemetry'){this.context.push(record);this.contextBytes+=bytes;while(this.context.length&&(Date.parse(this.context[0].timestamp)<at-10*60000||this.contextBytes>1048576||this.context.length>4000))this.contextBytes-=this.recordSizes.get(this.context.shift())||0;}
      else if(provider!=='system'){const rows=this.recentPhases.get(provider)||[];let used=(this.recentPhaseBytes.get(provider)||0)+bytes;rows.push(record);while(rows.length&&(rows.length>200||used>262144))used-=this.recordSizes.get(rows.shift())||0;this.recentPhases.set(provider,rows);this.recentPhaseBytes.set(provider,used);}
      if (bytes > 32768 || this.queueBytes + bytes > this.queueLimit || this.queue.length >= 5000) { this.stats.recordsDropped++; return false; }
      this.queue.push({ record, line, bytes }); this.queueBytes += bytes; this.stats.maxQueueBytes = Math.max(this.stats.maxQueueBytes, this.queueBytes);
      if (!this.flushTimer && !this.flushing) { this.flushTimer = setTimeout(() => this.flush(), this.flushMs); this.flushTimer.unref?.(); }
      return true;
    } catch { this.stats.recordsDropped++; return false; }
    finally{this.stats.hookCalls++;this.stats.hookTimeMs+=performance.now()-hookStarted;}
  }
  status() { return { schemaVersion: FORENSIC_VERSION, updatedAt:new Date(this.now()).toISOString(),instance: this.instance, ...this.stats, queueDepth: this.queue.length, queueBytes: this.queueBytes,contextBytes:this.contextBytes,recentPhaseBytes:Object.fromEntries(this.recentPhaseBytes), currentFileBytes: Object.fromEntries([...this.current].map(([p, f]) => [p, f.bytes])), retentionHours: this.retentionMs / HOUR, incidentRetentionDays: this.incidentRetentionMs / (24 * HOUR), maxBytes: this.maxBytes, minFreeMiB: this.minFreeMiB }; }
  async flush() {
    clearTimeout(this.flushTimer); this.flushTimer = null;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      await this.ready;
      await this.withIO(async()=>{
      const batch = this.queue.splice(0); this.queueBytes = 0;
      try{const disk=await this.statfs(this.dir);this.stats.diskFreeMiB=Number(disk.bavail)*Number(disk.bsize)/MIB;if(this.stats.diskFreeMiB<this.minFreeMiB)this.stats.retentionState='low-free-space';else if(this.stats.retentionState==='low-free-space')this.stats.retentionState='ok';}catch{this.stats.retentionState='unavailable';}
      if (['low-free-space', 'unavailable'].includes(this.stats.retentionState)) { this.stats.recordsDropped += batch.length; return; }
      // Limit one append to a bounded batch. Rotation also bounds the active file.
      const groups = new Map();
      for (const row of batch) { const key = row.record.provider + '/' + hourKey(Date.parse(row.record.timestamp)); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
      for (const [key, rows] of groups) {
        const [provider, hour] = key.split('/'), data = rows.map(r => r.line).join(''), bytes = Buffer.byteLength(data);
        if (this.stats.diskUsageBytes + bytes > this.maxBytes || this.stats.diskFreeMiB-bytes/MIB<this.minFreeMiB) { this.stats.recordsDropped += rows.length; this.stats.retentionState = 'disk-cap'; continue; }
        let file = this.current.get(provider);
        if (!file || file.hour !== hour || file.bytes + bytes > this.segmentBytes) {
          const folder = provider === 'system' ? path.join(this.dir, 'system') : path.join(this.dir, 'providers', provider);
          file = { path: path.join(folder, `${hour}-${this.instance}-${rows[0].record.sequence}.ndjson`), hour, bytes: 0, start: hourStart(hour), provider }; this.current.set(provider, file);
        }
        try { await this.append(file.path, data); file.bytes += bytes; this.files.set(file.path, file); this.stats.recordsWritten += rows.length; this.stats.bytesWritten += bytes; this.stats.diskUsageBytes += bytes;this.stats.diskFreeMiB-=bytes/MIB; }
        catch { this.stats.writeErrors++; this.stats.recordsDropped += rows.length;const stat=await fs.stat(file.path).catch(()=>null);if(stat){this.stats.diskUsageBytes+=Math.max(0,stat.size-file.bytes);file.bytes=stat.size;} }
      }
      });
    })().catch(() => { this.stats.writeErrors++; }).finally(() => { this.flushing = null; if (this.queue.length && !this.stopped) { this.flushTimer = setTimeout(() => this.flush(), this.flushMs); this.flushTimer.unref?.(); } });
    return this.flushing;
  }
  async saveIncident(i) {
    const snapshot=safeTelemetry(i);await this.ready;return this.withIO(()=>this.saveJSON(path.join(this.dir,'incidents',`incident-${snapshot.incidentId}.json`),JSON.stringify(snapshot)));
  }
  async saveJSON(file,data) {
    if (['low-free-space', 'unavailable'].includes(this.stats.retentionState)) { this.stats.writeErrors++; return; }
    const bytes=Buffer.byteLength(data);
    if(this.stats.diskUsageBytes+bytes>this.maxBytes || (this.stats.diskFreeMiB!=null&&this.stats.diskFreeMiB-bytes/MIB<this.minFreeMiB)){this.stats.recordsDropped++;return;}
    try{const prev=await fs.stat(file).catch(()=>({size:0}));await fs.writeFile(file+'.tmp',data,{mode:0o600});await fs.rename(file+'.tmp',file);this.stats.diskUsageBytes+=bytes-prev.size;this.stats.diskFreeMiB-=(bytes-prev.size)/MIB;}catch{this.stats.writeErrors++;await fs.unlink(file+'.tmp').catch(()=>{});}
  }

  heartbeat(provider, snapshot = {}) {
    if (!PROVIDERS.includes(provider)) return;
    const at = this.now(), p = this.providers.get(provider) || {}, state = snapshot.collectorState || 'DEGRADED', healthy = /^HEALTHY_/.test(state);
    this.record(provider, 'heartbeat', { ...snapshot, errorCount: p.errorCount || 0, retryCount: p.retryCount || 0, reconnectCount: snapshot.reconnectCount ?? p.reconnectCount ?? 0, freshnessState: state });
    let i = this.incidents.get(provider);
    if (!healthy && ((!i && (p.healthyAt || at-this.startedAt>=30000)) || (i && state!==p.healthState))) {
      if (!i) {
        i = { incidentId: `${new Date(at).toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`, provider, instance: this.instance, startedAt: new Date(at).toISOString(), detectedAt: new Date(at).toISOString(), previousHealthyAt: p.healthyAt ? new Date(p.healthyAt).toISOString() : null, symptom: state, state: 'OPEN', transitions: [], relatedIncidentIds: [], contextTelemetry: this.context.slice(), recentPhases: (this.recentPhases.get(provider) || []).slice(), rootCause: 'UNKNOWN' };
        for (const other of this.incidents.values()) if (Math.abs(at - Date.parse(other.detectedAt)) <= 30000) { i.relatedIncidentIds.push(other.incidentId); other.relatedIncidentIds.push(i.incidentId); this.saveIncident(other).catch(() => {}); }
        this.incidents.set(provider, i);
        this.record(provider, 'incident_start', { incidentId: i.incidentId, symptom: state, relatedIncidentIds: i.relatedIncidentIds });
      }
      i.transitionCount=(i.transitionCount||0)+1;if(i.transitions.length>=500)i.transitions.shift();i.transitions.push({ timestamp: new Date(at).toISOString(), previousState: p.healthState || 'UNKNOWN', state });
      i.lastEvidence = safeTelemetry(snapshot); this.saveIncident(i).catch(() => {});
    }
    if (healthy) {
      p.healthyAt = at;
      if (i) {
        Object.assign(i, { state: 'RECOVERED', recoveredAt: new Date(at).toISOString(), durationMs: at - Date.parse(i.startedAt), recoveryMechanism: i.instance && i.instance !== this.instance ? 'collector-restart-observed' : snapshot.recoveryMechanism || 'healthy telemetry observed; mechanism unproven', recoveryEvidence: safeTelemetry(snapshot), retryCount: p.retryCount || 0, reconnectCount: snapshot.reconnectCount ?? p.reconnectCount ?? 0 });
        this.record(provider, 'recovery', { incidentId: i.incidentId, durationMs: i.durationMs, recoveryMechanism: i.recoveryMechanism }); this.saveIncident(i).catch(() => {}); this.incidents.delete(provider);
      }
    }
    p.healthState = state; this.providers.set(provider, { ...this.providers.get(provider), ...p });
  }
  async sample() {
    if (this.sampling) return;
    this.sampling = true;
    try {
      for (const [provider, read] of this.readers) try { this.heartbeat(provider, await read()); } catch (e) { this.heartbeat(provider, { collectorState: 'DEGRADED', ...errorFields(e) }); }
      const memory = process.memoryUsage(), usage = process.cpuUsage(), at = performance.now();
      const elapsed = this.cpuAt ? at - this.cpuAt : null, cpuPercent = elapsed ? (usage.user + usage.system - this.cpuUsage.user - this.cpuUsage.system) / (elapsed * 10) : null; this.cpuAt = at; this.cpuUsage = usage;
      const meminfo = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '');
      const kb = k => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] || 0);
      const wal = await fs.stat(path.join(path.dirname(this.dir), 'monitor-v2.sqlite3-wal')).catch(() => null);
      const network={};for(const line of (await fs.readFile('/proc/net/dev','utf8').catch(()=>'' )).split('\n')){const match=/^\s*([^:]+):\s*(.*)$/.exec(line);if(!match)continue;const n=match[2].trim().split(/\s+/).map(Number);network[match[1]]={rxBytes:n[0],rxErrors:n[2],rxDrops:n[3],txBytes:n[8],txErrors:n[10],txDrops:n[11]};}
      const pressure={};for(const kind of ['cpu','memory','io'])pressure[kind]=(await fs.readFile('/proc/pressure/'+kind,'utf8').catch(()=>'' )).trim()||null;
      this.record('system', 'telemetry', { network,pressure,rssMiB: memory.rss / MIB, heapUsedMiB: memory.heapUsed / MIB, heapTotalMiB: memory.heapTotal / MIB, cpuPercent, eventLoopDelayMs:this.loopHistogram?.count?this.loopHistogram.mean/1e6:0,eventLoopMaxMs:this.loopHistogram?.count?this.loopHistogram.max/1e6:0, loadAverage: (await fs.readFile('/proc/loadavg', 'utf8').catch(() => '')).split(' ').slice(0, 3).map(Number), memAvailableMiB: kb('MemAvailable') / 1024, swapUsedMiB: (kb('SwapTotal') - kb('SwapFree')) / 1024, sqliteWalBytes: wal?.size ?? null, logger: this.status() });
      this.loopHistogram?.reset();
    } finally { this.sampling = false; }
  }
  start() {
    this.loopHistogram=monitorEventLoopDelay({resolution:20});this.loopHistogram.enable();
    this.heartbeatTimer = setInterval(() => this.sample().catch(() => {}), this.heartbeatMs); this.heartbeatTimer.unref?.();
    this.maintenanceTimer = setInterval(() => this.maintain().catch(() => { this.stats.writeErrors++; }), 60000); this.maintenanceTimer.unref?.();
    this.record('system', 'session_start', { existingGgbetForensic: path.join(path.dirname(this.dir), 'ggbet-forensics'), heartbeatMs: this.heartbeatMs });
    this.sample().catch(() => {});
  }
  async maintain() {
    if(this.maintaining)return this.maintaining;
    const pending=this.withIO(()=>this.maintainNow());this.maintaining=pending.finally(()=>{this.maintaining=null;});return this.maintaining;
  }
  async maintainNow() {
    try {
      const at = this.now();this.stats.lastMaintenanceAt=new Date(at).toISOString();const directories = ['system', 'incidents', 'indexes', ...PROVIDERS.map(p => 'providers/' + p)], entries = [];
      for (const d of directories) {await fs.mkdir(path.join(this.dir,d),{recursive:true,mode:0o700});for (const name of await fs.readdir(path.join(this.dir, d))) { const file = path.join(this.dir, d, name), stat = await fs.stat(file); if (stat.isFile()) entries.push({ path: file, name, size: stat.size, start: hourStart(name), mtime: stat.mtimeMs, dir: d }); }}
      for(const name of await fs.readdir(this.dir))if(name.endsWith('.json')||name.endsWith('.tmp')){const file=path.join(this.dir,name),stat=await fs.stat(file);if(stat.isFile())entries.push({path:file,name,size:stat.size,start:NaN,mtime:stat.mtimeMs,dir:''});}
      let usage = entries.reduce((n, f) => n + f.size, 0);
      const current = new Set([...this.current.values()].map(f => f.path));
      const remove = async f => { await fs.unlink(f.path); usage -= f.size; this.files.delete(f.path); if (current.has(f.path)) for (const [p, v] of this.current) if (v.path === f.path) this.current.delete(p); };
      for (const f of entries) {
        const limit = f.dir === 'incidents' ? this.incidentRetentionMs : this.retentionMs;
        if ((Number.isFinite(f.start) ? f.start + HOUR : f.mtime) < at - limit) { await remove(f); f.deleted = true; }
      }
      // Emergency cap applies to all files, including the active hour and incidents. Disk safety wins over retention.
      for (const f of entries.filter(f => !f.deleted).sort((a, b) => a.mtime - b.mtime)) { if (usage < this.maxBytes * 0.9) break; await remove(f); f.deleted = true; }
      const stat = await this.statfs(this.dir); const freeMiB = Number(stat.bavail) * Number(stat.bsize) / MIB;
      this.stats.diskFreeMiB = freeMiB; this.stats.diskUsageBytes = usage; this.stats.retentionState = freeMiB < this.minFreeMiB ? 'low-free-space' : usage >= this.maxBytes ? 'disk-cap' : 'ok';
      if (this.stats.retentionState === 'ok') for (const f of entries) if (!f.deleted && f.name.endsWith('.ndjson') && !current.has(f.path) && f.start + HOUR < at && usage+f.size+65536<this.maxBytes && freeMiB*MIB-f.size-65536> this.minFreeMiB * MIB) {
        try { await pipeline(createReadStream(f.path), createGzip({ level: 1 }), createWriteStream(f.path + '.gz.tmp', { mode: 0o600 })); await fs.rename(f.path + '.gz.tmp', f.path + '.gz'); const compressed = await fs.stat(f.path + '.gz'); await fs.unlink(f.path); usage += compressed.size - f.size; f.path += '.gz'; f.size = compressed.size; }
        catch { this.stats.writeErrors++; await fs.unlink(f.path + '.gz.tmp').catch(() => {}); }
      }
      this.stats.diskUsageBytes = usage;
      if (this.stats.retentionState !== 'low-free-space') {
        const stateFile = path.join(this.dir, 'logger-state.json');await this.saveJSON(stateFile,JSON.stringify(this.status()));
        const hours = new Map(); for (const f of entries) if (!f.deleted && Number.isFinite(f.start) && !f.dir.startsWith('indexes')) { const key = hourKey(f.start); if (!hours.has(key)) hours.set(key, []); hours.get(key).push({ path: path.relative(this.dir, f.path), bytes: f.size, from: new Date(f.start).toISOString(), to: new Date(f.start + HOUR).toISOString() }); }
        for (const [hour, files] of hours) await this.saveJSON(path.join(this.dir,'indexes',hour+'.json'),JSON.stringify({schemaVersion:1,files}));
      }
    } catch { this.stats.writeErrors++; this.stats.retentionState = 'unavailable'; }

  }
  async stop() {
    this.loopHistogram?.disable(); clearInterval(this.heartbeatTimer); clearInterval(this.maintenanceTimer); clearTimeout(this.flushTimer); this.stopped = true;
    await this.flushing; await this.flush();await this.io; await this.maintain();
  }
}
