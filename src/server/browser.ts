// 无头 Chromium 管理：启动 host 页面、等待扩展连接、空闲关闭与按需启动、退出清理。
// 看门狗（自动重启、通知用户、退避）在后续步骤实现，这里通过 onEvent 提供 crashed / heartbeatTimeout 等钩子。
// 真正的 puppeteer 调用在 puppeteer-launcher.ts，这里只依赖 Launcher 接口，便于测试。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isKnownNoise, isReadyConsoleLine } from '../extension/adapter';
import { HOST_PARAM, SKIP_CSRF_PATCH_PARAM } from '../extension/host-mode';
import { diagnoseBrowserError } from './browser-diagnose';
import { DEFAULT_PAGE_HEAP_LIMIT_MB } from './config';
import type { FetchLike } from './http';
import type { Logger } from './logger';

export interface PageResponseLike {
  status(): number;
}

export interface PageLike {
  authenticate(creds: { username: string; password: string }): Promise<void>;
  goto(url: string, opts: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<PageResponseLike | null>;
  url(): string;
  /** 页面 JS 堆已用字节数（CDP Runtime.getHeapUsage）。比页面里的 performance.memory 准，也不依赖 UI 扩展的版本。 */
  heapUsed(): Promise<number>;
  /** error：渲染进程崩溃；pageerror：页面未捕获异常；console：控制台；response：网络响应。 */
  on(event: 'error', fn: (e: Error) => void): void;
  on(event: 'pageerror', fn: (e: unknown) => void): void;
  on(event: 'console', fn: (text: string, type: string) => void): void;
  on(event: 'response', fn: (url: string, status: number) => void): void;
}

export interface LaunchedBrowser {
  pid?: number;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  kill(): void;
  onDisconnected(fn: () => void): void;
}

export type Launcher = (opts: { executablePath: string; args: string[]; userDataDir: string }) => Promise<LaunchedBrowser>;

/** 与 HostChannel 的接口约定（只用到这些）。 */
export interface HostLink {
  rotateNonce(): string;
  readonly connected: boolean;
  readonly hello: unknown;
  readonly lastSeenAt: number;
  onConnectionChange(fn: (connected: boolean) => void): () => void;
}

export type BrowserState = 'stopped' | 'starting' | 'running' | 'stopping';

export type BrowserEvent =
  | { type: 'started'; pid?: number }
  | { type: 'stopped'; reason: string }
  /** 浏览器进程意外退出或页面渲染进程崩溃。 */
  | { type: 'crashed'; detail: string }
  /** 运行中超过 heartbeatTimeoutMs 没有收到页面任何上行消息。每次失联只发一次。 */
  | { type: 'heartbeatTimeout'; silentMs: number };

export interface BrowserManagerOptions {
  log: Logger;
  host: HostLink;
  launcher: Launcher;
  /** 没有可用的 Chromium 时为 undefined，start 会给出安装提示。 */
  executablePath?: string;
  /** 找不到 Chromium 时的提示（chromium-path.ts 给出）。 */
  missingHint?: string;
  stBaseUrl: string;
  basicAuth?: { username: string; password: string };
  lowMemory: boolean;
  /** 低内存模式下 JS 老生代上限（MB），默认 256。面板里改了之后，下次启动 Chromium 时生效。 */
  pageHeapLimitMB?: number;
  /** 0 表示不空闲关闭。 */
  idleShutdownMs: number;
  fetch?: FetchLike;
  now?: () => number;
  /** 检查空闲和心跳的间隔，默认 15 秒。 */
  tickMs?: number;
  heartbeatTimeoutMs?: number;
  /** 等待 ST 服务端可访问，默认 120 秒。 */
  stReadyTimeoutMs?: number;
  /** 打开页面后等待扩展连接，默认 180 秒（全新安装时首启动弹窗要先被关掉）。 */
  hostReadyTimeoutMs?: number;
  /** 已在运行但页面未连接时，最多等多久再重启，默认 30 秒。 */
  reconnectGraceMs?: number;
  isRoot?: boolean;
  /** 运行平台，默认 process.platform；启动失败诊断用。 */
  platform?: NodeJS.Platform;
  /** 只用于测试：让扩展跳过 CSRF 补丁（环境变量 SILLY_TG_TEST_SKIP_CSRF_PATCH=1）。 */
  testSkipCsrfPatch?: boolean;
}

/** Chromium 启动参数。纯函数。 */
export function chromiumArgs(opts: { lowMemory: boolean; isRoot: boolean; heapLimitMB?: number }): string[] {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    // 关闭后台降频：无头页面一直在“后台”，否则定时器和渲染会被节流
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
  if (opts.lowMemory) {
    // spike 实测比默认低约 200 MB（macOS RSS）
    args.push(
      '--disable-gpu',
      '--disable-extensions',
      '--renderer-process-limit=1',
      '--disable-background-networking',
      '--mute-audio',
      `--js-flags=--max-old-space-size=${opts.heapLimitMB ?? DEFAULT_PAGE_HEAP_LIMIT_MB}`,
    );
  }
  // 以 root 运行（常见于容器）时 Chrome 拒绝启动沙箱
  if (opts.isRoot) args.push('--no-sandbox');
  return args;
}

/** host 标记放在 hash 里，原因见 extension/host-mode.ts（查询参数会让 ST 页面 DOM 出现两份）。 */
export function hostUrl(stBaseUrl: string, nonce: string, test: { skipCsrfPatch?: boolean } = {}): string {
  return `${stBaseUrl}/#${HOST_PARAM}=${nonce}${test.skipCsrfPatch ? `&${SKIP_CSRF_PATCH_PARAM}=1` : ''}`;
}

export class BrowserStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserStartError';
  }
}

