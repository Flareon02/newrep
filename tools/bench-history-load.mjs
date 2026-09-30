#!/usr/bin/env node
// Measures what loading the persisted History costs in RAM and time at startup, using the same
// sequential SnapshotState.load() that server/src/index.js performs.
//
//   node tools/bench-history-load.mjs --events 20000 [--states 7]
//
// Rows are synthetic but modelled on real parsed events (fixtures), so treat the result as
// bytes-per-row for extrapolation: read historyCount of each snapshot from /health on the
// production server and multiply.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'server');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const events = Number(arg('events', 20000)), states = Number(arg('states', 7)), phase = arg('phase', 'parent');
const NAMES = ['live', 'prematch', 'fonbet-live', 'fonbet-prematch', 'ggbet-live', 'pinnacle-prematch', 'pinnacle-live'].slice(0, states);
const mib = (n) => Math.round(n / 1048576);

if (phase === 'generate') {
  const { parseLiveFeed } = await import(pathToFileURL(path.join(server, 'src/parsers.js')));
  const { snapshotSave, closeSqliteStorage } = await import(pathToFileURL(path.join(server, 'src/sqlite-storage.js')));
  const fixture = JSON.parse(readFileSync(path.join(server, 'test/fixtures/astek-live.json'), 'utf8'));
  const template = parseLiveFeed(fixture, 'https://astekbet.com')[0];
  delete template.odds;
  const now = Date.now();
  for (const name of NAMES) {
    const history = Array.from({ length: events }, (_, i) => ({
      ...template, id: `${name}-${i}`, sourceEventId: String(i), team1: `Team ${i % 997} ${name}`, team2: `Team ${(i * 7) % 991} ${name}`,
      league: `League ${i % 240}`, startAt: now - i * 60000, firstSeenAt: now - i * 60000 - 3600000, lastSeenAt: now - i * 60000, removedAt: now - i * 60000 + 1000,
    }));
    snapshotSave(name, { revision: 1, matchRevision: 1, events: [], history, seen: {} }, {});
  }
  closeSqliteStorage();
} else if (phase === 'measure') {
  const { SnapshotState } = await import(pathToFileURL(path.join(server, 'src/state.js')));
  const t0 = process.hrtime.bigint();
  const loaded = [];
  for (const name of NAMES) { const s = new SnapshotState(name, 60000); await s.load(); loaded.push(s); }
  globalThis.gc?.();
  const m = process.memoryUsage(), ms = Number(process.hrtime.bigint() - t0) / 1e6, rows = loaded.reduce((n, s) => n + s.history.length, 0);
  console.log(JSON.stringify({ rows, rssMiB: mib(m.rss), heapUsedMiB: mib(m.heapUsed), loadMs: Math.round(ms), bytesPerRow: Math.round(m.heapUsed / rows) }));
} else {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-history-'));
  const env = { ...process.env, DATA_DIR: dir, NODE_OPTIONS: '--disable-warning=ExperimentalWarning --max-old-space-size=320 --expose-gc' };
  try {
    const run = (p) => spawnSync('node', [fileURLToPath(import.meta.url), '--phase', p, '--events', String(events), '--states', String(states)], { env, encoding: 'utf8' });
    const g = run('generate'); if (g.status) throw new Error('generate failed: ' + g.stderr.slice(-400));
    const m = run('measure'); if (m.status) throw new Error('measure failed (heap cap 320 MiB?): ' + (m.stderr || m.stdout).slice(-600));
    console.log(`${states} snapshots x ${events} rows:`, m.stdout.trim());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
