// 配置面板里不依赖 DOM 的部分：服务端响应的类型、表单值到提交内容的转换、运行状态的文案。可在 Node 中测试。

import type { RuntimeStatus } from '../shared/runtime-status';

/** 保存后不影响正在运行的浏览器、下次启动 Chromium 才生效的字段。 */
const NEXT_START_FIELDS: readonly string[] = ['lowMemory', 'pageHeapLimitMB'];

export interface SettingsValues {
  botToken: { set: boolean };
  allowedUserIds: number[];
  telegramProxy: string;
  stBaseUrl: string;
  basicAuth: { username: string; passwordSet: boolean } | null;
  idleShutdownMinutes: number;
  lowMemory: boolean;
  pageHeapLimitMB: number;
  dialogueStyle: string;
  logLevel: string;
  draftIntervalSeconds: number;
  draftMode: string;
  choiceLayout: string;
}

export interface SettingsResponse {
  ok: boolean;
  running?: boolean;
  startErrors?: Array<{ field: string; message: string }>;
  exists?: boolean;
  values?: SettingsValues;
  error?: string;
  /** 本地判断出的：服务端插件没装（接口返回 HTTP 404）。不是服务端响应里的字段。 */
  serverMissing?: boolean;
  errors?: Array<{ field: string; message: string }>;
  changed?: string[];
  hot?: string[];
  /** 触发了运行时重新加载的字段（待命时为全部改动）。 */
  reloaded?: string[];
  /** 这次保存是否重新加载了运行时；待命时即使没有改动也会按现有 config.json 重新启动一次。 */
  reloadedRuntime?: boolean;
  /** POST /reload（面板的“重新连接”按钮）的响应：按磁盘上的 config.json 重新加载了运行时。 */
  reconnected?: boolean;
  /** 服务端运行状态（GET/POST /config 与 GET /status 都带）。 */
  runtime?: RuntimeStatus;
}

/** 表单里用户填的原始值（都是字符串/布尔）。 */
export interface FormValues {
  botToken: string;
  allowedUserIds: string;
  telegramProxy: string;
  stBaseUrl: string;
  basicAuthUser: string;
  basicAuthPassword: string;
  idleShutdownMinutes: string;
  lowMemory: boolean;
  pageHeapLimitMB: string;
  dialogueStyle: string;
  logLevel: string;
  draftIntervalSeconds: string;
  draftMode: string;
  choiceLayout: string;
}

export type ParsedIds = { ok: true; ids: number[] } | { ok: false; message: string };

/** 用逗号、空格或换行分隔的用户 ID。 */
export function parseUserIds(text: string): ParsedIds {
  const parts = text.split(/[\s,，、;；]+/).filter(Boolean);
  const ids: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p) || !Number.isSafeInteger(Number(p)) || Number(p) <= 0) {
      return { ok: false, message: `“${p}”不是用户数字 ID（应为纯数字，可向 @userinfobot 查询，不是用户名）。` };
    }
    ids.push(Number(p));
  }
  return { ok: true, ids: [...new Set(ids)] };
}

export type BuildResult = { ok: true; patch: Record<string, unknown> } | { ok: false; errors: Array<{ field: string; message: string }> };

/**
 * 表单值转成提交给服务端的 patch。
 * 密码类字段留空表示不修改；客户端不做字段校验（以服务端 validateConfig 为准），只处理格式转换。
 */
export function buildPatch(form: FormValues, original: SettingsValues | undefined): BuildResult {
  const errors: Array<{ field: string; message: string }> = [];
  const patch: Record<string, unknown> = {};

  if (form.botToken.trim()) patch.botToken = form.botToken.trim();

  const ids = parseUserIds(form.allowedUserIds);
  if (ids.ok) patch.allowedUserIds = ids.ids;
  else errors.push({ field: 'allowedUserIds', message: ids.message });

  patch.telegramProxy = form.telegramProxy.trim();
  patch.stBaseUrl = form.stBaseUrl.trim();

  if (form.basicAuthUser.trim()) patch.basicAuth = { username: form.basicAuthUser.trim(), password: form.basicAuthPassword };
  else if (original?.basicAuth) patch.basicAuth = null;

  const idle = form.idleShutdownMinutes.trim() === '' ? 0 : Number(form.idleShutdownMinutes);
  if (!Number.isFinite(idle)) errors.push({ field: 'idleShutdownMinutes', message: '空闲关闭时间必须是数字（分钟），0 表示不关闭。' });
  else patch.idleShutdownMinutes = idle;

  patch.lowMemory = form.lowMemory;
  const heap = form.pageHeapLimitMB.trim() === '' ? 512 : Number(form.pageHeapLimitMB);
  if (!Number.isInteger(heap) || heap < 128 || heap > 4096) errors.push({ field: 'pageHeapLimitMB', message: '页面内存上限必须是 128–4096 之间的整数（MB），默认 512。' });
  else patch.pageHeapLimitMB = heap;
  patch.dialogueStyle = form.dialogueStyle;
  patch.logLevel = form.logLevel;
  patch.draftMode = form.draftMode;
  patch.choiceLayout = form.choiceLayout;

  const draft = form.draftIntervalSeconds.trim() === '' ? 1 : Number(form.draftIntervalSeconds);
  if (!Number.isFinite(draft)) errors.push({ field: 'draftIntervalSeconds', message: '草稿刷新间隔必须是数字（秒）。' });
  else patch.draftIntervalSeconds = draft;

  return errors.length > 0 ? { ok: false, errors } : { ok: true, patch };
}

