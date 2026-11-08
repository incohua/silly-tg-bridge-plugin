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
  it('配置文件缺失：返回 null，提示复制 config.example.json，不注册路由', async () => {
    const log = captureLogger();
    const router = express.Router();
    const rt = await startPlugin({ router, pluginDir: dirWithConfig(undefined), env: {}, log });
    expect(rt).toBeNull();
    expect(router.stack).toHaveLength(0);
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
});
