import { describe, expect, it } from 'vitest';
import type { HostEvent } from '../src/shared/protocol';
import { HeapGuard, OLD_SPACE_LIMIT_MB, type HeapGuardOptions } from '../src/server/heap-guard';
import { captureLogger } from './helpers';

const MB = 1024 * 1024;
const MIN = 60_000;

class Setup {
  now = 1_000_000;
  idle = true;
  enabled = true;
  recycles = 0;
  recycleError: Error | null = null;
  /** 让 recycle 一直挂起，直到调用 finishRecycle */
  hold = false;
  private release: (() => void) | null = null;
  private handlers = new Set<(e: HostEvent) => void>();
  log = captureLogger();
  guard: HeapGuard;

  constructor(extra: Partial<HeapGuardOptions> = {}) {
    this.guard = new HeapGuard({
      host: {
        onEvent: (fn) => {
          this.handlers.add(fn);
          return () => this.handlers.delete(fn);
        },
      },
      isIdle: () => this.idle,
      enabled: () => this.enabled,
      recycle: async () => {
        this.recycles++;
        if (this.hold) await new Promise<void>((r) => (this.release = r));
        if (this.recycleError) throw this.recycleError;
      },
      log: this.log,
      now: () => this.now,
      ...extra,
    });
  }
  emit(e: HostEvent) {
    for (const h of [...this.handlers]) h(e);
  }
  beat(usedMB: number | undefined) {
    this.emit(usedMB === undefined ? { type: 'heartbeat' } : { type: 'heartbeat', heap: { used: usedMB * MB, limit: 352 * MB } });
  }
  finishRecycle() {
    this.release?.();
  }
}

describe('HeapGuard', () => {
  it('阈值是老生代上限的 75%；低于阈值不回收', async () => {
    const t = new Setup();
    t.beat(100);
    t.beat(OLD_SPACE_LIMIT_MB * 0.75 - 1);
    await t.guard.settled();
    expect(t.recycles).toBe(0);
    expect(t.guard.status()).toMatchObject({ limitMB: 256, recycled: 0, suspended: false });
  });

  it('≥75% 且空闲：回收一次，并记 info', async () => {
    const t = new Setup();
    t.beat(200);
    await t.guard.settled();
    expect(t.recycles).toBe(1);
    expect(t.guard.status().recycled).toBe(1);
    expect(t.log.lines.some((l) => l.startsWith('info') && l.includes('200 MB') && l.includes('堆回收重载完成'))).toBe(true);
  });

  it('busy 时不回收；busy 结束后的下一次心跳回收', async () => {
    const t = new Setup();
    t.idle = false;
    t.beat(200);
    t.beat(205);
    await t.guard.settled();
    expect(t.recycles).toBe(0);
    t.idle = true;
    t.beat(210);
    await t.guard.settled();
    expect(t.recycles).toBe(1);
  });

  it('回收进行中收到的心跳不会触发第二次回收', async () => {
    const t = new Setup();
    t.hold = true;
    t.beat(200);
    t.beat(210);
    t.beat(220);
    expect(t.recycles).toBe(1);
    t.finishRecycle();
    await t.guard.settled();
    expect(t.recycles).toBe(1);
  });

  it('回收后很快又超阈值：停止自动回收并 warn，不死循环', async () => {
    const t = new Setup();
    t.beat(200);
    await t.guard.settled();
    t.now += 2 * MIN;
    t.beat(0.1); // 新页面起步很低 → 不算复发
    t.now += 1 * MIN;
    t.beat(200); // 5 分钟窗口内又回到阈值以上
    await t.guard.settled();
    expect(t.recycles).toBe(1);
    expect(t.guard.status().suspended).toBe(true);
    expect(t.log.lines.filter((l) => l.startsWith('warn') && l.includes('已停止自动回收'))).toHaveLength(1);
    t.now += 60 * MIN;
    t.beat(250);
    await t.guard.settled();
    expect(t.recycles).toBe(1);
  });

  it('窗口过后正常增长到阈值：允许下一次回收（间隔 ≥ 5 分钟）', async () => {
    const t = new Setup();
    t.beat(200);
    await t.guard.settled();
    t.now += 25 * MIN;
    t.beat(195);
    await t.guard.settled();
    expect(t.recycles).toBe(2);
    expect(t.guard.status()).toMatchObject({ recycled: 2, suspended: false });
  });

  it('回收失败：只 warn 不抛出，且仍计入最小间隔', async () => {
    const t = new Setup();
    t.recycleError = new Error('页面没回来');
    t.beat(200);
    await t.guard.settled();
    expect(t.recycles).toBe(1);
    expect(t.guard.status().recycled).toBe(0);
    expect(t.log.lines.some((l) => l.startsWith('warn') && l.includes('页面没回来'))).toBe(true);
    t.now += 1 * MIN;
    t.beat(200);
    await t.guard.settled();
    expect(t.recycles).toBe(1); // 间隔未到
    t.now += 5 * MIN;
    t.recycleError = null;
    t.beat(200);
    await t.guard.settled();
    expect(t.recycles).toBe(2);
    expect(t.guard.status().suspended).toBe(false);
  });

  it('enabled() 为 false 时不回收', async () => {
    const t = new Setup();
    t.enabled = false;
    t.beat(250);
    await t.guard.settled();
    expect(t.recycles).toBe(0);
  });

  it('缺省的 heap（旧版扩展）被忽略', async () => {
    const t = new Setup();
    t.beat(undefined);
    await t.guard.settled();
    expect(t.recycles).toBe(0);
    expect(t.guard.status().usedMB).toBeUndefined();
  });

  it('新页面 hello 后旧用量作废；status 反映最近一次用量', () => {
    const t = new Setup();
    t.beat(50);
    expect(t.guard.status().usedMB).toBeCloseTo(50);
    t.emit({ type: 'hello', nonce: 'n', stVersion: 'x', hasTavernHelper: false });
    expect(t.guard.status().usedMB).toBeUndefined();
  });

  it('dispose() 后不再响应', async () => {
    const t = new Setup();
    t.guard.dispose();
    t.beat(250);
    await t.guard.settled();
    expect(t.recycles).toBe(0);
  });
});
