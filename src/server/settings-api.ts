// 酒馆扩展栏里的配置面板对应的服务端接口：GET/POST /api/plugins/silly-tg/config、GET /status。
// 路由继承 ST 的会话、CSRF 和 basic auth 鉴权。
// 保存后不再需要重启 ST：热字段直接写进运行中的配置；连接类字段（token、代理、ST 地址、登录账号）
// 触发运行时重新加载（停掉旧的轮询和浏览器，用新配置拉起），见 supervisor.ts。
// 安全约定：
//   - 读取时密码类字段（botToken、basicAuth.password、代理里的密码）一律掩码，响应里没有明文。
//   - 保存时掩码值或空值表示“不修改”，不会把掩码写进文件。
//   - chromiumPath（会被当作可执行文件启动）、telegramApiBase 等不受管理的字段不返回、不接受修改，原样保留。
//   - 先用 validateConfig 校验，通过才写入；写入用临时文件加 rename，保留文件里面板不管理的字段。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Router } from 'express';
import type { RuntimeStatus } from '../shared/runtime-status';
import { validateConfig, type Config, type ConfigIssue } from './config';
import type { Logger } from './logger';
import { redactError } from './redact';

export const MASK = '********';

/**
 * 保存后立即生效的字段（写进运行中的同一个 Config 对象，消费方用 getter 或每次读取）。
 * allowedUserIds 的读取点只有轮询过滤（plugin.ts）和通知（bridge.ts 的 notify），都是每次实时读。
 */
export const HOT_FIELDS = ['allowedUserIds', 'dialogueStyle', 'logLevel', 'idleShutdownMinutes', 'lowMemory', 'draftIntervalSeconds', 'draftMode', 'choiceLayout'] as const;
/** 保存后触发运行时重新加载的字段（重建 Telegram 客户端、轮询和无头浏览器），无需重启 ST。 */
export const RELOAD_FIELDS = ['botToken', 'telegramProxy', 'basicAuth', 'stBaseUrl'] as const;
export const MANAGED_FIELDS: readonly string[] = [...RELOAD_FIELDS, ...HOT_FIELDS];

