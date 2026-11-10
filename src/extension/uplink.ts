// 上行：POST /api/plugins/silly-tg/host/message，信封 {nonce, event}。
// 所有事件按发送顺序串行提交，保证 streamText 不会比 messageFinal 晚到。

import type { HostEvent, HostUpload } from '../shared/protocol';
import { ctx } from './adapter';

export const PLUGIN_BASE = '/api/plugins/silly-tg';

/** 单次上行请求的超时；卡住的请求会堵住整条串行链。 */
export const UPLINK_TIMEOUT_MS = 30_000;

export class Uplink {
  private chain: Promise<unknown> = Promise.resolve();
  private dead = false;

  constructor(
    private readonly nonce: string,
    /** 服务端返回 403（nonce 已换，页面过期）时回调一次。 */
    private readonly onRejected: () => void,
  ) {}

  get closed(): boolean {
    return this.dead;
  }

  /** 立即提交（不排队），返回 HTTP 状态。只用于 hello。 */
  async sendNow(event: HostEvent): Promise<number> {
    const res = await fetch(`${PLUGIN_BASE}/host/message`, {
      method: 'POST',
      headers: ctx().getRequestHeaders(),
      body: JSON.stringify({ nonce: this.nonce, event } satisfies HostUpload),
      signal: AbortSignal.timeout(UPLINK_TIMEOUT_MS),
    });
    return res.status;
  }

  /** 排队提交。失败只记控制台，不抛错。 */
  send(event: HostEvent): Promise<void> {
    const p = this.chain.then(async () => {
      if (this.dead) return;
      try {
        const status = await this.sendNow(event);
        if (status === 403) this.reject();
        else if (status >= 400) console.warn(`[silly-tg] 上行 ${event.type} 失败：HTTP ${status}`);
      } catch (e) {
        console.warn(`[silly-tg] 上行 ${event.type} 失败：${(e as Error).message}`);
      }
    });
    this.chain = p;
    return p;
  }

  reject(): void {
    if (this.dead) return;
    this.dead = true;
    this.onRejected();
  }
}
