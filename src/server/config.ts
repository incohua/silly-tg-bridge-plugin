import { readFileSync } from 'node:fs';
import { PROXY_ENV_KEYS } from './http';
import type { LogLevel } from './logger';

export interface Config {
  botToken: string;
  allowedUserIds: number[];
  stBaseUrl: string;
  telegramProxy?: string;
  chromiumPath?: string;
  basicAuth?: { username: string; password: string };
  miniAppPort: number;
  publicBaseUrl?: string;
  /** 空闲多少分钟后关闭 Chromium，0 表示不关闭。 */
  idleShutdownMinutes: number;
  /** 使用低内存 Chromium 参数。 */
  lowMemory: boolean;
  /** 对话（带引号的内容）在 Telegram 里的样式：bold 加粗（默认）、italic 斜体、mark 高亮、plain 只保留引号。 */
  dialogueStyle: 'bold' | 'italic' | 'mark' | 'plain';
  logLevel: LogLevel;
  /** 生成时草稿的刷新间隔（秒），范围 0.5–30，默认 1。调大可以减少聊天窗口的上下滚动。 */
  draftIntervalSeconds: number;
  /** 生成时草稿显示什么：live 逐步显示正文（默认），progress 只显示“正在生成… 已写 N 字”。 */
  draftMode: 'live' | 'progress';
  /** 行动选项按钮：numbers 一排数字按钮（默认），rows 每个选项一行并带文字。 */
  choiceLayout: 'numbers' | 'rows';
  /** 仅用于测试：Bot API 根地址（默认 https://api.telegram.org），指向本地假服务做离线联调。 */
  telegramApiBase?: string;
}

export interface ConfigIssue {
  field: string;
  message: string;
}

