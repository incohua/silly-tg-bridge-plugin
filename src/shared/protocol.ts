// 服务端插件 <-> UI 扩展（host 模式）的协议。
// 这里是协议的唯一定义处：类型、解码、校验都在这里，两侧都从这里导入，不要在别处就地断言字段。
// 通道：下行 SSE（HostCommand），上行 POST（HostUpload）。见 design.md 第 3 节。

/** 卡片源码。字段由 card-render 任务扩展。 */
export interface CardSource {
  source: string;
}

export type HostCommand =
  /** generationId 由服务端生成，后续 streamText / messageFinal 等事件都带它。rpcResult 在生成开始后立即返回，不等生成结束。 */
  | { id: string; type: 'send'; text: string; generationId: string }
  /**
   * 重新生成 ST 中的最后一条回复。chatId、messageId 是上一轮 messageFinal 的值，页面先核对：
   * 当前聊天不同或那条消息已不是最后一条时拒绝（rpc 错误），避免重新生成了别的消息。
   */
  | { id: string; type: 'regenerate'; generationId: string; chatId: string; messageId: number }
  /** stop 和 getStatus 不进页面串行队列（生成进行中也要能立即执行）。 */
  | { id: string; type: 'stop' | 'getStatus' | 'newChat' | 'listCharacters' | 'listChats' }
  /** characterId 是角色的 avatar 文件名（跨重启稳定），不是数组下标。 */
  | { id: string; type: 'selectCharacter'; characterId: string }
  /** fileName 是聊天名（getCurrentChatId 的值，不带 .jsonl）。 */
  | { id: string; type: 'openChat'; fileName: string }
  | { id: string; type: 'getCardState'; messageId: number; chatId: string }
  | { id: string; type: 'updateVariables'; messageId: number; chatId: string; patch: unknown };

export type HostCommandType = HostCommand['type'];

/** getStatus 的结果。 */
export interface HostStatus {
  /** 'st' 或 'luker'。 */
  app: string;
  characterName?: string;
  chatId?: string;
  mainApi?: string;
  onlineStatus?: string;
  generating: boolean;
  /** 当前角色的 avatar（selectCharacter 用的 id）。 */
  characterAvatar?: string;
  /** 当前聊天的消息条数（含开场白）。 */
  messageCount?: number;
  /**
   * ST 角色编辑表单（#form_create）里出现多个值的字段。ST 打开或新建聊天时会用这个表单重新保存角色卡，
   * 有重复字段时卡片字段会被存成数组（卡片损坏），所以这时 openChat / newChat 会拒绝执行。
   */
  formDuplicates?: string[];
}

/** listCharacters 的结果项。 */
export interface CharacterInfo {
  avatar: string;
  name: string;
}

/** listChats 的结果项，按最近使用排序。 */
export interface ChatInfo {
  /** 聊天名，不带 .jsonl。 */
  fileName: string;
  /** 毫秒时间戳。 */
  lastMessageAt?: number;
  messageCount?: number;
  /** 最后一条消息的开头。 */
  preview?: string;
}

/** selectCharacter / openChat / newChat 的结果。 */
export interface SwitchResult {
  characterName?: string;
  characterAvatar?: string;
  chatId?: string;
}

/** 自检项。设计要求的启动自检（CSRF、Mvu 等）都用这个结构上报。 */
export interface SelfCheckItem {
  name: string;
  ok: boolean;
  detail?: string;
}

export type HostEvent =
  | { type: 'hello'; nonce: string; stVersion: string; hasTavernHelper: boolean }
  /** 扩展定期发送，服务端据此判断页面存活（看门狗）。 */
  | { type: 'heartbeat' }
  /** 启动自检结果（CSRF 补丁、typeof Mvu 等），服务端写日志并显示在 /status。 */
  | { type: 'selfCheck'; items: SelfCheckItem[] }
  /** 页面内的未处理错误（已过滤忽略清单后）。 */
  | { type: 'hostError'; message: string }
  /** 页面内值得记日志但不是错误的事情，例如自动关闭了弹窗。 */
  | { type: 'hostLog'; level: 'info' | 'warn'; message: string }
  /** text 是 ST 流式事件给出的累计原文（未经渲染和正则）。 */
  | { type: 'streamText'; generationId: string; text: string }
  /**
   * html 是渲染后 .mes_text 的 innerHTML（含“仅格式显示”正则的结果），text 是同一元素的 innerText，供纯文本发送和回退使用。
   * stopped 为 true 表示用户停止了生成，内容是已生成的部分。
   */
  | {
      type: 'messageFinal';
      generationId: string;
      chatId: string;
      messageId: number;
      html: string;
      text: string;
      stopped: boolean;
      cards: CardSource[];
    }
  | { type: 'generationStopped' | 'generationFailed'; generationId: string; reason?: string }
  | { type: 'rpcResult'; id: string; ok: boolean; result?: unknown; error?: string };

