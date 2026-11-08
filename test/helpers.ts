import type { Logger } from '../src/server/logger';

export const FAKE_TOKEN = '123456789:AAFakeTokenFakeTokenFakeToken_12345';

export interface CapturedLogger extends Logger {
  lines: string[];
}

export function captureLogger(): CapturedLogger {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (msg: string, ...extra: unknown[]): void => {
      lines.push([level, msg, ...extra.map(String)].join(' '));
    };
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

export const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
