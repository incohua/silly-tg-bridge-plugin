import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEPLOY_MARKER, deployExtension, findOtherCopies, findStRoot, isOurs } from '../src/server/deploy-extension';

// 故障注入：让 fs/promises 的 cp / rename 在指定时机失败。默认全部透传。
const inject = vi.hoisted(() => ({ cpFailsAfterCopy: false, renameTmpFails: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    cp: async (...a: Parameters<typeof real.cp>) => {
      await real.cp(...a);
      if (inject.cpFailsAfterCopy) throw new Error('disk full');
    },
    rename: async (from: string, to: string) => {
      if (inject.renameTmpFails && String(from).includes('.silly-tg.tmp-')) throw new Error('rename denied');
      return real.rename(from, to);
    },
  };
});
afterEach(() => {
  inject.cpFailsAfterCopy = false;
  inject.renameTmpFails = false;
});

const HOME_PAGE = 'https://github.com/incohua/silly-tg-bridge-plugin';

interface Env {
  plugin: string;
  st: string;
  /** ST 的 third-party 目录 */
  tp: string;
  /** 我们的部署目标 */
  target: string;
  /** default-user 的用户级扩展目录 */
  userExt: string;
}

function setup(): Env {
  const root = mkdtempSync(join(tmpdir(), 'silly-tg-deploy-'));
  const plugin = join(root, 'plugins', 'silly-tg');
  const st = root;
  mkdirSync(join(plugin, 'dist', 'extension'), { recursive: true });
  writeFileSync(join(plugin, 'dist', 'extension', 'manifest.json'), JSON.stringify({ js: 'index.js', version: '9.9.9', silly_tg: true, homePage: HOME_PAGE }));
  writeFileSync(join(plugin, 'dist', 'extension', 'index.js'), 'new');
  const tp = join(st, 'public', 'scripts', 'extensions', 'third-party');
  mkdirSync(tp, { recursive: true });
  return { plugin, st, tp, target: join(tp, 'silly-tg'), userExt: join(st, 'data', 'default-user', 'extensions') };
}

/** 在 dir 下放一份“面板安装的”副本。 */
function putPanelCopy(dir: string, manifest: object = { js: 'dist/extension/index.js', silly_tg: true }): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

/** 旧版（v0.2.0）部署出来的目录：没有标记文件，manifest 没有 silly_tg，只有 homePage。 */
function putLegacyCopy(target: string): void {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ js: 'index.js', version: '0.2.0', homePage: HOME_PAGE }));
  writeFileSync(join(target, 'index.js'), 'old');
  writeFileSync(join(target, 'stale.js'), 'old');
}

const leftovers = (tp: string): string[] => readdirSync(tp).filter((n) => n.startsWith('.silly-tg.'));

describe('deployExtension：没有其它副本', () => {
  it('首次部署：复制、写标记文件', async () => {
    const { plugin, st, target } = setup();
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r).toMatchObject({ ok: true, target });
    expect(r.skipped).toBeUndefined();
    expect(r.unchanged).toBeUndefined();
    expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('new');
    const marker = JSON.parse(readFileSync(join(target, DEPLOY_MARKER), 'utf8')) as { version: string; hash: string };
    expect(marker.version).toBe('9.9.9');
    expect(marker.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('二次启动内容一致：跳过复制，不改动文件', async () => {
    const { plugin, st, target } = setup();
    await deployExtension({ pluginDir: plugin, cwd: st });
    const before = lstatSync(join(target, 'index.js')).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r).toMatchObject({ ok: true, unchanged: true });
    expect(lstatSync(join(target, 'index.js')).mtimeMs).toBe(before);
  });
  it('来源内容变化：重新部署，并去掉旧文件', async () => {
    const { plugin, st, target, tp } = setup();
    await deployExtension({ pluginDir: plugin, cwd: st });
    writeFileSync(join(target, 'stale.js'), 'x');
    writeFileSync(join(plugin, 'dist', 'extension', 'index.js'), 'newer');
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r).toMatchObject({ ok: true });
    expect(r.unchanged).toBeUndefined();
    expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('newer');
    expect(existsSync(join(target, 'stale.js'))).toBe(false);
    expect(leftovers(tp)).toEqual([]);
  });
  it('目标目录被手动改过（哈希对不上）：重新部署', async () => {
    const { plugin, st, target } = setup();
    await deployExtension({ pluginDir: plugin, cwd: st });
    writeFileSync(join(target, 'index.js'), 'tampered');
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r.unchanged).toBeUndefined();
    expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('new');
  });
  it('v0.2.0 的旧副本（无标记文件，靠 homePage 识别）：更新为当前版本', async () => {
    const { plugin, st, target } = setup();
    putLegacyCopy(target);
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r).toMatchObject({ ok: true });
    expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('new');
    expect(existsSync(join(target, 'stale.js'))).toBe(false);
    expect(existsSync(join(target, DEPLOY_MARKER))).toBe(true);
  });
  it('扫描目录（default-user、其它用户）都不存在：当作没有其它副本，照常部署', async () => {
    const { plugin, st, target } = setup();
    expect(existsSync(join(st, 'data'))).toBe(false);
    expect((await deployExtension({ pluginDir: plugin, cwd: st })).ok).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});

