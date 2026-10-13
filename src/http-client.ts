import { CookieJar } from 'tough-cookie';
import { CRM_ORIGIN, type Config } from './config.js';
import { CrmError } from './errors.js';

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export interface Trace { method: string; path: string; status: number }
interface Reply { status: number; headers: Headers; body: string }

export class AlmondHttpClient {
  private readonly jar = new CookieJar();
  private loginInProgress: Promise<void> | undefined;
  private sessionVersion = 0;

  constructor(
    private readonly config: Config,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
    private readonly trace?: (event: Trace) => void,
  ) {}

  /** Validate credentials without reading or changing a task. */
  async authenticate(): Promise<void> {
    await this.ensureSession();
  }

  async read(path: string): Promise<string> {
    await this.ensureSession();
    const version = this.sessionVersion;
    try {
      return await this.readOnce(path);
    } catch (error) {
      if (!(error instanceof CrmError) || error.code !== 'AUTH_REQUIRED') throw error;
      if (this.sessionVersion === version) await this.login();
      // At most one session refresh per read. No write is replayed here.
      return await this.readOnce(path);
    }
  }

  async post(path: string, form: FormData): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const reply = await this.exchange(path, 'POST', form, true);
    this.checkResponse(reply, true);
    if (!reply.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      throw new CrmError('OUTCOME_UNKNOWN', 'CRM ответила на запись неожиданным форматом. Проверьте задачу перед повтором.', reply.status);
    }
    let value: unknown;
    try { value = JSON.parse(reply.body); } catch {
      throw new CrmError('OUTCOME_UNKNOWN', 'Ответ записи повреждён. Проверьте задачу перед повтором.', reply.status);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CrmError('OUTCOME_UNKNOWN', 'Ответ записи не содержит подтверждения. Проверьте задачу перед повтором.', reply.status);
    }
    const result = value as Record<string, unknown>;
    if (result.ok === false) {
      throw new CrmError('VALIDATION_ERROR', typeof result.err === 'string' ? result.err : 'CRM отклонила действие.', reply.status);
    }
    if (result.ok !== true) {
      throw new CrmError('OUTCOME_UNKNOWN', 'CRM не подтвердила запись. Проверьте задачу перед повтором.', reply.status);
    }
    return result;
  }

  private async readOnce(path: string): Promise<string> {
    const reply = await this.exchange(path, 'GET');
    this.checkResponse(reply, false);
    if (!reply.headers.get('content-type')?.toLowerCase().includes('text/html')) {
      throw new CrmError('INVALID_RESPONSE', 'CRM вернула неожиданный формат карточки задачи.', reply.status);
    }
    return reply.body;
  }

  private async ensureSession(): Promise<void> {
    const cookies = await this.jar.getCookies(CRM_ORIGIN);
    if (!cookies.some(cookie => cookie.key === 'uid' && cookie.value)) await this.login();
  }

  private async login(): Promise<void> {
    if (this.loginInProgress) return this.loginInProgress;
    this.loginInProgress = this.performLogin();
    try { await this.loginInProgress; } finally { this.loginInProgress = undefined; }
  }

  private async performLogin(): Promise<void> {
    const body = new URLSearchParams({ username: this.config.username, password: this.config.password });
    const reply = await this.exchange('/login', 'POST', body, false, true);
    const location = reply.headers.get('location');
    let destination: URL | undefined;
    if (location) {
      try { destination = new URL(location, CRM_ORIGIN); } catch { /* invalid redirect */ }
    }
    const cookies = await this.jar.getCookies(CRM_ORIGIN);
    if (![302, 303].includes(reply.status) || !destination || destination.origin !== CRM_ORIGIN
      || destination.pathname === '/login' || !cookies.some(cookie => cookie.key === 'uid' && cookie.value)) {
      throw new CrmError('AUTH_FAILED', 'Вход в CRM не подтверждён. Проверьте локальные учётные данные.', reply.status);
    }
    this.sessionVersion++;
  }

  private async exchange(
    path: string,
    method: 'GET' | 'POST',
    body?: FormData | URLSearchParams,
    mutation = false,
    login = false,
  ): Promise<Reply> {
    if (!path.startsWith('/') || path.startsWith('//') || new URL(path, CRM_ORIGIN).origin !== CRM_ORIGIN) {
      throw new CrmError('INVALID_ARGUMENT', 'HTTP-запрос разрешён только к фиксированному домену CRM.');
    }
    const url = new URL(path, CRM_ORIGIN).href;
    const headers = new Headers({ Accept: login ? 'text/html' : method === 'GET' ? 'text/html' : 'application/json' });
    const cookie = await this.jar.getCookieString(url);
    if (cookie) headers.set('Cookie', cookie);
    if (!login) headers.set('X-Requested-With', 'fetch');
    if (method === 'POST') {
      headers.set('Origin', CRM_ORIGIN);
      const task = /^\/tasks\/(\d+)/.exec(path)?.[1];
      headers.set('Referer', login ? `${CRM_ORIGIN}/login` : `${CRM_ORIGIN}/tasks/${task}`);
    }
    try {
      const response = await this.fetcher(url, {
        method, headers, redirect: 'manual', signal: AbortSignal.timeout(this.config.timeoutMs),
        ...(body === undefined ? {} : { body }),
      });
      for (const setCookie of response.headers.getSetCookie()) {
        await this.jar.setCookie(setCookie, url);
      }
      const text = await response.text();
      this.trace?.({ method, path, status: response.status });
      return { status: response.status, headers: response.headers, body: text };
    } catch {
      throw new CrmError(mutation ? 'OUTCOME_UNKNOWN' : 'NETWORK_ERROR', mutation
        ? 'Связь прервалась во время записи. Исход неизвестен; проверьте задачу перед повтором.'
        : 'Не удалось связаться с CRM. Проверьте DNS, сеть и доступ из процесса Node.js.');
    }
  }

  private checkResponse(reply: Reply, mutation: boolean): void {
    const { status, headers, body } = reply;
    const location = headers.get('location');
    const isLoginPage = /<form\b/i.test(body) && /name\s*=\s*["']password["']/i.test(body)
      && /name\s*=\s*["']username["']/i.test(body);
    let redirectsToLogin = false;
    if (location) {
      try { const target = new URL(location, CRM_ORIGIN); redirectsToLogin = target.origin === CRM_ORIGIN && target.pathname === '/login'; } catch { /* invalid location */ }
    }
    if (status === 401 || redirectsToLogin || isLoginPage) {
      throw new CrmError('AUTH_REQUIRED', 'Сессия CRM истекла. Запись не повторялась автоматически.', status);
    }
    let message: string | undefined;
    const toast = headers.get('X-Toast');
    if (toast) { try { message = decodeURIComponent(toast); } catch { /* malformed toast */ } }
    if (status === 403) throw new CrmError('FORBIDDEN', message || 'Недостаточно прав для действия.', status);
    if (status === 404) throw new CrmError('NOT_FOUND', message || 'Задача не найдена или недоступна.', status);
    if (status === 422 || status === 400) throw new CrmError('VALIDATION_ERROR', message || 'CRM отклонила параметры действия.', status);
    if (status >= 200 && status < 300) return;
    if (mutation && (status >= 500 || (status >= 300 && status < 400))) {
      throw new CrmError('OUTCOME_UNKNOWN', message || 'CRM не подтвердила результат записи. Проверьте задачу перед повтором.', status);
    }
    throw new CrmError('CRM_ERROR', message || `Неожиданный HTTP-ответ CRM: ${status}.`, status);
  }
}
