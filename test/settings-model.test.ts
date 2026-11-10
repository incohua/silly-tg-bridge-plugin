import { describe, expect, it } from 'vitest';
import { buildPatch, classifyConfigFailure, describeRuntime, INSTALL_GUIDE, parseUserIds, runtimeInProgress, runtimeSettling, saveResultMessage, type FormValues, type SettingsValues } from '../src/extension/settings-model';
import type { RuntimeStatus } from '../src/shared/runtime-status';

const form = (over: Partial<FormValues> = {}): FormValues => ({
  botToken: '',
  allowedUserIds: '123, 456',
  telegramProxy: '',
  stBaseUrl: 'http://127.0.0.1:8000',
  basicAuthUser: '',
  basicAuthPassword: '',
  idleShutdownMinutes: '0',
  lowMemory: true,
  pageHeapLimitMB: '256',
  dialogueStyle: 'bold',
  logLevel: 'info',
  draftIntervalSeconds: '1',
  draftMode: 'live',
  choiceLayout: 'numbers',
  ...over,
});

const original: SettingsValues = {
  botToken: { set: true },
  allowedUserIds: [123],
  telegramProxy: '',
  stBaseUrl: 'http://127.0.0.1:8000',
  basicAuth: { username: 'u', passwordSet: true },
  idleShutdownMinutes: 0,
  lowMemory: true,
  pageHeapLimitMB: 256,
  dialogueStyle: 'bold',
  logLevel: 'info',
  draftIntervalSeconds: 1,
  draftMode: 'live',
  choiceLayout: 'numbers',
};

describe('parseUserIds', () => {
  it('逗号、空格、换行、中文逗号分隔；去重', () => {
    expect(parseUserIds('1, 2\n3，4 、 2')).toEqual({ ok: true, ids: [1, 2, 3, 4] });
    expect(parseUserIds('')).toEqual({ ok: true, ids: [] });
  });
  it('用户名、负数、小数、过大的数都拒绝', () => {
    for (const bad of ['@bob', '-5', '1.5', '0', '99999999999999999999']) expect(parseUserIds(bad).ok).toBe(false);
  });
});

describe('buildPatch', () => {
  it('页面内存上限：128–4096 的整数；留空取默认 256；非法值报错', () => {
    const ok = buildPatch(form({ pageHeapLimitMB: '512' }), original);
    expect(ok.ok && ok.patch.pageHeapLimitMB).toBe(512);
    const blank = buildPatch(form({ pageHeapLimitMB: '' }), original);
    expect(blank.ok && blank.patch.pageHeapLimitMB).toBe(256);
    for (const bad of ['64', '5000', '300.5', 'abc', '-1']) {
      const r = buildPatch(form({ pageHeapLimitMB: bad }), original);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0].field).toBe('pageHeapLimitMB');
    }
  });
  it('草稿与选项排版字段', () => {
    const r = buildPatch(form({ draftIntervalSeconds: '2.5', draftMode: 'progress', choiceLayout: 'rows' }), original);
    expect(r.ok && r.patch).toMatchObject({ draftIntervalSeconds: 2.5, draftMode: 'progress', choiceLayout: 'rows' });
    expect(buildPatch(form({ draftIntervalSeconds: 'abc' }), original).ok).toBe(false);
    const blank = buildPatch(form({ draftIntervalSeconds: '' }), original);
    expect(blank.ok && blank.patch.draftIntervalSeconds).toBe(1);
  });
  it('token 留空不提交；其余字段都带上', () => {
    const r = buildPatch(form(), original);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch).not.toHaveProperty('botToken');
    expect(r.patch).toMatchObject({ allowedUserIds: [123, 456], lowMemory: true, idleShutdownMinutes: 0, dialogueStyle: 'bold' });
  });
  it('填了 token 就提交（去空白）', () => {
    const r = buildPatch(form({ botToken: '  1:abc  ' }), original);
    expect(r.ok && r.patch.botToken).toBe('1:abc');
  });
  it('账号留空：原来有账号则清除，原来没有则不提交；密码留空保留（由服务端处理）', () => {
    const cleared = buildPatch(form(), original);
    expect(cleared.ok && cleared.patch.basicAuth).toBeNull();
    const none = buildPatch(form(), { ...original, basicAuth: null });
    expect(none.ok && 'basicAuth' in none.patch).toBe(false);
    const keep = buildPatch(form({ basicAuthUser: 'u' }), original);
    expect(keep.ok && keep.patch.basicAuth).toEqual({ username: 'u', password: '' });
  });
  it('非法输入给出逐字段错误', () => {
    const r = buildPatch(form({ allowedUserIds: '@bob', idleShutdownMinutes: 'abc' }), original);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field)).toEqual(['allowedUserIds', 'idleShutdownMinutes']);
  });
});