export type ConfigResult =
  | { ok: true; config: Config; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

const KNOWN_KEYS = new Set([
  'botToken',
  'allowedUserIds',
  'stBaseUrl',
  'telegramProxy',
  'chromiumPath',
  'basicAuth',
  'miniAppPort',
  'publicBaseUrl',
  'idleShutdownMinutes',
  'lowMemory',
  'dialogueStyle',
  'logLevel',
  'draftIntervalSeconds',
  'draftMode',
  'choiceLayout',
  'telegramApiBase',
]);

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 空字符串和 null 都当作没填。 */
const unset = (v: unknown): boolean => v === undefined || v === null || v === '';

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** 校验配置内容。纯函数，错误信息写明改哪个字段、怎么改。 */
export function validateConfig(raw: unknown, source = 'config.json'): ConfigResult {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const err = (field: string, message: string): void => void errors.push({ field, message });

  if (!isRecord(raw)) {
    return { ok: false, errors: [{ field: '(root)', message: `${source} 的内容必须是 JSON 对象，参考 config.example.json。` }], warnings };
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push({ field: key, message: `未知配置项 "${key}"，已忽略。检查是否拼写错误。` });
  }

  // botToken
  let botToken = '';
  if (unset(raw.botToken)) {
    err('botToken', `缺少 botToken。在 Telegram 里找 @BotFather 创建机器人，把得到的 token 填进 ${source}。`);
  } else if (typeof raw.botToken !== 'string' || !TOKEN_RE.test(raw.botToken.trim())) {
    err('botToken', 'botToken 格式不对，应形如 "123456789:AA..."（@BotFather 给出的完整 token，不带 "bot" 前缀）。');
  } else {
    botToken = raw.botToken.trim();
  }

  // allowedUserIds
  let allowedUserIds: number[] = [];
  if (!Array.isArray(raw.allowedUserIds) || raw.allowedUserIds.length === 0) {
    err(
      'allowedUserIds',
      `allowedUserIds 为空。填入允许使用的 Telegram 用户数字 ID（可向 @userinfobot 查询），例如 [123456789]。为空时任何人都不能用，插件不会启动。`,
    );
  } else if (!raw.allowedUserIds.every((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
    err('allowedUserIds', 'allowedUserIds 的每一项必须是正整数（用户数字 ID，不是用户名，也不要加引号）。');
  } else {
    allowedUserIds = [...new Set(raw.allowedUserIds)];
  }

  // stBaseUrl
  let stBaseUrl = 'http://127.0.0.1:8000';
  if (!unset(raw.stBaseUrl)) {
    const u = typeof raw.stBaseUrl === 'string' ? parseUrl(raw.stBaseUrl) : null;
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
      err('stBaseUrl', 'stBaseUrl 必须是 http:// 或 https:// 开头的地址，例如 "http://127.0.0.1:8000"。');
    } else {
      stBaseUrl = u.origin + u.pathname.replace(/\/+$/, '');
    }
  }

  // telegramProxy
  let telegramProxy: string | undefined;
  if (!unset(raw.telegramProxy)) {
    const u = typeof raw.telegramProxy === 'string' ? parseUrl(raw.telegramProxy) : null;
    if (!u) {
      err('telegramProxy', 'telegramProxy 不是合法地址，例如 "http://127.0.0.1:7890"。');
    } else if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      err(
        'telegramProxy',
        `telegramProxy 只支持 http:// 或 https:// 代理，不支持 ${u.protocol.replace(':', '')}://。如果你的代理软件同时提供 HTTP 端口，请改用那个端口。`,
      );
    } else {
      telegramProxy = (raw.telegramProxy as string).trim();
    }
  }

  // chromiumPath
  let chromiumPath: string | undefined;
  if (!unset(raw.chromiumPath)) {
    if (typeof raw.chromiumPath !== 'string') err('chromiumPath', 'chromiumPath 必须是字符串路径。');
    else chromiumPath = raw.chromiumPath;
  }

  // basicAuth
  let basicAuth: Config['basicAuth'];
  if (!unset(raw.basicAuth)) {
    const b = raw.basicAuth;
    if (!isRecord(b) || typeof b.username !== 'string' || typeof b.password !== 'string' || !b.username) {
      err('basicAuth', 'basicAuth 应为 {"username": "...", "password": "..."}（与 ST config.yaml 里 basicAuthUser 一致），不用时填 null。');
    } else {
      basicAuth = { username: b.username, password: b.password };
    }
  }

  // miniAppPort
  let miniAppPort = 8788;
  if (!unset(raw.miniAppPort)) {
    const p = raw.miniAppPort;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) err('miniAppPort', 'miniAppPort 必须是 1–65535 的整数。');
    else miniAppPort = p;
  }

  // publicBaseUrl
  let publicBaseUrl: string | undefined;
  if (!unset(raw.publicBaseUrl)) {
    const u = typeof raw.publicBaseUrl === 'string' ? parseUrl(raw.publicBaseUrl) : null;
    if (!u || u.protocol !== 'https:') {
      err('publicBaseUrl', 'publicBaseUrl 必须是 https:// 开头的地址（Telegram Mini App 要求 HTTPS）。不需要 Mini App 时留空。');
    } else {
      publicBaseUrl = u.origin + u.pathname.replace(/\/+$/, '');
    }
  }

  // idleShutdownMinutes
  let idleShutdownMinutes = 0;
  if (!unset(raw.idleShutdownMinutes)) {
    const m = raw.idleShutdownMinutes;
    if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) err('idleShutdownMinutes', 'idleShutdownMinutes 必须是大于等于 0 的数字（分钟），0 表示不自动关闭。');
    else idleShutdownMinutes = m;
  }

  // lowMemory
  let lowMemory = true;
  if (raw.lowMemory !== undefined && raw.lowMemory !== null) {
    if (typeof raw.lowMemory !== 'boolean') err('lowMemory', 'lowMemory 必须是 true 或 false。');
    else lowMemory = raw.lowMemory;
  }

  // dialogueStyle
  let dialogueStyle: Config['dialogueStyle'] = 'bold';
  if (!unset(raw.dialogueStyle)) {
    if (raw.dialogueStyle !== 'bold' && raw.dialogueStyle !== 'italic' && raw.dialogueStyle !== 'mark' && raw.dialogueStyle !== 'plain') err('dialogueStyle', 'dialogueStyle 必须是 bold / italic / mark / plain 之一。');
    else dialogueStyle = raw.dialogueStyle;
  }

  // logLevel
  let logLevel: LogLevel = 'info';
  if (!unset(raw.logLevel)) {
    if (typeof raw.logLevel !== 'string' || !LOG_LEVELS.includes(raw.logLevel)) err('logLevel', `logLevel 必须是 ${LOG_LEVELS.join(' / ')} 之一。`);
    else logLevel = raw.logLevel as LogLevel;
  }

  // draftIntervalSeconds
  let draftIntervalSeconds = 1;
  if (!unset(raw.draftIntervalSeconds)) {
    const d = raw.draftIntervalSeconds;
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0.5 || d > 30) err('draftIntervalSeconds', 'draftIntervalSeconds 必须是 0.5–30 之间的数字（秒）。');
    else draftIntervalSeconds = d;
  }

  // draftMode
  let draftMode: Config['draftMode'] = 'live';
  if (!unset(raw.draftMode)) {
    if (raw.draftMode !== 'live' && raw.draftMode !== 'progress') err('draftMode', 'draftMode 必须是 live 或 progress。');
    else draftMode = raw.draftMode;
  }

  // choiceLayout
  let choiceLayout: Config['choiceLayout'] = 'numbers';
  if (!unset(raw.choiceLayout)) {
    if (raw.choiceLayout !== 'numbers' && raw.choiceLayout !== 'rows') err('choiceLayout', 'choiceLayout 必须是 numbers 或 rows。');
    else choiceLayout = raw.choiceLayout;
  }

  // telegramApiBase（测试用）
  let telegramApiBase: string | undefined;
  if (!unset(raw.telegramApiBase)) {
    const u = typeof raw.telegramApiBase === 'string' ? parseUrl(raw.telegramApiBase) : null;
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
      err('telegramApiBase', 'telegramApiBase 必须是 http:// 或 https:// 地址。这个配置项只用于测试，正常使用时不要填。');
    } else {
      telegramApiBase = u.origin + u.pathname.replace(/\/+$/, '');
      warnings.push({ field: 'telegramApiBase', message: `telegramApiBase 已设置为 ${telegramApiBase}，不会连接真正的 Telegram（仅用于测试）。` });
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    warnings,
    config: { botToken, allowedUserIds, stBaseUrl, telegramProxy, chromiumPath, basicAuth, miniAppPort, publicBaseUrl, idleShutdownMinutes, lowMemory, dialogueStyle, logLevel, draftIntervalSeconds, draftMode, choiceLayout, telegramApiBase },
  };
}

