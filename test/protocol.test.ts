import { describe, expect, it } from 'vitest';
import { decodeHostCommand, decodeHostEvent, decodeHostUpload } from '../src/shared/protocol';

describe('decodeHostEvent', () => {
  it('hello 的 extVersion 可选：带了就解出来，缺省或类型不对时为 undefined（旧版扩展照常连接）', () => {
    const base = { type: 'hello', nonce: 'n', stVersion: '1.19.0', hasTavernHelper: false };
    expect(decodeHostEvent({ ...base, extVersion: '0.3.0' })).toMatchObject({ type: 'hello', extVersion: '0.3.0' });
    expect(decodeHostEvent(base)).toMatchObject({ type: 'hello' });
    expect((decodeHostEvent(base) as { extVersion?: string }).extVersion).toBeUndefined();
    expect((decodeHostEvent({ ...base, extVersion: 3 }) as { extVersion?: string }).extVersion).toBeUndefined();
  });
  it('解码各类事件', () => {
    expect(decodeHostEvent({ type: 'hello', nonce: 'n', stVersion: '1.19.0', hasTavernHelper: true })).toEqual({
      type: 'hello',
      nonce: 'n',
      stVersion: '1.19.0',
      hasTavernHelper: true,
    });
    expect(decodeHostEvent({ type: 'heartbeat' })).toEqual({ type: 'heartbeat' });
    expect(decodeHostEvent({ type: 'streamText', generationId: 'g', text: 't' })).toBeTruthy();
    expect(decodeHostEvent({ type: 'selfCheck', items: [{ name: 'csrf', ok: false, detail: '403' }] })).toBeTruthy();
    expect(decodeHostEvent({ type: 'rpcResult', id: 'x', ok: true, result: { a: 1 } })).toMatchObject({ result: { a: 1 } });
    expect(decodeHostEvent({ type: 'generationStopped', generationId: 'g' })).toBeTruthy();
    expect(
      decodeHostEvent({ type: 'messageFinal', generationId: 'g', chatId: 'c', messageId: 3, html: '<p/>', text: '', stopped: false, cards: [{ source: 's' }] }),
    ).toBeTruthy();
    expect(decodeHostEvent({ type: 'hostLog', level: 'info', message: 'm' })).toEqual({ type: 'hostLog', level: 'info', message: 'm' });
  });
  it('拒绝结构不对或未知类型', () => {
    expect(decodeHostEvent(null)).toBeNull();
    expect(decodeHostEvent({ type: 'nope' })).toBeNull();
    expect(decodeHostEvent({ type: 'streamText', generationId: 1, text: 't' })).toBeNull();
    expect(decodeHostEvent({ type: 'selfCheck', items: [{ name: 1 }] })).toBeNull();
    expect(decodeHostEvent({ type: 'messageFinal', generationId: 'g', chatId: 'c', messageId: '3', html: '', cards: [] })).toBeNull();
    expect(decodeHostEvent({ type: 'rpcResult', id: 'x' })).toBeNull();
    expect(decodeHostEvent({ type: 'messageFinal', generationId: 'g', chatId: 'c', messageId: 3, html: '', cards: [] })).toBeNull();
    expect(decodeHostEvent({ type: 'hostLog', level: 'debug', message: 'm' })).toBeNull();
  });
});

describe('新增字段与命令', () => {
  const base = { type: 'messageFinal', generationId: 'g', chatId: 'c', messageId: 3, html: '', text: '', stopped: false, cards: [] };
  it('messageFinal.raw 可选：有则带上，旧页面缺省', () => {
    expect(decodeHostEvent({ ...base, raw: '<SUOT>1. a</SUOT>' })).toMatchObject({ raw: '<SUOT>1. a</SUOT>' });
    expect(decodeHostEvent(base)).toMatchObject({ raw: undefined });
    expect(decodeHostEvent({ ...base, raw: 1 })).toBeNull();
  });
  it('listPresets / selectPreset 命令', () => {
    expect(decodeHostCommand({ id: '1', type: 'listPresets' })).toEqual({ id: '1', type: 'listPresets' });
    expect(decodeHostCommand({ id: '1', type: 'refreshPage' })).toEqual({ id: '1', type: 'refreshPage' });
    expect(decodeHostCommand({ id: '1', type: 'selectPreset', name: '破限 A' })).toEqual({ id: '1', type: 'selectPreset', name: '破限 A' });
    expect(decodeHostCommand({ id: '1', type: 'selectPreset' })).toBeNull();
  });
});

describe('decodeHostUpload', () => {
  it('需要 nonce 与合法事件', () => {
    expect(decodeHostUpload({ nonce: 'n', event: { type: 'heartbeat' } })).toEqual({ nonce: 'n', event: { type: 'heartbeat' } });
    expect(decodeHostUpload({ event: { type: 'heartbeat' } })).toBeNull();
    expect(decodeHostUpload({ nonce: 'n', event: { type: 'x' } })).toBeNull();
  });
});

describe('decodeHostCommand', () => {
  it('解码合法命令', () => {
    expect(decodeHostCommand({ id: '1', type: 'send', text: 'hi', generationId: 'g' })).toEqual({ id: '1', type: 'send', text: 'hi', generationId: 'g' });
    expect(decodeHostCommand({ id: '1', type: 'getStatus' })).toEqual({ id: '1', type: 'getStatus' });
    expect(decodeHostCommand({ id: '1', type: 'openChat', fileName: 'a' })).toEqual({ id: '1', type: 'openChat', fileName: 'a' });
  });
  it('拒绝缺字段、缺 id 或未知类型', () => {
    expect(decodeHostCommand({ id: '1', type: 'send', text: 'hi' })).toBeNull();
    expect(decodeHostCommand({ type: 'stop' })).toBeNull();
    expect(decodeHostCommand({ id: '1', type: 'eval' })).toBeNull();
    expect(decodeHostCommand('x')).toBeNull();
  });
});
