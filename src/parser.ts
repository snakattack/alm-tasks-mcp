import { load, type CheerioAPI } from 'cheerio';
import { CRM_ORIGIN } from './config.js';
import { CrmError } from './errors.js';
import type { Discussion, Link, Person, Task, TaskStatus } from './types.js';

type Selection = ReturnType<CheerioAPI>;

// Read server-rendered markup; never execute scripts or load its linked resources.
export function textOf(selection: Selection): string {
  const node = selection.clone();
  const $ = load('');
  node.find('script, style, form, svg, .cact, .dedit-pen, .ttl-pen, .ctm, .cet, .pplpop').remove();
  const code: string[] = [];
  node.find('pre').each((_, el) => {
    code.push($(el).text());
    $(el).replaceWith(`\n\uFFF0CODE${code.length - 1}\uFFF1\n`);
  });
  node.find('br').replaceWith('\n');
  node.find('li').each((_, el) => { $(el).prepend('• '); });
  node.find('div, p, li, pre, blockquote, h1, h2, h3, tr').append('\n');
  return node.text().replace(/\r/g, '').replace(/\u00a0/g, ' ')
    .split('\n').map(line => line.replace(/[\t ]+/g, ' ').trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim()
    .replace(/\uFFF0CODE(\d+)\uFFF1/g, (_, index: string) => code[Number(index)] ?? '');
}

function safeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, CRM_ORIGIN);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function linksIn($: CheerioAPI, root: Selection, attachmentsOnly = false): Link[] {
  const result = new Map<string, Link>();
  root.find('a[href], img[src]').each((_, el) => {
    const item = $(el);
    if (item.closest('form, .cact, .pplpop').length) return;
    const url = safeUrl(item.attr('href') ?? item.attr('src'));
    if (!url) return;
    const isAttachment = /^\/tasks\/\d+\/(?:att\/|comment\/\d+\/att)/.test(new URL(url).pathname)
      || item.closest('.catt, .catt-img, .catt-file, .tatti, .tattwrap, .tattlink').length > 0;
    if (attachmentsOnly && !isAttachment) return;
    if (!attachmentsOnly && item.is('img')) return;
    const label = item.attr('alt') || item.attr('title') || item.text().trim() || item.find('img').attr('alt');
    if (!result.has(url)) result.set(url, { url, label: label || url });
  });
  return [...result.values()];
}

function person(value: Selection): Person | null {
  const anchor = value.find('a[href^="/u/"]:not(.planlink)').first();
  const name = textOf(anchor.length ? anchor : value.find('summary.aspick').first());
  // The assignee may be an editable picker rather than a profile link.
  const fallback = textOf(value.find('summary.aspick, b').first());
  const actualName = name || fallback;
  return actualName ? { name: actualName, url: safeUrl(anchor.attr('href')) } : null;
}

export function statusFromLabel(label: string): TaskStatus {
  switch (label.trim().toLowerCase()) {
    case 'ждёт': case 'ждет': return 'todo';
    case 'в работе': return 'doing';
    case 'на проверке': return 'review';
    case 'готово': case 'завершена': case 'завершено': case 'закрыта': return 'done';
    default: return 'unknown';
  }
}

export function parseDiscussion(html: string): Discussion {
  const $ = load(html);
  const comments: Discussion['comments'] = [];
  const events: Discussion['events'] = [];
  $('.cmsg[data-mid], .cev[data-mid]').each((_, el) => {
    const item = $(el);
    const id = Number(item.attr('data-mid'));
    if (!Number.isSafeInteger(id) || id < 1) throw new CrmError('INVALID_RESPONSE', 'В обсуждении отсутствует корректный ID сообщения.');
    if (item.hasClass('cev')) {
      events.push({ id, text: textOf(item), time: item.find('.cet').text().trim() || null });
    } else {
      const body = item.find('.ctxt');
      const raw = item.find('[data-t]').first().attr('data-t');
      comments.push({
        id,
        author: item.attr('data-au') ?? (item.find('.cav').attr('title') || null),
        text: raw ?? textOf(body),
        time: item.find('.ctm').clone().children().remove().end().text().trim() || null,
        links: linksIn($, body),
        attachments: linksIn($, item.find('.cbub'), true),
      });
    }
  });
  return { comments, events };
}

