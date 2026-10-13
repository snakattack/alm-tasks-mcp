import { lstat, mkdir, open, rename, rm, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { CrmError } from './errors.js';
import { runProgram, type Runner } from './process.js';

export interface FileSecurity { platform?: NodeJS.Platform; runner?: Runner }

async function restrict(path: string, directory: boolean, options: FileSecurity): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') {
    await chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  const script = `$ErrorActionPreference = 'Stop'
$p = $env:ALMOND_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = if ($env:ALMOND_PRIVATE_DIRECTORY -eq '1') { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = if ($env:ALMOND_PRIVATE_DIRECTORY -eq '1') { New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') } else { New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow') }
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl
Write-Output 'ALMOND_ACL_OK'`;
  const result = await (options.runner ?? runProgram)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { ALMOND_PRIVATE_PATH: path, ALMOND_PRIVATE_DIRECTORY: directory ? '1' : '0' });
  if (result.code !== 0 || result.stdout.trim() !== 'ALMOND_ACL_OK') {
    throw new CrmError('CONFIG_ERROR', 'Не удалось ограничить Windows ACL. Учётные данные не записаны.');
  }
}

async function inspect(path: string, directory: boolean, options: FileSecurity, strict = false): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1)) {
    throw new CrmError('CONFIG_ERROR', 'Путь настроек должен быть обычным файлом или каталогом, без ссылок.');
  }
  if ((options.platform ?? process.platform) !== 'win32') {
    if (process.getuid && stat.uid !== process.getuid()) throw new CrmError('CONFIG_ERROR', 'Настройки принадлежат другому пользователю ОС.');
    if (strict && (stat.mode & 0o077) !== 0) throw new CrmError('CONFIG_ERROR', 'Небезопасные права настроек. Выполните chmod 700 для каталога и chmod 600 для файлов ~/.almond-mcp.');
  }
}

export async function ensurePrivateDirectory(directory: string, options: FileSecurity = {}): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await inspect(directory, true, options);
  await restrict(directory, true, options);
}

export async function readPrivateJson(path: string, options: FileSecurity = {}): Promise<unknown | undefined> {
  try {
    await inspect(dirname(path), true, options, true);
    await inspect(path, false, options, true);
    // On Windows verify/restrict the ACL before reading a possible secret.
    if ((options.platform ?? process.platform) === 'win32') {
      await restrict(dirname(path), true, options);
      await restrict(path, false, options);
    }
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { return JSON.parse(await file.readFile('utf8')) as unknown; } finally { await file.close(); }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    if (error instanceof CrmError) throw error;
    throw new CrmError('CONFIG_ERROR', 'Не удалось прочитать настройки. Проверьте формат и права файлов ~/.almond-mcp.');
  }
}

/** Caller secures the parent directory before writing secret contents. */
export async function atomicPrivateJson(path: string, value: unknown, options: FileSecurity = {}): Promise<void> {
  const temporary = join(dirname(path), `.almond-${randomUUID()}.tmp`);
  try {
    try { await inspect(path, false, options); } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const file = await open(temporary, 'wx', 0o600);
    try {
      await restrict(temporary, false, options);
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
