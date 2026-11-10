import { describe, expect, it, vi } from 'vitest';
import {
  Bot,
  BOT_COMMANDS,
  BUSY_COMMAND_TEXT,
  BUSY_TEXT,
  COLD_START_TEXT,
  explainError,
  HELP_TEXT,
  NOTHING_TO_REGEN_TEXT,
  NOTHING_TO_STOP_TEXT,
  parseCommand,
  RECYCLING_TEXT,
  REGENERATED_NOTE,
  type BotBrowser,
  type BotHost,
  type BotStore,
  type BotTelegram,
  type DeliveredReply,
} from '../src/server/bot';
import type { ReplyRecord, SessionRecord } from '../src/server/message-map';
import type { BrowserState } from '../src/server/browser';
import type { PluginStatus } from '../src/server/plugin';
import type { FetchLike } from '../src/server/http';
import { HostChannelError } from '../src/server/host-channel';
import { TelegramApiError, TelegramClient, type TelegramUpdate } from '../src/server/telegram';
import type { HostCommandInput, HostEvent } from '../src/shared/protocol';
import { CARD_PLACEHOLDER } from '../src/server/text';
import { captureLogger, FAKE_TOKEN, noopLogger } from './helpers';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Call {
  method: string;
  params: Record<string, unknown>;
}

class FakeTelegram implements BotTelegram {
  calls: Call[] = [];
  draftError?: Error;
  /** 依次用于每次 sendRichMessage / sendMessage 调用；undefined 表示成功。 */
  richErrors: Array<Error | undefined> = [];
  plainErrors: Array<Error | undefined> = [];
  private nextId = 500;
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'sendMessageDraft' && this.draftError) throw this.draftError;
    if (method === 'sendRichMessage') {
      const err = this.richErrors.shift();
      if (err) throw err;
      return { message_id: this.nextId++, chat: { id: params.chat_id, type: 'private' } } as T;
    }
    return true as T;
  }
  /** 模拟 Telegram 响应慢：sendMessage 过这么久才算发出去（调用记录也在发出去之后才有）。 */
  sendDelayMs = 0;
  async sendMessage(params: { chat_id: number; text: string }) {
    if (this.sendDelayMs) await new Promise((r) => setTimeout(r, this.sendDelayMs));
    this.calls.push({ method: 'sendMessage', params });
    const err = this.plainErrors.shift();
    if (err) throw err;
    return { message_id: this.nextId++, chat: { id: params.chat_id, type: 'private' } };
  }
  /** sendRichMessage 的 html。 */
  rich(): string[] {
    return this.calls.filter((c) => c.method === 'sendRichMessage').map((c) => (c.params.rich_message as { html: string }).html);
  }
  deleteErrors: Array<Error | undefined> = [];
  async editMessageText(params: { chat_id: number; message_id: number; text: string }) {
    this.calls.push({ method: 'editMessageText', params });
    return true;
  }
  async deleteMessage(chat_id: number, message_id: number) {
    this.calls.push({ method: 'deleteMessage', params: { chat_id, message_id } });
    const err = this.deleteErrors.shift();
    if (err) throw err;
    return true;
  }
  async sendChatAction(chat_id: number, action: string) {
    this.calls.push({ method: 'sendChatAction', params: { chat_id, action } });
    return true;
  }
  async answerCallbackQuery(params: { callback_query_id: string; text?: string }) {
    this.calls.push({ method: 'answerCallbackQuery', params });
    return true;
  }
  texts(): string[] {
    return this.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text as string);
  }
  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
}

class FakeHost implements BotHost {
  connected = true;
  hello: { stVersion: string; hasTavernHelper: boolean } | null = { stVersion: 'st 1.19.0', hasTavernHelper: true };
  requests: HostCommandInput[] = [];
  reloadsOnRefresh = true;
  onRequest: (cmd: HostCommandInput) => Promise<unknown> = async () => ({});
  private handlers = new Set<(e: HostEvent) => void>();
  private connHandlers = new Set<(c: boolean) => void>();
  request<T>(cmd: HostCommandInput): Promise<T> {
    this.requests.push(cmd);
    // 模拟页面重载：收到 refreshPage 后很快换一个新的 hello
    if (cmd.type === 'refreshPage' && this.reloadsOnRefresh) setTimeout(() => (this.hello = { stVersion: 'st 1.19.0', hasTavernHelper: true }), 50);
    return this.onRequest(cmd) as Promise<T>;
  }
  onEvent(fn: (e: HostEvent) => void) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  onConnectionChange(fn: (c: boolean) => void) {
    this.connHandlers.add(fn);
    return () => this.connHandlers.delete(fn);
  }
  emit(e: HostEvent): void {
    for (const h of [...this.handlers]) h(e);
  }
  setConnected(c: boolean): void {
    this.connected = c;
    for (const h of [...this.connHandlers]) h(c);
  }
  /** 最近一次 send 或 regenerate 的 generationId。 */
  get gen(): string {
    const s = [...this.requests].reverse().find((r) => r.type === 'send' || r.type === 'regenerate') as { generationId: string } | undefined;
    if (!s) throw new Error('no send');
    return s.generationId;
  }
}

class FakeStore implements BotStore {
  replies: ReplyRecord[] = [];
  session: SessionRecord | undefined;
  lastReply(chatId: number) {
    return [...this.replies].reverse().find((r) => r.telegramChatId === chatId);
  }
  recordReply(r: ReplyRecord) {
    this.replies = this.replies.filter((x) => !(x.stChatId === r.stChatId && x.stMessageId === r.stMessageId));
    this.replies.push(r);
  }
  removeReply(r: ReplyRecord) {
    this.replies = this.replies.filter((x) => x !== r);
  }
  setSession(s: SessionRecord) {
    this.session = s;
  }
  greeted = new Set<string>();
  markGreeted(id: string) {
    if (this.greeted.has(id)) return false;
    this.greeted.add(id);
    return true;
  }
}

class FakeBrowser implements BotBrowser {
  state: BrowserState = 'running';
  pid = 4242;
  startedAt: number | undefined = 1;
  lastError?: string;
  leases = 0;
  ensureCalls = 0;
  ensureImpl: () => Promise<void> = async () => {};
  async ensureRunning() {
    this.ensureCalls++;
    await this.ensureImpl();
    this.state = 'running';
  }
  acquire() {
    this.leases++;
    return () => void this.leases--;
  }
  touch() {}
}

const status = (): PluginStatus => ({
  telegram: 'ok',
  botUsername: 'testbot',
  chromium: { path: '/chrome', source: 'system' },
  proxy: { source: 'none', description: '无（直连）' },
  extension: { ok: true },
  hostChecks: [],
});

function setup(over: Partial<ConstructorParameters<typeof Bot>[0]> = {}) {
  const telegram = new FakeTelegram();
  const host = new FakeHost();
  const browser = new FakeBrowser();
  const store = new FakeStore();
  const log = captureLogger();
  const bot = new Bot({ telegram, host, browser, store, status: status(), log, draftIntervalMs: 30, typingIntervalMs: 20, ...over });
  return { bot, telegram, host, browser, log, store };
}

let uid = 0;
const text = (t: string, chatId = 7): TelegramUpdate => ({ update_id: ++uid, message: { message_id: uid, chat: { id: chatId, type: 'private' }, from: { id: 1 }, text: t } });

describe('explainError', () => {
  it('页面通道的超时、未连接、断开换成能照着做的说明，其余原样', () => {
    expect(explainError(new HostChannelError('timeout', '命令 selectCharacter 在 90000 毫秒内没有响应'))).toMatch(/页面长时间没有响应.*90000.*\/status/);
    expect(explainError(new HostChannelError('not-connected', 'x'))).toMatch(/还没连上/);
    expect(explainError(new HostChannelError('disconnected', 'x'))).toMatch(/连接断了/);
    expect(explainError(new HostChannelError('remote-error', '切换角色超时：xx'))).toBe('切换角色超时：xx');
    expect(explainError(new Error('boom'))).toBe('boom');
    expect(explainError('str')).toBe('str');
  });
});

describe('parseCommand', () => {
  it('解析命令和 @bot 后缀', () => {
    expect(parseCommand('/start')).toEqual({ name: 'start', args: '' });
    expect(parseCommand('/Status@my_bot')).toEqual({ name: 'status', args: '' });
    expect(parseCommand('/chars 2')).toEqual({ name: 'chars', args: '2' });
    expect(parseCommand('你好 /start')).toBeNull();
    expect(parseCommand('/ 你好')).toBeNull();
  });
});

