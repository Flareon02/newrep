import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { CollectorForensics, forensic, forensicSpan, setCollectorForensics, safeTelemetry, errorFields, eventCounts } from '../src/collector-forensics.js';
import { forensicReport, queryOptions, queryRecords, queryIncidents, resolveTime } from '../src/collector-forensic-query.js';
import { stateHeartbeat, browserHeartbeat } from '../src/collector-forensic-runtime.js';
import { registerSecret } from '../src/ggbet-forensics.js';

const base = Date.parse('2026-10-04T11:34:00Z');
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'collector-forensic-')); let at = base;
  const logger = new CollectorForensics({ dir, now: () => at, statfs: async () => ({ bavail: 1000000, bsize: 4096 }), minFreeMiB: 1, ...options });
  await logger.ready;
  t.after(async () => { setCollectorForensics(null); await logger.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { logger, dir, advance: ms => at += ms, options: () => ({ dir, from: base - 60000, to: at + 60000, at: base, zone: 'Europe/Amsterdam' }) };
}
const read = async f => { const out = []; for await (const row of queryRecords(f.options())) out.push(row); return out; };

test('five providers record UTC instance, sequence and real operation phases', async t => {
  const f = await fixture(t); setCollectorForensics(f.logger);
  for (const p of ['astek', 'fonbet', 'pinnacle', 'ggbet-node', 'ggbet-browser']) { forensic(p, 'payload_received', { payloadBytes: 42 }); const end = forensicSpan(p, 'decode'); end({ eventCount: 2 }); }
  forensic('databet', 'payload_received'); await f.logger.flush();
  const rows = await read(f); assert.equal(rows.length, 15); assert.equal(new Set(rows.map(r => r.provider)).size, 5); assert.ok(rows.every(r => r.timestamp.endsWith('Z') && r.instance && Number.isFinite(r.monotonicMs))); assert.equal(new Set(rows.map(r => r.sequence)).size, 15);
  const complete = rows.find(r => r.phase === 'parse_complete'); assert.equal(complete.result, 'ok'); assert.ok(complete.durationMs >= 0); assert.equal(complete.lastReceiveAgeMs, 0);
});
test('heartbeat is light and HEALTHY_QUIET creates no incident', async t => {
  const f = await fixture(t); f.logger.heartbeat('fonbet', { collectorState: 'HEALTHY_QUIET', eventCount: 0 }); f.advance(15000); f.logger.heartbeat('fonbet', { collectorState: 'HEALTHY_QUIET', eventCount: 0 }); await f.logger.flush();
  assert.equal((await queryIncidents(f.options())).length, 0); assert.equal((await read(f)).filter(r => r.phase === 'heartbeat').length, 2);
});
test('incident preserves previous telemetry and closes with recovery evidence', async t => {
  const f = await fixture(t); f.logger.record('system', 'telemetry', { eventLoopMaxMs: 1200 }); f.logger.heartbeat('fonbet', { collectorState: 'HEALTHY_ACTIVE' }); f.advance(15000); f.logger.heartbeat('fonbet', { collectorState: 'STALE', eventCount: 3 }); await f.logger.flush();
  let rows = await queryIncidents(f.options()); assert.equal(rows.length, 1); assert.equal(rows[0].state, 'OPEN'); assert.ok(rows[0].previousHealthyAt); assert.ok(rows[0].contextTelemetry.some(r => r.provider === 'system')); assert.equal(rows[0].rootCause, 'UNKNOWN');
  f.advance(30000); f.logger.heartbeat('fonbet', { collectorState: 'HEALTHY_ACTIVE', recoveryMechanism: 'full resync observed', reconnectCount: 1 }); await f.logger.flush(); rows = await queryIncidents(f.options()); assert.equal(rows[0].state, 'RECOVERED'); assert.equal(rows[0].durationMs, 30000); assert.equal(rows[0].recoveryMechanism, 'full resync observed');
});
test('simultaneous providers link incidents without claiming shared cause', async t => {
  const f = await fixture(t);
  for (const p of ['astek', 'fonbet', 'pinnacle']) f.logger.heartbeat(p, { collectorState: 'HEALTHY_ACTIVE' });
  f.advance(15000); f.logger.heartbeat('astek', { collectorState: 'DEGRADED' }); f.advance(1000); f.logger.heartbeat('fonbet', { collectorState: 'STALE' }); f.advance(40000); f.logger.heartbeat('pinnacle', { collectorState: 'DISCONNECTED' }); await f.logger.flush();
  const rows = await queryIncidents(f.options()); assert.equal(rows.length, 3); assert.equal(rows[0].relatedIncidentIds[0], rows[1].incidentId); assert.equal(rows[1].relatedIncidentIds[0], rows[0].incidentId); assert.equal(rows[2].relatedIncidentIds.length, 0); assert.ok(rows.every(r => r.rootCause === 'UNKNOWN'));
});
test('incident survives logger restart and records recovery as restart observed', async t => {
  const f = await fixture(t); f.logger.heartbeat('astek', { collectorState: 'HEALTHY_ACTIVE' }); f.advance(1000); f.logger.heartbeat('astek', { collectorState: 'STALE' }); await f.logger.stop();
  const next = new CollectorForensics({ dir: f.dir, statfs: async () => ({ bavail: 1000000, bsize: 4096 }), minFreeMiB: 1, now: () => base + 2000 }); await next.ready; assert.equal(next.incidents.size, 1); next.heartbeat('astek', { collectorState: 'HEALTHY_QUIET' }); await next.flush(); await next.stop();
  const rows = await queryIncidents(f.options()); assert.equal(rows[0].state, 'RECOVERED'); assert.equal(rows[0].recoveryMechanism, 'collector-restart-observed');
});
test('new collector startup grace does not invent an immediate outage', async t => {
  const f = await fixture(t); f.logger.heartbeat('ggbet-node', { collectorState: 'DISCONNECTED' }); await f.logger.flush(); assert.equal((await queryIncidents(f.options())).length, 0); f.advance(31000); f.logger.heartbeat('ggbet-node', { collectorState: 'DISCONNECTED' }); await f.logger.flush(); assert.equal((await queryIncidents(f.options())).length, 1);
});
test('time window reads only requested records and preserves measured delays', async t => {
  const f = await fixture(t); f.logger.record('fonbet', 'parse_complete', { operation: 'full snapshot', durationMs: 2800, payloadBytes: 38000000 }); f.advance(10000); f.logger.record('astek', 'payload_received'); await f.logger.flush();
  const report = await forensicReport({ ...f.options(), to: base + 5000, provider: 'fonbet' }); assert.equal(report.recordCount, 1); assert.equal(report.providers.fonbet.largestDelays[0].durationMs, 2800); assert.equal(report.providers.fonbet.lastParse, new Date(base).toISOString()); assert.ok(report.rootCause.unknown.length);
});
test('rotation bounds active segments and gzip preserves query data', async t => {
  const f = await fixture(t, { segmentBytes: 500 });
  f.logger.record('astek', 'payload_received'); await f.logger.flush(); f.logger.record('astek', 'parse_complete'); await f.logger.flush(); assert.equal((await fs.readdir(path.join(f.dir, 'providers/astek'))).length, 2);
  f.advance(2 * 3600000); f.logger.record('astek', 'payload_received'); await f.logger.flush(); await f.logger.maintain(); const names = await fs.readdir(path.join(f.dir, 'providers/astek')); assert.ok(names.some(n => n.endsWith('.gz'))); assert.equal((await read(f)).length, 3);
});
test('retention removes expired partitions and keeps newer history', async t => {
  const f = await fixture(t, { retentionMs: 3600000 }); f.logger.record('astek', 'payload_received'); await f.logger.flush(); f.advance(3 * 3600000); f.logger.record('astek', 'payload_received'); await f.logger.flush(); await f.logger.maintain(); assert.equal((await read(f)).length, 1);
});
test('disk cap includes active segments and drops safely', async t => {
  const f = await fixture(t, { maxBytes: 6000 });
  for (let i = 0; i < 50; i++) { f.logger.record('fonbet', 'payload_received', { payloadBytes: i }); await f.logger.flush(); }
  assert.ok(f.logger.status().recordsDropped > 0); await f.logger.maintain();
  let total = 0; const walk = async d => { for (const n of await fs.readdir(d)) { const p = path.join(d, n), s = await fs.stat(p); if (s.isDirectory()) await walk(p); else total += s.size; } }; await walk(f.dir); assert.ok(total <= 6000, 'actual disk usage remains within cap');
});
test('min-free guard prevents telemetry and incident writes', async t => {
  const f = await fixture(t, { statfs: async () => ({ bavail: 1, bsize: 4096 }), minFreeMiB: 10 }); f.logger.record('astek', 'payload_received'); f.logger.heartbeat('astek', { collectorState: 'HEALTHY_ACTIVE' }); f.advance(1000); f.logger.heartbeat('astek', { collectorState: 'STALE' }); await f.logger.flush(); assert.equal(f.logger.status().retentionState, 'low-free-space'); assert.ok(f.logger.status().recordsDropped >= 3); assert.equal((await read(f)).length, 0); assert.equal((await queryIncidents(f.options())).length, 0);
});
test('bounded queue drops overflow without blocking provider work', async t => {
  const f = await fixture(t, { queueBytes: 700 }); for (let i = 0; i < 100; i++) f.logger.record('fonbet', 'payload_received'); assert.ok(f.logger.status().queueBytes <= 700); assert.ok(f.logger.status().recordsDropped >= 98); await f.logger.flush();
});
test('disk write failure does not stop collector; facade isolates throwing logger', async t => {
  const f = await fixture(t, { append: async () => { throw Error('read-only filesystem'); } }); let work = 0; const collect = async () => { f.logger.record('astek', 'payload_received'); work++; }; await collect(); await f.logger.flush(); assert.equal(work, 1); assert.ok(f.logger.status().writeErrors >= 1); assert.equal(f.logger.status().recordsWritten, 0); setCollectorForensics({ record() { throw Error('logger bug'); } }); assert.doesNotThrow(() => forensic('astek', 'payload_received')); setCollectorForensics(null);
});
test('sanitization removes secrets in keys and free-text transport errors', () => {
  registerSecret('known-test-secret-value'); const x = safeTelemetry({ Authorization: 'a', Cookie: 'b', API_TOKEN: 'c', PrivateKey: 'd', nested: { browserAuthSecret: 'e' }, detail: 'https://user:password@example.test/ Bearer abcdef known-test-secret-value' }); const json = JSON.stringify(x); for (const v of ['known-test-secret-value', 'user:password', 'abcdef', '"a"', '"b"', '"c"', '"d"', '"e"']) assert.ok(!json.includes(v));
});
test('UTC, Amsterdam local time and today HH:mm resolve explicitly', () => {
  assert.equal(resolveTime('2026-10-04 13:34'), base); assert.equal(resolveTime('2026-10-04T11:34:00Z'), base); assert.equal(resolveTime('13:34', { now: base }), base); const q = queryOptions(['--at', '13:34', '--window', '5m'], base); assert.equal(q.from, base - 300000); assert.equal(q.to, base + 300000); assert.equal(q.zone, 'Europe/Amsterdam');
});
test('ambiguous and nonexistent DST input require explicit offset', () => { assert.throws(() => resolveTime('2026-10-25 02:30'), /Ambiguous/); assert.throws(() => resolveTime('2026-03-29 02:30'), /Nonexistent/); });
test('invalid filters/window cannot escape provider directories', () => { assert.throws(() => queryOptions(['--provider', '../../etc']), /Provider/); assert.throws(() => queryOptions(['--since', '20d']), /14 days/); assert.throws(() => queryOptions(['--at', '13:34', '--since', '5m']), /Choose/); });
test('provider state heartbeat uses transport success, not unchanged odds', () => {
  const s = { name: 'fonbet-live', staleAfterMs: 60000, lastSuccessfulUpdateAt: base, events: [] }; const l = { providers: new Map() }; assert.equal(stateHeartbeat([s], l, 'fonbet', base + 1000).collectorState, 'HEALTHY_QUIET'); assert.equal(stateHeartbeat([s], l, 'fonbet', base + 61000).collectorState, 'STALE');
});
test('browser QUIET is healthy; stale pages/IPC/VPN have separate evidence', () => {
  let fresh = true, state = 'QUIET'; const source = { status: () => ({ ipc: { fresh }, selected: [{ pageState: state, marketCount: 5 }], worker: {} }) }; const h = { vpnState: 'UP', browserRunning: true };
  assert.equal(browserHeartbeat(source, h).collectorState, 'HEALTHY_QUIET'); state = 'STALE'; assert.equal(browserHeartbeat(source, h).collectorState, 'STALE'); state = 'QUIET'; assert.equal(browserHeartbeat(source, { ...h, vpnState: 'DOWN' }).collectorState, 'STALE'); fresh = false; assert.equal(browserHeartbeat(source, h).collectorState, 'DISCONNECTED');
});
test('system heartbeat and logger self-monitoring remain in same timeline', async t => { const f = await fixture(t); f.logger.register('astek', () => ({ collectorState: 'HEALTHY_QUIET' })); await f.logger.sample(); await f.logger.flush(); const rows = await read(f); const system = rows.find(r => r.phase === 'telemetry'); assert.ok(system.rssMiB > 0); assert.ok(system.logger.queueDepth >= 0); assert.ok('sqliteWalBytes' in system); });
test('error categories and market counts preserve useful evidence without raw bodies', () => { assert.equal(errorFields({ status: 429 }).errorCategory, 'rate-limit'); assert.equal(errorFields(Error('IPC timeout')).errorCategory, 'timeout'); assert.deepEqual(eventCounts([{ markets: [{ odds: [1, 2] }] }]), { eventCount: 1, marketCount: 1, outcomeCount: 2 }); });

test('real fetchJson distinguishes HTTP receive, body download and JSON decode; bad JSON/503 are isolated', async t => {
  const f = await fixture(t); setCollectorForensics(f.logger);
  const server = http.createServer((req, res) => { if (req.url === '/error') { res.statusCode = 503; return res.end('no upstream'); } res.end(req.url === '/invalid' ? 'not JSON' : JSON.stringify({ Success: true, Value: [], packetVersion: 42 })); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const { fetchJson } = await import('../src/utils.js'); const baseURL = 'http://127.0.0.1:' + server.address().port;
  await fetchJson(baseURL + '/', baseURL, { metricGroup: 'fonbetBase' }); await assert.rejects(fetchJson(baseURL + '/invalid', baseURL, { metricGroup: 'fonbetBase' }), /JSON/); await assert.rejects(fetchJson(baseURL + '/error', baseURL, { metricGroup: 'pinnacleLive' }), /503/); await f.logger.flush();
  const rows = await read(f); for (const phase of ['upstream_request_start', 'upstream_response_received', 'payload_received', 'upstream_request_complete', 'parse_start', 'parse_complete']) assert.ok(rows.some(r => r.phase === phase));
  assert.ok(rows.some(r => r.phase === 'parse_complete' && r.result === 'error')); assert.ok(rows.some(r => r.httpStatus === 503 && r.result === 'error')); assert.ok(rows.some(r => r.providerVersion === 42)); assert.ok(!JSON.stringify(rows).includes('not JSON'));
});
test('forensic span also isolates failures in logger operation allocation', () => { setCollectorForensics({ nextOperation() { throw Error('bug'); }, record() { throw Error('bug'); } }); assert.doesNotThrow(() => forensicSpan('astek', 'decode')()); setCollectorForensics(null); });
test('private directories and telemetry files are not readable by other users', async t => { const f = await fixture(t); f.logger.record('astek', 'payload_received'); await f.logger.flush(); assert.equal((await fs.stat(f.dir)).mode & 0o777, 0o700); const dir = path.join(f.dir, 'providers/astek'); assert.equal((await fs.stat(dir)).mode & 0o777, 0o700); const names = await fs.readdir(dir); assert.equal((await fs.stat(path.join(dir, names[0]))).mode & 0o777, 0o600); });
test('free-space guard recovers without collector restart', async t => { let free = false; const f = await fixture(t, { statfs: async () => ({ bavail: free ? 1000000 : 1, bsize: 4096 }), minFreeMiB: 10 }); f.logger.record('astek', 'payload_received'); await f.logger.flush(); assert.equal(f.logger.status().recordsWritten, 0); free = true; f.logger.record('astek', 'payload_received'); await f.logger.flush(); assert.equal(f.logger.status().recordsWritten, 1); assert.equal(f.logger.status().retentionState, 'ok'); });
