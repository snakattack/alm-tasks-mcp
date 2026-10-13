import { createInterface, emitKeypressEvents } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { CrmError } from './errors.js';

type Input = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
export interface Prompts {
  assertInteractive(): void;
  ask(message: string): Promise<string>;
  password(message: string): Promise<string>;
  confirm(message: string, defaultYes?: boolean): Promise<boolean>;
  write(message: string): void;
}

const cancelled = () => new CrmError('CONFIG_ERROR', 'Настройка отменена.');

export function readHidden(input: Input, output: Writable, message: string): Promise<string> {
  if (!input.isTTY || !input.setRawMode) return Promise.reject(new CrmError('CONFIG_ERROR', 'Нужен интерактивный терминал. Запустите almond-mcp setup самостоятельно или задайте ALMOND_USERNAME и ALMOND_PASSWORD в окружении.'));
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw ?? false;
    const wasPaused = input.isPaused();
    let value = '';
    const finish = (error?: Error) => {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      input.removeListener('error', onEnd);
      input.setRawMode?.(wasRaw);
      if (wasPaused) input.pause();
      output.write('\n');
      if (error) { value = ''; reject(error); } else resolve(value);
    };
    const onEnd = () => finish(cancelled());
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } = {}) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) return finish(cancelled());
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace' || key.name === 'delete') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (key.ctrl && key.name === 'u') { value = ''; return; }
      if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.once('error', onEnd);
    output.write(message);
    input.resume();
  });
}

export class TerminalPrompts implements Prompts {
  constructor(private readonly input: Input = process.stdin, private readonly output: Writable = process.stderr) {}
  assertInteractive(): void {
    if (!this.input.isTTY || !this.input.setRawMode) {
      throw new CrmError('CONFIG_ERROR', 'Нужен интерактивный терминал. Запустите almond-mcp setup самостоятельно или задайте ALMOND_USERNAME и ALMOND_PASSWORD в окружении.');
    }
  }
  write(message: string): void { this.output.write(`${message}\n`); }
  ask(message: string): Promise<string> {
    this.assertInteractive();
    return new Promise((resolve, reject) => {
      const readline = createInterface({ input: this.input, output: this.output });
      let answered = false;
      readline.once('SIGINT', () => readline.close());
      readline.once('close', () => { if (!answered) reject(cancelled()); });
      readline.question(message, value => { answered = true; readline.close(); resolve(value); });
    });
  }
  password(message: string): Promise<string> { return readHidden(this.input, this.output, message); }
  async confirm(message: string, defaultYes = false): Promise<boolean> {
    while (true) {
      const value = (await this.ask(`${message} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
      if (!value) return defaultYes;
      if (['y', 'yes', 'д', 'да'].includes(value)) return true;
      if (['n', 'no', 'н', 'нет'].includes(value)) return false;
      this.write('Введите y или n.');
    }
  }
}
