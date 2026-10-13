import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { asCrmError } from './errors.js';
import type { TaskService } from './task-service.js';
import { VERSION } from './version.js';

const task = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().min(1)])
  .describe('Положительный ID, строка с ID или ссылка https://almond-app.ru/tasks/{id}.');
const text = z.string().refine(value => value.trim().length > 0, 'Текст не должен быть пустым.');

type Service = Pick<TaskService, 'getTask' | 'addComment' | 'submitResult'>;

export function createServer(service: Service): McpServer {
  const server = new McpServer({ name: 'almond-mcp-tasks', version: VERSION });
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  server.registerTool('get_task', {
    title: 'Прочитать задачу Almond',
    description: 'Получить описание, критерии приёмки, статус, результат, участников, обсуждение, события и ссылки на вложения. CRM фиксирует просмотр и может отметить обсуждение прочитанным.',
    inputSchema: { task }, annotations,
  }, ({ task }) => respond(() => service.getTask(task)));
  server.registerTool('add_comment', {
    title: 'Добавить внутренний комментарий',
    description: 'Добавить текст в Обсуждение задачи Almond. Может вызвать уведомления участников. Не отправляет сообщение в клиентскую ветку. После неизвестного исхода не повторять без проверки обсуждения.',
    inputSchema: { task, text: text.describe('Текст комментария; допускается разметка CRM и ссылки.') }, annotations,
  }, ({ task, text }) => respond(() => service.addComment(task, text)));
  server.registerTool('submit_result', {
    title: 'Сдать результат на проверку',
    description: 'Сохранить результат и сдать задачу на проверку постановщику (review). Это отдельный этап перед окончательным принятием. Уже сданную или завершённую задачу повторно не сдаёт. После неизвестного исхода проверить задачу перед повтором.',
    inputSchema: { task, result: text.describe('Что сделано; при необходимости добавьте ссылки и разметку CRM.') }, annotations,
  }, ({ task, result }) => respond(() => service.submitResult(task, result)));
  return server;
}

async function respond(action: () => Promise<object>) {
  try {
    const data = await action();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      structuredContent: data as Record<string, unknown>,
    };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: asCrmError(error).toJSON() }) }] };
  }
}
