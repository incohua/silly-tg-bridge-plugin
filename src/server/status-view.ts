// /status 消息的排版：加粗分组标题 + 每组一个等宽块（键值按显示宽度对齐），有问题时在最上面列出。
// 只负责把已收集好的数据排成 Telegram HTML（parse_mode: 'HTML'）或纯文本（HTML 发送失败时的回退），不读任何运行状态。

/** ok ●、off ○（未启动，按需会自动启动）、busy ◐（启动 / 关闭中）、bad ✗。 */
export type StatusMark = 'ok' | 'off' | 'busy' | 'bad';

export interface StatusRow {
  label: string;
  value: string;
  mark?: StatusMark;
}

export interface StatusSection {
  title: string;
  rows: StatusRow[];
}

export interface StatusIssue {
  level: 'error' | 'warn';
  text: string;
}

export interface StatusView {
  issues: StatusIssue[];
  sections: StatusSection[];
  /** 最近一次页面错误，原样显示在末尾。 */
  lastError?: string;
}

const MARKS: Record<StatusMark, string> = { ok: '●', off: '○', busy: '◐', bad: '✗' };
const LABEL_WIDTH = 8;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 等宽字体里的显示宽度：CJK、全角字符算 2 列。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1;
  }
  return w;
}

/** 用量条，例如 [█████░░░░]。 */
export function meter(used: number, limit: number, cells = 9): string {
  const filled = limit > 0 ? Math.min(cells, Math.max(0, Math.round((used / limit) * cells))) : 0;
  return `[${'█'.repeat(filled)}${'░'.repeat(cells - filled)}]`;
}

function rowText(r: StatusRow): string {
  const pad = ' '.repeat(Math.max(1, LABEL_WIDTH - displayWidth(r.label)));
  return `${r.label}${pad}${r.mark ? `${MARKS[r.mark]} ` : ''}${r.value}`;
}

function statusHeadline(v: StatusView): string {
  return v.issues.length === 0 ? '📊 silly-tg  ✅' : `📊 silly-tg  ⚠️ ${v.issues.length}`;
}

function issueText(i: StatusIssue): string {
  return `${i.level === 'error' ? '🔴' : '🟡'} ${i.text}`;
}

export function renderStatusHtml(v: StatusView): string {
  let html = `<b>${statusHeadline(v)}</b>\n`;
  if (v.issues.length > 0) html += `\n${v.issues.map((i) => escapeHtml(issueText(i))).join('\n')}\n`;
  // <pre> 本身就是块，后面只跟一个换行，否则客户端会多出一行空白
  for (const s of v.sections) {
    if (s.rows.length === 0) continue;
    html += `\n<b>${escapeHtml(s.title)}</b>\n<pre>${s.rows.map((r) => escapeHtml(rowText(r))).join('\n')}</pre>`;
  }
  if (v.lastError) html += `\n🐞 <code>${escapeHtml(v.lastError)}</code>`;
  return html;
}

export function renderStatusPlain(v: StatusView): string {
  const out = [statusHeadline(v)];
  if (v.issues.length > 0) out.push('', ...v.issues.map(issueText));
  for (const s of v.sections) {
    if (s.rows.length === 0) continue;
    out.push('', s.title, ...s.rows.map((r) => `  ${rowText(r)}`));
  }
  if (v.lastError) out.push('', `🐞 ${v.lastError}`);
  return out.join('\n');
}
