import type { FetchLike } from './http';
import type { Logger } from './logger';
import { redact } from './redact';

const API_ROOT = 'https://api.telegram.org';

/** Bot API 返回 ok=false。 */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} 失败：${errorCode} ${description}`);
    this.name = 'TelegramApiError';
  }
}

/** 网络层失败（DNS、连接、超时、响应不是 JSON）。message 已脱敏，不保留原始 cause。 */
export class TelegramNetworkError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`Telegram ${method} 网络错误：${message}`);
    this.name = 'TelegramNetworkError';
  }
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  date?: number;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  /** Bot API 10.3：用户点了草稿上的停止按钮（sendMessageDraft 的 can_stop）。没有 from，只有 chat。 */
  stopped_message_generation?: { chat: { id: number; type: string }; message_thread_id?: number; draft_id: number | string };
  // 实测（2026-11-08）：Telegram 回传的 draft_id 是字符串（"276010980"），发送时是数字，比较前要统一类型。
  [key: string]: unknown;
}

export interface CallOptions {
  /** 遇到 429 时是否按 retry_after 重试，默认 true。草稿这类可丢弃的请求传 false。 */
  retry?: boolean;
  signal?: AbortSignal;
  /** 单次请求超时（毫秒），默认 30000。 */
  timeoutMs?: number;
}

export interface TelegramClientOptions {
  token: string;
  fetch: FetchLike;
  log: Logger;
  /** 额外脱敏字符串（代理凭据等）。 */
  secrets?: readonly string[];
  apiRoot?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 429 最多重试次数，默认 5。 */
  maxRetries?: number;
}

export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** 基于 fetch 的 Bot API 薄封装。所有对外抛出的错误都已脱敏，且不带 cause。 */
export class TelegramClient {
  private readonly token: string;
  private readonly secrets: string[];
  private readonly fetchImpl: FetchLike;
  private readonly log: Logger;
  private readonly apiRoot: string;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxRetries: number;

  constructor(opts: TelegramClientOptions) {
    this.token = opts.token;
    this.secrets = [opts.token, ...(opts.secrets ?? [])];
    this.fetchImpl = opts.fetch;
    this.log = opts.log;
    this.apiRoot = opts.apiRoot ?? API_ROOT;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 5;
  }

  /** 通用调用。其他方法都基于它；Bot API 新增的方法（如 sendRichMessage）直接用这个。 */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    const retry = opts.retry ?? true;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce<T>(method, params, opts);
      } catch (e) {
        const canRetry = retry && e instanceof TelegramApiError && e.errorCode === 429 && attempt < this.maxRetries && !opts.signal?.aborted;
        if (!canRetry) throw e;
        const waitSec = (e as TelegramApiError).retryAfter ?? 1;
        this.log.warn(`${method} 被限流，${waitSec} 秒后重试（第 ${attempt + 1} 次）`);
        await this.sleep(waitSec * 1000 + 100, opts.signal);
      }
    }
  }

  private async callOnce<T>(method: string, params: Record<string, unknown>, opts: CallOptions): Promise<T> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    let body: unknown;
    try {
      res = await this.fetchImpl(`${this.apiRoot}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal,
      });
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`响应不是 JSON（HTTP ${res.status}）`);
      }
    } catch (e) {
      // 不保留 cause：fetch 的错误可能带着含 token 的 URL。
      const reason = signal.aborted ? (opts.signal?.aborted ? '请求被取消' : '请求超时') : e instanceof Error ? e.message : String(e);
      throw new TelegramNetworkError(method, redact(reason, this.secrets));
    }
    const r = body as { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (r.ok === true) return r.result as T;
    throw new TelegramApiError(
      method,
      r.error_code ?? res.status,
      redact(r.description ?? 'unknown error', this.secrets),
      r.parameters?.retry_after,
    );
  }

  getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {}, { signal });
  }

  getUpdates(
    params: { offset?: number; timeout?: number; limit?: number; allowed_updates?: string[] },
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    // 长轮询服务器端最多挂 timeout 秒，客户端超时要比它长。
    return this.call<TelegramUpdate[]>('getUpdates', params, { signal, timeoutMs: ((params.timeout ?? 0) + 15) * 1000 });
  }

  sendMessage(params: { chat_id: number; text: string; [k: string]: unknown }, opts?: CallOptions): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', params, opts);
  }

  editMessageText(params: { chat_id: number; message_id: number; text: string; [k: string]: unknown }, opts?: CallOptions): Promise<unknown> {
    return this.call('editMessageText', params, opts);
  }

  deleteMessage(chat_id: number, message_id: number, opts?: CallOptions): Promise<boolean> {
    return this.call<boolean>('deleteMessage', { chat_id, message_id }, opts);
  }

  sendChatAction(chat_id: number, action: string, opts?: CallOptions): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id, action }, { retry: false, ...opts });
  }

  answerCallbackQuery(params: { callback_query_id: string; text?: string }, opts?: CallOptions): Promise<boolean> {
    return this.call<boolean>('answerCallbackQuery', params, opts);
  }

  /** 注册命令菜单（用户在输入框输入 / 时显示）。 */
  setMyCommands(commands: Array<{ command: string; description: string }>, opts?: CallOptions): Promise<boolean> {
    return this.call<boolean>('setMyCommands', { commands }, opts);
  }
}