describe('Bot 路由', () => {
  it('/start、/help 回复说明', async () => {
    const { bot, telegram } = setup();
    await bot.handleUpdate(text('/start'));
    await bot.handleUpdate(text('/help'));
    expect(telegram.texts()).toEqual([HELP_TEXT, HELP_TEXT]);
  });

  it('没有在生成时 /stop、没有记录时 /regen：给出说明，不触发生成', async () => {
    const { bot, telegram, host } = setup();
    await bot.handleUpdate(text('/stop'));
    await bot.handleUpdate(text('/regen'));
    expect(telegram.texts()).toEqual([NOTHING_TO_STOP_TEXT, NOTHING_TO_REGEN_TEXT]);
    expect(host.requests).toEqual([]);
  });

  it('未知命令和非文字消息', async () => {
    const { bot, telegram } = setup();
    await bot.handleUpdate(text('/foo'));
    await bot.handleUpdate({ update_id: 99, message: { message_id: 1, chat: { id: 7, type: 'private' }, from: { id: 1 } } });
    expect(telegram.texts()[0]).toMatch(/未知命令 \/foo/);
    expect(telegram.texts()[1]).toMatch(/只支持文字/);
  });

  it('无法识别或过期的按钮：应答并提示重新发送', async () => {
    const { bot, telegram } = setup();
    await bot.handleUpdate({ update_id: 5, callback_query: { id: 'cb1', from: { id: 1 }, data: 'x' } });
    await bot.handleUpdate({ update_id: 6, callback_query: { id: 'cb2', from: { id: 1 }, data: 'c|abcdef01|0' } });
    expect(telegram.of('answerCallbackQuery').map((c) => c.params)).toEqual([
      { callback_query_id: 'cb1', text: expect.stringMatching(/已过期/) },
      { callback_query_id: 'cb2', text: expect.stringMatching(/已过期/) },
    ]);
  });

  it('/status：显示 Chromium、ST 页面、当前角色和失败的自检；不唤醒浏览器', async () => {
    const { bot, telegram, host, browser } = setup();
    host.onRequest = async (cmd) =>
      cmd.type === 'getStatus' ? { app: 'st', characterName: 'Seraphina', chatId: 'Seraphina - 2026', mainApi: 'openai', onlineStatus: 'Valid', generating: false } : {};
    (bot as unknown as { opts: { status: PluginStatus } }).opts.status.hostChecks = [
      { name: 'csrf', ok: true },
      { name: 'mvu', ok: false, detail: '没有 MVU' },
    ];
    await bot.handleUpdate(text('/status'));
    const out = telegram.texts()[0];
    expect(out).toMatch(/Telegram：已连接 @testbot/);
    expect(out).toMatch(/Chromium：运行中（PID 4242，已运行 \d+ 分钟）/);
    expect(out).toMatch(/空闲关闭：未启用/);
    expect(out).toMatch(/可重新生成上一条：否/);
    expect(out).toMatch(/ST 页面：已连接（st 1\.19\.0，酒馆助手已加载）/);
    expect(out).toMatch(/当前角色：Seraphina/);
    expect(out).toMatch(/API：openai（已连接）/);
    expect(out).toMatch(/mvu 未通过：没有 MVU/);
    expect(browser.ensureCalls).toBe(0);
  });

  it('堆回收：空闲时重载页面并恢复会话；期间 busy，结束后释放浏览器租约', async () => {
    const ctx = setup();
    ctx.store.session = { characterAvatar: 'c5.png', chatId: 'E - 2' };
    ctx.browser.startedAt = 1;
    const p = ctx.bot.recyclePage();
    expect(ctx.bot.busy).toBe(true);
    expect(ctx.browser.leases).toBe(1);
    await p;
    expect(ctx.host.requests.map((r) => r.type)).toContain('refreshPage');
    expect(ctx.bot.busy).toBe(false);
    expect(ctx.browser.leases).toBe(0);
  });

  it('堆回收期间发来的消息：先提示再等页面恢复，之后照常发给 ST，不按忙碌丢弃', async () => {
    const ctx = setup();
    const p = ctx.bot.recyclePage();
    await wait(5);
    const h = ctx.bot.handleUpdate(text('回收时发的消息'));
    await p;
    await h;
    await wait(5);
    expect(ctx.telegram.texts()).toEqual([RECYCLING_TEXT]);
    expect(ctx.telegram.texts()).not.toContain(BUSY_TEXT);
    const types = ctx.host.requests.map((r) => r.type);
    expect(types.indexOf('refreshPage')).toBeLessThan(types.indexOf('send'));
    expect(ctx.host.requests.find((r) => r.type === 'send')).toMatchObject({ text: '回收时发的消息' });
    ctx.host.emit({ type: 'generationFailed', generationId: ctx.host.gen, reason: 'test' });
    await ctx.bot.idle();
  });

  it('堆回收期间发来的命令（/regen 等）同样等待，不回复忙碌', async () => {
    const ctx = setup();
    ctx.store.replies.push({ telegramChatId: 7, telegramMessageIds: [1], stChatId: 'c', stMessageId: 3, sentAt: Date.now() });
    const p = ctx.bot.recyclePage();
    await wait(5);
    const h = ctx.bot.handleUpdate(text('/regen'));
    await p;
    await h;
    expect(ctx.telegram.texts()).not.toContain(BUSY_COMMAND_TEXT);
    expect(ctx.telegram.texts()[0]).toBe(RECYCLING_TEXT);
    await wait(5);
    expect(ctx.host.requests.some((r) => r.type === 'regenerate')).toBe(true);
    ctx.host.emit({ type: 'generationFailed', generationId: ctx.host.gen, reason: 'test' });
    await ctx.bot.idle();
  });

  it('生成中不能回收页面：recyclePage 拒绝，当前生成不受影响', async () => {
    const ctx = setup();
    await ctx.bot.handleUpdate(text('你好'));
    await wait(5);
    await expect(ctx.bot.recyclePage()).rejects.toThrow(/正忙/);
    expect(ctx.host.requests.some((r) => r.type === 'refreshPage')).toBe(false);
    ctx.host.emit({ type: 'generationFailed', generationId: ctx.host.gen, reason: 'test' });
    await ctx.bot.idle();
  });

  it('堆回收：页面没能重新连上时抛错，并且恢复到空闲、释放租约', async () => {
    const ctx = setup({ hostReloadTimeoutMs: 300 });
    ctx.host.reloadsOnRefresh = false;
    await expect(ctx.bot.recyclePage()).rejects.toThrow();
    expect(ctx.bot.busy).toBe(false);
    expect(ctx.browser.leases).toBe(0);
  });

  it('/status：显示页面堆用量与回收次数；无数据时不显示', async () => {
    let heap: { usedMB?: number; limitMB: number; recycled: number; suspended: boolean } | undefined;
    const ctx = setup({ heapStatus: () => heap });
    await ctx.bot.handleUpdate(text('/status'));
    expect(ctx.telegram.texts()[0]).not.toMatch(/页面内存/);
    heap = { usedMB: 180.4, limitMB: 256, recycled: 2, suspended: false };
    await ctx.bot.handleUpdate(text('/status'));
    expect(ctx.telegram.texts()[1]).toMatch(/页面内存：180 \/ 256 MB；因堆回收重载 2 次/);
    heap = { limitMB: 256, recycled: 1, suspended: true };
    await ctx.bot.handleUpdate(text('/status'));
    expect(ctx.telegram.texts()[2]).toMatch(/页面内存：上限 256 MB；因堆回收重载 1 次.*已停止自动回收/);
  });

  it('/status：显示 Telegram 代理的来源（配置 / 环境变量 / 无），不含凭据', async () => {
    const cases: Array<[PluginStatus['proxy'], RegExp]> = [
      [{ source: 'config', description: '配置 telegramProxy（10.0.0.1:7890）' }, /Telegram 代理：配置 telegramProxy（10\.0\.0\.1:7890）/],
      [{ source: 'env', description: '环境变量 HTTPS_PROXY（10.0.0.2:8080）' }, /Telegram 代理：环境变量 HTTPS_PROXY（10\.0\.0\.2:8080）/],
      [{ source: 'none', description: '无（直连）' }, /Telegram 代理：无（直连）/],
    ];
    for (const [proxy, re] of cases) {
      const { bot, telegram } = setup();
      (bot as unknown as { opts: { status: PluginStatus } }).opts.status.proxy = proxy;
      await bot.handleUpdate(text('/status'));
      expect(telegram.texts()[0]).toMatch(re);
      expect(telegram.texts()[0]).not.toMatch(/pw|:\/\/\w+:\w+@/);
    }
  });

  it('/status：浏览器已关闭、页面未连接', async () => {
    const { bot, telegram, host, browser } = setup();
    browser.state = 'stopped';
    host.connected = false;
    await bot.handleUpdate(text('/status'));
    expect(telegram.texts()[0]).toMatch(/Chromium：已关闭（收到消息时自动启动）/);
    expect(telegram.texts()[0]).toMatch(/ST 页面：未连接/);
  });
});

