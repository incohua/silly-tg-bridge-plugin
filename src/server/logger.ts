import { redact, redactError } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, ...extra: unknown[]): void;
  info(msg: string, ...extra: unknown[]): void;
  warn(msg: string, ...extra: unknown[]): void;
  error(msg: string, ...extra: unknown[]): void;
  /** 运行时调整日志级别（配置面板保存后用）。 */
  setLevel?(level: LogLevel): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 额外要脱敏的字符串（token、密码、代理凭据）。 */
  secrets?: readonly string[];
  /** 输出函数，测试里替换。 */
  sink?: (level: LogLevel, line: string) => void;
}

const PREFIX = '[silly-tg]';

const defaultSink = (level: LogLevel, line: string): void => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** 所有输出（消息和附加参数，含 Error）都先脱敏。 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  let min = ORDER[opts.level ?? 'info'];
  const secrets = opts.secrets ?? [];
  const sink = opts.sink ?? defaultSink;
  const fmt = (v: unknown): string => (typeof v === 'string' ? redact(v, secrets) : redactError(v, secrets));
  const emit =
    (level: LogLevel) =>
    (msg: string, ...extra: unknown[]): void => {
      if (ORDER[level] < min) return;
      const line = [`${PREFIX} ${level === 'info' ? '' : `${level.toUpperCase()} `}${fmt(msg)}`, ...extra.map(fmt)].join(' ');
      sink(level, line);
    };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    setLevel: (level) => void (min = ORDER[level]),
  };
}
