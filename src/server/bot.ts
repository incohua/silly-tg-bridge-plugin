// Telegram 更新路由：命令、文字消息转 send、忙碌提示、流式草稿、正式消息、停止、重新生成、角色和聊天切换。
// 白名单在 plugin.ts 的轮询回调里已经过滤（含 callback_query 和 stopped_message_generation），到这里的 update 都来自允许的用户。
//
// 流式：sendMessageDraft（chat_id、非零 draft_id、text 0–4096、can_stop、keep_on_stop），同一 draft_id 连续更新，约每秒一次。
// 草稿是纯文本预览，可丢弃（不重试 429）。没收到流式文本之前（API 不支持流式或还在组装提示词）每 4.5 秒发一次 typing。
// 停止：/stop 或草稿上的停止按钮（stopped_message_generation 更新），已生成部分作为正式消息保留。
// 正式消息：扩展上报的渲染 HTML 经 rich-html 转换后用 sendRichMessage 分段发送，失败逐级回退纯文本，见 deliver.ts。
// 429 按 retry_after 重试（TelegramClient 默认行为）。
// 日志只记长度、id、耗时和结果，不记消息内容、角色名和聊天名。

import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { CharacterInfo, ChatInfo, HostCommandInput, HostEvent, Greeting, HostStatus, PresetList, SwitchResult } from '../shared/protocol';
import { clampPage, decodeCallback, listKeyboard, listTitle, PAGE_SIZE, type ListKind, type Listing } from './bot-lists';
import type { BrowserState } from './browser';
import { choicesKeyboard, choicesText, decodeChoiceCallback, DEFAULT_RULES, compileRules, parseChoices, type CompiledChoiceRule } from './choices';
import { deliverFinal } from './deliver';
import type { Logger } from './logger';
import type { ReplyRecord, SessionRecord } from './message-map';
import type { PluginStatus } from './plugin';
import type { CallOptions, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from './telegram';
import { TelegramApiError } from './telegram';
import { streamPreview } from './text';
import type { DialogueStyle } from '../shared/rich-html';

export interface BotTelegram {
  call<T = unknown>(method: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<T>;
  sendMessage(params: { chat_id: number; text: string; [k: string]: unknown }, opts?: CallOptions): Promise<TelegramMessage>;
  editMessageText(params: { chat_id: number; message_id: number; text: string; [k: string]: unknown }, opts?: CallOptions): Promise<unknown>;
  deleteMessage(chat_id: number, message_id: number, opts?: CallOptions): Promise<boolean>;
  sendChatAction(chat_id: number, action: string, opts?: CallOptions): Promise<boolean>;
  answerCallbackQuery(params: { callback_query_id: string; text?: string }, opts?: CallOptions): Promise<boolean>;
}

export interface BotHost {
  request<T = unknown>(cmd: HostCommandInput, timeoutMs?: number): Promise<T>;
  onEvent(fn: (e: HostEvent) => void): () => void;
  onConnectionChange(fn: (connected: boolean) => void): () => void;
  readonly connected: boolean;
  readonly hello: { stVersion: string; hasTavernHelper: boolean } | null;
}

export interface BotBrowser {
  ensureRunning(): Promise<void>;
  acquire(): () => void;
  touch(): void;
  readonly state: BrowserState;
  readonly pid?: number;
  readonly lastError?: string;
  /** 本次启动完成的时间；每次重启都会变，用来判断是否需要恢复会话。 */
  readonly startedAt?: number;
}

/** 消息映射和会话（message-map.ts 的 BridgeStore 实现）。 */
export interface BotStore {
  lastReply(telegramChatId: number): ReplyRecord | undefined;
  recordReply(r: ReplyRecord): void;
  removeReply(r: ReplyRecord): void;
  readonly session: SessionRecord | undefined;
  setSession(s: SessionRecord): void;
  /** 标记聊天已发过开场白；第一次返回 true。 */
  markGreeted(stChatId: string): boolean;
}

export interface BotOptions {
  telegram: BotTelegram;
  host: BotHost;
  browser: BotBrowser;
  store: BotStore;
  status: PluginStatus;
  log: Logger;
  now?: () => number;
  /** /status 显示用。 */
  idleShutdownMinutes?: number;
  /** 对话样式，默认 plain（只保留引号）；插件配置默认 bold。 */
  dialogueStyle?: DialogueStyle;
  /** /status 显示看门狗状态。 */
  watchdogStatus?: () => string | undefined;
  /** 草稿更新最小间隔，默认 1000 毫秒。 */
  draftIntervalMs?: number;
  /** typing 重发间隔，默认 4500 毫秒（Telegram 的 typing 状态约持续 5 秒）。 */
  typingIntervalMs?: number;
  /** 一轮生成中超过这么久没有任何进展就放弃，默认 10 分钟。 */
  turnIdleTimeoutMs?: number;
  /** 页面断开后等它重连的时间，默认 15 秒。 */
  disconnectGraceMs?: number;
  /** send 命令的 rpc 超时（页面队列里可能有别的操作），默认 120 秒。 */
  sendRpcTimeoutMs?: number;
  /** 切换类命令的 rpc 超时，默认 90 秒。 */
  switchRpcTimeoutMs?: number;
  /** 选项解析规则（热加载由调用方负责，每条回复读一次）。默认只有内置规则。 */
  choiceRules?: () => readonly CompiledChoiceRule[];
  /** 正式消息发出后回调（消息映射已在内部写入 store，这里供额外用途）。 */
  onDelivered?: (info: DeliveredReply) => void;
}

export interface DeliveredReply {
  telegramChatId: number;
  generationId: string;
  stChatId: string;
  stMessageId: number;
  telegramMessageIds: number[];
}

export const HELP_TEXT = [
  '在这里和 SillyTavern 里当前打开的角色聊天。直接发文字即可。',
  '',
  '/stop 停止生成（也可以点流式预览上的停止按钮），已生成的部分会保留',
  '/regen 重新生成上一条回复',
  '/chars 选择角色',
  '/chats 选择当前角色的聊天',
  '/preset 切换预设',
  '/new 为当前角色新建聊天',
  '/menu 打开主菜单（角色、聊天、预设等一键入口）',
  '/status 查看无头浏览器、ST 页面和当前角色',
  '/help 显示这段说明',
].join('\n');

/** 注册到 Telegram 命令菜单的命令（setMyCommands），顺序即显示顺序。 */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'menu', description: '主菜单：角色、聊天、预设等一键入口' },
  { command: 'chars', description: '选择角色' },
  { command: 'chats', description: '选择当前角色的聊天' },
  { command: 'preset', description: '切换预设' },
  { command: 'new', description: '为当前角色新建聊天' },
  { command: 'regen', description: '重新生成上一条回复' },
  { command: 'stop', description: '停止生成' },
  { command: 'status', description: '查看运行状态' },
  { command: 'help', description: '显示命令说明' },
];

