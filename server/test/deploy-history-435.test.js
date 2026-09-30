import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const upgrade=fs.readFileSync(new URL('../upgrade.sh',import.meta.url),'utf8');

test('4.3.5 deployment smoke test accepts intentional retryable History deferral',()=>{
  assert.match(upgrade,/hr\.status===503&&hd\?\.retryable===true/);
  assert.match(upgrade,/DEFERRED: realtime queue has priority \(expected\)/);
});

test('4.3.5 still treats LIVE, prematch and league UI endpoints as critical',()=>{
  assert.match(upgrade,/const critical=\["\/api\/ui\/live\?compact=1&thin=1","\/api\/ui\/prematch\?compact=1&thin=1","\/api\/ui\/leagues\?limit=20&thin=1"\]/);
  assert.match(upgrade,/if\(!r\.ok\|\|d\.serverUi!==true/);
});

test('4.3.5 stability health probe remains bounded and checks one-core limits',()=>{
  const probe=fs.readFileSync(new URL('../src/deploy-health-probe.js',import.meta.url),'utf8');
  assert.match(probe,/timeoutMs = 5000/);
  assert.match(probe,/loop > 3000/);
  assert.match(probe,/rss > 600 \|\| heap > 360/);
});
