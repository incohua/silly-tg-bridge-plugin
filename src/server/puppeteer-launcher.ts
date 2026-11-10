// 基于 puppeteer-core 的 Launcher 实现。只做类型适配，逻辑都在 browser.ts。
import puppeteer, { type CDPSession } from 'puppeteer-core';
import type { Launcher, LaunchedBrowser, PageLike } from './browser';

export const puppeteerLauncher: Launcher = async ({ executablePath, args, userDataDir }) => {
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir,
    args,
    defaultViewport: { width: 420, height: 900 },
    // 不让 puppeteer 接管信号：它的 SIGINT 处理会直接 process.exit(130)，抢在 ST 的优雅退出之前。
    // 关闭由插件 exit 钩子负责；puppeteer 仍会在进程 exit 事件时同步杀掉 Chromium，作为兜底。
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const proc = browser.process();
  const wrapped: LaunchedBrowser = {
    pid: proc?.pid,
    async newPage(): Promise<PageLike> {
      const page = await browser.newPage();
      let cdp: CDPSession | undefined;
      const adapter: PageLike = {
        heapUsed: async () => {
          try {
            cdp ??= await page.createCDPSession();
            const r = await cdp.send('Runtime.getHeapUsage');
            return r.usedSize;
          } catch (e) {
            // 页面重载或崩溃后会话可能失效：先释放旧会话（detach 自己的错误忽略），下次重新建
            const stale = cdp;
            cdp = undefined;
            await stale?.detach().catch(() => {});
            throw e;
          }
        },
        authenticate: (c) => page.authenticate(c),
        goto: async (url, o) => {
          const r = await page.goto(url, o);
          return r ? { status: () => r.status() } : null;
        },
        url: () => page.url(),
        on: ((event: string, fn: (...a: unknown[]) => void) => {
          if (event === 'error') page.on('error', (e) => fn(e));
          else if (event === 'pageerror') page.on('pageerror', (e) => fn(e));
          else if (event === 'console') page.on('console', (m) => fn(m.text(), m.type()));
          else if (event === 'response') page.on('response', (r) => fn(r.url(), r.status()));
        }) as PageLike['on'],
      };
      return adapter;
    },
    close: () => browser.close(),
    kill: () => void proc?.kill('SIGKILL'),
    onDisconnected: (fn) => void browser.on('disconnected', fn),
  };
  return wrapped;
};
