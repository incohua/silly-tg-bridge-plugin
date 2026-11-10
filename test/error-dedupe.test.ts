import { describe, expect, it } from 'vitest';
const T0 = 1_700_000_000_000;
import { createErrorDedupe, ERROR_DEDUPE_MAX_ENTRIES } from '../src/extension/error-dedupe';

describe('createErrorDedupe', () => {
  it('同一条在窗口内只报一次，窗口过后可再报', () => {
    const d = createErrorDedupe(30_000, 200);
    expect(d.shouldReport('a', T0)).toBe(true);
    expect(d.shouldReport('a', T0 + 20_000)).toBe(false);
    expect(d.shouldReport('a', T0 + 31_001)).toBe(true);
  });

  it('大量不同错误：条目数不超过上限，最旧的先被丢弃', () => {
    const d = createErrorDedupe();
    for (let i = 0; i < ERROR_DEDUPE_MAX_ENTRIES * 5; i++) expect(d.shouldReport(`e${i}`, T0 + i)).toBe(true);
    expect(d.size).toBeLessThanOrEqual(ERROR_DEDUPE_MAX_ENTRIES);
    expect(d.shouldReport(`e${ERROR_DEDUPE_MAX_ENTRIES * 5 - 1}`, T0 + ERROR_DEDUPE_MAX_ENTRIES * 5)).toBe(false);
    expect(d.shouldReport('e0', T0 + ERROR_DEDUPE_MAX_ENTRIES * 5)).toBe(true);
  });

  it('写入时清掉窗口外的旧条目', () => {
    const d = createErrorDedupe(30_000, 200);
    for (let i = 0; i < 50; i++) d.shouldReport(`e${i}`, T0);
    expect(d.size).toBe(50);
    d.shouldReport('new', T0 + 100_000);
    expect(d.size).toBe(1);
  });
});
