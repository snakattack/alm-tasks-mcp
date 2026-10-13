import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, chmod, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../dist/credentials.js';
import { loadRuntimeConfig } from '../dist/config.js';
import { atomicPrivateJson, ensurePrivateDirectory } from '../dist/secure-files.js';

const credentials = { username: 'test-user', password: 'stub-secret-only' };
async function directory(t) {
  const parent = await mkdtemp(join(tmpdir(), 'almond-profile-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return join(parent, '.almond-mcp');
}
function keyring() {
  const values = new Map();
  let available = true;
  return { values, disable: () => { available = false; },
    factory: async account => {
      if (!available) throw new Error('locked: stub-secret-only');
      return { getPassword: () => values.get(account) ?? null, setPassword: value => values.set(account, value), deletePassword: () => values.delete(account) };
    } };
}

test('private credentials survive a new store instance with strict Unix permissions', async t => {
  const path = await directory(t);
  await new CredentialStore({ directory: path }).save(credentials, 'file');
  assert.deepEqual(await new CredentialStore({ directory: path }).load(), credentials);
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  for (const file of ['credentials.json', 'config.json']) assert.equal((await stat(join(path, file))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(join(path, 'config.json'), 'utf8')).includes(credentials.password));
});

test('OS storage keeps secrets outside config and never falls back when locked', async t => {
  const path = await directory(t), keys = keyring();
  const store = new CredentialStore({ directory: path, keyFactory: keys.factory });
  assert.equal(await store.keychainAvailable(), true);
  assert.equal(keys.values.size, 0); // probes cleaned up
  await store.save(credentials, 'keychain');
  assert.deepEqual(await store.load(), credentials);
  await assert.rejects(readFile(join(path, 'credentials.json')), { code: 'ENOENT' });
  keys.disable();
  await assert.rejects(store.load(), error => error.code === 'CONFIG_ERROR' && !error.message.includes(credentials.password));
  await assert.rejects(store.save(credentials, 'keychain'), error => error.code === 'CONFIG_ERROR');
  await assert.rejects(readFile(join(path, 'credentials.json')), { code: 'ENOENT' });
});

test('switching backend removes the obsolete credential, and login replaces one profile', async t => {
  const path = await directory(t), keys = keyring();
  const store = new CredentialStore({ directory: path, keyFactory: keys.factory });
  await store.save(credentials, 'file');
  await store.save(credentials, 'keychain');
  await assert.rejects(readFile(join(path, 'credentials.json')), { code: 'ENOENT' });
  await store.save({ username: 'second-user', password: 'second-stub' }, 'keychain');
  assert.equal(keys.values.size, 1);
  await store.save(credentials, 'file');
  assert.equal(keys.values.size, 0);
  assert.deepEqual(await store.load(), credentials);
});

test('unsafe permissions, symlinks and malformed files are rejected without leaking data', async t => {
  const path = await directory(t);
  const store = new CredentialStore({ directory: path });
  await store.save(credentials, 'file');
  await chmod(join(path, 'credentials.json'), 0o644);
  await assert.rejects(store.load(), { code: 'CONFIG_ERROR' });
  await chmod(join(path, 'credentials.json'), 0o600);
  await writeFile(join(path, 'credentials.json'), '{"password":"stub-secret-only"}');
  await assert.rejects(store.load(), error => !error.message.includes(credentials.password));
  await rm(join(path, 'credentials.json'));
  const other = join(path, 'other.json');
  await writeFile(other, JSON.stringify(credentials), { mode: 0o600 });
  await symlink(other, join(path, 'credentials.json'));
  await assert.rejects(store.load(), { code: 'CONFIG_ERROR' });
  await assert.rejects(store.save(credentials, 'file'), { code: 'CONFIG_ERROR' });
  assert.deepEqual(JSON.parse(await readFile(other, 'utf8')), credentials);
});

test('explicit environment wins; partial environment never mixes user identities', async t => {
  const store = new CredentialStore({ directory: await directory(t) });
  await store.save(credentials, 'file');
  assert.equal((await loadRuntimeConfig({}, store)).username, credentials.username);
  assert.equal((await loadRuntimeConfig({ ALMOND_USERNAME: 'env-user', ALMOND_PASSWORD: 'env-stub' }, store)).username, 'env-user');
  await assert.rejects(loadRuntimeConfig({ ALMOND_USERNAME: 'env-user' }, store), { code: 'CONFIG_ERROR' });
  await assert.rejects(loadRuntimeConfig({ ALMOND_PASSWORD: 'env-stub' }, store), { code: 'CONFIG_ERROR' });
  await assert.rejects(loadRuntimeConfig({ ALMOND_TIMEOUT_MS: '0' }, store), { code: 'CONFIG_ERROR' });
});

test('Windows ACL is restricted before any secret bytes are written; failure leaves no file', async t => {
  const path = await directory(t), observed = [];
  const options = { platform: 'win32', runner: async (_command, _args, env) => {
    if (env.ALMOND_PRIVATE_DIRECTORY === '0') observed.push(await readFile(env.ALMOND_PRIVATE_PATH, 'utf8'));
    return { code: 0, stdout: 'ALMOND_ACL_OK\n', stderr: '' };
  } };
  await ensurePrivateDirectory(path, options);
  await atomicPrivateJson(join(path, 'credentials.json'), credentials, options);
  assert.deepEqual(observed, ['']);
  const failed = join(path, 'failed.json');
  await assert.rejects(atomicPrivateJson(failed, credentials, { platform: 'win32', runner: async () => ({ code: 0, stdout: '', stderr: '' }) }), { code: 'CONFIG_ERROR' });
  await assert.rejects(readFile(failed), { code: 'ENOENT' });
});

test('a symlinked profile directory cannot redirect credential writes', async t => {
  const path = await directory(t), other = `${path}-other`;
  await mkdir(other, { mode: 0o700 });
  await symlink(other, path);
  await assert.rejects(new CredentialStore({ directory: path }).save(credentials, 'file'), { code: 'CONFIG_ERROR' });
  await assert.rejects(readFile(join(other, 'credentials.json')), { code: 'ENOENT' });
});
