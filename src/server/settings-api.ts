// 酒馆扩展栏里的配置面板对应的服务端接口：GET/POST /api/plugins/silly-tg/config。
// 路由继承 ST 的会话、CSRF 和 basic auth 鉴权。
// 安全约定：
//   - 读取时密码类字段（botToken、basicAuth.password、代理里的密码）一律掩码，响应里没有明文。
//   - 保存时掩码值或空值表示“不修改”，不会把掩码写进文件。
//   - chromiumPath（会被当作可执行文件启动）、telegramApiBase 等不受管理的字段不返回、不接受修改，原样保留。
//   - 先用 validateConfig 校验，通过才写入；写入用临时文件加 rename，保留文件里面板不管理的字段。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Router } from 'express';
import { validateConfig, type Config, type ConfigIssue } from './config';
import type { Logger } from './logger';
import { redactError } from './redact';

export const MASK = '********';

/** 保存后立即生效的字段。 */
export const HOT_FIELDS = ['dialogueStyle', 'logLevel', 'idleShutdownMinutes', 'lowMemory'] as const;
/** 保存后要重启 ST 才生效的字段。 */
export const RESTART_FIELDS = ['botToken', 'allowedUserIds', 'telegramProxy', 'basicAuth', 'stBaseUrl'] as const;
export const MANAGED_FIELDS: readonly string[] = [...RESTART_FIELDS, ...HOT_FIELDS];

export type Effect = 'hot' | 'restart';
export const FIELD_EFFECTS: Record<string, Effect> = {
  ...Object.fromEntries(HOT_FIELDS.map((f) => [f, 'hot' as const])),
  ...Object.fromEntries(RESTART_FIELDS.map((f) => [f, 'restart' as const])),
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
    },
  };
}

export type ApplyResult =
  | { ok: true; raw: Record<string, unknown>; config: Config; changed: string[]; hot: string[]; restart: string[]; warnings: ConfigIssue[] }
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
    restart: changed.filter((k) => FIELD_EFFECTS[k] === 'restart'),
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
  /** 当前运行中的配置；插件因配置错误没启动时为 null。 */
  live: () => Config | null;
  /** 插件没启动时的原因，界面上展示。 */
  startErrors: () => ConfigIssue[];
  /** 保存成功后让热生效字段立即生效。 */
  applyHot: (config: Config) => void;
  secrets?: () => string[];
}

/**
 * ST 开启多用户账号时，插件路由对所有已登录用户开放；配置里有 bot token 和白名单，只允许管理员访问。
 * 单用户模式下 req.user 的 profile.admin 为 true；拿不到 req.user（没有账号体系的旧版本）时放行。
 */
function isAdmin(req: import('express').Request): boolean {
  const user = (req as unknown as { user?: { profile?: { admin?: boolean } } }).user;
  return !user || user.profile?.admin === true;
}

/** 注册 GET/POST /config。 */
export function registerSettingsRoutes(router: Router, opts: SettingsRouteOptions): void {
  const { configPath, log } = opts;
  const fail = (res: import('express').Response, status: number, error: string): void => void res.status(status).json({ ok: false, error });

  router.get('/config', (req, res) => {
    if (!isAdmin(req)) {
      fail(res, 403, '只有 ST 管理员可以查看或修改 Silly TG 配置。');
      return;
    }
    try {
      const { raw, exists } = readRawConfig(configPath);
      res.json({
        ok: true,
        running: opts.live() !== null,
        startErrors: opts.live() ? [] : opts.startErrors(),
        effects: FIELD_EFFECTS,
        ...viewSettings(raw, exists),
      });
    } catch (e) {
      fail(res, 500, (e as Error).message);
    }
  });

  router.post('/config', (req, res) => {
    if (!isAdmin(req)) {
      fail(res, 403, '只有 ST 管理员可以查看或修改 Silly TG 配置。');
      return;
    }
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
    // 没启动（之前配置有误）时所有字段都要重启后才生效
    const hot = live ? r.hot : [];
    const restart = live ? r.restart : r.changed;
    if (live && hot.length > 0) opts.applyHot(r.config);
    log.info(`配置已通过面板保存：${r.changed.length ? r.changed.join('、') : '无变化'}${hot.length ? `（立即生效：${hot.join('、')}）` : ''}${restart.length ? `（需重启 ST：${restart.join('、')}）` : ''}`);
    res.json({ ok: true, changed: r.changed, hot, restart, lowMemoryNote: r.changed.includes('lowMemory'), warnings: r.warnings, ...viewSettings(r.raw, true) });
  });
}
