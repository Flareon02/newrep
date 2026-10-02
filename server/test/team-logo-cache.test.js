import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { writeJson } from '../src/utils.js';
import { TeamLogos, LOGO_REFRESH_MS, LOGO_MIN_GAP_MS } from '../src/team-logos.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'team-logos-'));
config.dataDir = tmp;
const url = (name) => `https://cdn.gin.bet/team/${name}.png`, astekUrl = 'https://v2l.traincdn.com/sfiles/logo_teams/' + 'a'.repeat(32) + '.png';
const idle = async (t) => { for (let i = 0; i < 200 && (t.running || t.queue.length || t.pending.size); i++) await new Promise((r) => setTimeout(r, 2)); await new Promise((r) => setTimeout(r, 2)); };

// A store with a fake clock, a fake CDN (counts requests per URL) and a counted index writer.
function store({ status = 200, saveDelayMs = 60000 } = {}) {
  const clock = { t: Date.parse('2026-10-02T20:00:00Z') }, requests = [], writes = [];
  const fetchImpl = async (u) => { requests.push(u); const s = typeof status === 'function' ? status(u) : status; return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: s, headers: { 'content-type': 'image/png' } }); };
  const t = new TeamLogos({ now: () => clock.t, fetchImpl, read: async () => ({}), write: (f, v) => { writes.push(f); return writeJson(f, v); }, saveDelayMs });
  return { t, clock, requests, writes };
}
const event = (team1Logo, team1 = 'Team Spirit', category = 'Dota 2') => ({ category, team1, team2: 'Other', team1Logo, team2Logo: '' });

test('a downloaded logo is not queued again by the next decorate() calls (the endless re-download loop)', async () => {
  const { t, clock, requests } = store();
  t.decorate(event(url('spirit'))); await idle(t);
  assert.equal(requests.length, 1);
  const key = t.key('Dota 2', 'Team Spirit');
  for (let i = 0; i < 50; i++) { clock.t += 1000; const out = t.decorate(event(url('spirit'))); assert.equal(out.team1Logo, '/api/team-logos/' + key); }
  await idle(t);
  assert.equal(requests.length, 1, 'no second request for the same logo');
  assert.equal(t.index[key].attempt, t.index[key].updatedAt, 'the success keeps the time of the attempt');
});

test('the same URL is fetched again only after the refresh interval, once', async () => {
  const { t, clock, requests } = store();
  t.decorate(event(url('spirit'))); await idle(t);
  clock.t += LOGO_REFRESH_MS - 1000; t.decorate(event(url('spirit'))); await idle(t);
  assert.equal(requests.length, 1, 'still fresh just before the interval');
  clock.t += 2000; t.decorate(event(url('spirit'))); t.decorate(event(url('spirit'))); await idle(t);
  assert.equal(requests.length, 2, 'refreshed once after the interval');
});

test('a new URL is fetched; two bookmakers with different URLs for one team do not replace each other forever', async () => {
  const { t, clock, requests } = store();
  t.decorate(event(astekUrl)); await idle(t);
  clock.t += LOGO_MIN_GAP_MS + 1000; t.decorate(event(url('spirit'))); await idle(t);
  assert.deepEqual(requests, [astekUrl, url('spirit')], 'a URL never fetched for this team is downloaded');
  for (let i = 0; i < 20; i++) { clock.t += LOGO_MIN_GAP_MS + 1000; t.decorate(event(i % 2 ? astekUrl : url('spirit'))); await idle(t); }
  assert.equal(requests.length, 2, 'both URLs are known: no ping-pong between sources');
  clock.t += LOGO_MIN_GAP_MS + 1000; t.decorate(event(url('spirit-2026'))); await idle(t);
  assert.equal(requests.at(-1), url('spirit-2026'), 'a changed URL is still picked up');
});

test('an index written before this fix (file, no attempt/fetched) is not downloaded again', async () => {
  const { t, clock, requests } = store();
  const key = t.key('Dota 2', 'Team Spirit');
  t.index[key] = { key, remote: url('spirit'), name: 'Team Spirit', category: 'Dota 2', file: key + '.png', mime: 'image/png', updatedAt: clock.t - 60000, failureCount: 0, retryAt: 0, lastError: '' };
  t.decorate(event(url('spirit'))); await idle(t);
  assert.equal(requests.length, 0);
});

test('a failed download keeps its backoff: no retry before retryAt, then once, then a longer backoff', async () => {
  const { t, clock, requests } = store({ status: 404 });
  t.decorate(event(url('gone'))); await idle(t);
  const key = t.key('Dota 2', 'Team Spirit'), first = t.index[key];
  assert.equal(requests.length, 1); assert.equal(first.failureCount, 1); assert.equal(first.retryAt - first.attempt, 5 * 60000);
  clock.t += 4 * 60000; t.decorate(event(url('gone'))); await idle(t);
  assert.equal(requests.length, 1, 'inside the backoff');
  clock.t += 2 * 60000; t.decorate(event(url('gone'))); await idle(t);
  assert.equal(requests.length, 2); assert.equal(t.index[key].failureCount, 2); assert.equal(t.index[key].retryAt - t.index[key].attempt, 10 * 60000);
});

test('a batch of downloads is one index write (debounced), and flush() writes what is pending', async () => {
  const { t, requests, writes } = store();
  for (let i = 0; i < 60; i++) t.decorate(event(url('team' + i), 'Team ' + i));
  await idle(t);
  assert.equal(requests.length, 60);
  assert.equal(writes.length, 0, 'nothing written per download');
  await t.flush();
  assert.equal(writes.length, 1, 'one write for the whole batch');
  const saved = JSON.parse(await fs.readFile(path.join(tmp, 'teams', 'logos.json'), 'utf8'));
  assert.equal(Object.values(saved).filter((e) => e.file).length, 60);
  await t.flush(); assert.equal(writes.length, 1, 'nothing pending: no extra write');
});

test('the debounced save writes once after the delay', async () => {
  const { t, writes } = store({ saveDelayMs: 20 });
  for (let i = 0; i < 10; i++) t.decorate(event(url('late' + i), 'Late ' + i));
  await idle(t); await new Promise((r) => setTimeout(r, 60)); await t.flush();
  assert.equal(writes.length, 1);
});
