import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../feed-push.js', import.meta.url), 'utf8');
const FeedPush = (() => { const root = {}; vm.runInNewContext(source, { globalThis: root, self: root, window: root, module: undefined, console }); return root.FeedPush; })();

// app.js keeps an `offline` placeholder (events: []) while no snapshot has arrived and the server is unreachable.
// Patches must never be applied on top of it (that produced "LIVE 0 / Матчи не найдены" with a fresh timestamp);
// app.js therefore hands `undefined` to applyProviderPatches, which must refuse it without inventing a snapshot.
test('push patches without a base snapshot do not create an empty snapshot', () => {
  const result = FeedPush.applyProviderPatches(undefined, [{ source: 'astek', sourceEventId: '1', fields: ['scoreText'], scoreText: '1:0' }], { revision: 'r1' }, 123);
  assert.equal(result.ok, false);
  assert.equal(result.snapshot, undefined);
});

test('patches on a real snapshot still apply', () => {
  const snap = { events: [{ source: 'astek', sourceEventId: '1', id: '1', scoreText: '0:0' }], revision: 'r0' };
  const result = FeedPush.applyProviderPatches(snap, [{ source: 'astek', sourceEventId: '1', fields: ['scoreText'], scoreText: '1:0' }], { revision: 'r1' }, 123);
  assert.equal(result.snapshot.events[0].scoreText, '1:0');
  assert.equal(result.snapshot.receivedAt, 123);
});
