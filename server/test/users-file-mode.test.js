import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { writeJson } from '../src/utils.js';
import { UserStore } from '../src/entitlements.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'users-mode-'));
config.dataDir = tmp;
const mode = async (f) => (await fs.stat(path.join(tmp, f))).mode & 0o777;

test('users.json and users.json.bak stay 0600 across rewrites, even with umask 0022 and a legacy 0644 file', async () => {
  const previous = process.umask(0o022);
  try {
    // A users.json written before this fix (umask 0022 -> 0644).
    await fs.writeFile(path.join(tmp, 'users.json'), JSON.stringify({ version: 1, users: [] }), { mode: 0o644 });
    await fs.chmod(path.join(tmp, 'users.json'), 0o644);
    const store = new UserStore(); await store.ready;
    const { user } = await store.create({ name: 'Mode check' });
    assert.equal(await mode('users.json'), 0o600);
    assert.equal(await mode('users.json.bak'), 0o600, 'the legacy generation moved to .bak is tightened too');
    await store.update(user.id, { capabilities: ['live.view'] });
    await store.rotateToken(user.id);
    assert.equal(await mode('users.json'), 0o600);
    assert.equal(await mode('users.json.bak'), 0o600);
    const saved = JSON.parse(await fs.readFile(path.join(tmp, 'users.json'), 'utf8'));
    assert.deepEqual(saved.users.map((u) => u.capabilities), [['live.view']], 'content is written as before');
  } finally { process.umask(previous); }
});

test('writeJson without a mode keeps the default file mode (other data files unchanged)', async () => {
  const previous = process.umask(0o022);
  try {
    await writeJson('plain.json', { a: 1 }); await writeJson('plain.json', { a: 2 });
    assert.equal(await mode('plain.json'), 0o644);
    assert.equal(await mode('plain.json.bak'), 0o644);
  } finally { process.umask(previous); }
});