/** 保存结果的提示文字。保存后不再需要重启 ST：连接类字段由服务端当场重新连接。 */
export function saveResultMessage(r: SettingsResponse): string {
  const changed = r.changed ?? [];
  const hot = r.hot ?? [];
  const reloaded = r.reloaded ?? [];
  const rt = r.runtime;
  // 待命时没有改动也会重新启动一次（例如手动改好了 config.json，在面板里点保存让它生效）
  const head = r.reconnected ? '已按 config.json 重新连接' : changed.length > 0 ? '已保存' : r.reloadedRuntime ? '没有改动，已按现有 config.json 重新启动' : '没有改动';
  const parts: string[] = [`${head}。`];
  // 这两项保存后不会动正在运行的浏览器，下次启动 Chromium 才用上新值
  const nextStart = hot.filter((f) => NEXT_START_FIELDS.includes(f));
  const immediate = hot.filter((f) => !NEXT_START_FIELDS.includes(f));
  if (immediate.length > 0) parts.push(`已立即生效：${immediate.map(fieldLabel).join('、')}。`);
  if (nextStart.length > 0) parts.push(`下次启动无头浏览器时生效：${nextStart.map(fieldLabel).join('、')}。`);
  // 只有重新加载过、或者当前不在正常运行时，才补一句运行状态
  if (!rt || (!r.reloadedRuntime && reloaded.length === 0 && rt.state === 'running' && rt.telegram !== 'error')) return parts.join('');
  if (runtimeSettling(rt)) return `${parts.join('')}正在重新连接…`;
  if (rt.state === 'standby') return `${head}，但插件没有启动：${rt.errors?.map((e) => e.message).join('；') || '请检查配置'}`;
  if (rt.telegram === 'error') return `${head}，但连接 Telegram 失败：${rt.telegramError ?? '原因见 ST 日志'}`;
  if (rt.telegram === 'ok') parts.push(`已重新连接${rt.botUsername ? `，bot：@${rt.botUsername}` : ''}。`);
  else parts.push('已重新加载。');
  return parts.join('');
}

export type RuntimeLineLevel = 'ok' | 'error' | 'pending' | 'idle';
export interface RuntimeLine {
  level: RuntimeLineLevel;
  text: string;
}
export const LEVEL_ICON: Record<RuntimeLineLevel, string> = { ok: '🟢', error: '🔴', pending: '⏳', idle: '⚪' };

/** 面板状态区的几行：总体状态、Telegram、Chromium、无头页面。文字都来自固定文案或服务端已脱敏的字段。 */
export function describeRuntime(rt: RuntimeStatus): RuntimeLine[] {
  const lines: RuntimeLine[] = [];
  const add = (level: RuntimeLineLevel, text: string): void => void lines.push({ level, text });
  switch (rt.state) {
    case 'standby':
      if (rt.standbyReason === 'invalid-config') add('error', '待命：配置有误，修正后保存即可，无需重启 ST。');
      else if (rt.standbyReason === 'start-failed') add('error', '待命：上次启动失败，修正后再保存一次即可重试。');
      else add('idle', '待命：还没有配置。填写 Bot Token 和允许的用户 ID 后保存，插件会立即启动。');
      for (const e of rt.errors ?? []) add('error', `· ${e.field}：${e.message}`);
      break;
    case 'starting':
      add('pending', '正在启动…');
      break;
    case 'stopping':
      add('pending', '正在重新加载…');
      break;
    case 'running':
      add('ok', '运行中');
      break;
  }
  if (rt.telegram === 'ok') add('ok', `Telegram：已连接${rt.botUsername ? ` @${rt.botUsername}` : ''}`);
  else if (rt.telegram === 'error') add('error', `Telegram：连接失败。${rt.telegramError ?? '原因见 ST 日志'}`);
  else if (rt.telegram === 'pending') add('pending', 'Telegram：连接中…');
  else add('idle', rt.state === 'running' ? 'Telegram：未连接（离线模式）' : 'Telegram：未连接');
  if (rt.chromium.found) add('ok', 'Chromium：已找到');
  else add('error', `Chromium：未找到。${rt.chromium.hint ?? ''}`.trim());
  if (rt.hostConnected) add('ok', `无头页面：已连接${rt.hostPage ? `（ST ${rt.hostPage.stVersion}）` : ''}`);
  else if (rt.state === 'running' && rt.chromium.found) add('pending', '无头页面：未连接（正在启动，或已空闲关闭，收到消息时会自动启动）');
  else add('idle', '无头页面：未启动');
  return lines;
}