export type Effect = 'hot' | 'reload';
export const FIELD_EFFECTS: Record<string, Effect> = {
  ...Object.fromEntries(HOT_FIELDS.map((f) => [f, 'hot' as const])),
  ...Object.fromEntries(RELOAD_FIELDS.map((f) => [f, 'reload' as const])),
  // lowMemory 的新值在下次启动 Chromium 时才会用上，界面上单独说明
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 代理地址里的密码换成掩码。 */
export function maskProxy(url: string): string {
  try {
    const u = new URL(url);
    if (!u.password) return url;
    u.password = MASK;
    return url.endsWith('/') ? u.toString() : u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

export interface SettingsView {
  /** config.json 是否存在。 */
  exists: boolean;
  values: {
    botToken: { set: boolean };
    allowedUserIds: number[];
    telegramProxy: string;
    stBaseUrl: string;
    basicAuth: { username: string; passwordSet: boolean } | null;
    idleShutdownMinutes: number;
    lowMemory: boolean;
    dialogueStyle: string;
    logLevel: string;
    draftIntervalSeconds: number;
    draftMode: string;
    choiceLayout: string;
  };
}

/** 从 config.json 的原始 JSON 生成给界面的视图（掩码、只含受管理的字段，缺省值与 validateConfig 一致）。 */
export function viewSettings(raw: Record<string, unknown>, exists: boolean): SettingsView {
  const ba = raw.basicAuth;
  return {
    exists,
    values: {
      botToken: { set: typeof raw.botToken === 'string' && raw.botToken.trim() !== '' },
      allowedUserIds: Array.isArray(raw.allowedUserIds) ? raw.allowedUserIds.filter((x): x is number => typeof x === 'number') : [],
      telegramProxy: typeof raw.telegramProxy === 'string' ? maskProxy(raw.telegramProxy) : '',
      stBaseUrl: typeof raw.stBaseUrl === 'string' && raw.stBaseUrl ? raw.stBaseUrl : 'http://127.0.0.1:8000',
      basicAuth: isRecord(ba) && typeof ba.username === 'string' ? { username: ba.username, passwordSet: typeof ba.password === 'string' && ba.password !== '' } : null,
      idleShutdownMinutes: typeof raw.idleShutdownMinutes === 'number' ? raw.idleShutdownMinutes : 0,
      lowMemory: typeof raw.lowMemory === 'boolean' ? raw.lowMemory : true,
      dialogueStyle: typeof raw.dialogueStyle === 'string' && raw.dialogueStyle ? raw.dialogueStyle : 'bold',
      logLevel: typeof raw.logLevel === 'string' && raw.logLevel ? raw.logLevel : 'info',
      draftIntervalSeconds: typeof raw.draftIntervalSeconds === 'number' ? raw.draftIntervalSeconds : 1,
      draftMode: typeof raw.draftMode === 'string' && raw.draftMode ? raw.draftMode : 'live',
      choiceLayout: typeof raw.choiceLayout === 'string' && raw.choiceLayout ? raw.choiceLayout : 'numbers',
    },
  };
}

export type ApplyResult =
  | { ok: true; raw: Record<string, unknown>; config: Config; changed: string[]; hot: string[]; reload: string[]; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[] };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const keep = (v: unknown): boolean => v === undefined || v === '' || v === MASK;

/**
 * 把界面提交的 patch 合并进现有的原始配置并校验。纯函数。
 * 只处理受管理的字段；其余字段（chromiumPath 等）以现有文件为准。
 */
export function applySettings(existing: Record<string, unknown>, patch: unknown): ApplyResult {
  if (!isRecord(patch)) return { ok: false, errors: [{ field: '(root)', message: '提交的内容不是对象。' }] };
  const next: Record<string, unknown> = { ...existing };

  for (const key of MANAGED_FIELDS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    switch (key) {
      case 'botToken':
        if (!keep(v)) next.botToken = typeof v === 'string' ? v.trim() : v;
        break;
      case 'telegramProxy':
        if (typeof v === 'string' && v === maskProxy(String(existing.telegramProxy ?? ''))) break; // 未修改（含掩码的原值）
        if (typeof v === 'string' && v.includes(MASK)) {
          // 用户只改了地址、保留了掩码的密码：把密码换回原值
          const old = typeof existing.telegramProxy === 'string' ? safeUrl(existing.telegramProxy) : null;
          const cur = safeUrl(v.replace(MASK, 'x'));
          if (old?.password && cur) {
            cur.password = old.password;
            next.telegramProxy = v.endsWith('/') ? cur.toString() : cur.toString().replace(/\/$/, '');
            break;
          }
        }
        next.telegramProxy = typeof v === 'string' ? v.trim() : v;
        break;
      case 'basicAuth': {
        if (v === null) {
          next.basicAuth = null;
          break;
        }
        if (!isRecord(v)) {
          next.basicAuth = v; // 交给 validateConfig 报错
          break;
        }
        const old = isRecord(existing.basicAuth) ? existing.basicAuth : {};
        const password = keep(v.password) ? (typeof old.password === 'string' ? old.password : '') : v.password;
        next.basicAuth = { username: v.username, password };
        break;
      }
      default:
        next[key] = v;
    }
  }

  const result = validateConfig(next, 'config.json');
  if (!result.ok) return { ok: false, errors: result.errors };

  const changed = MANAGED_FIELDS.filter((k) => !same(existing[k], next[k]));
  return {
    ok: true,
    raw: next,
    config: result.config,
    changed,
    hot: changed.filter((k) => FIELD_EFFECTS[k] === 'hot'),
    reload: changed.filter((k) => FIELD_EFFECTS[k] === 'reload'),
    warnings: result.warnings,
  };
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** 读取原始配置。文件不存在返回 exists:false；不是合法 JSON 或不是对象抛错（不带原文，避免泄露 token）。 */
export function readRawConfig(path: string): { raw: Record<string, unknown>; exists: boolean } {
  if (!existsSync(path)) return { raw: {}, exists: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('config.json 不是合法的 JSON，请先手动修正（面板不会覆盖它）。');
  }
  if (!isRecord(parsed)) throw new Error('config.json 的内容必须是 JSON 对象。');
  return { raw: parsed, exists: true };
}

/** 原子写入：临时文件加 rename，权限 600（含 token）。 */
export function writeRawConfig(path: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // 不支持 chmod 的文件系统忽略
  }
  renameSync(tmp, path);
}

export interface SettingsRouteOptions {
  configPath: string;
  log: Logger;
  /** 当前运行中（或正在启动）的配置；待命时为 null。 */
  live: () => Config | null;
  /** 运行时监管（supervisor.ts）：状态与重新加载。 */
  runtime: {
    status(): RuntimeStatus;
    reload(): Promise<RuntimeStatus>;
  };
  /** 保存成功后让热生效字段立即生效。 */
  applyHot: (config: Config) => void;
  secrets?: () => string[];
  /** POST 等待重新加载的上限，默认 25 秒；到点先返回当前状态，面板接着轮询 GET /status。 */
  reloadWaitMs?: number;
}

/**
 * ST 开启多用户账号时，插件路由对所有已登录用户开放；配置里有 bot token 和白名单，只允许管理员访问。
 * 单用户模式下 req.user 的 profile.admin 为 true；拿不到 req.user（没有账号体系的旧版本）时放行。
 */
function isAdmin(req: import('express').Request): boolean {
  const user = (req as unknown as { user?: { profile?: { admin?: boolean } } }).user;
  return !user || user.profile?.admin === true;
}

/** 把校验后的新配置里热生效的字段写进运行中的 Config 对象（消费方用 getter 实时读取）。 */
export function assignHotFields(target: Config, source: Config): void {
  for (const f of HOT_FIELDS) (target as unknown as Record<string, unknown>)[f] = source[f];
}

/**
 * 校验并保存一个设置补丁到 config.json，热生效字段立即应用到运行中的配置。失败抛出带可读原因的错误。
 * bot 里的 /settings 用它；它与面板接口走同一套 applySettings 校验。
 */
export function saveSettingsPatch(configPath: string, live: Config, patch: Record<string, unknown>): void {
  const { raw } = readRawConfig(configPath);
  const r = applySettings(raw, patch);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('；'));
  writeRawConfig(configPath, r.raw);
  assignHotFields(live, r.config);
}

/** 注册 GET/POST /config 与 GET /status。 */
export function registerSettingsRoutes(router: Router, opts: SettingsRouteOptions): void {
  const { configPath, log } = opts;
  const fail = (res: import('express').Response, status: number, error: string): void => void res.status(status).json({ ok: false, error });
  const denied = (req: import('express').Request, res: import('express').Response): boolean => {
    if (isAdmin(req)) return false;
    fail(res, 403, '只有 ST 管理员可以查看或修改 Silly TG 配置。');
    return true;
  };

  router.get('/config', (req, res) => {
    if (denied(req, res)) return;
    try {
      const { raw, exists } = readRawConfig(configPath);
      const runtime = opts.runtime.status();
      res.json({
        ok: true,
        running: runtime.state === 'running',
        // 旧版面板读这个字段；新版面板看 runtime
        startErrors: runtime.state === 'standby' ? (runtime.errors ?? []) : [],
        effects: FIELD_EFFECTS,
        runtime,
        ...viewSettings(raw, exists),
      });
    } catch (e) {
      fail(res, 500, (e as Error).message);
    }
  });

  router.get('/status', (req, res) => {
    if (denied(req, res)) return;
    res.json({ ok: true, runtime: opts.runtime.status() });
  });

  /** 重新加载运行时，最多等 reloadWaitMs；到点还没稳定就先返回当前状态（面板继续轮询 /status）。 */
  const reloadCapped = async (): Promise<RuntimeStatus> => {
    let timer: NodeJS.Timeout | undefined;
    const capped = new Promise<RuntimeStatus>((resolve) => {
      timer = setTimeout(() => resolve(opts.runtime.status()), opts.reloadWaitMs ?? 25_000);
      timer.unref?.();
    });
    const done = opts.runtime.reload().catch((e: unknown) => {
      log.error(`重新加载失败：${redactError(e, opts.secrets?.() ?? [])}`);
      return opts.runtime.status();
    });
    const runtime = await Promise.race([done, capped]);
    clearTimeout(timer);
    return runtime;
  };

  // 手动改过 config.json 之后，让面板的“重新连接”按钮按磁盘上的文件重新加载，不用重启 ST。
  // 先校验：文件不存在、不是合法 JSON、校验失败都拒绝，不去拆掉正在运行的实例。
  router.post('/reload', async (req, res) => {
    if (denied(req, res)) return;
    let existing: { raw: Record<string, unknown>; exists: boolean };
    try {
      existing = readRawConfig(configPath);
    } catch (e) {
      fail(res, 409, (e as Error).message);
      return;
    }
    if (!existing.exists) {
      fail(res, 409, '还没有 config.json：先在上面填写 Bot Token 和允许的用户 ID 并保存。');
      return;
    }
    const v = validateConfig(existing.raw, 'config.json');
    if (!v.ok) {
      res.status(422).json({ ok: false, errors: v.errors });
      return;
    }
    log.info('收到面板的“重新连接”请求，按 config.json 重新加载');
    const runtime = await reloadCapped();
    res.json({ ok: true, reconnected: true, reloadedRuntime: true, changed: [], hot: [], reloaded: [], warnings: v.warnings, runtime, ...viewSettings(existing.raw, true) });
  });

  router.post('/config', async (req, res) => {
    if (denied(req, res)) return;
    let existing: { raw: Record<string, unknown>; exists: boolean };
    try {
      existing = readRawConfig(configPath);
    } catch (e) {
      fail(res, 409, (e as Error).message);
      return;
    }
    const body = req.body as { settings?: unknown } | undefined;
    const r = applySettings(existing.raw, body?.settings);
    if (!r.ok) {
      res.status(422).json({ ok: false, errors: r.errors });
      return;
    }
    try {
      writeRawConfig(configPath, r.raw);
    } catch (e) {
      log.error(`保存配置失败：${redactError(e, opts.secrets?.() ?? [])}`);
      fail(res, 500, '写入 config.json 失败，详情见 ST 日志。');
      return;
    }
    const live = opts.live();
    // 待命（没有配置或配置有误）时无论改了什么都重新加载；运行中只有连接类字段变化才重新加载
    const needReload = !live || r.reload.length > 0;
    const hot = live ? r.hot : [];
    const reloaded = needReload ? (live ? r.reload : r.changed) : [];
    if (live && hot.length > 0) opts.applyHot(r.config);
    log.info(
      `配置已通过面板保存：${r.changed.length ? r.changed.join('、') : '无变化'}${hot.length ? `（立即生效：${hot.join('、')}）` : ''}${needReload ? `（重新加载${reloaded.length ? `：${reloaded.join('、')}` : ''}）` : ''}`,
    );
    const runtime = needReload ? await reloadCapped() : opts.runtime.status();
    // reloadedRuntime：这次保存是否重新加载了运行时（待命时即使没有改动也会按现有文件重新启动一次）
    res.json({ ok: true, changed: r.changed, hot, reloaded, reloadedRuntime: needReload, lowMemoryNote: r.changed.includes('lowMemory'), warnings: r.warnings, runtime, ...viewSettings(r.raw, true) });
  });
}
