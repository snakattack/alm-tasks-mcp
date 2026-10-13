import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { parseTask, parseDiscussion, textOf } from '../dist/parser.js';
import { loadConfig } from '../dist/config.js';
import { resolveTaskId } from '../dist/task-ref.js';
import { observedTask, htmlTask, htmlReply } from './support/fixtures.mjs';

test('task references accept IDs and canonicalize CRM links', () => {
  for (const value of [9705, '9705', ' https://almond-app.ru/tasks/9705?frag=1#at-m3 ', 'https://almond-app.ru/tasks/9705/']) {
    assert.equal(resolveTaskId(value), 9705);
  }
});
test('task references reject other hosts, schemes, paths, credentials and unsafe numbers', () => {
  for (const value of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, '01', '#9705', 'https://almond-app.ru.evil.test/tasks/9705',
    'http://almond-app.ru/tasks/9705', 'https://user:secret@almond-app.ru/tasks/9705', 'https://almond-app.ru/tasks/9705/finish',
    'https://almond-app.ru:123/tasks/9705', 'https://other.test/tasks/9705', 'javascript:alert(1)']) {
    assert.throws(() => resolveTaskId(value), { code: 'INVALID_ARGUMENT' });
  }
});
test('the anonymized observed card exposes task and discussion without editor noise', () => {
  const task = parseTask(observedTask, 10081);
  assert.equal(task.id, 10081);
  assert.equal(task.title, 'Тест задача');
  assert.equal(task.description, 'Проверка описания');
  assert.equal(task.acceptanceCriteria, '');
  assert.equal(task.status, 'review');
  assert.equal(task.result, 'тест текст сдачи');
  assert.equal(task.dueDate, null);
  assert.equal(task.creator.name, 'Исполнитель');
  assert.equal(task.assignee.name, 'Исполнитель');
  assert.equal(task.canSubmit, false);
  assert.equal(task.discussion.comments[0].id, 48337);
  assert.equal(task.discussion.comments[0].text, 'Тест комментарий');
  assert.equal(task.discussion.comments[0].time, '23:16');
  assert.equal(task.discussion.events[0].id, 48338);
  assert.equal(task.discussion.events[0].time, '23:18');
  assert.ok(!task.discussion.events[0].text.includes('23:18'));
  assert.equal(task.readSideEffects.length, 1);
});
test('read-only card criteria, links, and attachments retain useful data', () => {
  const $ = load(htmlTask());
  $('#desc-form').remove(); $('#crit-form').remove();
  $('#crit-view').html('<div>Критерий один</div><div>Критерий два</div>');
  $('#desc-view').html('<div>Документация <a href="https://example.test/doc">здесь</a></div><div>Следующая строка</div><script>throw new Error()</script>');
  $('[data-z="descr"]').append('<div class="tattwrap"><div class="tatti"><a href="/tasks/10081/att/7"><img src="/tasks/10081/att/7" alt="screenshot.png"></a></div><a href="javascript:alert(1)">ignored</a></div>');
  const task = parseTask($.html(), 10081);
  assert.equal(task.acceptanceCriteria, 'Критерий один\nКритерий два');
  assert.match(task.description, /Следующая строка/);
  assert.ok(!task.description.includes('throw'));
  assert.deepEqual(task.links, [{ url: 'https://example.test/doc', label: 'здесь' }]);
  assert.equal(task.attachments[0].url, 'https://almond-app.ru/tasks/10081/att/7');
});
test('unknown statuses remain explicit and malformed cards fail closed', () => {
  assert.equal(parseTask(htmlTask({ status: 'Новый статус' }), 10081).status, 'unknown');
  assert.throws(() => parseTask(observedTask, 9705), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseTask('<html>maintenance</html>', 10081), { code: 'INVALID_RESPONSE' });
});
test('checklist extraction separates item text from POST controls and completion state', () => {
  const $ = load(htmlTask());
  const section = $('.dsec').filter((_, el) => /Чек-лист/.test($(el).find('.dsec-h').text()));
  section.append('<ul><li><form action="/tasks/10081/check/1/toggle"><input type="checkbox" checked><button>Снять</button></form><span>Проверить страницу</span></li><li><form action="/tasks/10081/check/2/toggle"><input type="checkbox"><button>Отметить</button></form><span>Проверить ссылки</span></li></ul>');
  assert.deepEqual(parseTask($.html(), 10081).checklist, [
    { text: 'Проверить страницу', done: true }, { text: 'Проверить ссылки', done: false },
  ]);
});
test('comment source text preserves markup and line breaks', () => {
  const original = '**Готово**\n```ts\n  return true;\n```';
  assert.equal(parseDiscussion(htmlReply(7, original)).comments[0].text, original);
});
test('rendered code indentation and line breaks survive extraction', () => {
  const $ = load('<div id="body"><p>Код</p><pre>  if (ok) {\n    return true;\n  }</pre><p>Дальше</p></div>');
  assert.match(textOf($('#body')), /  if \(ok\) \{\n    return true;/);
});
test('configuration errors never echo credentials', () => {
  assert.throws(() => loadConfig({}), { code: 'CONFIG_ERROR' });
  assert.throws(() => loadConfig({ ALMOND_USERNAME: 'user', ALMOND_PASSWORD: 'secret', ALMOND_TIMEOUT_MS: '-1' }), { code: 'CONFIG_ERROR' });
  assert.equal(loadConfig({ ALMOND_USERNAME: ' user ', ALMOND_PASSWORD: ' secret ' }).password, ' secret ');
});
