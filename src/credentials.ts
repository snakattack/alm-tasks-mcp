import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { CrmError } from './errors.js';
import { atomicPrivateJson, ensurePrivateDirectory, readPrivateJson, type FileSecurity } from './secure-files.js';

export interface Credentials { username: string; password: string }
export type Storage = 'keychain' | 'file';
export interface KeyEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}
export type KeyFactory = (account: string) => Promise<KeyEntry>;
export interface StoreOptions extends FileSecurity { directory?: string; keyFactory?: KeyFactory }
interface Profile { version: 1; storage: Storage; account: string }

export function parseCredentials(value: unknown): Credentials {
  if (!value || typeof value !== 'object' || !('username' in value) || !('password' in value)
    || typeof value.username !== 'string' || !value.username.trim() || typeof value.password !== 'string' || !value.password) {
    throw new CrmError('CONFIG_ERROR', 'Учётные данные не найдены или повреждены. Выполните almond-mcp login.');
  }
  return { username: value.username.trim(), password: value.password };
}

async function defaultKeyFactory(account: string): Promise<KeyEntry> {
  const { Entry } = await import('@napi-rs/keyring');
  return new Entry('almond-mcp-tasks', account, { linux: { store: 'secret-service' } });
}

export class CredentialStore {
  readonly directory: string;
  private readonly keyFactory: KeyFactory;
  constructor(private readonly options: StoreOptions = {}) {
    this.directory = options.directory ?? join(homedir(), '.almond-mcp');
    this.keyFactory = options.keyFactory ?? defaultKeyFactory;
  }

  async storage(): Promise<Storage | undefined> { return (await this.profile())?.storage; }

  async keychainAvailable(): Promise<boolean> {
    let entry: KeyEntry | undefined;
    try {
      entry = await this.keyFactory(`probe-${randomUUID()}`);
      const value = randomUUID();
      entry.setPassword(value);
      return entry.getPassword() === value;
    } catch { return false; } finally { try { entry?.deletePassword(); } catch { /* no credentials in probe */ } }
  }

  async load(): Promise<Credentials> {
    const profile = await this.profile();
    if (!profile) throw new CrmError('CONFIG_ERROR', 'Выполните almond-mcp setup в личном терминале или задайте ALMOND_USERNAME и ALMOND_PASSWORD.');
    if (profile.storage === 'file') return parseCredentials(await readPrivateJson(join(this.directory, 'credentials.json'), this.options));
    try {
      const value = (await this.keyFactory(profile.account)).getPassword();
      if (!value) throw new Error('missing');
      return parseCredentials(JSON.parse(value));
    } catch { throw new CrmError('CONFIG_ERROR', 'Системное хранилище заблокировано или недоступно. Разблокируйте его либо выполните almond-mcp login.'); }
  }

  async save(credentials: Credentials, storage: Storage): Promise<void> {
    const validated = parseCredentials(credentials);
    const previous = await this.profile();
    await ensurePrivateDirectory(this.directory, this.options);
    let account = 'file';
    let entry: KeyEntry | undefined;
    if (storage === 'keychain') {
      account = `profile-${randomUUID()}`;
      try {
        entry = await this.keyFactory(account);
        entry.setPassword(JSON.stringify(validated));
        if (entry.getPassword() !== JSON.stringify(validated)) throw new Error('verification');
      } catch {
        try { entry?.deletePassword(); } catch { /* best effort cleanup */ }
        throw new CrmError('CONFIG_ERROR', 'Не удалось сохранить данные в системном хранилище. Файловое хранение автоматически не включено.');
      }
    } else {
      await atomicPrivateJson(join(this.directory, 'credentials.json'), validated, this.options);
    }
    try {
      await atomicPrivateJson(join(this.directory, 'config.json'), { version: 1, storage, account } satisfies Profile, this.options);
    } catch (error) {
      try { entry?.deletePassword(); } catch { /* best effort cleanup */ }
      throw error;
    }
    if (storage === 'keychain') await rm(join(this.directory, 'credentials.json'), { force: true });
    if (previous?.storage === 'keychain') {
      try { (await this.keyFactory(previous.account)).deletePassword(); } catch {
        throw new CrmError('CONFIG_ERROR', 'Новый вход сохранён, но предыдущую запись хранилища удалить не удалось. Проверьте хранилище ОС.');
      }
    }
  }

  private async profile(): Promise<Profile | undefined> {
    const value = await readPrivateJson(join(this.directory, 'config.json'), this.options);
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
      || !('storage' in value) || (value.storage !== 'file' && value.storage !== 'keychain')
      || !('account' in value) || typeof value.account !== 'string' || !value.account) {
      throw new CrmError('CONFIG_ERROR', 'Некорректная конфигурация ~/.almond-mcp/config.json.');
    }
    return value as Profile;
  }
}
