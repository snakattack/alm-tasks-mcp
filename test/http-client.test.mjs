import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlmondHttpClient } from '../dist/http-client.js';
import { config, loginPage, loginReply, mockFetch, reply, htmlTask } from './support/fixtures.mjs';

test('direct HTTP login encodes credentials and attaches a cookie to later reads', async () => {
  const mock = mockFetch([loginReply(), reply(htmlTask())]);
  const trace = [];
  const client = new AlmondHttpClient(config, mock.fetch, event => trace.push(event));
  await client.read('/tasks/10081?frag=1');
  assert.equal(mock.calls[0].path, '/login');
  assert.equal(mock.calls[0].method, 'POST');
  assert.ok(mock.calls[0].body instanceof URLSearchParams);
  assert.deepEqual(Object.fromEntries(mock.calls[0].body), { username: 'test-user', password: 'test-password' });
  assert.equal(mock.calls[0].redirect, 'manual');
  assert.equal(mock.calls[1].headers.get('Cookie'), 'uid=test-session');
  assert.equal(mock.calls[1].headers.get('X-Requested-With'), 'fetch');
  assert.ok(!JSON.stringify(trace).includes(config.password));
  assert.ok(!JSON.stringify(trace).includes('test-session'));
});
test('expired read redirects trigger a single reauthentication and retry', async () => {
  const mock = mockFetch([loginReply(), reply(null, 302, { location: '/login' }), loginReply(), reply(htmlTask())]);
  await new AlmondHttpClient(config, mock.fetch).read('/tasks/10081?frag=1');
  assert.deepEqual(mock.calls.map(call => call.path), ['/login', '/tasks/10081?frag=1', '/login', '/tasks/10081?frag=1']);
});
test('a 200 HTML login page is recognized as lost authentication', async () => {
  const mock = mockFetch([loginReply(), reply(loginPage), loginReply(), reply(loginPage)]);
  await assert.rejects(new AlmondHttpClient(config, mock.fetch).read('/tasks/10081?frag=1'), { code: 'AUTH_REQUIRED' });
  assert.equal(mock.calls.length, 4);
});
test('concurrent initial reads share one login', async () => {
  const mock = mockFetch([async () => { await new Promise(resolve => setTimeout(resolve, 10)); return loginReply(); }, reply(htmlTask()), reply(htmlTask())]);
  const client = new AlmondHttpClient(config, mock.fetch);
  await Promise.all([client.read('/tasks/10081?frag=1'), client.read('/tasks/10081?frag=1')]);
  assert.equal(mock.calls.filter(call => call.path === '/login').length, 1);
});
test('bad credentials fail without echoing them', async () => {
  const mock = mockFetch([reply(loginPage)]);
  await assert.rejects(new AlmondHttpClient(config, mock.fetch).read('/tasks/10081?frag=1'), error => {
    assert.equal(error.code, 'AUTH_FAILED');
    assert.ok(!error.message.includes(config.password));
    return true;
  });
});
test('JSON write uses native multipart and the observed request headers', async () => {
  const mock = mockFetch([loginReply(), reply({ ok: true, bubbles: '<div></div>' })]);
  const form = new FormData(); form.set('text', 'Тест');
  await new AlmondHttpClient(config, mock.fetch).post('/tasks/10081/comment', form);
  const call = mock.calls[1];
  assert.equal(call.headers.get('Origin'), 'https://almond-app.ru');
  assert.equal(call.headers.get('Referer'), 'https://almond-app.ru/tasks/10081');
  assert.equal(call.headers.get('X-Requested-With'), 'fetch');
  assert.equal(call.headers.get('Content-Type'), null); // fetch supplies the multipart boundary
  const actual = new Request(call.url, { method: 'POST', headers: call.headers, body: call.body });
  assert.match(actual.headers.get('Content-Type'), /^multipart\/form-data; boundary=/);
  assert.equal((await actual.formData()).get('text'), 'Тест');
});
test('write auth failures and unknown outcomes are never retried', async () => {
  for (const [response, code] of [
    [reply(null, 302, { location: '/login' }), 'AUTH_REQUIRED'],
    [reply('<html>unexpected redirect</html>', 302, { location: '/tasks/10081' }), 'OUTCOME_UNKNOWN'],
    [reply('<html>server error</html>', 500), 'OUTCOME_UNKNOWN'],
    [reply('<html>unexpected success</html>'), 'OUTCOME_UNKNOWN'],
    [reply('{bad-json', 200, { 'content-type': 'application/json' }), 'OUTCOME_UNKNOWN'],
    [reply({}), 'OUTCOME_UNKNOWN'],
    [new Error('private connection details'), 'OUTCOME_UNKNOWN'],
  ]) {
    const mock = mockFetch([loginReply(), response]);
    await assert.rejects(new AlmondHttpClient(config, mock.fetch).post('/tasks/10081/finish', new FormData()), { code });
    assert.equal(mock.calls.length, 2);
  }
});
test('HTTP errors expose safe CRM reasons and status codes', async () => {
  for (const [status, code] of [[403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [422, 'VALIDATION_ERROR'], [500, 'CRM_ERROR']]) {
    const mock = mockFetch([loginReply(), reply('error', status, { 'X-Toast': encodeURIComponent('Причина отказа') })]);
    await assert.rejects(new AlmondHttpClient(config, mock.fetch).read('/tasks/10081?frag=1'), { code, status, message: 'Причина отказа' });
  }
});
test('JSON rejection is handled even with HTTP 200', async () => {
  const mock = mockFetch([loginReply(), reply({ ok: false, err: 'Требуется результат' })]);
  await assert.rejects(new AlmondHttpClient(config, mock.fetch).post('/tasks/10081/finish', new FormData()), { code: 'VALIDATION_ERROR', message: 'Требуется результат' });
});
test('network failure on a read is distinct from an ambiguous write', async () => {
  const mock = mockFetch([loginReply(), new Error('network down')]);
  await assert.rejects(new AlmondHttpClient(config, mock.fetch).read('/tasks/10081?frag=1'), { code: 'NETWORK_ERROR' });
});
test('client refuses URL escape without making an outside request', async () => {
  const mock = mockFetch([loginReply()]);
  await assert.rejects(new AlmondHttpClient(config, mock.fetch).read('//evil.test/tasks/10081'), { code: 'INVALID_ARGUMENT' });
  assert.equal(mock.calls.length, 1);
});
