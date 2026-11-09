import { describe, expect, it } from 'vitest';
import { validateConfig, type Config } from '../src/server/config';
import type { PluginStatus } from '../src/server/plugin';
import { Supervisor, type LoadResult, type ManagedRuntime } from '../src/server/supervisor';
import { captureLogger, FAKE_TOKEN } from './helpers';

const OTHER_TOKEN = '987654321:AAFakeOtherTokenOtherTokenOther_999';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function cfg(over: Record<string, unknown> = {}): Config {
  const v = validateConfig({ botToken: FAKE_TOKEN, allowedUserIds: [1], ...over });
  if (!v.ok) throw new Error('fixture');
  return v.config;
}

interface FakeRuntime extends ManagedRuntime {
  id: number;
  stopped: boolean;
}

/** 可控的假依赖：load 读 disk 变量，start/stop 记录顺序。 */
function harness(
  opts: {
    startDelayMs?: number;
    stopImpl?: (rt: FakeRuntime) => Promise<void>;
    telegram?: (c: Config) => Partial<PluginStatus>;
    startThrows?: boolean;
    /** 这个 token 的启动一直挂着（像网络不通的 getMe），直到被取消。 */
    hangToken?: string;
  } = {},
) {
  const log = captureLogger();
  const events: string[] = [];
  let disk: LoadResult = { ok: false, missing: true, errors: [{ field: '(file)', message: '找不到配置文件' }] };
  let seq = 0;
  const loads: Config[] = [];
  const host = { connected: false, hello: null as null | { stVersion: string; extVersion?: string } };
  const sup = new Supervisor<FakeRuntime>({
    log,
    host,
    chromium: () => ({ hint: '安装 Chromium' }),
    stopTimeoutMs: 80,
    load: () => {
      events.push('load');
      if (disk.ok) loads.push(disk.config);
      return disk;
    },
    start: async (config, _warnings, signal) => {
      const id = ++seq;
      events.push(`start${id}`);
      if (opts.startDelayMs) await wait(opts.startDelayMs);
      if (opts.hangToken === config.botToken) {
        await new Promise<void>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('请求被取消')), { once: true }));
      }
      if (opts.startThrows) throw new Error(`启动炸了 ${config.botToken}`);
      const rt: FakeRuntime = {
        id,
        stopped: false,
        config,
        status: { telegram: 'ok', botUsername: `bot${id}`, chromium: { path: '/chrome' }, proxy: { source: 'none', description: '' }, extension: { ok: true }, hostChecks: [], ...opts.telegram?.(config) },
        stop: async () => {
          events.push(`stop${id}`);
          if (opts.stopImpl) await opts.stopImpl(rt);
          rt.stopped = true;
          events.push(`stopped${id}`);
        },
      };
      events.push(`started${id}`);
      return rt;
    },
  });
  return {
    sup,
    log,
    events,
    loads,
    host,
    setDisk: (c: Config | null, invalid = false) => {
      disk = c ? { ok: true, config: c, warnings: [] } : invalid ? { ok: false, missing: false, errors: [{ field: 'botToken', message: 'botToken 格式不对' }] } : { ok: false, missing: true, errors: [{ field: '(file)', message: '找不到配置文件' }] };
    },
  };
}

