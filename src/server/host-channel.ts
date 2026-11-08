import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { decodeHostUpload, type HostCommand, type HostCommandInput, type HostEvent } from '../shared/protocol';
import type { Logger } from './logger';

export const HOST_EVENTS_PATH = '/host/events';
export const HOST_MESSAGE_PATH = '/host/message';

export class HostChannelError extends Error {
  constructor(
    readonly code: 'not-connected' | 'timeout' | 'disconnected' | 'remote-error',
    message: string,
  ) {
    super(message);
    this.name = 'HostChannelError';
  }
}

export interface HostChannelOptions {
  log: Logger;
  /** RPC 超时（毫秒），默认 30000。 */
  rpcTimeoutMs?: number;
  /** SSE 注释心跳间隔（毫秒），防止中间层断开空闲连接，默认 15000。 */
  keepAliveMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

type EventHandler = (event: HostEvent) => void;

/**
 * 服务端插件与 UI 扩展之间的通道。
 * 下行：GET /host/events（SSE）发命令；上行：POST /host/message 收事件和 RPC 响应。
 * 两个方向都要带 nonce（URL 里的 silly_tg_host 同一个值），不匹配一律 403。
 * 同一时刻只保留一条 SSE 连接：新连接建立时旧的被关闭（host 页面重载或重启 Chromium）。
 */
export class HostChannel {
  private nonceValue = randomBytes(16).toString('hex');
  private sse: Response | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly handlers = new Set<EventHandler>();
  private readonly connHandlers = new Set<(connected: boolean) => void>();
  private readonly rpcTimeoutMs: number;
  private readonly keepAliveMs: number;
  private readonly log: Logger;
  /** 最近一次收到上行消息（含心跳）的时间，看门狗使用。 */
  lastSeenAt = 0;
  /** 最近一次 hello 的内容。 */
  hello: Extract<HostEvent, { type: 'hello' }> | null = null;

  constructor(opts: HostChannelOptions) {
    this.log = opts.log;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 30_000;
    this.keepAliveMs = opts.keepAliveMs ?? 15_000;
  }

  get nonce(): string {
    return this.nonceValue;
  }

  /** 换新 nonce 并断开现有连接。浏览器管理在每次启动 Chromium 前调用，返回值拼进 host URL。 */
  rotateNonce(): string {
    this.closeSse('nonce rotated');
    this.hello = null;
    this.lastSeenAt = 0;
    this.nonceValue = randomBytes(16).toString('hex');
    return this.nonceValue;
  }

  get connected(): boolean {
    return this.sse !== null;
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** SSE 连上或断开时回调（看门狗、进行中的生成使用）。 */
  onConnectionChange(handler: (connected: boolean) => void): () => void {
    this.connHandlers.add(handler);
    return () => this.connHandlers.delete(handler);
  }

  private emitConnection(connected: boolean): void {
    for (const h of this.connHandlers) {
      try {
        h(connected);
      } catch (e) {
        this.log.error(`host 连接状态处理器出错：${(e as Error).message}`);
      }
    }
  }

  /** 注册路由到 ST 给插件的 router（挂在 /api/plugins/silly-tg）。 */
  register(router: Router): void {
    router.get(HOST_EVENTS_PATH, (req, res) => this.handleEvents(req, res));
    router.post(HOST_MESSAGE_PATH, (req, res) => this.handleMessage(req, res));
  }

  /** 发命令并等待扩展用 rpcResult 回应。id 由这里生成。 */
  request<T = unknown>(cmd: HostCommandInput, timeoutMs = this.rpcTimeoutMs): Promise<T> {
    if (!this.sse) return Promise.reject(new HostChannelError('not-connected', '无头浏览器页面未连接'));
    const id = randomUUID();
    const command = { ...cmd, id } as HostCommand;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostChannelError('timeout', `命令 ${cmd.type} 在 ${timeoutMs} 毫秒内没有响应`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.sse?.write(`data: ${JSON.stringify(command)}\n\n`);
    });
  }

  /** 关闭通道（exit 时调用）。 */
  close(): void {
    this.closeSse('plugin exit');
  }

  private checkNonce(given: unknown): boolean {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.nonceValue);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private handleEvents(req: Request, res: Response): void {
    if (!this.checkNonce(req.query.nonce)) {
      this.log.debug('host/events 被拒绝：nonce 不匹配');
      res.status(403).json({ error: 'invalid nonce' });
      return;
    }
    this.closeSse('replaced by new connection');
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    this.sse = res;
    this.lastSeenAt = Date.now();
    this.keepAlive = setInterval(() => res.write(': ping\n\n'), this.keepAliveMs);
    this.keepAlive.unref();
    this.log.debug('host SSE 已连接');
    this.emitConnection(true);
    req.on('close', () => {
      if (this.sse === res) {
        this.sse = null;
        this.stopKeepAlive();
        this.failPending('disconnected', '页面与插件的连接已断开');
        this.log.debug('host SSE 已断开');
        this.emitConnection(false);
      }
    });
  }

  private handleMessage(req: Request, res: Response): void {
    const upload = decodeHostUpload(req.body);
    if (!upload) {
      res.status(400).json({ error: 'invalid payload' });
      return;
    }
    if (!this.checkNonce(upload.nonce) || (upload.event.type === 'hello' && !this.checkNonce(upload.event.nonce))) {
      this.log.debug('host/message 被拒绝：nonce 不匹配');
      res.status(403).json({ error: 'invalid nonce' });
      return;
    }
    this.lastSeenAt = Date.now();
    const event = upload.event;
    if (event.type === 'rpcResult') {
      const p = this.pending.get(event.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(event.id);
        if (event.ok) p.resolve(event.result);
        else p.reject(new HostChannelError('remote-error', event.error ?? '扩展返回了错误'));
      } else {
        this.log.debug(`收到未知或已超时的 rpcResult：${event.id}`);
      }
    } else {
      if (event.type === 'hello') this.hello = event;
      for (const h of this.handlers) {
        try {
          h(event);
        } catch (e) {
          this.log.error(`host 事件处理器出错：${(e as Error).message}`);
        }
      }
    }
    res.json({ ok: true });
  }

  private closeSse(reason: string): void {
    const res = this.sse;
    this.sse = null;
    this.stopKeepAlive();
    if (res) {
      this.log.debug(`关闭 host SSE：${reason}`);
      res.end();
    }
    this.failPending('disconnected', `连接已关闭（${reason}）`);
    if (res) this.emitConnection(false);
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  private failPending(code: 'disconnected', message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new HostChannelError(code, message));
      this.pending.delete(id);
    }
  }
}
