import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentConnector, SERVER_NAME, exportedConfig } from '../dist/agents.js';

const launch = { command: '/absolute/node with spaces', args: ['/absolute/installed package/dist/cli.js', 'serve'] };
async function home(t) {
  const path = await mkdtemp(join(tmpdir(), 'almond-agents-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));

test('Codex uses its CLI with absolute argument boundaries and is idempotent', async t => {
  const calls = []; let current;
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[1] === 'get') return current ? { code: 0, stdout: JSON.stringify(current), stderr: '' }
      : { code: 1, stdout: '', stderr: 'Error: No MCP server named almond-tasks found.' };
    current = { name: SERVER_NAME, enabled: true, transport: { type: 'stdio', command: args[4], args: args.slice(5), env: null } };
    return { code: 0, stdout: '', stderr: '' };
  };
  const connector = new AgentConnector({ home: await home(t), launch, runner });
  const target = { agent: 'codex', path: '/codex', installed: true };
  await connector.connect(target, async () => { throw new Error('no conflict expected'); });
  await connector.connect(target, async () => { throw new Error('no conflict expected'); });
  assert.equal(await connector.status(target), true);
  assert.deepEqual(calls.filter(c => c[1] === 'add'), [['mcp', 'add', SERVER_NAME, '--', launch.command, ...launch.args]]);
});

test('foreign Codex entry requires consent and races abort rather than overwrite', async t => {
  let current = { transport: { command: '/other', args: [], env: { PASSWORD: 'old-stub' } } };
  const calls = [];
  const connector = new AgentConnector({ home: await home(t), launch, runner: async (_command, args) => {
    calls.push(args); return { code: 0, stdout: JSON.stringify(current), stderr: '' };
  } });
  const target = { agent: 'codex', path: '/codex', installed: true };
  await connector.connect(target, async () => false);
  assert.equal(calls.filter(c => c[1] === 'add').length, 0);
  await assert.rejects(connector.connect(target, async () => { current = { transport: { command: '/changed', args: [] } }; return true; }), { code: 'CONFIG_ERROR' });
  assert.equal(calls.filter(c => c[1] === 'add').length, 0);
});

test('Claude Code registers at user scope and preserves unrelated settings', async t => {
  const path = await home(t), configPath = join(path, '.claude.json');
  const original = { theme: 'dark', projects: { '/project': { trusted: true } }, mcpServers: { other: { command: '/other' } } };
  await writeFile(configPath, JSON.stringify(original));
  const calls = [];
  const connector = new AgentConnector({ home: path, launch, runner: async (_command, args) => {
    calls.push(args);
    const config = await json(configPath);
    config.mcpServers[SERVER_NAME] = JSON.parse(args[5]);
    await writeFile(configPath, JSON.stringify(config));
    return { code: 0, stdout: '', stderr: '' };
  } });
  await connector.connect({ agent: 'claude-code', path: '/claude', installed: true }, async () => false);
  assert.deepEqual(calls[0].slice(0, 5), ['mcp', 'add-json', '--scope', 'user', SERVER_NAME]);
  const config = await json(configPath);
  assert.deepEqual(config.projects, original.projects);
  assert.deepEqual(config.mcpServers.other, original.mcpServers.other);
  assert.equal(config.mcpServers[SERVER_NAME].command, launch.command);
});

test('failed Claude replacement restores the old entry without secrets in process arguments', async t => {
  const path = await home(t), configPath = join(path, '.claude.json');
  const previous = { command: '/old', args: [], env: { SECRET: 'old-stub-secret' } };
  await writeFile(configPath, JSON.stringify({ mcpServers: { [SERVER_NAME]: previous, other: { command: '/other' } } }));
  const calls = [];
  const connector = new AgentConnector({ home: path, launch, runner: async (_command, args) => {
    calls.push(args);
    if (args[1] === 'remove') {
      const config = await json(configPath); delete config.mcpServers[SERVER_NAME];
      config.newSetting = true;
      await writeFile(configPath, JSON.stringify(config));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'stub failure' };
  } });
  await assert.rejects(connector.connect({ agent: 'claude-code', path: '/claude', installed: true }, async () => true), { code: 'CONFIG_ERROR' });
  const config = await json(configPath);
  assert.deepEqual(config.mcpServers[SERVER_NAME], previous);
  assert.equal(config.newSetting, true);
  assert.equal(config.mcpServers.other.command, '/other');
  assert.ok(!JSON.stringify(calls).includes('old-stub-secret'));
});

test('Desktop merges JSON, supports spaces, and preserves a declined conflicting entry', async t => {
  const path = await home(t), desktop = join(path, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  await mkdir(join(path, 'Library', 'Application Support', 'Claude'), { recursive: true });
  const original = { preferences: { theme: 'dark' }, mcpServers: { other: { command: '/other' }, [SERVER_NAME]: { command: '/foreign' } } };
  await writeFile(desktop, JSON.stringify(original));
  const connector = new AgentConnector({ home: path, platform: 'darwin', launch, locate: async () => undefined });
  const [target] = await connector.discover();
  assert.equal(target.agent, 'claude-desktop');
  await connector.connect(target, async () => false);
  assert.deepEqual(await json(desktop), original);
  await connector.connect(target, async () => true);
  const updated = await json(desktop);
  assert.deepEqual(updated.preferences, original.preferences);
  assert.deepEqual(updated.mcpServers.other, original.mcpServers.other);
  assert.deepEqual(updated.mcpServers[SERVER_NAME], launch);
});

test('malformed Desktop configuration is never overwritten and Linux has no Desktop target', async t => {
  const path = await home(t), desktop = join(path, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  await mkdir(join(path, 'Library', 'Application Support', 'Claude'), { recursive: true });
  await writeFile(desktop, '{malformed');
  const connector = new AgentConnector({ home: path, platform: 'darwin', launch, locate: async () => undefined });
  const [target] = await connector.discover();
  await assert.rejects(connector.connect(target, async () => true), { code: 'CONFIG_ERROR' });
  assert.equal(await readFile(desktop, 'utf8'), '{malformed');
  assert.deepEqual(await new AgentConnector({ home: path, platform: 'linux', launch, locate: async () => undefined }).discover(), []);
});

test('CLI returning success without a confirmed configuration is rejected', async t => {
  const connector = new AgentConnector({ home: await home(t), launch, runner: async () => ({ code: 0, stdout: '', stderr: '' }) });
  await assert.rejects(connector.connect({ agent: 'codex', path: '/codex', installed: true }, async () => true), { code: 'CONFIG_ERROR' });
  assert.deepEqual(exportedConfig(launch), { mcpServers: { [SERVER_NAME]: launch } });
});