describe('deployExtension：已有其它副本（面板安装）', () => {
  it('third-party 下有其它副本：不复制，日志说明原因', async () => {
    const { plugin, st, tp, target } = setup();
    const panel = putPanelCopy(join(tp, 'silly-tg-bridge-plugin'));
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r).toMatchObject({ ok: true, skipped: true, others: [panel] });
    expect(r.message).toContain(panel);
    expect(r.message).toContain('跳过自动复制');
    expect(existsSync(target)).toBe(false);
  });
  it('default-user 的用户级目录下有其它副本：同样跳过', async () => {
    const { plugin, st, userExt } = setup();
    const panel = putPanelCopy(join(userExt, 'silly-tg-bridge-plugin'));
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r).toMatchObject({ ok: true, skipped: true, others: [panel] });
  });
  it('老用户升级后又装了面板副本：清理旧的自动部署副本（含 v0.2.0 无标记的旧副本）', async () => {
    const { plugin, st, tp, target } = setup();
    putLegacyCopy(target);
    putPanelCopy(join(tp, 'silly-tg-bridge-plugin'));
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r).toMatchObject({ ok: true, skipped: true, removedStale: true });
    expect(existsSync(target)).toBe(false);
    expect(r.message).toContain('清理');
  });
  it('其它用户（非 default-user）的扩展目录里有副本：不算，照常部署，不删全局副本', async () => {
    const { plugin, st, target } = setup();
    putPanelCopy(join(st, 'data', 'alice', 'extensions', 'silly-tg-bridge-plugin'));
    putLegacyCopy(target);
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r.skipped).toBeUndefined();
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('new');
  });
  it('其它副本在，但 third-party/silly-tg 不是我方产物：不删，给警告', async () => {
    const { plugin, st, tp, target } = setup();
    putPanelCopy(join(tp, 'silly-tg-bridge-plugin'));
    mkdirSync(target);
    writeFileSync(join(target, 'manifest.json'), '{"display_name":"别人的扩展"}');
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r).toMatchObject({ ok: true, skipped: true, removedStale: false });
    expect(r.warning).toContain(target);
    expect(existsSync(join(target, 'manifest.json'))).toBe(true);
  });
  it('manifest 没有 silly_tg 的其它扩展不算副本', async () => {
    const { plugin, st, tp } = setup();
    putPanelCopy(join(tp, 'some-other-extension'), { display_name: 'x' });
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r.skipped).toBeUndefined();
    expect(r.ok).toBe(true);
  });
  it('dataRoot 可指定（ST 的 DATA_ROOT 不在 <ST>/data 时）', async () => {
    const { plugin, st } = setup();
    const dataRoot = mkdtempSync(join(tmpdir(), 'silly-tg-dataroot-'));
    putPanelCopy(join(dataRoot, 'default-user', 'extensions', 'silly-tg-bridge-plugin'));
    expect((await deployExtension({ pluginDir: plugin, cwd: st, dataRoot })).skipped).toBe(true);
    expect((await deployExtension({ pluginDir: plugin, cwd: st })).skipped).toBeUndefined();
  });
});

describe('deployExtension：不能确认是我方产物的目标目录', () => {
  it('软链接：不删不覆盖，警告并给手动步骤', async () => {
    const { plugin, st, target } = setup();
    const real = mkdtempSync(join(tmpdir(), 'silly-tg-dev-'));
    writeFileSync(join(real, 'manifest.json'), JSON.stringify({ silly_tg: true, homePage: HOME_PAGE }));
    writeFileSync(join(real, 'index.js'), 'dev');
    symlinkSync(real, target);
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r.ok).toBe(false);
    expect(r.manual).toBeTruthy();
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(real, 'index.js'), 'utf8')).toBe('dev');
  });
  it('带 .git 的目录（用户自己 clone 的）：不动', async () => {
    const { plugin, st, target } = setup();
    putLegacyCopy(target);
    mkdirSync(join(target, '.git'));
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('old');
  });
  it('没有标记且 homePage 不匹配：不动', async () => {
    const { plugin, st, target } = setup();
    mkdirSync(target);
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({ homePage: 'https://example.com/other' }));
    writeFileSync(join(target, 'index.js'), 'mine');
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('mine');
  });
  it('其它副本在、third-party/silly-tg 是软链接：清理分支也不删软链接', async () => {
    const { plugin, st, tp, target } = setup();
    putPanelCopy(join(tp, 'silly-tg-bridge-plugin'));
    const real = mkdtempSync(join(tmpdir(), 'silly-tg-dev-'));
    writeFileSync(join(real, 'manifest.json'), JSON.stringify({ silly_tg: true }));
    symlinkSync(real, target);
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r).toMatchObject({ ok: true, skipped: true, removedStale: false });
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(existsSync(join(real, 'manifest.json'))).toBe(true);
  });
});