export function parseTask(html: string, expectedId: number): Task {
  const $ = load(html);
  const root = $('.twin').first();
  const id = Number(root.attr('data-tid'));
  const title = textOf(root.find('h1').first());
  if (!root.length || id !== expectedId || !title) {
    throw new CrmError('INVALID_RESPONSE', 'Ответ CRM не содержит ожидаемую карточку задачи.');
  }
  const meta = root.find('[data-z="meta"]');
  const row = (label: string): Selection => meta.find('.irow').filter((_, el) =>
    $(el).find('.ilbl').text().trim().toLowerCase() === label).first().find('.ival');
  const statusLabel = textOf(row('статус').find('#stBtn').length ? row('статус').find('#stBtn') : row('статус'));
  if (!statusLabel) throw new CrmError('INVALID_RESPONSE', 'В карточке отсутствует статус задачи.');
  const descr = root.find('#desc-view').first();
  const rawDescr = root.find('#desc-form textarea[name="descr"]').first();
  const sections = root.find('[data-z="descr"] .dsec');
  const acceptanceSection = sections.filter((_, el) => /критерии при[её]мки/i.test($(el).find('.dsec-h').first().text()));
  const acceptanceRaw = root.find('textarea[name="acceptance"], textarea[name="criteria"], textarea[name="accept"]').first();
  const acceptanceView = root.find('#crit-view, #acc-view, #accept-view, #criteria-view').first();
  const acceptance = acceptanceRaw.length ? acceptanceRaw.text()
    : textOf(acceptanceView.length ? acceptanceView : acceptanceSection.find('.dtext, .deditable').first());
  const resultPanel = root.find('[data-z="res"] .panel').first();
  const result = resultPanel.length ? textOf(resultPanel.children().last()) || null : null;
  const due = row('крайний срок');
  const dueValue = due.find('[data-due]').attr('data-due') ?? root.find('#dueVal').attr('value');
  const dueLabel = textOf(due) || null;
  const projectAnchor = root.find('.task-sub a[href^="/p/"]').first();
  const projectUrl = safeUrl(projectAnchor.attr('href'));
  const watchers: Person[] = [];
  root.find('[data-z="watch"] a[href^="/u/"]').each((_, el) => {
    const name = textOf($(el));
    if (name) watchers.push({ name, url: safeUrl($(el).attr('href')) });
  });
  const checklist: Task['checklist'] = [];
  const checklistSection = sections.filter((_, el) => /чек[- ]лист/i.test($(el).find('.dsec-h').first().text()));
  const entries = new Set<Parameters<typeof $>[0]>();
  checklistSection.find('li, [data-cid], .chk-item, .check-item, .ckrow, .step').each((_, el) => { entries.add(el); });
  // Some cards render each checkbox action as an inline form beside the item text.
  checklistSection.find('form[action*="/check/"]:not([action$="/add"])').each((_, el) => {
    const knownRow = $(el).closest('li, [data-cid], .chk-item, .check-item, .ckrow, .step');
    const row = knownRow.length ? knownRow : $(el).parent();
    if (!row.hasClass('dsec') && row.get(0)) entries.add(row.get(0));
  });
  for (const el of entries) {
    const item = $(el);
    const text = textOf(item);
    if (text) checklist.push({ text, done: item.hasClass('done') || item.find('input[type="checkbox"][checked]').length > 0
      || item.find('[style*="line-through"], [aria-checked="true"]').length > 0 });
  }
  const discussion = parseDiscussion(root.find('#taskchat').html() ?? '');
  return {
    id, url: `${CRM_ORIGIN}/tasks/${id}`, title,
    description: rawDescr.length ? rawDescr.text().trim() : textOf(descr),
    acceptanceCriteria: /^Критерии при[её]мки не заполнены/i.test(acceptance.trim()) ? '' : acceptance.trim(), checklist,
    status: statusFromLabel(statusLabel), statusLabel, result,
    dueDate: dueValue && /^\d{4}-\d{2}-\d{2}$/.test(dueValue) ? dueValue : null,
    dueLabel: dueLabel === 'срок не задан' ? null : dueLabel,
    project: projectUrl ? { url: projectUrl, label: projectAnchor.text().trim() } : null,
    creator: person(row('постановщик')), assignee: person(row('исполнитель')), watchers,
    links: linksIn($, descr),
    attachments: linksIn($, root.find('[data-z="descr"], .tattwrap'), true),
    discussion,
    canSubmit: root.find(`form[action="/tasks/${id}/finish"]`).length > 0,
    readSideEffects: ['CRM фиксирует просмотр карточки и может отметить обсуждение прочитанным.'],
  };
}
