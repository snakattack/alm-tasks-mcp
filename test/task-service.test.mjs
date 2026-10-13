import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlmondHttpClient } from '../dist/http-client.js';
import { TaskService } from '../dist/task-service.js';
import { config, htmlTask, htmlReply, loginReply, mockFetch, reply } from './support/fixtures.mjs';

function setup(sequence) {
  const mock = mockFetch([loginReply(), ...sequence]);
  return { mock, service: new TaskService(new AlmondHttpClient(config, mock.fetch)) };
}
test('commenting preflights task and sends only the internal discussion form', async () => {
  const { service, mock } = setup([reply(htmlTask()), reply({ ok: true, bubbles: htmlReply(48339, '**Текст**\nстрока') })]);
  const result = await service.addComment('https://almond-app.ru/tasks/10081?foo=bar', '**Текст**\nстрока');
  assert.equal(result.commentId, 48339);
  assert.deepEqual(mock.calls.map(call => call.path), ['/login', '/tasks/10081?frag=1', '/tasks/10081/comment']);
  assert.deepEqual([...mock.calls[2].body.keys()].sort(), ['file', 'reply_quote', 'reply_to', 'text']);
  assert.equal(mock.calls[2].body.get('file').size, 0);
  assert.equal(mock.calls[2].body.get('file').name, '');
});
test('successful submission confirms both the saved result and review status', async () => {
  const resultText = 'Готово\nhttps://example.test/';
  const { service, mock } = setup([reply(htmlTask()), reply({ ok: true, zones: { meta: '<section></section>' } }), reply(htmlTask({ status: 'review', result: resultText }))]);
  const result = await service.submitResult(10081, resultText);
  assert.equal(result.status, 'review');
  assert.equal(result.result, resultText);
  assert.equal(mock.calls[2].path, '/tasks/10081/finish');
  assert.deepEqual([...mock.calls[2].body], [['result', resultText]]);
  assert.equal(mock.calls[3].method, 'GET');
});
test('already reviewed or completed task is not changed', async () => {
  for (const status of ['review', 'done']) {
    const { service, mock } = setup([reply(htmlTask({ status, result: 'Исходный результат' }))]);
    await assert.rejects(service.submitResult(10081, 'Новый результат'), { code: 'ALREADY_SUBMITTED' });
    assert.equal(mock.calls.length, 2);
  }
});
test('missing finish form prevents an unsupported write', async () => {
  const { service, mock } = setup([reply(htmlTask().replace('/tasks/10081/finish', '/tasks/10081/other'))]);
  await assert.rejects(service.submitResult(10081, 'Результат'), { code: 'SUBMIT_NOT_AVAILABLE' });
  assert.equal(mock.calls.length, 2);
});
test('blank arguments are rejected before any login or CRM access', async () => {
  const mock = mockFetch([]);
  const service = new TaskService(new AlmondHttpClient(config, mock.fetch));
  await assert.rejects(service.addComment(10081, ' \n '), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(service.submitResult(10081, ''), { code: 'INVALID_ARGUMENT' });
  assert.equal(mock.calls.length, 0);
});
test('a missing comment ID after success is an unknown outcome', async () => {
  for (const bubbles of ['', '<div class="cmsg" data-mid="invalid"></div>']) {
    const { service, mock } = setup([reply(htmlTask()), reply({ ok: true, bubbles })]);
    await assert.rejects(service.addComment(10081, 'Текст'), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(mock.calls.length, 3);
  }
});
test('submission verification failure never repeats the finish POST', async () => {
  for (const after of [reply(htmlTask({ status: 'review', result: 'Другой результат' })), new Error('network down')]) {
    const { service, mock } = setup([reply(htmlTask()), reply({ ok: true, zones: {} }), after]);
    await assert.rejects(service.submitResult(10081, 'Результат'), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(mock.calls.filter(call => call.path.endsWith('/finish')).length, 1);
  }
});
test('concurrent submissions of one task are serialized and do not overwrite the result', async () => {
  const { service, mock } = setup([reply(htmlTask()), reply({ ok: true, zones: {} }),
    reply(htmlTask({ status: 'review', result: 'Первый' })), reply(htmlTask({ status: 'review', result: 'Первый' }))]);
  const results = await Promise.allSettled([service.submitResult(10081, 'Первый'), service.submitResult(10081, 'Второй')]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'ALREADY_SUBMITTED');
  assert.equal(mock.calls.filter(call => call.path.endsWith('/finish')).length, 1);
});
