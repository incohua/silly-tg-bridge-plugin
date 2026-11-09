// 单例保护。ST 面板装的副本和服务端自动部署的副本可能同时被加载（目录名不同），
// 两份都执行会重复处理消息。先执行的占位，后到的看到占位就退出。
// 占位必须在入口顶层、任何 await 之前同步完成，否则两份会同时通过检查。

export const SINGLETON_KEY = '__SILLY_TG__';

export type ClaimResult = { ok: true } | { ok: false; existingVersion: string };

/** 纯函数：在给定的全局对象上占位。已被占用返回先到那份的版本。 */
export function claimSingleton(g: Record<string, unknown>, version: string): ClaimResult {
  const existing = g[SINGLETON_KEY];
  if (existing !== undefined && existing !== null) {
    const v = (existing as { version?: unknown }).version;
    return { ok: false, existingVersion: typeof v === 'string' ? v : 'unknown' };
  }
  g[SINGLETON_KEY] = { version };
  return { ok: true };
}

/** 重复加载时给控制台和 toast 用的提示文字。 */
export function duplicateMessage(existingVersion: string, thisVersion: string): string {
  return `检测到 Silly TG 扩展被加载了两份（已在运行的版本 ${existingVersion}，本份版本 ${thisVersion}），本份已停用。请在 ST 的扩展管理里删掉多余的一份，或重启 ST 让插件自动清理。`;
}