describe('deployExtension：失败与边界', () => {
  it('复制中途失败（半成品已写到临时目录）：返回手动步骤、不抛错，旧部署原样保留，不留临时目录', async () => {
    const { plugin, st, tp, target } = setup();
    await deployExtension({ pluginDir: plugin, cwd: st });
    writeFileSync(join(plugin, 'dist', 'extension', 'index.js'), 'v2');
    inject.cpFailsAfterCopy = true;
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('disk full');
    expect(r.manual).toBeTruthy();
    expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('new');
    expect(leftovers(tp)).toEqual([]);
  });
  it('首次部署复制失败：不留下空的目标目录', async () => {
    const { plugin, st, tp, target } = setup();
    inject.cpFailsAfterCopy = true;
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(leftovers(tp)).toEqual([]);
  });
  it('以前崩溃遗留的临时目录（.silly-tg.tmp-/.old-）会在部署时清掉，其它隐藏目录不动', async () => {
    const { plugin, st, tp } = setup();
    mkdirSync(join(tp, '.silly-tg.tmp-1'), { recursive: true });
    mkdirSync(join(tp, '.silly-tg.old-2'), { recursive: true });
    mkdirSync(join(tp, '.other-hidden'), { recursive: true });
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r.ok).toBe(true);
    expect(readdirSync(tp).sort()).toEqual(['.other-hidden', 'silly-tg']);
  });

  it('替换最后一步失败：把旧目录放回去', async () => {
    const { plugin, st, tp, target } = setup();
    await deployExtension({ pluginDir: plugin, cwd: st });
    writeFileSync(join(plugin, 'dist', 'extension', 'index.js'), 'v2');
    inject.renameTmpFails = true;
    const r = await deployExtension({ pluginDir: plugin, cwd: st });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('new');
    expect(existsSync(join(target, DEPLOY_MARKER))).toBe(true);
    expect(leftovers(tp)).toEqual([]);
  });
  it('cwd 不是 ST 根目录时回退到插件目录的上两级（符号链接场景之外的常规安装）', () => {
    const { plugin, st } = setup();
    expect(findStRoot(plugin, '/definitely/not/here')).toBe(st);
  });
  it('找不到 ST 根目录：不抛错，给出手动步骤', async () => {
    const lonely = mkdtempSync(join(tmpdir(), 'silly-tg-lonely-'));
    mkdirSync(join(lonely, 'dist', 'extension'), { recursive: true });
    writeFileSync(join(lonely, 'dist', 'extension', 'manifest.json'), '{}');
    const r2 = await deployExtension({ pluginDir: lonely, cwd: '/definitely/not/here' });
    expect(r2.ok).toBe(false);
    expect(r2.manual).toContain('third-party/silly-tg');
  });
  it('缺少构建产物：提示构建', async () => {
    const lonely = mkdtempSync(join(tmpdir(), 'silly-tg-nodist-'));
    const r = await deployExtension({ pluginDir: lonely, stRoot: lonely });
    expect(r.ok).toBe(false);
    expect(r.manual).toMatch(/pnpm build|dist/);
  });
  it('third-party 位置不可写（路径上有文件）：返回手动步骤而不是抛错', async () => {
    const { plugin, tp } = setup();
    writeFileSync(join(tp, 'x'), '');
    const r = await deployExtension({ pluginDir: plugin, stRoot: join(tp, 'x') });
    expect(r.ok).toBe(false);
    expect(r.manual).toBeTruthy();
  });
});

describe('findOtherCopies / isOurs', () => {
  it('忽略点开头的临时目录和我们自己的部署目标', async () => {
    const { st, tp } = setup();
    putPanelCopy(join(tp, '.silly-tg.tmp-1'));
    putPanelCopy(join(tp, 'silly-tg'));
    expect(await findOtherCopies(st)).toEqual([]);
  });
  it('用户级目录里叫 silly-tg 的副本算其它副本（只排除 third-party 下的那个）', async () => {
    const { st, userExt } = setup();
    const p = putPanelCopy(join(userExt, 'silly-tg'));
    expect(await findOtherCopies(st)).toEqual([p]);
  });
  it('manifest 损坏或不是对象：忽略', async () => {
    const { st, tp } = setup();
    mkdirSync(join(tp, 'bad'));
    writeFileSync(join(tp, 'bad', 'manifest.json'), '{oops');
    mkdirSync(join(tp, 'arr'));
    writeFileSync(join(tp, 'arr', 'manifest.json'), '[]');
    expect(await findOtherCopies(st)).toEqual([]);
  });
  it('isOurs：标记文件 / silly_tg / homePage 任一满足；不存在的目录为 false', async () => {
    const { tp } = setup();
    const a = join(tp, 'a');
    mkdirSync(a);
    writeFileSync(join(a, DEPLOY_MARKER), '{}');
    expect(await isOurs(a)).toBe(true);
    const b = putPanelCopy(join(tp, 'b'), { silly_tg: true });
    expect(await isOurs(b)).toBe(true);
    const c = putPanelCopy(join(tp, 'c'), { homePage: `${HOME_PAGE}#readme` });
    expect(await isOurs(c)).toBe(true);
    expect(await isOurs(join(tp, 'nope'))).toBe(false);
  });
});
