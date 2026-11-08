import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deployExtension, findStRoot } from '../src/server/deploy-extension';

function setup(): { plugin: string; st: string } {
  const root = mkdtempSync(join(tmpdir(), 'silly-tg-deploy-'));
  const plugin = join(root, 'plugins', 'silly-tg');
  const st = root;
  mkdirSync(join(plugin, 'dist', 'extension'), { recursive: true });
  writeFileSync(join(plugin, 'dist', 'extension', 'manifest.json'), '{"js":"index.js"}');
  writeFileSync(join(plugin, 'dist', 'extension', 'index.js'), 'new');
  mkdirSync(join(st, 'public', 'scripts', 'extensions', 'third-party'), { recursive: true });
  return { plugin, st };
}

describe('deployExtension', () => {
  it('复制扩展并替换旧文件', async () => {
    const { plugin, st } = setup();
    const target = join(st, 'public', 'scripts', 'extensions', 'third-party', 'silly-tg');
    mkdirSync(target);
    writeFileSync(join(target, 'stale.js'), 'old');
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r).toMatchObject({ ok: true, target });
    expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('new');
    expect(existsSync(join(target, 'stale.js'))).toBe(false);
  });
  it('cwd 不是 ST 根目录时回退到插件目录的上两级（符号链接场景之外的常规安装）', () => {
    const { plugin, st } = setup();
    expect(findStRoot(plugin, '/definitely/not/here')).toBe(st);
  });
  it('找不到 ST 根目录：不抛错，给出手动步骤', async () => {
    const { plugin } = setup();
    const r = await deployExtension({ pluginDir: plugin, stRoot: undefined, cwd: '/definitely/not/here' });
    // 常规结构下上两级就是 ST，这里强制一个没有 public 目录的布局
    const lonely = mkdtempSync(join(tmpdir(), 'silly-tg-lonely-'));
    mkdirSync(join(lonely, 'dist', 'extension'), { recursive: true });
    writeFileSync(join(lonely, 'dist', 'extension', 'manifest.json'), '{}');
    const r2 = await deployExtension({ pluginDir: lonely, cwd: '/definitely/not/here' });
    expect(r.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r2.manual).toContain('third-party/silly-tg');
  });
  it('缺少构建产物：提示构建', async () => {
    const lonely = mkdtempSync(join(tmpdir(), 'silly-tg-nodist-'));
    const r = await deployExtension({ pluginDir: lonely, stRoot: lonely });
    expect(r.ok).toBe(false);
    expect(r.manual).toMatch(/pnpm build|dist/);
  });
  it('复制失败时返回手动步骤而不是抛错', async () => {
    const { plugin, st } = setup();
    // third-party 位置放一个文件，导致 cp 失败
    const tp = join(st, 'public', 'scripts', 'extensions', 'third-party');
    writeFileSync(join(tp, 'x'), '');
    const bad = join(st, 'public', 'scripts', 'extensions');
    const r = await deployExtension({ pluginDir: plugin, stRoot: join(bad, 'third-party', 'x') });
    expect(r.ok).toBe(false);
    expect(r.manual).toBeTruthy();
  });
});
