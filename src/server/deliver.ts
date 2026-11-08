// 正式消息发送：Rich Message 优先，逐级回退，目标是任何情况下都不丢内容。
//
// 1. toRichMessages(html) 分段，逐段 sendRichMessage({chat_id, rich_message: {html}})。
// 2. 某段 rich 发送失败（400 等，或 429 重试用尽）：从这一段起改用纯文本，
//    对剩余各段的 html 用 toPlainTexts 分段，逐段 sendMessage。
// 3. 纯文本仍然失败：一条都还没发出时，改用扩展上报的 innerText（messageFinal.text）按 splitPlainText 分段；
//    已经发出过一部分时，对剩余片段再用 splitPlainText 规整后重试一次（避免把已发内容重发一遍）。
// 429 由 TelegramClient 按 retry_after 重试，这里看到的都是重试后的最终结果。
// html 转换没有可见内容时返回空数组：text 也为空就不发消息；text 不为空（取不到渲染节点等）就直接发 text。

import { toPlainTexts, toRichMessages, type DialogueStyle } from '../shared/rich-html';
import type { Logger } from './logger';
import type { CallOptions, TelegramMessage } from './telegram';
import { splitPlainText } from './text';

export interface DeliverTelegram {
  call<T = unknown>(method: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<T>;
  sendMessage(params: { chat_id: number; text: string; [k: string]: unknown }, opts?: CallOptions): Promise<TelegramMessage>;
}

export const STOPPED_SUFFIX = '（⏹️ 已停止生成）';

export interface DeliverResult {
  /** 发出的每一段消息的 message_id，按发送顺序。步骤 10 的消息映射用。 */
  messageIds: number[];
  /** 实际用到的方式。'none' 表示没有内容、没有发送。 */
  via: 'rich' | 'plain' | 'text' | 'mixed' | 'none';
  /** 有内容没能发出去。 */
  incomplete: boolean;
}

export async function deliverFinal(opts: {
  telegram: DeliverTelegram;
  log: Logger;
  chatId: number;
  html: string;
  text: string;
  stopped: boolean;
  dialogueStyle?: DialogueStyle;
}): Promise<DeliverResult> {
  const { telegram, log, chatId } = opts;
  const html = opts.stopped ? `${opts.html}<p>${STOPPED_SUFFIX}</p>` : opts.html;
  const text = opts.stopped ? `${opts.text.trimEnd()}\n\n${STOPPED_SUFFIX}` : opts.text;
  const ids: number[] = [];
  const used = new Set<'rich' | 'plain' | 'text'>();
  const result = (incomplete: boolean): DeliverResult => ({
    messageIds: ids,
    via: used.size === 0 ? 'none' : used.size > 1 ? 'mixed' : [...used][0],
    incomplete,
  });

  const sendPlain = async (pieces: string[], kind: 'plain' | 'text'): Promise<number> => {
    for (let i = 0; i < pieces.length; i++) {
      if (!pieces[i].trim()) continue;
      try {
        const m = await telegram.sendMessage({ chat_id: chatId, text: pieces[i] });
        ids.push(m.message_id);
        used.add(kind);
      } catch (e) {
        log.warn(`纯文本分段发送失败（第 ${i + 1}/${pieces.length} 段）：${(e as Error).message}`);
        return i;
      }
    }
    return -1;
  };

  // 前端卡片源码（酒馆助手判定的 <body>/<html> 代码块）在 Telegram 里没有意义，先移除；
  // card-render 任务上线后，改为用截图或 Mini App 展示。
  let droppedCard = false;
  const parts = toRichMessages(html, {
    dialogueStyle: opts.dialogueStyle,
    onPre: ({ isCard }) => {
      if (!isCard) return 'keep';
      droppedCard = true;
      return 'drop';
    },
  });
  if (droppedCard) log.info('已从正文移除前端卡片源码（暂不支持渲染）');
  if (parts.length === 0) {
    if (droppedCard) {
      log.info('正文只有前端卡片，没有可发送的文字，不发送正式消息');
      return result(false);
    }
    if (!text.trim()) {
      log.info('回复没有可见内容，不发送正式消息');
      return result(false);
    }
    log.warn('渲染结果转换后为空，但纯文本不为空，改发纯文本');
    return result((await sendPlain(splitPlainText(text), 'text')) >= 0);
  }

  // 1. Rich Message
  let failedAt = -1;
  for (let i = 0; i < parts.length; i++) {
    try {
      const m = await telegram.call<TelegramMessage>('sendRichMessage', { chat_id: chatId, rich_message: { html: parts[i].html } });
      ids.push(m.message_id);
      used.add('rich');
    } catch (e) {
      log.warn(`sendRichMessage 失败（第 ${i + 1}/${parts.length} 段），改用纯文本：${(e as Error).message}`);
      failedAt = i;
      break;
    }
  }
  if (failedAt < 0) return result(false);

  // 2. 剩余各段的 html 转纯文本
  const rest = parts.slice(failedAt);
  const plainPieces = rest.flatMap((p) => toPlainTexts(p.html));
  const plainFailed = await sendPlain(plainPieces, 'plain');
  if (plainFailed < 0) return result(false);

  // 3. 最后一级
  const nothingSent = ids.length === 0;
  const last = nothingSent ? splitPlainText(text) : plainPieces.slice(plainFailed).flatMap((p) => splitPlainText(p));
  log.warn(nothingSent ? '纯文本回退仍失败，改用页面 innerText 重发' : '纯文本回退仍失败，规整剩余片段后重试');
  return result((await sendPlain(last, 'text')) >= 0);
}
