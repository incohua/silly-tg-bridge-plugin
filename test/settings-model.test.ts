import { describe, expect, it } from 'vitest';
import { buildPatch, parseUserIds, saveSummary, type FormValues, type SettingsValues } from '../src/extension/settings-model';

const form = (over: Partial<FormValues> = {}): FormValues => ({
  botToken: '',
  allowedUserIds: '123, 456',
  telegramProxy: '',
  stBaseUrl: 'http://127.0.0.1:8000',
  basicAuthUser: '',
  basicAuthPassword: '',
  idleShutdownMinutes: '0',
  lowMemory: true,
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

describe('saveSummary', () => {
  it('区分立即生效和需要重启', () => {
    expect(saveSummary({ ok: true, changed: [] })).toBe('没有改动。');
    expect(saveSummary({ ok: true, changed: ['logLevel', 'botToken'], hot: ['logLevel'], restart: ['botToken'] })).toBe('已保存。已立即生效：日志级别。需要重启 ST 才生效：Bot Token。');
  });
});
