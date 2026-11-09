import { describe, expect, it } from 'vitest';
import type { BrowserEvent, BrowserState } from '../src/server/browser';
import { Watchdog, type WatchdogBrowser, type WatchdogHost } from '../src/server/watchdog';
import { captureLogger } from './helpers';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeBrowser implements WatchdogBrowser {
  state: BrowserState = 'running';
  startedAt: number | undefined = 1;
  starts = 0;
  stops = 0;
  failNext = 0;
  private handlers = new Set<(e: BrowserEvent) => void>();
  onEvent(fn: (e: BrowserEvent) => void) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  emit(e: BrowserEvent) {
    for (const h of [...this.handlers]) h(e);
  }
  async ensureRunning() {
    if (this.state === 'running') return;
    this.starts++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('启动失败');
    }
    this.state = 'running';
    this.startedAt = Date.now() + this.starts;
    this.emit({ type: 'started' });
  }
  async stop() {
    this.stops++;
    this.state = 'stopped';
  }
  crash() {
    this.state = 'stopped';
    this.emit({ type: 'crashed', detail: '浏览器进程意外退出' });
  }
}

class FakeHost implements WatchdogHost {
  connected = true;
  private handlers = new Set<(c: boolean) => void>();
  onConnectionChange(fn: (c: boolean) => void) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  set(c: boolean) {
    this.connected = c;
    for (const h of [...this.handlers]) h(c);
  }
}

function setup(over: Partial<ConstructorParameters<typeof Watchdog>[0]> = {}) {
  const browser = new FakeBrowser();
  const host = new FakeHost();
  const notes: string[] = [];
  const log = captureLogger();
  const wd = new Watchdog({ browser, host, log, notify: async (t) => void notes.push(t), backoffMs: [0, 20, 40], maxConsecutive: 3, disconnectGraceMs: 30, ...over });
  return { browser, host, notes, log, wd };
}

describe('Watchdog', () => {
  it('浏览器崩溃：通知、重启、再通知已恢复', async () => {
    const { browser, notes, wd } = setup();
    browser.crash();
    await wait(10);
    expect(browser.starts).toBe(1);
    expect(browser.state).toBe('running');
    expect(notes[0]).toMatch(/无头浏览器异常：浏览器进程意外退出。正在自动重启/);
    expect(notes[1]).toMatch(/已恢复/);
    expect(wd.status()).toMatch(/已自动重启 1 次/);
    wd.dispose();
  });

  it('页面崩溃（Page crashed!）：通知里提示可能是 JS 内存上限；其他故障不带这句', async () => {
    const { browser, notes, wd } = setup();
    browser.emit({ type: 'crashed', detail: '页面崩溃：Page crashed!' });
    await wait(10);
    expect(notes[0]).toMatch(/页面崩溃：Page crashed!。正在自动重启/);
    expect(notes[0]).toMatch(/JS 内存达到上限.*使用提醒/);
    wd.dispose();
    const other = setup();
    other.browser.crash();
    await wait(10);
    expect(other.notes[0]).not.toMatch(/JS 内存/);
    other.wd.dispose();
  });

  it('心跳超时：先关闭再启动', async () => {
    const { browser, wd } = setup();
    browser.emit({ type: 'heartbeatTimeout', silentMs: 90_000 });
    await wait(10);
    expect(browser.stops).toBe(1);
    expect(browser.starts).toBe(1);
    wd.dispose();
  });

  it('SSE 断开超过宽限期才重启；宽限期内重连不重启', async () => {
    const { browser, host, wd } = setup();
    host.set(false);
    await wait(10);
    host.set(true);
    await wait(40);
    expect(browser.starts).toBe(0);
    host.set(false);
    await wait(50);
    expect(browser.stops).toBe(1);
    expect(browser.starts).toBe(1);
    wd.dispose();
  });

  it('浏览器没在运行时的断开（空闲关闭、启动中）不算故障', async () => {
    const { browser, host, wd } = setup();
    browser.state = 'stopped';
    host.set(false);
    await wait(50);
    expect(browser.starts).toBe(0);
    browser.emit({ type: 'stopped', reason: 'idle' });
    await wait(10);
    expect(browser.starts).toBe(0);
    wd.dispose();
  });

  it('接连出事：退避逐次变长，超过上限后停止自动重启', async () => {
    const { browser, notes, wd } = setup();
    browser.crash();
    await wait(10);
    browser.crash();
    await wait(5);
    expect(browser.starts).toBe(1); // 第二次在等 20ms 退避
    expect(wd.status()).toMatch(/正在恢复/);
    await wait(30);
    expect(browser.starts).toBe(2);
    browser.crash();
    await wait(60);
    expect(browser.starts).toBe(3);
    browser.crash();
    await wait(60);
    expect(browser.starts).toBe(3);
    expect(notes.at(-1)).toMatch(/已停止自动重启/);
    expect(wd.status()).toMatch(/已停止自动重启/);
    // 用户发消息触发的启动成功后恢复工作
    await browser.ensureRunning();
    expect(wd.status()).not.toMatch(/已停止自动重启/);
    wd.dispose();
  });

  it('重启失败：按退避再试', async () => {
    const { browser, wd, log } = setup();
    browser.failNext = 1;
    browser.crash();
    await wait(60);
    expect(browser.starts).toBe(2);
    expect(browser.state).toBe('running');
    expect(log.lines.join('\n')).toMatch(/重启失败/);
    wd.dispose();
  });

  it('退避期间新消息已经把浏览器启动起来：不再重复重启', async () => {
    const { browser, wd } = setup({ backoffMs: [50] });
    browser.crash();
    await wait(5);
    await browser.ensureRunning(); // 用户消息触发
    const startedAt = browser.startedAt;
    await wait(70);
    expect(browser.stops).toBe(0);
    expect(browser.starts).toBe(1);
    expect(browser.startedAt).toBe(startedAt);
    wd.dispose();
  });

  it('dispose 后不再处理事件', async () => {
    const { browser, wd } = setup();
    wd.dispose();
    browser.crash();
    await wait(10);
    expect(browser.starts).toBe(0);
  });
});
