#!/usr/bin/env node
// GGBET egress controller (root, systemd unit esports-monitor-ggbet-egressd): keeps ONE Mullvad egress for GGBET
// (ops/staging/ggbet-egress.sh), checks its transport health every 30 s and - only on transport failure - re-establishes
// it, switches to the next Mullvad config, or falls back to the existing HTTP proxy as last resort (ggbet-vpn-pool.js).
// GGBET's own answers and pricing are never a reason to switch (the service only records them).
// A candidate is always verified (exit probe through its socket) BEFORE the service sees it in status.json.
// Never reads or prints a config's contents; that happens only inside ggbet-egress.sh.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VpnPool } from '../server/src/ggbet-vpn-pool.js';
import { NetnsConnectAgent } from '../server/src/egress.js';
import { ForensicLog } from '../server/src/ggbet-forensics.js';

const run = promisify(execFile);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const O = {
  stateDir: arg('state-dir', '/var/lib/esports-monitor-ggbet'), configs: arg('configs', '/root/.secrets/mullvad'),
  service: arg('service-state', '/var/lib/esports-monitor/data/ggbet-forensics/state.json'), egress: arg('egress-cmd', '/usr/local/bin/esports-monitor-ggbet-egress'),
  run: '/run/ggbet-egress', ns: 'ggbet-egress', iface: 'wgge0', intervalMs: Number(arg('interval', 30000)), probeEveryMs: 120000, preferred: arg('preferred', 'ggbet-good.conf'), svcGroup: 'monitor',
};
fs.mkdirSync(O.stateDir, { recursive: true, mode: 0o750 });
const log = new ForensicLog({ dir: path.join(O.stateDir, 'log') });
const poolFile = path.join(O.stateDir, 'pool.json');
const pool = new VpnPool({ state: (() => { try { return JSON.parse(fs.readFileSync(poolFile, 'utf8')); } catch { return {}; } })(), preferred: O.preferred });
const note = (type, data = {}) => { log.write(type, data); process.stdout.write(JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n'); };
function save() { const tmp = poolFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(pool.snapshot(), null, 1), { mode: 0o640 }); try { fs.chownSync(tmp, 0, gid()); } catch {} fs.renameSync(tmp, poolFile); }
const gid = () => { try { return Number(fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.startsWith(O.svcGroup + ':')).split(':')[2]); } catch { return 0; } };
function discover() {
  try { fs.chmodSync(O.configs, 0o700); } catch {}
  const files = fs.readdirSync(O.configs).filter((f) => f.endsWith('.conf')).sort();
  for (const f of files) { try { const p = path.join(O.configs, f); if ((fs.statSync(p).mode & 0o077) !== 0) fs.chmodSync(p, 0o600); } catch {} }
  return pool.discover(files);
}
function readStatus() { try { return JSON.parse(fs.readFileSync(path.join(O.run, 'status.json'), 'utf8')); } catch { return null; } }
function writeStatus(obj) {
  fs.mkdirSync(O.run, { recursive: true, mode: 0o750 }); try { fs.chownSync(O.run, 0, gid()); fs.chmodSync(O.run, 0o750); } catch {}
  const tmp = path.join(O.run, 'status.json.tmp'); fs.writeFileSync(tmp, JSON.stringify(obj) + '\n', { mode: 0o640 }); try { fs.chownSync(tmp, 0, gid()); } catch {}
  fs.renameSync(tmp, path.join(O.run, 'status.json'));
}
// Bring a config up WITHOUT exposing it; returns the status object to publish after verification.
async function prepare(configFile) {
  try { const { stdout } = await run(O.egress, ['select', configFile], { env: { ...process.env, GGBET_EGRESS_NO_STATUS: '1' }, timeout: 90000 }); return JSON.parse(stdout.trim().split('\n').pop()); }
  catch (e) { return { error: `select failed (exit ${e.code ?? '?'})`, local: true, isolation: e.code === 3 }; }
}
function probe() {
  return new Promise((resolve) => {
    const req = https.get('https://ipinfo.io/json', { agent: new NetnsConnectAgent(path.join(O.run, 'connect.sock')), timeout: 15000 }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { const j = JSON.parse(b); resolve({ ok: r.statusCode === 200 && !!j.ip, ip: j.ip, country: j.country, city: j.city }); } catch { resolve({ ok: false, error: `HTTP ${r.statusCode}` }); } }); });
    req.on('timeout', () => req.destroy(Error('timeout'))); req.on('error', (e) => resolve({ ok: false, error: String(e.message).slice(0, 120) }));
  });
}
async function wgHealth() {
  const ns = (await run('ip', ['netns', 'list']).catch(() => ({ stdout: '' }))).stdout.split('\n').some((l) => l.split(' ')[0] === O.ns);
  if (!ns) return { netns: false, wg: false, handshakeAgeS: null };
  const wg = await run('ip', ['-n', O.ns, 'link', 'show', O.iface]).then(() => true, () => false);
  let handshakeAgeS = null;
  if (wg) { const out = (await run('ip', ['netns', 'exec', O.ns, 'wg', 'show', O.iface, 'latest-handshakes']).catch(() => ({ stdout: '' }))).stdout; const ts = Number(out.trim().split(/\s+/).pop()); if (ts > 0) handshakeAgeS = Math.round(Date.now() / 1000 - ts); }
  return { netns: true, wg, handshakeAgeS };
}
function serviceHealth(since) {
  try {
    const s = JSON.parse(fs.readFileSync(O.service, 'utf8')), fresh = Date.now() - Date.parse(s.updatedAt) < 90000;
    const failures = (s.transport?.failures || []).filter((f) => Date.parse(f.at) > since).length;
    return { serviceHealthy: fresh && !!s.collector?.connected && (s.collector?.dataAgeMs ?? 1e9) < 120000, serviceTransportFailures: failures, serviceEgress: s.egress?.id };
  } catch { return { serviceHealthy: false, serviceTransportFailures: 0 }; }
}
// Verify and activate a candidate; on failure mark it and continue with the next one (bounded by the pool).
async function activate(decision) {
  let d = decision;
  for (let guard = 0; guard < 10 && d && ['switch', 'restore', 'select', 'reestablish'].includes(d.action); guard++) {
    const target = d.to || d.id, v = pool.vpns[target]; if (!v) break;
    note('prepare', { id: target, configFile: v.configFile, reason: d.reason });
    const st = await prepare(v.configFile), pr = st.error ? { ok: false, error: st.error } : await probe();
    if (pr.ok && (!st.exitIp || pr.ip === st.exitIp)) {
      // Re-establishing the SAME egress keeps the published status (same exit): the service keeps its session.
      const same = d.action === 'reestablish' && readStatus()?.id === target && readStatus()?.exitIp === st.exitIp;
      if (!same) writeStatus(st); pool.activated(target, st); note('activated', { id: target, exitIp: st.exitIp, country: st.country, city: st.city, hostname: st.hostname, reason: d.reason }); save(); return true;
    }
    note('verification-failed', { id: target, error: pr.error || 'exit mismatch', local: !!st.local });
    // A local setup error (script failed before any network check) is not the VPN's fault: no cooldown, no switch
    // budget; run the last-resort proxy and retry on the fallback schedule. Exit 3 = host isolation broken: stop at once.
    if (st.local) { if (d.action === 'switch') pool.switches.pop(); if (pool.mode !== 'fallback') pool.enterFallback(st.isolation ? 'egress setup stopped: host isolation check failed' : `egress setup error: ${st.error}`); await fallback(st.isolation ? 'egress setup stopped: host isolation check failed' : `egress setup error: ${st.error}`); return false; }
    if (d.action === 'restore') { pool.networkFailure(target, `verification: ${pr.error || 'exit mismatch'}`); pool.mode = 'fallback'; await run(O.egress, ['down'], { env: { ...process.env, GGBET_EGRESS_NO_STATUS: '1' } }).catch(() => {}); save(); return false; }
    d = pool.candidateFailed(target, pr.error || 'exit mismatch');
  }
  if (d?.action === 'fallback') await fallback(d.reason);
  save(); return false;
}
async function fallback(reason) {
  await run(O.egress, ['down'], { env: { ...process.env, GGBET_EGRESS_NO_STATUS: '1' } }).catch(() => {});
  const at = new Date().toISOString(); writeStatus({ kind: 'proxy-fallback', id: 'proxy:last-resort', fallbackReason: reason, fallbackStartedAt: pool.fallback?.startedAt || at, activatedAt: pool.fallback?.startedAt || at });
  note('fallback', { reason }); save();
}