describe('Supervisor', () => {
  it('没有配置：待命（no-config），info 级日志说明下一步；不启动运行时', async () => {
    const h = harness();
    const s = await h.sup.reload();
    expect(s).toMatchObject({ state: 'standby', standbyReason: 'no-config', telegram: 'skipped', hostConnected: false, chromium: { found: false, hint: '安装 Chromium' } });
    expect(h.sup.liveConfig()).toBeNull();
    expect(h.events).toEqual(['load']);
    const line = h.log.lines.find((l) => l.includes('待命'));
    expect(line).toMatch(/^info .*Silly TG.*Bot Token.*允许的用户 ID/);
    expect(h.log.lines.some((l) => l.startsWith('error'))).toBe(false);
  });

  it('配置有误：待命（invalid-config），error 日志逐条列出', async () => {
    const h = harness();
    h.setDisk(null, true);
    const s = await h.sup.reload();
    expect(s).toMatchObject({ state: 'standby', standbyReason: 'invalid-config', errors: [{ field: 'botToken' }] });
    expect(h.log.lines.filter((l) => l.startsWith('error')).join('\n')).toMatch(/botToken 格式不对[\s\S]*其余功能不受影响/);
  });

  it('待命 → 写入有效配置后 reload → running', async () => {
    const h = harness();
    await h.sup.reload();
    h.setDisk(cfg());
    const s = await h.sup.reload();
    expect(s).toMatchObject({ state: 'running', telegram: 'ok', botUsername: 'bot1', chromium: { found: true } });
    expect(s.standbyReason).toBeUndefined();
    expect(h.sup.liveConfig()?.botToken).toBe(FAKE_TOKEN);
  });

  it('running → 换 token：旧运行时先停完，新的才启动', async () => {
    const h = harness({ stopImpl: () => wait(20) });
    h.setDisk(cfg());
    await h.sup.reload();
    h.setDisk(cfg({ botToken: OTHER_TOKEN }));
    const s = await h.sup.reload();
    expect(h.events).toEqual(['load', 'start1', 'started1', 'stop1', 'stopped1', 'load', 'start2', 'started2']);
    expect(s.botUsername).toBe('bot2');
    expect(h.sup.liveConfig()?.botToken).toBe(OTHER_TOKEN);
  });

  it('并发 reload：执行中的多次请求合并为一次，且那一轮重新读盘；所有等待者拿到最终结果', async () => {
    const h = harness({ startDelayMs: 30 });
    h.setDisk(cfg());
    const a = h.sup.reload();
    await wait(5); // 第一轮正在 start
    h.setDisk(cfg({ botToken: OTHER_TOKEN }));
    const b = h.sup.reload();
    const c = h.sup.reload();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(h.events.filter((e) => e.startsWith('start') && !e.startsWith('started'))).toEqual(['start1', 'start2']);
    expect(h.loads.map((x) => x.botToken)).toEqual([FAKE_TOKEN, OTHER_TOKEN]);
    for (const r of [ra, rb, rc]) expect(r).toMatchObject({ state: 'running', botUsername: 'bot2' });
    expect(h.events.indexOf('stopped1')).toBeLessThan(h.events.indexOf('start2'));
  });

  it('starting 期间 status 为 starting、telegram pending；whenSettled 等到结束', async () => {
    const h = harness({ startDelayMs: 30 });
    h.setDisk(cfg());
    void h.sup.reload();
    await wait(5);
    expect(h.sup.status()).toMatchObject({ state: 'starting', telegram: 'pending' });
    // starting 时已经可以拿到这次加载的配置（热字段写进它会被运行时用上）
    expect(h.sup.liveConfig()?.botToken).toBe(FAKE_TOKEN);
    const s = await h.sup.whenSettled();
    expect(s.state).toBe('running');
    expect((await h.sup.whenSettled()).state).toBe('running');
  });

  it('旧运行时停止超时：记 warn 后继续启动新的，不会无限挂起', async () => {
    const h = harness({ stopImpl: () => new Promise(() => {}) });
    h.setDisk(cfg());
    await h.sup.reload();
    const t0 = Date.now();
    const s = await h.sup.reload();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.state).toBe('running');
    expect(h.events).toContain('start2');
    expect(h.log.lines.some((l) => l.startsWith('warn') && l.includes('超时'))).toBe(true);
  });

  it('启动抛错：进入待命（start-failed），原因已脱敏；再次 reload 可恢复', async () => {
    const h = harness({ startThrows: true });
    h.setDisk(cfg());
    const s = await h.sup.reload();
    expect(s).toMatchObject({ state: 'standby', standbyReason: 'start-failed' });
    expect(JSON.stringify(s)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(s)).toContain('启动炸了');
    expect(h.log.lines.join('\n')).not.toContain(FAKE_TOKEN);
  });

  it('RuntimeStatus 里的 telegramError 不含 token 和代理密码', async () => {
    const h = harness({
      telegram: (c) => ({ telegram: 'error', botUsername: undefined, telegramError: `401 Unauthorized at /bot${c.botToken}/getMe via http://u:proxy-pw@h:1` }),
    });
    h.setDisk(cfg({ telegramProxy: 'http://u:proxy-pw@h:1' }));
    const s = await h.sup.reload();
    expect(s).toMatchObject({ state: 'running', telegram: 'error' });
    const json = JSON.stringify(s);
    expect(json).toContain('401 Unauthorized');
    expect(json).not.toContain(FAKE_TOKEN);
    expect(json).not.toContain('proxy-pw');
  });

  it('host 页面状态与版本来自通道', async () => {
    const h = harness();
    h.setDisk(cfg());
    await h.sup.reload();
    h.host.connected = true;
    h.host.hello = { stVersion: '1.13.0', extVersion: '0.3.0' };
    expect(h.sup.status()).toMatchObject({ hostConnected: true, hostPage: { stVersion: '1.13.0', extVersion: '0.3.0' } });
    h.host.connected = false;
    expect(h.sup.status().hostPage).toBeUndefined();
  });

  it('stop：停掉运行中的运行时；之后的 reload 不再启动', async () => {
    const h = harness();
    h.setDisk(cfg());
    await h.sup.reload();
    await h.sup.stop();
    expect(h.events).toContain('stopped1');
    await h.sup.reload();
    expect(h.events.filter((e) => e === 'load')).toHaveLength(1);
    expect(h.sup.liveConfig()).toBeNull();
  });

  it('启动挂住时又来 reload：取消这次启动（不等网络超时），按最新配置启动；被取消的不留下运行时', async () => {
    const h = harness({ hangToken: FAKE_TOKEN });
    h.setDisk(cfg());
    const a = h.sup.reload();
    expect(h.sup.status().state).toBe('starting');
    h.setDisk(cfg({ botToken: OTHER_TOKEN }));
    const s = await h.sup.reload();
    expect(await a).toEqual(s);
    expect(s).toMatchObject({ state: 'running', botUsername: 'bot2' });
    expect(h.events).toEqual(['load', 'start1', 'load', 'start2', 'started2']);
    expect(h.log.lines.some((l) => l.startsWith('info') && l.includes('已取消这次启动'))).toBe(true);
    expect(h.log.lines.some((l) => l.startsWith('error'))).toBe(false);
  });

  it('启动挂住时 ST 退出：stop 立即取消启动并返回，不用等停止上限', async () => {
    const h = harness({ hangToken: FAKE_TOKEN });
    h.setDisk(cfg());
    void h.sup.reload();
    await h.sup.stop();
    expect(h.sup.status().state).toBe('standby');
    expect(h.sup.current()).toBeNull();
    // 挂住的启动是被取消掉的（否则它永远不会结束，运行时也会在之后冒出来）
    expect(h.log.lines.some((l) => l.includes('已取消这次启动'))).toBe(true);
  });

  it('stop 发生在启动过程中：启动完成后立刻被停掉，不留下运行时', async () => {
    const h = harness({ startDelayMs: 40 });
    h.setDisk(cfg());
    void h.sup.reload();
    await wait(5);
    await h.sup.stop();
    expect(h.events).toContain('stopped1');
    expect(h.sup.status().state).toBe('standby');
  });
});
