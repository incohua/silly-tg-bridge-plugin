// 无头浏览器启动失败的诊断：把 puppeteer 的原始报错归类，给出一句可操作的修法。
// 纯函数。puppeteer 的报错格式随版本变化，所以按文本关键词匹配；匹配不上返回 null，
// 调用方回退为原始信息，保证不比没有诊断更差。

import { chromiumInstallHint } from './chromium-path';

export type BrowserErrorKind = 'missing-libs' | 'snap' | 'root' | 'sandbox' | 'not-found';

export interface BrowserDiagnosis {
  kind: BrowserErrorKind;
  /** 一句话修法，可直接给用户看。 */
  hint: string;
}

export interface DiagnoseContext {
  platform: NodeJS.Platform;
  isRoot: boolean;
  /** 实际启动的可执行文件路径，没有则为 undefined。 */
  chromiumPath?: string;
}

const NO_SANDBOX_ENV =
  '在启动 SillyTavern 的环境里设置环境变量 PUPPETEER_DANGEROUS_NO_SANDBOX=true 后重启 ST（systemd 写 Environment=，容器写进环境变量设置）。这会关闭 Chromium 沙箱，降低浏览器与系统的隔离，只在访问你自己的 ST 页面时可以接受';
const ANDROID_NOTE = '当前是 Termux（android），原生 Termux 不受支持，请改用 proot-distro 里的 Debian（见 docs/install-linux.md）。';

const MISSING_LIBS_RE = /error while loading shared libraries|cannot open shared object file/i;
const ROOT_RE = /running as root without --no-sandbox/i;
const SANDBOX_RE =
  /no usable sandbox|failed to move to new namespace|(?:setuid|suid) sandbox|(?:sandbox|namespace)[^\n]*(?:not permitted|permission denied|operation not permitted|unprivileged)|(?:not permitted|permission denied|unprivileged)[^\n]*(?:sandbox|namespace)/i;
const SNAP_RE = /(?:^|[\s'"(])\/snap\/|\bsnap-confine\b|requires the chromium snap|\bsnap install\b/i;
const NOT_FOUND_RE = /could not find (?:chrome|chromium|browser)|no usable (?:chrome|chromium)|browser was not found|spawn [^\n]*ENOENT|ENOENT[^\n]*(?:chrome|chromium)/i;

/** 归类浏览器启动失败的报错。认不出来时返回 null。 */
export function diagnoseBrowserError(message: string, ctx: DiagnoseContext): BrowserDiagnosis | null {
  const android = ctx.platform === 'android' ? ANDROID_NOTE : '';
  const done = (kind: BrowserErrorKind, hint: string): BrowserDiagnosis => ({ kind, hint: android && kind !== 'snap' && kind !== 'not-found' ? `${hint}。${android}` : hint });

  if (MISSING_LIBS_RE.test(message)) {
    return done('missing-libs', '缺少 Chromium 运行需要的系统库。最省事的办法是用发行版自带的包安装（Debian/Ubuntu：apt install chromium 会连依赖一起装好），不要手动拷贝浏览器文件');
  }
  if (ctx.chromiumPath?.includes('/snap/') || SNAP_RE.test(message)) {
    return done('snap', '当前用的是 snap 版 Chromium，它的沙箱和临时目录限制会让无头启动失败。请改装 deb 版：Debian 用 apt install chromium；Ubuntu 用 Google Chrome 的 deb 包（见 docs/install-linux.md），然后卸载 snap 版或在 config.json 的 chromiumPath 里指向 deb 版');
  }
  if (ROOT_RE.test(message)) {
    return done('root', `以 root 运行时 Chromium 拒绝启动沙箱（插件通常会自动加 --no-sandbox，这次没有生效）。${NO_SANDBOX_ENV}`);
  }
  if (SANDBOX_RE.test(message)) {
    return done('sandbox', `Chromium 沙箱在当前环境不可用（常见于容器、没有用户命名空间权限的系统或非 root 的容器模式）。${NO_SANDBOX_ENV}`);
  }
  if (NOT_FOUND_RE.test(message)) {
    return done('not-found', `找不到可执行的浏览器。${chromiumInstallHint(ctx.platform)}`);
  }
  return null;
}