// One transport qualification of another config at a time, at most every 10 min, only while the active egress is healthy.
let lastQualify = 0;
async function qualifyOne() {
  if (pool.mode !== 'mullvad' || pool.failing || Date.now() - lastQualify < 600000) return;
  const v = pool.nextTransportCheck(); if (!v) return; lastQualify = Date.now();
  let r; try { const { stdout } = await run(O.egress, ['qualify', v.configFile], { timeout: 90000 }); r = JSON.parse(stdout.trim().split('\n').pop()); } catch (e) { r = { ok: false, error: `qualify failed (exit ${e.code ?? '?'})`, checkedAt: new Date().toISOString() }; }
  pool.transportChecked(v.id, r); note('transport-check', { id: v.id, ok: r.ok, exitIp: r.exitIp, country: r.country, city: r.city, hostname: r.hostname, error: r.error }); save();
}
let lastTick = Date.now(), lastProbe = 0, stopping = false;
async function tick() {
  discover();
  const st = readStatus();
  // Adopt what is running (controller restart) or an operator's manual `select`.
  if (st?.kind === 'proxy-fallback' && pool.mode !== 'fallback') { pool.mode = 'fallback'; pool.fallback = pool.fallback || { reason: st.fallbackReason, startedAt: st.fallbackStartedAt }; }
  else if (st?.id && st.kind !== 'proxy-fallback' && pool.vpns[st.id] && st.id !== pool.active) { pool.activated(st.id, st); note('adopted', { id: st.id, reason: 'egress already running (restart or manual select)' }); }
  let decision;
  if (pool.mode === 'fallback') decision = pool.fallbackTick();
  else if (!pool.active) decision = { action: 'select', to: pool.candidate()?.id, reason: 'startup: no active egress' };
  else {
    const wg = await wgHealth(), svc = serviceHealth(lastTick); let probeOk;
    if (!svc.serviceHealthy || Date.now() - lastProbe > O.probeEveryMs) { const p = await probe(); probeOk = p.ok; lastProbe = Date.now(); if (!p.ok) note('probe-failed', { id: pool.active, error: p.error }); }
    decision = pool.tick({ ...wg, probeOk, ...svc });
    if (decision.reason && decision.action === 'none') note('check', { id: pool.active, reason: decision.reason });
  }
  lastTick = Date.now();
  if (decision?.action === 'select' && !decision.to) decision = pool.enterFallback('no usable Mullvad config at startup');
  if (decision?.action === 'fallback') await fallback(decision.reason);
  else if (['select', 'switch', 'restore', 'reestablish'].includes(decision?.action)) await activate(decision);
  else if (decision?.action === 'none' && !decision.reason) await qualifyOne();
  save();
}
async function loop() { while (!stopping) { try { await tick(); } catch (e) { note('error', { error: String(e.message).slice(0, 200) }); } await new Promise((r) => setTimeout(r, O.intervalMs)); } }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; save(); log.flushSync(); process.exit(0); }); // the egress stays up for the service
note('start', { preferred: O.preferred, configs: discover().map((v) => v.configFile) });
if (process.argv.includes('--once')) await tick(); else loop();
