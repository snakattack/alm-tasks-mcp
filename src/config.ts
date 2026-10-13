import { CrmError } from './errors.js';
import { CredentialStore } from './credentials.js';

export const CRM_ORIGIN = 'https://almond-app.ru';

export interface Config {
  username: string;
  password: string;
  timeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const username = env.ALMOND_USERNAME?.trim();
  const password = env.ALMOND_PASSWORD;
  if (!username || !password) {
    throw new CrmError('CONFIG_ERROR', 'Укажите ALMOND_USERNAME и ALMOND_PASSWORD в окружении или локальном .env.');
  }
  const timeoutMs = Number(env.ALMOND_TIMEOUT_MS ?? 30_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new CrmError('CONFIG_ERROR', 'ALMOND_TIMEOUT_MS должен быть целым числом от 1 до 300000.');
  }
  return { username, password, timeoutMs };
}

export async function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env, store = new CredentialStore()): Promise<Config> {
  // A partial explicit configuration is an error, never a mix of two accounts.
  if (env.ALMOND_USERNAME !== undefined || env.ALMOND_PASSWORD !== undefined) return loadConfig(env);
  const credentials = await store.load();
  return loadConfig({ ...env, ALMOND_USERNAME: credentials.username, ALMOND_PASSWORD: credentials.password });
}
