import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface ProcessResult { code: number; stdout: string; stderr: string }
export type Runner = (command: string, args: string[], extraEnv?: NodeJS.ProcessEnv) => Promise<ProcessResult>;

/** Never include subprocess output or arguments in public errors. */
export const runProgram: Runner = (command, args, extraEnv = {}) => new Promise(resolveResult => {
  const env = { ...process.env, ...extraEnv };
  // Agent CLIs and ACL helpers never need the CRM password.
  delete env.ALMOND_USERNAME;
  delete env.ALMOND_PASSWORD;
  let executable = command;
  let parameters = args;
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command)) {
    executable = 'powershell.exe';
    parameters = ['-NoProfile', '-NonInteractive', '-Command',
      '$a = @(ConvertFrom-Json $env:ALMOND_TOOL_ARGS); & $env:ALMOND_TOOL @a; exit $LASTEXITCODE'];
    env.ALMOND_TOOL = command;
    env.ALMOND_TOOL_ARGS = JSON.stringify(args);
  }
  const child = spawn(executable, parameters, { env, cwd: homedir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill(), 30_000);
  child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 1_000_000) child.kill(); });
  child.stderr.on('data', chunk => { stderr += String(chunk); if (stderr.length > 1_000_000) child.kill(); });
  child.on('error', () => { clearTimeout(timer); resolveResult({ code: -1, stdout: '', stderr: '' }); });
  child.on('close', code => { clearTimeout(timer); resolveResult({ code: code ?? -1, stdout, stderr }); });
});

export async function findProgram(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1'] : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const path = resolve(join(directory, `${name}${extension}`));
      try { await access(path, process.platform === 'win32' ? 0 : 1); return path; } catch { /* next PATH entry */ }
    }
  }
  return undefined;
}
