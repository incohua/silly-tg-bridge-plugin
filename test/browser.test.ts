import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BrowserManager, chromiumArgs, hostUrl, type BrowserEvent, type HostLink, type LaunchedBrowser, type Launcher, type PageLike } from '../src/server/browser';
import { captureLogger } from './helpers';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 假的 host 通道：goto 之后“扩展”自动连上。 */
class FakeHost implements HostLink {
  connected = false;
  hello: unknown = null;
  lastSeenAt = 0;
  nonces: string[] = [];
  private handlers = new Set<(c: boolean) => void>();
  rotateNonce(): string {
    this.setConnected(false);
    this.hello = null;
    this.lastSeenAt = 0;
    const n = `nonce${this.nonces.length}`;
    this.nonces.push(n);
    return n;
  }
  onConnectionChange(fn: (c: boolean) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  setConnected(c: boolean): void {
    if (c === this.connected) return;
    this.connected = c;
    if (c) {
      this.hello = { stVersion: 'st 1.19.0' };
      this.lastSeenAt = Date.now();
    }
    for (const h of [...this.handlers]) h(c);
  }
}

interface FakeBrowser extends LaunchedBrowser {
  /** 假页面当前的 JS 堆已用字节数；heapThrows 为真时 heapUsed 抛错（页面重载中）。 */
  heapBytes: number;
  heapThrows: boolean;
  closed: boolean;
  killed: boolean;
  killCount: number;
  /** kill() 被调用那一刻，临时 profile 目录是否还在 */
  dirExistedAtKill?: boolean;
  disconnect(): void;
  crashPage(): void;
  gotoUrl?: string;
}

function fakeLauncher(host: FakeHost, opts: { connect?: boolean; redirectTo?: string; killThrows?: boolean } = {}) {
  const launched: FakeBrowser[] = [];
  const argsSeen: string[][] = [];
  const launcher: Launcher = async ({ args, userDataDir }) => {
    argsSeen.push(args);
    let onDisc: (() => void) | null = null;
    let onPageError: ((e: Error) => void) | null = null;
    const b: FakeBrowser = {
      pid: 1000 + launched.length,
      closed: false,
      killed: false,
      killCount: 0,
      heapBytes: 123 * 1024 * 1024,
      heapThrows: false,
      async newPage(): Promise<PageLike> {
        let url = '';
        return {
          authenticate: async () => {},
          goto: async (u) => {
            url = opts.redirectTo ?? u;
            b.gotoUrl = u;
            if (opts.connect !== false) setTimeout(() => host.setConnected(true), 5);
            return { status: () => 200 };
          },
          url: () => url,
          heapUsed: async () => {
            if (b.heapThrows) throw new Error('Execution context was destroyed');
            return b.heapBytes;
          },
          on: ((ev: string, fn: (e: Error) => void) => {
            if (ev === 'error') onPageError = fn;
          }) as PageLike['on'],
        };
      },
      close: async () => {
        b.closed = true;
        host.setConnected(false);
      },
      kill: () => {
        b.killed = true;
        b.killCount++;
        b.dirExistedAtKill = existsSync(userDataDir);
        if (opts.killThrows) throw new Error('kill ESRCH');
      },
      onDisconnected: (fn) => void (onDisc = fn),
      disconnect: () => {
        host.setConnected(false);
        onDisc?.();
      },
      crashPage: () => onPageError?.(new Error('Page crashed!')),
    };
    launched.push(b);
    return b;
  };
  return { launcher, launched, argsSeen };
}

const okFetch = async () => new Response('ok', { status: 200 });

function make(host: FakeHost, launcher: Launcher, extra: Partial<ConstructorParameters<typeof BrowserManager>[0]> = {}) {
  const log = captureLogger();
  const m = new BrowserManager({
    log,
    host,
    launcher,
    executablePath: '/fake/chrome',
    stBaseUrl: 'http://127.0.0.1:8000',
    lowMemory: true,
    idleShutdownMs: 0,
    fetch: okFetch,
    tickMs: 10,
    hostReadyTimeoutMs: 500,
    reconnectGraceMs: 50,
    isRoot: false,
    ...extra,
  });
  const events: BrowserEvent[] = [];
  m.onEvent((e) => events.push(e));
  return { m, log, events };
}

describe('chromiumArgs / hostUrl', () => {
  it('总是关闭后台降频；低内存参数可选；root 时加 --no-sandbox', () => {
    const base = chromiumArgs({ lowMemory: false, isRoot: false });
    expect(base).toContain('--disable-background-timer-throttling');
    expect(base).toContain('--disable-renderer-backgrounding');
    expect(base).not.toContain('--renderer-process-limit=1');
    const low = chromiumArgs({ lowMemory: true, isRoot: true });
    expect(low).toContain('--renderer-process-limit=1');
    expect(low).toContain('--no-sandbox');
    // 上限默认 256，可通过 heapLimitMB 调整；非低内存模式没有这个参数
    expect(low).toContain('--js-flags=--max-old-space-size=256');
    expect(chromiumArgs({ lowMemory: true, isRoot: false, heapLimitMB: 512 })).toContain('--js-flags=--max-old-space-size=512');
    expect(base.some((a) => a.startsWith('--js-flags'))).toBe(false);
  });
  it('host URL 带 nonce 参数', () => {
    expect(hostUrl('http://127.0.0.1:8000', 'abc')).toBe('http://127.0.0.1:8000/#silly_tg_host=abc');
    expect(hostUrl('http://127.0.0.1:8000', 'abc', { skipCsrfPatch: true })).toBe('http://127.0.0.1:8000/#silly_tg_host=abc&silly_tg_test_skip_csrf_patch=1');
  });
});

describe('BrowserManager', () => {
  it('ensureRunning：启动、换 nonce、打开 host 页面、等扩展连接', async () => {
    const host = new FakeHost();
    const { launcher, launched, argsSeen } = fakeLauncher(host);
    const { m, events } = make(host, launcher);
    await m.ensureRunning();
    expect(m.state).toBe('running');
    expect(launched).toHaveLength(1);
    expect(launched[0].gotoUrl).toBe(`http://127.0.0.1:8000/#silly_tg_host=${host.nonces[0]}`);
    expect(argsSeen[0]).toContain('--renderer-process-limit=1');
    expect(events).toEqual([{ type: 'started', pid: 1000 }]);
    await m.dispose();
    expect(launched[0].closed).toBe(true);
    expect(m.state).toBe('stopped');
  });

  it('并发 ensureRunning 只启动一次', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m } = make(host, launcher);
    await Promise.all([m.ensureRunning(), m.ensureRunning(), m.ensureRunning()]);
    expect(launched).toHaveLength(1);
    await m.dispose();
  });

