import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/server/http';
import { pollUpdates, TelegramApiError, TelegramClient, TelegramNetworkError, type TelegramUpdate } from '../src/server/telegram';
import { captureLogger, FAKE_TOKEN, noopLogger } from './helpers';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const ok = (result: unknown): Response => json({ ok: true, result });
const instantSleep = async (): Promise<void> => {};

function client(fetchImpl: FetchLike, extra: { sleep?: (ms: number) => Promise<void>; log?: ReturnType<typeof captureLogger> } = {}): TelegramClient {
  return new TelegramClient({ token: FAKE_TOKEN, fetch: fetchImpl, log: extra.log ?? noopLogger, sleep: extra.sleep ?? instantSleep });
}

describe('TelegramClient', () => {
  it('把 token 放进 URL，参数作为 JSON 发送', async () => {
    const f = vi.fn<FetchLike>(async (_u, _i) => ok({ id: 1, username: 'b' }));
    const me = await client(f).getMe();
    expect(me.username).toBe('b');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/getMe`);
    expect(init?.method).toBe('POST');
  });

  it('getUpdates 带 offset、timeout，并返回结果', async () => {
    const f = vi.fn<FetchLike>(async (_u, _i) => ok([{ update_id: 5 }]));
    const r = await client(f).getUpdates({ offset: 5, timeout: 30 });
    expect(r).toEqual([{ update_id: 5 }]);
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ offset: 5, timeout: 30 });
  });

  it('API 错误映射为 TelegramApiError，带错误码', async () => {
    const f: FetchLike = async () => json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400);
    const e = (await client(f)
      .sendMessage({ chat_id: 1, text: 'x' })
      .catch((x: unknown) => x as TelegramApiError)) as TelegramApiError;
    expect(e).toBeInstanceOf(TelegramApiError);
    expect(e.errorCode).toBe(400);
    expect(e.message).toContain('chat not found');
  });

  it('429 按 retry_after 等待并重试，成功后返回', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let n = 0;
    const f: FetchLike = async () => (n++ < 2 ? json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }, 429) : ok(true));
    await expect(client(f, { sleep }).deleteMessage(1, 2)).resolves.toBe(true);
    expect(n).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(3000);
  });

  it('retry:false 时 429 直接抛出（草稿可丢弃）', async () => {
    let n = 0;
    const f: FetchLike = async () => (n++, json({ ok: false, error_code: 429, description: 'x', parameters: { retry_after: 1 } }, 429));
    const e = (await client(f).call('sendRichMessageDraft', {}, { retry: false }).catch((x: unknown) => x)) as TelegramApiError;
    expect(e).toBeInstanceOf(TelegramApiError);
    expect(e.retryAfter).toBe(1);
    expect(n).toBe(1);
  });

  it('429 持续出现时有重试上限', async () => {
    let n = 0;
    const f: FetchLike = async () => (n++, json({ ok: false, error_code: 429, description: 'x', parameters: { retry_after: 1 } }, 429));
    await expect(client(f).call('m')).rejects.toBeInstanceOf(TelegramApiError);
    expect(n).toBe(6);
  });

  it('网络错误：消息里的 token 被脱敏，且不带 cause', async () => {
    const f: FetchLike = async (url) => {
      throw new TypeError(`fetch failed for ${url}`, { cause: new Error(`ECONNRESET ${url}`) });
    };
    const e = await client(f).getMe().catch((x) => x);
    expect(e).toBeInstanceOf(TelegramNetworkError);
    expect(e.message).not.toContain(FAKE_TOKEN);
    expect(e.message).toContain('bot***');
    expect(e.cause).toBeUndefined();
    expect(String(e.stack)).not.toContain(FAKE_TOKEN);
  });

  it('响应不是 JSON 时给出网络错误', async () => {
    const f: FetchLike = async () => new Response('<html>502</html>', { status: 502 });
    await expect(client(f).getMe()).rejects.toThrow(/不是 JSON.*502/);
  });

  it('API 错误描述里若带 token 也会脱敏', async () => {
    const f: FetchLike = async () => json({ ok: false, error_code: 401, description: `Unauthorized ${FAKE_TOKEN}` }, 401);
    const e = await client(f).getMe().catch((x) => x);
    expect(e.message).not.toContain(FAKE_TOKEN);
  });

  it('调用方取消时报告取消', async () => {
    const ac = new AbortController();
    const f: FetchLike = (_u, init) =>
      new Promise((_r, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const p = client(f).call('getUpdates', {}, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/取消/);
  });

  it('请求超时', async () => {
    const f: FetchLike = (_u, init) =>
      new Promise((_r, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('t', 'TimeoutError'))));
    await expect(client(f).call('x', {}, { timeoutMs: 10 })).rejects.toThrow(/超时/);
  });

  it('带外部 signal 的请求超时：仍报超时，且调用结束后外部 signal 上不留监听', async () => {
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, 'addEventListener');
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    const f: FetchLike = (_u, init) =>
      new Promise((_r, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('t', 'TimeoutError'))));
    await expect(client(f).call('x', {}, { signal: ac.signal, timeoutMs: 10 })).rejects.toThrow(/请求超时/);
    expect(add.mock.calls.filter((c) => c[0] === 'abort')).toHaveLength(1);
    expect(remove.mock.calls.filter((c) => c[0] === 'abort')).toHaveLength(1);
    expect(remove.mock.calls[0]![1]).toBe(add.mock.calls[0]![1]);
  });

  it('成功的请求结束后也摘掉外部 signal 上的监听', async () => {
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, 'addEventListener');
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    await client(async () => ok(true)).call('x', {}, { signal: ac.signal });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]![1]).toBe(add.mock.calls[0]![1]);
  });

  it('外部 signal 一开始就已取消：直接报取消', async () => {
    const ac = new AbortController();
    ac.abort();
    const f: FetchLike = (_u, init) =>
      new Promise((_r, reject) => {
        if (init!.signal!.aborted) reject(new DOMException('aborted', 'AbortError'));
      });
    await expect(client(f).call('x', {}, { signal: ac.signal })).rejects.toThrow(/请求被取消/);
  });
});

describe('pollUpdates', () => {
  const upd = (id: number): TelegramUpdate => ({ update_id: id });

  it('依次推进 offset，按顺序投递，abort 后退出', async () => {
    const ac = new AbortController();
    const offsets: Array<number | undefined> = [];
    const batches = [[upd(10), upd(11)], [upd(12)]];
    const f: FetchLike = async (_u, init) => {
      offsets.push(JSON.parse(String(init!.body)).offset);
      const b = batches.shift();
      if (!b) {
        ac.abort();
        return ok([]);
      }
      return ok(b);
    };
    const got: number[] = [];
    const reason = await pollUpdates({ client: client(f), signal: ac.signal, log: noopLogger, onUpdate: (u) => void got.push(u.update_id), sleep: instantSleep });
    expect(reason).toBe('aborted');
    expect(got).toEqual([10, 11, 12]);
    expect(offsets).toEqual([undefined, 12, 13]);
  });

  it('initialOffset：第一次拉取就带上；onProcessed 在每条处理完（含出错）后调用，关闭时没处理的不记录也不交给 bot', async () => {
    const ac = new AbortController();
    const offsets: Array<number | undefined> = [];
    const f: FetchLike = async (_u, init) => {
      offsets.push(JSON.parse(String(init!.body)).offset);
      return offsets.length === 1 ? ok([upd(21), upd(22), upd(23)]) : (ac.abort(), ok([]));
    };
    const got: number[] = [];
    const processed: number[] = [];
    await pollUpdates({
      client: client(f),
      signal: ac.signal,
      log: noopLogger,
      sleep: instantSleep,
      initialOffset: 21,
      onProcessed: (id) => void processed.push(id),
      onUpdate: (u) => {
        got.push(u.update_id);
        if (u.update_id === 21) throw new Error('boom');
        if (u.update_id === 22) ac.abort(); // 处理第 22 条时开始关闭
      },
    });
    expect(offsets[0]).toBe(21);
    expect(got).toEqual([21, 22]); // 23 没有交给 bot
    expect(processed).toEqual([21, 22]); // 23 没有被记录为已处理，重启后 Telegram 会再投递
  });

  it('单条处理失败不影响后续，并且不会重复拉取', async () => {
    const ac = new AbortController();
    let calls = 0;
    const f: FetchLike = async () => (++calls === 1 ? ok([upd(1), upd(2)]) : (ac.abort(), ok([])));
    const log = captureLogger();
    const got: number[] = [];
    await pollUpdates({
      client: client(f),
      signal: ac.signal,
      log,
      sleep: instantSleep,
      onUpdate: (u) => {
        if (u.update_id === 1) throw new Error('boom');
        got.push(u.update_id);
      },
    });
    expect(got).toEqual([2]);
    expect(log.lines.some((l) => l.includes('update 1'))).toBe(true);
  });

  it('网络错误指数退避后恢复', async () => {
    const ac = new AbortController();
    const sleeps: number[] = [];
    let n = 0;
    const f: FetchLike = async () => {
      n++;
      if (n <= 3) throw new TypeError('fetch failed');
      ac.abort();
      return ok([]);
    };
    await pollUpdates({ client: client(f), signal: ac.signal, log: noopLogger, onUpdate() {}, sleep: async (ms) => void sleeps.push(ms), backoffMs: { min: 100, max: 300 } });
    expect(sleeps).toEqual([100, 200, 300]);
  });

  it('401 停止轮询并提示检查 token', async () => {
    const log = captureLogger();
    const f: FetchLike = async () => json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
    const reason = await pollUpdates({ client: client(f), signal: new AbortController().signal, log, onUpdate() {}, sleep: instantSleep });
    expect(reason).toBe('unauthorized');
    expect(log.lines.join('\n')).toMatch(/botToken/);
  });
});