/** /menu 的按钮：callback_data 为 m|<动作>，动作对应同名命令。 */
export const MENU_ACTIONS = ['chars', 'chats', 'preset', 'new', 'regen', 'status'] as const;
export type MenuAction = (typeof MENU_ACTIONS)[number];
const MENU_LABELS: Record<MenuAction, string> = { chars: '角色', chats: '聊天', preset: '预设', new: '新建聊天', regen: '重新生成', status: '状态' };

export function menuKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
  const btn = (a: MenuAction) => ({ text: MENU_LABELS[a], callback_data: `m|${a}` });
  return [[btn('chars'), btn('chats'), btn('preset')], [btn('new'), btn('regen'), btn('status')]];
}

export function decodeMenuCallback(data: string | undefined): MenuAction | null {
  const m = /^m\|([a-z]+)$/.exec(data ?? '');
  return m && (MENU_ACTIONS as readonly string[]).includes(m[1]) ? (m[1] as MenuAction) : null;
}

export const BUSY_TEXT = '上一条消息还在生成回复，请等它完成后再发。这条消息没有发送给角色。';
export const BUSY_COMMAND_TEXT = '正在生成回复或切换中，请等它完成（或先 /stop）再执行这个命令。';
export const COLD_START_TEXT = '正在启动无头浏览器，稍候…';
export const NOTHING_TO_STOP_TEXT = '当前没有正在生成的回复。';
export const NOTHING_TO_REGEN_TEXT = '没有可以重新生成的回复。只能重新生成 bot 在这里发出的上一条回复。';
export const REGENERATED_NOTE = '（这条回复已重新生成，新的回复在下面）';

/** Telegram 只允许 bot 删除 48 小时内的消息。 */
const DELETE_WINDOW_MS = 48 * 3600_000;
const MAX_LISTINGS = 10;

/** 解析 /cmd@bot args。不是命令返回 null。 */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() } : null;
}

type TurnResult =
  | { kind: 'final'; html: string; text: string; raw?: string; stopped: boolean; stChatId: string; stMessageId: number }
  | { kind: 'stopped' }
  | { kind: 'failed'; reason: string }
  | { kind: 'lost'; reason: string };

type TurnRequest = { kind: 'send'; text: string } | { kind: 'regenerate'; previous: ReplyRecord };

interface Turn {
  chatId: number;
  generationId: string;
  draftId: number;
  kind: TurnRequest['kind'];
  /** starting：等浏览器；requesting：命令已发出、等页面确认；running：生成中。 */
  phase: 'starting' | 'requesting' | 'running';
  /** 在 starting 阶段收到停止：不再发给 ST。 */
  cancelled: boolean;
  /** 在 requesting 阶段收到停止：页面确认后立即停止。 */
  stopRequested: boolean;
  promise: Promise<void>;
}

