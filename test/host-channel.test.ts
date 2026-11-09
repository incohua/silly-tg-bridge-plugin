import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostChannel, HostChannelError } from '../src/server/host-channel';
import type { HostCommand, HostEvent } from '../src/shared/protocol';
import { noopLogger } from './helpers';

let server: Server;
let base: string;
let channel: HostChannel;
const aborts: AbortController[] = [];

beforeEach(async () => {
  // 默认 RPC 超时设得很长：只有专门测超时的用例才传短的超时，其余用例不能因为 CPU 繁忙而误超时
  channel = new HostChannel({ log: noopLogger, rpcTimeoutMs: 60_000, keepAliveMs: 50 });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  channel.register(router);
  app.use('/api/plugins/silly-tg', router);
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plugins/silly-tg`;
});

afterEach(async () => {
  aborts.splice(0).forEach((a) => a.abort());
  channel.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** 打开 SSE，返回一个按行读取命令的迭代器。 */
async function openSse(nonce = channel.nonce): Promise<{ status: number; next: () => Promise<HostCommand>; ac: AbortController }> {
  const ac = new AbortController();
  aborts.push(ac);
  const res = await fetch(`${base}/host/events?nonce=${nonce}`, { signal: ac.signal });
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return {
    status: res.status,
    ac,
    async next() {
      for (;;) {
        const i = buf.indexOf('\n\n');
        if (i >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6)) as HostCommand;
          continue;
        }
        const { value, done } = await reader!.read();
        if (done) throw new Error('SSE closed');
        buf += dec.decode(value);
      }
    },
  };
}

const post = (body: unknown): Promise<Response> =>
  fetch(`${base}/host/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('HostChannel', () => {
  it('SSE nonce 错误返回 403，缺失也是 403', async () => {
    expect((await openSse('wrong')).status).toBe(403);
    expect((await fetch(`${base}/host/events`)).status).toBe(403);
    expect(channel.connected).toBe(false);
  });

  it('没有连接时发命令立即失败', async () => {
    await expect(channel.request({ type: 'stop' })).rejects.toMatchObject({ code: 'not-connected' });
  });

  it('命令经 SSE 下发，rpcResult 回来后 resolve', async () => {
    const sse = await openSse();
    expect(sse.status).toBe(200);
    const p = channel.request<{ n: number }>({ type: 'send', text: 'hi', generationId: 'g1' });
    const cmd = await sse.next();
    expect(cmd).toMatchObject({ type: 'send', text: 'hi' });
    expect(typeof cmd.id).toBe('string');
    const r = await post({ nonce: channel.nonce, event: { type: 'rpcResult', id: cmd.id, ok: true, result: { n: 1 } } });
    expect(r.status).toBe(200);
    await expect(p).resolves.toEqual({ n: 1 });
  });

  it('rpcResult ok=false 转成 remote-error', async () => {
    const sse = await openSse();
    const p = channel.request({ type: 'stop' });
    const cmd = await sse.next();
    const rejected = expect(p).rejects.toMatchObject({ code: 'remote-error', message: 'nope' });
    await post({ nonce: channel.nonce, event: { type: 'rpcResult', id: cmd.id, ok: false, error: 'nope' } });
    await rejected;
  });

  it('RPC 超时', async () => {
    await openSse();
    await expect(channel.request({ type: 'stop' }, 50)).rejects.toBeInstanceOf(HostChannelError);
    await expect(channel.request({ type: 'stop' }, 50)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('SSE 断开时未完成的 RPC 立即失败', async () => {
    const sse = await openSse();
    const p = channel.request({ type: 'stop' }, 5000);
    await sse.next();
    sse.ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'disconnected' });
    await vi.waitFor(() => expect(channel.connected).toBe(false), { timeout: 4000, interval: 5 });
  });

  it('新连接替换旧连接', async () => {
    const a = await openSse();
    const p = channel.request({ type: 'stop' }, 5000);
    await a.next();
    const rejected = expect(p).rejects.toMatchObject({ code: 'disconnected' });
    const b = await openSse();
    await rejected;
    const p2 = channel.request({ type: 'newChat' });
    expect(await b.next()).toMatchObject({ type: 'newChat' });
    p2.catch(() => {});
  });

  it('上行：nonce 错误 403、结构错误 400，hello 里的 nonce 也要匹配', async () => {
    expect((await post({ nonce: 'bad', event: { type: 'heartbeat' } })).status).toBe(403);
    expect((await post({ nonce: channel.nonce, event: { type: 'zzz' } })).status).toBe(400);
    expect((await post('garbage')).status).toBe(400);
    const hello = (n: string): HostEvent => ({ type: 'hello', nonce: n, stVersion: '1', hasTavernHelper: true });
    expect((await post({ nonce: channel.nonce, event: hello('other') })).status).toBe(403);
    expect((await post({ nonce: channel.nonce, event: hello(channel.nonce) })).status).toBe(200);
    expect(channel.hello?.stVersion).toBe('1');
  });

  it('事件分发给处理器并更新 lastSeenAt，处理器抛错不影响响应', async () => {
    const seen: HostEvent[] = [];
    channel.onEvent((e) => {
      seen.push(e);
      throw new Error('handler bug');
    });
    expect(channel.lastSeenAt).toBe(0);
    const r = await post({ nonce: channel.nonce, event: { type: 'streamText', generationId: 'g', text: 'abc' } });
    expect(r.status).toBe(200);
    expect(seen).toEqual([{ type: 'streamText', generationId: 'g', text: 'abc' }]);
    expect(channel.lastSeenAt).toBeGreaterThan(0);
  });

  it('rotateNonce 使旧 nonce 失效并断开连接', async () => {
    const old = channel.nonce;
    const sse = await openSse();
    const p = channel.request({ type: 'stop' }, 5000);
    await sse.next();
    const fresh = channel.rotateNonce();
    expect(fresh).not.toBe(old);
    await expect(p).rejects.toMatchObject({ code: 'disconnected' });
    expect((await post({ nonce: old, event: { type: 'heartbeat' } })).status).toBe(403);
    expect((await post({ nonce: fresh, event: { type: 'heartbeat' } })).status).toBe(200);
  });

  it('SSE 周期性发送注释心跳', async () => {
    const ac = new AbortController();
    aborts.push(ac);
    const res = await fetch(`${base}/host/events?nonce=${channel.nonce}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    let text = '';
    const dec = new TextDecoder();
    while (!text.includes(': ping')) text += dec.decode((await reader.read()).value);
    expect(text).toContain(': connected');
  });
});