export interface PollOptions {
  client: TelegramClient;
  onUpdate: (update: TelegramUpdate) => Promise<void> | void;
  signal: AbortSignal;
  log: Logger;
  /** 长轮询秒数，默认 30。 */
  timeoutSec?: number;
  allowedUpdates?: string[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 退避范围（毫秒），默认 1s 到 30s。 */
  backoffMs?: { min: number; max: number };
}

/**
 * 长轮询循环，直到 signal 触发或 token 被拒绝（401）。
 * 单个 update 的处理失败只记日志，不影响后续；网络和 5xx 类错误指数退避。
 * 返回停止原因。
 */
export async function pollUpdates(opts: PollOptions): Promise<'aborted' | 'unauthorized'> {
  const { client, onUpdate, signal, log } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const { min, max } = opts.backoffMs ?? { min: 1000, max: 30_000 };
  let offset: number | undefined;
  let delay = min;

  while (!signal.aborted) {
    let updates: TelegramUpdate[];
    try {
      updates = await client.getUpdates({ offset, timeout: opts.timeoutSec ?? 30, allowed_updates: opts.allowedUpdates }, signal);
      delay = min;
    } catch (e) {
      if (signal.aborted) break;
      if (e instanceof TelegramApiError && e.errorCode === 401) {
        log.error('Telegram 拒绝了 botToken（401），轮询已停止。在 ST 扩展设置栏的 Silly TG 面板里改好 botToken 并保存即可，无需重启 ST（直接改 config.json 的话要重启 ST 才会重新读取）。');
        return 'unauthorized';
      }
      if (e instanceof TelegramApiError && e.errorCode === 409) {
        log.warn('Telegram 返回 409：同一个 bot 在别处也在轮询（或设置了 webhook）。确认没有第二个 ST 实例或旧的桥接程序在运行。');
      } else {
        log.warn(`getUpdates 失败，${Math.round(delay / 1000)} 秒后重试：${(e as Error).message}`);
      }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, max);
      continue;
    }
    for (const update of updates) {
      // 先推进 offset，避免某条消息的处理一直抛错而被反复拉取。
      offset = update.update_id + 1;
      log.debug(`拉到 update ${update.update_id}：${Object.keys(update).filter((k) => k !== 'update_id').join(',')}`);
      try {
        await onUpdate(update);
      } catch (e) {
        log.error(`处理 update ${update.update_id} 出错：${(e as Error).message}`);
      }
    }
  }
  return 'aborted';
}