describe('Bot 对话', () => {
  it('文字转成 send；流式草稿节流；正式消息走 sendRichMessage', async () => {
    const { bot, telegram, host, browser } = setup();
    await bot.handleUpdate(text('你好'));
    await wait(5);
    expect(host.requests[0]).toMatchObject({ type: 'send', text: '你好' });
    expect(browser.leases).toBe(1);
    const gen = host.gen;
    // 在一个节流窗口内连发多段，只应发出最新的一段
    host.emit({ type: 'streamText', generationId: gen, text: '你' });
    host.emit({ type: 'streamText', generationId: gen, text: '你好呀' });
    host.emit({ type: 'streamText', generationId: 'other', text: '别的生成' });
    await wait(50);
    host.emit({ type: 'streamText', generationId: gen, text: '你好呀，旅人。\n```html\n<html>' });
    await wait(50);
    host.emit({ type: 'messageFinal', generationId: gen, chatId: 'c', messageId: 3, html: '<p>你好呀，旅人。</p>', text: '你好呀，旅人。', stopped: false, cards: [] });
    await bot.idle();
    const drafts = telegram.of('sendMessageDraft').map((c) => c.params);
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts.every((d) => d.draft_id === drafts[0].draft_id && d.chat_id === 7)).toBe(true);
    expect(drafts.map((d) => d.text)).not.toContain('你');
    expect(drafts.map((d) => d.text)).not.toContain('别的生成');
    expect(drafts.at(-1)!.text).toBe(`你好呀，旅人。\n${CARD_PLACEHOLDER}`);
    expect(telegram.texts()).toEqual([]);
    expect(telegram.rich()).toEqual(['<p>你好呀，旅人。</p>']);
    expect(telegram.of('sendRichMessage')[0].params.chat_id).toBe(7);
    // 正式消息在所有草稿之后
    const lastDraft = telegram.calls.map((c) => c.method).lastIndexOf('sendMessageDraft');
    const final = telegram.calls.findIndex((c) => c.method === 'sendRichMessage');
    expect(final).toBeGreaterThan(lastDraft);
    expect(browser.leases).toBe(0);
    expect(bot.busy).toBe(false);
  });

  it('生成中再发消息：提示忙碌，不发给 ST，当前生成不受影响', async () => {
    const { bot, telegram, host } = setup();
    await bot.handleUpdate(text('第一条'));
    await wait(5);
    await bot.handleUpdate(text('第二条'));
    expect(telegram.texts()).toEqual([BUSY_TEXT]);
    expect(host.requests.filter((r) => r.type === 'send')).toHaveLength(1);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '', text: '回复一', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.texts()).toEqual([BUSY_TEXT, '回复一']);
    // 结束后可以继续发
    await bot.handleUpdate(text('第三条'));
    await wait(5);
    expect(host.requests.filter((r) => r.type === 'send')).toHaveLength(2);
    host.emit({ type: 'generationFailed', generationId: host.gen, reason: 'API 401' });
    await bot.idle();
  });

  it('dispose（运行时重新加载或退出）：进行中的一轮立即按中断收尾，不再等页面', async () => {
    const { bot, telegram, host } = setup({ turnIdleTimeoutMs: 60_000 });
    await bot.handleUpdate(text('hi'));
    await vi.waitFor(() => expect(host.requests.some((r) => r.type === 'send')).toBe(true), { timeout: 4000, interval: 2 });
    expect(bot.busy).toBe(true);
    bot.dispose();
    await bot.idle();
    expect(bot.busy).toBe(false);
    expect(telegram.texts().at(-1)).toMatch(/这一轮回复没有完成：插件正在重新加载或退出/);
    // 之后页面再发结果也不会再回复
    const n = telegram.texts().length;
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '', text: '迟到的回复', stopped: false, cards: [] });
    await wait(5);
    expect(telegram.texts()).toHaveLength(n);
    // 没有进行中的一轮时 dispose 无副作用
    bot.dispose();
  });

  it('dispose 会等“没有完成”的提示真正发出去再返回（ST 退出前不能赶不上）', async () => {
    const { bot, telegram, host } = setup({ turnIdleTimeoutMs: 60_000 });
    await bot.handleUpdate(text('hi'));
    await vi.waitFor(() => expect(host.requests.some((r) => r.type === 'send')).toBe(true), { timeout: 4000, interval: 2 });
    telegram.sendDelayMs = 60;
    await bot.dispose();
    // 没有额外等 bot.idle()：dispose 返回时提示已经发出
    expect(telegram.texts().at(-1)).toMatch(/这一轮回复没有完成：插件正在重新加载或退出/);
    expect(bot.busy).toBe(false);
  });

  it('dispose 有等待上限：Telegram 一直不响应时不会卡住退出', async () => {
    const { bot, telegram, host } = setup({ turnIdleTimeoutMs: 60_000 });
    await bot.handleUpdate(text('hi'));
    await vi.waitFor(() => expect(host.requests.some((r) => r.type === 'send')).toBe(true), { timeout: 4000, interval: 2 });
    telegram.sendDelayMs = 400;
    const t0 = Date.now();
    await bot.dispose('测试', 40);
    expect(Date.now() - t0).toBeLessThan(300);
    await bot.idle();
  });

  it('dispose 时消息还没发给 ST（浏览器启动中）：立即告知“没有发给角色”，之后不再发送也不重复提示', async () => {
    const { bot, telegram, host, browser } = setup();
    let release!: () => void;
    browser.ensureImpl = () => new Promise<void>((r) => (release = r));
    await bot.handleUpdate(text('hi'));
    await wait(5);
    expect(bot.busy).toBe(true);
    await bot.dispose();
    expect(telegram.texts().filter((t) => /没有发给角色/.test(t))).toHaveLength(1);
    release(); // 浏览器后来才启动完
    await bot.idle();
    expect(host.requests.some((r) => r.type === 'send')).toBe(false);
    expect(telegram.texts().filter((t) => /没有发给角色|没有完成/.test(t))).toHaveLength(1);
    expect(bot.busy).toBe(false);
    expect(browser.leases).toBe(0);
  });

  it('不支持流式：收到正式消息前一直 typing，没有草稿', async () => {
    const { bot, telegram, host } = setup();
    await bot.handleUpdate(text('hi'));
    // 等到至少发出 3 次 typing（不按固定时长睡：CPU 繁忙时定时器会被推迟）
    await vi.waitFor(() => expect(telegram.of('sendChatAction').length).toBeGreaterThanOrEqual(3), { timeout: 4000, interval: 5 });
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '', text: '完整回复', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.of('sendChatAction').length).toBeGreaterThanOrEqual(3);
    expect(telegram.of('sendChatAction')[0].params).toEqual({ chat_id: 7, action: 'typing' });
    expect(telegram.of('sendMessageDraft')).toHaveLength(0);
    expect(telegram.texts()).toEqual(['完整回复']);
    const n = telegram.of('sendChatAction').length;
    await wait(60);
    expect(telegram.of('sendChatAction')).toHaveLength(n);
  });

  it('流式开始后停止 typing', async () => {
    const { bot, telegram, host } = setup();
    await bot.handleUpdate(text('hi'));
    await wait(5);
    host.emit({ type: 'streamText', generationId: host.gen, text: '开始了' });
    const n = telegram.of('sendChatAction').length;
    await wait(80);
    expect(telegram.of('sendChatAction')).toHaveLength(n);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '', text: 'x', stopped: false, cards: [] });
    await bot.idle();
  });

  it('草稿接口不存在（404）：改回 typing，正式消息照发', async () => {
    const { bot, telegram, host, log } = setup();
    telegram.draftError = new TelegramApiError('sendMessageDraft', 404, 'Not Found');
    await bot.handleUpdate(text('hi'));
    await wait(5);
    host.emit({ type: 'streamText', generationId: host.gen, text: '一段' });
    await wait(50);
    const typingAfter = telegram.of('sendChatAction').length;
    await wait(50);
    expect(telegram.of('sendChatAction').length).toBeGreaterThan(typingAfter);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '', text: '最终', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.texts()).toEqual(['最终']);
    expect(log.lines.join('\n')).toMatch(/不支持 sendMessageDraft/);
  });

  it('超长回复：rich 分段发送，每段不超过 32768 字符，内容完整；收集每段 message_id', async () => {
    const delivered: DeliveredReply[] = [];
    const { bot, telegram, host } = setup({ onDelivered: (d) => delivered.push(d) });
    await bot.handleUpdate(text('长一点'));
    await wait(5);
    const paras = Array.from({ length: 500 }, (_, i) => `第${i}段：` + '字'.repeat(80));
    const html = paras.map((p) => `<p>${p}</p>`).join('');
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'chat-1', messageId: 9, html, text: paras.join('\n'), stopped: false, cards: [] });
    await bot.idle();
    const parts = telegram.rich();
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.replace(/<[^>]+>/g, '').length).toBeLessThanOrEqual(32768);
    const visible = parts.join('').replace(/<\/p>/g, '\n').replace(/<[^>]+>/g, '');
    for (const p of paras) expect(visible).toContain(p);
    expect(visible.match(/第\d+段/g)).toHaveLength(500);
    expect(telegram.texts()).toEqual([]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ telegramChatId: 7, stChatId: 'chat-1', stMessageId: 9 });
    expect(delivered[0].telegramMessageIds).toHaveLength(parts.length);
  });

  it('rich 返回 400：同一份 html 用 toPlainTexts 回退为 sendMessage', async () => {
    const { bot, telegram, host } = setup();
    telegram.richErrors = [new TelegramApiError('sendRichMessage', 400, "Bad Request: can't parse rich message")];
    await bot.handleUpdate(text('hi'));
    await wait(5);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '<p><b>粗体</b>和<i>斜体</i></p><p>第二段</p>', text: '不应使用', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.rich()).toHaveLength(1);
    expect(telegram.texts()).toEqual(['粗体和斜体\n第二段']);
  });

  it('第二段 rich 失败：只回退剩余部分，已发出的不重发', async () => {
    const delivered: DeliveredReply[] = [];
    const { bot, telegram, host } = setup({ onDelivered: (d) => delivered.push(d) });
    telegram.richErrors = [undefined, new TelegramApiError('sendRichMessage', 400, 'Bad Request')];
    await bot.handleUpdate(text('hi'));
    await wait(5);
    const paras = Array.from({ length: 400 }, (_, i) => `P${i}-` + 'x'.repeat(100));
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: paras.map((p) => `<p>${p}</p>`).join(''), text: '', stopped: false, cards: [] });
    await bot.idle();
    const rich = telegram.rich();
    expect(rich.length).toBe(2);
    const firstVisible = rich[0].replace(/<\/p>/g, '\n').replace(/<[^>]+>/g, '');
    const plain = telegram.texts().join('\n');
    for (const p of paras) expect(firstVisible.includes(p) !== plain.includes(p)).toBe(true);
    for (const t of telegram.texts()) expect(t.length).toBeLessThanOrEqual(4096);
    expect(delivered[0].telegramMessageIds.length).toBe(1 + telegram.texts().length);
  });

  it('rich 和纯文本回退都失败：一条都没发出时改用页面 innerText', async () => {
    const { bot, telegram, host } = setup();
    telegram.richErrors = [new TelegramApiError('sendRichMessage', 400, 'Bad Request')];
    telegram.plainErrors = [new TelegramApiError('sendMessage', 400, 'Bad Request: message text is empty')];
    await bot.handleUpdate(text('hi'));
    await wait(5);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '<p>转换后的文字</p>', text: '页面 innerText', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.texts()).toEqual(['转换后的文字', '页面 innerText']);
  });

  it('全部失败：告诉用户内容在 ST 里', async () => {
    const { bot, telegram, host } = setup();
    const bad = () => new TelegramApiError('x', 403, 'Forbidden: bot was blocked by the user');
    telegram.richErrors = [bad()];
    telegram.plainErrors = [bad(), bad()];
    await bot.handleUpdate(text('hi'));
    await wait(5);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '<p>内容</p>', text: '内容', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.texts().at(-1)).toMatch(/完整内容保存在 ST 聊天记录中/);
  });

  it('rich 遇到 429：按 retry_after 重试后成功，不回退纯文本', async () => {
    const sleeps: number[] = [];
    let richCalls = 0;
    const methods: string[] = [];
    const fetchFake: FetchLike = async (url, init) => {
      const method = url.split('/').pop()!;
      methods.push(method);
      if (method === 'sendRichMessage' && richCalls++ === 0) {
        return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } }));
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: body.chat_id, type: 'private' } } }));
    };
    const client = new TelegramClient({ token: FAKE_TOKEN, fetch: fetchFake, log: noopLogger, sleep: async (ms) => void sleeps.push(ms) });
    const host = new FakeHost();
    const delivered: DeliveredReply[] = [];
    const bot = new Bot({ telegram: client, host, browser: new FakeBrowser(), store: new FakeStore(), status: status(), log: noopLogger, onDelivered: (d) => delivered.push(d) });
    await bot.handleUpdate(text('hi'));
    await wait(5);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '<p>ok</p>', text: 'ok', stopped: false, cards: [] });
    await bot.idle();
    expect(methods.filter((m) => m === 'sendRichMessage')).toHaveLength(2);
    expect(methods).not.toContain('sendMessage');
    expect(sleeps).toEqual([3100]);
    expect(delivered[0].telegramMessageIds).toEqual([77]);
  });

  it('转换结果为空数组：不发正式消息', async () => {
    const delivered: DeliveredReply[] = [];
    const { bot, telegram, host } = setup({ onDelivered: (d) => delivered.push(d) });
    await bot.handleUpdate(text('hi'));
    await wait(5);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '<p>  </p><div></div>', text: '', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.rich()).toEqual([]);
    expect(telegram.texts()).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('前端卡片源码不进正文：文字照发，代码块被移除', async () => {
    const { bot, telegram, host } = setup();
    await bot.handleUpdate(text('hi'));
    await wait(5);
    const card = '<div class="TH-render"><pre><code>&lt;body&gt;&lt;script&gt;$(\'body\').load(\'x\')&lt;/script&gt;&lt;/body&gt;</code></pre></div>';
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: `<p>正文内容</p>${card}`, text: '正文内容\n<body>', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.rich()).toHaveLength(1);
    const sent = JSON.stringify(telegram.rich()[0]);
    expect(sent).toContain('正文内容');
    expect(sent).not.toContain('body');
    expect(sent).not.toContain('load');
  });

  it('正文只有前端卡片：不发正式消息，也不把源码当纯文本发', async () => {
    const { bot, telegram, host } = setup();
    await bot.handleUpdate(text('hi'));
    await wait(5);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '<pre><code>&lt;body&gt;&lt;/body&gt;</code></pre>', text: '<body></body>', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.rich()).toEqual([]);
    expect(telegram.texts()).toEqual([]);
  });

  it('生成失败、停止（无内容）、停止（有内容）', async () => {
    const { bot, telegram, host } = setup();
    await bot.handleUpdate(text('a'));
    await wait(5);
    host.emit({ type: 'generationFailed', generationId: host.gen, reason: 'API 返回 401' });
    await bot.idle();
    await bot.handleUpdate(text('b'));
    await wait(5);
    host.emit({ type: 'generationStopped', generationId: host.gen });
    await bot.idle();
    await bot.handleUpdate(text('c'));
    await wait(5);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '<p>一半</p>', text: '一半', stopped: true, cards: [] });
    await bot.idle();
    expect(telegram.texts()).toEqual(['❌ 生成失败：API 返回 401', '⏹️ 已停止生成，没有生成内容。']);
    expect(telegram.rich()).toEqual(['<p>一半</p><p>（⏹️ 已停止生成）</p>']);
  });

  it('send 命令被页面拒绝：提示原因，释放忙碌状态', async () => {
    const { bot, telegram, host, browser } = setup();
    host.onRequest = async () => {
      throw new Error('ST 当前没有打开任何角色的聊天，请先选择角色');
    };
    await bot.handleUpdate(text('hi'));
    await bot.idle();
    expect(telegram.texts()).toEqual(['❌ 发送到 ST 失败：ST 当前没有打开任何角色的聊天，请先选择角色']);
    expect(bot.busy).toBe(false);
    expect(browser.leases).toBe(0);
  });

  it('冷启动：先提示正在启动，启动完成后消息照常发出（不丢）', async () => {
    const { bot, telegram, host, browser } = setup();
    browser.state = 'stopped';
    host.connected = false;
    let finishStart!: () => void;
    browser.ensureImpl = () => new Promise<void>((r) => (finishStart = r));
    await bot.handleUpdate(text('醒醒'));
    await wait(5);
    expect(telegram.texts()).toEqual([COLD_START_TEXT]);
    expect(host.requests).toHaveLength(0);
    // 启动期间再来一条：按忙碌处理
    await bot.handleUpdate(text('还有我'));
    expect(telegram.texts()).toEqual([COLD_START_TEXT, BUSY_TEXT]);
    // 启动过程中通道断开又连上（rotateNonce），不应影响这一轮
    host.setConnected(false);
    host.setConnected(true);
    finishStart();
    await wait(5);
    expect(host.requests[0]).toMatchObject({ type: 'send', text: '醒醒' });
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '', text: '早', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.texts()).toEqual([COLD_START_TEXT, BUSY_TEXT, '早']);
  });

  it('浏览器启动失败：告诉用户原因', async () => {
    const { bot, telegram, browser } = setup();
    browser.state = 'stopped';
    browser.ensureImpl = async () => {
      throw new Error('没有找到 Chrome/Chromium');
    };
    await bot.handleUpdate(text('hi'));
    await bot.idle();
    expect(telegram.texts()).toEqual([COLD_START_TEXT, '❌ 无头浏览器启动失败：没有找到 Chrome/Chromium\n可以发 /status 查看详情，修好后直接再发消息即可重试']);
    expect(bot.busy).toBe(false);
  });

  it('生成中页面断开超过宽限期：结束这一轮并说明', async () => {
    const { bot, telegram, host } = setup({ disconnectGraceMs: 30 });
    await bot.handleUpdate(text('hi'));
    await wait(5);
    host.setConnected(false);
    await bot.idle();
    expect(telegram.texts()[0]).toMatch(/没有完成：无头浏览器页面连接中断/);
  });

  it('断开后在宽限期内重连：继续等这一轮', async () => {
    const { bot, telegram, host } = setup({ disconnectGraceMs: 40 });
    await bot.handleUpdate(text('hi'));
    await wait(5);
    host.setConnected(false);
    await wait(10);
    host.setConnected(true);
    await wait(60);
    expect(bot.busy).toBe(true);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '', text: 'ok', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.texts()).toEqual(['ok']);
  });

  it('长时间没有进展：超时结束', async () => {
    const { bot, telegram } = setup({ turnIdleTimeoutMs: 40 });
    await bot.handleUpdate(text('hi'));
    await bot.idle();
    expect(telegram.texts()[0]).toMatch(/没有完成：超过/);
  });

  it('html 为空但 innerText 不为空（取不到渲染节点）：直接发纯文本，不丢内容', async () => {
    const { bot, telegram, host } = setup();
    await bot.handleUpdate(text('hi'));
    await wait(5);
    host.emit({ type: 'messageFinal', generationId: host.gen, chatId: 'c', messageId: 1, html: '', text: '只有纯文本', stopped: false, cards: [] });
    await bot.idle();
    expect(telegram.rich()).toEqual([]);
    expect(telegram.texts()).toEqual(['只有纯文本']);
  });
});

