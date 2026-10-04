import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { PROVIDERS, hourStart } from './collector-forensics.js';

const duration = value => { const m = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(String(value)); if (!m) throw Error('Duration must use s/m/h/d, e.g. 5m'); return +m[1] * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]]; };
function parts(at, zone) { return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at).filter(x => x.type !== 'literal').map(x => [x.type, x.value])); }
export function resolveTime(value, { now = Date.now(), zone = 'Europe/Amsterdam' } = {}) {
  if (/(?:Z|[+-]\d\d:?\d\d)$/i.test(value)) { const ms = Date.parse(value); if (!Number.isFinite(ms)) throw Error('Invalid absolute timestamp'); return ms; }
  const today = parts(now, zone), normalized = /^\d\d:\d\d(?::\d\d)?$/.test(value) ? `${today.year}-${today.month}-${today.day} ${value}` : value;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(normalized);
  if (!m) throw Error('Use YYYY-MM-DD HH:mm, HH:mm, or an ISO timestamp with Z/offset');
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)); let candidate = wall;
  for (let i = 0; i < 4; i++) { const p = parts(candidate, zone); candidate += wall - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second); }
  const expected = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`, rendered = t => { const p = parts(t, zone); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; };
  if (rendered(candidate) !== expected) throw Error('Nonexistent local time; provide an explicit UTC offset');
  if ([candidate - 3600000, candidate + 3600000].some(t => rendered(t) === expected)) throw Error('Ambiguous daylight-saving time; provide an explicit UTC offset');
  return candidate;
}
export function queryOptions(args, now = Date.now()) {
  const values = {}, flags = new Set();
  for (let i = 0; i < args.length; i++) { const key = args[i]; if (['--json', '--help'].includes(key)) flags.add(key); else if (['--dir', '--since', '--from', '--to', '--at', '--window', '--provider', '--timezone'].includes(key)) { if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('Missing value for ' + key); values[key.slice(2)] = args[++i]; } else throw Error('Unknown argument ' + key); }
  const zone = values.timezone || process.env.FORENSIC_TIMEZONE || 'Europe/Amsterdam'; parts(now, zone);
  if (values.provider && !PROVIDERS.includes(values.provider)) throw Error('Provider must be ' + PROVIDERS.join(', '));
  if ([values.at, values.since, values.from].filter(Boolean).length > 1) throw Error('Choose --at, --since or --from');
  const at = values.at ? resolveTime(values.at, { now, zone }) : null, window = duration(values.window || '5m');
  const from = at !== null ? at - window : values.from ? resolveTime(values.from, { now, zone }) : now - duration(values.since || '30m');
  const to = at !== null ? at + window : values.to ? resolveTime(values.to, { now, zone }) : now;
  if (to < from || to - from > 14 * 86400000) throw Error('Window must be ordered and at most 14 days');
  return { dir: values.dir || process.env.COLLECTOR_FORENSICS_DIR || path.join(process.env.DATA_DIR || '/var/lib/esports-monitor/data', 'collector-forensics'), from, to, at, zone, provider: values.provider || null, json: flags.has('--json'), help: flags.has('--help') };
}
async function filesForWindow({ dir, from, to, provider }) {
  const files = [];
  // Hour partitions are the time index; inspect only matching hours, never unrelated payload/log contents.
  for (const folder of ['system', ...(provider ? [provider] : PROVIDERS).map(p => 'providers/' + p)]) for (const name of await fs.readdir(path.join(dir, folder)).catch(() => [])) {
    const at = hourStart(name); if (/\.ndjson(?:\.gz)?$/.test(name) && at <= to && at + 3600000 > from) files.push(path.join(dir, folder, name));
  }
  return files.sort((a,b)=>{const aa=a.replace(/-\d+\.ndjson(?:\.gz)?$/,''),bb=b.replace(/-\d+\.ndjson(?:\.gz)?$/,'');return aa.localeCompare(bb)||Number(/-(\d+)\.ndjson/.exec(a)?.[1]||0)-Number(/-(\d+)\.ndjson/.exec(b)?.[1]||0);});
}
export async function *queryRecords(options) {
  for (const file of await filesForWindow(options)) {
    const input = createReadStream(file); const stream = file.endsWith('.gz') ? input.pipe(createGunzip()) : input;
    input.on('error', e => stream.destroy(e));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const line of lines) { let row; try { row = JSON.parse(line); } catch { continue; } const at = Date.parse(row.timestamp); if (at >= options.from && at <= options.to) yield row; } }
    finally { lines.close(); stream.destroy(); input.destroy(); }
  }
}
export async function queryIncidents({ dir, from = -Infinity, to = Infinity, provider, includeContext = true }) {
  const rows = [];
  for (const name of await fs.readdir(path.join(dir, 'incidents')).catch(() => [])) if (name.endsWith('.json')) try { const row = JSON.parse(await fs.readFile(path.join(dir, 'incidents', name), 'utf8')); if ((!provider || row.provider === provider) && Date.parse(row.startedAt) <= to && (!row.recoveredAt || Date.parse(row.recoveredAt) >= from)) {if(!includeContext){row.contextReference={file:path.join(dir,'incidents',name),telemetryRecords:row.contextTelemetry?.length||0,phaseRecords:row.recentPhases?.length||0};delete row.contextTelemetry;delete row.recentPhases;}rows.push(row);} } catch {}
  return rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
export async function forensicReport(options) {
  const providers = Object.fromEntries((options.provider ? [options.provider] : PROVIDERS).map(p => [p, { records: 0, phases: {}, errors: 0, states: {}, lastReceive: null, lastParse: null, lastPublish: null, largestDelays: [], timeline: [], heartbeats: 0, heartbeatTimes: [], stageTimeline: [], maxHeartbeatGapMs: 0 }]));
  const system = { samples: 0, max: {}, latest: null }, evidence = [], pending = new Map();let pendingTruncated=false;
  let count = 0;
  for await (const row of queryRecords(options)) {
    count++;
    if (row.provider === 'system') {
      if (row.phase === 'telemetry') { system.samples++; if (!system.latest || row.timestamp > system.latest.timestamp) system.latest = row; for (const field of ['rssMiB', 'heapUsedMiB', 'cpuPercent', 'eventLoopMaxMs', 'swapUsedMiB', 'sqliteWalBytes']) if (Number.isFinite(row[field])) system.max[field] = Math.max(system.max[field] || 0, row[field]); if (Number.isFinite(row.memAvailableMiB)) system.minMemAvailableMiB = Math.min(system.minMemAvailableMiB ?? Infinity, row.memAvailableMiB); }
      continue;
    }
    const p = providers[row.provider]; if (!p) continue;
    p.records++; p.phases[row.phase] = (p.phases[row.phase] || 0) + 1; if (row.result === 'error') p.errors++;
    const last = field => { if (!p[field] || row.timestamp > p[field]) p[field] = row.timestamp; };
    if (['payload_received', 'ws_frame_received'].includes(row.phase)) last('lastReceive');
    if (row.phase === 'parse_complete' && row.result === 'ok') last('lastParse');
    if (row.phase === 'publish_complete' && row.result === 'ok') last('lastPublish');
    if (row.operationId) { const key = row.provider + ':' + row.operationId + ':' + row.phase.replace(/_(?:start|complete)$/, ''); if(row.phase.endsWith('_start')){if(pending.size<5000)pending.set(key,row);else pendingTruncated=true;}if(row.phase.endsWith('_complete'))pending.delete(key); }
    if(['upstream_request_start','upstream_response_received','payload_received','ws_frame_received','parse_start','parse_complete','state_start','state_complete','state_update','publish_start','publish_complete'].includes(row.phase)){p.stageTimeline.push(row);if(p.stageTimeline.length>100)p.stageTimeline.shift();}
    if (row.durationMs > 100) { p.largestDelays.push({ timestamp: row.timestamp, phase: row.phase, operation: row.operation, durationMs: row.durationMs, payloadBytes: row.payloadBytes ?? null, result: row.result }); p.largestDelays.sort((a, b) => b.durationMs - a.durationMs); p.largestDelays = p.largestDelays.slice(0, 10); }
    if (row.phase === 'heartbeat') { p.heartbeats++;p.heartbeatTimes.push(Date.parse(row.timestamp)); p.states[row.collectorState] = (p.states[row.collectorState] || 0) + 1; if (p.lastHeartbeatAt) p.maxHeartbeatGapMs = Math.max(p.maxHeartbeatGapMs, Date.parse(row.timestamp) - Date.parse(p.lastHeartbeatAt)); p.lastHeartbeatAt = row.timestamp; if (!p.latest || row.timestamp > p.latest.timestamp) p.latest = row; }
    if (['heartbeat', 'incident_start', 'recovery', 'disconnect', 'reconnect', 'retry', 'full_resync'].includes(row.phase) || row.result === 'error' || row.durationMs > 1000) { if (p.timeline.length < 500) p.timeline.push(row); else p.timelineTruncated = true; }
  }
  for (const [provider, p] of Object.entries(providers)) {
    p.heartbeatTimes.sort((a,b)=>a-b);for(let i=1;i<p.heartbeatTimes.length;i++)p.maxHeartbeatGapMs=Math.max(p.maxHeartbeatGapMs,p.heartbeatTimes[i]-p.heartbeatTimes[i-1]);delete p.heartbeatTimes;p.timeline.sort((a,b)=>a.timestamp.localeCompare(b.timestamp));p.stageTimeline.sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
    p.observed = p.records ? `${p.records} records; ${p.heartbeats} heartbeats; ${p.errors} errors` : 'NO DATA';
    p.supported = p.largestDelays.map(r => `${r.timestamp}: ${r.operation}/${r.phase} measured ${r.durationMs} ms; payload bytes=${r.payloadBytes??'unknown'}`);
    p.plausible = p.states.STALE || p.states.DEGRADED || p.states.DISCONNECTED ? ['Inspect measured stage delays and contemporaneous system telemetry; root cause is not inferred from status alone.'] : [];
    p.unknown = ['Remote bookmaker behavior, client receipt/rendering and GC cause are not proven by server enqueue telemetry.'];
    if (!p.heartbeats || p.maxHeartbeatGapMs > 45000) p.unknown.push('Missing heartbeat coverage: distinguish collector outage from logger/process outage.');
    if (p.heartbeats && Object.keys(p.states).every(s => /^HEALTHY_/.test(s))) evidence.push(`${provider}: healthy at all recorded heartbeats; gaps do not prove uninterrupted health`);
    p.pendingOperations=[...pending.values()].filter(r=>r.provider===provider);if(pendingTruncated)p.unknown.push('Pending-operation index was bounded/truncated at5000 entries.');
  }
  const incidents = await queryIncidents({...options,includeContext:false}), logger = await fs.readFile(path.join(options.dir, 'logger-state.json'), 'utf8').then(JSON.parse).catch(() => null);
  return { schemaVersion: 1, window: { fromUTC: new Date(options.from).toISOString(), toUTC: new Date(options.to).toISOString(), resolvedAtUTC: options.at === null ? null : new Date(options.at).toISOString(), inputTimezone: options.zone, localTimeInterpretation: 'Date-less HH:mm resolves to today in inputTimezone; ambiguous DST requires explicit offset.' }, recordCount: count, providers, system, incidents, notAffectedEvidence: evidence, loggerCurrent: logger, rootCause: { observed: 'See measured provider stages and incident transitions.', supportedCause: 'Only directly measured delays/errors are supported; no automatic causal attribution.', plausible: system.max.eventLoopMaxMs > 250 ? ['Host event-loop pressure may contribute; temporal overlap alone is not causality.'] : [], unknown: ['No GC traces or remote server instrumentation; no client delivery acknowledgements.'] } };
}
export function formatReport(report) {
  const lines = [`TIME WINDOW ${report.window.fromUTC} – ${report.window.toUTC}`, `Input timezone: ${report.window.inputTimezone}; resolved --at: ${report.window.resolvedAtUTC || 'n/a'}`, `Records: ${report.recordCount}`];
  for (const [provider, p] of Object.entries(report.providers)) {
    lines.push('', provider.toUpperCase(), `OBSERVED: ${p.observed}`, `Receive: ${p.lastReceive || 'unknown'}; parse: ${p.lastParse || 'unknown'}; publish enqueue: ${p.lastPublish || 'unknown'}`, `States: ${JSON.stringify(p.states)}; latest ages receive/parse/publish ms: ${p.latest?.lastReceiveAgeMs??'?'} / ${p.latest?.lastParseAgeMs??'?'} / ${p.latest?.lastPublishAgeMs??'?'}`, ...(provider==='ggbet-browser'?[`Firefox PSS=${p.latest?.firefoxPssMiB??'?'} MiB; worker RSS=${p.latest?.workerRssMiB??'?'} MiB; pages=${p.latest?.pageCount??'?'}; VPN=${p.latest?.vpnState??'?'}; IPC=${p.latest?.transportState??'?'}`]:[]), ...p.supported.slice(0, 5).map(s => 'SUPPORTED: ' + s), ...p.plausible.map(s => 'PLAUSIBLE: ' + s), ...p.unknown.map(s => 'UNKNOWN: ' + s));
  }
  lines.push('', 'SYSTEM', JSON.stringify({ samples: report.system.samples, max: report.system.max, minMemAvailableMiB: report.system.minMemAvailableMiB }), '', 'INCIDENTS');
  for (const i of report.incidents) lines.push(`${i.incidentId} ${i.provider} ${i.state} ${i.startedAt} → ${i.recoveredAt || 'open'} (${i.durationMs ?? '?'} ms), related=${i.relatedIncidentIds?.join(',') || 'none'}, rootCause=${i.rootCause}`);
  if (!report.incidents.length) lines.push('No recorded incidents in window. Missing data does not establish health.');
  lines.push('', 'LOGGER CURRENT', JSON.stringify(report.loggerCurrent), '', 'UNKNOWN: SSE publish_complete means server enqueue, not extension receipt/rendering.');
  return lines.join('\n');
}
