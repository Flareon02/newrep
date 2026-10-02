import test from 'node:test';
import assert from 'node:assert/strict';
import { GgbetLiveCollector, MIN_HEALTHY_SESSION_MS as GG_HEALTHY } from '../src/ggbet.js';
import { DatabetLiveCollector, MIN_HEALTHY_SESSION_MS as DB_HEALTHY } from '../src/databet.js';
import { SnapshotState } from '../src/state.js';
import { config } from '../src/config.js';

// No network: reconnects are captured instead of scheduled, time is a fake clock.
function harness(Collector, options = {}) {
  let t = 10_000_000;
  const state = new SnapshotState('t-pacing-' + Math.random(), 60000); state.persist = async () => {};
  const c = new Collector(state, { now: () => t, ...options });
  c.stopped = false;
  const delays = []; c.scheduleReconnect = (d) => delays.push(d);
  return { c, delays, advance: (ms) => { t += ms; }, now: () => t };
}
const QUICK_MAX = Math.round(500 * 1.15);

for (const [name, Collector, healthy, maxBackoff] of [['GGBET', GgbetLiveCollector, GG_HEALTHY, () => config.ggbetMaxBackoffMs], ['DataBet', DatabetLiveCollector, DB_HEALTHY, () => config.databetMaxBackoffMs]]) {
  test(`${name}: a healthy long session refreshes its token at once (scheduled refresh 4001 / auth close 4401)`, () => {
    for (const code of [4001, 4401]) {
      const h = harness(Collector);
      h.c.lastConnectAt = h.now() - healthy - 1000; h.c.failures = 0;
      h.c.handleClose({ code });
      assert.ok(h.delays[0] <= QUICK_MAX, `${code}: ${h.delays[0]} ms`);
    }
  });

  test(`${name}: a token rejected again and again backs off exponentially instead of reconnecting every 0.5 s`, () => {
    const h = harness(Collector);
    for (let i = 0; i < 8; i++) {
      h.c.lastConnectAt = h.now(); h.c.failures = 0;   // every new session is acked (failures reset) and dies at once
      h.advance(1500);
      h.c.handleClose({ code: 4401, reason: 'refresh-token' });
      h.advance(h.delays.at(-1));
    }
    assert.ok(h.delays[1] >= 2 * 1000 * 0.85, `second retry ${h.delays[1]} ms`);
    for (let i = 2; i < h.delays.length; i++) assert.ok(h.delays[i] >= Math.min(maxBackoff(), 1000 * 2 ** Math.min(6, i + 1)) * 0.85 - 1, `retry ${i + 1}: ${h.delays[i]} ms`);
    assert.ok(h.delays.at(-1) >= maxBackoff() * 0.85, 'capped at the maximum back-off');
    const total = h.delays.reduce((s, d) => s + d, 0);
    assert.ok(total > 3 * 60000, `8 rejected sessions spread over ${Math.round(total / 1000)} s, not seconds`);
    assert.equal(h.c.status().shortSessions, 8);
  });

  test(`${name}: connection_error already scheduled a back-off; the following 4401 close does not shorten it`, () => {
    const h = harness(Collector);
    h.c.lastConnectAt = h.now(); h.c.failures = 1;     // the connect() catch counted the rejected init
    h.advance(300);
    h.c.handleClose({ code: 4401, reason: 'refresh-token' });
    assert.ok(h.delays[0] >= 4000 * 0.85, `${h.delays[0]} ms`);
  });

  test(`${name}: sessions that are acked and then dropped right away do not loop every 2 s`, () => {
    const h = harness(Collector);
    for (let i = 0; i < 6; i++) { h.c.lastConnectAt = h.now(); h.c.failures = 0; h.advance(2000); h.c.handleClose({ code: 1006 }); h.advance(h.delays.at(-1)); }
    assert.ok(h.delays.at(-1) >= 30000, `last delay ${h.delays.at(-1)} ms`);
    // A long healthy session afterwards resets the streak.
    h.c.lastConnectAt = h.now() - healthy - 1; h.c.failures = 0; h.c.handleClose({ code: 4001 });
    assert.ok(h.delays.at(-1) <= QUICK_MAX);
  });
}

test('GGBET bootstrap: 403/407/429 or a proxy failure cost one request per attempt; the next attempt starts with the next mirror', async () => {
  const old = { origins: config.ggbetOrigins, mode: config.ggbetNetworkModeSetting, relay: config.ggbetBootstrapRelayUrl };
  config.ggbetOrigins = ['https://a.gg.bet', 'https://b.gg.bet', 'https://c.gg.bet']; config.ggbetNetworkModeSetting = 'direct'; config.ggbetBootstrapRelayUrl = '';
  try {
    for (const status of [403, 407, 429]) {
      const calls = [];
      const h = harness(GgbetLiveCollector, { trustedOrigins: config.ggbetOrigins, fetchImpl: async (url) => { calls.push(new URL(url).hostname); return { ok: false, status, text: async () => '' }; } });
      await assert.rejects(() => h.c.fetchBootstrap(true), new RegExp(`HTTP ${status}`));
      assert.deepEqual(calls, ['a.gg.bet'], `${status}: one request`);
      await assert.rejects(() => h.c.fetchBootstrap(true));
      assert.deepEqual(calls, ['a.gg.bet', 'b.gg.bet'], `${status}: the next attempt rotates to the next mirror`);
    }
    // A mirror-specific failure (404, network error) still falls through to the other mirrors within one attempt.
    const calls = [];
    const h = harness(GgbetLiveCollector, { trustedOrigins: config.ggbetOrigins, fetchImpl: async (url) => { calls.push(new URL(url).hostname); if (calls.length === 1) throw new Error('getaddrinfo ENOTFOUND'); return { ok: false, status: 404, text: async () => '' }; } });
    await assert.rejects(() => h.c.fetchBootstrap(true));
    assert.deepEqual(calls, ['a.gg.bet', 'b.gg.bet', 'c.gg.bet']);
  } finally { config.ggbetOrigins = old.origins; config.ggbetNetworkModeSetting = old.mode; config.ggbetBootstrapRelayUrl = old.relay; }
});
