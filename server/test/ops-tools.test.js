import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { startApi } from './helpers/api-harness.js';
import { setLogSink } from '../src/logger.js';

setLogSink(() => {});
const run = promisify(execFile);
const repo = path.resolve(new URL('../..', import.meta.url).pathname);
const TOKEN = 'ops-tools-token-0123456789';

test('staging environment is derived from the release compose file, without secrets or container paths', () => {
  const out = spawnSync('python3', [path.join(repo, 'ops/staging/compose-env.py'), path.join(repo, 'server/docker-compose.yml')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const env = Object.fromEntries(out.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(env.HISTORY_HOT_DAYS, '7');
  assert.equal(env.PREMATCH_CONCURRENCY, '1');
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=320/);
  for (const forbidden of ['API_TOKEN', 'DATA_DIR', 'PORT', 'GGBET_BOOTSTRAP_RELAY_SECRET_FILE', 'GGBET_BOOTSTRAP_RELAY_CA_FILE']) assert.ok(!(forbidden in env), forbidden);
  assert.ok(!out.stdout.includes('${'), 'all ${VAR:-default} were resolved');
  // Every key must be a setting the server actually reads.
  const config = fs.readdirSync(path.join(repo, 'server/src')).filter((f) => /\.(?:js|cjs)$/.test(f)).map((f) => fs.readFileSync(path.join(repo, 'server/src', f), 'utf8')).join('\n');
  for (const key of Object.keys(env)) if (!['NODE_OPTIONS', 'UV_THREADPOOL_SIZE'].includes(key)) assert.ok(config.includes(`"${key}"`) || config.includes(`'${key}'`) || config.includes(`process.env.${key}`), `${key} is not read by the server`);
});

test('every staging shell script parses, and the systemd unit keeps its safety properties', () => {
  const dir = path.join(repo, 'ops/staging');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sh'))) {
    const r = spawnSync('bash', ['-n', path.join(dir, file)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
  }
  const unit = fs.readFileSync(path.join(dir, 'esports-monitor.service'), 'utf8');
  for (const line of ['Restart=always', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'TasksMax=128', 'CapabilityBoundingSet=']) assert.ok(unit.includes(line), line);
  const provision = fs.readFileSync(path.join(dir, 'provision.sh'), 'utf8');
  assert.ok(provision.indexOf('ufw allow "$p/tcp"') < provision.indexOf('ufw --force enable'), 'SSH is allowed before the firewall is enabled');
  assert.ok(!/MemoryMax|CPUQuota/.test(unit), 'limits come only from the profile drop-in, never from the base unit');
});

test('staging-auth-check passes against a server with API_TOKEN and never prints the token', async () => {
  const api = await startApi({ api: { authToken: TOKEN } });
  try {
    const { stdout } = await run('node', [path.join(repo, 'tools/staging-auth-check.mjs'), '--url', api.base], { env: { ...process.env, STAGING_TOKEN: TOKEN } });
    assert.match(stdout, /all checks passed/);
    assert.ok(!stdout.includes(TOKEN));
    assert.match(stdout, /PASS {2}POST \/api\/ui\/odds-watch without a token is refused/);
  } finally { await api.close(); }
});

test('staging-auth-check fails when the server has no token configured (open server)', async () => {
  const api = await startApi({ api: { authToken: '' } });
  try {
    await assert.rejects(run('node', [path.join(repo, 'tools/staging-auth-check.mjs'), '--url', api.base], { env: { ...process.env, STAGING_TOKEN: TOKEN } }), (e) => e.code === 1 && /FAIL/.test(e.stdout));
  } finally { await api.close(); }
});

test('feed-report states what works and what does not instead of inventing success', async () => {
  const api = await startApi();
  try {
    const { stdout } = await run('node', [path.join(repo, 'tools/feed-report.mjs'), '--url', api.base, '--json']);
    const report = JSON.parse(stdout);
    assert.ok(report.rows.length >= 5);
    assert.ok(report.rows.every((r) => typeof r.verdict === 'string' && r.verdict.length));
    assert.ok(!report.rows.some((r) => r.verdict === 'WORKING'), 'nothing is reported as working when no collector ran');
  } finally { await api.close(); }
});

test('soak sampler + report: one sample is complete, and the report forecasts growth', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-'));
  try {
    const out = path.join(dir, 'samples.jsonl');
    await run('node', [path.join(repo, 'tools/soak-sampler.mjs'), '--url', api.base, '--out', out, '--once', '--data-dir', dir]);
    const row = JSON.parse(fs.readFileSync(out, 'utf8').trim());
    assert.equal(row.health.version, '4.4.0');
    assert.ok(row.health.history && 'rows' in row.health.history);
    assert.ok(row.system.memAvailableMiB > 0);
    // Synthetic 3-day series: database +10 MiB/day.
    const base = Date.now() - 3 * 86_400_000, rows = [];
    for (let i = 0; i <= 72; i++) rows.push({ at: base + i * 3_600_000, iso: new Date(base + i * 3_600_000).toISOString(), pid: 1, proc: { rssMiB: 100 + (i % 3), cpuTicks: i * 360 }, health: { heapUsedMiB: 20, eventLoopMaxMs: 30 }, disk: { dbMiB: 100 + (i / 24) * 10, dataMiB: 200 + (i / 24) * 12 } });
    fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { stdout } = await run('node', [path.join(repo, 'tools/soak-report.mjs'), out, '--json']);
    const report = JSON.parse(stdout);
    assert.equal(report.samples, 73);
    assert.ok(Math.abs(report.metrics['SQLite file, MiB'].slopePerDay - 10) < 0.2);
    assert.ok(Math.abs(report.diskForecast['SQLite file, MiB'].after30d - (130 + 300)) < 8, JSON.stringify(report.diskForecast['SQLite file, MiB']));
    assert.ok(Math.abs(report.cpuPercentOfOneCore.avg - 0.1) < 0.02, `CPU percent from ticks (${report.cpuPercentOfOneCore.avg})`);
  } finally { await api.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
