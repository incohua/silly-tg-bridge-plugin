import { describe, expect, it } from 'vitest';
import { detectApp, getHostApi, isKnownNoise, isReadyConsoleLine } from '../src/extension/adapter';
import { parseHostNonce, parseHostTestFlags } from '../src/extension/host-mode';
import { SerialQueue } from '../src/extension/queue';
import { activeCharacterFromSettingsResponse } from '../src/extension/restore';
import { isGreetingOnly, normalizeChats } from '../src/extension/commands';
import { regenerateRejection } from '../src/extension/generation';
import { recheckUntilOk } from '../src/extension/retry';

const NONCE = '0123456789abcdef0123456789abcdef';

describe('parseHostNonce（host 模式判定）', () => {
  it('普通 ST 页面没有标记：不是 host', () => {
    expect(parseHostNonce('')).toBeNull();
    expect(parseHostNonce('#foo=bar')).toBeNull();
  });
  it('hash 带合法 nonce：返回 nonce', () => {
    expect(parseHostNonce(`#silly_tg_host=${NONCE}`)).toBe(NONCE);
    expect(parseHostNonce(`#a=1&silly_tg_host=${NONCE}`)).toBe(NONCE);
  });
  it('格式不对的 nonce 不算 host（spike 用过的 probe 之类）', () => {
    expect(parseHostNonce('#silly_tg_host=probe')).toBeNull();
    expect(parseHostNonce(`#silly_tg_host=${NONCE.toUpperCase()}`)).toBeNull();
    expect(parseHostNonce(`#silly_tg_host=${NONCE}0`)).toBeNull();
    expect(parseHostNonce('#silly_tg_host=')).toBeNull();
  });
});

describe('parseHostTestFlags', () => {
  it('只有显式标记才跳过 CSRF 补丁', () => {
    expect(parseHostTestFlags(`#silly_tg_host=${NONCE}`)).toEqual({ skipCsrfPatch: false });
    expect(parseHostTestFlags(`#silly_tg_host=${NONCE}&silly_tg_test_skip_csrf_patch=1`)).toEqual({ skipCsrfPatch: true });
    expect(parseHostTestFlags(`#silly_tg_host=${NONCE}&silly_tg_test_skip_csrf_patch=true`)).toEqual({ skipCsrfPatch: false });
    // nonce 判定不受测试标记影响
    expect(parseHostNonce(`#silly_tg_host=${NONCE}&silly_tg_test_skip_csrf_patch=1`)).toBe(NONCE);
  });
});

