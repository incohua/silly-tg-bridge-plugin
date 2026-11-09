import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/server/http';
import { startPlugin } from '../src/server/plugin';
import { captureLogger, FAKE_TOKEN } from './helpers';

function dirWithConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'silly-tg-plugin-'));
  if (config !== undefined) writeFileSync(join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

const json = (b: unknown): Response => new Response(JSON.stringify(b));

describe('startPlugin', () => {
  it('配置文件缺失：返回 null，提示复制 config.example.json；只注册配置面板的接口（host 通道不注册）', async () => {
    const log = captureLogger();
    const router = express.Router();
    const rt = await startPlugin({ router, pluginDir: dirWithConfig(undefined), env: {}, log });
    expect(rt).toBeNull();
    // 只有配置面板的 GET/POST /config，没有 host 通道的路由
    expect(router.stack.map((l) => (l as unknown as { route?: { path: string } }).route?.path)).toEqual(['/config', '/config']);
    expect(log.lines.join('\n')).toMatch(/config\.example\.json/);
  });

  it('缺 token + 白名单为空：两条错误都出现', async () => {
    const log = captureLogger();
    const rt = await startPlugin({ router: express.Router(), pluginDir: dirWithConfig({}), env: {}, log });
    expect(rt).toBeNull();
    const out = log.lines.join('\n');
    expect(out).toMatch(/botToken/);
    expect(out).toMatch(/allowedUserIds/);
    expect(out).toMatch(/其余功能不受影响/);
  });

  it('离线模式：启动成功、注册路由、不访问 Telegram', async () => {
    const log = captureLogger();
    const router = express.Router();
    let fetched = 0;
    const rt = await startPlugin({
      router,
      pluginDir: dirWithConfig({ botToken: FAKE_TOKEN, allowedUserIds: [1] }),
      env: { SILLY_TG_OFFLINE: '1' },
      fetch: async () => (fetched++, json({ ok: true, result: [] })),
      log,
    });
    expect(rt).not.toBeNull();
    expect(fetched).toBe(0);
    expect(router.stack.length).toBeGreaterThan(0);
    expect(rt!.status.telegram).toBe('skipped');
    await rt!.stop();
  });

  it('在线：getMe 成功，白名单外的 update 不会到达处理器；stop 执行退出钩子', async () => {
    const log = captureLogger();
    const handled: number[] = [];
    let polled = 0;
    const f: FetchLike = async (url) => {
      if (url.endsWith('/getMe')) return json({ ok: true, result: { id: 9, username: 'testbot' } });
      if (polled++ === 0)
        return json({
          ok: true,
          result: [
            { update_id: 1, message: { message_id: 1, chat: { id: 5, type: 'private' }, from: { id: 5 } } },
            { update_id: 2, message: { message_id: 2, chat: { id: 1, type: 'private' }, from: { id: 1 } } },
          ],
        });
      await new Promise((r) => setTimeout(r, 20));
      return json({ ok: true, result: [] });
    };
    const rt = await startPlugin({
      router: express.Router(),
      pluginDir: dirWithConfig({ botToken: FAKE_TOKEN, allowedUserIds: [1] }),
      env: {},
      fetch: f,
      log,
    });
    expect(rt!.status).toMatchObject({ telegram: 'ok', botUsername: 'testbot' });
    rt!.setUpdateHandler((u) => void handled.push(u.update_id));
    let hooked = false;
    rt!.onShutdown(() => void (hooked = true));
    await new Promise((r) => setTimeout(r, 60));
    await rt!.stop();
    expect(handled).toEqual([2]);
    expect(hooked).toBe(true);
    expect(log.lines.join('\n')).not.toContain(FAKE_TOKEN);
  });

  it('Telegram 不可达：不抛错，给出代理提示', async () => {
    const log = captureLogger();
    const rt = await startPlugin({
      router: express.Router(),
      pluginDir: dirWithConfig({ botToken: FAKE_TOKEN, allowedUserIds: [1] }),
      env: {},
      fetch: async (url) => {
        throw new TypeError(`fetch failed ${url}`);
      },
      log,
    });
    expect(rt!.status.telegram).toBe('error');
    const out = log.lines.join('\n');
    expect(out).toMatch(/telegramProxy/);
    expect(out).not.toContain(FAKE_TOKEN);
    await rt!.stop();
  });

  it('Telegram 返回 401：说明网络和代理是通的，不提示检查代理，指向 botToken', async () => {
    const log = captureLogger();
    const rt = await startPlugin({
      router: express.Router(),
      pluginDir: dirWithConfig({ botToken: FAKE_TOKEN, allowedUserIds: [1] }),
      env: { HTTPS_PROXY: 'http://9.9.9.9:7897' },
      fetch: async () => json({ ok: false, error_code: 401, description: 'Unauthorized' }),
      log,
    });
    const out = log.lines.join('\n');
    expect(out).toMatch(/401 Unauthorized/);
    expect(out).toMatch(/botToken 被拒绝/);
    expect(out).not.toMatch(/检查代理是否可用/);
    expect(out).not.toContain(FAKE_TOKEN);
    await rt?.stop();
  });

  describe('Telegram 代理来源', () => {
    const start = (env: NodeJS.ProcessEnv, config: object = {}) => {
      const log = captureLogger();
      return startPlugin({
        router: express.Router(),
        pluginDir: dirWithConfig({ botToken: FAKE_TOKEN, allowedUserIds: [1], ...config }),
        env: { SILLY_TG_OFFLINE: '1', ...env },
        log,
      }).then((rt) => ({ rt: rt!, log }));
    };

    it('配置：status 与日志显示来源和主机，不含凭据', async () => {
      const { rt, log } = await start({ HTTPS_PROXY: 'http://env-u:env-pw@9.9.9.9:1' }, { telegramProxy: 'http://u:cfg-pw@10.0.0.1:7890' });
      expect(rt.status.proxy).toEqual({ source: 'config', description: '配置 telegramProxy（10.0.0.1:7890）' });
      const out = log.lines.join('\n');
      expect(out).toContain('Telegram 代理：配置 telegramProxy（10.0.0.1:7890）');
      expect(out).not.toMatch(/cfg-pw|env-pw/);
      await rt.stop();
    });

    it('环境变量：来源为 env，日志写出变量名和主机', async () => {
      const { rt, log } = await start({ https_proxy: 'http://u:env-pw@10.0.0.2:8080', NO_PROXY: 'localhost' });
      expect(rt.status.proxy).toEqual({ source: 'env', description: '环境变量 https_proxy（10.0.0.2:8080）' });
      const out = log.lines.join('\n');
      expect(out).toMatch(/Telegram 代理：环境变量 https_proxy（10\.0\.0\.2:8080），NO_PROXY=localhost/);
      expect(out).not.toContain('env-pw');
      await rt.stop();
    });

    it('无：来源为 none，没有代理日志', async () => {
      const { rt, log } = await start({});
      expect(rt.status.proxy).toEqual({ source: 'none', description: '无（直连）' });
      expect(log.lines.join('\n')).not.toContain('Telegram 代理');
      await rt.stop();
    });

    it('socks 环境变量：警告并直连，不泄露凭据', async () => {
      const { rt, log } = await start({ ALL_PROXY: 'socks5://u:socks-pw@127.0.0.1:1080' });
      expect(rt.status.proxy.source).toBe('none');
      expect(rt.status.proxy.description).toMatch(/已忽略 ALL_PROXY=socks5:\/\/127\.0\.0\.1:1080/);
      const warn = log.lines.find((l) => l.startsWith('warn') && l.includes('ALL_PROXY'));
      expect(warn).toMatch(/只支持 http\/https/);
      expect(log.lines.join('\n')).not.toContain('socks-pw');
      await rt.stop();
    });

    it('连接失败的提示按来源区分，且错误里的代理凭据被隐去', async () => {
      const run = async (env: NodeJS.ProcessEnv, config: object = {}) => {
        const log = captureLogger();
        const rt = await startPlugin({
          router: express.Router(),
          pluginDir: dirWithConfig({ botToken: FAKE_TOKEN, allowedUserIds: [1], ...config }),
          env,
          fetch: async () => {
            throw new TypeError('fetch failed: proxy http://u:leak-pw@10.0.0.2:8080 refused');
          },
          log,
        });
        await rt!.stop();
        return log.lines.filter((l) => l.startsWith('error')).join('\n');
      };
      expect(await run({}, { telegramProxy: 'http://10.0.0.1:7890' })).toMatch(/已配置 telegramProxy/);
      const envOut = await run({ HTTPS_PROXY: 'http://u:leak-pw@10.0.0.2:8080' });
      expect(envOut).toMatch(/环境变量 HTTPS_PROXY 里的代理/);
      expect(envOut).not.toContain('leak-pw');
      expect(await run({})).toMatch(/telegramProxy（或设置环境变量 HTTPS_PROXY）/);
    });
  });

  it('配置面板保存：热生效字段直接改到运行中的配置对象，其余字段保持不变', async () => {
    const log = captureLogger();
    const router = express.Router();
    const dir = dirWithConfig({ botToken: FAKE_TOKEN, allowedUserIds: [1], dialogueStyle: 'bold' });
    const rt = await startPlugin({ router, pluginDir: dir, env: { SILLY_TG_OFFLINE: '1' }, log });
    const layer = router.stack.find((l) => (l as unknown as { route?: { path: string; methods: Record<string, boolean> } }).route?.methods.post && (l as unknown as { route: { path: string } }).route.path === '/config') as unknown as {
      route: { stack: Array<{ handle: (req: unknown, res: unknown) => void }> };
    };
    let out: unknown;
    const res = { status: () => res, json: (b: unknown) => (out = b) };
    layer.route.stack[0].handle({ body: { settings: { dialogueStyle: 'italic', idleShutdownMinutes: 5, allowedUserIds: [1, 2] } } }, res);
    expect(out).toMatchObject({ ok: true, hot: ['dialogueStyle', 'idleShutdownMinutes'], restart: ['allowedUserIds'] });
    expect(rt!.config.dialogueStyle).toBe('italic');
    expect(rt!.config.idleShutdownMinutes).toBe(5);
    expect(rt!.config.allowedUserIds).toEqual([1]); // 需要重启才生效
    await rt!.stop();
  });
});
