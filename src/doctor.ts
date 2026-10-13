import { access } from 'node:fs/promises';
import { AgentConnector } from './agents.js';
import { loadRuntimeConfig } from './config.js';
import { CredentialStore } from './credentials.js';
import { asCrmError } from './errors.js';
import { AlmondHttpClient } from './http-client.js';

interface DoctorOptions {
  store?: CredentialStore; connector?: AgentConnector; env?: NodeJS.ProcessEnv;
  authenticate?: (config: Awaited<ReturnType<typeof loadRuntimeConfig>>) => Promise<void>;
}

export async function diagnose(network = false, options: DoctorOptions = {}): Promise<{ ok: boolean; checks: object[] }> {
  const store = options.store ?? new CredentialStore();
  const connector = options.connector ?? new AgentConnector();
  const env = options.env ?? process.env;
  const checks: object[] = [];
  let ok = true;
  try {
    await access(connector.launch.command);
    await access(connector.launch.args[0] ?? '');
    checks.push({ check: 'runtime', ok: true, node: process.version });
  } catch { ok = false; checks.push({ check: 'runtime', ok: false, message: 'Node.js или файл MCP недоступен. Повторите setup.' }); }
  try {
    const config = await loadRuntimeConfig(env, store);
    const storage = env.ALMOND_USERNAME !== undefined || env.ALMOND_PASSWORD !== undefined ? 'environment' : await store.storage();
    checks.push({ check: 'credentials', ok: true, storage });
    if (network) {
      await (options.authenticate ?? (async config => new AlmondHttpClient(config).authenticate()))(config);
      checks.push({ check: 'crm-login', ok: true });
    }
  } catch (error) { ok = false; checks.push({ check: 'credentials-or-login', ok: false, error: asCrmError(error).toJSON() }); }
  for (const target of await connector.discover()) {
    try {
      const connected = await connector.status(target);
      checks.push({ check: target.agent, connected });
    } catch (error) { ok = false; checks.push({ check: target.agent, ok: false, error: asCrmError(error).toJSON() }); }
  }
  return { ok, checks };
}
