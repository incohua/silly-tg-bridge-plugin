// 列表与切换命令：listCharacters、selectCharacter、listChats、openChat、newChat、getStatus。
// 除 getStatus 外都在串行队列里执行（index.ts）。
// ST 的切换函数可能被弹窗挡住而一直不返回（spike 调整 3），所以只等到“状态已变成目标值”或超时，
// 弹窗交给 dialog-watcher 处理。

import type { CharacterInfo, ChatInfo, Greeting, HostStatus, PresetList, SwitchResult } from '../shared/protocol';
import { ctx, detectApp, newChat as adapterNewChat, pastChats } from './adapter';
import { isGenerating } from './generation';

const SWITCH_TIMEOUT_MS = 30_000;

/** createOrEditCharacter 自己会删掉再逐个追加的字段，允许多值。 */
const MULTI_OK = new Set(['alternate_greetings']);

/**
 * #form_create 的 FormData 里有多个值的字段名。ST 的 openCharacterChat、新建聊天都会调用 createOrEditCharacter，
 * 用这个表单重新保存角色卡；字段重复时卡片里的字段会变成数组（实测把 Seraphina 卡写坏过）。
 */
export function formDuplicates(): string[] {
  const form = document.getElementById('form_create');
  if (!(form instanceof HTMLFormElement)) return [];
  const fd = new FormData(form);
  return [...new Set(fd.keys())].filter((k) => !MULTI_OK.has(k) && fd.getAll(k).length > 1);
}

/** 重复字段在 DOM 中的位置（诊断用）。 */
export function formDuplicateLocations(name: string): string[] {
  return [...document.querySelectorAll(`[name="${CSS.escape(name)}"]`)].map((e) => {
    const path: string[] = [];
    let x: Element | null = e;
    for (let i = 0; i < 5 && x; i++) {
      path.push(x.tagName.toLowerCase() + (x.id ? `#${x.id}` : '') + (typeof x.className === 'string' && x.className ? `.${x.className.split(' ')[0]}` : ''));
      x = x.parentElement;
    }
    return path.join(' < ');
  });
}

