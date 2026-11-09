// 构建时由 esbuild 的 define 注入（见 build.mjs，值来自 package.json）。
// 测试和 tsc 环境里没有注入，回退为 'dev'。
declare const __SILLY_TG_VERSION__: string | undefined;

export const VERSION: string = typeof __SILLY_TG_VERSION__ === 'string' ? __SILLY_TG_VERSION__ : 'dev';

/**
 * 服务端收到 UI 扩展 hello 后的版本比对。
 * 一致、扩展没带版本（旧版 UI）、任一边是开发构建都不提示；否则返回给日志用的警告文字。
 */
export function versionMismatchWarning(serverVersion: string, extVersion: string | undefined): string | null {
  if (extVersion === undefined || extVersion === serverVersion) return null;
  if (serverVersion === 'dev' || extVersion === 'dev') return null;
  return `UI 扩展版本（${extVersion}）与服务端插件版本（${serverVersion}）不一致，请把两边都更新到同一版本，否则部分功能可能异常。`;
}
