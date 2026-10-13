import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialStore } from '../dist/credentials.js';
import { AgentConnector } from '../dist/agents.js';
import { diagnose } from '../dist/doctor.js';

test('doctor defaults to offline checks and never reveals credentials', async t => {
  const path = await mkdtemp(join(tmpdir(), 'almond-doctor-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const store = new CredentialStore({ directory: join(path, 'profile') });
  await store.save({ username: 'test-user', password: 'stub-secret-only' }, 'file');
  const connector = new AgentConnector({ home: path, platform: 'linux', locate: async () => undefined });
  let logins = 0;
  const options = { store, connector, env: {}, authenticate: async () => { logins++; } };
  const offline = await diagnose(false, options);
  assert.equal(offline.ok, true);
  assert.equal(logins, 0);
  assert.ok(!JSON.stringify(offline).includes('stub-secret-only'));
  const online = await diagnose(true, options);
  assert.equal(logins, 1);
  assert.equal(online.ok, true);
  assert.ok(!JSON.stringify(online).includes('stub-secret-only'));
});

test('doctor reports missing setup safely without network requests', async t => {
  const path = await mkdtemp(join(tmpdir(), 'almond-doctor-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const report = await diagnose(false, { env: {}, store: new CredentialStore({ directory: join(path, 'missing') }),
    connector: new AgentConnector({ home: path, platform: 'linux', locate: async () => undefined }) });
  assert.equal(report.ok, false);
  assert.ok(JSON.stringify(report).includes('almond-mcp setup'));
});