  it('没有 Chromium：给出安装提示，不启动', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m } = make(host, launcher, { executablePath: undefined, missingHint: '安装 Chromium' });
    await expect(m.ensureRunning()).rejects.toThrow(/安装 Chromium/);
    expect(launched).toHaveLength(0);
    expect(m.lastError).toMatch(/Chrome\/Chromium/);
    await m.dispose();
  });

  it('launcher 抛出沙箱错误：原始报错保留，lastError、日志和异常都带修法', async () => {
    const host = new FakeHost();
    const raw = 'Failed to launch the browser process!\n[1:1:0101/000000:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!';
    const { m, log } = make(host, async () => {
      throw new Error(raw);
    });
    await expect(m.ensureRunning()).rejects.toThrow(/No usable sandbox[\s\S]*PUPPETEER_DANGEROUS_NO_SANDBOX=true/);
    expect(m.lastError).toContain(raw);
    expect(m.lastError).toMatch(/修法：.*PUPPETEER_DANGEROUS_NO_SANDBOX=true/);
    expect(log.lines.join('\n')).toMatch(/PUPPETEER_DANGEROUS_NO_SANDBOX/);
    await m.dispose();
  });

  it('launcher 抛出认不出的错误：保留原文并附通用提示', async () => {
    const host = new FakeHost();
    const { m } = make(host, async () => {
      throw new Error('something weird');
    });
    await expect(m.ensureRunning()).rejects.toThrow(/something weird[\s\S]*docs\/install-linux\.md/);
    await m.dispose();
  });

  it('启动后阶段的错误（扩展没连接）不做浏览器诊断', async () => {
    const host = new FakeHost();
    const { launcher } = fakeLauncher(host, { connect: false });
    const { m } = make(host, launcher, { hostReadyTimeoutMs: 50 });
    await expect(m.ensureRunning()).rejects.toThrow(/扩展没有连接/);
    expect(m.lastError).not.toMatch(/修法/);
    await m.dispose();
  });

  it('扩展一直不连接：超时报错并关闭浏览器', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host, { connect: false });
    const { m } = make(host, launcher, { hostReadyTimeoutMs: 50 });
    await expect(m.ensureRunning()).rejects.toThrow(/扩展没有连接/);
    expect(launched[0].closed).toBe(true);
    expect(m.state).toBe('stopped');
    await m.dispose();
  });

  it('多用户模式（跳转到登录页）：明确提示', async () => {
    const host = new FakeHost();
    const { launcher } = fakeLauncher(host, { connect: false, redirectTo: 'http://127.0.0.1:8000/login' });
    const { m } = make(host, launcher);
    await expect(m.ensureRunning()).rejects.toThrow(/enableUserAccounts/);
    await m.dispose();
  });

  it('ST 要求 basic auth 但没配置：明确提示', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m } = make(host, launcher, { fetch: async () => new Response('', { status: 401 }) });
    await expect(m.ensureRunning()).rejects.toThrow(/basicAuth/);
    expect(launched).toHaveLength(0);
    await m.dispose();
  });

  it('空闲关闭：占用期间不关；释放后超时关闭；再次 ensureRunning 自动启动', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m, events } = make(host, launcher, { idleShutdownMs: 60 });
    await m.ensureRunning();
    const release = m.acquire();
    await wait(120);
    expect(m.state).toBe('running');
    release();
    await vi.waitFor(() => expect(m.state).toBe('stopped'), { timeout: 4000, interval: 5 });
    expect(launched[0].closed).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['started', 'stopped']);
    expect(events[1]).toEqual({ type: 'stopped', reason: 'idle' });
    await m.ensureRunning();
    expect(m.state).toBe('running');
    expect(launched).toHaveLength(2);
    expect(host.nonces).toHaveLength(2);
    await m.dispose();
  });

  it('touch 推迟空闲关闭', async () => {
    const host = new FakeHost();
    const { launcher } = fakeLauncher(host);
    const { m } = make(host, launcher, { idleShutdownMs: 80 });
    await m.ensureRunning();
    for (let i = 0; i < 5; i++) {
      await wait(30);
      m.touch();
    }
    expect(m.state).toBe('running');
    await m.dispose();
  });

  it('关闭期间到达的消息：等关闭完成后重新启动', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m } = make(host, launcher);
    await m.ensureRunning();
    const stopping = m.stop('idle');
    const again = m.ensureRunning();
    await stopping;
    await again;
    expect(m.state).toBe('running');
    expect(launched).toHaveLength(2);
    await m.dispose();
  });

  it('浏览器意外退出：发 crashed 事件，下次 ensureRunning 重启', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m, events } = make(host, launcher);
    await m.ensureRunning();
    launched[0].disconnect();
    expect(m.state).toBe('stopped');
    expect(events.at(-1)).toEqual({ type: 'crashed', detail: '浏览器进程意外退出' });
    await m.ensureRunning();
    expect(launched).toHaveLength(2);
    await m.dispose();
  });

  it('浏览器意外退出：连接断开不等于进程退出，要结束残留进程（恰好一次，且在清理目录之前）', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m, log } = make(host, launcher);
    await m.ensureRunning();
    launched[0].disconnect();
    expect(launched[0].killCount).toBe(1);
    expect(launched[0].dirExistedAtKill).toBe(true);
    expect(log.lines.some((l) => l.includes('已结束残留的浏览器进程') && l.includes('1000'))).toBe(true);
    await m.dispose();
  });

  it('浏览器意外退出：进程已经退出（kill 抛错）时不抛出，仍发 crashed 事件', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host, { killThrows: true });
    const { m, events } = make(host, launcher);
    await m.ensureRunning();
    expect(() => launched[0].disconnect()).not.toThrow();
    expect(events.at(-1)).toEqual({ type: 'crashed', detail: '浏览器进程意外退出' });
    expect(m.state).toBe('stopped');
    await m.dispose();
  });

  it('stop() / dispose() 期间触发的断开不重复 kill', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m } = make(host, launcher);
    await m.ensureRunning();
    const stopping = m.stop('test');
    launched[0].disconnect();
    await stopping;
    expect(launched[0].killCount).toBe(0);
    await m.ensureRunning();
    const disposing = m.dispose();
    launched[1].disconnect();
    await disposing;
    expect(launched[1].killCount).toBe(0);
  });

  it('旧实例的 disconnected 在新实例启动后才到达：不会杀到新实例', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m } = make(host, launcher);
    await m.ensureRunning();
    launched[0].disconnect();
    expect(launched[0].killCount).toBe(1);
    await m.ensureRunning();
    launched[0].disconnect();
    expect(launched[0].killCount).toBe(1);
    expect(launched[1].killCount).toBe(0);
    expect(m.state).toBe('running');
    await m.dispose();
  });

  it('heapLimitMB：按这次启动时的 lowMemory / pageHeapLimitMB 判断，之后热改配置不影响正在运行的浏览器', async () => {
    const host = new FakeHost();
    const { launcher, argsSeen } = fakeLauncher(host);
    let low = true;
    let limit = 512;
    const m = new BrowserManager({
      log: captureLogger(),
      host,
      launcher,
      executablePath: '/fake/chrome',
      stBaseUrl: 'http://127.0.0.1:8000',
      get lowMemory() {
        return low;
      },
      get pageHeapLimitMB() {
        return limit;
      },
      idleShutdownMs: 0,
      fetch: okFetch,
      tickMs: 10,
      hostReadyTimeoutMs: 500,
      reconnectGraceMs: 50,
      isRoot: false,
    });
    expect(m.heapLimitMB).toBeUndefined();
    await m.ensureRunning();
    expect(m.heapLimitMB).toBe(512);
    expect(argsSeen[0]).toContain('--js-flags=--max-old-space-size=512');
    low = false;
    limit = 1024;
    expect(m.heapLimitMB).toBe(512); // 正在运行的浏览器不受影响
    await m.stop();
    expect(m.heapLimitMB).toBeUndefined();
    await m.ensureRunning(); // 下次启动才用新值：lowMemory 已关，没有上限
    expect(m.heapLimitMB).toBeUndefined();
    expect(argsSeen[1].some((a) => a.startsWith('--js-flags'))).toBe(false);
    low = true;
    await m.stop();
    await m.ensureRunning();
    expect(m.heapLimitMB).toBe(1024);
    await m.dispose();
  });

  it('pageHeapLimitMB 缺省为 256', async () => {
    const host = new FakeHost();
    const { launcher } = fakeLauncher(host);
    const { m } = make(host, launcher);
    await m.ensureRunning();
    expect(m.heapLimitMB).toBe(256);
    await m.dispose();
  });

  it('sampleHeapUsed：运行中读页面堆用量；没在运行或页面暂时取不到时返回 undefined，不抛错', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m } = make(host, launcher);
    expect(await m.sampleHeapUsed()).toBeUndefined();
    await m.ensureRunning();
    expect(await m.sampleHeapUsed()).toBe(123 * 1024 * 1024);
    launched[0].heapThrows = true;
    expect(await m.sampleHeapUsed()).toBeUndefined();
    launched[0].heapThrows = false;
    await m.stop();
    expect(await m.sampleHeapUsed()).toBeUndefined();
    await m.dispose();
  });

  it('页面崩溃：发 crashed 事件并关闭浏览器', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m, events } = make(host, launcher);
    await m.ensureRunning();
    launched[0].crashPage();
    // 崩溃处理是同步的：事件已发出、关闭已开始。之后等这次关闭完成（stop() 返回进行中的那次），不按固定时长睡
    expect(events.some((e) => e.type === 'crashed')).toBe(true);
    expect(m.state).toBe('stopping');
    await m.stop();
    expect(launched[0].closed).toBe(true);
    expect(m.state).toBe('stopped');
    await m.dispose();
  });

  it('运行中但页面断开且不重连：ensureRunning 重启', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m } = make(host, launcher);
    await m.ensureRunning();
    host.setConnected(false);
    await m.ensureRunning();
    expect(launched).toHaveLength(2);
    expect(launched[0].closed).toBe(true);
    await m.dispose();
  });

  it('心跳超时：只发一次 heartbeatTimeout，恢复后可再次触发', async () => {
    const host = new FakeHost();
    const { launcher } = fakeLauncher(host);
    const { m, events } = make(host, launcher, { heartbeatTimeoutMs: 30 });
    await m.ensureRunning();
    host.lastSeenAt = Date.now() - 1000;
    await wait(60);
    expect(events.filter((e) => e.type === 'heartbeatTimeout')).toHaveLength(1);
    host.lastSeenAt = Date.now() + 10_000;
    await wait(30);
    host.lastSeenAt = Date.now() - 1000;
    await wait(30);
    expect(events.filter((e) => e.type === 'heartbeatTimeout')).toHaveLength(2);
    await m.dispose();
  });

  it('关闭超时：强制结束进程', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m } = make(host, launcher);
    await m.ensureRunning();
    launched[0].close = () => new Promise(() => {});
    const t = Date.now();
    await m.dispose();
    expect(launched[0].killed).toBe(true);
    expect(Date.now() - t).toBeGreaterThanOrEqual(4900);
  }, 10_000);

  it('dispose 之后不再启动', async () => {
    const host = new FakeHost();
    const { launcher } = fakeLauncher(host);
    const { m } = make(host, launcher);
    await m.dispose();
    await expect(m.ensureRunning()).rejects.toThrow(/退出/);
  });

  it('启动中（等扩展连接）dispose：不等连接超时，立即关闭浏览器；不当成故障', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host, { connect: false });
    const { m, log, events } = make(host, launcher, { hostReadyTimeoutMs: 60_000 });
    const starting = m.ensureRunning().catch((e: Error) => e);
    while (launched.length === 0) await wait(2);
    await wait(10);
    const t = Date.now();
    await m.dispose();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(launched[0].closed).toBe(true);
    expect(m.state).toBe('stopped');
    expect(String(await starting)).toMatch(/退出|重新加载/);
    expect(events.some((e) => e.type === 'crashed')).toBe(false);
    expect(log.lines.some((l) => l.startsWith('error'))).toBe(false);
  });

  it('等 ST 可访问时 dispose：不再换 nonce（通道跨重新加载共用，换了会踢掉新页面），也不启动浏览器', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    let release!: (r: Response) => void;
    let asked = 0;
    const gated = () => (asked++, new Promise<Response>((r) => (release = r)));
    const { m } = make(host, launcher, { fetch: gated });
    const starting = m.ensureRunning().catch((e: Error) => e);
    await vi.waitFor(() => expect(asked).toBe(1), { timeout: 4000, interval: 2 });
    const disposing = m.dispose();
    release(new Response('ok', { status: 200 }));
    await disposing;
    expect(String(await starting)).toMatch(/退出|重新加载/);
    expect(host.nonces).toEqual([]);
    expect(launched).toHaveLength(0);
    expect(m.state).toBe('stopped');
  });

  it('launcher 进行中 dispose：拉起来的进程立即关掉，不再开页面', async () => {
    const host = new FakeHost();
    const inner = fakeLauncher(host);
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((r) => (release = r));
    const launcher: Launcher = async (o) => {
      calls++;
      await gate;
      return inner.launcher(o);
    };
    const { m, log } = make(host, launcher);
    const starting = m.ensureRunning().catch((e: Error) => e);
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 4000, interval: 2 });
    const disposing = m.dispose();
    release();
    await disposing;
    expect(String(await starting)).toMatch(/退出|重新加载/);
    expect(inner.launched).toHaveLength(1);
    expect(inner.launched[0].closed).toBe(true);
    expect(inner.launched[0].gotoUrl).toBeUndefined();
    expect(m.state).toBe('stopped');
    expect(log.lines.some((l) => l.startsWith('error'))).toBe(false);
  });
});
