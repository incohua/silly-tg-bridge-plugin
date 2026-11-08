// /chars、/chats 的分页按钮。纯函数。
// callback_data 上限 64 字节，所以按钮里只放 “操作|列表令牌|序号”，列表本身留在内存里（Bot.lists）。

import type { CharacterInfo, ChatInfo } from '../shared/protocol';

export const PAGE_SIZE = 8;
const LABEL_MAX = 48;

export type ListKind = 'chars' | 'chats' | 'presets';

export interface Listing {
  kind: ListKind;
  items: CharacterInfo[] | ChatInfo[] | string[];
  /** 当前角色的 avatar 或当前聊天名，用于标注。 */
  current?: string;
  createdAt: number;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type CallbackAction = { op: 'select' | 'page'; kind: ListKind; token: string; n: number };

const OPS: Record<string, { op: 'select' | 'page'; kind: ListKind }> = {
  c: { op: 'select', kind: 'chars' },
  cp: { op: 'page', kind: 'chars' },
  h: { op: 'select', kind: 'chats' },
  hp: { op: 'page', kind: 'chats' },
  p: { op: 'select', kind: 'presets' },
  pp: { op: 'page', kind: 'presets' },
};

export function encodeCallback(a: CallbackAction): string {
  const code = Object.entries(OPS).find(([, v]) => v.op === a.op && v.kind === a.kind)![0];
  return `${code}|${a.token}|${a.n}`;
}

export function decodeCallback(data: string | undefined): CallbackAction | null {
  if (!data) return null;
  const m = /^(c|cp|h|hp|p|pp)\|([0-9a-f]{1,16})\|(\d{1,6})$/.exec(data);
  if (!m) return null;
  return { ...OPS[m[1]], token: m[2], n: Number(m[3]) };
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

export function clampPage(page: number, total: number): number {
  return Math.min(Math.max(0, page), pageCount(total) - 1);
}

function truncate(s: string, max = LABEL_MAX): string {
  const cps = Array.from(s.replace(/\s+/g, ' ').trim());
  return cps.length > max ? cps.slice(0, max - 1).join('') + '…' : cps.join('');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 聊天按钮文字：日期、条数、最后一条的开头。 */
export function chatLabel(c: ChatInfo): string {
  const parts: string[] = [];
  if (c.lastMessageAt) {
    const d = new Date(c.lastMessageAt);
    parts.push(`${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
  }
  if (c.messageCount !== undefined) parts.push(`${c.messageCount} 条`);
  parts.push(c.preview || c.fileName);
  return truncate(parts.join(' · '));
}

export function itemLabel(l: Listing, i: number): string {
  if (l.kind === 'chars') {
    const c = (l.items as CharacterInfo[])[i];
    return truncate(`${c.avatar === l.current ? '✅ ' : ''}${c.name}`);
  }
  if (l.kind === 'presets') {
    const n = (l.items as string[])[i];
    return truncate(`${n === l.current ? '✅ ' : ''}${n}`);
  }
  const c = (l.items as ChatInfo[])[i];
  return truncate(`${c.fileName === l.current ? '✅ ' : ''}${chatLabel(c)}`);
}

export function listTitle(l: Listing, page: number): string {
  const what = l.kind === 'chars' ? '角色' : l.kind === 'presets' ? '预设' : '聊天';
  const total = l.items.length;
  if (total === 0) return l.kind === 'chars' ? '📭 ST 里还没有角色。' : l.kind === 'presets' ? '📭 当前 API 还没有预设。' : '📭 当前角色还没有聊天记录。';
  const icon = l.kind === 'chars' ? '🎭' : l.kind === 'presets' ? '🎛️' : '💬';
  return `${icon} 选择${what}（共 ${total} 个，第 ${page + 1}/${pageCount(total)} 页）${l.current ? '\n✅ 表示当前正在用的' : ''}`;
}

/** 某一页的内联键盘：每项一行，最后一行是翻页。 */
export function listKeyboard(l: Listing, token: string, page: number): InlineButton[][] {
  const total = l.items.length;
  const p = clampPage(page, total);
  const rows: InlineButton[][] = [];
  for (let i = p * PAGE_SIZE; i < Math.min(total, (p + 1) * PAGE_SIZE); i++) {
    rows.push([{ text: itemLabel(l, i), callback_data: encodeCallback({ op: 'select', kind: l.kind, token, n: i }) }]);
  }
  if (pageCount(total) > 1) {
    const nav: InlineButton[] = [];
    if (p > 0) nav.push({ text: '⬅️ 上一页', callback_data: encodeCallback({ op: 'page', kind: l.kind, token, n: p - 1 }) });
    if (p < pageCount(total) - 1) nav.push({ text: '下一页 ➡️', callback_data: encodeCallback({ op: 'page', kind: l.kind, token, n: p + 1 }) });
    rows.push(nav);
  }
  return rows;
}
