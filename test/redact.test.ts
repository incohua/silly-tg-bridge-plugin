import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/server/logger';
import { redact, redactError } from '../src/server/redact';
import { FAKE_TOKEN } from './helpers';

describe('redact', () => {
  it('替换 URL 里的 token', () => {
    expect(redact(`https://api.telegram.org/bot${FAKE_TOKEN}/getMe`)).toBe('https://api.telegram.org/bot***/getMe');
  });
  it('替换已知秘密字符串', () => {
    expect(redact('password=hunter22', ['hunter22'])).toBe('password=***');
  });
  it('Error 的 message、stack 和 cause 链都脱敏', () => {
    const inner = new Error(`connect failed https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`);
    const outer = new Error('fetch failed', { cause: inner });
    const text = redactError(outer);
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).toContain('fetch failed');
  });
  it('非 Error 值也能处理', () => {
    expect(redactError({ url: `x/bot${FAKE_TOKEN}` })).not.toContain(FAKE_TOKEN);
  });
});

describe('logger', () => {
  it('消息和附加的 Error 参数都不泄漏 token 与秘密', () => {
    const out: string[] = [];
    const log = createLogger({ level: 'debug', secrets: ['s3cret-pass'], sink: (_l, line) => out.push(line) });
    log.info(`token ${FAKE_TOKEN}`, new Error(`bad url /bot${FAKE_TOKEN}/x s3cret-pass`));
    log.error('plain', { token: FAKE_TOKEN });
    const all = out.join('\n');
    expect(all).not.toContain(FAKE_TOKEN);
    expect(all).not.toContain('s3cret-pass');
    expect(out).toHaveLength(2);
  });
  it('按级别过滤', () => {
    const out: string[] = [];
    const log = createLogger({ level: 'warn', sink: (_l, line) => out.push(line) });
    log.debug('a');
    log.info('b');
    log.warn('c');
    expect(out).toHaveLength(1);
  });
});