/** 读取并校验配置文件。文件缺失、JSON 语法错误都转成可读的错误项。 */
export function loadConfigFile(path: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): ConfigResult {
  let text: string;
  try {
    text = read(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT'
        ? `找不到配置文件 ${path}。把插件目录下的 config.example.json 复制为 config.json，填好 botToken 和 allowedUserIds 后重启 ST。`
        : `无法读取配置文件 ${path}：${(e as Error).message}`;
    return { ok: false, errors: [{ field: '(file)', message }], warnings: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    // Node 的 JSON 错误消息会附带一段原文片段，可能含 token，所以只取位置信息。
    const pos = /position (\d+)/.exec((e as Error).message)?.[1];
    const where = pos ? `（大约在第 ${pos} 个字符附近）` : '';
    return { ok: false, errors: [{ field: '(file)', message: `${path} 不是合法的 JSON${where}。检查逗号、引号和括号。` }], warnings: [] };
  }
  return validateConfig(raw, path);
}

/**
 * 配置里所有需要从日志中隐去的字符串。
 * 传入 env 时，把环境变量代理（HTTPS_PROXY 等）地址里的账号密码也算上；不传则只看配置。
 */
export function configSecrets(c: Config, env?: NodeJS.ProcessEnv): string[] {
  const out = [c.botToken];
  if (c.basicAuth?.password) out.push(c.basicAuth.password);
  const proxies = [c.telegramProxy];
  if (env) for (const k of PROXY_ENV_KEYS) proxies.push(env[k]);
  for (const p of proxies) {
    const u = p ? parseUrl(p.trim()) : null;
    // URL 里的账号密码是百分号编码形式；错误信息可能带编码前或编码后的写法，两种都隐去
    for (const v of [u?.password, u?.username]) {
      if (!v) continue;
      out.push(v);
      try {
        const d = decodeURIComponent(v);
        if (d !== v) out.push(d);
      } catch {
        // 百分号编码不合法时只保留原文
      }
    }
  }
  return out;
}
