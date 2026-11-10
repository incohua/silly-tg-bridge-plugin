import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFetch } from '../src/server/http';

let proxy: Server | undefined;
afterEach(async () => {
  proxy?.closeAllConnections();
  await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
  proxy = undefined;
});

describe('createFetch', () => {
  it('配置代理后，HTTPS 请求通过 CONNECT 发往代理（不访问真实 Telegram）', async () => {
    const connects: string[] = [];
    const proxyAuth: Array<string | undefined> = [];
    proxy = createServer();
    proxy.on('connect', (req, socket) => {
      connects.push(req.url ?? '');
      proxyAuth.push(req.headers['proxy-authorization'] as string | undefined);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    await new Promise<void>((r) => proxy!.listen(0, '127.0.0.1', () => r()));
    const port = (proxy.address() as AddressInfo).port;
    const f = createFetch(`http://user:pw@127.0.0.1:${port}`);
    await expect(f('https://api.telegram.org/botX/getMe')).rejects.toThrow();
    expect(connects).toEqual(['api.telegram.org:443']);
    expect(proxyAuth[0]).toMatch(/^Basic /);
  });

  it('不配代理时直接使用全局 fetch', async () => {
    const srv = createServer((_q, s) => s.end('hi'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const f = createFetch();
    const res = await f(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`);
    expect(await res.text()).toBe('hi');
    srv.close();
  });

  it('用代理时返回的 fetch 带 close()，直连时没有', async () => {
    const f = createFetch('http://127.0.0.1:1');
    expect(typeof f.close).toBe('function');
    await f.close!();
    expect(createFetch().close).toBeUndefined();
  });
});
