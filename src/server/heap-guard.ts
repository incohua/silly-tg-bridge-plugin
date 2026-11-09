// 页面 JS 堆回收：低内存模式把 JS 老生代上限设成 256 MB，而页面堆会随时间缓慢增长，
// 迟早撞上限、“Page crashed!”。这里根据扩展心跳上报的堆用量，在 bot 空闲时主动重载页面把堆清零，
// 而不是等它在生成回复的中途崩溃。
import type { HostEvent } from '../shared/protocol';
import type { Logger } from './logger';

/** 低内存模式下 Chromium 的 JS 老生代上限（MB）。browser.ts 的启动参数和回收阈值共用这个值。 */
export const OLD_SPACE_LIMIT_MB = 256;

const MB = 1024 * 1024;

export interface HeapGuardOptions {
  host: { onEvent(fn: (e: HostEvent) => void): () => void };
  /** bot 当前没有进行中的生成或操作。 */
  isIdle(): boolean;
  /** 重载页面并恢复会话；失败请抛错。 */
  recycle(): Promise<void>;
  /** 当前运行的浏览器有堆上限才回收（lowMemory 关闭时没有上限参数）。 */
  enabled(): boolean;
  log: Logger;
  now?: () => number;
  /** 用量 ≥ 上限的这个比例时回收，默认 0.75。 */
  thresholdRatio?: number;
  /** 两次回收（含失败）之间的最小间隔，默认 5 分钟。 */
  minIntervalMs?: number;
  /** 回收完成后多久内用量又回到阈值以上，就判定回收没用、停止自动回收，默认 5 分钟。 */
  relapseWindowMs?: number;
}

export interface HeapStatus {
  usedMB?: number;
  limitMB: number;
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
  private readonly off: () => void;
  private readonly now: () => number;
  private readonly thresholdMB: number;
  private readonly minIntervalMs: number;
  private readonly relapseWindowMs: number;

  constructor(private readonly opts: HeapGuardOptions) {
    this.now = opts.now ?? Date.now;
    this.thresholdMB = OLD_SPACE_LIMIT_MB * (opts.thresholdRatio ?? 0.75);
    this.minIntervalMs = opts.minIntervalMs ?? 5 * 60_000;
    this.relapseWindowMs = opts.relapseWindowMs ?? 5 * 60_000;
    this.off = opts.host.onEvent((e) => this.onEvent(e));
  }

  status(): HeapStatus {
    return {
      usedMB: this.usedBytes === undefined ? undefined : this.usedBytes / MB,
      limitMB: OLD_SPACE_LIMIT_MB,
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
    this.off();
  }

  private onEvent(e: HostEvent): void {
    if (this.disposed) return;
    // 页面重新加载（新的 hello）后旧用量作废，等新页面的第一次心跳
    if (e.type === 'hello') {
      this.usedBytes = undefined;
      return;
    }
    if (e.type !== 'heartbeat' || !e.heap || this.inFlight) return;
    this.usedBytes = e.heap.used;
    this.consider();
  }

  private consider(): void {
    if (this.suspended || this.usedBytes === undefined || !this.opts.enabled()) return;
    const usedMB = this.usedBytes / MB;
    if (usedMB < this.thresholdMB) return;
    const now = this.now();
    if (this.lastSuccessAt !== undefined && now - this.lastSuccessAt <= this.relapseWindowMs) {
      this.suspended = true;
      this.opts.log.warn(
        `页面堆回收后用量立即回到 ${Math.round(usedMB)} MB（阈值 ${Math.round(this.thresholdMB)} MB），已停止自动回收。` +
          `可能是当前角色卡或聊天本身就很大；可以在配置里把 lowMemory 设为 false 取消 ${OLD_SPACE_LIMIT_MB} MB 上限（需要更多内存）`,
      );
      return;
    }
    if (this.lastAttemptAt !== undefined && now - this.lastAttemptAt < this.minIntervalMs) return;
    if (!this.opts.isIdle()) return; // 生成中不打断，下一次心跳再判断
    this.inFlight = this.run(usedMB);
  }

  private async run(usedMB: number): Promise<void> {
    const { log } = this.opts;
    const startedAt = this.now();
    this.lastAttemptAt = startedAt;
    log.info(`页面 JS 堆 ${usedMB.toFixed(0)} MB / 上限 ${OLD_SPACE_LIMIT_MB} MB，已达回收阈值且 bot 空闲，重载页面`);
    try {
      await this.opts.recycle();
      const done = this.now();
      this.lastAttemptAt = done;
      this.lastSuccessAt = done;
      this.recycledCount++;
      log.info(`堆回收重载完成：回收前 ${usedMB.toFixed(0)} MB / 上限 ${OLD_SPACE_LIMIT_MB} MB，用时 ${Math.max(0, Math.round((done - startedAt) / 1000))} 秒`);
    } catch (e) {
      this.lastAttemptAt = this.now();
      log.warn(`堆回收重载失败：${(e as Error).message}`);
    } finally {
      this.usedBytes = undefined;
      this.inFlight = null;
    }
  }
}
