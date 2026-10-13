import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from '../dist/config.js';
import { CrmError } from '../dist/errors.js';
import { resolveTaskId } from '../dist/task-ref.js';

const client = new Client({ name: 'almond-read-smoke', version: '0.1.0' });
let transport;
try {
  await loadRuntimeConfig();
  const task = resolveTaskId(process.argv[2] ?? '10081');
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
    stderr: 'pipe',
  });
  await client.connect(transport);
  const listed = await client.listTools();
  const expected = ['add_comment', 'get_task', 'submit_result'];
  if (JSON.stringify(listed.tools.map(tool => tool.name).sort()) !== JSON.stringify(expected)) {
    throw new Error('Unexpected tool list');
  }
  const response = await client.callTool({ name: 'get_task', arguments: { task } });
  if (response.isError) {
    console.error(response.content);
    process.exitCode = 1;
  } else {
    const result = response.structuredContent;
    console.log(JSON.stringify({ tools: expected, taskId: result.id, title: result.title, status: result.status,
      comments: result.discussion.comments.length, events: result.discussion.events.length }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof CrmError ? error.toJSON() : {
    code: 'MCP_CONNECTION_ERROR',
    message: 'Не удалось установить MCP-соединение. Проверьте запуск дочернего Node.js-процесса и окружение клиента.',
  } }));
  process.exitCode = 1;
} finally {
  await client.close();
  if (transport) await transport.close();
}
