import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const configUrl = new URL('../src/config.js', import.meta.url).href;
const hostFor = (value) => {
  const env = { ...process.env }; delete env.HOST; if (value !== undefined) env.HOST = value;
  return execFileSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(configUrl)}).then((m) => process.stdout.write(m.config.host))`], { env, cwd: fileURLToPath(new URL('..', import.meta.url)) }).toString();
};

test('HOST: unset keeps 0.0.0.0 (Docker); loopback values bind locally; anything invalid fails closed to 127.0.0.1', () => {
  assert.equal(hostFor(undefined), '0.0.0.0');
  assert.equal(hostFor(''), '0.0.0.0');
  assert.equal(hostFor('127.0.0.1'), '127.0.0.1');
  assert.equal(hostFor('localhost'), '127.0.0.1');
  assert.equal(hostFor('::1'), '::1');
  assert.equal(hostFor('127.0.0.l'), '127.0.0.1', 'a typo never exposes the API publicly');
  assert.equal(hostFor('api.example.com'), '127.0.0.1');
});
