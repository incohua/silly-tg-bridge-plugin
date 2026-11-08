// ST 与 Luker 的差异只放在这里。模块顶层不访问浏览器全局，纯函数部分可在 Node 中测试，
// 服务端（browser.ts）也复用其中的错误忽略清单。
//
// 已核实的差异（见父任务 design.md 第 5 节“适配层”）：
// - 入口：Luker 同时提供 globalThis.Luker 与 SillyTavern（同一对象），ST 只有 SillyTavern。
// - 就绪：两者的 eventSource 都把 APP_READY 设为“发生过就自动补发”，所以页面内统一等 APP_READY。
//   从 Puppeteer 控制台看，ST 输出 "Event emitted: app_ready"，Luker 输出 "[init] firstLoadInit complete"，
//   见 READY_CONSOLE_PATTERNS。#preloader 在两边都不能作为依据。
// - 新建聊天：Luker 的 context 有 doNewChat，ST 1.19 用 slash 命令 /newchat。
// - 历史聊天列表：Luker 的 context 有 getPastCharacterChats，ST 1.19 直接请求 /api/characters/chats（只读）。
// - 首次加载噪音：Luker 的 /api/sd/* 500、若干 worldinfo 404、一条 jQuery UI pageerror，不上报、不触发看门狗。

import type { StContext, StHostApi } from './st-types';

export type HostApp = 'st' | 'luker';

/** 无头页面控制台里表示前端初始化完成的日志（Puppeteer 侧观察用）。 */
export const READY_CONSOLE_PATTERNS: readonly string[] = ['Event emitted: app_ready', '[init] firstLoadInit complete'];

export function isReadyConsoleLine(text: string): boolean {
  return READY_CONSOLE_PATTERNS.some((p) => text.includes(p));
}

/** 错误忽略清单：返回 true 表示这是已知的无害噪音。 */
export interface NoiseInput {
  /** 'http'：失败的网络请求；'error'：页面错误或控制台错误。 */
  kind: 'http' | 'error';
  url?: string;
  status?: number;
  message?: string;
}

const NOISE_RULES: Array<(n: NoiseInput) => boolean> = [
  // Luker 没配置 Stable Diffusion 时的 /api/sd/* 500
  (n) => n.kind === 'http' && n.status === 500 && /\/api\/sd\//.test(n.url ?? ''),
  // Luker 内置工具查询的 worldinfo 404（__SEARCH_TOOLS__、__MEMORY_GRAPH__ 等）
  (n) => n.kind === 'http' && n.status === 404 && /\/api\/worldinfo\/get/.test(n.url ?? ''),
  // Luker 首次加载时 jQuery UI autocomplete 的 pageerror
  (n) => n.kind === 'error' && /autocomplete/i.test(n.message ?? '') && /jquery|ui|widget|instance/i.test(n.message ?? ''),
  // 浏览器自带的 favicon 请求
  (n) => n.kind === 'http' && n.status === 404 && /favicon\.ico/.test(n.url ?? ''),
];

export function isKnownNoise(n: NoiseInput): boolean {
  return NOISE_RULES.some((r) => r(n));
}

/** 取 ST / Luker 的全局入口。没加载时返回 undefined。 */
export function getHostApi(g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): StHostApi | undefined {
  const api = (g.Luker ?? g.SillyTavern) as StHostApi | undefined;
  return api && typeof api.getContext === 'function' ? api : undefined;
}

export function detectApp(g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): HostApp {
  return g.Luker !== undefined ? 'luker' : 'st';
}

/** 每次都重新取 context：ST 的 getContext() 返回的是当时的快照（chat 数组、角色 id 都可能变）。 */
export function ctx(): StContext {
  const api = getHostApi();
  if (!api) throw new Error('SillyTavern / Luker 的 getContext 不可用');
  return api.getContext();
}

/** 等前端初始化完成。APP_READY 是自动补发事件，已经发生过时监听会立即回调。 */
export function waitAppReady(timeoutMs: number): Promise<'ready' | 'timeout'> {
  return new Promise((resolve) => {
    const c = ctx();
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    c.eventSource.once(c.eventTypes.APP_READY, () => {
      clearTimeout(timer);
      resolve('ready');
    });
  });
}

/** 新建聊天。 */
export async function newChat(): Promise<void> {
  const c = ctx();
  if (typeof c.doNewChat === 'function') await c.doNewChat({ deleteCurrentChat: false });
  else await c.executeSlashCommandsWithOptions('/newchat', { handleParserErrors: false });
}

/** 当前角色的历史聊天，原始结构（各项含 file_name、last_mes、chat_items、mes）。 */
export async function pastChats(characterIndex: number): Promise<unknown[]> {
  const c = ctx();
  if (typeof c.getPastCharacterChats === 'function') {
    const r = await c.getPastCharacterChats(characterIndex);
    return Array.isArray(r) ? r : [];
  }
  const avatar = c.characters[characterIndex]?.avatar;
  if (!avatar) return [];
  const res = await fetch('/api/characters/chats', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
  if (!res.ok) throw new Error(`读取聊天列表失败：HTTP ${res.status}`);
  const j = (await res.json()) as unknown;
  return Array.isArray(j) ? j : [];
}
