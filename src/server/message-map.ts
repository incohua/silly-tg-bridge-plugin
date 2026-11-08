// Telegram 消息与 ST 消息的映射，以及最近一次切换到的角色和聊天（会话）。
// 持久化到插件数据目录的 state.json，ST 重启后仍可重新生成上一条、恢复到同一个聊天。
// 写入用临时文件加 rename，避免进程中途退出时留下半个文件。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from './logger';

export interface ReplyRecord {
  telegramChatId: number;
  /** 这条回复在 Telegram 里的各段消息，按发送顺序。 */
  telegramMessageIds: number[];
  stChatId: string;
  stMessageId: number;
  /** 毫秒时间戳。超过 48 小时的消息 Telegram 不允许 bot 删除。 */
  sentAt: number;
}

export interface SessionRecord {
  characterAvatar?: string;
  chatId?: string;
}

interface StateFile {
  version: 1;
  replies: ReplyRecord[];
  session?: SessionRecord;
  /** 已发过开场白的 ST 聊天名。 */
  greeted?: string[];
}

const MAX_REPLIES = 100;
const MAX_GREETED = 200;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function decodeReply(v: unknown): ReplyRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isNum(r.telegramChatId) || !Array.isArray(r.telegramMessageIds) || !r.telegramMessageIds.every(isNum)) return null;
  if (typeof r.stChatId !== 'string' || !isNum(r.stMessageId) || !isNum(r.sentAt)) return null;
  return {
    telegramChatId: r.telegramChatId,
    telegramMessageIds: r.telegramMessageIds,
    stChatId: r.stChatId,
    stMessageId: r.stMessageId,
    sentAt: r.sentAt,
  };
}

function decodeSession(v: unknown): SessionRecord | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const s = v as Record<string, unknown>;
  const out: SessionRecord = {};
  if (typeof s.characterAvatar === 'string' && s.characterAvatar) out.characterAvatar = s.characterAvatar;
  if (typeof s.chatId === 'string' && s.chatId) out.chatId = s.chatId;
  return out.characterAvatar || out.chatId ? out : undefined;
}

export class BridgeStore {
  private replies: ReplyRecord[] = [];
  private sessionValue: SessionRecord | undefined;
  private greeted: string[] = [];

  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {
    this.load();
  }

  get session(): SessionRecord | undefined {
    return this.sessionValue;
  }

  /** 该 Telegram 聊天里 bot 发出的最近一条回复。 */
  lastReply(telegramChatId: number): ReplyRecord | undefined {
    for (let i = this.replies.length - 1; i >= 0; i--) if (this.replies[i].telegramChatId === telegramChatId) return this.replies[i];
    return undefined;
  }

  /** 记录一条回复。同一条 ST 消息（重新生成后）的旧记录被替换。 */
  recordReply(r: ReplyRecord): void {
    this.replies = this.replies.filter((x) => !(x.stChatId === r.stChatId && x.stMessageId === r.stMessageId && x.telegramChatId === r.telegramChatId));
    this.replies.push(r);
    if (this.replies.length > MAX_REPLIES) this.replies = this.replies.slice(-MAX_REPLIES);
    this.save();
  }

  removeReply(r: ReplyRecord): void {
    this.replies = this.replies.filter((x) => x !== r);
    this.save();
  }

  /** 标记这个聊天已发过开场白。第一次标记返回 true，之后返回 false。 */
  markGreeted(stChatId: string): boolean {
    if (this.greeted.includes(stChatId)) return false;
    this.greeted.push(stChatId);
    if (this.greeted.length > MAX_GREETED) this.greeted = this.greeted.slice(-MAX_GREETED);
    this.save();
    return true;
  }

  setSession(s: SessionRecord): void {
    this.sessionValue = decodeSession(s);
    this.save();
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`读取 ${this.file} 失败，消息映射从空开始：${(e as Error).message}`);
      return;
    }
    try {
      const j = JSON.parse(text) as Partial<StateFile>;
      this.replies = Array.isArray(j.replies) ? j.replies.map(decodeReply).filter((r): r is ReplyRecord => r !== null) : [];
      this.sessionValue = decodeSession(j.session);
      this.greeted = Array.isArray(j.greeted) ? j.greeted.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      this.log.warn(`${this.file} 不是合法的 JSON，消息映射从空开始（原文件会在下次写入时被覆盖）`);
    }
  }

  private save(): void {
    const data: StateFile = { version: 1, replies: this.replies, session: this.sessionValue, greeted: this.greeted };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      this.log.error(`保存 ${this.file} 失败：${(e as Error).message}`);
    }
  }
}
