import { describe, expect, it } from 'vitest';
import { findChromium } from '../src/server/chromium-path';

const env = (files: string[], platform: NodeJS.Platform = 'linux') => ({
  platform,
  pathEnv: '/usr/local/bin:/usr/bin',
  exists: (p: string) => files.includes(p),
});

describe('findChromium', () => {
  it('优先使用配置路径', () => {
    expect(findChromium('/opt/chrome', env(['/opt/chrome', '/usr/bin/chromium']))).toEqual({ path: '/opt/chrome', source: 'config' });
  });
  it('配置路径无效时回退系统查找并给出警告', () => {
    const r = findChromium('/nope', env(['/usr/bin/chromium']));
    expect(r).toMatchObject({ path: '/usr/bin/chromium', source: 'system' });
    expect(r.warning).toContain('/nope');
  });
  it('macOS 固定位置', () => {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(findChromium(undefined, env([p], 'darwin')).path).toBe(p);
  });
  it('都找不到：给出安装提示', () => {
    const r = findChromium(undefined, env([]));
    expect(r.path).toBeUndefined();
    expect(r.hint).toMatch(/apt install chromium/);
  });
  it('android（Termux）：提示用 proot-distro Debian，说明原生不支持', () => {
    const r = findChromium(undefined, env([], 'android'));
    expect(r.hint).toMatch(/proot-distro/);
    expect(r.hint).toMatch(/原生 Termux 不支持/);
  });
});
