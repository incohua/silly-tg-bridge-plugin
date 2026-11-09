import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFetch, describeProxy, resolveProxy } from '../src/server/http';

describe('resolveProxy', () => {
  it('telegramProxy 优先于环境变量', () => {
    const r = resolveProxy('http://cfg:1111', { HTTPS_PROXY: 'http://env:2222' });
    expect(r).toEqual({ source: 'config', url: 'http://cfg:1111' });
  });

  it('只有环境变量：按 HTTPS_PROXY、https_proxy、HTTP_PROXY、http_proxy、ALL_PROXY、all_proxy 的顺序取第一个非空值', () => {
    const order = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
    for (let i = 0; i < order.length; i++) {
      const env: NodeJS.ProcessEnv = {};
      // 排在前面的留空，从第 i 个开始都有值
      order.forEach((k, j) => {
        env[k] = j < i ? '' : `http://h${j}:80`;
      });
      expect(resolveProxy(undefined, env)).toMatchObject({ source: 'env', envName: order[i], url: `http://h${i}:80` });
    }
  });

  it('NO_PROXY / no_proxy 记录下来', () => {
    expect(resolveProxy(undefined, { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'localhost,.lan' }).noProxy).toBe('localhost,.lan');
    expect(resolveProxy(undefined, { HTTPS_PROXY: 'http://p:1', no_proxy: '127.0.0.1' }).noProxy).toBe('127.0.0.1');
  });

  it('什么都没有：直连', () => {
    expect(resolveProxy(undefined, {})).toEqual({ source: 'none' });
    expect(resolveProxy(undefined, { HTTPS_PROXY: '  ' })).toEqual({ source: 'none' });
  });

  it('socks 等协议被忽略并直连，ignored 里不含凭据', () => {
    const r = resolveProxy(undefined, { ALL_PROXY: 'socks5://user:secret-pw@127.0.0.1:1080' });
    expect(r.source).toBe('none');
    expect(r.ignored).toBe('ALL_PROXY=socks5://127.0.0.1:1080');
    expect(JSON.stringify(r)).not.toContain('secret-pw');
    expect(describeProxy(r)).toMatch(/已忽略 ALL_PROXY=socks5/);
  });

  it('无法识别的值（例如缺少协议头）被忽略，且不回显原文', () => {
    const r = resolveProxy(undefined, { HTTPS_PROXY: 'user:pw-secret@host' });
    expect(r.source).toBe('none');
    expect(r.ignored).toBeDefined();
    expect(JSON.stringify(r)).not.toContain('pw-secret');
  });
});

describe('describeProxy', () => {
  it('三种来源都只显示来源和主机，不含账号密码', () => {
    const cfg = describeProxy(resolveProxy('http://u:cfg-pw@10.0.0.1:7890', {}));
    expect(cfg).toBe('配置 telegramProxy（10.0.0.1:7890）');
    const env = describeProxy(resolveProxy(undefined, { HTTPS_PROXY: 'http://u:env-pw@10.0.0.2:8080' }));
    expect(env).toBe('环境变量 HTTPS_PROXY（10.0.0.2:8080）');
    expect(describeProxy(resolveProxy(undefined, {}))).toBe('无（直连）');
    for (const s of [cfg, env]) expect(s).not.toMatch(/pw|u:/);
  });
});

describe('createFetch 使用环境变量代理', () => {
  let proxy: Server | undefined;
  let target: Server | undefined;
  afterEach(async () => {
    for (const s of [proxy, target]) {
      s?.closeAllConnections();
      await new Promise<void>((r) => (s ? s.close(() => r()) : r()));
    }
    proxy = target = undefined;
  });

  async function setup() {
    const seen: string[] = [];
    proxy = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.end('via-proxy');
    });
    proxy.on('connect', (req, socket) => {
      seen.push(`CONNECT ${req.url}`);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    target = createServer((_q, s) => s.end('direct'));
    await Promise.all([proxy, target].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))));
    const proxyPort = (proxy.address() as AddressInfo).port;
    const targetPort = (target.address() as AddressInfo).port;
    return { seen, proxyPort, targetPort };
  }

  it('仅有环境变量：请求发往代理', async () => {
    const { seen, proxyPort, targetPort } = await setup();
    const f = createFetch(resolveProxy(undefined, { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }));
    await f(`http://127.0.0.1:${targetPort}/x`).then((r) => r.text(), () => '');
    expect(seen.join('\n')).toContain(`:${targetPort}`);
  });

  it('NO_PROXY 命中：直连目标，代理收不到请求', async () => {
    const { seen, proxyPort, targetPort } = await setup();
    const f = createFetch(resolveProxy(undefined, { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.1' }));
    const res = await f(`http://127.0.0.1:${targetPort}/x`);
    expect(await res.text()).toBe('direct');
    expect(seen).toEqual([]);
  });

  it('配置优先：环境变量里的代理不会被使用', async () => {
    const { seen, proxyPort, targetPort } = await setup();
    // 配置的代理指向不存在的端口；环境变量指向真代理，不应被用到
    const f = createFetch(resolveProxy('http://127.0.0.1:1', { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }));
    await expect(f(`http://127.0.0.1:${targetPort}/x`)).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it('只有被忽略的 socks 环境变量：直连', async () => {
    const { seen, targetPort } = await setup();
    const f = createFetch(resolveProxy(undefined, { ALL_PROXY: 'socks5://127.0.0.1:1080' }));
    expect(await (await f(`http://127.0.0.1:${targetPort}/x`)).text()).toBe('direct');
    expect(seen).toEqual([]);
  });
});
