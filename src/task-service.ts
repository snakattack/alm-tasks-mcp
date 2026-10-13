import { AlmondHttpClient } from './http-client.js';
import { CrmError } from './errors.js';
import { parseDiscussion, parseTask } from './parser.js';
import { requireText, resolveTaskId, type TaskRef } from './task-ref.js';
import type { Task } from './types.js';

export class TaskService {
  private readonly writes = new Map<number, Promise<unknown>>();
  constructor(private readonly http: AlmondHttpClient) {}

  async getTask(task: TaskRef): Promise<Task> {
    const id = resolveTaskId(task);
    return parseTask(await this.http.read(`/tasks/${id}?frag=1`), id);
  }

  async addComment(task: TaskRef, value: string) {
    const id = resolveTaskId(task);
    const text = requireText(value, 'text');
    return this.serializeWrite(id, async () => {
      // Reading also refreshes an expired session before the non-replayed POST.
      await this.getTask(id);
      const form = new FormData();
      form.set('text', text);
      form.set('reply_to', '');
      form.set('reply_quote', '');
      // Match the observed browser FormData without uploading an attachment.
      form.set('file', new Blob([], { type: 'application/octet-stream' }), '');
      const reply = await this.http.post(`/tasks/${id}/comment`, form);
      if (typeof reply.bubbles !== 'string') throw unknownComment();
      let comment;
      try { comment = parseDiscussion(reply.bubbles).comments.find(item => item.text.trim() === text); } catch { throw unknownComment(); }
      if (!comment) throw unknownComment();
      return { taskId: id, commentId: comment.id, comment };
    });
  }

  async submitResult(task: TaskRef, value: string) {
    const id = resolveTaskId(task);
    const result = requireText(value, 'result');
    return this.serializeWrite(id, async () => {
      const before = await this.getTask(id);
      if (before.status === 'review' || before.status === 'done') {
        throw new CrmError('ALREADY_SUBMITTED', 'Задача уже сдана на проверку или завершена. Результат не изменён.');
      }
      if (!before.canSubmit) {
        throw new CrmError('SUBMIT_NOT_AVAILABLE', 'CRM не разрешает сдачу этой задачи текущему пользователю.');
      }
      const form = new FormData();
      form.set('result', result);
      await this.http.post(`/tasks/${id}/finish`, form);
      let after: Task;
      try { after = await this.getTask(id); } catch {
        throw new CrmError('OUTCOME_UNKNOWN', 'CRM подтвердила сдачу, но повторное чтение не удалось. Проверьте задачу перед повтором.');
      }
      if (after.status !== 'review' || normalize(after.result ?? '') !== normalize(result)) {
        throw new CrmError('OUTCOME_UNKNOWN', 'Не удалось подтвердить статус и сохранённый результат после сдачи. Проверьте задачу перед повтором.');
      }
      return { taskId: id, status: after.status, statusLabel: after.statusLabel, result: after.result, url: after.url };
    });
  }

  private async serializeWrite<T>(id: number, action: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.writes.set(id, next);
    try { return await next; } finally { if (this.writes.get(id) === next) this.writes.delete(id); }
  }
}

function unknownComment(): CrmError {
  return new CrmError('OUTCOME_UNKNOWN', 'CRM подтвердила запись, но ID комментария не удалось разобрать. Проверьте обсуждение перед повтором.');
}

function normalize(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}