const running: RuntimeStatus = { state: 'running', telegram: 'ok', botUsername: 'mybot', chromium: { found: true }, hostConnected: true, hostPage: { stVersion: '1.13.0' } };

describe('saveResultMessage：下次启动才生效的字段', () => {
  it('lowMemory / pageHeapLimitMB 不说“已立即生效”，而是“下次启动无头浏览器时生效”', () => {
    const m = saveResultMessage({ ok: true, changed: ['pageHeapLimitMB', 'logLevel'], hot: ['pageHeapLimitMB', 'logLevel'], reloaded: [], reloadedRuntime: false });
    expect(m).toMatch(/已立即生效：日志级别/);
    expect(m).toMatch(/下次启动无头浏览器时生效：页面内存上限/);
    expect(m).not.toMatch(/已立即生效：[^。]*页面内存上限/);
  });
});

describe('saveResultMessage：重新连接', () => {
  const running = { state: 'running', telegram: 'ok', botUsername: 'testbot', chromium: { found: true }, hostConnected: true } as const;
  it('点“重新连接”：说明是按 config.json 重新连接，并带上 bot 用户名', () => {
    const m = saveResultMessage({ ok: true, reconnected: true, reloadedRuntime: true, changed: [], hot: [], reloaded: [], runtime: running });
    expect(m).toContain('已按 config.json 重新连接');
    expect(m).toContain('@testbot');
    expect(m).not.toContain('重启');
  });
  it('重新连接失败时给出原因', () => {
    const m = saveResultMessage({ ok: true, reconnected: true, reloadedRuntime: true, changed: [], hot: [], reloaded: [], runtime: { ...running, telegram: 'error', telegramError: '401 Unauthorized' } });
    expect(m).toContain('已按 config.json 重新连接');
    expect(m).toContain('401 Unauthorized');
  });
});

describe('saveResultMessage', () => {
  it('没有改动', () => {
    expect(saveResultMessage({ ok: true, changed: [], hot: [], reloaded: [], runtime: running })).toBe('没有改动。');
  });
  it('只改热字段：立即生效，不提重启', () => {
    const m = saveResultMessage({ ok: true, changed: ['logLevel', 'allowedUserIds'], hot: ['logLevel', 'allowedUserIds'], reloaded: [], runtime: running });
    expect(m).toBe('已保存。已立即生效：日志级别、允许的用户 ID。');
  });
  it('连接类字段：重新连接成功 / 连接中 / 失败；任何情况都不再提示重启 ST', () => {
    const ok = saveResultMessage({ ok: true, changed: ['botToken'], hot: [], reloaded: ['botToken'], runtime: running });
    expect(ok).toBe('已保存。已重新连接，bot：@mybot。');
    const pending = saveResultMessage({ ok: true, changed: ['botToken'], hot: [], reloaded: ['botToken'], runtime: { ...running, state: 'starting', telegram: 'pending' } });
    expect(pending).toBe('已保存。正在重新连接…');
    const failed = saveResultMessage({ ok: true, changed: ['botToken'], hot: [], reloaded: ['botToken'], runtime: { ...running, telegram: 'error', telegramError: '401 Unauthorized。是 botToken 被拒绝' } });
    expect(failed).toBe('已保存，但连接 Telegram 失败：401 Unauthorized。是 botToken 被拒绝');
    const standby = saveResultMessage({ ok: true, changed: ['botToken'], hot: [], reloaded: ['botToken'], runtime: { ...running, state: 'standby', standbyReason: 'start-failed', errors: [{ field: '(runtime)', message: '炸了' }] } });
    expect(standby).toBe('已保存，但插件没有启动：炸了');
    for (const m of [ok, pending, failed, standby]) expect(m).not.toContain('重启');
  });
  it('待命时没有改动也点了保存：说明已按现有 config.json 重新启动（不是“没有改动”就完事）', () => {
    const ok = saveResultMessage({ ok: true, changed: [], hot: [], reloaded: [], reloadedRuntime: true, runtime: running });
    expect(ok).toBe('没有改动，已按现有 config.json 重新启动。已重新连接，bot：@mybot。');
    const bad = saveResultMessage({ ok: true, changed: [], hot: [], reloaded: [], reloadedRuntime: true, runtime: { ...running, state: 'standby', standbyReason: 'invalid-config', errors: [{ field: 'botToken', message: '缺少' }] } });
    expect(bad).toBe('没有改动，已按现有 config.json 重新启动，但插件没有启动：缺少');
    // 运行中没有改动：不重新加载
    expect(saveResultMessage({ ok: true, changed: [], hot: [], reloaded: [], reloadedRuntime: false, runtime: running })).toBe('没有改动。');
  });
});

