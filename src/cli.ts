#!/usr/bin/env node
import { exportedConfig } from './agents.js';
import { diagnose } from './doctor.js';
import { CrmError, asCrmError } from './errors.js';
import { serve } from './runtime.js';
import { runWizard } from './setup.js';
import { VERSION } from './version.js';

const help = `Almond MCP ${VERSION} — Node.js 24+

almond-mcp setup           Личный вход и подключение агентов через терминал
almond-mcp login           Сменить сохранённые учётные данные
almond-mcp doctor          Проверить настройку без обращения к CRM
almond-mcp doctor --login  Дополнительно проверить только вход в CRM
almond-mcp config          Показать JSON подключения без секретов
almond-mcp serve           Запустить MCP через stdio (также команда по умолчанию)

Обновление: npm install --global <источник-новой-версии>
После обновления перезапустите MCP-процессы. Credentials сохраняются отдельно.
На сервере используйте личный терминал, например SSH с TTY.
Пароль не передавайте в чат или аргументы команд.`;

try {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'serve';
  if (['--help', '-h', 'help'].includes(command) && args.length === 1) console.log(help);
  else if (command === '--version' && args.length === 1) console.log(VERSION);
  else if (command === 'serve' && args.length <= 1) await serve();
  else if ((command === 'setup' || command === 'login') && args.length === 1) await runWizard(command);
  else if (command === 'config' && args.length === 1) console.log(JSON.stringify(exportedConfig(), null, 2));
  else if (command === 'doctor' && (args.length === 1 || (args.length === 2 && args[1] === '--login'))) {
    const report = await diagnose(args[1] === '--login');
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } else throw new CrmError('INVALID_ARGUMENT', 'Неизвестная команда или аргументы. Выполните almond-mcp --help.');
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: asCrmError(error).toJSON() })}\n`);
  process.exitCode = 1;
}
