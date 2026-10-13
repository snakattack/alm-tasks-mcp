import { readFile, mkdir, lstat } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CrmError } from './errors.js';
import { atomicPrivateJson } from './secure-files.js';
import { findProgram, runProgram, type Runner } from './process.js';

export const SERVER_NAME = 'almond-tasks';
export type Agent = 'codex' | 'claude-code' | 'claude-desktop';
export interface Launch { command: string; args: string[] }
export interface AgentTarget { agent: Agent; path: string; installed: boolean }
export interface AgentOptions {
  home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; runner?: Runner;
  locate?: typeof findProgram; launch?: Launch;
}

export function launchConfig(): Launch {
  return { command: process.execPath, args: [fileURLToPath(new URL('./cli.js', import.meta.url)), 'serve'] };
}
export function exportedConfig(launch = launchConfig()) { return { mcpServers: { [SERVER_NAME]: launch } }; }

async function readObject(path: string): Promise<Record<string, unknown>> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe file');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('format');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw new CrmError('CONFIG_ERROR', 'Конфигурация агента повреждена или является ссылкой. Исправьте её перед подключением.');
  }
}

function serversIn(value: Record<string, unknown>): Record<string, unknown> {
  const servers = value.mcpServers;
  if (servers === undefined) return {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new CrmError('CONFIG_ERROR', 'Некорректный раздел mcpServers. Конфигурация не изменена.');
  return servers as Record<string, unknown>;
}

export class AgentConnector {
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner: Runner;
  readonly launch: Launch;
  constructor(private readonly options: AgentOptions = {}) {
    this.home = options.home ?? homedir();
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.runner = options.runner ?? runProgram;
    this.launch = options.launch ?? launchConfig();
    if (!isAbsolute(this.launch.command) || !isAbsolute(this.launch.args[0] ?? '')) throw new CrmError('CONFIG_ERROR', 'Подключение требует абсолютных путей к Node.js и MCP.');
  }

  async discover(): Promise<AgentTarget[]> {
    const result: AgentTarget[] = [];
    const locate = this.options.locate ?? findProgram;
    const codex = await locate('codex', this.env);
    const claude = await locate('claude', this.env);
    if (codex) result.push({ agent: 'codex', path: codex, installed: true });
    if (claude) result.push({ agent: 'claude-code', path: claude, installed: true });
    if (this.platform === 'darwin' || this.platform === 'win32') {
      const path = this.desktopPath();
      let installed = false;
      try { await lstat(dirname(path)); installed = true; } catch { /* Desktop may not have been opened yet */ }
      result.push({ agent: 'claude-desktop', path, installed });
    }
    return result;
  }

  async connect(target: AgentTarget, replace: (agent: Agent) => Promise<boolean>): Promise<void> {
    const current = await this.current(target);
    if (this.matches(current)) return;
    if (current !== undefined && !await replace(target.agent)) return;
    if (JSON.stringify(await this.current(target)) !== JSON.stringify(current)) {
      throw new CrmError('CONFIG_ERROR', 'Конфигурация изменилась во время настройки. Повторите подключение.');
    }
    if (target.agent === 'claude-desktop') {
      const config = await readObject(target.path);
      const servers = serversIn(config);
      const latest = servers[SERVER_NAME];
      if (JSON.stringify(latest) !== JSON.stringify(current)) throw new CrmError('CONFIG_ERROR', 'Конфигурация изменилась во время настройки. Повторите подключение.');
      await mkdir(dirname(target.path), { recursive: true });
      await atomicPrivateJson(target.path, { ...config, mcpServers: { ...servers, [SERVER_NAME]: this.launch } }, { platform: this.platform, runner: this.runner });
    } else {
      const args = target.agent === 'codex'
        ? ['mcp', 'add', SERVER_NAME, '--', this.launch.command, ...this.launch.args]
        : ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, JSON.stringify({ type: 'stdio', ...this.launch })];
      // Claude's CLI refuses duplicate names, unlike Codex. Remove only after consent.
      if (target.agent === 'claude-code' && current !== undefined) {
        const removed = await this.runner(target.path, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
        if (removed.code !== 0) throw new CrmError('CONFIG_ERROR', 'Не удалось заменить подключение Claude Code. Остальные настройки не изменены.');
      }
      const result = await this.runner(target.path, args);
      if (result.code !== 0) {
        if (target.agent === 'claude-code' && current !== undefined) {
          await this.restoreClaude(current);
        }
        throw new CrmError('CONFIG_ERROR', 'CLI агента не подтвердил сохранение подключения. Проверьте его установку и права настройки.');
      }
    }
    if (!this.matches(await this.current(target))) {
      if (target.agent === 'claude-code' && current !== undefined) await this.restoreClaude(current);
      throw new CrmError('CONFIG_ERROR', 'Подключение не подтверждено после записи. Выполните almond-mcp doctor.');
    }
  }

  async status(target: AgentTarget): Promise<boolean> { return this.matches(await this.current(target)); }

  private matches(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const launch = 'transport' in value && value.transport && typeof value.transport === 'object' ? value.transport : value;
    if (!('command' in launch) || !('args' in launch)) return false;
    const env = 'env' in launch ? launch.env : undefined;
    const envVars = 'env_vars' in launch ? launch.env_vars : undefined;
    return launch.command === this.launch.command && JSON.stringify(launch.args) === JSON.stringify(this.launch.args)
      && (!env || (typeof env === 'object' && Object.keys(env).length === 0))
      && (!envVars || (Array.isArray(envVars) && envVars.length === 0))
      && (!('enabled' in value) || value.enabled !== false);
  }

  private async restoreClaude(previous: unknown): Promise<void> {
    const path = join(this.home, '.claude.json');
    const config = await readObject(path);
    const servers = serversIn(config);
    if (servers[SERVER_NAME] !== undefined && !this.matches(servers[SERVER_NAME])) {
      throw new CrmError('CONFIG_ERROR', 'Во время замены подключение Claude Code изменилось. Проверьте almond-tasks вручную.');
    }
    // Restore secrets through a private file, never through CLI arguments.
    await atomicPrivateJson(path, { ...config, mcpServers: { ...servers, [SERVER_NAME]: previous } }, { platform: this.platform, runner: this.runner });
  }

  private async current(target: AgentTarget): Promise<unknown> {
    if (target.agent === 'claude-desktop') return serversIn(await readObject(target.path))[SERVER_NAME];
    if (target.agent === 'claude-code') return serversIn(await readObject(join(this.home, '.claude.json')))[SERVER_NAME];
    const result = await this.runner(target.path, ['mcp', 'get', SERVER_NAME, '--json']);
    if (result.code !== 0 && /not found|no mcp server|does not exist/i.test(result.stderr)) return undefined;
    if (result.code !== 0) throw new CrmError('CONFIG_ERROR', 'Не удалось прочитать пользовательское подключение Codex. Проверьте CLI и config.toml.');
    try { return JSON.parse(result.stdout) as unknown; } catch {
      throw new CrmError('CONFIG_ERROR', 'CLI Codex вернул некорректный ответ. Конфигурация не изменена.');
    }
  }

  private desktopPath(): string {
    return this.platform === 'win32'
      ? join(this.env.APPDATA ?? join(this.home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
      : join(this.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
}
