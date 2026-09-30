import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const upgrade=fs.readFileSync(new URL('../upgrade.sh',import.meta.url),'utf8');
const rollback=fs.readFileSync(new URL('../rollback.sh',import.meta.url),'utf8');

test('4.3.5 updater detects the real port-8080 production container',()=>{
  assert.match(upgrade,/docker ps --filter publish=8080/);
  assert.match(upgrade,/PROD_CONTAINER="\$PORT_OWNER"/);
  assert.match(upgrade,/PROD_CONTAINER" != "astek-monitor"/);
  assert.match(upgrade,/docker rename astek-monitor "\$STALE_CONTAINER"/);
});

test('4.3.5 uses a unique compose project and refuses a second port owner',()=>{
  assert.match(upgrade,/PROJECT_NAME="astek-monitor-435-\$STAMP"/);
  assert.match(upgrade,/Port 8080 is still owned by container/);
  assert.match(upgrade,/COMPOSE_PROJECT_NAME="\$PROJECT_NAME" docker compose up -d --no-build --force-recreate/);
  assert.doesNotMatch(upgrade,/COMPOSE_PROJECT_NAME=astek-monitor-434/);
});

test('rollback can recover when the serving container has a failed/replaced name',()=>{
  assert.match(rollback,/docker ps --filter publish=8080/);
  assert.match(rollback,/CURRENT="\$\(port_8080_container/);
  assert.match(rollback,/CURRENT" != "astek-monitor"/);
});
