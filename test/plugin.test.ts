import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchedBrowser, Launcher, PageLike } from '../src/server/browser';
import type { FetchLike } from '../src/server/http';
import { bootPlugin, type BootOptions, type PluginShell } from '../src/server/plugin';
import type { RuntimeStatus } from '../src/shared/runtime-status';
import { captureLogger, FAKE_TOKEN, type CapturedLogger } from './helpers';

const OTHER_TOKEN = '987654321:AAFakeOtherTokenOtherTokenOther_999';
const BAD_TOKEN = '555555555:AAFakeRejectedRejectedRejected_555';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dirWithConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'silly-tg-plugin-'));
  if (config !== undefined) writeFileSync(join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

const json = (b: unknown): Response => new Response(JSON.stringify(b));

/** 假 Telegram：按 URL 里的 token 区分 bot；记录调用顺序；getUpdates 在 abort 时立即返回。 */
/** 等条件成立（CPU 繁忙时定时器会被推迟，不按固定时长睡）。 */
const until = (fn: () => void) => vi.waitFor(fn, { timeout: 4000, interval: 5 });

function fakeTelegram(opts: { reject?: string[]; getMeDelayMs?: number; hang?: string[] } = {}) {
  const events: string[] = [];
  const tag = (token: string) => (token === FAKE_TOKEN ? 'A' : token === OTHER_TOKEN ? 'B' : token === BAD_TOKEN ? 'BAD' : '?');
  const f: FetchLike = async (url, init) => {
    const m = /\/bot([^/]+)\/(\w+)$/.exec(url);
    const token = m?.[1] ?? '';
    const method = m?.[2] ?? '';
    const t = tag(token);
    if (opts.reject?.includes(token)) {
      events.push(`${method}:${t}:401`);
      return json({ ok: false, error_code: 401, description: 'Unauthorized' });
    }
    if (method === 'getMe') {
      events.push(`getMe:${t}`);
      if (opts.hang?.includes(token)) {
        // 像网络不通：一直挂着，直到请求被取消
        await new Promise<void>((_r, reject) => init?.signal?.addEventListener('abort', () => (events.push(`abortGetMe:${t}`), reject(new DOMException('aborted', 'AbortError'))), { once: true }));
      }
      if (opts.getMeDelayMs) await wait(opts.getMeDelayMs);
      return json({ ok: true, result: { id: 9, username: `bot${t}` } });
    }
    if (method === 'getUpdates') {
      events.push(`getUpdates:${t}`);
      const signal = init?.signal;
      await new Promise<void>((r) => {
        const timer = setTimeout(r, 20);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          events.push(`abort:${t}`);
          r();
        });
      });
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return json({ ok: true, result: [] });
    }
    events.push(`${method}:${t}`);
    return json({ ok: true, result: true });
  };
  return { fetch: f, events };
}

const shells: PluginShell[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of shells.splice(0)) await s.stop();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** 启动外壳。默认找不到 Chromium（单元测试不拉起浏览器），扩展部署用假实现。 */
async function boot(config: unknown, over: Partial<BootOptions> = {}): Promise<{ shell: PluginShell; log: CapturedLogger; router: express.Router; dir: string; deployed: string[] }> {
  const log = captureLogger();
  const router = express.Router();
  const dir = dirWithConfig(config);
  const deployed: string[] = [];
  const shell = await bootPlugin({
    router,
    pluginDir: dir,
    env: { SILLY_TG_OFFLINE: '1' },
    log,
    findChromium: () => ({ hint: '测试环境不启动 Chromium' }),
    deploy: async ({ pluginDir }) => (deployed.push(pluginDir), { ok: true, message: 'UI 扩展已是最新' }),
    ...over,
  });
  shells.push(shell);
  return { shell, log, router, dir, deployed };
}

async function listen(router: express.Router): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api/plugins/silly-tg', router);
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plugins/silly-tg`;
}

async function save(base: string, settings: Record<string, unknown>): Promise<{ status: number; body: { ok: boolean; runtime: RuntimeStatus; reloaded: string[]; hot: string[] } & Record<string, unknown> }> {
  const res = await fetch(`${base}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings }) });
  return { status: res.status, body: (await res.json()) as never };
}

