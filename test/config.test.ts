import { describe, expect, it } from 'vitest';
import { configSecrets, loadConfigFile, validateConfig } from '../src/server/config';
import { FAKE_TOKEN } from './helpers';

const base = { botToken: FAKE_TOKEN, allowedUserIds: [42] };

function errorsOf(raw: unknown): Record<string, string> {
  const r = validateConfig(raw);
  if (r.ok) return {};
  return Object.fromEntries(r.errors.map((e) => [e.field, e.message]));
}

describe('validateConfig', () => {
  it('最小配置通过并填入默认值', () => {
    const r = validateConfig(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).toMatchObject({
        stBaseUrl: 'http://127.0.0.1:8000',
        miniAppPort: 8788,
        idleShutdownMinutes: 0,
        lowMemory: true,
        dialogueStyle: 'bold',
        logLevel: 'info',
        draftIntervalSeconds: 1,
        draftMode: 'live',
        choiceLayout: 'numbers',
        allowedUserIds: [42],
      });
      expect(r.config.telegramProxy).toBeUndefined();
    }
  });
  it('config.example.json 的占位内容被拒绝，而不是被当成真 token', async () => {
    const ex = (await import('../config.example.json', { with: { type: 'json' } })).default;
    expect(errorsOf(ex)).toHaveProperty('botToken');
  });
  it('缺 token：提示去找 BotFather', () => {
    expect(errorsOf({ allowedUserIds: [1] }).botToken).toMatch(/BotFather/);
  });
  it('token 格式错误', () => {
    expect(errorsOf({ ...base, botToken: 'bot123:abc' }).botToken).toMatch(/格式/);
  });
  it('白名单为空：提示如何填，并说明不会启动', () => {
    const msg = errorsOf({ botToken: FAKE_TOKEN, allowedUserIds: [] }).allowedUserIds;
    expect(msg).toMatch(/为空/);
    expect(msg).toMatch(/userinfobot/);
  });
  it('白名单缺失与非整数', () => {
    expect(errorsOf({ botToken: FAKE_TOKEN })).toHaveProperty('allowedUserIds');
    expect(errorsOf({ ...base, allowedUserIds: ['42'] })).toHaveProperty('allowedUserIds');
    expect(errorsOf({ ...base, allowedUserIds: [-1] })).toHaveProperty('allowedUserIds');
  });
  it('白名单去重', () => {
    const r = validateConfig({ ...base, allowedUserIds: [1, 1, 2] });
    expect(r.ok && r.config.allowedUserIds).toEqual([1, 2]);
  });
  it('telegramApiBase（测试用）：合法时给出警告，非法时报错', () => {
    const r = validateConfig({ ...base, telegramApiBase: 'http://127.0.0.1:9999/' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.telegramApiBase).toBe('http://127.0.0.1:9999');
      expect(r.warnings.map((w) => w.field)).toContain('telegramApiBase');
    }
    expect(errorsOf({ ...base, telegramApiBase: 'ftp://x' }).telegramApiBase).toMatch(/只用于测试/);
  });

  it('stBaseUrl 规范化去掉结尾斜杠，非法值报错', () => {
    const r = validateConfig({ ...base, stBaseUrl: 'http://localhost:8001/' });
    expect(r.ok && r.config.stBaseUrl).toBe('http://localhost:8001');
    expect(errorsOf({ ...base, stBaseUrl: 'localhost:8000' })).toHaveProperty('stBaseUrl');
  });
  it('代理：支持 http(s)，拒绝 socks 并给出提示', () => {
    expect(validateConfig({ ...base, telegramProxy: 'http://127.0.0.1:7890' }).ok).toBe(true);
    expect(errorsOf({ ...base, telegramProxy: 'socks5://127.0.0.1:1080' }).telegramProxy).toMatch(/不支持 socks5/);
    expect(errorsOf({ ...base, telegramProxy: 'not a url' })).toHaveProperty('telegramProxy');
  });
  it('空字符串视为未填', () => {
    const r = validateConfig({ ...base, telegramProxy: '', chromiumPath: '', publicBaseUrl: '', basicAuth: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.chromiumPath).toBeUndefined();
  });
  it('publicBaseUrl 必须是 https', () => {
    expect(errorsOf({ ...base, publicBaseUrl: 'http://x.example' })).toHaveProperty('publicBaseUrl');
    const r = validateConfig({ ...base, publicBaseUrl: 'https://x.example/' });
    expect(r.ok && r.config.publicBaseUrl).toBe('https://x.example');
  });
  it('pageHeapLimitMB：缺省为 512，可配置', () => {
    const d = validateConfig(base);
    expect(d.ok && d.config.pageHeapLimitMB).toBe(512);
    const c = validateConfig({ ...base, pageHeapLimitMB: 768 });
    expect(c.ok && c.config.pageHeapLimitMB).toBe(768);
  });
  it('basicAuth 与数值项校验', () => {
    expect(errorsOf({ ...base, basicAuth: { username: 'a' } })).toHaveProperty('basicAuth');
    expect(errorsOf({ ...base, miniAppPort: 70000 })).toHaveProperty('miniAppPort');
    expect(errorsOf({ ...base, idleShutdownMinutes: -1 })).toHaveProperty('idleShutdownMinutes');
    expect(errorsOf({ ...base, lowMemory: 'yes' })).toHaveProperty('lowMemory');
    // pageHeapLimitMB：128–4096 的整数
    for (const bad of [64, 127, 4097, 300.5, '512', true]) expect(errorsOf({ ...base, pageHeapLimitMB: bad })).toHaveProperty('pageHeapLimitMB');
    expect(errorsOf({ ...base, pageHeapLimitMB: 64 }).pageHeapLimitMB).toMatch(/128–4096.*默认 512/);
    expect(errorsOf({ ...base, pageHeapLimitMB: 4096 })).not.toHaveProperty('pageHeapLimitMB');
    expect(errorsOf({ ...base, dialogueStyle: 'neon' })).toHaveProperty('dialogueStyle');
    expect(errorsOf({ ...base, dialogueStyle: 'italic' })).not.toHaveProperty('dialogueStyle');
    expect(errorsOf({ ...base, draftIntervalSeconds: 0.1 })).toHaveProperty('draftIntervalSeconds');
    expect(errorsOf({ ...base, draftIntervalSeconds: 31 })).toHaveProperty('draftIntervalSeconds');
    expect(errorsOf({ ...base, draftIntervalSeconds: 2.5 })).not.toHaveProperty('draftIntervalSeconds');
    expect(errorsOf({ ...base, draftMode: 'off' })).toHaveProperty('draftMode');
    expect(errorsOf({ ...base, choiceLayout: 'grid' })).toHaveProperty('choiceLayout');
    expect(errorsOf({ ...base, logLevel: 'loud' })).toHaveProperty('logLevel');
  });
  it('未知配置项只警告', () => {
    const r = validateConfig({ ...base, botTokn: 'x' });
    expect(r.ok).toBe(true);
    expect(r.warnings[0]?.field).toBe('botTokn');
  });
  it('根不是对象', () => {
    expect(validateConfig([]).ok).toBe(false);
  });
  it('一次报出全部错误', () => {
    expect(Object.keys(errorsOf({})).sort()).toEqual(['allowedUserIds', 'botToken']);
  });
});

