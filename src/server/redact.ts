// 日志与错误信息脱敏。bot token 出现在 Bot API 的 URL 里（/bot<token>/method），
// fetch 的错误对象、堆栈、cause 都可能带着它，所以所有输出日志的路径都要经过这里。

/** Telegram bot token 的形态：数字 id、冒号、一段 base64url 字符。 */
const TOKEN_PATTERN = /\d{5,}:[A-Za-z0-9_-]{30,}/g;
const REDACTED = '***';

/** 脱敏文本：既替换已知的秘密字符串，也替换形似 bot token 的内容。 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join(REDACTED);
  }
  return out.replace(TOKEN_PATTERN, REDACTED);
}

/** 把任意值转成脱敏后的字符串，Error 会带上堆栈和 cause 链。 */
export function redactError(err: unknown, secrets: readonly string[] = []): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== undefined && !seen.has(cur) && parts.length < 5) {
    seen.add(cur);
    if (cur instanceof Error) {
      parts.push(cur.stack ?? `${cur.name}: ${cur.message}`);
      cur = cur.cause;
    } else {
      parts.push(typeof cur === 'string' ? cur : safeStringify(cur));
      break;
    }
  }
  return redact(parts.join('\ncaused by: '), secrets);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
