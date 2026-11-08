import { describe, expect, it } from 'vitest';
import { decodeHostCommand, decodeHostEvent, decodeHostUpload } from '../src/shared/protocol';

describe('decodeHostEvent', () => {
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