describe('runtimeSettling（轮询到时是否提示“还没完成”）', () => {
  it('只有启动 / 重新加载 / 连接中算；页面没连上（可能是空闲关闭）不算', () => {
    expect(runtimeSettling({ ...running, state: 'starting' })).toBe(true);
    expect(runtimeSettling({ ...running, state: 'stopping' })).toBe(true);
    expect(runtimeSettling({ ...running, telegram: 'pending' })).toBe(true);
    expect(runtimeSettling({ ...running, hostConnected: false })).toBe(false);
    expect(runtimeSettling(running)).toBe(false);
  });
});

describe('describeRuntime', () => {
  const texts = (rt: RuntimeStatus) => describeRuntime(rt).map((l) => `${l.level} ${l.text}`);
  it('运行中：Telegram、Chromium、无头页面三行都正常', () => {
    expect(texts(running)).toEqual(['ok 运行中', 'ok Telegram：已连接 @mybot', 'ok Chromium：已找到', 'ok 无头页面：已连接（ST 1.13.0）']);
  });
  it('待命（没有配置）：说明下一步', () => {
    const t = texts({ state: 'standby', standbyReason: 'no-config', telegram: 'skipped', chromium: { found: true }, hostConnected: false });
    expect(t[0]).toMatch(/^idle 待命.*Bot Token.*允许的用户 ID/);
    expect(t).toContain('idle Telegram：未连接');
    expect(t).toContain('idle 无头页面：未启动');
  });
  it('待命（配置有误）：逐条列出原因', () => {
    const t = texts({ state: 'standby', standbyReason: 'invalid-config', errors: [{ field: 'botToken', message: '格式不对' }], telegram: 'skipped', chromium: { found: false, hint: '安装 chromium' }, hostConnected: false });
    expect(t[0]).toMatch(/^error 待命：配置有误/);
    expect(t).toContain('error · botToken：格式不对');
    expect(t).toContain('error Chromium：未找到。安装 chromium');
  });
  it('启动中 / 连接失败 / 页面未连接', () => {
    expect(texts({ ...running, state: 'starting', telegram: 'pending', hostConnected: false, hostPage: undefined }).slice(0, 2)).toEqual(['pending 正在启动…', 'pending Telegram：连接中…']);
    expect(texts({ ...running, telegram: 'error', telegramError: '网络错误' })[1]).toBe('error Telegram：连接失败。网络错误');
    expect(texts({ ...running, hostConnected: false, hostPage: undefined })[3]).toMatch(/^pending 无头页面：未连接/);
  });
});

describe('runtimeInProgress（面板是否继续轮询）', () => {
  it('启动中、重新加载中、Telegram 连接中、页面还没连上时继续；稳定后停止', () => {
    expect(runtimeInProgress({ ...running, state: 'starting' })).toBe(true);
    expect(runtimeInProgress({ ...running, state: 'stopping' })).toBe(true);
    expect(runtimeInProgress({ ...running, hostConnected: false })).toBe(true);
    expect(runtimeInProgress(running)).toBe(false);
    expect(runtimeInProgress({ ...running, telegram: 'error' })).toBe(false);
    expect(runtimeInProgress({ ...running, chromium: { found: false }, hostConnected: false })).toBe(false);
    expect(runtimeInProgress({ state: 'standby', telegram: 'skipped', chromium: { found: true }, hostConnected: false })).toBe(false);
  });
});

describe('classifyConfigFailure（服务端插件是否没装）', () => {
  it('只认 HTTP 404', () => {
    expect(classifyConfigFailure(404)).toBe('server-missing');
  });
  it('401、403、5xx、200 等都不是“没装”，仍走原来的错误提示', () => {
    for (const status of [200, 400, 401, 403, 500, 502, 503, 0]) expect(classifyConfigFailure(status)).toBe('other');
  });
});

describe('INSTALL_GUIDE（引导文案）', () => {
  it('克隆命令带显式目标目录 plugins/silly-tg-bridge-plugin，且不含凭据', () => {
    expect(INSTALL_GUIDE.command).toBe('git clone https://github.com/incohua/silly-tg-bridge-plugin plugins/silly-tg-bridge-plugin');
    expect(INSTALL_GUIDE.command).not.toMatch(/@|token/i);
  });
  it('步骤里说明了 enableServerPlugins、plugins 目录和只需重启一次；保存后无需再重启', () => {
    const text = [INSTALL_GUIDE.intro, ...INSTALL_GUIDE.steps].join('\n');
    expect(text).toContain('enableServerPlugins');
    expect(text).toContain('plugins');
    expect(text).toContain('重启 ST 一次');
    expect(text).toMatch(/无需再重启|不用再重启/);
  });
});
