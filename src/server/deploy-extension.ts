import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const EXTENSION_DIR_NAME = 'silly-tg';
/** 写在部署目录里的标记：版本 + 内容哈希。有它说明这个目录是本插件自动部署出来的。 */
export const DEPLOY_MARKER = '.silly-tg-deploy.json';
/** 旧版本（v0.2.0 及更早）没有标记文件，靠 manifest 的 homePage 认出来。 */
const REPO_URL_RE = /github\.com\/incohua\/silly-tg-bridge-plugin/i;

export interface DeployResult {
  ok: boolean;
  /** 目标目录（找到 ST 根目录时才有）。 */
  target?: string;
  /** 成功时给日志的一句话（部署了、已是最新、还是跳过及原因）。 */
  message?: string;
  /** 成功但值得提醒的事，日志用 warn。 */
  warning?: string;
  /** 失败时给用户的手动步骤。 */
  manual?: string;
  reason?: string;
  /** 检测到 ST 里已有其它副本（面板安装的），没有复制。 */
  skipped?: boolean;
  /** 目标目录内容已是最新，没有复制。 */
  unchanged?: boolean;
  /** 检测到的其它副本目录。 */
  others?: string[];
  /** 清理了旧的自动部署副本。 */
  removedStale?: boolean;
}

/** 找 ST（或 Luker）根目录：先看进程工作目录（ST 启动时会 chdir 到自己的根），再看插件目录的上两级。 */
export function findStRoot(pluginDir: string, cwd: string = process.cwd(), exists: (p: string) => boolean = existsSync): string | undefined {
  const candidates = [cwd, resolve(pluginDir, '..', '..')];
  return candidates.find((c) => exists(join(c, 'public', 'scripts', 'extensions')));
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse(await readFile(p, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 目录是否存在（软链接本身也算存在，不跟随）。 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 这个目录是不是本插件自动部署出来的（可以放心覆盖或删除）。
 * 软链接、带 .git 的目录（用户自己 clone 的）一律不是；其余看标记文件、manifest 的 silly_tg 字段，
 * 或 manifest 的 homePage 指向本仓库（兼容没有标记文件的旧版部署）。
 */
export async function isOurs(dir: string): Promise<boolean> {
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (await pathExists(join(dir, '.git'))) return false;
    if (await readJson(join(dir, DEPLOY_MARKER))) return true;
    const manifest = await readJson(join(dir, 'manifest.json'));
    if (!manifest) return false;
    if (manifest.silly_tg === true) return true;
    return typeof manifest.homePage === 'string' && REPO_URL_RE.test(manifest.homePage);
  } catch {
    return false;
  }
}

/** ST 的数据根目录：优先取 ST 设置的全局变量 DATA_ROOT（插件与 ST 同进程），取不到用 <ST>/data。 */
export function resolveDataRoot(stRoot: string): string {
  const g = (globalThis as { DATA_ROOT?: unknown }).DATA_ROOT;
  return typeof g === 'string' && g ? resolve(stRoot, g) : join(stRoot, 'data');
}

/**
 * 找 ST 里已经装好的其它本扩展副本（manifest 带 silly_tg: true），排除我们自己的部署目标。
 * 只扫无头页面能加载到的位置：全局 third-party 和 default-user 的用户级扩展目录
 * （无头页面以 default-user 身份运行，其它用户的副本它加载不到）。
 * 任何读取失败都当作“没有”，不抛错。
 */
export async function findOtherCopies(stRoot: string, dataRoot: string = resolveDataRoot(stRoot)): Promise<string[]> {
  const roots = [join(stRoot, 'public', 'scripts', 'extensions', 'third-party'), join(dataRoot, 'default-user', 'extensions')];
  const found: string[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = (await readdir(root)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      // 点开头的是我们自己的临时目录（或别的隐藏目录）；root 为 third-party 时 silly-tg 是我们自己的部署目标
      if (name.startsWith('.') || (name === EXTENSION_DIR_NAME && root === roots[0])) continue;
      const dir = join(root, name);
      try {
        if (!(await stat(dir)).isDirectory()) continue;
        if ((await readJson(join(dir, 'manifest.json')))?.silly_tg === true) found.push(dir);
      } catch {
        // 读不到就当没有
      }
    }
  }
  return found;
}

/** 目录内容哈希：相对路径 + 文件内容，按路径排序。ignore 里的文件名不参与（部署标记）。 */
async function hashDir(dir: string, ignore: string[] = []): Promise<string> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile() && !ignore.includes(r)) files.push(r);
    }
  };
  await walk('');
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${f}\0`);
    h.update(await readFile(join(dir, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

/** 目标目录已经是当前内容：标记文件的哈希与来源一致，且目录实际内容也一致。 */
async function isUpToDate(target: string, sourceHash: string): Promise<boolean> {
  const marker = await readJson(join(target, DEPLOY_MARKER));
  if (!marker || marker.hash !== sourceHash) return false;
  try {
    return (await hashDir(target, [DEPLOY_MARKER])) === sourceHash;
  } catch {
    return false;
  }
}

/** 清掉以前崩溃或删除失败留下的临时目录（固定命名 .silly-tg.tmp-<pid> / .silly-tg.old-<pid>）。尽力而为，不抛错。 */
async function cleanStaleTemps(parent: string): Promise<void> {
  try {
    for (const name of await readdir(parent)) {
      if (/^\.silly-tg\.(tmp|old)-\d+$/.test(name)) await rm(join(parent, name), { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    // 清不掉不影响部署
  }
}

/**
 * 把 dist/extension 部署到 <ST>/public/scripts/extensions/third-party/silly-tg。
 * - ST 里已有其它副本（面板安装的）时不复制，并清理确认是我方产物的旧自动部署副本，避免加载两份；
 * - 否则幂等地复制：内容一致就跳过；先复制到同级临时目录再替换，失败不留空目录；
 * - 目标目录存在但不能确认是我方产物（软链接、带 .git、非本插件）时不删不覆盖，只警告。
 * 永远不抛错，失败返回手动步骤。
 */
export async function deployExtension(opts: { pluginDir: string; stRoot?: string; cwd?: string; dataRoot?: string }): Promise<DeployResult> {
  const source = join(opts.pluginDir, 'dist', 'extension');
  const stRoot = opts.stRoot ?? findStRoot(opts.pluginDir, opts.cwd);
  const manualFor = (target: string): string =>
    `手动安装：把 ${source} 整个目录复制为 ${target}，然后刷新 ST 页面（或重启 ST）。`;

  if (!existsSync(join(source, 'manifest.json'))) {
    return { ok: false, reason: `找不到扩展构建产物 ${source}（缺 manifest.json）。`, manual: '在插件目录运行 pnpm build，或重新 git clone 完整的仓库（dist/ 需要在仓库里）。' };
  }
  if (!stRoot) {
    return {
      ok: false,
      reason: '没有找到 SillyTavern 根目录（public/scripts/extensions 不存在）。',
      manual: manualFor('<ST 根目录>/public/scripts/extensions/third-party/silly-tg'),
    };
  }
  const target = join(stRoot, 'public', 'scripts', 'extensions', 'third-party', EXTENSION_DIR_NAME);
  const parent = dirname(target);
  const tmp = join(parent, `.${EXTENSION_DIR_NAME}.tmp-${process.pid}`);
  const old = join(parent, `.${EXTENSION_DIR_NAME}.old-${process.pid}`);
  try {
    const others = await findOtherCopies(stRoot, opts.dataRoot ?? resolveDataRoot(stRoot));
    const targetExists = await pathExists(target);
    const ours = targetExists && (await isOurs(target));

    if (others.length > 0) {
      // 已经通过 ST 装了一份：不再复制。旧的自动部署副本（确认是我方产物）要删掉，否则 ST 会加载两份。
      let removedStale = false;
      let warning: string | undefined;
      if (targetExists) {
        if (ours) {
          // 固定路径 third-party/silly-tg，且已确认是我方产物
          await rm(target, { recursive: true, force: true });
          removedStale = true;
        } else {
          warning = `${target} 不是本插件自动部署的目录，没有动它；它和 ST 里已安装的副本可能同时被加载，需要的话请手动处理。`;
        }
      }
      return {
        ok: true,
        skipped: true,
        target,
        others,
        removedStale,
        warning,
        message: `检测到已通过 ST 安装的 UI 扩展：${others.join('、')}，跳过自动复制${removedStale ? `，并清理了旧的自动部署副本 ${target}` : ''}。`,
      };
    }

    if (targetExists && !ours) {
      return {
        ok: false,
        target,
        reason: `${target} 已存在，但看起来不是本插件自动部署的（软链接、带 .git，或不是 Silly TG），为避免误删没有覆盖。`,
        manual: `如果这个目录不需要保留，删除它后重启 ST，插件会重新部署；如果是你自己放的开发版本，保留即可，插件不会再动它。${manualFor(target)}`,
      };
    }

    const hash = await hashDir(source);
    if (ours && (await isUpToDate(target, hash))) {
      return { ok: true, target, unchanged: true, message: `UI 扩展已是最新，无需复制（${target}）` };
    }

    const manifest = await readJson(join(source, 'manifest.json'));
    await cleanStaleTemps(parent);
    await rm(tmp, { recursive: true, force: true });
    await rm(old, { recursive: true, force: true });
    await cp(source, tmp, { recursive: true });
    await writeFile(join(tmp, DEPLOY_MARKER), JSON.stringify({ version: manifest?.version ?? 'unknown', hash }, null, 2));
    let moved = false;
    try {
      if (targetExists) {
        await rename(target, old);
        moved = true;
      }
      await rename(tmp, target);
    } catch (e) {
      // 替换失败：把旧目录放回去
      if (moved) await rename(old, target).catch(() => undefined);
      throw e;
    }
    if (moved) await rm(old, { recursive: true, force: true }).catch(() => undefined);
    return { ok: true, target, message: `UI 扩展已部署到 ${target}` };
  } catch (e) {
    return { ok: false, target, reason: `部署失败：${(e as Error).message}`, manual: manualFor(target) };
  } finally {
    // 成功时 tmp 已被改名，force 删除不存在的路径无副作用；失败时清掉半成品
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