// ───────────── 步骤 10、11 ─────────────

const final = (gen: string, over: Partial<Extract<HostEvent, { type: 'messageFinal' }>> = {}): HostEvent => ({
  type: 'messageFinal',
  generationId: gen,
  chatId: 'chat-A',
  messageId: 3,
  html: '<p>回复</p>',
  text: '回复',
  stopped: false,
  cards: [],
  ...over,
});

/** 完成一轮正常对话，返回记录下来的回复。 */
async function oneRound(ctx: ReturnType<typeof setup>, t = 'hi', over: Partial<Extract<HostEvent, { type: 'messageFinal' }>> = {}) {
  await ctx.bot.handleUpdate(text(t));
  await wait(5);
  ctx.host.emit(final(ctx.host.gen, over));
  await ctx.bot.idle();
  return ctx.store.lastReply(7)!;
}

describe('停止', () => {
  it('草稿带 can_stop 和 keep_on_stop', async () => {
    const ctx = setup();
    await ctx.bot.handleUpdate(text('hi'));
    await wait(5);
    ctx.host.emit({ type: 'streamText', generationId: ctx.host.gen, text: '开始' });
    await wait(40);
    expect(ctx.telegram.of('sendMessageDraft')[0].params).toMatchObject({ can_stop: true, keep_on_stop: true });
    ctx.host.emit(final(ctx.host.gen));
    await ctx.bot.idle();
  });

  it('/stop：向页面发 stop，已生成部分作为正式消息保留', async () => {
    const ctx = setup();
    await ctx.bot.handleUpdate(text('hi'));
    await wait(5);
    await ctx.bot.handleUpdate(text('/stop'));
    expect(ctx.host.requests.map((r) => r.type)).toEqual(['send', 'stop']);
    ctx.host.emit(final(ctx.host.gen, { html: '<p>一半</p>', text: '一半', stopped: true }));
    await ctx.bot.idle();
    expect(ctx.telegram.rich()).toEqual(['<p>一半</p><p>（⏹️ 已停止生成）</p>']);
    expect(ctx.store.lastReply(7)).toBeTruthy();
  });

  it('草稿停止按钮：draft_id 匹配才停止', async () => {
    const ctx = setup();
    await ctx.bot.handleUpdate(text('hi'));
    await wait(5);
    ctx.host.emit({ type: 'streamText', generationId: ctx.host.gen, text: '开始' });
    await wait(40);
    const draftId = ctx.telegram.of('sendMessageDraft')[0].params.draft_id as number;
    const stopUpdate = (id: number | string): TelegramUpdate => ({ update_id: ++uid, stopped_message_generation: { chat: { id: 7, type: 'private' }, draft_id: id } });
    await ctx.bot.handleUpdate(stopUpdate(draftId + 1));
    expect(ctx.host.requests.map((r) => r.type)).toEqual(['send']);
    // 真实 Telegram 回传的 draft_id 是字符串
    await ctx.bot.handleUpdate(stopUpdate(String(draftId)));
    expect(ctx.host.requests.map((r) => r.type)).toEqual(['send', 'stop']);
    ctx.host.emit(final(ctx.host.gen, { stopped: true }));
    await ctx.bot.idle();
  });

  it('启动期间 /stop：取消，不发给 ST', async () => {
    const ctx = setup();
    ctx.browser.state = 'stopped';
    ctx.host.connected = false;
    let go!: () => void;
    ctx.browser.ensureImpl = () => new Promise<void>((r) => (go = r));
    await ctx.bot.handleUpdate(text('hi'));
    await wait(5);
    await ctx.bot.handleUpdate(text('/stop'));
    go();
    await ctx.bot.idle();
    expect(ctx.host.requests.filter((r) => r.type === 'send')).toHaveLength(0);
    expect(ctx.telegram.texts().at(-1)).toMatch(/已取消/);
  });

  it('页面确认前 /stop：确认后立即停止', async () => {
    const ctx = setup();
    let ack!: () => void;
    ctx.host.onRequest = async (cmd) => (cmd.type === 'send' ? new Promise((r) => (ack = () => r({}))) : {});
    await ctx.bot.handleUpdate(text('hi'));
    await wait(5);
    await ctx.bot.handleUpdate(text('/stop'));
    expect(ctx.host.requests.map((r) => r.type)).toEqual(['send']);
    ack();
    await wait(5);
    expect(ctx.host.requests.map((r) => r.type)).toEqual(['send', 'stop']);
    ctx.host.emit({ type: 'generationStopped', generationId: ctx.host.gen });
    await ctx.bot.idle();
  });
});