describe('SerialQueue', () => {
  it('任务一个接一个执行，不重叠', async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const task = (name: string, ms: number) => () =>
      new Promise<string>((r) => {
        log.push(`start ${name}`);
        setTimeout(() => {
          log.push(`end ${name}`);
          r(name);
        }, ms);
      });
    const results = await Promise.all([q.run(task('a', 20)), q.run(task('b', 5)), q.run(task('c', 1))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(q.size).toBe(0);
  });
  it('前一个失败不影响后一个，错误返回给自己的调用方', async () => {
    const q = new SerialQueue();
    const a = q.run(() => {
      throw new Error('boom');
    });
    const b = q.run(() => 2);
    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe(2);
  });
  it('size 反映排队数', async () => {
    const q = new SerialQueue();
    let release!: () => void;
    const p = q.run(() => new Promise<void>((r) => (release = r)));
    void q.run(() => undefined);
    expect(q.size).toBe(2);
    await new Promise((r) => setTimeout(r, 0));
    release();
    await p;
    await new Promise((r) => setTimeout(r, 0));
    expect(q.size).toBe(0);
  });
});

describe('adapter', () => {
  it('入口：Luker 优先，否则 SillyTavern', () => {
    const st = { getContext: () => ({}) };
    const luker = { getContext: () => ({}) };
    expect(getHostApi({ SillyTavern: st })).toBe(st);
    expect(getHostApi({ SillyTavern: st, Luker: luker })).toBe(luker);
    expect(getHostApi({})).toBeUndefined();
    expect(detectApp({ SillyTavern: st })).toBe('st');
    expect(detectApp({ Luker: luker })).toBe('luker');
  });
  it('就绪日志：ST 与 Luker 两种写法都认', () => {
    expect(isReadyConsoleLine('Event emitted: app_ready')).toBe(true);
    expect(isReadyConsoleLine('[init] firstLoadInit complete')).toBe(true);
    expect(isReadyConsoleLine('Event emitted: chat_id_changed')).toBe(false);
  });
  it('错误忽略清单：Luker 首次加载噪音', () => {
    expect(isKnownNoise({ kind: 'http', status: 500, url: 'http://127.0.0.1:8001/api/sd/comfy/models' })).toBe(true);
    expect(isKnownNoise({ kind: 'http', status: 404, url: 'http://x/api/worldinfo/get?name=__SEARCH_TOOLS__' })).toBe(true);
    expect(isKnownNoise({ kind: 'error', message: "cannot call methods on autocomplete prior to initialization; attempted to call method 'instance'" })).toBe(true);
  });
  it('错误忽略清单：真正的错误不被忽略', () => {
    expect(isKnownNoise({ kind: 'http', status: 403, url: 'http://x/api/tokenizers/openai/count' })).toBe(false);
    expect(isKnownNoise({ kind: 'http', status: 500, url: 'http://x/api/backends/chat-completions/generate' })).toBe(false);
    expect(isKnownNoise({ kind: 'error', message: 'TypeError: x is undefined' })).toBe(false);
  });
});

describe('activeCharacterFromSettingsResponse', () => {
  it('ST：settings 是 JSON 字符串', () => {
    expect(activeCharacterFromSettingsResponse({ settings: JSON.stringify({ active_character: 'default_Seraphina.png' }) })).toBe('default_Seraphina.png');
  });
  it('settings 已是对象也能读', () => {
    expect(activeCharacterFromSettingsResponse({ settings: { active_character: 'a.png' } })).toBe('a.png');
  });
  it('没有记录、为空或格式错误返回 null', () => {
    expect(activeCharacterFromSettingsResponse({ settings: JSON.stringify({ active_character: null }) })).toBeNull();
    expect(activeCharacterFromSettingsResponse({ settings: '{bad' })).toBeNull();
    expect(activeCharacterFromSettingsResponse(null)).toBeNull();
  });
});

describe('regenerateRejection', () => {
  const chat = [{ is_user: false }, { is_user: true }, { is_user: false }];
  it('同一聊天、最后一条是那条回复：通过', () => {
    expect(regenerateRejection({ chatId: 'A', chat }, { chatId: 'A', messageId: 2 })).toBeNull();
  });
  it('聊天不同、不是最后一条、最后一条是用户消息：拒绝', () => {
    expect(regenerateRejection({ chatId: 'B', chat }, { chatId: 'A', messageId: 2 })).toMatch(/不是上一条回复所在的聊天/);
    expect(regenerateRejection({ chatId: 'A', chat: [...chat, { is_user: true }] }, { chatId: 'A', messageId: 2 })).toMatch(/不是聊天里的最后一条/);
    expect(regenerateRejection({ chatId: 'A', chat: chat.slice(0, 2) }, { chatId: 'A', messageId: 1 })).toMatch(/不是角色回复/);
  });
});

describe('normalizeChats', () => {
  it('去掉 .jsonl、解析时间、按最近排序、截断预览', () => {
    const out = normalizeChats([
      { file_name: 'A - 1.jsonl', last_mes: 1000, chat_items: 3, mes: 'x'.repeat(100) },
      { file_name: 'A - 2.jsonl', last_mes: '2026-11-07T10:00:00.000Z', chat_items: '5', mes: ' 多个   空格 ' },
      { nope: true },
      null,
    ]);
    expect(out.map((c) => c.fileName)).toEqual(['A - 2', 'A - 1']);
    expect(out[0]).toEqual({ fileName: 'A - 2', lastMessageAt: Date.parse('2026-11-07T10:00:00.000Z'), messageCount: 5, preview: '多个 空格' });
    expect(out[1].preview).toHaveLength(60);
  });
});

describe('isGreetingOnly（新聊天判定）', () => {
  it('只有一条角色消息才算新聊天', () => {
    expect(isGreetingOnly([{}])).toBe(true);
    expect(isGreetingOnly([])).toBe(false);
    expect(isGreetingOnly([{}, { is_user: true }])).toBe(false);
    expect(isGreetingOnly([{ is_user: true }])).toBe(false);
    expect(isGreetingOnly([{ is_system: true }])).toBe(false);
  });
});

describe('recheckUntilOk（自检复查）', () => {
  const noSleep = async (): Promise<void> => {};
  it('首次就通过：不复查', async () => {
    let calls = 0;
    const r = await recheckUntilOk(() => ({ ok: (calls++, true) }), { retries: 3, delayMs: 1, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });
  it('复查时变为通过：返回通过的结果', async () => {
    let calls = 0;
    const r = await recheckUntilOk(() => ({ ok: ++calls >= 3 }), { retries: 5, delayMs: 1, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
  });
  it('一直失败：复查 retries 次后返回失败', async () => {
    let calls = 0;
    const r = await recheckUntilOk(() => ({ ok: (calls++, false) }), { retries: 3, delayMs: 1, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(calls).toBe(4);
  });
  it('页面已停止：不再复查', async () => {
    let calls = 0;
    await recheckUntilOk(() => ({ ok: (calls++, false) }), { retries: 3, delayMs: 1, sleep: noSleep, keepGoing: () => false });
    expect(calls).toBe(1);
  });
  it('每次复查之间按 delayMs 等待', async () => {
    const waits: number[] = [];
    await recheckUntilOk(() => ({ ok: false }), { retries: 2, delayMs: 2000, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([2000, 2000]);
  });
});
