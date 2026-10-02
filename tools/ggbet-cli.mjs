#!/usr/bin/env node
// Read-only GGBET diagnostics (state written by server/src/ggbet-supervisor.js). Never shows a secret: the state and the
// forensic log are sanitized before they are written, and configs are listed by name/mode only.
//   esports-monitor-ggbet status|vpns|sessions|history|switches|qualification|incidents [id]|tail [-n N] [--json]
//   esports-monitor-ggbet select <config.conf>      (root; manual egress choice via ggbet-egress.sh)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2), json = args.includes('--json'), VALUED = ['--dir', '--configs', '--n', '--pool'];
const pos = args.filter((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
const opt = (n, d) => { const i = args.indexOf('--' + n); return i > 0 ? args[i + 1] : d; };
const DIR = opt('dir', process.env.GGBET_FORENSICS_DIR || '/var/lib/esports-monitor/data/ggbet-forensics');
const CONF_DIR = opt('configs', '/root/.secrets/mullvad');
const POOL = opt('pool', '/var/lib/esports-monitor-ggbet/pool.json');
export function loadPool(file = POOL) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const now = Date.now();
const dur = (ms) => { if (ms == null || !Number.isFinite(ms) || ms < 0) return '-'; const s = Math.floor(ms / 1000); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d${h}h` : h ? `${h}h${m}m` : m ? `${m}m${s % 60}s` : `${s}s`; };
const ago = (iso) => (iso ? dur(now - Date.parse(iso)) + ' ago' : '-');
const t = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) + 'Z' : '-');
const table = (rows, cols) => { const w = cols.map(([h, f]) => Math.max(h.length, ...rows.map((r) => String(f(r) ?? '-').length))); const line = (cells) => cells.map((c, i) => String(c ?? '-').padEnd(w[i])).join('  ').trimEnd(); return [line(cols.map(([h]) => h)), ...rows.map((r) => line(cols.map(([, f]) => f(r))))].join('\n'); };
export function loadState(dir = DIR) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { return null; } }
export function discoverConfigs(dir = CONF_DIR) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.conf')).sort().map((n) => { const st = fs.statSync(path.join(dir, n)); return { configFile: n, id: `mullvad:${n.replace(/\.conf$/, '')}`, mode: (st.mode & 0o777).toString(8), size: st.size }; }); } catch { return []; }
}
export function incidents(dir = DIR) {
  const d = path.join(dir, 'incidents'); let names = []; try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort(); } catch {}
  return names.map((n) => { try { return JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')); } catch { return { incidentId: n, error: 'unreadable' }; } });
}
export function tail(dir = DIR, n = 30) {
  const d = path.join(dir, 'events'); let files = []; try { files = fs.readdirSync(d).filter((f) => /\.ndjson(\.gz)?$/.test(f)).sort(); } catch {}
  const lines = []; for (const f of files.slice(-2)) { const buf = fs.readFileSync(path.join(d, f)); lines.push(...(f.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8').split('\n').filter(Boolean)); }
  return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l.slice(0, 200) }; } });
}
export function vpnRows(state, configs, pool = null) {
  const e = state?.egresses || {}, p = pool?.vpns || {}, now = Date.now();
  // Pool (controller) statistics win over the service's per-egress counters; both are merged.
  const rows = configs.map((c) => { const pv = p[c.id] || {}, sv = e[c.id] || {}; return { ...c, ...sv, ...pv, state: pv.state || sv.state || 'UNTESTED', service: sv, cooldownLeftMs: pv.cooldownUntil > now ? pv.cooldownUntil - now : 0 }; });
  for (const [id, v] of Object.entries(e)) if (!rows.some((r) => r.id === id)) rows.push({ id, configFile: v.configFile || '-', ...v });
  // The running egress's current stretch is not in totalActiveDurationMs yet (added when it is deactivated).
  return rows.map((r) => { const current = (pool?.active || state?.egress?.id) === r.id; return { ...r, current, totalActiveDurationMs: (r.totalActiveDurationMs || 0) + (current && state?.egress?.id === r.id ? state.egress.ageMs || 0 : 0) }; });
}
function out(data, text) { process.stdout.write(json ? JSON.stringify(data, null, 1) + '\n' : text + '\n'); }

const cmd = pos[0] || 'status', state = loadState(), pool = loadPool();
if (cmd === 'select') {
  const name = pos[1]; if (!name) { console.error('usage: select <config.conf>'); process.exit(2); }
  execFileSync('/usr/local/bin/esports-monitor-ggbet-egress', ['select', name], { stdio: 'inherit' }); process.exit(0);
}
if (!state && !['vpns', 'incidents', 'switches', 'qualification'].includes(cmd)) { out({ error: `no state in ${DIR}` }, `no GGBET state in ${DIR} (is the server running with GGBET forensics enabled?)`); process.exit(1); }
if (cmd === 'status') {
  const eg = state.egress || {}, s = state.session || {}, c = state.collector || {}, g = state.guard || {}, last = g.last, pv = pool?.vpns?.[eg.id] || {}, es = state.egresses?.[eg.id] || {};
  const type = eg.kind === 'proxy-fallback' ? `FALLBACK PROXY (last resort: ${eg.fallbackReason || pool?.fallback?.reason || '-'})` : eg.kind === 'mullvad-netns' ? 'Mullvad' : eg.kind || state.mode;
  out({ egressType: type, egress: eg, controller: pool && { mode: pool.mode, active: pool.active, nextCandidate: pool.nextCandidate, switchesLastHour: pool.switchesLastHour, fallback: pool.fallback, vpn: pv }, session: s, collector: c, guard: g, log: state.log, updatedAt: state.updatedAt }, [
    `Egress type: ${type}   controller: ${pool ? pool.mode : 'not running'}`,
    `Current egress: ${eg.id || '-'}${eg.configFile ? `  config ${eg.configFile}` : ''}`,
    `Exit: ${[eg.exitIp, eg.country, eg.city, eg.hostname].filter(Boolean).join(' ') || '-'}`,
    `Active since: ${t(eg.activatedAt)}  (age ${dur(eg.ageMs)})   VPN healthy run ${dur(pv.currentHealthyRunMs)}  longest ${dur(pv.longestHealthyRunMs)}  state ${pv.state || '-'}`,
    `Bootstrap (this egress): ok ${es.bootstrapSuccesses ?? 0} / failed ${es.bootstrapFailures ?? 0}   WS ok ${es.wsConnectSuccesses ?? 0} / failed ${es.wsConnectFailures ?? 0}`,
    `Session: ${s.id || '-'}  age ${dur(s.ageMs)}  bootstrap ${s.bootstrap?.reason || '-'} (${s.bootstrap?.status || '-'})  JWE ${s.jwe ? `${s.jwe.currency}/${s.jwe.locale}/label ${s.jwe.label}` : '-'}`,
    `WS: ${c.connected ? 'connected' : 'not connected'}  age ${dur(s.wsAgeMs)}  connects ${s.wsConnects ?? '-'}  reconnects ${s.reconnects ?? '-'}  last close ${s.lastClose || '-'}`,
    `Subscriptions: light ${c.light ?? '-'}  full ${c.full ?? '-'}  leases ${c.leases ?? '-'}   data age ${dur(c.dataAgeMs)}`,
    `Pricing guard (${g.mode}${g.enforceIgnored ? ', enforce requested but ignored' : ''}): ${g.state}  samples ${g.samples} unusual ${g.unusual}  last good ${ago(g.lastGoodAt)}  first suspect ${t(g.firstSuspectAt)}`,
    `Last typeId 96: ${last ? `${t(last.at)} ${last.eventId} ${last.marketId} odd ${last.odd?.price} / even ${last.even?.price} (ratio ${last.ratio})` : 'none yet'}`,
    `Last good pricing: ${t(g.lastGoodAt)}   incidents: ${(state.incidents || []).length || '-'}`,
    `Fallback candidate: ${pool?.nextCandidate || '-'}   switches last hour ${pool?.switchesLastHour ?? '-'}${pool?.fallback ? `   fallback since ${t(pool.fallback.startedAt)}` : ''}`,
    `Forensic log: ${state.log?.level} ${(state.log?.bytes / 1048576 || 0).toFixed(1)} MiB, ${state.log?.files} files, raw ${state.log?.raw ? 'on' : 'off'}   state ${ago(state.updatedAt)}`,
  ].join('\n'));
} else if (cmd === 'vpns') {
  const configs = discoverConfigs(), rows = vpnRows(state, configs.length ? configs : Object.values(pool?.vpns || {}).map((v) => ({ configFile: v.configFile, id: v.id })), pool);
  out(rows, table(rows, [['ID', (r) => (r.current ? '*' : ' ') + r.id], ['Config', (r) => r.configFile], ['Exit', (r) => [r.exitIp, r.country, r.city].filter(Boolean).join(' ')], ['State', (r) => r.state], ['Last activated', (r) => t(r.lastActivatedAt)], ['Healthy run', (r) => dur(r.currentHealthyRunMs)], ['Longest', (r) => dur(r.longestHealthyRunMs)], ['Total healthy', (r) => dur(r.totalHealthyRuntimeMs)], ['Activations', (r) => r.activationCount ?? 0], ['Sessions', (r) => r.service?.sessions ?? 0], ['Pricing susp/conf', (r) => `${r.service?.pricingSuspects ?? 0}/${r.service?.pricingConfirmed ?? 0}`], ['Net fail', (r) => r.networkFailures ?? 0], ['Cooldown', (r) => (r.cooldownLeftMs ? dur(r.cooldownLeftMs) : '-')], ['Last reason', (r) => r.lastFailureReason || r.service?.lastFailureReason]]));
} else if (cmd === 'sessions') {
  const rows = (state.sessions || []).slice().reverse();
  out(rows, table(rows, [['Session', (r) => r.id], ['Egress', (r) => r.egressId], ['Started', (r) => t(r.startedAt)], ['Age/lifetime', (r) => dur((r.endedAt ? Date.parse(r.endedAt) : now) - Date.parse(r.startedAt))], ['First good', (r) => t(r.firstGoodAt)], ['Last good', (r) => t(r.lastGoodAt)], ['Guard', (r) => r.guardState], ['WS', (r) => r.wsConnects], ['Reconn', (r) => r.reconnects], ['Suspect/conf', (r) => `${r.pricingSuspects}/${r.pricingConfirmed}`], ['JWE', (r) => (r.jwe ? `${r.jwe.locale}/${r.jwe.label}` : '-')], ['End', (r) => r.endReason || (r.endedAt ? 'ended' : 'active')]]));
} else if (cmd === 'history') {
  const since = now - 24 * 3600000, rows = (state.history || []).filter((h) => Date.parse(h.at) >= since).reverse();
  out(rows, table(rows, [['Time', (r) => t(r.at)], ['From', (r) => r.from], ['To', (r) => r.to], ['Reason', (r) => r.reason], ['Old session', (r) => r.oldSessionId], ['Old session age', (r) => dur(r.oldSessionAgeMs)], ['Old egress age', (r) => dur(r.oldEgressAgeMs)], ['Pricing', (r) => r.pricingState]]));
} else if (cmd === 'switches') {
  const rows = (pool?.history || []).filter((h) => ['switch', 'fallback', 'activated', 'restore-attempt', 'network-failure', 'reestablish', 'qualified'].includes(h.type)).reverse();
  out(rows, table(rows, [['Time', (r) => t(r.at)], ['Event', (r) => r.type], ['From', (r) => r.from || r.id], ['To', (r) => r.to], ['Reason', (r) => r.reason], ['Cooldown until', (r) => t(r.cooldownUntil)]]));
} else if (cmd === 'qualification') {
  const q = pool?.options?.qualifyMs || 3600000, rows = vpnRows(state, discoverConfigs(), pool);
  out(rows.map((r) => ({ id: r.id, configFile: r.configFile, state: r.state, totalHealthyRuntimeMs: r.totalHealthyRuntimeMs || 0, qualifyMs: q, qualified: (r.totalHealthyRuntimeMs || 0) >= q, sessions: r.service?.sessions || 0, pricingSuspects: r.service?.pricingSuspects || 0, pricingConfirmed: r.service?.pricingConfirmed || 0, networkFailures: r.networkFailures || 0, bootstrapFailures: r.service?.bootstrapFailures || 0, wsFailures: r.service?.wsConnectFailures || 0 })), table(rows, [['ID', (r) => r.id], ['State', (r) => r.state], ['Healthy runtime', (r) => `${dur(r.totalHealthyRuntimeMs || 0)} / ${dur(q)}`], ['Qualified', (r) => ((r.totalHealthyRuntimeMs || 0) >= q ? 'yes' : 'no')], ['Sessions', (r) => r.service?.sessions ?? 0], ['Pricing susp/conf', (r) => `${r.service?.pricingSuspects ?? 0}/${r.service?.pricingConfirmed ?? 0}`], ['Net fail', (r) => r.networkFailures ?? 0], ['Boot fail', (r) => r.service?.bootstrapFailures ?? 0], ['WS fail', (r) => r.service?.wsConnectFailures ?? 0]]));
} else if (cmd === 'incidents') {
  const list = incidents(), id = pos[1];
  if (id) { const one = list.find((i) => String(i.incidentId).includes(id)); out(one || { error: 'not found' }, one ? JSON.stringify(one, null, 1) : 'not found'); }
  else out(list.map(({ incidentId, at, egressId, sessionId, classification, decision, confirmedBad }) => ({ incidentId, at, egressId, sessionId, classification, decision, eventId: confirmedBad?.eventId, marketId: confirmedBad?.marketId })), table(list.slice().reverse(), [['Time', (r) => t(r.at)], ['Incident', (r) => r.incidentId], ['Egress', (r) => r.egressId], ['Session', (r) => r.sessionId], ['Class', (r) => r.classification], ['Event/market', (r) => (r.confirmedBad ? `${r.confirmedBad.eventId} ${r.confirmedBad.marketId}` : '-')], ['Action', (r) => r.decision]]));
} else if (cmd === 'tail') {
  const rows = tail(DIR, Number(opt('n', 30)) || 30);
  out(rows, rows.map((r) => `${r.at} ${r.kind.padEnd(10)} ${JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !['at', 'kind'].includes(k)))).slice(0, 220)}`).join('\n'));
} else { console.error('commands: status | vpns | sessions | history | switches | qualification | incidents [id] | tail [--n N] | select <config.conf>   (--json)'); process.exit(2); }
