#!/usr/bin/env node
// Honest per-source status of the real integrations, taken from a running server's /health. A source is only
// reported WORKING when it delivered data and has no error; blocked/unreachable sources are stated as such.
//
//   node tools/feed-report.mjs [--url http://127.0.0.1[:port]]  (default: STAGING_URL, else PORT from /etc/esports-monitor/server.env, else 8080) [--json]
import { defaultUrl } from './default-url.mjs';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const url = arg('url', defaultUrl()).replace(/\/+$/, '');
const h = await (await fetch(url + '/health', { signal: AbortSignal.timeout(10000) })).json();

function classify({ count, stale, err, http, attempts, successes }) {
  if (attempts === 0) return 'NOT TRIED';
  if (successes === 0 && /403|429|451|503|Just a moment|blocked|Cloudflare/i.test(`${http} ${err}`)) return `BLOCKED (${http || err})`;
  if (successes === 0) return `UNREACHABLE (${err || 'no response'})`;
  if (err && stale) return `FAILING (${err})`;
  if (count > 0 && !stale) return err ? `WORKING with errors (${err})` : 'WORKING';
  if (!stale && count === 0) return 'REACHABLE, no events right now';
  return `STALE (${err || 'no recent update'})`;
}
const up = h.upstreamRequests || {};
const rows = [];
const add = (name, s, group) => rows.push({ source: name, events: s?.count ?? '-', history: s?.historyCount ?? '-', stale: !!s?.stale, http: s?.lastHttpStatus ?? 0, error: String(s?.lastError || ''), upstream: group ? up[group] : undefined });
for (const [k, v] of Object.entries(h.live || {})) add('live.' + k, v, { astek: 'astekLive', fonbet: 'fonbetFeed' }[k]);
for (const [k, v] of Object.entries(h.prematch || {})) add('prematch.' + k, v, { astek: 'astekPrematch', fonbet: 'fonbetFeed' }[k]);
rows.push({ source: 'ggbet collector', events: h.ggbetCollector?.events ?? '-', stale: false, http: 0, error: String(h.ggbetCollector?.lastError || h.ggbetCollector?.bootstrapError || ''), extra: h.ggbetCollector && { connected: h.ggbetCollector.connected, acknowledged: h.ggbetCollector.acknowledged, reconnects: h.ggbetCollector.reconnects, failures: h.ggbetCollector.failures } });
rows.push({ source: 'results', events: '-', stale: false, http: 0, error: String(h.results?.lastError || ''), upstream: up.astekResultsGames || up.fonbetResults });
rows.push({ source: 'hltv', events: h.hltv?.matches ?? '-', stale: false, http: 0, error: String(h.hltv?.lastError || ''), extra: { requests: h.hltv?.requests, blockedUntil: h.hltv?.blockedUntil } });
rows.push({ source: 'statistics (dota2/cs2)', events: h.statistics?.archivedMatches ?? '-', stale: false, http: 0, error: String(h.statistics?.lastError || ''), extra: h.statistics?.sources });
for (const r of rows) r.verdict = r.upstream ? classify({ count: typeof r.events === 'number' ? r.events : 0, stale: r.stale, err: r.error, http: r.http, attempts: r.upstream.attempts, successes: r.upstream.successes }) : (r.error ? `ERROR (${r.error})` : 'see details');
if (process.argv.includes('--json')) { console.log(JSON.stringify({ version: h.version, uptimeSeconds: h.uptimeSeconds, rows }, null, 2)); process.exit(0); }
console.log(`server ${h.version}, up ${h.uptimeSeconds}s\n`);
for (const r of rows) console.log(`${r.source.padEnd(24)} events ${String(r.events).padStart(4)}  ${r.verdict}${r.upstream ? `   [upstream ok ${r.upstream.successes}/${r.upstream.attempts}]` : ''}`);
console.log('\nupstream counters:'); for (const [k, v] of Object.entries(up)) console.log(`  ${k.padEnd(22)} attempts ${v.attempts}  ok ${v.successes}  failed ${v.failures}  last ${v.lastElapsedMs} ms`);
