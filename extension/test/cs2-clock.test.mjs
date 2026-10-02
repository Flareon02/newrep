import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../cs2-clock.js');

const fake = () => { let t = 1000; return { now: () => t, advance: (ms) => { t += ms; }, at: () => t }; };
const live = (roundTime, extra = {}) => ({ roundTime, timerRunning: true, connected: true, mapNum: 1, currentRound: 5, serverNow: 50000, clockAt: 50000, ...extra });

test('monotonic count-down from one anchor: irregular ticks never skip or repeat seconds', () => {
  const f = fake(), c = C.createRoundClock({ now: f.now });
  c.update(live('1:40'), { receivedLocal: f.at() });
  const seen = [];
  for (const step of [130, 870, 1003, 1500, 400, 97, 2000, 999, 1]) { f.advance(step); seen.push(c.text()); }
  // elapsed 130, 1000, 2003, 3503, 3903, 4000, 6000, 6999, 7000 ms of 100 s
  assert.deepEqual(seen, ['1:39', '1:39', '1:37', '1:36', '1:36', '1:36', '1:34', '1:33', '1:33'], 'derived from elapsed time, not a counter');
  const values = []; for (let i = 0; i < 50; i++) { f.advance(37 + (i % 5) * 61); values.push(c.value()); }
  assert.ok(values.every((v, i) => i === 0 || v <= values[i - 1]), 'never goes up');
});

test('the transit age of the reading is accounted (server sent it later than the clock was read)', () => {
  const f = fake(), c = C.createRoundClock({ now: f.now });
  c.update(live('1:00', { clockAt: 50000, serverNow: 52500 }), { receivedLocal: f.at() });
  assert.equal(c.text(), '0:57');
});

test('a delayed update a little behind the running display does not pull the clock back; a real correction does', () => {
  const f = fake(), c = C.createRoundClock({ now: f.now });
  c.update(live('1:40'), { receivedLocal: f.at() });
  f.advance(10000); assert.equal(c.text(), '1:30');
  assert.equal(c.update(live('1:31'), { receivedLocal: f.at() }), 'kept', 'one second behind: delayed packet');
  assert.equal(c.text(), '1:30');
  assert.equal(c.update(live('1:25'), { receivedLocal: f.at() }), 'anchored', 'ahead: applied (time moves forward)');
  assert.equal(c.text(), '1:25');
  assert.equal(c.update(live('1:35'), { receivedLocal: f.at() }), 'anchored', '10 s behind: upstream correction');
  assert.equal(c.text(), '1:35');
  assert.equal(c.update(live('1:55', { currentRound: 6 }), { receivedLocal: f.at() }), 'anchored', 'new round');
  assert.equal(c.text(), '1:55');
  c.update(live('0:40', { currentRound: 6, bomb: 'planted' }), { receivedLocal: f.at() });
  assert.equal(c.text(), '0:40', 'bomb timer replaces the round timer');
});

test('pause freezes, resume continues; a reconnect burst of identical readings does not stutter', () => {
  const f = fake(), c = C.createRoundClock({ now: f.now });
  c.update(live('0:20', { timerRunning: false }), { receivedLocal: f.at() });
  f.advance(5000); assert.equal(c.text(), '0:20', 'buy time / pause');
  c.update(live('1:55'), { receivedLocal: f.at() }); f.advance(2500); assert.equal(c.text(), '1:52');
  const before = c.value(); for (let i = 0; i < 20; i++) c.update(live('1:55'), { receivedLocal: f.at() - 2500 });
  assert.ok(Math.abs(c.value() - before) < 1e-9, 'a burst of the same old reading changes nothing');
});

test('a feed that goes quiet freezes the clock (stale) instead of counting on; the next tick waits for the second boundary', () => {
  const f = fake(), c = C.createRoundClock({ now: f.now, staleAfterMs: 45000 });
  c.update(live('1:40'), { receivedLocal: f.at() });
  f.advance(400); assert.equal(c.nextChangeIn(), 608, 'remaining 99.6 s: the display changes in ~600 ms');
  f.advance(50000); assert.equal(c.stale(), true); assert.equal(c.text(), '0:55', 'frozen 45 s after the last update');
  f.advance(10000); assert.equal(c.text(), '0:55');
  assert.equal(C.format(null), '—:—'); assert.equal(C.secondsOf('1:05.5'), 65.5);
});
