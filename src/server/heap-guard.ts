// 页面 JS 堆回收：低内存模式把 JS 老生代上限设成 pageHeapLimitMB（默认 256 MB），而页面堆会随时间缓慢增长，
// 迟早撞上限、“Page crashed!”。这里定时经 CDP 读取页面 JS 堆用量（Runtime.getHeapUsage），在 bot 空闲时
// 主动重载页面把堆清零，而不是等它在生成回复的中途崩溃。
//
// 数据源为什么是 CDP 而不是页面里的 performance.memory：后者是分桶近似值，在带酒馆助手 / MVU 的真实页面上
// 比 CDP 实测值高出 40 MB 以上（Luker 实测 185 对 141 MB），用它和 75% 阈值比较会一启动就贴着阈值，回收白做。
import type { Logger } from './logger';

const MB = 1024 * 1024;

export interface HeapGuardOptions {
  /** 当前页面 JS 堆已用字节数；取不到（页面重载中、浏览器没在运行）返回 undefined。 */
  sample(): Promise<number | undefined>;
  /** 当前运行的浏览器的 JS 堆上限（MB）；没有上限（非低内存模式）或没在运行时返回 undefined，此时不回收。 */
  limitMB(): number | undefined;
  /** bot 当前没有进行中的生成或操作。 */
  isIdle(): boolean;
  /** 重载页面并恢复会话；失败请抛错。 */
  recycle(): Promise<void>;
  log: Logger;
  now?: () => number;
  /** 采样间隔，默认 15 秒；0 表示不自动采样（测试里手动调用 poll）。 */
  intervalMs?: number;
  /** 用量 ≥ 上限的这个比例时回收，默认 0.75。 */
  thresholdRatio?: number;
  /** 两次回收（含失败）之间的最小间隔，默认 5 分钟。 */
  minIntervalMs?: number;
  /** 回收完成后多久内用量又回到阈值以上，就判定回收没用、停止自动回收，默认 5 分钟。 */
  relapseWindowMs?: number;
  /**
   * 回收完成后先不采样的沉降期，默认 30 秒。CDP 读的是整个渲染进程的堆，旧页面的垃圾要等 GC 才释放，
   * 刚重载完的几秒到十几秒里读数会偏高（本机实测 110 MB 对稳定后的 19 MB），不等它沉降会把“回收有效”误判成“回收后立即回升”。
   */
  settleMs?: number;
}

export interface HeapStatus {
  usedMB?: number;
  limitMB?: number;
  recycled: number;
  suspended: boolean;
}

export class HeapGuard {
  private usedBytes: number | undefined;
  private recycledCount = 0;
  private suspended = false;
  private inFlight: Promise<void> | null = null;
  private lastAttemptAt: number | undefined;
  /** 最近一次成功回收完成的时间，用来判断回收后是否马上又超阈值。 */
  private lastSuccessAt: number | undefined;
  private disposed = false;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly now: () => number;
  private readonly thresholdRatio: number;
  private readonly minIntervalMs: number;
  private readonly relapseWindowMs: number;
  private readonly settleMs: number;

  constructor(private readonly opts: HeapGuardOptions) {
    this.now = opts.now ?? Date.now;
    this.thresholdRatio = opts.thresholdRatio ?? 0.75;
    this.minIntervalMs = opts.minIntervalMs ?? 5 * 60_000;
    this.relapseWindowMs = opts.relapseWindowMs ?? 5 * 60_000;
    this.settleMs = opts.settleMs ?? 30_000;
    const interval = opts.intervalMs ?? 15_000;
    if (interval > 0) {
      this.timer = setInterval(() => void this.poll(), interval);
      this.timer.unref?.();
    }
  }

  status(): HeapStatus {
    return {
      usedMB: this.usedBytes === undefined ? undefined : this.usedBytes / MB,
      limitMB: this.opts.limitMB(),
      recycled: this.recycledCount,
      suspended: this.suspended,
    };
  }

  /** 进行中的回收（测试用）。 */
  settled(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 采样一次并按需回收。定时器调用；同一时刻只有一次采样在飞。 */
  async poll(): Promise<void> {
    if (this.disposed || this.polling || this.inFlight) return;
    // 刚回收完：旧页面的垃圾还没释放，读数不可信，等沉降期过去
    if (this.lastSuccessAt !== undefined && this.now() - this.lastSuccessAt < this.settleMs) return;
    this.polling = true;
    try {
      const limitMB = this.opts.limitMB();
      if (limitMB === undefined) {
        this.usedBytes = undefined;
        return;
      }
      const used = await this.opts.sample().catch(() => undefined);
      // 采样期间可能已经 dispose 或开始了回收
      if (this.disposed || this.inFlight) return;
      this.usedBytes = used;
      if (used === undefined) return;
      this.consider(used / MB, limitMB);
    } finally {
      this.polling = false;
    }
  }

  private consider(usedMB: number, limitMB: number): void {
    if (this.suspended) return;
    const thresholdMB = limitMB * this.thresholdRatio;
    if (usedMB < thresholdMB) return;
    const now = this.now();
    if (this.lastSuccessAt !== undefined && now - this.lastSuccessAt <= this.relapseWindowMs) {
      this.suspended = true;
      this.opts.log.warn(
        `页面堆回收后用量立即回到 ${Math.round(usedMB)} MB（阈值 ${Math.round(thresholdMB)} MB），已停止自动回收。` +
          `可能是当前角色卡或聊天本身就很大；可以调大 pageHeapLimitMB（当前 ${limitMB} MB，下次启动浏览器生效），或把 lowMemory 设为 false 取消上限（需要更多内存）`,
      );
      return;
    }
    if (this.lastAttemptAt !== undefined && now - this.lastAttemptAt < this.minIntervalMs) return;
    if (!this.opts.isIdle()) return; // 生成中不打断，下一次采样再判断
    this.inFlight = this.run(usedMB, limitMB);
  }

  private async run(usedMB: number, limitMB: number): Promise<void> {
    const { log } = this.opts;
    const startedAt = this.now();
    this.lastAttemptAt = startedAt;
    log.info(`页面 JS 堆 ${usedMB.toFixed(0)} MB / 上限 ${limitMB} MB，已达回收阈值且 bot 空闲，重载页面`);
    try {
      await this.opts.recycle();
      const done = this.now();
      this.lastAttemptAt = done;
      this.lastSuccessAt = done;
      this.recycledCount++;
      log.info(`堆回收重载完成：回收前 ${usedMB.toFixed(0)} MB / 上限 ${limitMB} MB，用时 ${Math.max(0, Math.round((done - startedAt) / 1000))} 秒`);
    } catch (e) {
      this.lastAttemptAt = this.now();
      log.warn(`堆回收重载失败：${(e as Error).message}`);
    } finally {
      this.usedBytes = undefined;
      this.inFlight = null;
    }
  }
}