describe('重新生成', () => {
  it('/regen：带上一条的 chatId、messageId 发 regenerate，删除旧消息，记录新回复', async () => {
    const ctx = setup();
    const first = await oneRound(ctx);
    expect(first).toMatchObject({ telegramChatId: 7, stChatId: 'chat-A', stMessageId: 3 });
    await ctx.bot.handleUpdate(text('/regen'));
    await wait(5);
    const regen = ctx.host.requests.at(-1)!;
    expect(regen).toMatchObject({ type: 'regenerate', chatId: 'chat-A', messageId: 3 });
    expect(ctx.telegram.of('deleteMessage').map((c) => c.params.message_id)).toEqual(first.telegramMessageIds);
    ctx.host.emit(final(ctx.host.gen, { html: '<p>新回复</p>', text: '新回复' }));
    await ctx.bot.idle();
    expect(ctx.telegram.rich().at(-1)).toBe('<p>新回复</p>');
    const second = ctx.store.lastReply(7)!;
    expect(second.telegramMessageIds).not.toEqual(first.telegramMessageIds);
    expect(ctx.store.replies).toHaveLength(1);
  });

  it('旧消息删不掉：回复一条“已重新生成”的标注', async () => {
    const ctx = setup();
    const first = await oneRound(ctx);
    ctx.telegram.deleteErrors = [new TelegramApiError('deleteMessage', 400, "Bad Request: message can't be deleted")];
    await ctx.bot.handleUpdate(text('/regen'));
    await wait(5);
    const note = ctx.telegram.of('sendMessage').at(-1)!;
    expect(note.params.text).toBe(REGENERATED_NOTE);
    expect(note.params.reply_parameters).toEqual({ message_id: first.telegramMessageIds[0], allow_sending_without_reply: true });
    ctx.host.emit(final(ctx.host.gen));
    await ctx.bot.idle();
  });

  it('超过 48 小时：不尝试删除，直接标注', async () => {
    let now = 1_000_000;
    const ctx = setup({ now: () => now });
    await oneRound(ctx);
    now += 49 * 3600_000;
    await ctx.bot.handleUpdate(text('/regen'));
    await wait(5);
    expect(ctx.telegram.of('deleteMessage')).toHaveLength(0);
    expect(ctx.telegram.texts().at(-1)).toBe(REGENERATED_NOTE);
    ctx.host.emit(final(ctx.host.gen));
    await ctx.bot.idle();
  });

  it('页面拒绝（聊天已切换等）：说明原因，不删除旧消息', async () => {
    const ctx = setup();
    await oneRound(ctx);
    ctx.host.onRequest = async (cmd) => {
      if (cmd.type === 'regenerate') throw new Error('上一条回复已不是聊天里的最后一条');
      return {};
    };
    await ctx.bot.handleUpdate(text('/regen'));
    await ctx.bot.idle();
    expect(ctx.telegram.texts().at(-1)).toBe('❌ 重新生成失败：上一条回复已不是聊天里的最后一条');
    expect(ctx.telegram.of('deleteMessage')).toHaveLength(0);
    expect(ctx.store.lastReply(7)).toBeTruthy();
  });

  it('生成中 /regen、/chars：提示忙碌', async () => {
    const ctx = setup();
    await ctx.bot.handleUpdate(text('hi'));
    await wait(5);
    await ctx.bot.handleUpdate(text('/regen'));
    await ctx.bot.handleUpdate(text('/chars'));
    expect(ctx.telegram.texts()).toEqual([BUSY_COMMAND_TEXT, BUSY_COMMAND_TEXT]);
    ctx.host.emit(final(ctx.host.gen));
    await ctx.bot.idle();
  });
});