const routePaths = (router: express.Router) => router.stack.map((l) => (l as unknown as { route?: { path: string } }).route?.path);

describe('bootPlugin', () => {
  describe('hello 版本比对', () => {
    /** 启动插件并用真实 HTTP 往 host 通道发一条 hello，返回 HTTP 状态和日志。 */
    async function sendHello(serverVersion: string, extVersion: string | undefined): Promise<{ status: number; out: string }> {
      const { shell, log, router } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1] }, { version: serverVersion });
      await shell.supervisor.whenSettled();
      const base = await listen(router);
      const nonce = shell.channel.nonce;
      const event = { type: 'hello', nonce, stVersion: '1.19.0', hasTavernHelper: true, ...(extVersion === undefined ? {} : { extVersion }) };
      const res = await fetch(`${base}/host/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce, event }) });
      return { status: res.status, out: log.lines.join('\n') };
    }

    it('版本不一致：警告里含两边版本，但连接照常被接受', async () => {
      const r = await sendHello('0.3.0', '0.2.0');
      expect(r.status).toBe(200);
      expect(r.out).toMatch(/warn .*0\.2\.0.*0\.3\.0/);
    });
    it('版本一致、或旧版扩展不带版本字段：不警告', async () => {
      for (const ext of ['0.3.0', undefined]) {
        const r = await sendHello('0.3.0', ext);
        expect(r.status).toBe(200);
        expect(r.out).not.toContain('不一致');
      }
    });
  });

  it('没有 config.json：待命（info 级说明下一步）；面板路由、host 通道路由都注册，UI 扩展照常部署', async () => {
    const { shell, log, router, dir, deployed } = await boot(undefined, { env: {} });
    const s = await shell.supervisor.whenSettled();
    expect(s).toMatchObject({ state: 'standby', standbyReason: 'no-config' });
    expect(deployed).toEqual([dir]);
    expect(routePaths(router)).toEqual(expect.arrayContaining(['/config', '/status', '/host/events', '/host/message']));
    const out = log.lines.join('\n');
    expect(out).toMatch(/info .*待命.*Silly TG.*Bot Token/);
    expect(log.lines.some((l) => l.startsWith('error'))).toBe(false);
    // 面板可用
    const base = await listen(router);
    const g = (await (await fetch(`${base}/config`)).json()) as { exists: boolean; runtime: RuntimeStatus };
    expect(g).toMatchObject({ exists: false, runtime: { state: 'standby', standbyReason: 'no-config' } });
  });

  it('缺 token + 白名单为空：待命（invalid-config），两条错误都以 error 级出现', async () => {
    const { shell, log } = await boot({}, { env: {} });
    const s = await shell.supervisor.whenSettled();
    expect(s).toMatchObject({ state: 'standby', standbyReason: 'invalid-config' });
    const out = log.lines.filter((l) => l.startsWith('error')).join('\n');
    expect(out).toMatch(/botToken/);
    expect(out).toMatch(/allowedUserIds/);
    expect(out).toMatch(/其余功能不受影响/);
  });

  it('离线模式：运行中、不访问 Telegram', async () => {
    let fetched = 0;
    const { shell } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1] }, { fetch: async () => (fetched++, json({ ok: true, result: [] })) });
    expect((await shell.supervisor.whenSettled()).state).toBe('running');
    expect(fetched).toBe(0);
    expect(shell.supervisor.current()!.status.telegram).toBe('skipped');
  });

  it('init 不等 Telegram：getMe 很慢时外壳先返回，运行时在后台 starting', async () => {
    const tg = fakeTelegram({ getMeDelayMs: 80 });
    const { shell } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1] }, { env: {}, fetch: tg.fetch });
    expect(shell.supervisor.status()).toMatchObject({ state: 'starting', telegram: 'pending' });
    expect((await shell.supervisor.whenSettled()).state).toBe('running');
  });

  it('在线：getMe 成功，白名单外的 update 不会到达处理器；stop 执行退出钩子', async () => {
    const handled: number[] = [];
    let polled = 0;
    const f: FetchLike = async (url) => {
      if (url.endsWith('/getMe')) return json({ ok: true, result: { id: 9, username: 'testbot' } });
      if (!url.endsWith('/getUpdates')) return json({ ok: true, result: true });
      if (polled++ === 0) {
        await wait(20); // 让测试先换上处理器
        return json({
          ok: true,
          result: [
            { update_id: 1, message: { message_id: 1, chat: { id: 5, type: 'private' }, from: { id: 5 } } },
            { update_id: 2, message: { message_id: 2, chat: { id: 1, type: 'private' }, from: { id: 1 } } },
          ],
        });
      }
      await wait(20);
      return json({ ok: true, result: [] });
    };
    const { shell, log } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1] }, { env: {}, fetch: f });
    await shell.supervisor.whenSettled();
    const rt = shell.supervisor.current()!;
    expect(rt.status).toMatchObject({ telegram: 'ok', botUsername: 'testbot' });
    rt.setUpdateHandler((u) => void handled.push(u.update_id));
    let hooked = false;
    rt.onShutdown(() => void (hooked = true));
    // 第二次 getUpdates 说明第一批 update 已经处理完
    await until(() => expect(polled).toBeGreaterThanOrEqual(2));
    await shell.stop();
    expect(handled).toEqual([2]);
    expect(hooked).toBe(true);
    expect(log.lines.join('\n')).not.toContain(FAKE_TOKEN);
  });

  it('Telegram 不可达：不抛错，给出代理提示；面板状态里有原因且不含 token', async () => {
    const { shell, log } = await boot(
      { botToken: FAKE_TOKEN, allowedUserIds: [1] },
      {
        env: {},
        fetch: async (url) => {
          throw new TypeError(`fetch failed ${url}`);
        },
      },
    );
    const s = await shell.supervisor.whenSettled();
    expect(s).toMatchObject({ state: 'running', telegram: 'error' });
    expect(s.telegramError).toMatch(/telegramProxy/);
    expect(JSON.stringify(s)).not.toContain(FAKE_TOKEN);
    const out = log.lines.join('\n');
    expect(out).toMatch(/telegramProxy/);
    expect(out).not.toContain(FAKE_TOKEN);
  });

  it('Telegram 返回 401：说明网络和代理是通的，不提示检查代理，指向 botToken', async () => {
    const { shell, log } = await boot(
      { botToken: FAKE_TOKEN, allowedUserIds: [1] },
      { env: { HTTPS_PROXY: 'http://9.9.9.9:7897' }, fetch: async () => json({ ok: false, error_code: 401, description: 'Unauthorized' }) },
    );
    const s = await shell.supervisor.whenSettled();
    expect(s.telegramError).toMatch(/botToken 被拒绝/);
    const out = log.lines.join('\n');
    expect(out).toMatch(/401 Unauthorized/);
    expect(out).toMatch(/botToken 被拒绝/);
    expect(out).not.toMatch(/检查代理是否可用/);
    // token 被拒绝后轮询会停止，不能再说“将继续在后台重试”
    expect(out).not.toMatch(/将继续在后台重试/);
    expect(out).not.toContain(FAKE_TOKEN);
  });

  describe('Telegram 代理来源', () => {
    const start = async (env: NodeJS.ProcessEnv, config: object = {}) => {
      const { shell, log } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1], ...config }, { env: { SILLY_TG_OFFLINE: '1', ...env } });
      await shell.supervisor.whenSettled();
      return { rt: shell.supervisor.current()!, log };
    };

    it('配置：status 与日志显示来源和主机，不含凭据', async () => {
      const { rt, log } = await start({ HTTPS_PROXY: 'http://env-u:env-pw@9.9.9.9:1' }, { telegramProxy: 'http://u:cfg-pw@10.0.0.1:7890' });
      expect(rt.status.proxy).toEqual({ source: 'config', description: '配置 telegramProxy（10.0.0.1:7890）' });
      const out = log.lines.join('\n');
      expect(out).toContain('Telegram 代理：配置 telegramProxy（10.0.0.1:7890）');
      expect(out).not.toMatch(/cfg-pw|env-pw/);
    });

    it('环境变量：来源为 env，日志写出变量名和主机', async () => {
      const { rt, log } = await start({ https_proxy: 'http://u:env-pw@10.0.0.2:8080', NO_PROXY: 'localhost' });
      expect(rt.status.proxy).toEqual({ source: 'env', description: '环境变量 https_proxy（10.0.0.2:8080）' });
      const out = log.lines.join('\n');
      expect(out).toMatch(/Telegram 代理：环境变量 https_proxy（10\.0\.0\.2:8080），NO_PROXY=localhost/);
      expect(out).not.toContain('env-pw');
    });

    it('无：来源为 none，没有代理日志', async () => {
      const { rt, log } = await start({});
      expect(rt.status.proxy).toEqual({ source: 'none', description: '无（直连）' });
      expect(log.lines.join('\n')).not.toContain('Telegram 代理');
    });

    it('socks 环境变量：警告并直连，不泄露凭据', async () => {
      const { rt, log } = await start({ ALL_PROXY: 'socks5://u:socks-pw@127.0.0.1:1080' });
      expect(rt.status.proxy.source).toBe('none');
      expect(rt.status.proxy.description).toMatch(/已忽略 ALL_PROXY=socks5:\/\/127\.0\.0\.1:1080/);
      const warn = log.lines.find((l) => l.startsWith('warn') && l.includes('ALL_PROXY'));
      expect(warn).toMatch(/只支持 http\/https/);
      expect(log.lines.join('\n')).not.toContain('socks-pw');
    });

    it('连接失败的提示按来源区分，且错误里的代理凭据被隐去（日志和面板状态）', async () => {
      const run = async (env: NodeJS.ProcessEnv, config: object = {}) => {
        const { shell, log } = await boot(
          { botToken: FAKE_TOKEN, allowedUserIds: [1], ...config },
          {
            env,
            fetch: async () => {
              throw new TypeError('fetch failed: proxy http://u:leak-pw@10.0.0.2:8080 refused');
            },
          },
        );
        const s = await shell.supervisor.whenSettled();
        return { out: log.lines.filter((l) => l.startsWith('error')).join('\n'), status: JSON.stringify(s) };
      };
      expect((await run({}, { telegramProxy: 'http://10.0.0.1:7890' })).out).toMatch(/已配置 telegramProxy/);
      const env = await run({ HTTPS_PROXY: 'http://u:leak-pw@10.0.0.2:8080' });
      expect(env.out).toMatch(/环境变量 HTTPS_PROXY 里的代理/);
      expect(env.out).not.toContain('leak-pw');
      expect(env.status).toMatch(/环境变量 HTTPS_PROXY 里的代理/);
      expect(env.status).not.toContain('leak-pw');
      expect((await run({})).out).toMatch(/telegramProxy（或设置环境变量 HTTPS_PROXY）/);
    });
  });

  describe('面板保存', () => {
    it('热生效字段（含 allowedUserIds）直接改到运行中的配置对象，不重新加载', async () => {
      const { shell, router } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1], dialogueStyle: 'bold' });
      await shell.supervisor.whenSettled();
      const rt = shell.supervisor.current()!;
      const base = await listen(router);
      const r = await save(base, { dialogueStyle: 'italic', idleShutdownMinutes: 5, allowedUserIds: [1, 2] });
      expect(r.body).toMatchObject({ ok: true, hot: ['allowedUserIds', 'dialogueStyle', 'idleShutdownMinutes'], reloaded: [], runtime: { state: 'running' } });
      expect(shell.supervisor.current()).toBe(rt);
      expect(rt.config).toMatchObject({ dialogueStyle: 'italic', idleShutdownMinutes: 5, allowedUserIds: [1, 2] });
    });

    it('待命 → 保存有效配置：当场启动，响应里是 running；无需重启', async () => {
      const tg = fakeTelegram();
      const { shell, router, log } = await boot(undefined, { env: {}, fetch: tg.fetch });
      await shell.supervisor.whenSettled();
      const base = await listen(router);
      const r = await save(base, { botToken: FAKE_TOKEN, allowedUserIds: [7] });
      expect(r.status).toBe(200);
      expect(r.body.runtime).toMatchObject({ state: 'running', telegram: 'ok', botUsername: 'botA' });
      expect(JSON.stringify(r.body)).not.toContain(FAKE_TOKEN);
      expect(log.lines.join('\n')).toMatch(/Telegram 已连接，bot：@botA/);
      const st = (await (await fetch(`${base}/status`)).json()) as { runtime: RuntimeStatus };
      expect(st.runtime.state).toBe('running');
    });

    it('运行中换 token：旧轮询先停，新 bot 才连接；最后只剩新 token 在轮询', async () => {
      const tg = fakeTelegram();
      const { shell, router } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1] }, { env: {}, fetch: tg.fetch });
      await shell.supervisor.whenSettled();
      await wait(30);
      const base = await listen(router);
      const r = await save(base, { botToken: OTHER_TOKEN });
      expect(r.body).toMatchObject({ reloaded: ['botToken'], runtime: { state: 'running', botUsername: 'botB' } });
      const ev = tg.events;
      expect(ev.indexOf('abort:A')).toBeGreaterThan(-1);
      expect(ev.indexOf('abort:A')).toBeLessThan(ev.indexOf('getMe:B'));
      tg.events.length = 0;
      await until(() => expect(tg.events.filter((e) => e === 'getUpdates:B').length).toBeGreaterThanOrEqual(2));
      expect(tg.events.filter((e) => e.startsWith('getUpdates')).every((e) => e === 'getUpdates:B')).toBe(true);
    });

    it('保存被拒绝的 token：面板拿到明确原因；再保存有效 token 即恢复，不用重启', async () => {
      const tg = fakeTelegram({ reject: [BAD_TOKEN] });
      const { shell, router } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1] }, { env: {}, fetch: tg.fetch });
      await shell.supervisor.whenSettled();
      const base = await listen(router);
      const bad = await save(base, { botToken: BAD_TOKEN });
      expect(bad.body.runtime).toMatchObject({ state: 'running', telegram: 'error' });
      expect(bad.body.runtime.telegramError).toMatch(/botToken 被拒绝/);
      expect(JSON.stringify(bad.body)).not.toContain(BAD_TOKEN);
      const good = await save(base, { botToken: OTHER_TOKEN });
      expect(good.body.runtime).toMatchObject({ state: 'running', telegram: 'ok', botUsername: 'botB' });
      expect(good.body.runtime.telegramError).toBeUndefined();
    });

    it('快速连续保存两次：合并成最多一次额外加载，最后用的是最新的 token，没有重复轮询', async () => {
      const tg = fakeTelegram({ getMeDelayMs: 30 });
      const { shell, router } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1] }, { env: {}, fetch: tg.fetch });
      await shell.supervisor.whenSettled();
      const base = await listen(router);
      const [a, b] = await Promise.all([save(base, { botToken: BAD_TOKEN.replace('555555555', '444444444') }), wait(5).then(() => save(base, { botToken: OTHER_TOKEN }))]);
      expect(a.status).toBe(200);
      expect(b.body.runtime).toMatchObject({ state: 'running', botUsername: 'botB' });
      // 初次 1 次 + 两次保存最多 2 次
      expect(tg.events.filter((e) => e.startsWith('getMe')).length).toBeLessThanOrEqual(3);
      expect(JSON.parse(readFileSync(shell.configPath, 'utf8')).botToken).toBe(OTHER_TOKEN);
      tg.events.length = 0;
      await until(() => expect(tg.events.filter((e) => e === 'getUpdates:B').length).toBeGreaterThanOrEqual(2));
      expect(tg.events.filter((e) => e.startsWith('getUpdates')).every((e) => e === 'getUpdates:B')).toBe(true);
    });
  });

  it('getMe 挂住（网络不通）时保存新 token：取消挂住的启动，不等 30 秒超时；旧 token 从未开始轮询', async () => {
    const tg = fakeTelegram({ hang: [FAKE_TOKEN] });
    const { shell, router } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1] }, { env: {}, fetch: tg.fetch });
    expect(shell.supervisor.status().state).toBe('starting');
    const base = await listen(router);
    const r = await save(base, { botToken: OTHER_TOKEN });
    expect(r.body).toMatchObject({ reloaded: ['botToken'], reloadedRuntime: true, runtime: { state: 'running', telegram: 'ok', botUsername: 'botB' } });
    expect(tg.events).toContain('abortGetMe:A');
    expect(tg.events.some((e) => e === 'getUpdates:A')).toBe(false);
  });

  it('白名单收紧（热生效）：被移除的用户下一条消息立即被拒绝', async () => {
    const queue: object[][] = [];
    const f: FetchLike = async (url, init) => {
      if (url.endsWith('/getMe')) return json({ ok: true, result: { id: 9, username: 'testbot' } });
      if (!url.endsWith('/getUpdates')) return json({ ok: true, result: true });
      const batch = queue.shift();
      if (batch) return json({ ok: true, result: batch });
      await new Promise<void>((r) => {
        const t = setTimeout(r, 5);
        init?.signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });
      return json({ ok: true, result: [] });
    };
    const { shell, router } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1, 2] }, { env: {}, fetch: f });
    await shell.supervisor.whenSettled();
    const handled: number[] = [];
    shell.supervisor.current()!.setUpdateHandler((u) => void handled.push(u.message!.from!.id));
    const msg = (id: number, from: number) => ({ update_id: id, message: { message_id: id, chat: { id: from, type: 'private' }, from: { id: from } } });
    queue.push([msg(1, 2)]);
    await until(() => expect(handled).toEqual([2]));
    const base = await listen(router);
    const r = await save(base, { allowedUserIds: [1] });
    expect(r.body).toMatchObject({ hot: ['allowedUserIds'], reloaded: [], reloadedRuntime: false });
    queue.push([msg(2, 2), msg(3, 1)]);
    await until(() => expect(handled).toEqual([2, 1]));
  });

  it('消息映射跨重新加载保留：旧运行时写入的会话，新运行时能读到', async () => {
    const { shell } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1] });
    await shell.supervisor.whenSettled();
    shell.supervisor.current()!.bridge!.store.setSession({ characterAvatar: 'a.png', chatId: 'chat-1' });
    await shell.supervisor.reload();
    expect(shell.supervisor.current()!.bridge!.store.session).toEqual({ characterAvatar: 'a.png', chatId: 'chat-1' });
  });

  describe('无头浏览器（假 launcher）', () => {
    function fakeLauncher(events: string[]) {
      let n = 0;
      const launcher: Launcher = async () => {
        const id = ++n;
        events.push(`launch${id}`);
        const b: LaunchedBrowser = {
          pid: 1000 + id,
          newPage: async (): Promise<PageLike> => ({
            authenticate: async () => {},
            goto: async () => ({ status: () => 200 }),
            url: () => 'http://127.0.0.1/',
            on: (() => {}) as PageLike['on'],
          }),
          close: async () => void events.push(`close${id}`),
          kill: () => void events.push(`kill${id}`),
          onDisconnected: () => {},
        };
        return b;
      };
      return launcher;
    }

    async function fakeSt(): Promise<string> {
      const app = express();
      app.get('/', (_req, res) => void res.send('ok'));
      const server = await new Promise<Server>((r) => {
        const s = app.listen(0, '127.0.0.1', () => r(s));
      });
      servers.push(server);
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    it('重新加载：先关掉旧 Chromium，再启动新的；退出时也关闭', async () => {
      const events: string[] = [];
      const stBaseUrl = await fakeSt();
      const { shell } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1], stBaseUrl }, { findChromium: () => ({ path: '/fake/chrome', source: 'system' }), launcher: fakeLauncher(events) });
      await shell.supervisor.whenSettled();
      while (!events.includes('launch1')) await wait(5);
      const t = Date.now();
      await shell.supervisor.reload();
      expect(Date.now() - t).toBeLessThan(3000);
      while (!events.includes('launch2')) await wait(5);
      expect(events.slice(0, 3)).toEqual(['launch1', 'close1', 'launch2']);
      await shell.stop();
      expect(events).toContain('close2');
      expect(events.filter((e) => e.startsWith('launch'))).toHaveLength(2);
    });
  });

  it('退出：停掉轮询，之后不再有 Telegram 请求', async () => {
    const tg = fakeTelegram();
    const { shell } = await boot({ botToken: FAKE_TOKEN, allowedUserIds: [1] }, { env: {}, fetch: tg.fetch });
    await shell.supervisor.whenSettled();
    await shell.stop();
    expect(tg.events).toContain('abort:A');
    tg.events.length = 0;
    await wait(60);
    expect(tg.events).toEqual([]);
    expect(shell.supervisor.status().state).toBe('standby');
  });
});
