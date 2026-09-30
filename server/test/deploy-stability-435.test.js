import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {assessHealth, probeHealth, RETRY, LAG} from '../src/deploy-health-probe.js';

const health = () => ({ok: true, version: '4.3.5', runtime: {
  eventLoopMaxMs: 1687, rssMiB: 245, heapUsedMiB: 79,
  storage: {engine: 'sqlite', schemaVersion: 3, integrity: 'ok'}
}});
const upgrade = fs.readFileSync(new URL('../upgrade.sh', import.meta.url), 'utf8');
const stability = upgrade.slice(upgrade.indexOf('log "[7/7]'), upgrade.indexOf('\nmount_source='));

function runStability(codes, restartAt = -1) {
  // Exercise the actual POSIX shell loop, without a daemon or real delays.
  const branches = codes.map((code, i) => `${i + 1}) return ${code} ;;`).join('\n');
  const harness = `set -eu
probe_index=0
sleep(){ :; }
log(){ printf '%s\\n' "$*"; }
diag(){ echo DIAGNOSTICS >&2; }
docker(){
  case "$1" in
    inspect)
      case "$*" in
        *State.Running*) echo true ;;
        *RestartCount*) if [ "$probe_index" -eq ${restartAt} ]; then echo 1; else echo 0; fi ;;
        *) return 1 ;;
      esac ;;
    exec)
      probe_index=$((probe_index+1))
      echo "PROBE $probe_index"
      case "$probe_index" in
        ${branches}
        *) return 0 ;;
      esac ;;
    *) return 1 ;;
  esac
}
${stability}
echo STABILITY_PASSED
`;
  return spawnSync('sh', ['-s'], {input: harness, encoding: 'utf8', timeout: 5000});
}

test('a transient timeout resets the success streak and allows recovery', () => {
  const result = runStability([0, RETRY, 0, 0, 0, 0, 0, 0]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PROBE 8/);
  assert.match(result.stdout, /STABILITY_PASSED/);
});

test('three consecutive unavailable/slow probes fail with diagnostics', () => {
  const result = runStability([RETRY, RETRY, RETRY]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Three consecutive health timeouts\/slow responses/);
  assert.match(result.stderr, /DIAGNOSTICS/);
  assert.doesNotMatch(result.stdout, /STABILITY_PASSED/);
});

test('a rolling startup peak can clear, but persistent lag exhausts the bound', () => {
  const recovery = runStability([...Array(10).fill(LAG), ...Array(6).fill(0)]);
  assert.equal(recovery.status, 0, recovery.stderr);
  const failure = runStability(Array(18).fill(LAG));
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /within 18 probes/);
  assert.match(failure.stderr, /DIAGNOSTICS/);
});

test('intermittent failures cannot pass without six consecutive healthy samples', () => {
  const result = runStability(Array.from({length: 18}, (_, i) => i % 2 ? RETRY : 0));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /within 18 probes/);
});

test('hard probe failures and a restart during the final probe fail immediately', () => {
  assert.equal(runStability([1]).status, 1);
  const result = runStability(Array(6).fill(0), 6);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Server restarted/);
  assert.match(result.stderr, /DIAGNOSTICS/);
});

test('identity, integrity, memory and missing metrics remain hard failures', () => {
  assert.equal(assessHealth(health(), 721).code, 0);
  assert.equal(assessHealth(health(), 4600).code, RETRY);
  const lag = health(); lag.runtime.eventLoopMaxMs = 3500;
  assert.equal(assessHealth(lag, 721).code, LAG);
  for (const change of [
    d => {d.version = '4.3.4';},
    d => {d.ok = false;},
    d => {d.runtime.storage.integrity = 'failed';},
    d => {d.runtime.rssMiB = 601;},
    d => {d.runtime.heapUsedMiB = 361;},
    d => {d.runtime.rssMiB = null;},
    d => {delete d.runtime.eventLoopMaxMs;}
  ]) {
    const data = health(); change(data);
    assert.equal(assessHealth(data, 721).code, 1);
  }
});

test('real HTTP probes bound stalled headers and bodies and reject invalid JSON', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/headers') return;
    if (req.url === '/body') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.write('{');
      return;
    }
    res.end(req.url === '/invalid' ? '{' : JSON.stringify(health()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await probeHealth({url: base, timeoutMs: 2000})).code, 0);
    for (const path of ['/headers', '/body']) {
      const result = await probeHealth({url: base + path, timeoutMs: 100});
      assert.equal(result.code, RETRY);
      assert.ok(result.elapsed < 2000, `Timeout took ${result.elapsed}ms`);
    }
    assert.equal((await probeHealth({url: base + '/invalid'})).code, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
