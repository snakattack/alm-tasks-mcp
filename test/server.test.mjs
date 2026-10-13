import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { createServer } from '../dist/server.js';
import { TaskService } from '../dist/task-service.js';
import { AlmondHttpClient } from '../dist/http-client.js';
import { config, htmlTask, htmlReply, loginReply, reply } from './support/fixtures.mjs';

// Exercise the real stdio framing and SDK handshake through pipes without requiring
// child-process execution or opening sockets in the restricted development environment.
class PipeClientTransport {
  constructor(input, output) { this.input = input; this.output = output; this.buffer = new ReadBuffer(); }
  async start() {
    this.input.on('data', chunk => {
      try {
        this.buffer.append(chunk);
        let message;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) { this.onerror?.(error); }
    });
  }
  async send(message) { this.output.write(serializeMessage(message)); }
  async close() { this.input.removeAllListeners('data'); this.onclose?.(); }
}

async function connected(t) {
  let state = 'todo', result = null, commentId = 48339;
  const requests = [];
  const http = new AlmondHttpClient(config, async (url, init) => {
    const path = new URL(url).pathname; requests.push({ path, ...init });
    if (path === '/login') return loginReply();
    if (init.method === 'GET') return reply(htmlTask({ status: state, result }));
    if (path.endsWith('/comment')) return reply({ ok: true, bubbles: htmlReply(commentId++, init.body.get('text')) });
    if (path.endsWith('/finish')) { state = 'review'; result = init.body.get('result'); return reply({ ok: true, zones: {} }); }
    throw new Error('Unexpected route');
  });
  const server = createServer(new TaskService(http));
  const incoming = new PassThrough(), outgoing = new PassThrough();
  const stdout = [];
  outgoing.on('data', chunk => stdout.push(String(chunk)));
  await server.connect(new StdioServerTransport(incoming, outgoing));
  const client = new Client({ name: 'almond-test-client', version: '1' });
  await client.connect(new PipeClientTransport(outgoing, incoming));
  t.after(async () => { await client.close(); await server.close(); incoming.destroy(); outgoing.destroy(); });
  return { client, requests, stdout };
}

test('stdio SDK initialization advertises exactly the three agreed tools', async t => {
  const { client, requests, stdout } = await connected(t);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['add_comment', 'get_task', 'submit_result']);
  assert.equal(listed.tools.find(tool => tool.name === 'get_task').annotations.readOnlyHint, false);
  assert.equal(requests.length, 0); // listing does not log in or read CRM tasks
  for (const line of stdout.join('').trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
});
test('MCP reads a URL and returns structured task data', async t => {
  const { client } = await connected(t);
  const response = await client.callTool({ name: 'get_task', arguments: { task: 'https://almond-app.ru/tasks/10081?frag=1' } });
  assert.ok(!response.isError);
  assert.equal(response.structuredContent.id, 10081);
  assert.equal(response.structuredContent.description, 'Проверка описания');
  assert.equal(JSON.parse(response.content[0].text).id, 10081);
});
test('MCP comment and submit calls use the HTTP service and prevent resubmission', async t => {
  const { client, requests } = await connected(t);
  const comment = await client.callTool({ name: 'add_comment', arguments: { task: 10081, text: 'Комментарий SDK' } });
  assert.equal(comment.structuredContent.commentId, 48339);
  const result = await client.callTool({ name: 'submit_result', arguments: { task: '10081', result: 'Готово SDK' } });
  assert.equal(result.structuredContent.status, 'review');
  const repeated = await client.callTool({ name: 'submit_result', arguments: { task: 10081, result: 'Повтор' } });
  assert.equal(repeated.isError, true);
  assert.equal(JSON.parse(repeated.content[0].text).error.code, 'ALREADY_SUBMITTED');
  assert.equal(requests.filter(request => request.path.endsWith('/finish')).length, 1);
});
test('invalid MCP arguments fail without sending HTTP requests', async t => {
  const { client, requests } = await connected(t);
  const badUrl = await client.callTool({ name: 'get_task', arguments: { task: 'https://evil.test/tasks/10081' } });
  assert.equal(badUrl.isError, true);
  assert.equal(JSON.parse(badUrl.content[0].text).error.code, 'INVALID_ARGUMENT');
  const blank = await client.callTool({ name: 'add_comment', arguments: { task: 10081, text: '  ' } });
  assert.equal(blank.isError, true);
  assert.equal(requests.length, 0);
});
