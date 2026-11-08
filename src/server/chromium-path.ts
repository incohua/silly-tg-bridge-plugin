import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface ChromiumLookup {
  /** 找到的可执行文件，没找到为 undefined。 */
  path?: string;
  source?: 'config' | 'system';
  /** 配置路径无效而回退到系统查找时的说明。 */
  warning?: string;
  /** 没找到时给用户的安装提示。 */
  hint?: string;
}

export interface ChromiumLookupEnv {
  platform: NodeJS.Platform;
  pathEnv: string;
  exists: (p: string) => boolean;
}

const defaultEnv = (): ChromiumLookupEnv => ({
  platform: process.platform,
  pathEnv: process.env.PATH ?? '',
  exists: (p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
});

const BIN_NAMES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge'];

const FIXED: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

const HINTS: Partial<Record<NodeJS.Platform, string>> = {
  linux: '安装 Chromium，例如 Debian/Ubuntu：apt install chromium（或 chromium-browser），也可以在 config.json 的 chromiumPath 里写可执行文件路径。',
  darwin: '安装 Google Chrome，或在 config.json 的 chromiumPath 里写可执行文件路径。',
};

/** 优先用配置路径，其次系统查找（固定安装位置、PATH）。 */
export function findChromium(configured?: string, env: ChromiumLookupEnv = defaultEnv()): ChromiumLookup {
  let warning: string | undefined;
  if (configured) {
    if (env.exists(configured)) return { path: configured, source: 'config' };
    warning = `chromiumPath 指向的文件不存在或不可执行：${configured}，改为自动查找系统里的 Chrome/Chromium。`;
  }
  const candidates = [...(FIXED[env.platform] ?? [])];
  for (const dir of env.pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of BIN_NAMES) candidates.push(join(dir, env.platform === 'win32' ? `${name}.exe` : name));
  }
  const found = candidates.find((c) => env.exists(c));
  if (found) return { path: found, source: 'system', warning };
  return { warning, hint: HINTS[env.platform] ?? '安装 Chrome 或 Chromium，并在 config.json 的 chromiumPath 里写可执行文件路径。' };
}
