import { describe, expect, it } from 'vitest';
import { claimSingleton, duplicateMessage, SINGLETON_KEY } from '../src/extension/singleton';
import { versionMismatchWarning } from '../src/shared/version';

describe('versionMismatchWarning', () => {
  it('一致、旧版扩展没带版本、开发构建：不警告', () => {
    expect(versionMismatchWarning('0.3.0', '0.3.0')).toBeNull();
    expect(versionMismatchWarning('0.3.0', undefined)).toBeNull();
    expect(versionMismatchWarning('dev', '0.3.0')).toBeNull();
    expect(versionMismatchWarning('0.3.0', 'dev')).toBeNull();
  });
  it('不一致：警告里含两边版本', () => {
    const w = versionMismatchWarning('0.3.0', '0.2.0');
    expect(w).toContain('0.2.0');
    expect(w).toContain('0.3.0');
  });
});

describe('claimSingleton', () => {
  it('第一份占位成功，第二份被拒并拿到先到那份的版本', () => {
    const g: Record<string, unknown> = {};
    expect(claimSingleton(g, '0.3.0')).toEqual({ ok: true });
    expect(g[SINGLETON_KEY]).toEqual({ version: '0.3.0' });
    expect(claimSingleton(g, '0.2.0')).toEqual({ ok: false, existingVersion: '0.3.0' });
    // 不覆盖先到的占位
    expect(g[SINGLETON_KEY]).toEqual({ version: '0.3.0' });
  });
  it('占位内容异常也不抛错', () => {
    expect(claimSingleton({ [SINGLETON_KEY]: true }, '1')).toEqual({ ok: false, existingVersion: 'unknown' });
  });
  it('重复提示里含两份版本', () => {
    const m = duplicateMessage('0.3.0', '0.2.0');
    expect(m).toContain('0.3.0');
    expect(m).toContain('0.2.0');
  });
});
