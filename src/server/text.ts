// 纯文本处理：流式草稿预览、按 sendMessage 上限切分。纯函数。
// 正式消息的 Rich Message 转换和分段在 src/shared/rich-html.ts；splitPlainText 只用于最后一级回退
// （deliver.ts：rich 和 toPlainTexts 都发送失败时，按 UTF-16 码元切分扩展上报的 innerText）。

/** sendMessage / sendMessageDraft 的 text 上限（Telegram 按 UTF-16 码元计数）。 */
export const TELEGRAM_TEXT_LIMIT = 4096;

export const CARD_PLACEHOLDER = '［正在生成卡片…］';

/**
 * 把 ST 流式事件给出的累计原文变成草稿预览：
 * - 代码块（含还没写完的最后一个）替换成占位文字，卡片源码不会刷屏；
 * - 去掉 HTML 标签和注释（含没闭合的尾部标签）；
 * - 超长时保留尾部，开头加省略号。
 */
export function streamPreview(raw: string, limit = TELEGRAM_TEXT_LIMIT): string {
  let s = raw.replace(/\r\n?/g, '\n');
  // 闭合的代码块
  s = s.replace(/```[\s\S]*?```/g, CARD_PLACEHOLDER);
  // 没闭合的代码块（还在生成）
  const open = s.indexOf('```');
  if (open >= 0) s = s.slice(0, open) + CARD_PLACEHOLDER;
  // HTML 注释、标签，以及末尾没写完的标签
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, '');
  s = s.replace(/<\/?[A-Za-z][^<>]*>/g, '');
  s = s.replace(/<\/?[A-Za-z][^<>]*$/, '');
  // 合并连续占位符和多余空行
  s = s.split(CARD_PLACEHOLDER + CARD_PLACEHOLDER).join(CARD_PLACEHOLDER);
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > limit) s = '…' + safeSlice(s, s.length - (limit - 1));
  return s;
}

/** 从 start 开始截取，不切开代理对。 */
function safeSlice(s: string, start: number, end?: number): string {
  let a = start;
  if (a > 0 && a < s.length && isLowSurrogate(s.charCodeAt(a))) a++;
  let b = end ?? s.length;
  if (b < s.length && b > 0 && isLowSurrogate(s.charCodeAt(b))) b--;
  return s.slice(a, b);
}

const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * 把纯文本切成每段不超过 limit 的片段，内容不丢、不重排。
 * 优先在空行处切，其次换行、空白，最后硬切（不切开代理对）。
 * 片段首尾的空白会去掉；全是空白时返回空数组。
 */
export function splitPlainText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = -1;
    for (const sep of ['\n\n', '\n', ' ', '。', '，']) {
      const i = window.lastIndexOf(sep);
      // 太靠前的切点会产生很碎的片段，至少保留一半长度
      if (i >= limit / 2) {
        cut = sep.trim() === '' ? i : i + sep.length;
        break;
      }
    }
    if (cut <= 0 || cut > limit) cut = limit;
    let piece = safeSlice(rest, 0, cut);
    if (piece.length === 0) piece = rest.slice(0, limit);
    out.push(piece.trimEnd());
    rest = rest.slice(piece.length).trimStart();
  }
  if (rest) out.push(rest);
  return out.filter((p) => p.length > 0);
}