/** 启动或重新加载还没结束（不含“页面还没连上”这种可能长期存在的稳定状态）。 */
export function runtimeSettling(rt: RuntimeStatus): boolean {
  return rt.state === 'starting' || rt.state === 'stopping' || rt.telegram === 'pending';
}

/** 面板轮询到时还没结束时的提示。 */
export const POLL_TIMEOUT_NOTE = '30 秒内还没有完成（可能是网络或代理较慢）。稍后重新打开本面板查看状态，或查看 ST 的日志。';

/** 状态还在变化（启动、重新加载、连接中、页面还没连上），面板应继续轮询 GET /status。 */
export function runtimeInProgress(rt: RuntimeStatus): boolean {
  if (runtimeSettling(rt)) return true;
  return rt.state === 'running' && rt.chromium.found && !rt.hostConnected;
}

export const FIELD_LABELS: Record<string, string> = {
  botToken: 'Bot Token',
  allowedUserIds: '允许的用户 ID',
  telegramProxy: 'Telegram 代理',
  stBaseUrl: 'ST 地址',
  basicAuth: 'ST 登录账号',
  idleShutdownMinutes: '空闲关闭时间',
  lowMemory: '低内存模式',
  pageHeapLimitMB: '页面内存上限',
  dialogueStyle: '对话样式',
  logLevel: '日志级别',
  draftIntervalSeconds: '草稿刷新间隔',
  draftMode: '草稿显示方式',
  choiceLayout: '选项按钮排版',
};

export const fieldLabel = (k: string): string => FIELD_LABELS[k] ?? k;

/** 配置接口失败的归类。 */
export type ConfigFailure = 'server-missing' | 'other';

/**
 * 只有 HTTP 404 才认为服务端插件没装（ST 找不到 /api/plugins/silly-tg/* 路由）。
 * 401、403、5xx 和网络错误（ST 本身连不上也会抛）都不是“没装”，仍按原来的错误提示处理。
 * 必须在 res.json() 之前判断：404 时 ST 返回的是 HTML，不是 JSON。
 */
export function classifyConfigFailure(status: number): ConfigFailure {
  return status === 404 ? 'server-missing' : 'other';
}

/**
 * 服务端插件没有加载时的引导文案。全部是固定文字，不含任何来自服务端响应的内容。
 * 覆盖两种情况：只装了扩展（没 clone 服务端插件）；clone 了但 enableServerPlugins 没开。
 */
export const INSTALL_GUIDE = {
  title: '服务端插件没有加载',
  intro: '这个扩展只是 Silly TG 的页面部分，需要配套的服务端插件才能工作。出现这段说明，是因为 ST 没有加载它：可能还没装到 ST 的 plugins 目录，或者 config.yaml 里的 enableServerPlugins 不是 true。请按下面的步骤检查：',
  command: 'git clone https://github.com/incohua/silly-tg-bridge-plugin plugins/silly-tg-bridge-plugin',
  steps: [
    '在 SillyTavern 的根目录执行上面的命令（需要已安装 git）。plugins 目录下已经有它（目录名随意）就不用再执行。',
    '打开 ST 根目录的 config.yaml，把 enableServerPlugins 改成 true（已经是 true 就不用改）。默认是 false，不开启时插件不会被加载，也没有任何提示。',
    '重启 ST 一次，然后刷新本页面，回到这里填写 Bot Token 和允许的用户 ID 并保存。保存后立即生效，无需再重启。',
  ],
  readmeUrl: 'https://github.com/incohua/silly-tg-bridge-plugin#安装',
  readmeText: '查看完整安装说明',
} as const;
