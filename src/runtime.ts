import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadRuntimeConfig } from './config.js';
import { AlmondHttpClient } from './http-client.js';
import { createServer } from './server.js';
import { TaskService } from './task-service.js';

export async function serve(): Promise<void> {
  const http = new AlmondHttpClient(await loadRuntimeConfig());
  const server = createServer(new TaskService(http));
  const shutdown = () => { void server.close().finally(() => process.exit(0)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
}
