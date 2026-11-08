import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/server/logger';

describe('logger.setLevel', () => {
  it('运行时调整级别立即生效', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sink: (_l, line) => lines.push(line) });
    log.debug('d1');
    log.setLevel?.('debug');
    log.debug('d2');
    log.setLevel?.('error');
    log.warn('w1');
    log.error('e1');
    expect(lines.map((l) => l.replace(/^\S+\s+/, ''))).toEqual([expect.stringContaining('d2'), expect.stringContaining('e1')]);
  });
});
