// send / regenerate 命令：触发生成，上报流式文本和最终渲染结果。
//
// regenerate：核对当前聊天和最后一条消息与服务端记录一致后，调用 context.generate('regenerate')
// （ST 会删掉最后一条回复再生成），新回复的下标就是原来那条的下标。
//
// 触发方式：把文字放进 #send_textarea 再调用 context.generate('normal')，与用户点发送按钮走同一路径
// （宏、偏置、附件处理都一致）。没有用 /send 拼接 slash 命令，因为用户文字里的 |、{: 等会被 slash 解析器当成语法。
// generate() 在流式时会等生成结束才返回，相当于 /trigger await=true（spike 调整 5）。
// 注意：以 / 开头的文字会被 ST 当成 slash 命令执行，所以在这里拒绝。

import type { HostEvent } from '../shared/protocol';
import { ctx } from './adapter';
import type { JQueryLike } from './st-types';

/** 流式文本上行的最小间隔。服务端还会再节流成约每秒一次草稿。 */
const STREAM_UPLOAD_INTERVAL_MS = 400;

let generating = false;
/** 生成期间 toastr.error / warning 的内容，生成失败时作为原因上报。 */
let toastLog: string[] | null = null;

export const isGenerating = (): boolean => generating;

/** 由 index.ts 在启动时调用一次：记录生成期间的 toastr 错误。 */
export function captureToasts(): void {
  const t = (globalThis as unknown as { toastr?: Record<string, (...a: unknown[]) => unknown> }).toastr;
  if (!t) return;
  for (const level of ['error', 'warning']) {
    const orig = t[level];
    if (typeof orig !== 'function') continue;
    t[level] = function (this: unknown, ...args: unknown[]) {
      if (toastLog) toastLog.push(args.filter((a) => typeof a === 'string').join(' ').slice(0, 300));
      return orig.apply(this, args);
    };
  }
}

export type GenerationRequest =
  | { kind: 'send'; text: string }
  /** chatId、messageId：服务端记录的上一条回复。 */
  | { kind: 'regenerate'; chatId: string; messageId: number };

export interface GenerationOptions {
  generationId: string;
  request: GenerationRequest;
  report: (event: HostEvent) => void;
  /** 生成已经开始时调用，index.ts 据此回 rpcResult。 */
  onStarted: () => void;
}

/** regenerate 的前置核对。纯函数，返回拒绝原因，通过时返回 null。 */
export function regenerateRejection(
  current: { chatId: string | undefined; chat: Array<{ is_user?: boolean; is_system?: boolean }> },
  expected: { chatId: string; messageId: number },
): string | null {
  if (current.chatId !== expected.chatId) return 'ST 当前打开的不是上一条回复所在的聊天（可能已切换聊天），无法重新生成';
  const last = current.chat.length - 1;
  if (last !== expected.messageId) return '上一条回复已不是聊天里的最后一条（之后又有新消息或被删除），无法重新生成';
  const m = current.chat[last];
  if (!m || m.is_user || m.is_system) return '聊天里的最后一条不是角色回复，无法重新生成';
  return null;
}

const hasChat = (c: ReturnType<typeof ctx>): boolean => (c.characterId !== undefined && c.characterId !== null) || !!c.groupId;

/** 在串行队列里执行。开始前的错误（没选角色、核对失败等）直接抛出，由调用方作为 rpc 错误返回。 */
export async function runGeneration(opts: GenerationOptions): Promise<void> {
  const { generationId, report, request } = opts;
  const c = ctx();
  if (!hasChat(c)) throw new Error('ST 当前没有打开任何角色的聊天，请先发 /chars 选择角色');
  let textarea: ReturnType<JQueryLike> | null = null;
  let minIndex: number;
  if (request.kind === 'send') {
    if (request.text.trimStart().startsWith('/')) throw new Error('以 / 开头的文字会被 ST 当作 slash 命令，已拒绝');
    const $ = (globalThis as unknown as { $: JQueryLike }).$;
    textarea = $('#send_textarea');
    if (!textarea.length || !textarea[0]) throw new Error('找不到 #send_textarea，ST 页面结构可能已变化');
    // 用户消息写在 chat.length，回复在它之后
    minIndex = c.chat.length;
  } else {
    const why = regenerateRejection({ chatId: c.getCurrentChatId(), chat: c.chat }, request);
    if (why) throw new Error(why);
    minIndex = request.messageId;
  }

  const { eventSource, eventTypes } = c;
  let stopped = false;
  let latest: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    if (latest !== null) report({ type: 'streamText', generationId, text: latest });
    latest = null;
  };
  const onToken = (...args: unknown[]): void => {
    if (typeof args[0] !== 'string') return;
    latest = args[0];
    if (!timer) timer = setTimeout(flush, STREAM_UPLOAD_INTERVAL_MS);
  };
  const onStopped = (): void => void (stopped = true);

  generating = true;
  toastLog = [];
  eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, onToken);
  eventSource.on(eventTypes.GENERATION_STOPPED, onStopped);
  let error: unknown;
  try {
    if (request.kind === 'send' && textarea) {
      textarea.val(request.text);
      textarea[0]?.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // 从这里开始，任何错误都以 generationFailed 事件上报，而不是 rpc 错误。
    opts.onStarted();
    await c.generate(request.kind === 'send' ? 'normal' : 'regenerate');
  } catch (e) {
    error = e;
  } finally {
    eventSource.removeListener(eventTypes.STREAM_TOKEN_RECEIVED, onToken);
    eventSource.removeListener(eventTypes.GENERATION_STOPPED, onStopped);
    if (timer) clearTimeout(timer);
    timer = null;
    latest = null;
    generating = false;
  }
  const toasts = toastLog ?? [];
  toastLog = null;

  // CHARACTER_MESSAGE_RENDERED 在 generate 返回前已经 await 过；再让出一次，等 DOM 和正则更新完。
  await new Promise((r) => setTimeout(r, 50));

  const after = ctx();
  const index = after.chat.length - 1;
  const msg = after.chat[index];
  if (index >= minIndex && msg && !msg.is_user && !msg.is_system) {
    const node = document.querySelector<HTMLElement>(`#chat .mes[mesid="${index}"] .mes_text`);
    report({
      type: 'messageFinal',
      generationId,
      chatId: after.getCurrentChatId() ?? '',
      messageId: index,
      html: node?.innerHTML ?? '',
      text: node ? node.innerText : (msg.mes ?? ''),
      raw: msg.mes ?? '',
      stopped,
      cards: [],
    });
    return;
  }
  if (stopped) {
    report({ type: 'generationStopped', generationId });
    return;
  }
  const reason = toasts.filter(Boolean).join('；') || (error instanceof Error ? error.message : error ? String(error) : '') || '没有生成新的回复';
  report({ type: 'generationFailed', generationId, reason: reason.slice(0, 500) });
}
