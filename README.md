# alm-tasks-mcp

[![CI](https://github.com/snakattack/alm-tasks-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/snakattack/alm-tasks-mcp/actions/workflows/ci.yml)

[English](#english) · [Русский](#русский)

## English

An unofficial local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for working with Almond CRM tasks. It uses direct HTTP requests and the user's own CRM account; the running server does not need a browser.

### What it does

| Tool | Behavior |
| --- | --- |
| `get_task` | Returns the task description, acceptance criteria, checklist, status, result, participants, discussion, and attachment links. |
| `add_comment` | Adds a message to the task's internal discussion. |
| `submit_result` | Sends a completed result for review. It does not perform final acceptance. |

A task can be identified by a positive numeric ID or its Almond CRM task URL. `get_task` can mark a discussion as read. Comments can trigger CRM notifications. If a write times out or its outcome is unclear, the server reports `OUTCOME_UNKNOWN` and does not retry it automatically; inspect the task before trying again.

### Get started

Requires **Node.js 24+**, npm, and an Almond CRM account.

```bash
git clone https://github.com/snakattack/alm-tasks-mcp.git
cd alm-tasks-mcp
npm ci
npm run build
node dist/cli.js setup
```

Run `setup` in a personal terminal. It verifies your login, stores your credentials locally, and offers to connect Codex, Claude Code, or Claude Desktop. Restart the MCP client after connecting it. The wizard needs a TTY; it does not ask for credentials through chat or command-line arguments.

For another MCP client, run `node dist/cli.js config` to print a configuration snippet without secrets. `node dist/cli.js doctor` checks local setup without network access; add `--login` to check CRM authentication without opening a task. `node dist/cli.js serve` starts the stdio server. See [mcp.config.example.json](./mcp.config.example.json) for a development example using an explicit `.env` file.

### Credentials and limitations

The wizard prefers the OS credential store. If it is unavailable, it offers a private local credentials file with restricted permissions. CRM session cookies remain in process memory. For non-interactive environments, supply `ALMOND_USERNAME` and `ALMOND_PASSWORD` through the process environment or a secret manager. Never commit credentials or `.env` files.

The server supports task reads, internal comments, and submitting results for review. It does not upload attachments, search tasks, or accept submitted work. The parser depends on the CRM's HTML structure and may need an update if that structure changes.

### Development

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

Tests use simulated HTTP responses and anonymized HTML; they do not contact the CRM. `src/` contains the TypeScript server, HTTP client, parser, CLI, and credential handling. `test/` contains the automated tests. `scripts/smoke.mjs` checks a live MCP connection; run it only with a dedicated test task because reading a task can mark its discussion as read:

```bash
npm run build
npm run smoke -- https://almond-app.ru/tasks/YOUR_TEST_TASK_ID
```

This repository is provided for source review. It is not published to npm, and no license is granted.

## Русский

Неофициальный локальный сервер [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) для работы с задачами Almond CRM. Он использует прямые HTTP-запросы и личную учётную запись пользователя; браузер для работы сервера не требуется.

### Возможности

| Инструмент | Действие |
| --- | --- |
| `get_task` | Возвращает описание, критерии приёмки, чек-лист, статус, результат, участников, обсуждение и ссылки на вложения. |
| `add_comment` | Добавляет сообщение во внутреннее обсуждение задачи. |
| `submit_result` | Отправляет готовый результат на проверку. Окончательное принятие не выполняется. |

Задачу можно указать положительным числовым ID или ссылкой на задачу Almond CRM. `get_task` может отметить обсуждение прочитанным. Комментарии могут вызвать уведомления CRM. Если исход записи неизвестен, сервер возвращает `OUTCOME_UNKNOWN` и не повторяет запрос автоматически: перед новой попыткой проверьте задачу.

### Быстрый запуск

Нужны **Node.js 24+**, npm и учётная запись Almond CRM.

```bash
git clone https://github.com/snakattack/alm-tasks-mcp.git
cd alm-tasks-mcp
npm ci
npm run build
node dist/cli.js setup
```

Запускайте `setup` в личном терминале. Мастер проверит вход, сохранит credentials локально и предложит подключить Codex, Claude Code или Claude Desktop. После подключения перезапустите MCP-клиент. Мастеру нужен TTY; пароль не передаётся через чат или аргументы команды.

Для другого MCP-клиента команда `node dist/cli.js config` выводит конфигурацию без секретов. `node dist/cli.js doctor` проверяет локальную настройку без сети; флаг `--login` дополнительно проверяет вход в CRM, не открывая задачу. `node dist/cli.js serve` запускает stdio-сервер. Пример разработки с явным `.env` находится в [mcp.config.example.json](./mcp.config.example.json).

### Credentials и ограничения

Мастер предпочитает системное хранилище credentials. Если оно недоступно, он предлагает личный файл с ограниченными правами. Cookie сессии остаются в памяти процесса. В окружении без интерактивного терминала передавайте `ALMOND_USERNAME` и `ALMOND_PASSWORD` через переменные процесса или менеджер секретов. Не добавляйте credentials и `.env` в Git.

Сервер читает задачи, добавляет внутренние комментарии и сдаёт результат на проверку. Загрузка вложений, поиск задач и окончательное принятие не реализованы. Парсер зависит от HTML-разметки CRM и может потребовать обновления при её изменении.

### Разработка

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

Тесты используют имитацию HTTP и обезличенный HTML, поэтому не обращаются к CRM. В `src/` находятся TypeScript-сервер, HTTP-клиент, парсер, CLI и работа с credentials; в `test/` — автоматические тесты. `scripts/smoke.mjs` проверяет реальное MCP-соединение. Используйте для этого только выделенную тестовую задачу: чтение может отметить обсуждение прочитанным.

```bash
npm run build
npm run smoke -- https://almond-app.ru/tasks/YOUR_TEST_TASK_ID
```

Репозиторий опубликован для просмотра исходного кода. Публикации в npm и лицензии на использование кода нет.
