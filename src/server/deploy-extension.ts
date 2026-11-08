import { existsSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const EXTENSION_DIR_NAME = 'silly-tg';

export interface DeployResult {
  ok: boolean;
  /** 目标目录（找到 ST 根目录时才有）。 */
  target?: string;
  /** 失败时给用户的手动步骤。 */
  manual?: string;
  reason?: string;
}

/** 找 ST（或 Luker）根目录：先看进程工作目录（ST 启动时会 chdir 到自己的根），再看插件目录的上两级。 */
export function findStRoot(pluginDir: string, cwd: string = process.cwd(), exists: (p: string) => boolean = existsSync): string | undefined {
  const candidates = [cwd, resolve(pluginDir, '..', '..')];
  return candidates.find((c) => exists(join(c, 'public', 'scripts', 'extensions')));
}

/**
 * 把 dist/extension 复制到 <ST>/public/scripts/extensions/third-party/silly-tg。
 * 目录整体替换，避免遗留旧版本文件。永远不抛错，失败返回手动步骤。
 */
export async function deployExtension(opts: { pluginDir: string; stRoot?: string; cwd?: string }): Promise<DeployResult> {
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
  try {
    // 目标路径是固定拼出来的，只会删除我们自己的目录。
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
    return { ok: true, target };
  } catch (e) {
    return { ok: false, target, reason: `复制失败：${(e as Error).message}`, manual: manualFor(target) };
  }
}

