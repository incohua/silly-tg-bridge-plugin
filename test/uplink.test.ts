import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/extension/adapter', () => ({ ctx: () => ({ getRequestHeaders: () => ({}) }) }));

import { Uplink, UPLINK_TIMEOUT_MS } from '../src/extension/uplink';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Uplink 超时', () => {
  it('一次上行请求挂住：超时后串行链不断，后续事件仍能发出', async () => {
    // AbortSignal.timeout 用的是原生定时器，假定时器管不到：换成可手动触发的 signal
    const timeoutCtrls: AbortController[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const c = new AbortController();
      timeoutCtrls.push(c);
      return c.signal;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: string[] = [];
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { event: { type: string } };
        if (first) {
          first = false;
          // 模拟卡住：只有 signal 触发才结束
          return new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
        }
        sent.push(body.event.type);
        return Promise.resolve(new Response('', { status: 200 }));
      }),
    );
    const up = new Uplink('n', () => {});
    const p1 = up.send({ type: 'heartbeat' });
    const p2 = up.send({ type: 'hostLog', level: 'info', message: 'x' } as never);
    await vi.waitFor(() => expect(timeoutCtrls).toHaveLength(1));
    expect(AbortSignal.timeout).toHaveBeenCalledWith(UPLINK_TIMEOUT_MS);
    timeoutCtrls[0]!.abort(new DOMException('timeout', 'TimeoutError'));
    await Promise.all([p1, p2]);
    expect(sent).toEqual(['hostLog']);
    expect(up.closed).toBe(false);
  });

  it('sendNow 带超时 signal', async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', f);
    await new Uplink('n', () => {}).sendNow({ type: 'heartbeat' });
    expect(f.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
});
