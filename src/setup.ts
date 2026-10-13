import { AgentConnector, exportedConfig } from './agents.js';
import { loadConfig } from './config.js';
import { CredentialStore, type Credentials, type Storage } from './credentials.js';
import { CrmError, asCrmError } from './errors.js';
import { AlmondHttpClient } from './http-client.js';
import { TerminalPrompts, type Prompts } from './prompts.js';

interface WizardOptions {
  prompts?: Prompts;
  store?: Pick<CredentialStore, 'storage' | 'keychainAvailable' | 'save'>;
  connector?: Pick<AgentConnector, 'discover' | 'connect' | 'status' | 'launch'>;
  authenticate?: (credentials: Credentials) => Promise<void>;
}

export async function runWizard(command: 'setup' | 'login', options: WizardOptions = {}): Promise<void> {
  const prompts = options.prompts ?? new TerminalPrompts();
  prompts.assertInteractive();
  const store = options.store ?? new CredentialStore();
  const connector = options.connector ?? new AgentConnector();
  let storage = await store.storage();
  if (storage) {
    prompts.write(`Сейчас используется ${storage === 'file' ? 'личный файл без шифрования' : 'системное хранилище ОС'}.`);
    if (await prompts.confirm('Изменить способ хранения?')) storage = undefined;
  }
  if (!storage) storage = await selectStorage(prompts, store);
  prompts.write('Вход в https://almond-app.ru под вашей личной учётной записью.');
  let username = '';
  while (!username) username = (await prompts.ask('Логин CRM: ')).trim();
  let password = '';
  while (!password) password = await prompts.password('Пароль CRM (ввод скрыт): ');
  const credentials = { username, password };
  const authenticate = options.authenticate ?? (async (credentials: Credentials) => {
    const config = loadConfig({ ...process.env, ALMOND_USERNAME: credentials.username, ALMOND_PASSWORD: credentials.password });
    await new AlmondHttpClient(config).authenticate();
  });
  await authenticate(credentials);
  await store.save(credentials, storage);
  password = '';
  credentials.password = '';
  prompts.write('Вход подтверждён; учётные данные сохранены.');
  if (command === 'login') {
    prompts.write('Перезапустите работающие MCP-процессы, чтобы использовать новые учётные данные.');
    return;
  }
  let failures = 0;
  const targets = await connector.discover();
  if (!targets.some(target => target.agent === 'codex')) prompts.write('Codex CLI не найден в PATH. Для автоматического подключения установите CLI и повторите setup.');
  if (!targets.some(target => target.agent === 'claude-code')) prompts.write('Claude Code CLI не найден в PATH. Для автоматического подключения установите CLI и повторите setup.');
  for (const target of targets) {
    const label = `${target.agent}${target.installed ? '' : ' (конфигурация пока не обнаружена)'}`;
    if (!await prompts.confirm(`Подключить ${label} для всех проектов?`, target.installed)) continue;
    try {
      await connector.connect(target, agent => prompts.confirm(`Подключение ${agent} с именем almond-tasks уже существует. Заменить его?`));
      if (await connector.status(target)) {
        prompts.write(`${target.agent}: подключение подтверждено.${target.agent === 'claude-desktop' ? ' Перезапустите Claude Desktop.' : ''}`);
      } else prompts.write(`${target.agent}: существующее подключение оставлено без изменений.`);
    } catch (error) {
      failures++;
      prompts.write(`${target.agent}: ${asCrmError(error).message}`);
    }
  }
  prompts.write('Конфигурация для других MCP-клиентов (без учётных данных):');
  prompts.write(JSON.stringify(exportedConfig(connector.launch), null, 2));
  if (failures) throw new CrmError('CONFIG_ERROR', 'Учётные данные сохранены, но часть подключений не настроена. Повторите setup или используйте показанный JSON.');
}

async function selectStorage(prompts: Prompts, store: Pick<CredentialStore, 'keychainAvailable'>): Promise<Storage> {
  if (await store.keychainAvailable()) {
    if (await prompts.confirm('Сохранить пароль в системном хранилище ОС?', true)) return 'keychain';
  } else prompts.write('Постоянное системное хранилище недоступно.');
  prompts.write('Личный файл ~/.almond-mcp/credentials.json хранит пароль без шифрования; доступ ограничивается вашим пользователем ОС.');
  if (await prompts.confirm('Использовать личный файл?')) return 'file';
  throw new CrmError('CONFIG_ERROR', 'Данные не сохранены. Настройте хранилище ОС или используйте ALMOND_USERNAME и ALMOND_PASSWORD в окружении.');
}
