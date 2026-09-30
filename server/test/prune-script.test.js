import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = fs.readFileSync(new URL('../prune-old-releases.sh', import.meta.url), 'utf8');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  const backups = path.join(dir, 'backups');
  fs.mkdirSync(backups);
  fs.writeFileSync(path.join(dir, 'prune-old-releases.sh'), script, { mode: 0o755 });
  for (const day of ['01', '02', '03', '04', '05']) {
    fs.writeFileSync(path.join(backups, `astek-monitor-manual-backup-202601${day}-000000.tar.gz`), 'x');
    fs.writeFileSync(path.join(backups, `astek-monitor-manual-backup-202601${day}-000000.tar.gz.sha256`), 'x');
  }
  fs.writeFileSync(path.join(dir, 'rollback-container.txt'), 'astek-monitor-stale-2\n');
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh
case "$*" in
 "ps -a --filter status=exited --filter status=created --format {{.Names}}") printf 'astek-monitor-failed-1\\nastek-monitor-stale-2\\nastek-monitor\\nastek-monitor-replaced-9\\n';;
 "images --format {{.Repository}}:{{.Tag}}") printf 'astek-monitor-server:4.4.0\\nastek-monitor-server:4.3.5\\nnode:22-alpine\\n';;
 "ps -a --filter ancestor=astek-monitor-server:4.4.0 --format {{.Names}}") echo astek-monitor;;
 *) echo "docker $*" >> "${path.join(dir, 'docker.log')}";;
esac
`, { mode: 0o755 });
  return { dir, backups };
}
const run = ({ dir, backups }, args = []) => spawnSync('sh', [path.join(dir, 'prune-old-releases.sh'), ...args], {
  env: { ...process.env, ASTEK_BACKUP_DIR: backups, DOCKER: path.join(dir, 'docker'), KEEP_BACKUPS: '3' }, encoding: 'utf8',
});

test('dry run lists leftovers and deletes nothing', () => {
  const box = sandbox();
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN/);
  assert.match(result.stdout, /would remove: .*20260101/);
  assert.match(result.stdout, /would remove: container astek-monitor-failed-1/);
  assert.match(result.stdout, /would remove: image astek-monitor-server:4.3.5/);
  assert.equal(fs.readdirSync(box.backups).length, 10);
  fs.rmSync(box.dir, { recursive: true, force: true });
});

test('apply keeps the newest backups, the rollback target, the live container and images in use', () => {
  const box = sandbox();
  const result = run(box, ['--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(box.backups).filter(f => f.endsWith('.tar.gz')).sort(), [
    'astek-monitor-manual-backup-20260103-000000.tar.gz',
    'astek-monitor-manual-backup-20260104-000000.tar.gz',
    'astek-monitor-manual-backup-20260105-000000.tar.gz',
  ]);
  const log = fs.readFileSync(path.join(box.dir, 'docker.log'), 'utf8');
  assert.match(log, /docker rm astek-monitor-failed-1/);
  assert.doesNotMatch(log, /astek-monitor-stale-2/, 'rollback target must be protected');
  assert.doesNotMatch(log, /docker rm astek-monitor$/m, 'the live container must never be removed');
  assert.doesNotMatch(log, /image rm astek-monitor-server:4.4.0/, 'the image in use must be kept');
  assert.doesNotMatch(log, /prune/, 'never prunes images that belong to other projects');
  fs.rmSync(box.dir, { recursive: true, force: true });
});

test('a non-numeric KEEP_BACKUPS is rejected before anything is touched', () => {
  const box = sandbox();
  const result = spawnSync('sh', [path.join(box.dir, 'prune-old-releases.sh'), '--apply'], { env: { ...process.env, ASTEK_BACKUP_DIR: box.backups, KEEP_BACKUPS: 'x; rm -rf /' }, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(fs.readdirSync(box.backups).length, 10);
  fs.rmSync(box.dir, { recursive: true, force: true });
});
