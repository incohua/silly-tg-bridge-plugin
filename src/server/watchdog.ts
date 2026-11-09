// 看门狗：页面崩溃、浏览器进程意外退出、SSE 断开超过 60 秒、心跳超时时重启 Chromium，并通知白名单用户。
//
// 退避：短时间内（healthyResetMs，默认 5 分钟）接连出事，每次等待更久（0、5 秒、30 秒、2 分钟、5 分钟）；
// 连续超过 maxConsecutive 次就停止自动重启，等用户发消息时再由 BrowserManager.ensureRunning 尝试一次。
// 稳定运行超过 healthyResetMs 后，计数清零。
// 恢复期间到达的消息由 Bot 调 ensureRunning 等待同一次启动，不会丢；退避等待期间到达的消息会直接触发启动。
// 空闲关闭和插件退出不算故障。

import type { BrowserEvent, BrowserState } from './browser';
import type { Logger } from './logger';

export interface WatchdogBrowser {
  readonly state: BrowserState;
  /** 每次启动完成都会变。 */
  readonly startedAt?: number;
  onEvent(fn: (e: BrowserEvent) => void): () => void;
  ensureRunning(): Promise<void>;
  stop(reason?: string): Promise<void>;
}

export interface WatchdogHost {
  readonly connected: boolean;
  onConnectionChange(fn: (connected: boolean) => void): () => void;
}

export interface WatchdogOptions {
  browser: WatchdogBrowser;
  host: WatchdogHost;
  log: Logger;
  /** 通知所有白名单用户。失败由实现自己处理。 */
  notify: (text: string) => Promise<void>;
  now?: () => number;
  /** SSE 断开多久算故障，默认 60 秒。 */
  disconnectGraceMs?: number;
  backoffMs?: number[];
  maxConsecutive?: number;
  healthyResetMs?: number;
}

const DEFAULT_BACKOFF = [0, 5_000, 30_000, 120_000, 300_000];

export class Watchdog {
  private consecutive = 0;
  private lastIncidentAt = 0;
  private recovering = false;
  private gaveUp = false;
  private disposed = false;
  private restarts = 0;
  private lastReason?: string;
  private retryAt?: number;
  private disconnectTimer: NodeJS.Timeout | null = null;
  private backoffTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private readonly offs: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly opts: WatchdogOptions) {
    this.now = opts.now ?? Date.now;
    this.offs.push(
      opts.browser.onEvent((e) => {
        if (e.type === 'crashed') this.incident(e.detail);
        else if (e.type === 'heartbeatTimeout') this.incident(`页面 ${Math.round(e.silentMs / 1000)} 秒没有心跳`);
        else if (e.type === 'started' && this.gaveUp && !this.recovering) {
          // 用户发消息触发的启动成功了，恢复自动重启
          this.gaveUp = false;
          this.opts.log.info('无头浏览器已由新消息重新启动，看门狗恢复工作');
        }
      }),
      opts.host.onConnectionChange((connected) => this.onConnection(connected)),
    );
  }

  /** /status 用的一行说明。 */
  status(): string {
    const parts: string[] = [];
    if (this.gaveUp) parts.push('多次恢复失败，已停止自动重启（下一条消息会再试）');
    else if (this.recovering) parts.push(this.retryAt && this.retryAt > this.now() ? `正在恢复，${Math.ceil((this.retryAt - this.now()) / 1000)} 秒后重试` : '正在恢复');
    else parts.push('正常');
    if (this.restarts > 0) parts.push(`已自动重启 ${this.restarts} 次${this.lastReason ? `，上次原因：${this.lastReason}` : ''}`);
    return parts.join('；');
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.wake?.();
  }

  private onConnection(connected: boolean): void {
    if (connected) {
      if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
      return;
    }
    // 只关心运行中的断开；启动、关闭过程中的断开是自己造成的
    if (this.opts.browser.state !== 'running' || this.disconnectTimer) return;
    const grace = this.opts.disconnectGraceMs ?? 60_000;
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      if (!this.opts.host.connected && this.opts.browser.state === 'running') this.incident(`页面连接断开超过 ${Math.round(grace / 1000)} 秒`);
    }, grace);
    this.disconnectTimer.unref?.();
  }

  private incident(reason: string): void {
    if (this.disposed) return;
    const { log } = this.opts;
    if (this.recovering) {
      log.debug(`看门狗：恢复进行中，忽略新故障（${reason}）`);
      return;
    }
    if (this.gaveUp) {
      log.warn(`看门狗：已停止自动重启，忽略故障（${reason}）`);
      return;
    }
    const now = this.now();
    const healthy = this.opts.healthyResetMs ?? 300_000;
    this.consecutive = this.lastIncidentAt && now - this.lastIncidentAt < healthy ? this.consecutive + 1 : 1;
    this.lastIncidentAt = now;
    this.lastReason = reason;
    log.warn(`看门狗：${reason}（短时间内第 ${this.consecutive} 次）`);
    void this.recover(reason);
  }

  private async recover(reason: string): Promise<void> {
    const { log, browser, notify } = this.opts;
    const max = this.opts.maxConsecutive ?? 5;
    if (this.consecutive > max) {
      this.gaveUp = true;
      log.error(`看门狗：短时间内 ${max} 次恢复都没能稳定运行，停止自动重启`);
      await notify(`无头浏览器多次异常（最近一次：${reason}），已停止自动重启。下一条消息会再尝试启动一次；如果仍然失败，请查看 ST 的日志。`);
      return;
    }
    this.recovering = true;
    const startedAtBefore = browser.startedAt;
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.consecutive - 1, backoff.length - 1)];
    try {
      await notify(`无头浏览器异常：${reason}。正在自动重启${delay > 0 ? `（${Math.round(delay / 1000)} 秒后）` : ''}…${/crashed/i.test(reason) ? '\n如果开着低内存模式，页面崩溃多半是 JS 内存达到上限，详见 README 的「使用提醒」。' : ''}`);
      if (delay > 0) {
        this.retryAt = this.now() + delay;
        await new Promise<void>((r) => {
          this.wake = r;
          this.backoffTimer = setTimeout(r, delay);
        });
        this.wake = null;
        this.retryAt = undefined;
      }
      if (this.disposed) return;
      // 退避期间如果新消息已经触发了一次成功的启动，就不再重启
      const alreadyRestarted = browser.state === 'running' && browser.startedAt !== startedAtBefore;
      if (!alreadyRestarted) {
        if (browser.state === 'running') await browser.stop('看门狗重启');
        await browser.ensureRunning();
      }
      this.restarts++;
      log.info('看门狗：无头浏览器已恢复');
      await notify('无头浏览器已恢复，可以继续对话。如果刚才的消息没有收到回复，请重新发送。');
      this.recovering = false;
    } catch (e) {
      this.recovering = false;
      const msg = (e as Error).message;
      log.error(`看门狗：重启失败：${msg}`);
      if (!this.disposed) this.incident(`重启失败：${msg}`);
    }
  }
}
