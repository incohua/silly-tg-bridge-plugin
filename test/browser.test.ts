import { describe, expect, it } from 'vitest';
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
  closed: boolean;
  killed: boolean;
  disconnect(): void;
  crashPage(): void;
  gotoUrl?: string;
}

function fakeLauncher(host: FakeHost, opts: { connect?: boolean; redirectTo?: string } = {}) {
  const launched: FakeBrowser[] = [];
  const argsSeen: string[][] = [];
  const launcher: Launcher = async ({ args }) => {
    argsSeen.push(args);
    let onDisc: (() => void) | null = null;
    let onPageError: ((e: Error) => void) | null = null;
    const b: FakeBrowser = {
      pid: 1000 + launched.length,
      closed: false,
      killed: false,
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
          on: ((ev: string, fn: (e: Error) => void) => {
            if (ev === 'error') onPageError = fn;
          }) as PageLike['on'],
        };
      },
      close: async () => {
        b.closed = true;
        host.setConnected(false);
      },
      kill: () => void (b.killed = true),
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
    await wait(150);
    expect(m.state).toBe('stopped');
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

  it('页面崩溃：发 crashed 事件并关闭浏览器', async () => {
    const host = new FakeHost();
    const { launcher, launched } = fakeLauncher(host);
    const { m, events } = make(host, launcher);
    await m.ensureRunning();
    launched[0].crashPage();
    await wait(10);
    expect(events.some((e) => e.type === 'crashed')).toBe(true);
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
});