describe('/chars、/chats、/new', () => {
  const chars = Array.from({ length: 11 }, (_, i) => ({ avatar: `c${i}.png`, name: `角色${i}` }));
  const chats = [
    { fileName: 'A - 1', lastMessageAt: Date.UTC(2026, 10, 7, 9, 0), messageCount: 5, preview: '最后一句' },
    { fileName: 'A - 2', messageCount: 1 },
  ];
  const withHost = (ctx: ReturnType<typeof setup>) => {
    ctx.host.onRequest = async (cmd) => {
      switch (cmd.type) {
        case 'getStatus':
          return { app: 'st', characterAvatar: 'c1.png', chatId: 'A - 1', generating: false };
        case 'listCharacters':
          return chars;
        case 'listChats':
          return chats;
        case 'selectCharacter':
          return { characterName: '角色10', characterAvatar: cmd.characterId, chatId: 'B - 1' };
        case 'openChat':
          return { characterName: '角色1', characterAvatar: 'c1.png', chatId: cmd.fileName };
        case 'newChat':
          return { characterName: '角色1', characterAvatar: 'c1.png', chatId: 'A - 3' };
        default:
          return {};
      }
    };
  };
  const keyboard = (c: Call) => (c.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
  const tap = (ctx: ReturnType<typeof setup>, data: string, messageId = 900): Promise<void> =>
    ctx.bot.handleUpdate({ update_id: ++uid, callback_query: { id: `q${uid}`, from: { id: 1 }, data, message: { message_id: messageId, chat: { id: 7, type: 'private' } } } });

  it('/chars：分页按钮，标注当前角色；翻页；选中后切换并记住会话', async () => {
    const ctx = setup();
    withHost(ctx);
    await ctx.bot.handleUpdate(text('/chars'));
    const list = ctx.telegram.of('sendMessage').at(-1)!;
    expect(list.params.text).toMatch(/共 11 个，第 1\/2 页/);
    const kb = keyboard(list);
    expect(kb).toHaveLength(9);
    expect(kb[1][0].text).toBe('✅ 角色1');
    expect(kb[8].map((b) => b.text)).toEqual(['下一页 ➡️']);
    await tap(ctx, kb[8][0].callback_data);
    const edited = ctx.telegram.of('editMessageText').at(-1)!;
    expect(edited.params.text).toMatch(/第 2\/2 页/);
    const page2 = keyboard(edited);
    expect(page2.map((r) => r[0].text)).toEqual(['角色8', '角色9', '角色10', '⬅️ 上一页']);
    await tap(ctx, page2[2][0].callback_data);
    expect(ctx.host.requests.at(-1)).toEqual({ type: 'selectCharacter', characterId: 'c10.png' });
    expect(ctx.store.session).toEqual({ characterAvatar: 'c10.png', chatId: 'B - 1' });
    expect(ctx.telegram.of('editMessageText').at(-1)!.params.text).toMatch(/已切换到角色：角色10\n💬 当前聊天：B - 1/);
    // 选过之后列表作废
    await tap(ctx, page2[0][0].callback_data);
    expect(ctx.telegram.of('answerCallbackQuery').at(-1)!.params.text).toMatch(/已过期/);
  });

  it('切换后，后续消息进入新聊天：回复记录的是新聊天', async () => {
    const ctx = setup();
    withHost(ctx);
    await ctx.bot.handleUpdate(text('/chats'));
    const kb = keyboard(ctx.telegram.of('sendMessage').at(-1)!);
    expect(kb[0][0].text).toMatch(/^✅ \d\d-\d\d \d\d:\d\d · 5 条 · 最后一句$/);
    expect(kb[1][0].text).toBe('1 条 · A - 2');
    await tap(ctx, kb[1][0].callback_data);
    expect(ctx.host.requests.at(-1)).toEqual({ type: 'openChat', fileName: 'A - 2' });
    expect(ctx.store.session).toEqual({ characterAvatar: 'c1.png', chatId: 'A - 2' });
    await oneRound(ctx, 'hi', { chatId: 'A - 2', messageId: 1 });
    expect(ctx.store.lastReply(7)).toMatchObject({ stChatId: 'A - 2' });
  });

  it('/new：新建聊天并记住', async () => {
    const ctx = setup();
    withHost(ctx);
    await ctx.bot.handleUpdate(text('/new'));
    expect(ctx.host.requests.at(-1)).toEqual({ type: 'newChat' });
    expect(ctx.telegram.texts().at(-1)).toMatch(/已新建聊天：A - 3/);
    expect(ctx.store.session).toEqual({ characterAvatar: 'c1.png', chatId: 'A - 3' });
  });

  it('切换失败：提示原因，不改会话', async () => {
    const ctx = setup();
    ctx.host.onRequest = async (cmd) => {
      if (cmd.type === 'newChat') throw new Error('ST 当前没有选择角色');
      return {};
    };
    await ctx.bot.handleUpdate(text('/new'));
    expect(ctx.telegram.texts().at(-1)).toBe('❌ /new 失败：ST 当前没有选择角色');
    expect(ctx.store.session).toBeUndefined();
    expect(ctx.bot.busy).toBe(false);
  });

  it('切换进行中发文字：提示忙碌', async () => {
    const ctx = setup();
    let release!: () => void;
    ctx.host.onRequest = async (cmd) => (cmd.type === 'newChat' ? new Promise((r) => (release = () => r({ chatId: 'x' }))) : {});
    const p = ctx.bot.handleUpdate(text('/new'));
    await wait(5);
    await ctx.bot.handleUpdate(text('你好'));
    expect(ctx.telegram.texts()).toEqual([BUSY_TEXT]);
    release();
    await p;
  });

  it('浏览器重启后：先把页面恢复到记住的角色和聊天，再发送', async () => {
    const ctx = setup();
    ctx.store.session = { characterAvatar: 'c5.png', chatId: 'E - 2' };
    const seen: string[] = [];
    ctx.host.onRequest = async (cmd) => {
      seen.push(cmd.type);
      if (cmd.type === 'getStatus') return seen.includes('selectCharacter') ? { characterAvatar: 'c5.png', chatId: 'E - 1' } : { characterAvatar: 'c1.png', chatId: 'A - 1' };
      return {};
    };
    await ctx.bot.handleUpdate(text('hi'));
    await wait(10);
    expect(seen).toEqual(['getStatus', 'selectCharacter', 'getStatus', 'openChat', 'send']);
    expect(ctx.host.requests.find((r) => r.type === 'openChat')).toEqual({ type: 'openChat', fileName: 'E - 2' });
    ctx.host.emit(final(ctx.host.gen, { chatId: 'E - 2' }));
    await ctx.bot.idle();
    // 同一次启动内不再重复恢复
    seen.length = 0;
    await ctx.bot.handleUpdate(text('again'));
    await wait(5);
    expect(seen).toEqual(['send']);
    ctx.host.emit(final(ctx.host.gen, { chatId: 'E - 2', messageId: 5 }));
    await ctx.bot.idle();
    // 换了一次启动（startedAt 变了）才再恢复
    ctx.browser.startedAt = 2;
    seen.length = 0;
    await ctx.bot.handleUpdate(text('after restart'));
    await wait(5);
    expect(seen[0]).toBe('getStatus');
    ctx.host.emit(final(ctx.host.gen, { chatId: 'E - 2', messageId: 7 }));
    await ctx.bot.idle();
  });
});

describe('/preset 与开场白', () => {
  const presets = ['Default', '破限 A', '破限 B'];
  const keyboard = (c: Call) => (c.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
  const tap = (ctx: ReturnType<typeof setup>, data: string, messageId = 900): Promise<void> =>
    ctx.bot.handleUpdate({ update_id: ++uid, callback_query: { id: `q${uid}`, from: { id: 1 }, data, message: { message_id: messageId, chat: { id: 7, type: 'private' } } } });

  it('/preset：列出预设并标注当前；点选后切换，列表作废', async () => {
    const ctx = setup();
    ctx.host.onRequest = async (cmd) => {
      if (cmd.type === 'getStatus') return { app: 'st', generating: false };
      if (cmd.type === 'listPresets') return { api: 'openai', current: '破限 A', presets };
      if (cmd.type === 'selectPreset') return { presetName: cmd.name };
      return {};
    };
    await ctx.bot.handleUpdate(text('/preset'));
    const list = ctx.telegram.of('sendMessage').at(-1)!;
    expect(list.params.text).toMatch(/选择预设（共 3 个/);
    const kb = keyboard(list);
    expect(kb.map((r) => r[0].text)).toEqual(['Default', '✅ 破限 A', '破限 B']);
    await tap(ctx, kb[2][0].callback_data);
    expect(ctx.host.requests.at(-1)).toEqual({ type: 'selectPreset', name: '破限 B' });
    expect(ctx.telegram.of('editMessageText').at(-1)!.params.text).toMatch(/已切换到预设：破限 B/);
    await tap(ctx, kb[0][0].callback_data);
    expect(ctx.telegram.of('answerCallbackQuery').at(-1)!.params.text).toMatch(/已过期/);
  });

  it('/preset：先刷新无头页面再列出预设', async () => {
    const ctx = setup();
    ctx.host.onRequest = async (cmd) => (cmd.type === 'listPresets' ? { api: 'openai', current: 'Default', presets } : { app: 'st', generating: false });
    await ctx.bot.handleUpdate(text('/preset'));
    const types = ctx.host.requests.map((r) => r.type);
    expect(types.indexOf('refreshPage')).toBeGreaterThan(-1);
    expect(types.indexOf('refreshPage')).toBeLessThan(types.indexOf('listPresets'));
    expect(ctx.telegram.of('sendMessage').at(-1)!.params.text).toMatch(/选择预设（共 3 个/);
  });

  it('刷新页面后把角色和聊天恢复到 bot 记着的那个', async () => {
    const ctx = setup();
    ctx.store.session = { characterAvatar: 'c5.png', chatId: 'E - 2' };
    const seen: string[] = [];
    let reloaded = false;
    ctx.host.onRequest = async (cmd) => {
      seen.push(cmd.type);
      if (cmd.type === 'refreshPage') reloaded = true;
      if (cmd.type === 'getStatus') {
        // 重载后页面回到 ST 记录的最近角色，但聊天不是 bot 记着的那个
        return reloaded && !seen.includes('selectCharacter') ? { characterAvatar: 'c5.png', chatId: 'E - 1' } : { characterAvatar: 'c5.png', chatId: 'E - 2' };
      }
      if (cmd.type === 'listCharacters') return [{ avatar: 'c5.png', name: 'E' }];
      return {};
    };
    ctx.browser.startedAt = 1;
    await ctx.bot.handleUpdate(text('/chars'));
    expect(seen.indexOf('refreshPage')).toBeGreaterThan(-1);
    const open = ctx.host.requests.find((r) => r.type === 'openChat');
    expect(open).toEqual({ type: 'openChat', fileName: 'E - 2' });
    expect(seen.indexOf('openChat')).toBeLessThan(seen.indexOf('listCharacters'));
  });

  it('/chats 不刷新页面', async () => {
    const ctx = setup();
    ctx.host.onRequest = async (cmd) => (cmd.type === 'listChats' ? [] : { app: 'st', characterName: 'A', generating: false });
    await ctx.bot.handleUpdate(text('/chats'));
    expect(ctx.host.requests.map((r) => r.type)).not.toContain('refreshPage');
  });

  it('/preset：刷新失败时仍用现有数据列出', async () => {
    const ctx = setup();
    ctx.host.onRequest = async (cmd) => {
      if (cmd.type === 'refreshPage') throw new Error('正在生成，暂不刷新页面');
      if (cmd.type === 'listPresets') return { api: 'openai', current: 'Default', presets };
      return { app: 'st', generating: false };
    };
    await ctx.bot.handleUpdate(text('/preset'));
    expect(ctx.telegram.of('sendMessage').at(-1)!.params.text).toMatch(/选择预设（共 3 个/);
  });

  it('当前 API 没有预设：提示原因', async () => {
    const ctx = setup();
    ctx.host.onRequest = async (cmd) => {
      if (cmd.type === 'listPresets') throw new Error('当前 API 没有可切换的预设');
      return { generating: false };
    };
    await ctx.bot.handleUpdate(text('/preset'));
    expect(ctx.telegram.texts().at(-1)).toBe('❌ /preset 失败：当前 API 没有可切换的预设');
  });

  it('/status 显示预设名', async () => {
    const ctx = setup();
    ctx.host.onRequest = async () => ({ app: 'st', characterName: 'A', presetName: '破限 A', generating: false });
    await ctx.bot.handleUpdate(text('/status'));
    expect(ctx.telegram.texts()[0]).toMatch(/预设：破限 A/);
  });

  it('/new 后发送开场白，同一聊天只发一次', async () => {
    const ctx = setup();
    ctx.host.onRequest = async (cmd) =>
      cmd.type === 'newChat' ? { characterName: 'A', characterAvatar: 'a.png', chatId: 'A - 9', greeting: { html: '<p>欢迎来到这里</p>', text: '欢迎来到这里' } } : {};
    await ctx.bot.handleUpdate(text('/new'));
    expect(ctx.telegram.rich().join('')).toMatch(/欢迎来到这里/);
    const n = ctx.telegram.rich().length;
    await ctx.bot.handleUpdate(text('/new'));
    expect(ctx.telegram.rich()).toHaveLength(n);
  });

  it('没有 greeting 字段（已有对话的聊天）：不发送', async () => {
    const ctx = setup();
    ctx.host.onRequest = async (cmd) => (cmd.type === 'newChat' ? { chatId: 'A - 9' } : {});
    await ctx.bot.handleUpdate(text('/new'));
    expect(ctx.telegram.rich()).toHaveLength(0);
  });
});

describe('/menu 与命令菜单', () => {
  const keyboard = (c: Call) => (c.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
  const tap = (ctx: ReturnType<typeof setup>, data: string): Promise<void> =>
    ctx.bot.handleUpdate({ update_id: ++uid, callback_query: { id: `q${uid}`, from: { id: 1 }, data, message: { message_id: 900, chat: { id: 7, type: 'private' } } } });

  it('/menu：速览行加六个按钮；不唤醒浏览器', async () => {
    const ctx = setup();
    ctx.host.onRequest = async () => ({ characterName: '角色A', chatId: 'A - 1', presetName: '破限 A', generating: false });
    await ctx.bot.handleUpdate(text('/menu'));
    const m = ctx.telegram.of('sendMessage').at(-1)!;
    expect(m.params.text).toBe('📋 主菜单\n角色A · A - 1 · 破限 A');
    expect(keyboard(m).flat().map((b) => b.callback_data)).toEqual(['m|chars', 'm|chats', 'm|preset', 'm|new', 'm|regen', 'm|status', 'm|settings']);
    expect(ctx.browser.ensureCalls).toBe(0);
  });

  it('页面未连接时 /menu 只有标题', async () => {
    const ctx = setup();
    ctx.host.connected = false;
    await ctx.bot.handleUpdate(text('/menu'));
    expect(ctx.telegram.of('sendMessage').at(-1)!.params.text).toBe('📋 主菜单');
  });

  it('菜单按钮等同于发送对应命令', async () => {
    const ctx = setup();
    ctx.host.onRequest = async (cmd) => (cmd.type === 'listPresets' ? { api: 'openai', current: 'A', presets: ['A', 'B'] } : { generating: false });
    await tap(ctx, 'm|preset');
    expect(ctx.telegram.of('sendMessage').at(-1)!.params.text).toMatch(/选择预设/);
    await tap(ctx, 'm|new');
    expect(ctx.host.requests.at(-1)).toEqual({ type: 'newChat' });
    await tap(ctx, 'm|regen');
    expect(ctx.telegram.texts().at(-1)).toBe(NOTHING_TO_REGEN_TEXT);
    await tap(ctx, 'm|bogus');
    expect(ctx.telegram.of('answerCallbackQuery').at(-1)!.params.text).toMatch(/已过期/);
  });

  it('命令菜单覆盖全部命令且描述非空', () => {
    expect(BOT_COMMANDS.map((c) => c.command)).toEqual(['menu', 'chars', 'chats', 'preset', 'new', 'regen', 'settings', 'stop', 'status', 'help']);
    expect(BOT_COMMANDS.every((c) => c.description.length > 0 && c.description.length <= 256)).toBe(true);
  });
});

describe('行动选项按钮', () => {
  const keyboard = (c: Call) => (c.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
  const tap = (ctx: ReturnType<typeof setup>, data: string, messageId = 901): Promise<void> =>
    ctx.bot.handleUpdate({ update_id: ++uid, callback_query: { id: `q${uid}`, from: { id: 1 }, data, message: { message_id: messageId, chat: { id: 7, type: 'private' } } } });
  const raw = '她看着你。\n<SUOT>\n1. 去酒馆\n2. 回家\n3. 沉默\n</SUOT>';
  const round = (ctx: ReturnType<typeof setup>, over: Partial<Extract<HostEvent, { type: 'messageFinal' }>> = {}) =>
    oneRound(ctx, 'hi', { html: '<p>她看着你。</p><suot>1. 去酒馆</suot>', text: raw, raw, ...over });

  it('选项消息上的 🔄：重新生成上一条回复，选项消息改成已重新生成', async () => {
    const ctx = setup();
    await round(ctx);
    const m = ctx.telegram.of('sendMessage').at(-1)!;
    const regen = keyboard(m).flat().at(-1)!;
    expect(regen.text).toBe('🔄 重新生成');
    await tap(ctx, regen.callback_data);
    await wait(5);
    expect(ctx.host.requests.at(-1)).toMatchObject({ type: 'regenerate', chatId: 'chat-A' });
    expect(ctx.telegram.of('editMessageText').at(-1)!.params.text).toBe('🔄 已重新生成上一条回复');
    // 同一组选项不能再点
    await tap(ctx, regen.callback_data);
    expect(ctx.telegram.of('answerCallbackQuery').at(-1)!.params.text).toMatch(/已过期/);
  });

  it('choiceLayout=rows：每个选项一行，最后一行是 🔄', async () => {
    const ctx = setup({ choiceLayout: 'rows' });
    await round(ctx);
    const kb = keyboard(ctx.telegram.of('sendMessage').at(-1)!);
    expect(kb.map((r) => r.map((b) => b.text))).toEqual([['1. 去酒馆'], ['2. 回家'], ['3. 沉默'], ['🔄 重新生成']]);
  });

  it('正文去掉选项块；下面一条带按钮的选项消息；点击后把该选项作为用户消息发出', async () => {
    const ctx = setup();
    await round(ctx);
    expect(ctx.telegram.rich().join('')).not.toMatch(/suot|去酒馆/i);
    const m = ctx.telegram.of('sendMessage').at(-1)!;
    expect(m.params.text).toMatch(/行动选项[\s\S]*1\. 去酒馆\n2\. 回家\n3\. 沉默/);
    const kb = keyboard(m);
    expect(kb.flat().map((b) => b.text)).toEqual(['1', '2', '3', '🔄 重新生成']);
    await tap(ctx, kb[0][1].callback_data);
    await wait(5);
    expect(ctx.host.requests.at(-1)).toMatchObject({ type: 'send', text: '回家' });
    expect(ctx.telegram.of('editMessageText').at(-1)!.params).toMatchObject({ message_id: 901, text: '✅ 已选择 2：回家' });
    ctx.host.emit(final(ctx.host.gen, { chatId: 'chat-A', messageId: 5 }));
    await ctx.bot.idle();
  });

  it('选完后旧按钮失效；新回复让旧按钮失效', async () => {
    const ctx = setup();
    await round(ctx);
    const data = keyboard(ctx.telegram.of('sendMessage').at(-1)!)[0][0].callback_data;
    await ctx.bot.handleUpdate(text('自己打字'));
    await wait(5);
    ctx.host.emit(final(ctx.host.gen, { messageId: 5 }));
    await ctx.bot.idle();
    await tap(ctx, data);
    expect(ctx.telegram.of('answerCallbackQuery').at(-1)!.params.text).toMatch(/已过期/);
    expect(ctx.host.requests.filter((r) => r.type === 'send')).toHaveLength(2);
  });

  it('/chars 只是列出列表，不会让选项作废', async () => {
    const ctx = setup();
    await round(ctx);
    const data = keyboard(ctx.telegram.of('sendMessage').at(-1)!)[0][0].callback_data;
    await ctx.bot.handleUpdate(text('/chars'));
    await tap(ctx, data);
    expect(ctx.telegram.of('answerCallbackQuery').at(-1)!.params.text).toBeUndefined();
    expect(ctx.host.requests.filter((r) => r.type === 'send')).toHaveLength(2);
    ctx.host.emit(final(ctx.host.gen, { chatId: 'chat-A', messageId: 5 }));
    await ctx.bot.idle();
  });

  it('连点两次同一个按钮只发出一次', async () => {
    const ctx = setup();
    await round(ctx);
    const data = keyboard(ctx.telegram.of('sendMessage').at(-1)!)[0][0].callback_data;
    await Promise.all([tap(ctx, data), tap(ctx, data)]);
    await wait(5);
    expect(ctx.host.requests.filter((r) => r.type === 'send')).toHaveLength(2);
    ctx.host.emit(final(ctx.host.gen, { chatId: 'chat-A', messageId: 5 }));
    await ctx.bot.idle();
  });

  it('/new 之后旧选项失效', async () => {
    const ctx = setup();
    await round(ctx);
    const data = keyboard(ctx.telegram.of('sendMessage').at(-1)!)[0][0].callback_data;
    ctx.host.onRequest = async (cmd) => (cmd.type === 'newChat' ? { chatId: 'x' } : {});
    await ctx.bot.handleUpdate(text('/new'));
    await tap(ctx, data);
    expect(ctx.telegram.of('answerCallbackQuery').at(-1)!.params.text).toMatch(/已过期/);
  });

  it('没有选项的回复、停止的回复：不出按钮', async () => {
    const ctx = setup();
    await oneRound(ctx, 'hi', { html: '<p>普通回复</p>', text: '普通回复', raw: '普通回复' });
    expect(ctx.telegram.of('sendMessage').filter((c) => c.params.reply_markup)).toHaveLength(0);
    await round(ctx, { stopped: true });
    expect(ctx.telegram.of('sendMessage').filter((c) => c.params.reply_markup)).toHaveLength(0);
  });

  it('旧页面不上报 raw：不解析，正文原样', async () => {
    const ctx = setup();
    await oneRound(ctx, 'hi', { html: '<p>你好</p>', text: raw, raw: undefined });
    expect(ctx.telegram.of('sendMessage').filter((c) => c.params.reply_markup)).toHaveLength(0);
  });
});

describe('日志', () => {
  it('关键节点有 info 日志，但不含消息内容和 token', async () => {
    const ctx = setup();
    const secret = '这是用户的私密消息内容';
    await oneRound(ctx, secret, { html: '<p>角色的私密回复</p>', text: '角色的私密回复' });
    await ctx.bot.handleUpdate(text('/status'));
    const out = ctx.log.lines.join('\n');
    expect(out).toMatch(/收到消息 update=\d+ 长度=11/);
    expect(out).toMatch(/开始生成 gen=/);
    expect(out).toMatch(/生成完成 gen=\S+ 用时 [\d.]+ 秒，回复 7 字符/);
    expect(out).toMatch(/正式消息已发出 1 段，方式=rich/);
    expect(out).toMatch(/收到命令 \/status/);
    expect(out).not.toContain(secret);
    expect(out).not.toContain('私密回复');
    expect(out).not.toContain(FAKE_TOKEN);
  });
});

describe('/settings', () => {
  const keyboard = (c: Call) => (c.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
  const tap = (ctx: ReturnType<typeof setup>, data: string): Promise<void> =>
    ctx.bot.handleUpdate({ update_id: ++uid, callback_query: { id: `q${uid}`, from: { id: 1 }, data, message: { message_id: 950, chat: { id: 7, type: 'private' } } } });
  const makeSettings = () => {
    const values = { dialogueStyle: 'bold', draftMode: 'live', draftIntervalSeconds: 1, choiceLayout: 'numbers' };
    const saved: Array<Record<string, unknown>> = [];
    return {
      values,
      saved,
      settings: {
        get: () => ({ ...values }),
        set: (p: Record<string, unknown>) => {
          if (p.draftIntervalSeconds === 999) throw new Error('不合法');
          saved.push(p);
          Object.assign(values, p);
        },
      },
    };
  };

  it('列出当前值；点按钮切到下一个值并保存，消息原地更新', async () => {
    const s = makeSettings();
    const ctx = setup({ settings: s.settings });
    await ctx.bot.handleUpdate(text('/settings'));
    const m = ctx.telegram.of('sendMessage').at(-1)!;
    expect(keyboard(m).map((r) => r[0].text)).toEqual(['🗨️ 对话样式：加粗', '👀 生成时预览：逐步显示正文', '⏱️ 预览刷新间隔：1 秒', '🎲 行动选项按钮：一排数字']);
    await tap(ctx, 's|1');
    await tap(ctx, 's|2');
    await tap(ctx, 's|3');
    expect(s.saved).toEqual([{ draftMode: 'progress' }, { draftIntervalSeconds: 2 }, { choiceLayout: 'rows' }]);
    const edit = ctx.telegram.of('editMessageText').at(-1)!;
    expect(keyboard(edit).map((r) => r[0].text)).toEqual(['🗨️ 对话样式：加粗', '👀 生成时预览：只显示进度', '⏱️ 预览刷新间隔：2 秒', '🎲 行动选项按钮：每项一行']);
  });

  it('保存失败：提示原因，不改消息', async () => {
    const s = makeSettings();
    s.values.draftIntervalSeconds = 999;
    s.settings.set = () => {
      throw new Error('写入失败');
    };
    const ctx = setup({ settings: s.settings });
    await tap(ctx, 's|2');
    expect(ctx.telegram.of('answerCallbackQuery').at(-1)!.params.text).toMatch(/保存失败：写入失败/);
    expect(ctx.telegram.of('editMessageText')).toHaveLength(0);
  });

  it('没有启用设置功能时给出提示', async () => {
    const ctx = setup();
    await ctx.bot.handleUpdate(text('/settings'));
    expect(ctx.telegram.texts().at(-1)).toMatch(/没有启用设置/);
  });

  it('生成时预览为 progress：草稿只显示进度', async () => {
    const ctx = setup({ draftMode: 'progress' });
    ctx.host.onRequest = async () => ({ generationId: 'x' });
    await ctx.bot.handleUpdate(text('hi'));
    await wait(5);
    ctx.host.emit({ type: 'streamText', generationId: ctx.host.gen, text: '她看着你，一言不发。' } as HostEvent);
    await wait(60);
    const draft = ctx.telegram.of('sendMessageDraft').at(-1)!;
    expect(draft.params.text).toMatch(/^✍️ 正在生成… 已写 \d+ 字$/);
    ctx.host.emit(final(ctx.host.gen));
    await ctx.bot.idle();
  });
});