describe('loadConfigFile', () => {
  it('文件不存在：提示复制 config.example.json', () => {
    const r = loadConfigFile('/nope/config.json', () => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' });
    });
    expect(!r.ok && r.errors[0]?.message).toMatch(/config\.example\.json/);
  });
  it('JSON 语法错误：不回显文件内容', () => {
    const r = loadConfigFile('/c.json', () => `{"botToken": "${FAKE_TOKEN}", oops}`);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
  });
  it('正常读取', () => {
    expect(loadConfigFile('/c.json', () => JSON.stringify(base)).ok).toBe(true);
  });
});

describe('configSecrets', () => {
  it('包含 token、basicAuth 密码、代理凭据', () => {
    const r = validateConfig({ ...base, basicAuth: { username: 'u', password: 'pw-1234' }, telegramProxy: 'http://pu:pp-9999@127.0.0.1:7890' });
    if (!r.ok) throw new Error('unexpected');
    expect(configSecrets(r.config)).toEqual(expect.arrayContaining([FAKE_TOKEN, 'pw-1234', 'pp-9999']));
  });
  it('传入 env 时包含环境变量代理里的账号密码；不传则不看环境变量', () => {
    const r = validateConfig(base);
    if (!r.ok) throw new Error('unexpected');
    const env = { HTTPS_PROXY: 'http://eu:ep%40ss@10.0.0.1:7890', all_proxy: 'socks5://su:sp-5555@10.0.0.1:1080' };
    expect(configSecrets(r.config, env)).toEqual(expect.arrayContaining(['eu', 'ep@ss', 'ep%40ss', 'su', 'sp-5555']));
    expect(configSecrets(r.config)).not.toContain('ep@ss');
  });
});