export type HostEventType = HostEvent['type'];

/** 上行 POST 的请求体。nonce 在每个请求里都要带，服务端逐次校验。 */
export interface HostUpload {
  nonce: string;
  event: HostEvent;
}

/** 去掉 id 的命令，调用方传这个，id 由通道生成。 */
export type HostCommandInput = HostCommand extends infer C ? (C extends { id: string } ? Omit<C, 'id'> : never) : never;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isOptStr = (v: unknown): boolean => v === undefined || typeof v === 'string';

function isCardSource(v: unknown): v is CardSource {
  return isRecord(v) && isStr(v.source);
}

function isSelfCheckItem(v: unknown): v is SelfCheckItem {
  return isRecord(v) && isStr(v.name) && typeof v.ok === 'boolean' && isOptStr(v.detail);
}

/** 从 unknown 解码上行事件。不合法返回 null。 */
export function decodeHostEvent(v: unknown): HostEvent | null {
  if (!isRecord(v) || !isStr(v.type)) return null;
  switch (v.type) {
    case 'hello':
      return isStr(v.nonce) && isStr(v.stVersion) && typeof v.hasTavernHelper === 'boolean'
        ? { type: 'hello', nonce: v.nonce, stVersion: v.stVersion, hasTavernHelper: v.hasTavernHelper }
        : null;
    case 'heartbeat':
      return { type: 'heartbeat' };
    case 'selfCheck':
      return Array.isArray(v.items) && v.items.every(isSelfCheckItem)
        ? { type: 'selfCheck', items: v.items.map((i) => ({ name: i.name, ok: i.ok, detail: i.detail })) }
        : null;
    case 'hostError':
      return isStr(v.message) ? { type: 'hostError', message: v.message } : null;
    case 'hostLog':
      return (v.level === 'info' || v.level === 'warn') && isStr(v.message) ? { type: 'hostLog', level: v.level, message: v.message } : null;
    case 'streamText':
      return isStr(v.generationId) && isStr(v.text) ? { type: 'streamText', generationId: v.generationId, text: v.text } : null;
    case 'messageFinal':
      return isStr(v.generationId) &&
        isStr(v.chatId) &&
        typeof v.messageId === 'number' &&
        isStr(v.html) &&
        isStr(v.text) &&
        typeof v.stopped === 'boolean' &&
        Array.isArray(v.cards) &&
        v.cards.every(isCardSource)
        ? {
            type: 'messageFinal',
            generationId: v.generationId,
            chatId: v.chatId,
            messageId: v.messageId,
            html: v.html,
            text: v.text,
            stopped: v.stopped,
            cards: v.cards.map((c) => ({ source: c.source })),
          }
        : null;
    case 'generationStopped':
    case 'generationFailed':
      return isStr(v.generationId) && isOptStr(v.reason)
        ? { type: v.type, generationId: v.generationId, reason: v.reason as string | undefined }
        : null;
    case 'rpcResult':
      return isStr(v.id) && typeof v.ok === 'boolean' && isOptStr(v.error)
        ? { type: 'rpcResult', id: v.id, ok: v.ok, result: v.result, error: v.error as string | undefined }
        : null;
    default:
      return null;
  }
}

/** 解码上行 POST 请求体。 */
export function decodeHostUpload(v: unknown): HostUpload | null {
  if (!isRecord(v) || !isStr(v.nonce)) return null;
  const event = decodeHostEvent(v.event);
  return event ? { nonce: v.nonce, event } : null;
}

/** 从 unknown 解码下行命令（扩展侧使用）。不合法返回 null。 */
export function decodeHostCommand(v: unknown): HostCommand | null {
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.type)) return null;
  const id = v.id;
  switch (v.type) {
    case 'send':
      return isStr(v.text) && isStr(v.generationId) ? { id, type: 'send', text: v.text, generationId: v.generationId } : null;
    case 'regenerate':
      return isStr(v.generationId) && isStr(v.chatId) && typeof v.messageId === 'number'
        ? { id, type: 'regenerate', generationId: v.generationId, chatId: v.chatId, messageId: v.messageId }
        : null;
    case 'stop':
    case 'getStatus':
    case 'newChat':
    case 'listCharacters':
    case 'listChats':
      return { id, type: v.type };
    case 'selectCharacter':
      return isStr(v.characterId) ? { id, type: 'selectCharacter', characterId: v.characterId } : null;
    case 'openChat':
      return isStr(v.fileName) ? { id, type: 'openChat', fileName: v.fileName } : null;
    case 'getCardState':
      return typeof v.messageId === 'number' && isStr(v.chatId) ? { id, type: 'getCardState', messageId: v.messageId, chatId: v.chatId } : null;
    case 'updateVariables':
      return typeof v.messageId === 'number' && isStr(v.chatId)
        ? { id, type: 'updateVariables', messageId: v.messageId, chatId: v.chatId, patch: v.patch }
        : null;
    default:
      return null;
  }
}