/** 启动失败但认不出原因时附上的通用提示。 */
const GENERIC_LAUNCH_HINT = '如果是在没有桌面的服务器或容器里，请对照 docs/install-linux.md 排查；把上面的原始报错发给开发者也有帮助。';

const CANCELLED = '插件正在退出或重新加载，已取消启动无头浏览器';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class BrowserManager {
  private stateValue: BrowserState = 'stopped';
  private browser: LaunchedBrowser | null = null;
  private userDataDir: string | null = null;
  private launchedHeapLimitMB: number | undefined;
  private pageRef: PageLike | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private leases = 0;
  private lastActivity: number;
  private heartbeatAlerted = false;
  private readonly handlers = new Set<(e: BrowserEvent) => void>();
  /** 正在等页面连接的回调；dispose 时立即叫醒，不等连接超时。 */
  private readonly connectWaiters = new Set<() => void>();
  private readonly ticker: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;
  private disposed = false;
  /** 最近一次启动失败的原因，供 /status 显示。 */
  lastError?: string;
  startedAt?: number;

  constructor(private readonly opts: BrowserManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.lastActivity = this.now();
    this.ticker = setInterval(() => this.tick(), opts.tickMs ?? 15_000);
    this.ticker.unref();
  }

  get state(): BrowserState {
    return this.stateValue;
  }

  /** 当前这个 Chromium 的 JS 堆上限（MB）；没有上限（非低内存模式）或没在运行时为 undefined。 */
  get heapLimitMB(): number | undefined {
    return this.stateValue === 'running' ? this.launchedHeapLimitMB : undefined;
  }

  /** 当前页面 JS 堆已用字节数；浏览器没在运行、页面正在重载等取不到时返回 undefined。 */
  async sampleHeapUsed(): Promise<number | undefined> {
    const page = this.pageRef;
    if (this.stateValue !== 'running' || !page) return undefined;
    try {
      return await page.heapUsed();
    } catch {
      return undefined;
    }
  }

  get pid(): number | undefined {
    return this.browser?.pid;
  }

  onEvent(fn: (e: BrowserEvent) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  /** 记录一次活动（收到消息等），重置空闲计时。 */
  touch(): void {
    this.lastActivity = this.now();
  }

  /** 占用期间（生成进行中）不会被空闲关闭。返回释放函数，重复调用无副作用。 */
  acquire(): () => void {
    this.leases++;
    this.touch();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases--;
      this.touch();
    };
  }

  /**
   * 确保浏览器在运行且页面已连接。正在启动时等同一次启动；已关闭时启动；
   * 运行中但页面断开超过 reconnectGraceMs 时重启。
   */
  async ensureRunning(): Promise<void> {
    if (this.disposed) throw new BrowserStartError('插件正在退出');
    this.touch();
    if (this.stateValue === 'running') {
      if (this.opts.host.connected) return;
      if (await this.waitConnected(this.opts.reconnectGraceMs ?? 30_000)) return;
      if (this.disposed) throw new BrowserStartError(CANCELLED);
      this.opts.log.warn('host 页面断开且没有自动重连，重启无头浏览器');
      await this.stop('页面未连接，重启');
    }
    if (this.stopping) await this.stopping;
    // 上面的等待期间可能已经 dispose：不再新开一次启动
    if (this.disposed) throw new BrowserStartError(CANCELLED);
    if (!this.starting) {
      this.starting = this.start().finally(() => (this.starting = null));
    }
    return this.starting;
  }

  /** 关闭浏览器并清理临时目录。可重复调用。 */
  stop(reason = 'manual'): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.browser && this.stateValue === 'stopped') return Promise.resolve();
    this.stopping = this.doStop(reason).finally(() => (this.stopping = null));
    return this.stopping;
  }

  /**
   * 插件退出或重新加载：停止计时器并关闭浏览器。
   * 启动进行中时不等它走完（等扩展连接最长 180 秒）：叫醒等待、关掉已经拉起的进程，让启动立刻失败收尾。
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.ticker);
    if (this.starting) {
      for (const wake of [...this.connectWaiters]) wake();
      // 打开页面（goto）可能还在进行：先把浏览器关掉，让启动立刻失败收尾
      const browser = this.browser;
      this.browser = null;
      const closing = browser ? this.closeBrowser(browser) : undefined;
      await this.starting.catch(() => {});
      await closing;
    }
    await this.stop('ST 退出或插件重新加载');
  }

  private emit(e: BrowserEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.opts.log.error(`浏览器事件处理器出错：${(err as Error).message}`);
      }
    }
  }

  private tick(): void {
    if (this.stateValue !== 'running') return;
    const now = this.now();
    const idleMs = this.opts.idleShutdownMs;
    if (idleMs > 0 && this.leases === 0 && now - this.lastActivity >= idleMs) {
      this.opts.log.info(`空闲 ${+(idleMs / 60000).toFixed(2)} 分钟，关闭无头浏览器（收到消息时自动启动）`);
      void this.stop('idle');
      return;
    }
    const silent = now - this.opts.host.lastSeenAt;
    const limit = this.opts.heartbeatTimeoutMs ?? 60_000;
    if (this.opts.host.lastSeenAt > 0 && silent > limit) {
      if (!this.heartbeatAlerted) {
        this.heartbeatAlerted = true;
        this.opts.log.warn(`host 页面已 ${Math.round(silent / 1000)} 秒没有心跳`);
        this.emit({ type: 'heartbeatTimeout', silentMs: silent });
      }
    } else {
      this.heartbeatAlerted = false;
    }
  }

  private waitConnected(timeoutMs: number): Promise<boolean> {
    const host = this.opts.host;
    if (host.connected && host.hello) return Promise.resolve(true);
    if (this.disposed) return Promise.resolve(false);
    const waiters = this.connectWaiters;
    return new Promise((resolve) => {
      const off = host.onConnectionChange((c) => {
        if (c && host.hello) done(true);
      });
      const timer = setTimeout(() => done(false), timeoutMs);
      const wake = (): void => done(false);
      waiters.add(wake);
      function done(v: boolean): void {
        clearTimeout(timer);
        off();
        waiters.delete(wake);
        resolve(v);
      }
    });
  }

  private async waitForSt(): Promise<void> {
    const deadline = this.now() + (this.opts.stReadyTimeoutMs ?? 120_000);
    const headers: Record<string, string> = {};
    if (this.opts.basicAuth) {
      headers.authorization = `Basic ${Buffer.from(`${this.opts.basicAuth.username}:${this.opts.basicAuth.password}`).toString('base64')}`;
    }
    let last = '';
    while (this.now() < deadline && !this.disposed) {
      try {
        const res = await this.fetchImpl(`${this.opts.stBaseUrl}/`, { headers, signal: AbortSignal.timeout(5000) });
        await res.body?.cancel();
        if (res.status === 401) {
          throw new BrowserStartError(
            this.opts.basicAuth
              ? 'ST 拒绝了 basicAuth 用户名或密码（401）。检查 config.json 的 basicAuth 是否与 ST config.yaml 的 basicAuthUser 一致。'
              : 'ST 开启了 basic auth（401）。在 config.json 里填写 basicAuth: {"username": "...", "password": "..."}。',
          );
        }
        if (res.status === 403) {
          throw new BrowserStartError(`ST 拒绝了来自本机的访问（403）。确认 stBaseUrl（${this.opts.stBaseUrl}）指向本机地址，且本机在 ST 的白名单中。`);
        }
        if (res.status < 500) return;
        last = `HTTP ${res.status}`;
      } catch (e) {
        if (e instanceof BrowserStartError) throw e;
        last = (e as Error).message;
      }
      await sleep(1000);
    }
    throw new BrowserStartError(`等待 ST（${this.opts.stBaseUrl}）可访问超时：${last}。检查 config.json 的 stBaseUrl。`);
  }

  private async start(): Promise<void> {
    const { log } = this.opts;
    if (!this.opts.executablePath) {
      const msg = `没有找到 Chrome/Chromium，无法启动无头浏览器。${this.opts.missingHint ?? ''}`;
      this.lastError = msg;
      throw new BrowserStartError(msg);
    }
    this.stateValue = 'starting';
    // 只有 launcher 本身抛出的错才做浏览器启动诊断（等 ST、打开页面等阶段的错有各自的提示）
    let launching = false;
    // 每个 await 之后都要看一眼是否已 dispose：重新加载时旧运行时停止超时后，新运行时会共用同一个
    // host 通道，旧的启动不能再换 nonce（会踢掉新页面）或继续开页面。
    const cancelled = (): void => {
      if (this.disposed) throw new BrowserStartError(CANCELLED);
    };
    try {
      await this.waitForSt();
      cancelled();
      const nonce = this.opts.host.rotateNonce();
      this.userDataDir = await mkdtemp(join(tmpdir(), 'silly-tg-chrome-'));
      cancelled();
      const isRoot = this.opts.isRoot ?? process.getuid?.() === 0;
      launching = true;
      // lowMemory 面板里可以热改，但对已启动的 Chromium 不起作用：记下这一次启动用的值，堆回收按它判断
      const lowMemory = this.opts.lowMemory;
      const heapLimitMB = this.opts.pageHeapLimitMB ?? DEFAULT_PAGE_HEAP_LIMIT_MB;
      const browser = await this.opts.launcher({
        executablePath: this.opts.executablePath,
        args: chromiumArgs({ lowMemory, isRoot, heapLimitMB }),
        userDataDir: this.userDataDir,
      });
      launching = false;
      // 先记下来再检查：取消时由下面的收尾（doStop）关掉这个进程
      this.browser = browser;
      this.launchedHeapLimitMB = lowMemory ? heapLimitMB : undefined;
      cancelled();
      browser.onDisconnected(() => this.handleDisconnected(browser));
      log.info(`无头浏览器已启动（PID ${browser.pid ?? '未知'}${lowMemory ? `，低内存参数，JS 堆上限 ${heapLimitMB} MB` : ''}），打开 ST 页面…`);

      const page = await browser.newPage();
      cancelled();
      this.pageRef = page;
      this.watchPage(page, browser);
      if (this.opts.basicAuth) await page.authenticate(this.opts.basicAuth);
      const connected = this.waitConnected(this.opts.hostReadyTimeoutMs ?? 180_000);
      const res = await page.goto(hostUrl(this.opts.stBaseUrl, nonce, { skipCsrfPatch: this.opts.testSkipCsrfPatch }), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (res?.status() === 401) throw new BrowserStartError('打开 ST 页面返回 401，检查 config.json 的 basicAuth。');
      if (/\/login(\b|\?|$)/.test(new URL(page.url()).pathname)) {
        throw new BrowserStartError(
          'ST 开启了多用户账户（enableUserAccounts），无头页面被重定向到登录页。首版不支持多用户模式，请在 ST 的 config.yaml 里关闭 enableUserAccounts。',
        );
      }
      if (!(await connected)) {
        cancelled();
        throw new BrowserStartError(
          'ST 页面打开了，但 silly-tg 扩展没有连接。检查 ST 的“扩展”管理里 Silly TG 是否存在并处于启用状态（可能是面板安装的副本，也可能是自动部署到 public/scripts/extensions/third-party/silly-tg 的副本，被停用都会导致连不上）。',
        );
      }
      this.stateValue = 'running';
      this.startedAt = this.now();
      this.lastError = undefined;
      this.heartbeatAlerted = false;
      this.touch();
      log.info('无头 ST 页面已连接');
      this.emit({ type: 'started', pid: browser.pid });
    } catch (e) {
      if (this.disposed) {
        // 退出或重新加载时主动取消，不是故障
        this.lastError = undefined;
        log.info('无头浏览器启动已取消（插件退出或重新加载）');
        await this.doStop('启动已取消', false);
        throw new BrowserStartError(CANCELLED);
      }
      let message = (e as Error).message;
      if (launching && !(e instanceof BrowserStartError)) {
        const d = diagnoseBrowserError(message, {
          platform: this.opts.platform ?? process.platform,
          isRoot: this.opts.isRoot ?? process.getuid?.() === 0,
          chromiumPath: this.opts.executablePath,
        });
        // 保留原始报错，把修法追加在后面
        message = `${message}\n💡 修法：${d ? d.hint : GENERIC_LAUNCH_HINT}`;
      }
      this.lastError = message;
      log.error(`无头浏览器启动失败：${this.lastError}`);
      await this.doStop('启动失败', false);
      throw e instanceof BrowserStartError ? e : new BrowserStartError(this.lastError);
    }
  }

  private watchPage(page: PageLike, browser: LaunchedBrowser): void {
    const { log } = this.opts;
    page.on('error', (e) => {
      if (this.browser !== browser) return;
      log.error(`无头页面崩溃：${e.message}`);
      this.emit({ type: 'crashed', detail: `页面崩溃：${e.message}` });
      void this.stop('页面崩溃');
    });
    page.on('pageerror', (e) => {
      const message = e instanceof Error ? e.message : String(e);
      if (!isKnownNoise({ kind: 'error', message })) log.debug(`页面错误：${message.slice(0, 300)}`);
    });
    page.on('response', (url, status) => {
      if (status >= 400 && !isKnownNoise({ kind: 'http', url, status })) log.debug(`页面请求 ${status}：${url.slice(0, 200)}`);
    });
    page.on('console', (text, type) => {
      if (isReadyConsoleLine(text)) log.debug('ST 前端初始化完成');
      else if (type === 'error' && !isKnownNoise({ kind: 'error', message: text })) log.debug(`页面控制台错误：${text.slice(0, 300)}`);
    });
  }

  private handleDisconnected(browser: LaunchedBrowser): void {
    // dispose 期间是我们自己关的，由 start 的收尾或 stop 负责清理
    if (this.browser !== browser || this.stopping || this.disposed) return;
    this.opts.log.error('无头浏览器意外退出');
    this.browser = null;
    this.stateValue = 'stopped';
    this.startedAt = undefined;
    // 连接断开（CDP 通道断了）不等于 Chromium 进程退出，进程可能还活着。
    // 先 SIGKILL 兜底再清理目录（进程还在写 profile 时删目录会报错），否则每断一次留下一个孤儿占内存。
    try {
      browser.kill();
      this.opts.log.info(`连接断开，已结束残留的浏览器进程（PID ${browser.pid ?? '未知'}）`);
    } catch {
      // 进程已经退出
    }
    void this.cleanupDir();
    this.emit({ type: 'crashed', detail: '浏览器进程意外退出' });
  }

  private async doStop(reason: string, announce = true): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      this.stateValue = 'stopping';
      await this.closeBrowser(browser);
    }
    await this.cleanupDir();
    this.stateValue = 'stopped';
    this.startedAt = undefined;
    if (browser && announce) {
      this.opts.log.info(`无头浏览器已关闭（${reason}）`);
      this.emit({ type: 'stopped', reason });
    }
  }

  /** 正常关闭，5 秒内没关掉就强制结束进程。 */
  private async closeBrowser(browser: LaunchedBrowser): Promise<void> {
    const closed = await Promise.race([
      browser.close().then(
        () => true,
        () => false,
      ),
      sleep(5000).then(() => false),
    ]);
    if (!closed) {
      this.opts.log.warn('关闭浏览器超时，强制结束进程');
      try {
        browser.kill();
      } catch {
        // 进程可能已经退出
      }
    }
  }

  private async cleanupDir(): Promise<void> {
    const dir = this.userDataDir;
    this.userDataDir = null;
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