function assertCardSafe(action: string): void {
  const dups = formDuplicates();
  if (dups.length === 0) return;
  const where = formDuplicateLocations(dups[0]).join(' | ');
  throw new Error(
    `ST 页面的角色编辑表单出现重复字段（${dups.slice(0, 6).join('、')}），${action}会用它重新保存角色卡并把卡片写坏，已拒绝执行。重启 ST 后再试。诊断：${where}`,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 让 p 跑起来，但最多等 ms 毫秒；p 的错误会抛出，超时不算错误。 */
async function settle(p: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([p, sleep(ms)]);
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(200);
  }
  return pred();
}

const currentIndex = (): number | undefined => {
  const id = ctx().characterId;
  return id === undefined || id === null || id === '' ? undefined : Number(id);
};

function switchResult(): SwitchResult {
  const c = ctx();
  const i = currentIndex();
  const ch = i === undefined ? undefined : c.characters[i];
  return { characterName: ch?.name, characterAvatar: ch?.avatar, chatId: c.getCurrentChatId() };
}

/**
 * 聊天里只有开场白一条消息（新聊天）时，返回第 0 条消息渲染后的内容。纯函数部分见 isGreetingOnly。
 */
export function isGreetingOnly(chat: ReadonlyArray<{ is_user?: boolean; is_system?: boolean }>): boolean {
  return chat.length === 1 && !chat[0].is_user && !chat[0].is_system;
}

function readGreeting(): Greeting | undefined {
  const c = ctx();
  if (!isGreetingOnly(c.chat)) return undefined;
  const node = document.querySelector<HTMLElement>('#chat .mes[mesid="0"] .mes_text');
  const html = node?.innerHTML ?? '';
  const text = node ? node.innerText : (c.chat[0].mes ?? '');
  return html || text ? { html, text } : undefined;
}

/** 当前 API 的预设管理器；该 API 没有预设时返回 null。 */
function presetManager() {
  const c = ctx();
  return typeof c.getPresetManager === 'function' ? c.getPresetManager() : null;
}

export function hostStatus(): HostStatus {
  const c = ctx();
  const r = switchResult();
  return {
    app: detectApp(),
    characterName: c.groupId ? `群聊 ${c.groupId}` : r.characterName,
    characterAvatar: r.characterAvatar,
    chatId: r.chatId,
    messageCount: r.chatId ? c.chat.length : undefined,
    formDuplicates: formDuplicates(),
    mainApi: c.mainApi,
    onlineStatus: c.onlineStatus,
    generating: isGenerating(),
    presetName: presetManager()?.getSelectedPresetName() || undefined,
  };
}

export function listPresets(): PresetList {
  const m = presetManager();
  if (!m) throw new Error('当前 API 没有可切换的预设');
  const presets = m.getAllPresets().filter((n) => typeof n === 'string' && n);
  return { api: ctx().mainApi ?? '', current: m.getSelectedPresetName() || undefined, presets };
}

export async function selectPreset(name: string): Promise<{ presetName: string }> {
  const m = presetManager();
  if (!m) throw new Error('当前 API 没有可切换的预设');
  const value = m.findPreset(name);
  if (value === undefined || value === null) throw new Error('找不到这个预设（可能已被删除或改名），请重新发送 /preset');
  if (m.getSelectedPresetName() !== name) await m.selectPreset(value);
  if (!(await waitFor(() => presetManager()?.getSelectedPresetName() === name, 5000))) throw new Error('切换预设超时');
  return { presetName: name };
}

export function listCharacters(): CharacterInfo[] {
  return ctx()
    .characters.filter((ch) => typeof ch.avatar === 'string' && ch.avatar)
    .map((ch) => ({ avatar: ch.avatar as string, name: ch.name || (ch.avatar as string) }));
}

export async function selectCharacter(avatar: string): Promise<SwitchResult> {
  const c = ctx();
  const index = c.characters.findIndex((ch) => ch.avatar === avatar);
  if (index < 0) throw new Error('找不到这个角色（可能已被删除或改名），请重新发送 /chars');
  if (currentIndex() === index && c.getCurrentChatId()) return { ...switchResult(), greeting: readGreeting() };
  await settle(c.selectCharacterById(index), SWITCH_TIMEOUT_MS);
  const ok = await waitFor(() => currentIndex() === index && !!ctx().getCurrentChatId(), 5000);
  if (!ok) throw new Error('切换角色超时');
  await sleep(300); // 等开场白渲染
  return { ...switchResult(), greeting: readGreeting() };
}

/** 把 ST /api/characters/chats（或 Luker getPastCharacterChats）的结果整理成 ChatInfo，按最近使用排序。纯函数。 */
export function normalizeChats(raw: unknown[]): ChatInfo[] {
  const out: ChatInfo[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.file_name !== 'string' || !o.file_name) continue;
    const fileName = o.file_name.replace(/\.jsonl$/, '');
    let lastMessageAt: number | undefined;
    if (typeof o.last_mes === 'number' && Number.isFinite(o.last_mes)) lastMessageAt = o.last_mes;
    else if (typeof o.last_mes === 'string') {
      const t = Date.parse(o.last_mes);
      if (Number.isFinite(t)) lastMessageAt = t;
    }
    const count = typeof o.chat_items === 'number' ? o.chat_items : Number(o.chat_items);
    const preview = typeof o.mes === 'string' ? o.mes.replace(/\s+/g, ' ').trim().slice(0, 60) : undefined;
    out.push({ fileName, lastMessageAt, messageCount: Number.isFinite(count) ? count : undefined, preview });
  }
  return out.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
}

export async function listChats(): Promise<ChatInfo[]> {
  const i = currentIndex();
  if (i === undefined) throw new Error('ST 当前没有选择角色，先用 /chars 选一个');
  return normalizeChats(await pastChats(i));
}

export async function openChat(fileName: string): Promise<SwitchResult> {
  const c = ctx();
  if (currentIndex() === undefined) throw new Error('ST 当前没有选择角色，先用 /chars 选一个');
  if (c.getCurrentChatId() === fileName) return switchResult();
  assertCardSafe('打开聊天');
  await settle(c.openCharacterChat(fileName), SWITCH_TIMEOUT_MS);
  if (!(await waitFor(() => ctx().getCurrentChatId() === fileName, 5000))) throw new Error('打开聊天超时');
  return switchResult();
}

export async function newChat(): Promise<SwitchResult> {
  const c = ctx();
  if (currentIndex() === undefined) throw new Error('ST 当前没有选择角色，先用 /chars 选一个');
  const before = c.getCurrentChatId();
  assertCardSafe('新建聊天');
  await settle(adapterNewChat(), SWITCH_TIMEOUT_MS);
  if (!(await waitFor(() => !!ctx().getCurrentChatId() && ctx().getCurrentChatId() !== before, 5000))) throw new Error('新建聊天超时');
  await sleep(300); // 等开场白渲染
  return { ...switchResult(), greeting: readGreeting() };
}
