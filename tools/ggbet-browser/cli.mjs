#!/usr/bin/env node
// Operator CLI for the GGBET Firefox browser worker (local Unix socket only).
//   ggbet-browser status | selected | matches | markets <eventId> | stale | stats   [--json]
import http from 'node:http';

const SOCK = process.env.GGBET_BROWSER_SOCKET || '/run/ggbet-browser/data.sock';
const args = process.argv.slice(2), json = args.includes('--json'), [cmd = 'status', arg] = args.filter((a) => a !== '--json');
const get = (p) => new Promise((resolve, reject) => {
  const req = http.get({ socketPath: SOCK, path: p, timeout: 5000 }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`bad response from ${p}`)); } }); });
  req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
});
const age = (ms) => (ms == null ? '-' : ms < 1000 ? `${ms}ms` : ms < 120000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);
const out = (o, text) => console.log(json ? JSON.stringify(o, null, 2) : text());

async function main() {
  if (cmd === 'status') {
    const h = await get('/health');
    return out(h, () => [
      `browser   ${h.browserRunning ? `running pid ${h.browserPid}` : 'DOWN'}  session ${age(h.browserSessionAgeMs)}  restarts ${h.restartCount}`,
      `vpn       ${h.vpnState}  exit ${h.vpnExit ? `${h.vpnExit.ip} ${h.vpnExit.city} ${h.vpnExit.hostname}` : '-'}  first GG.BET use ${h.firstGgbetAt || '-'}`,
      `pages     ${h.pagesActive}/${h.maxPages}  healthy ${h.pagesHealthy} quiet ${h.pagesQuiet} suspect ${h.pagesSuspect} stale ${h.pagesStale} recovering ${h.pagesRecovering}  recoveries ${h.pageRecoveries}`,
      `data      ws frames ${h.wsFramesTotal} (last ${age(h.lastWsFrameAgeMs)})  markets ${h.marketCount} outcomes ${h.outcomeCount}  updates/min ${h.updatesPerMinute}  last update ${age(h.lastAnyUpdateAgeMs)}`,
      `resources firefox PSS ${h.firefoxPssMiB} MiB (${h.firefoxProcesses} procs)  worker RSS ${h.workerRssMiB} MiB  MemAvailable ${h.systemMemAvailableMiB} MiB`,
    ].join('\n'));
  }
  if (cmd === 'selected') {
    const m = await get('/selected');
    return out(m, () => (m.length ? m.map((p) => `${String(p.sport).padEnd(7)} ${p.eventId}  ${p.title || '?'}  [${p.league || '?'}]  ${p.status || '?'} ${p.score || ''}  rank ${p.sportRank ?? '-'} global ${p.globalRank ?? '-'}  ${p.state}${p.ready ? ' READY' : ''}  markets ${p.marketCount}  -- ${p.reason || ''}`).join('\n') : 'no selected events'));
  }
  if (cmd === 'matches') {
    const m = await get('/matches');
    return out(m, () => (m.length ? m.map((p) => `${p.state.padEnd(13)} ${p.eventId}  ${p.eventName || '?'}  [${p.league || '?'}]  ${p.status || '?'} ${p.score || ''}  v${p.eventVersion || '?'}  markets ${p.markets} outcomes ${p.outcomes}  tab ${age(p.tabAgeMs)}  data ${age(p.eventUpdateAgeMs)}  price ${age(p.priceChangeAgeMs)}  recoveries ${p.recoveries}`).join('\n') : 'no pages'));
  }
  if (cmd === 'markets') {
    if (!arg) throw new Error('usage: ggbet-browser markets <eventId>');
    const m = await get(`/markets?eventId=${encodeURIComponent(arg)}`);
    return out(m, () => [`${m.eventName || arg}  state ${m.state}  fresh ${m.fresh}`, ...(m.markets || []).map((x) => `${String(x.marketId).padEnd(8)} t${String(x.typeId).padEnd(4)} ${String(x.marketStatus).padEnd(10)} ${x.stale ? 'STALE' : 'fresh'} ${age(x.ageMs).padStart(5)}  ${x.marketName}  ${x.outcomes.map((o) => `${o.outcomeId}:${o.outcomeName}=${o.rawPrice}${o.active ? '' : '(off)'}`).join('  ')}`)].join('\n'));
  }
  if (cmd === 'stale') {
    const s = await get('/stale');
    return out(s, () => (s.length ? s.map((p) => `${p.state.padEnd(13)} ${p.eventId}  ${p.eventName || '?'}  data ${age(p.eventUpdateAgeMs)}  ws ${age(p.wsAgeMs)}  price ${age(p.priceChangeAgeMs)}  recoveries ${p.recoveries}`).join('\n') : 'no stale or suspect pages'));
  }
  if (cmd === 'stats') {
    const h = await get('/health');
    return out({ stats: h.stats, updatesPerMinute: h.updatesPerMinute, thresholds: h.thresholds }, () => `${Object.entries(h.stats).map(([k, v]) => `${k} ${v}`).join('  ')}  updates/min ${h.updatesPerMinute}\nthresholds ${Object.entries(h.thresholds || {}).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  throw new Error('usage: ggbet-browser status | selected | matches | markets <eventId> | stale | stats [--json]');
}
main().catch((e) => { console.error(`ggbet-browser: ${e.message}`); process.exit(1); });