const short = (id: string): string => id.slice(0, 8);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Bot {
  private turn: Turn | null = null;
  /** 切换角色、列表等非生成操作进行中（与生成互斥）。 */
  private op: string | null = null;
  private nextDraftId = randomInt(1, 1_000_000_000);
  private draftsDisabled = false;
  private readonly lists = new Map<string, Listing>();
  /** 最新一条回复的行动选项；新消息、重新生成、切换角色/聊天后作废。 */
  private choiceSet: { token: string; items: string[] } | null = null;
  private readonly defaultRules = compileRules(DEFAULT_RULES).rules;
  private sessionKey: number | undefined;
  private sessionPromise: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly opts: BotOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** 当前一轮生成结束（测试和退出时用）。 */
  async idle(): Promise<void> {
    while (this.turn) await this.turn.promise;
  }

  get busy(): boolean {
    return this.turn !== null || this.op !== null;
  }

  /** 处理一个白名单 update。不等待生成完成，轮询循环不会被一轮生成卡住。 */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const { log } = this.opts;
    if (update.callback_query) return this.handleCallback(update.callback_query);
    if (update.stopped_message_generation) {
      const s = update.stopped_message_generation;
      log.info(
        `收到停止按钮 update=${update.update_id} draft_id=${String(s.draft_id)}（${typeof s.draft_id}） 当前草稿=${this.turn ? this.turn.draftId : '无'}`,
      );
      // Telegram 回传的 draft_id 是字符串，发送时是数字，按字符串比较。
      if (this.turn && String(this.turn.draftId) === String(s.draft_id)) await this.requestStop(s.chat.id, 'button');
      else log.info('停止按钮对应的生成已结束，忽略');
      return;
    }
    const msg = update.message;
    if (!msg) {
      log.debug(`忽略 update ${update.update_id}（不是新消息）`);
      return;
    }
    const chatId = msg.chat.id;
    if (typeof msg.text !== 'string' || msg.text.trim() === '') {
      log.info(`收到非文字消息 update=${update.update_id}，已提示`);
      await this.reply(chatId, '目前只支持文字消息。');
      return;
    }
    const cmd = parseCommand(msg.text);
    if (cmd) {
      log.info(`收到命令 /${cmd.name} update=${update.update_id}`);
      await this.handleCommand(chatId, cmd.name);
      return;
    }
    log.info(`收到消息 update=${update.update_id} 长度=${msg.text.length}`);
    if (msg.text.trimStart().startsWith('/')) {
      // ST 会把以 / 开头的输入当作 slash 命令执行，不能转发
      await this.reply(chatId, '以 / 开头的文字会被当作命令。发 /help 查看可用命令；想发给角色的话，开头别用 /。');
      return;
    }
    if (this.busy) {
      log.info(`正在${this.turn ? '生成' : '切换'}，已提示忙碌 update=${update.update_id}`);
      await this.reply(chatId, BUSY_TEXT);
      return;
    }
    this.startTurn(chatId, { kind: 'send', text: msg.text });
  }

  private async handleCommand(chatId: number, name: string): Promise<void> {
    switch (name) {
      case 'start':
      case 'help':
        await this.reply(chatId, HELP_TEXT);
        return;
      case 'status':
        await this.reply(chatId, await this.statusText(chatId));
        return;
      case 'stop':
        return this.requestStop(chatId, 'command');
      case 'menu':
        await this.sendMenu(chatId);
        return;
    }
    if (!['regen', 'chars', 'chats', 'preset', 'new'].includes(name)) {
      await this.reply(chatId, `未知命令 /${name}，发 /help 查看可用命令。`);
      return;
    }
    if (this.busy) {
      await this.reply(chatId, BUSY_COMMAND_TEXT);
      return;
    }
    if (name === 'regen') {
      const previous = this.opts.store.lastReply(chatId);
      if (!previous) {
        this.opts.log.info('/regen：没有可重新生成的回复');
        await this.reply(chatId, NOTHING_TO_REGEN_TEXT);
        return;
      }
      this.startTurn(chatId, { kind: 'regenerate', previous });
      return;
    }
    if (name === 'chars' || name === 'chats' || name === 'preset') {
      const kind = name === 'preset' ? 'presets' : name;
      await this.withHost(chatId, `/${name}`, () => this.sendList(chatId, kind));
      return;
    }
    await this.withHost(chatId, '/new', async () => {
      this.choiceSet = null;
      const r = await this.opts.host.request<SwitchResult>({ type: 'newChat' }, this.opts.switchRpcTimeoutMs ?? 90_000);
      this.saveSession(r);
      this.opts.log.info('/new：已新建聊天');
      await this.reply(chatId, `已新建聊天：${r.chatId ?? '（未知）'}。之后的消息会发到这个聊天。`);
      await this.sendGreeting(chatId, r, r.greeting);
    });
  }

  /** 主菜单：一行“角色 · 聊天 · 预设”速览加按钮。不唤醒浏览器，页面没连上时只有标题。 */
  private async sendMenu(chatId: number): Promise<void> {
    const { host } = this.opts;
    let summary = '';
    if (host.connected) {
      try {
        const st = await host.request<HostStatus>({ type: 'getStatus' }, 5000);
        summary = [st.characterName, st.chatId, st.presetName].filter(Boolean).join(' · ');
      } catch {
        // 速览拿不到不影响菜单
      }
    }
    await this.reply(chatId, summary ? `主菜单\n${summary}` : '主菜单', { reply_markup: { inline_keyboard: menuKeyboard() } });
  }

  private async reply(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<TelegramMessage | undefined> {
    try {
      return await this.opts.telegram.sendMessage({ chat_id: chatId, text, ...extra });
    } catch (e) {
      this.opts.log.error(`发送消息失败：${errMsg(e)}`);
      return undefined;
    }
  }

  // ───────────── 页面会话 ─────────────

  /**
   * 每次浏览器（重新）启动后，把页面恢复到最近一次通过 bot 切换到的角色和聊天。
   * 扩展自己会先打开 ST 记录的最近角色；这里再按 bot 的记录校正（例如用 /chats 切到了旧聊天）。
   */
  private ensureSession(): Promise<void> {
    const key = this.opts.browser.startedAt;
    if (key === undefined || key === this.sessionKey) return this.sessionPromise;
    this.sessionKey = key;
    const { host, log, store } = this.opts;
    const timeout = this.opts.switchRpcTimeoutMs ?? 90_000;
    this.sessionPromise = (async () => {
      const s = store.session;
      if (!s) return;
      let st = await host.request<HostStatus>({ type: 'getStatus' }, 10_000);
      if (s.characterAvatar && st.characterAvatar !== s.characterAvatar) {
        await host.request<SwitchResult>({ type: 'selectCharacter', characterId: s.characterAvatar }, timeout);
        st = await host.request<HostStatus>({ type: 'getStatus' }, 10_000);
      }
      if (s.chatId && st.chatId !== s.chatId) await host.request<SwitchResult>({ type: 'openChat', fileName: s.chatId }, timeout);
      log.info('已把页面恢复到上次使用的角色和聊天');
    })().catch((e) => log.warn(`恢复上次的角色和聊天失败（继续使用页面当前的聊天）：${errMsg(e)}`));
    return this.sessionPromise;
  }

  private saveSession(r: SwitchResult): void {
    const old = this.opts.store.session;
    this.opts.store.setSession({ characterAvatar: r.characterAvatar ?? old?.characterAvatar, chatId: r.chatId });
  }

  /** 非生成类操作：占用浏览器、必要时冷启动、恢复会话，期间其他消息按忙碌处理。 */
  private async withHost(chatId: number, label: string, fn: () => Promise<void>): Promise<void> {
    const { browser, host, log } = this.opts;
    this.op = label;
    const release = browser.acquire();
    try {
      if (browser.state !== 'running' || !host.connected) await this.reply(chatId, COLD_START_TEXT);
      await browser.ensureRunning();
      await this.ensureSession();
      await fn();
    } catch (e) {
      log.warn(`${label} 失败：${errMsg(e)}`);
      await this.reply(chatId, `${label} 失败：${errMsg(e)}`);
    } finally {
      release();
      this.op = null;
    }
  }

  // ───────────── 列表与按钮 ─────────────

  private async sendList(chatId: number, kind: ListKind): Promise<void> {
    const { host, log } = this.opts;
    const timeout = this.opts.switchRpcTimeoutMs ?? 90_000;
    const st = await host.request<HostStatus>({ type: 'getStatus' }, 10_000);
    let items: Listing['items'];
    let current: string | undefined;
    if (kind === 'chars') {
      items = await host.request<CharacterInfo[]>({ type: 'listCharacters' }, timeout);
      current = st.characterAvatar;
    } else if (kind === 'chats') {
      items = await host.request<ChatInfo[]>({ type: 'listChats' }, timeout);
      current = st.chatId;
    } else {
      const r = await host.request<PresetList>({ type: 'listPresets' }, timeout);
      items = r.presets;
      current = r.current;
    }
    const listing: Listing = { kind, items, current, createdAt: this.now() };
    const token = randomBytes(4).toString('hex');
    this.lists.set(token, listing);
    while (this.lists.size > MAX_LISTINGS) this.lists.delete(this.lists.keys().next().value as string);
    log.info(`/${kind}：列出 ${items.length} 项`);
    const currentIndex =
      kind === 'chars' ? (items as CharacterInfo[]).findIndex((c) => c.avatar === listing.current) : kind === 'presets' ? (items as string[]).indexOf(listing.current ?? '') : 0;
    const page = currentIndex > 0 ? Math.floor(currentIndex / PAGE_SIZE) : 0;
    await this.reply(chatId, listTitle(listing, page), { reply_markup: { inline_keyboard: listKeyboard(listing, token, page) } });
  }

  private async handleChoice(q: TelegramCallbackQuery, token: string, n: number, answer: (text?: string) => Promise<unknown>): Promise<void> {
    const { telegram, log } = this.opts;
    const set = this.choiceSet;
    const item = set && set.token === token ? set.items[n] : undefined;
    if (!set || item === undefined) {
      await answer('这组选项已过期（只有最新一条回复的选项有效）');
      return;
    }
    if (this.busy) {
      await answer('正在生成回复或切换中，稍后再试');
      return;
    }
    await answer();
    // await 期间这组选项可能已被别处消耗（双击）或作废，也可能别的消息先开始了一轮
    if (this.choiceSet !== set) return;
    const chatId = q.message?.chat.id ?? q.from.id;
    if (this.busy) {
      await this.reply(chatId, BUSY_COMMAND_TEXT);
      return;
    }
    log.info(`选择行动选项 ${n + 1}/${set.items.length}`);
    // startTurn 同步占用并作废这组选项，之后的 await 里重复点击会得到“已过期”
    this.startTurn(chatId, { kind: 'send', text: item });
    // 按钮消息改成“已选择”并去掉键盘
    if (q.message) {
      const text = `已选择 ${n + 1}：${item.length > 200 ? `${item.slice(0, 199)}…` : item}`;
      await telegram.editMessageText({ chat_id: chatId, message_id: q.message.message_id, text }).catch((e) => log.debug(`更新选项消息失败：${errMsg(e)}`));
    }
  }

  private async handleCallback(q: TelegramCallbackQuery): Promise<void> {
    const { telegram, log } = this.opts;
    const answer = (text?: string): Promise<unknown> => telegram.answerCallbackQuery({ callback_query_id: q.id, text }).catch(() => undefined);
    const menu = decodeMenuCallback(q.data);
    if (menu) {
      await answer();
      await this.handleCommand(q.message?.chat.id ?? q.from.id, menu);
      return;
    }
    const choice = decodeChoiceCallback(q.data);
    if (choice) {
      await this.handleChoice(q, choice.token, choice.n, answer);
      return;
    }
    const action = decodeCallback(q.data);
    const chatId = q.message?.chat.id ?? q.from.id;
    const messageId = q.message?.message_id;
    log.info(`收到按钮 ${action ? `${action.kind}/${action.op}` : '（无法识别）'}`);
    const listing = action ? this.lists.get(action.token) : undefined;
    if (!action || !listing || listing.kind !== action.kind) {
      await answer('这个列表已过期，请重新发送 /chars、/chats 或 /preset');
      return;
    }
    if (action.op === 'page') {
      await answer();
      if (messageId === undefined) return;
      const page = clampPage(action.n, listing.items.length);
      await telegram
        .editMessageText({ chat_id: chatId, message_id: messageId, text: listTitle(listing, page), reply_markup: { inline_keyboard: listKeyboard(listing, action.token, page) } })
        .catch((e) => log.debug(`翻页失败：${errMsg(e)}`));
      return;
    }
    if (this.busy) {
      await answer('正在生成回复或切换中，稍后再试');
      return;
    }
    const item = listing.items[action.n];
    if (!item) {
      await answer('这个列表已过期，请重新发送');
      return;
    }
    await answer('正在切换…');
    const timeout = this.opts.switchRpcTimeoutMs ?? 90_000;
    const label = action.kind === 'chars' ? '切换角色' : action.kind === 'chats' ? '切换聊天' : '切换预设';
    await this.withHost(chatId, label, async () => {
      let text: string;
      let greeting: Greeting | undefined;
      let switched: SwitchResult | undefined;
      if (action.kind !== 'presets') this.choiceSet = null; // 换角色/聊天后旧选项不再适用；换预设不影响
      if (action.kind === 'presets') {
        const r = await this.opts.host.request<{ presetName: string }>({ type: 'selectPreset', name: item as string }, timeout);
        text = `已切换到预设：${r.presetName}\n之后的回复使用这个预设。`;
      } else {
        const r =
          action.kind === 'chars'
            ? await this.opts.host.request<SwitchResult>({ type: 'selectCharacter', characterId: (item as CharacterInfo).avatar }, timeout)
            : await this.opts.host.request<SwitchResult>({ type: 'openChat', fileName: (item as ChatInfo).fileName }, timeout);
        this.saveSession(r);
        switched = r;
        greeting = r.greeting;
        text = `已切换到角色：${r.characterName ?? '（未知）'}\n当前聊天：${r.chatId ?? '（未知）'}\n之后的消息会发到这个聊天。`;
      }
      // 列表里的“当前”标注已过时，作废这个列表
      this.lists.delete(action.token);
      log.info(`${label}：成功`);
      if (messageId !== undefined) {
        await telegram.editMessageText({ chat_id: chatId, message_id: messageId, text }).catch(() => this.reply(chatId, text));
      } else {
        await this.reply(chatId, text);
      }
      if (switched) await this.sendGreeting(chatId, switched, greeting);
    });
  }

  /** 行动选项：一条带数字按钮的消息，列出完整选项。 */
  private async sendChoices(chatId: number, choices: string[]): Promise<void> {
    const token = randomBytes(4).toString('hex');
    this.choiceSet = { token, items: choices };
    const m = await this.reply(chatId, choicesText(choices), { reply_markup: { inline_keyboard: choicesKeyboard(token, choices.length) } });
    if (!m) this.choiceSet = null;
  }

  /** 新聊天只有开场白时，把开场白作为正式消息发出；同一聊天只发一次。 */
  private async sendGreeting(chatId: number, r: SwitchResult, greeting: Greeting | undefined): Promise<void> {
    if (!greeting || !r.chatId || !this.opts.store.markGreeted(r.chatId)) return;
    const sent = await deliverFinal({
      telegram: this.opts.telegram,
      log: this.opts.log,
      chatId,
      html: greeting.html,
      text: greeting.text,
      stopped: false,
      dialogueStyle: this.opts.dialogueStyle,
    });
    this.opts.log.info(`开场白：已发送 ${sent.messageIds.length} 条`);
  }

  // ───────────── 停止 ─────────────

  private async requestStop(chatId: number, source: 'command' | 'button'): Promise<void> {
    const { host, log } = this.opts;
    const t = this.turn;
    if (!t || t.chatId !== chatId) {
      if (source === 'command') await this.reply(chatId, NOTHING_TO_STOP_TEXT);
      return;
    }
    log.info(`停止生成 来源=${source === 'button' ? '按钮' : '/stop'} gen=${short(t.generationId)} 阶段=${t.phase}`);
    if (t.phase === 'starting') {
      t.cancelled = true;
      return;
    }
    if (t.phase === 'requesting') {
      t.stopRequested = true;
      return;
    }
    try {
      await host.request({ type: 'stop' }, 10_000);
    } catch (e) {
      log.warn(`停止失败：${errMsg(e)}`);
      await this.reply(chatId, `停止失败：${errMsg(e)}`);
    }
  }

  // ───────────── 状态 ─────────────

  async statusText(chatId?: number): Promise<string> {
    const { status, browser, host } = this.opts;
    const lines = ['silly-tg 状态'];
    lines.push(`Telegram：${status.telegram === 'ok' ? `已连接${status.botUsername ? ` @${status.botUsername}` : ''}` : status.telegram === 'error' ? '连接失败' : '未连接（离线模式）'}`);
    if (!status.chromium.path) lines.push('Chromium：未找到 Chrome/Chromium');
    else {
      const up = browser.startedAt ? `，已运行 ${Math.max(0, Math.round((this.now() - browser.startedAt) / 60_000))} 分钟` : '';
      const s: Record<BrowserState, string> = {
        running: `运行中${browser.pid ? `（PID ${browser.pid}${up}）` : ''}`,
        starting: '启动中',
        stopping: '正在关闭',
        stopped: browser.lastError ? `已关闭，上次启动失败：${browser.lastError}` : '已关闭（收到消息时自动启动）',
      };
      lines.push(`Chromium：${s[browser.state]}`);
    }
    const idle = this.opts.idleShutdownMinutes ?? 0;
    lines.push(`空闲关闭：${idle > 0 ? `空闲 ${idle} 分钟后关闭` : '未启用'}`);
    const wd = this.opts.watchdogStatus?.();
    if (wd) lines.push(`看门狗：${wd}`);
    if (host.connected && host.hello) {
      lines.push(`ST 页面：已连接（${host.hello.stVersion}，酒馆助手${host.hello.hasTavernHelper ? '已加载' : '未加载'}）`);
      try {
        const st = await host.request<HostStatus>({ type: 'getStatus' }, 5000);
        lines.push(`当前角色：${st.characterName ?? '未选择'}`);
        lines.push(`当前聊天：${st.chatId ?? '无'}${st.messageCount !== undefined ? `（${st.messageCount} 条消息）` : ''}`);
        if (st.presetName) lines.push(`预设：${st.presetName}`);
        lines.push(`API：${st.mainApi ?? '未知'}（${st.onlineStatus && st.onlineStatus !== 'no_connection' ? '已连接' : '未连接'}）`);
        if (st.generating) lines.push('正在生成回复');
        if (st.formDuplicates?.length) lines.push(`警告：ST 角色编辑表单有重复字段（${st.formDuplicates.slice(0, 6).join('、')}），/chats 和 /new 已暂停，重启 ST 可恢复`);
      } catch (e) {
        lines.push(`读取 ST 状态失败：${errMsg(e)}`);
      }
    } else {
      lines.push('ST 页面：未连接');
    }
    if (chatId !== undefined) lines.push(`可重新生成上一条：${this.opts.store.lastReply(chatId) ? '是' : '否'}`);
    const failed = status.hostChecks.filter((c) => !c.ok);
    if (status.hostChecks.length > 0) {
      lines.push(failed.length === 0 ? '页面自检：全部通过' : '页面自检：');
      for (const c of failed) lines.push(`- ${c.name} 未通过：${c.detail ?? ''}`);
    }
    if (status.lastHostError) lines.push(`最近页面错误：${status.lastHostError.slice(0, 300)}`);
    return lines.join('\n');
  }

  // ───────────── 生成 ─────────────

  private startTurn(chatId: number, request: TurnRequest): void {
    this.choiceSet = null;
    const turn: Turn = {
      chatId,
      generationId: randomUUID(),
      draftId: this.nextDraftId++,
      kind: request.kind,
      phase: 'starting',
      cancelled: false,
      stopRequested: false,
      promise: Promise.resolve(),
    };
    this.turn = turn;
    turn.promise = this.runTurn(turn, request)
      .catch((e) => this.opts.log.error(`处理消息出错：${errMsg(e)}`))
      .finally(() => {
        if (this.turn === turn) this.turn = null;
      });
  }

  /** 重新生成开始后，删除上一轮的 Telegram 消息；删不掉（超过 48 小时等）时回复一条标注。 */
  private async retract(prev: ReplyRecord): Promise<void> {
    const { telegram, log, store } = this.opts;
    const tooOld = this.now() - prev.sentAt > DELETE_WINDOW_MS;
    const failed: number[] = [];
    for (const id of prev.telegramMessageIds) {
      if (tooOld) {
        failed.push(id);
        continue;
      }
      try {
        await telegram.deleteMessage(prev.telegramChatId, id);
      } catch (e) {
        log.debug(`删除旧回复 ${id} 失败：${errMsg(e)}`);
        failed.push(id);
      }
    }
    log.info(`重新生成：删除旧回复 ${prev.telegramMessageIds.length - failed.length}/${prev.telegramMessageIds.length} 段${failed.length ? '，其余已标注' : ''}`);
    if (failed.length > 0) {
      await this.reply(prev.telegramChatId, REGENERATED_NOTE, { reply_parameters: { message_id: failed[0], allow_sending_without_reply: true } });
    }
    store.removeReply(prev);
  }

  private async runTurn(turn: Turn, request: TurnRequest): Promise<void> {
    const { browser, host, telegram, log, store } = this.opts;
    const release = browser.acquire();
    const chatId = turn.chatId;
    const gen = short(turn.generationId);
    const t0 = this.now();

    // typing：直到第一段流式文本或本轮结束
    let typingTimer: NodeJS.Timeout | null = null;
    const sendTyping = (): void => void telegram.sendChatAction(chatId, 'typing').catch(() => {});
    const startTyping = (): void => {
      if (typingTimer) return;
      sendTyping();
      typingTimer = setInterval(sendTyping, this.opts.typingIntervalMs ?? 4500);
    };
    const stopTyping = (): void => {
      if (typingTimer) clearInterval(typingTimer);
      typingTimer = null;
    };

    // 草稿节流
    const interval = this.opts.draftIntervalMs ?? 1000;
    let lastDraftAt = 0;
    let pendingPreview: string | null = null;
    let draftTimer: NodeJS.Timeout | null = null;
    let inflight: Promise<unknown> = Promise.resolve();
    let finished = false;
    let draftCount = 0;
    const sendDraft = (): void => {
      draftTimer = null;
      if (finished || pendingPreview === null || this.draftsDisabled) return;
      const preview = pendingPreview;
      pendingPreview = null;
      lastDraftAt = this.now();
      draftCount++;
      inflight = telegram
        .call('sendMessageDraft', { chat_id: chatId, draft_id: turn.draftId, text: preview, can_stop: true, keep_on_stop: true }, { retry: false })
        .catch((e) => {
          if (e instanceof TelegramApiError && e.errorCode === 404) {
            // 方法不存在：本次运行不再发草稿，改回 typing
            this.draftsDisabled = true;
            log.warn('Telegram 不支持 sendMessageDraft，改用 typing 状态');
            if (!finished) startTyping();
          } else {
            log.debug(`草稿发送失败（可忽略）：${errMsg(e)}`);
          }
        });
    };
    const onStream = (raw: string): void => {
      if (this.draftsDisabled) return;
      const preview = streamPreview(raw);
      if (!preview) return;
      stopTyping();
      pendingPreview = preview;
      if (draftTimer) return;
      const wait = Math.max(0, lastDraftAt + interval - this.now());
      draftTimer = setTimeout(sendDraft, wait);
    };

    let resolveResult!: (r: TurnResult) => void;
    const result = new Promise<TurnResult>((r) => (resolveResult = r));
    let idleTimer: NodeJS.Timeout | null = null;
    const idleMs = this.opts.turnIdleTimeoutMs ?? 10 * 60_000;
    const bump = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => resolveResult({ kind: 'lost', reason: `超过 ${Math.round(idleMs / 60000)} 分钟没有进展，放弃等待` }), idleMs);
    };
    let graceTimer: NodeJS.Timeout | null = null;

    const offEvent = host.onEvent((e) => {
      if (!('generationId' in e) || e.generationId !== turn.generationId) return;
      bump();
      if (e.type === 'streamText') onStream(e.text);
      else if (e.type === 'messageFinal')
        resolveResult({ kind: 'final', html: e.html, text: e.text, raw: e.raw, stopped: e.stopped, stChatId: e.chatId, stMessageId: e.messageId });
      else if (e.type === 'generationStopped') resolveResult({ kind: 'stopped' });
      else if (e.type === 'generationFailed') resolveResult({ kind: 'failed', reason: e.reason ?? '未知原因' });
    });
    // 连接监视在浏览器就绪后才开始：冷启动时 rotateNonce 本身就会触发一次断开。
    let offConn = (): void => {};
    const watchConnection = (): void => {
      offConn = host.onConnectionChange((connected) => {
        if (connected) {
          if (graceTimer) clearTimeout(graceTimer);
          graceTimer = null;
        } else if (!graceTimer) {
          graceTimer = setTimeout(() => resolveResult({ kind: 'lost', reason: '无头浏览器页面连接中断' }), this.opts.disconnectGraceMs ?? 15_000);
        }
      });
    };

    try {
      if (browser.state !== 'running' || !host.connected) await this.reply(chatId, COLD_START_TEXT);
      startTyping();
      try {
        await browser.ensureRunning();
      } catch (e) {
        log.warn(`无头浏览器启动失败 gen=${gen}：${errMsg(e)}`);
        await this.reply(chatId, `无头浏览器启动失败：${errMsg(e)}`);
        return;
      }
      await this.ensureSession();
      if (turn.cancelled) {
        log.info(`已取消 gen=${gen}（启动期间收到停止）`);
        await this.reply(chatId, '已取消，这条消息没有发给角色。');
        return;
      }
      watchConnection();
      bump();
      turn.phase = 'requesting';
      log.info(`开始${turn.kind === 'send' ? '生成' : '重新生成'} gen=${gen}`);
      try {
        const cmd: HostCommandInput =
          request.kind === 'send'
            ? { type: 'send', text: request.text, generationId: turn.generationId }
            : { type: 'regenerate', generationId: turn.generationId, chatId: request.previous.stChatId, messageId: request.previous.stMessageId };
        await host.request(cmd, this.opts.sendRpcTimeoutMs ?? 120_000);
      } catch (e) {
        log.warn(`页面拒绝了${turn.kind === 'send' ? '发送' : '重新生成'} gen=${gen}：${errMsg(e)}`);
        await this.reply(chatId, `${turn.kind === 'send' ? '发送到 ST 失败' : '重新生成失败'}：${errMsg(e)}`);
        return;
      }
      turn.phase = 'running';
      if (turn.stopRequested || turn.cancelled) void this.requestStop(chatId, 'command');
      if (request.kind === 'regenerate') await this.retract(request.previous);

      const r = await result;
      finished = true;
      stopTyping();
      if (draftTimer) clearTimeout(draftTimer);
      // 等最后一个草稿请求结束再发正式消息，否则晚到的草稿会在正式消息之后再闪现一次
      await inflight;
      const secs = ((this.now() - t0) / 1000).toFixed(1);
      switch (r.kind) {
        case 'final': {
          log.info(`生成${r.stopped ? '已停止（保留已生成部分）' : '完成'} gen=${gen} 用时 ${secs} 秒，回复 ${r.text.length} 字符，草稿 ${draftCount} 次`);
          // 行动选项：从正文里取出，之后单独发一条带按钮的消息
          const parsed = r.stopped ? null : parseChoices(r.raw, r.html, r.text, (this.opts.choiceRules ?? (() => this.defaultRules))());
          if (parsed) log.info(`解析到行动选项 ${parsed.choices.length} 个（规则 ${parsed.rule}）`);
          const sent = await deliverFinal({
            telegram,
            log,
            chatId,
            html: parsed?.html ?? r.html,
            text: parsed?.text ?? r.text,
            stopped: r.stopped,
            dialogueStyle: this.opts.dialogueStyle,
          });
          log.info(`正式消息已发出 ${sent.messageIds.length} 段，方式=${sent.via}${sent.via === 'plain' || sent.via === 'text' || sent.via === 'mixed' ? '（回退了纯文本）' : ''}${sent.incomplete ? '，有内容未发出' : ''}`);
          if (sent.incomplete) await this.reply(chatId, '回复的一部分没能发出，完整内容保存在 ST 聊天记录中。');
          if (sent.messageIds.length > 0) {
            store.recordReply({ telegramChatId: chatId, telegramMessageIds: sent.messageIds, stChatId: r.stChatId, stMessageId: r.stMessageId, sentAt: this.now() });
            if (store.session?.chatId !== r.stChatId) store.setSession({ ...store.session, chatId: r.stChatId });
            try {
              this.opts.onDelivered?.({ telegramChatId: chatId, generationId: turn.generationId, stChatId: r.stChatId, stMessageId: r.stMessageId, telegramMessageIds: sent.messageIds });
            } catch (e) {
              log.error(`onDelivered 回调出错：${errMsg(e)}`);
            }
            if (parsed) await this.sendChoices(chatId, parsed.choices);
          }
          break;
        }
        case 'stopped':
          log.info(`生成已停止，没有内容 gen=${gen} 用时 ${secs} 秒`);
          await this.reply(chatId, '已停止生成，没有生成内容。');
          break;
        case 'failed':
          log.warn(`生成失败 gen=${gen} 用时 ${secs} 秒：${r.reason}`);
          await this.reply(chatId, `生成失败：${r.reason}`);
          break;
        case 'lost':
          log.warn(`生成中断 gen=${gen} 用时 ${secs} 秒：${r.reason}`);
          await this.reply(chatId, `这一轮回复没有完成：${r.reason}。ST 聊天记录中可能已有部分内容。`);
          break;
      }
    } finally {
      finished = true;
      stopTyping();
      if (draftTimer) clearTimeout(draftTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (graceTimer) clearTimeout(graceTimer);
      offEvent();
      offConn();
      release();
    }
  }
}
