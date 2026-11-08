// 无头 Chromium 管理：启动 host 页面、等待扩展连接、空闲关闭与按需启动、退出清理。
// 看门狗（自动重启、通知用户、退避）在后续步骤实现，这里通过 onEvent 提供 crashed / heartbeatTimeout 等钩子。
// 真正的 puppeteer 调用在 puppeteer-launcher.ts，这里只依赖 Launcher 接口，便于测试。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isKnownNoise, isReadyConsoleLine } from '../extension/adapter';
import { HOST_PARAM, SKIP_CSRF_PATCH_PARAM } from '../extension/host-mode';
import type { FetchLike } from './http';
import type { Logger } from './logger';

export interface PageResponseLike {
  status(): number;
}

export interface PageLike {
  authenticate(creds: { username: string; password: string }): Promise<void>;
  goto(url: string, opts: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<PageResponseLike | null>;
  url(): string;
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
  /** 只用于测试：让扩展跳过 CSRF 补丁（环境变量 SILLY_TG_TEST_SKIP_CSRF_PATCH=1）。 */
  testSkipCsrfPatch?: boolean;
}

/** Chromium 启动参数。纯函数。 */
export function chromiumArgs(opts: { lowMemory: boolean; isRoot: boolean }): string[] {
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
      '--js-flags=--max-old-space-size=256',
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class BrowserManager {
  private stateValue: BrowserState = 'stopped';
  private browser: LaunchedBrowser | null = null;
  private userDataDir: string | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private leases = 0;
  private lastActivity: number;
  private heartbeatAlerted = false;
  private readonly handlers = new Set<(e: BrowserEvent) => void>();
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
      this.opts.log.warn('host 页面断开且没有自动重连，重启无头浏览器');
      await this.stop('页面未连接，重启');
    }
    if (this.stopping) await this.stopping;
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

  /** 插件退出：停止计时器并关闭浏览器。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.ticker);
    if (this.starting) await this.starting.catch(() => {});
    await this.stop('ST 退出');
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
    return new Promise((resolve) => {
      const off = host.onConnectionChange((c) => {
        if (c && host.hello) done(true);
      });
      const timer = setTimeout(() => done(false), timeoutMs);
      function done(v: boolean): void {
        clearTimeout(timer);
        off();
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
    try {
      await this.waitForSt();
      const nonce = this.opts.host.rotateNonce();
      this.userDataDir = await mkdtemp(join(tmpdir(), 'silly-tg-chrome-'));
      const isRoot = this.opts.isRoot ?? process.getuid?.() === 0;
      const browser = await this.opts.launcher({
        executablePath: this.opts.executablePath,
        args: chromiumArgs({ lowMemory: this.opts.lowMemory, isRoot }),
        userDataDir: this.userDataDir,
      });
      this.browser = browser;
      browser.onDisconnected(() => this.handleDisconnected(browser));
      log.info(`无头浏览器已启动（PID ${browser.pid ?? '未知'}${this.opts.lowMemory ? '，低内存参数' : ''}），打开 ST 页面…`);

      const page = await browser.newPage();
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
        throw new BrowserStartError(
          'ST 页面打开了，但 silly-tg 扩展没有连接。检查扩展是否已部署到 public/scripts/extensions/third-party/silly-tg 并在 ST 里处于启用状态。',
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
      this.lastError = (e as Error).message;
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
    if (this.browser !== browser || this.stopping) return;
    this.opts.log.error('无头浏览器意外退出');
    this.browser = null;
    this.stateValue = 'stopped';
    this.startedAt = undefined;
    void this.cleanupDir();
    this.emit({ type: 'crashed', detail: '浏览器进程意外退出' });
  }

  private async doStop(reason: string, announce = true): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      this.stateValue = 'stopping';
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
    await this.cleanupDir();
    this.stateValue = 'stopped';
    this.startedAt = undefined;
    if (browser && announce) {
      this.opts.log.info(`无头浏览器已关闭（${reason}）`);
      this.emit({ type: 'stopped', reason });
    }
  }

  private async cleanupDir(): Promise<void> {
    const dir = this.userDataDir;
    this.userDataDir = null;
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
