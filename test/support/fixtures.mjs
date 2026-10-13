import { readFileSync } from 'node:fs';
import { load } from 'cheerio';

export const observedTask = readFileSync(new URL('../fixtures/task-10081.html', import.meta.url), 'utf8');
export const config = { username: 'test-user', password: 'test-password', timeoutMs: 1000 };
export const loginPage = '<form method="post"><input name="username"><input name="password" type="password"></form>';

export function htmlTask({ id = 10081, status = 'todo', result = null } = {}) {
  const $ = load(observedTask.replaceAll('10081', String(id)));
  $('#stBtn').text({ todo: 'Ждёт', doing: 'В работе', review: 'На проверке', done: 'Готово' }[status] ?? status);
  const resultZone = $('[data-z="res"]').empty();
  if (result !== null) {
    const panel = $('<div class="panel"><div>Результат</div><div class="result-value"></div></div>');
    panel.find('.result-value').text(result);
    resultZone.append(panel);
  }
  $('[data-z="acts"]').empty();
  if (status === 'todo' || status === 'doing') {
    $('[data-z="acts"]').append(`<form method="post" action="/tasks/${id}/finish"><textarea name="result" required></textarea></form>`);
  }
  return $.html();
}

export function htmlReply(id, text) {
  const $ = load('<div class="cmsg me"><div class="cbub"><div class="ctxt"></div><div class="ctm">23:16</div><div class="cact"><span data-t=""></span></div></div></div>', {}, false);
  $('.cmsg').attr('data-mid', String(id)).attr('data-au', 'Тестовый Исполнитель');
  $('.ctxt').text(text);
  $('[data-t]').attr('data-t', text);
  return $.html();
}

export function reply(body, status = 200, headers = {}) {
  const isJson = body !== null && typeof body === 'object';
  return new Response(isJson ? JSON.stringify(body) : body, {
    status, headers: { 'content-type': isJson ? 'application/json' : 'text/html; charset=utf-8', ...headers },
  });
}

export function loginReply() {
  return reply(null, 302, { location: '/u/test-user', 'set-cookie': 'uid=test-session; HttpOnly; Secure; SameSite=Lax; Path=/' });
}

export function mockFetch(sequence) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, path: new URL(url).pathname + new URL(url).search, ...init, headers: new Headers(init.headers) };
      calls.push(call);
      const step = sequence.shift();
      if (!step) throw new Error('Unexpected extra HTTP request');
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? await step(call) : step;
    },
  };
}
