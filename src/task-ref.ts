import { CRM_ORIGIN } from './config.js';
import { CrmError } from './errors.js';

export type TaskRef = number | string;

export function resolveTaskId(task: TaskRef): number {
  let id: number;
  if (typeof task === 'number') {
    id = task;
  } else {
    const value = task.trim();
    if (/^[1-9]\d*$/.test(value)) {
      id = Number(value);
    } else {
      let url: URL;
      try { url = new URL(value); } catch { throw invalid(); }
      if (url.origin !== CRM_ORIGIN || url.username || url.password) throw invalid();
      const match = /^\/tasks\/([1-9]\d*)\/?$/.exec(url.pathname);
      if (!match?.[1]) throw invalid();
      id = Number(match[1]);
    }
  }
  if (!Number.isSafeInteger(id) || id <= 0) throw invalid();
  return id;
}

function invalid(): CrmError {
  return new CrmError('INVALID_ARGUMENT', 'task должен быть положительным целым ID или ссылкой https://almond-app.ru/tasks/{id}.');
}

export function requireText(value: string, name: string): string {
  const text = value.trim();
  if (!text) throw new CrmError('INVALID_ARGUMENT', `${name} не должен быть пустым.`);
  return text;
}
