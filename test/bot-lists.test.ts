import { describe, expect, it } from 'vitest';
import { chatLabel, decodeCallback, encodeCallback, listKeyboard, listTitle, PAGE_SIZE, type Listing } from '../src/server/bot-lists';

const chars = (n: number): Listing => ({ kind: 'chars', items: Array.from({ length: n }, (_, i) => ({ avatar: `a${i}.png`, name: `名${i}` })), createdAt: 0 });

describe('bot-lists', () => {
  it('callback_data 编解码，且不超过 64 字节', () => {
    const d = encodeCallback({ op: 'select', kind: 'chats', token: 'deadbeef', n: 123 });
    expect(d).toBe('h|deadbeef|123');
    expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(64);
    expect(decodeCallback(d)).toEqual({ op: 'select', kind: 'chats', token: 'deadbeef', n: 123 });
    expect(decodeCallback('cp|ab|2')).toEqual({ op: 'page', kind: 'chars', token: 'ab', n: 2 });
    expect(decodeCallback('x|ab|2')).toBeNull();
    expect(decodeCallback('c|ZZ|2')).toBeNull();
    expect(decodeCallback(undefined)).toBeNull();
  });
  it('分页：每页 8 项，首页只有下一页，末页只有上一页，越界取最近一页', () => {
    const l = chars(20);
    const p0 = listKeyboard(l, 't', 0);
    expect(p0).toHaveLength(PAGE_SIZE + 1);
    expect(p0.at(-1)!.map((b) => b.text)).toEqual(['下一页 ›']);
    const p1 = listKeyboard(l, 't', 1);
    expect(p1.at(-1)!.map((b) => b.text)).toEqual(['‹ 上一页', '下一页 ›']);
    const last = listKeyboard(l, 't', 99);
    expect(last.map((r) => r[0].text)).toEqual(['名16', '名17', '名18', '名19', '‹ 上一页']);
    expect(listKeyboard(chars(3), 't', 0)).toHaveLength(3);
    expect(listTitle(l, 1)).toBe('选择角色（共 20 个，第 2/3 页）');
    expect(listTitle(chars(0), 0)).toMatch(/还没有角色/);
  });
  it('按钮文字过长时截断', () => {
    const l: Listing = { kind: 'chars', items: [{ avatar: 'a', name: '长'.repeat(100) }], current: 'a', createdAt: 0 };
    const label = listKeyboard(l, 't', 0)[0][0].text;
    expect(Array.from(label).length).toBeLessThanOrEqual(48);
    expect(label.startsWith('[当前] ')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
  });
  it('聊天标签：日期 · 条数 · 预览；没有预览时用文件名', () => {
    expect(chatLabel({ fileName: 'F', lastMessageAt: new Date(2026, 10, 7, 9, 5).getTime(), messageCount: 2, preview: '你好' })).toBe('11-07 09:05 · 2 条 · 你好');
    expect(chatLabel({ fileName: 'F' })).toBe('F');
  });
});
