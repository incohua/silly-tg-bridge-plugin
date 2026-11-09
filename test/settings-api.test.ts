import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Router } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySettings, FIELD_EFFECTS, maskProxy, MASK, registerSettingsRoutes, saveSettingsPatch, viewSettings } from '../src/server/settings-api';
import { validateConfig, type Config } from '../src/server/config';
import type { RuntimeStatus } from '../src/shared/runtime-status';
import { FAKE_TOKEN, noopLogger } from './helpers';

const base = {
  botToken: FAKE_TOKEN,
  allowedUserIds: [111],
  stBaseUrl: 'http://127.0.0.1:8000',
  chromiumPath: '/usr/bin/chromium',
  telegramApiBase: '',
  basicAuth: { username: 'u', password: 'secret-pw' },
  telegramProxy: 'http://pu:proxy-pw@127.0.0.1:7890',
  dialogueStyle: 'bold',
  extraField: 'keep-me',
};

describe('viewSettings：掩码', () => {
  it('不含明文 token、密码和代理密码；不含 chromiumPath', () => {
    const json = JSON.stringify(viewSettings(base, true));
    expect(json).not.toContain(FAKE_TOKEN);
    expect(json).not.toContain('secret-pw');
    expect(json).not.toContain('proxy-pw');
    expect(json).not.toContain('chromium');
    const v = viewSettings(base, true).values;
    expect(v.botToken).toEqual({ set: true });
    expect(v.basicAuth).toEqual({ username: 'u', passwordSet: true });
    expect(v.telegramProxy).toBe(`http://pu:${MASK}@127.0.0.1:7890`);
  });
  it('没有配置文件：缺省值与 validateConfig 一致', () => {
    const v = viewSettings({}, false);
    expect(v.exists).toBe(false);
    expect(v.values).toMatchObject({ botToken: { set: false }, allowedUserIds: [], stBaseUrl: 'http://127.0.0.1:8000', lowMemory: true, dialogueStyle: 'bold', logLevel: 'info', idleShutdownMinutes: 0 });
  });
  it('maskProxy', () => {
    expect(maskProxy('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
    expect(maskProxy('http://a:b@h:1')).toBe(`http://a:${MASK}@h:1`);
    expect(maskProxy('乱写')).toBe('乱写');
  });
});

describe('applySettings', () => {
  it('掩码值/空值表示不修改：token、basicAuth 密码、代理密码保持原值', () => {
    const r = applySettings(base, {
      botToken: MASK,
      basicAuth: { username: 'u', password: '' },
      telegramProxy: `http://pu:${MASK}@127.0.0.1:7890`,
      dialogueStyle: 'italic',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.raw.botToken).toBe(FAKE_TOKEN);
    expect(r.raw.basicAuth).toEqual({ username: 'u', password: 'secret-pw' });
    expect(r.raw.telegramProxy).toBe('http://pu:proxy-pw@127.0.0.1:7890');
    expect(r.changed).toEqual(['dialogueStyle']);
    expect(r.hot).toEqual(['dialogueStyle']);
    expect(r.reload).toEqual([]);
    expect(JSON.stringify(r.raw)).not.toContain(MASK);
  });

  it('只改代理地址、保留掩码密码：密码换回原值', () => {
    const r = applySettings(base, { telegramProxy: `http://pu:${MASK}@127.0.0.1:9999` });
    expect(r.ok && r.raw.telegramProxy).toBe('http://pu:proxy-pw@127.0.0.1:9999');
  });

  it('不受管理的字段原样保留；patch 里的 chromiumPath 被忽略', () => {
    const r = applySettings(base, { chromiumPath: '/evil/bin', extraField: 'x', logLevel: 'debug' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.raw.chromiumPath).toBe('/usr/bin/chromium');
    expect(r.raw.extraField).toBe('keep-me');
    expect(r.raw.logLevel).toBe('debug');
  });

  it('分类：hot / reload；allowedUserIds 立即生效；不再有需要重启 ST 的字段', () => {
    const r = applySettings(base, { logLevel: 'warn', lowMemory: false, idleShutdownMinutes: 10, allowedUserIds: [111, 222], stBaseUrl: 'http://127.0.0.1:8001' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hot.sort()).toEqual(['allowedUserIds', 'idleShutdownMinutes', 'logLevel', 'lowMemory']);
    expect(r.reload.sort()).toEqual(['stBaseUrl']);
    expect(Object.values(FIELD_EFFECTS)).not.toContain('restart');
    expect(FIELD_EFFECTS).toMatchObject({ botToken: 'reload', telegramProxy: 'reload', basicAuth: 'reload', stBaseUrl: 'reload', allowedUserIds: 'hot' });
  });

  it('校验失败：返回逐字段错误，不产生结果', () => {
    const r = applySettings(base, { allowedUserIds: [], dialogueStyle: 'huge', botToken: 'bad' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field).sort()).toEqual(['allowedUserIds', 'botToken', 'dialogueStyle']);
  });

  it('从零创建：只填 token 和白名单就能得到合法配置', () => {
    const r = applySettings({}, { botToken: FAKE_TOKEN, allowedUserIds: [42] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validateConfig(r.raw).ok).toBe(true);
    expect(r.reload).toContain('botToken');
  });

  it('basicAuth 设为 null 即清除', () => {
    const r = applySettings(base, { basicAuth: null });
    expect(r.ok && r.raw.basicAuth).toBeNull();
  });
});

// 极简 router：记录 handler，直接调用
type Handler = (req: { body?: unknown; user?: { profile?: { admin?: boolean } } }, res: FakeRes) => void | Promise<void>;
class FakeRes {
  statusCode = 200;
  body: unknown;
  status(c: number) {
    this.statusCode = c;
    return this;
  }
  json(b: unknown) {
    this.body = b;
    return this;
  }
}

const standbyStatus: RuntimeStatus = { state: 'standby', standbyReason: 'invalid-config', errors: [{ field: 'botToken', message: '缺少' }], telegram: 'skipped', chromium: { found: true }, hostConnected: false };
const runningStatus: RuntimeStatus = { state: 'running', telegram: 'ok', botUsername: 'testbot', chromium: { found: true }, hostConnected: true };

describe('路由', () => {
  let dir: string;
  let file: string;
  const handlers: Record<string, Handler> = {};
  const router = { get: (p: string, h: Handler) => (handlers[`GET ${p}`] = h), post: (p: string, h: Handler) => (handlers[`POST ${p}`] = h) } as unknown as Router;
  let live: Config | null;
  let current: RuntimeStatus;
  let reloads: number;
  let reloadImpl: () => Promise<RuntimeStatus>;
  const hotCalls: Config[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'settings-'));
    file = join(dir, 'config.json');
    hotCalls.length = 0;
    live = null;
    current = standbyStatus;
    reloads = 0;
    reloadImpl = async () => (current = runningStatus);
    registerSettingsRoutes(router, {
      configPath: file,
      log: noopLogger,
      live: () => live,
      runtime: {
        status: () => current,
        reload: () => (reloads++, reloadImpl()),
      },
      applyHot: (c) => hotCalls.push(c),
      reloadWaitMs: 50,
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const call = async (key: string, body?: unknown) => {
    const res = new FakeRes();
    await handlers[key]({ body }, res);
    return res;
  };
  const runningConfig = (): Config => {
    const v = validateConfig(base);
    if (!v.ok) throw new Error('fixture');
    return v.config;
  };

  it('GET：没有文件时 exists:false，并带出待命原因和运行状态；响应无明文', async () => {
    const res = await call('GET /config');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, exists: false, running: false, startErrors: [{ field: 'botToken' }], runtime: { state: 'standby' }, effects: { botToken: 'reload', allowedUserIds: 'hot' } });
  });

  it('GET：运行中 running:true，startErrors 为空', async () => {
    current = runningStatus;
    const res = await call('GET /config');
    expect(res.body).toMatchObject({ ok: true, running: true, startErrors: [], runtime: { state: 'running', botUsername: 'testbot' } });
  });

  it('POST 从零创建（待命）：写出 600 权限的合法文件，触发一次重新加载，返回加载后的状态', async () => {
    const res = await call('POST /config', { settings: { botToken: FAKE_TOKEN, allowedUserIds: [7] } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, hot: [], reloaded: expect.arrayContaining(['botToken', 'allowedUserIds']), reloadedRuntime: true, runtime: { state: 'running' } });
    expect(res.body).not.toHaveProperty('restart');
    expect(reloads).toBe(1);
    expect(hotCalls).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ botToken: FAKE_TOKEN, allowedUserIds: [7] });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('POST 校验失败：422，文件不变，不重新加载', async () => {
    writeFileSync(file, JSON.stringify(base));
    const before = readFileSync(file, 'utf8');
    const res = await call('POST /config', { settings: { dialogueStyle: 'huge' } });
    expect(res.statusCode).toBe(422);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(reloads).toBe(0);
  });

  it('POST 运行中只改热字段（含 allowedUserIds）：立即应用，不重新加载', async () => {
    writeFileSync(file, JSON.stringify(base));
    live = runningConfig();
    current = runningStatus;
    const res = await call('POST /config', { settings: { logLevel: 'debug', allowedUserIds: [111, 222] } });
    expect(res.body).toMatchObject({ ok: true, hot: ['allowedUserIds', 'logLevel'], reloaded: [], reloadedRuntime: false, runtime: { state: 'running' } });
    expect(reloads).toBe(0);
    expect(hotCalls).toHaveLength(1);
    expect(hotCalls[0]).toMatchObject({ logLevel: 'debug', allowedUserIds: [111, 222] });
  });

  it('POST 运行中改了 stBaseUrl：热字段照常应用，并重新加载', async () => {
    writeFileSync(file, JSON.stringify(base));
    live = runningConfig();
    current = runningStatus;
    const res = await call('POST /config', { settings: { logLevel: 'debug', stBaseUrl: 'http://127.0.0.1:9000' } });
    expect(res.body).toMatchObject({ ok: true, hot: ['logLevel'], reloaded: ['stBaseUrl'] });
    expect(reloads).toBe(1);
    expect(hotCalls).toHaveLength(1);
  });

  it('POST 重新加载很久没完成：到上限先返回当前状态（starting），不挂起请求', async () => {
    writeFileSync(file, JSON.stringify(base));
    live = runningConfig();
    current = runningStatus;
    reloadImpl = () => {
      current = { ...runningStatus, state: 'starting', telegram: 'pending' };
      return new Promise(() => {});
    };
    const t = Date.now();
    const res = await call('POST /config', { settings: { botToken: '111111111:AAFakeTokenAnotherAnotherAnother_1' } });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(res.body).toMatchObject({ ok: true, reloaded: ['botToken'], runtime: { state: 'starting', telegram: 'pending' } });
  });

  it('POST 重新加载抛错：仍返回 200 和当前状态，错误进日志', async () => {
    writeFileSync(file, JSON.stringify(base));
    reloadImpl = () => Promise.reject(new Error(`炸了 ${FAKE_TOKEN}`));
    const res = await call('POST /config', { settings: { dialogueStyle: 'italic' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, runtime: { state: 'standby' } });
    expect(JSON.stringify(res.body)).not.toContain(FAKE_TOKEN);
  });

  it('GET /status：返回运行状态；非管理员 403', async () => {
    current = runningStatus;
    const res = await call('GET /status');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, runtime: runningStatus });
    const denied = new FakeRes();
    await handlers['GET /status']({ user: { profile: { admin: false } } }, denied);
    expect(denied.statusCode).toBe(403);
  });

  it('多用户 ST：非管理员 GET/POST 都是 403，且不写文件、不重新加载；管理员和单用户模式放行', async () => {
    const asUser = async (key: string, admin: boolean, body?: unknown) => {
      const res = new FakeRes();
      await handlers[key]({ body, user: { profile: { admin } } }, res);
      return res;
    };
    expect((await asUser('GET /config', false)).statusCode).toBe(403);
    const p = await asUser('POST /config', false, { settings: { botToken: FAKE_TOKEN, allowedUserIds: [1] } });
    expect(p.statusCode).toBe(403);
    expect(existsSync(file)).toBe(false);
    expect(reloads).toBe(0);
    expect((await asUser('GET /config', true)).statusCode).toBe(200);
  });

  it('config.json 损坏：GET/POST 都拒绝，不覆盖', async () => {
    writeFileSync(file, '{坏的 token=' + FAKE_TOKEN);
    const g = await call('GET /config');
    expect(g.statusCode).toBe(500);
    expect(JSON.stringify(g.body)).not.toContain(FAKE_TOKEN);
    const p = await call('POST /config', { settings: { botToken: FAKE_TOKEN, allowedUserIds: [1] } });
    expect(p.statusCode).toBe(409);
    expect(readFileSync(file, 'utf8')).toContain('坏的');
    expect(reloads).toBe(0);
  });
});

describe('saveSettingsPatch（bot 的 /settings 用）', () => {
  it('写入 config.json 并立即更新运行中的配置，其余字段保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-patch-'));
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ ...base, draftMode: 'live' }));
      const v = validateConfig(base);
      if (!v.ok) throw new Error('fixture');
      const live: Config = v.config;
      saveSettingsPatch(path, live, { draftMode: 'progress', draftIntervalSeconds: 3 });
      expect(live).toMatchObject({ draftMode: 'progress', draftIntervalSeconds: 3 });
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(saved).toMatchObject({ draftMode: 'progress', draftIntervalSeconds: 3, extraField: 'keep-me', chromiumPath: '/usr/bin/chromium' });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('不合法的值抛出可读原因，文件和运行中的配置都不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-patch-'));
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify(base));
      const before = readFileSync(path, 'utf8');
      const v = validateConfig(base);
      if (!v.ok) throw new Error('fixture');
      expect(() => saveSettingsPatch(path, v.config, { draftIntervalSeconds: 999 })).toThrow(/0\.5–30/);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(v.config.draftIntervalSeconds).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
