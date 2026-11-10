import { describe, expect, it, vi } from 'vitest';
import { HeapGuard, type HeapGuardOptions } from '../src/server/heap-guard';
import { captureLogger } from './helpers';

const MB = 1024 * 1024;
const MIN = 60_000;

class Setup {
  now = 1_000_000;
  idle = true;
  /** 当前页面堆用量（MB）；undefined 表示取不到（页面重载中） */
  usedMB: number | undefined = 100;
  limit: number | undefined = 256;
  recycles = 0;
  recycleError: Error | null = null;
  /** 让 recycle 一直挂起，直到调用 finishRecycle */
  hold = false;
  sampleThrows = false;
  samples = 0;
  private release: (() => void) | null = null;
  log = captureLogger();
  guard: HeapGuard;

  constructor(extra: Partial<HeapGuardOptions> = {}) {
    this.guard = new HeapGuard({
      sample: async () => {
        this.samples++;
        if (this.sampleThrows) throw new Error('cdp 断了');
        return this.usedMB === undefined ? undefined : this.usedMB * MB;
      },
      limitMB: () => this.limit,
      isIdle: () => this.idle,
      recycle: async () => {
        this.recycles++;
        if (this.hold) await new Promise<void>((r) => (this.release = r));
        if (this.recycleError) throw this.recycleError;
      },
      log: this.log,
      now: () => this.now,
      intervalMs: 0, // 测试里手动 poll
      ...extra,
    });
  }
  /** 设置当前用量并采样一次。 */
  async at(usedMB: number | undefined): Promise<void> {
    this.usedMB = usedMB;
    await this.guard.poll();
    await this.guard.settled();
  }
  finishRecycle() {
    this.release?.();
  }
}

describe('HeapGuard', () => {
  it('阈值是上限的 75%（256 → 192 MB）；低于阈值不回收', async () => {
    const t = new Setup();
    await t.at(100);
    await t.at(191);
    expect(t.recycles).toBe(0);
    expect(t.guard.status()).toMatchObject({ usedMB: 191, limitMB: 256, recycled: 0, suspended: false });
  });

  it('阈值随上限变：512 → 384 MB，300 MB 不回收，390 MB 回收', async () => {
    const t = new Setup();
    t.limit = 512;
    await t.at(300);
    expect(t.recycles).toBe(0);
    await t.at(390);
    expect(t.recycles).toBe(1);
    expect(t.log.lines.some((l) => l.includes('390 MB / 上限 512 MB'))).toBe(true);
  });

  it('≥75% 且空闲：回收一次，并记 info', async () => {
    const t = new Setup();
    await t.at(200);
    expect(t.recycles).toBe(1);
    expect(t.guard.status().recycled).toBe(1);
    expect(t.log.lines.some((l) => l.startsWith('info') && l.includes('200 MB') && l.includes('堆回收完成'))).toBe(true);
  });

  it('busy 时不回收；busy 结束后的下一次采样回收', async () => {
    const t = new Setup();
    t.idle = false;
    await t.at(200);
    await t.at(205);
    expect(t.recycles).toBe(0);
    t.idle = true;
    await t.at(210);
    expect(t.recycles).toBe(1);
  });

  it('回收进行中的采样被忽略，不会触发第二次回收', async () => {
    const t = new Setup();
    t.hold = true;
    t.usedMB = 200;
    await t.guard.poll();
    expect(t.recycles).toBe(1);
    const before = t.samples;
    await t.guard.poll();
    await t.guard.poll();
    expect(t.recycles).toBe(1);
    expect(t.samples).toBe(before); // 回收中根本不采样
    t.finishRecycle();
    await t.guard.settled();
    expect(t.recycles).toBe(1);
  });

  it('回收后很快又超阈值：停止自动回收并 warn，不死循环', async () => {
    const t = new Setup();
    await t.at(200);
    t.now += 2 * MIN;
    await t.at(25); // 新页面起步很低 → 不算复发
    t.now += 1 * MIN;
    await t.at(200); // 5 分钟窗口内又回到阈值以上
    expect(t.recycles).toBe(1);
    expect(t.guard.status().suspended).toBe(true);
    const warns = t.log.lines.filter((l) => l.startsWith('warn') && l.includes('已停止自动回收'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/pageHeapLimitMB/);
    t.now += 60 * MIN;
    await t.at(250);
    expect(t.recycles).toBe(1);
  });

  it('回收刚完成的沉降期内不采样：旧页面的垃圾还没释放时读数偏高，不能误判成“回收后立即回升”', async () => {
    const t = new Setup();
    await t.at(200);
    const n = t.samples;
    t.now += 10_000; // 沉降期（30 秒）内
    await t.at(200); // 即使读数偏高也不看
    expect(t.samples).toBe(n);
    expect(t.guard.status().suspended).toBe(false);
    t.now += 25_000; // 过了沉降期，读数已回落
    await t.at(30);
    expect(t.samples).toBe(n + 1);
    expect(t.guard.status()).toMatchObject({ suspended: false, usedMB: 30 });
  });

  it('窗口过后正常增长到阈值：允许下一次回收', async () => {
    const t = new Setup();
    await t.at(200);
    t.now += 25 * MIN;
    await t.at(195);
    expect(t.recycles).toBe(2);
    expect(t.guard.status()).toMatchObject({ recycled: 2, suspended: false });
  });

  it('回收失败：只 warn 不抛出，且仍计入最小间隔', async () => {
    const t = new Setup();
    t.recycleError = new Error('页面没回来');
    await t.at(200);
    expect(t.recycles).toBe(1);
    expect(t.guard.status().recycled).toBe(0);
    expect(t.log.lines.some((l) => l.startsWith('warn') && l.includes('页面没回来'))).toBe(true);
    t.now += 1 * MIN;
    await t.at(200);
    expect(t.recycles).toBe(1); // 间隔未到
    t.now += 5 * MIN;
    t.recycleError = null;
    await t.at(200);
    expect(t.recycles).toBe(2);
    expect(t.guard.status().suspended).toBe(false);
  });

  it('没有上限（非低内存模式或浏览器没在运行）时不采样也不回收', async () => {
    const t = new Setup();
    t.limit = undefined;
    await t.at(250);
    expect(t.recycles).toBe(0);
    expect(t.samples).toBe(0);
    expect(t.guard.status()).toMatchObject({ usedMB: undefined, limitMB: undefined });
  });

  it('取不到用量（页面重载中、CDP 出错）：忽略，不回收也不抛', async () => {
    const t = new Setup();
    await t.at(undefined);
    t.sampleThrows = true;
    await t.at(250);
    expect(t.recycles).toBe(0);
    expect(t.guard.status().usedMB).toBeUndefined();
  });

  it('定时器：按间隔自动采样；dispose 后停止', async () => {
    const t = new Setup({ intervalMs: 10 });
    t.usedMB = 220;
    await vi.waitFor(() => expect(t.recycles).toBeGreaterThanOrEqual(1), { timeout: 4000, interval: 5 });
    await t.guard.settled();
    expect(t.recycles).toBeGreaterThanOrEqual(1);
    t.guard.dispose();
    const n = t.samples;
    await new Promise((r) => setTimeout(r, 40));
    expect(t.samples).toBe(n);
  });

  it('dispose() 后 poll 不再响应', async () => {
    const t = new Setup();
    t.guard.dispose();
    await t.at(250);
    expect(t.recycles).toBe(0);
    expect(t.samples).toBe(0);
  });
});
