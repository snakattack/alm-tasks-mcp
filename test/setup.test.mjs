import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readHidden, TerminalPrompts } from '../dist/prompts.js';
import { runWizard } from '../dist/setup.js';
import { AlmondHttpClient } from '../dist/http-client.js';
import { CrmError } from '../dist/errors.js';
import { config, loginReply } from './support/fixtures.mjs';

function wizard({ storage, available = false, confirms = [], targets = [], authError } = {}) {
  const calls = [], messages = [];
  const prompts = { assertInteractive() {}, ask: async () => 'test-user', password: async () => 'stub-secret-only',
    confirm: async () => confirms.shift() ?? false, write: message => messages.push(message) };
  const store = { storage: async () => storage, keychainAvailable: async () => available,
    save: async (credentials, selected) => calls.push({ operation: 'save', credentials: { ...credentials }, selected }) };
  const connector = { launch: { command: '/node', args: ['/installed/cli.js', 'serve'] },
    discover: async () => targets, connect: async target => calls.push({ operation: 'connect', agent: target.agent }), status: async () => true };
  const authenticate = async credentials => { calls.push({ operation: 'authenticate', credentials: { ...credentials } }); if (authError) throw authError; };
  return { options: { prompts, store, connector, authenticate }, calls, messages };
}

test('CLI wizard verifies credentials before persisting and connecting selected agents', async () => {
  const w = wizard({ confirms: [true, true], targets: [{ agent: 'codex', path: '/codex', installed: true }] });
  await runWizard('setup', w.options);
  assert.deepEqual(w.calls.map(c => c.operation), ['authenticate', 'save', 'connect']);
  assert.equal(w.calls[1].selected, 'file');
  assert.equal(w.calls[1].credentials.password, 'stub-secret-only');
  assert.ok(!w.messages.join('\n').includes('stub-secret-only'));
  assert.ok(w.messages.join('\n').includes('mcpServers'));
});

test('failed authentication and declined file fallback do not save credentials or configure agents', async () => {
  const failed = wizard({ available: true, confirms: [true], authError: new CrmError('AUTH_FAILED', 'Вход не подтверждён.') });
  await assert.rejects(runWizard('setup', failed.options), { code: 'AUTH_FAILED' });
  assert.deepEqual(failed.calls.map(c => c.operation), ['authenticate']);
  const declined = wizard();
  await assert.rejects(runWizard('setup', declined.options), { code: 'CONFIG_ERROR' });
  assert.equal(declined.calls.length, 0);
});

test('login preserves the selected backend and does not reconfigure agents', async () => {
  const w = wizard({ storage: 'keychain', confirms: [false], targets: [{ agent: 'codex', installed: true }] });
  await runWizard('login', w.options);
  assert.deepEqual(w.calls.map(c => c.operation), ['authenticate', 'save']);
  assert.equal(w.calls[1].selected, 'keychain');
});

test('authenticate sends only login and never opens a CRM task', async () => {
  const requests = [];
  const http = new AlmondHttpClient(config, async (url, init) => { requests.push({ url, init }); return loginReply(); });
  await http.authenticate();
  await http.authenticate();
  assert.deepEqual(requests.map(r => new URL(r.url).pathname), ['/login']);
});

test('noninteractive setup fails before prompts, authentication or file writes', async () => {
  const w = wizard();
  w.options.prompts = new TerminalPrompts(new PassThrough(), new PassThrough());
  await assert.rejects(runWizard('setup', w.options), error => error.code === 'CONFIG_ERROR' && error.message.includes('терминал'));
  assert.equal(w.calls.length, 0);
});

test('password entry hides all characters and restores terminal mode', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; input.isRaw = false;
  const modes = []; input.setRawMode = mode => { modes.push(mode); input.isRaw = mode; };
  let rendered = ''; output.on('data', chunk => { rendered += chunk; });
  const result = readHidden(input, output, 'Password: ');
  input.emit('keypress', 'секрет🙂', {});
  input.emit('keypress', undefined, { name: 'backspace' });
  input.emit('keypress', '!', {});
  input.emit('keypress', '\r', { name: 'return' });
  assert.equal(await result, 'секрет!');
  assert.equal(rendered, 'Password: \n');
  assert.deepEqual(modes, [true, false]);
});

test('cancelled hidden input restores terminal mode and excludes the partial password', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; input.isRaw = false; input.setRawMode = mode => { input.isRaw = mode; };
  let rendered = ''; output.on('data', chunk => { rendered += chunk; });
  const result = readHidden(input, output, 'Password: ');
  input.emit('keypress', 'stub-secret-only', {});
  input.emit('keypress', undefined, { name: 'c', ctrl: true });
  await assert.rejects(result, error => !error.message.includes('stub-secret-only'));
  assert.equal(input.isRaw, false);
  assert.equal(rendered, 'Password: \n');
});
