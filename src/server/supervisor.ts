// 运行时监管：在 ST 的整个生命周期里，按需停止并重新拉起插件运行时（Telegram 轮询、无头浏览器、bot）。
//
// 契约：
//   - 串行：任意时刻最多一次 stop/start 在进行。
//   - 合并：执行中又来 reload，只记一个“还要再来一次”的标志；当前这轮结束后再跑一轮，并重新读盘。
//     多次请求合并成一轮，所有调用者拿到的都是最后一轮结束后的状态。
//   - 先停后起：旧运行时 stop 完成（或超过 stopTimeoutMs 放弃）后才启动新的。两个轮询同时用同一个
//     token 会得到 Telegram 409，所以不能重叠。
//   - 失败不致命：配置缺失/有误、启动抛错都进入待命（standby），任何状态下都可以再次 reload。
//   - 可取消：启动进行中又来 reload（要重跑）或 ST 退出时，中止这次启动（getMe 等网络请求立即返回），
//     不用等到超时；被取消的启动不留下运行时。
//   - 所有进入 RuntimeStatus 和日志的错误字符串都经过脱敏。

import type { RuntimeIssue, RuntimeState, RuntimeStatus, StandbyReason } from '../shared/runtime-status';
import type { ChromiumLookup } from './chromium-path';
import { configSecrets, type Config, type ConfigIssue } from './config';
import type { Logger } from './logger';
import type { PluginStatus } from './plugin';
import { redact, redactError } from './redact';

export type { RuntimeState, RuntimeStatus } from '../shared/runtime-status';

/** 由 Supervisor 管理的运行时（plugin.ts 的 PluginRuntime 满足它）。 */
export interface ManagedRuntime {
  readonly config: Config;
  readonly status: PluginStatus;
  stop(): Promise<void>;
}

export type LoadResult = { ok: true; config: Config; warnings: ConfigIssue[] } | { ok: false; missing: boolean; errors: ConfigIssue[] };

export interface SupervisorHost {
  readonly connected: boolean;
  readonly hello: { stVersion: string; extVersion?: string } | null;
}

export interface SupervisorOptions<R extends ManagedRuntime> {
  log: Logger;
  /** 每一轮都重新读盘。 */
  load(): LoadResult;
  /** signal 触发表示这次启动已经作废（有新的 reload 或 ST 退出）：尽快清理并抛错。 */
  start(config: Config, warnings: ConfigIssue[], signal: AbortSignal): Promise<R>;
  host: SupervisorHost;
  /** 待命时显示的 Chromium 查找结果（运行中以运行时自己的为准）。 */
  chromium(): ChromiumLookup;
  /** 某份配置对应的脱敏列表，默认 configSecrets(config)；插件传入带环境变量代理凭据的版本。 */
  secretsFor?(config: Config): string[];
  /** 停止旧运行时的总上限，默认 10 秒。 */
  stopTimeoutMs?: number;
}

const STANDBY_HINT = '插件已待命，请在 ST 扩展设置栏的 Silly TG 里填写 Bot Token 和允许的用户 ID 并保存，保存后自动启动，无需重启 ST。';

export class Supervisor<R extends ManagedRuntime> {
  private stateValue: RuntimeState = 'standby';
  private runtime: R | null = null;
  /** starting 时这一轮加载的配置（热字段写进它，运行时启动后用的就是同一个对象）。 */
  private loadingConfig: Config | null = null;
  private standby: { reason: StandbyReason; errors: RuntimeIssue[] } | undefined;
  private loop: Promise<RuntimeStatus> | null = null;
  /** 进行中的启动的取消器。 */
  private startAbort: AbortController | null = null;
  private again = false;
  private closed = false;

  constructor(private readonly opts: SupervisorOptions<R>) {}

  get state(): RuntimeState {
    return this.stateValue;
  }

  /** 当前运行时（测试和桥接用）。 */
  current(): R | null {
    return this.runtime;
  }

  /** running / starting 时的运行时配置；其余状态为 null。 */
  liveConfig(): Config | null {
    if (this.stateValue === 'running') return this.runtime?.config ?? null;
    if (this.stateValue === 'starting') return this.loadingConfig;
    return null;
  }

  /** 重新读盘并重建运行时。并发调用合并，见文件头的契约。 */
  reload(): Promise<RuntimeStatus> {
    if (this.closed) return Promise.resolve(this.status());
    if (this.loop) {
      this.again = true;
      // 正在启动的那份配置已经过时：取消它，结束后马上按最新配置再来一轮
      this.startAbort?.abort();
      return this.loop;
    }
    this.loop = (async () => {
      try {
        do {
          this.again = false;
          await this.cycle();
        } while (this.again && !this.closed);
        return this.status();
      } finally {
        this.loop = null;
      }
    })();
    return this.loop;
  }

  /** 等当前的加载（如果有）结束。测试和配置面板用。 */
  whenSettled(): Promise<RuntimeStatus> {
    return this.loop ?? Promise.resolve(this.status());
  }

  /** ST 退出：不再接受 reload，停掉运行时。 */
  async stop(): Promise<void> {
    this.closed = true;
    this.startAbort?.abort();
    const loop = this.loop;
    if (loop) {
      const t = this.timeout();
      // 正在启动的那一轮结束时会看到 closed 并自行停掉新运行时
      await Promise.race([loop.catch(() => undefined), t.promise]);
      t.clear();
    }
    const rt = this.runtime;
    this.runtime = null;
    if (rt) {
      this.stateValue = 'stopping';
      await this.stopRuntime(rt);
    }
    this.loadingConfig = null;
    this.stateValue = 'standby';
  }

  private secretsOf(c: Config | null | undefined): string[] {
    return c ? (this.opts.secretsFor ?? configSecrets)(c) : [];
  }

  status(): RuntimeStatus {
    const rt = this.runtime;
    const secrets = [...this.secretsOf(rt?.config), ...this.secretsOf(this.loadingConfig)];
    const clean = (s: string): string => redact(s, secrets);
    const chromium = rt ? rt.status.chromium : this.opts.chromium();
    const hello = this.opts.host.hello;
    const out: RuntimeStatus = {
      state: this.stateValue,
      telegram: rt ? rt.status.telegram : this.stateValue === 'starting' ? 'pending' : 'skipped',
      chromium: { found: !!chromium.path, ...(chromium.path ? {} : { hint: chromium.hint }) },
      hostConnected: this.opts.host.connected,
    };
    if (this.stateValue === 'standby' && this.standby) {
      out.standbyReason = this.standby.reason;
      out.errors = this.standby.errors.map((e) => ({ field: e.field, message: clean(e.message) }));
    }
    if (rt?.status.telegramError) out.telegramError = clean(rt.status.telegramError);
    if (rt?.status.botUsername) out.botUsername = rt.status.botUsername;
    // 通道断开后 hello 仍保留着上一次的内容，不当成当前页面
    if (hello && this.opts.host.connected) out.hostPage = { stVersion: hello.stVersion, ...(hello.extVersion ? { extVersion: hello.extVersion } : {}) };
    return out;
  }

  private timeout(): { promise: Promise<'timeout'>; clear: () => void } {
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), this.opts.stopTimeoutMs ?? 10_000);
      timer.unref?.();
    });
    return { promise, clear: () => clearTimeout(timer) };
  }

  /** 停止一个运行时，最多等 stopTimeoutMs；超时记 warn 后继续（宁可晚点回收一个进程，也不让保存请求挂住）。 */
  private async stopRuntime(rt: R): Promise<void> {
    const t = this.timeout();
    const r = await Promise.race([
      rt.stop().then(
        () => 'ok' as const,
        (e: unknown) => {
          this.opts.log.error(`停止运行时出错：${redactError(e, this.secretsOf(rt.config))}`);
          return 'error' as const;
        },
      ),
      t.promise,
    ]);
    t.clear();
    if (r === 'timeout') this.opts.log.warn(`停止旧的运行时超时（${+((this.opts.stopTimeoutMs ?? 10_000) / 1000).toFixed(1)} 秒），不再等待，继续重新加载（遗留的进程会在稍后自行退出）。`);
  }

  private async cycle(): Promise<void> {
    const { log } = this.opts;
    const old = this.runtime;
    if (old) {
      this.stateValue = 'stopping';
      this.runtime = null;
      log.info('正在重新加载：先停止旧的 Telegram 轮询和无头浏览器…');
      await this.stopRuntime(old);
    }
    if (this.closed) {
      this.stateValue = 'standby';
      return;
    }

    const loaded = this.opts.load();
    if (!loaded.ok) {
      this.stateValue = 'standby';
      this.loadingConfig = null;
      if (loaded.missing) {
        this.standby = { reason: 'no-config', errors: [] };
        log.info(STANDBY_HINT);
      } else {
        this.standby = { reason: 'invalid-config', errors: loaded.errors };
        for (const e of loaded.errors) log.error(`配置错误 [${e.field}]：${e.message}`);
        log.error('silly-tg 未启动（SillyTavern 的其余功能不受影响）。在 ST 扩展设置栏的 Silly TG 面板里修正并保存即可，无需重启 ST。');
      }
      return;
    }

    this.stateValue = 'starting';
    this.standby = undefined;
    this.loadingConfig = loaded.config;
    const ac = new AbortController();
    this.startAbort = ac;
    let rt: R;
    try {
      rt = await this.opts.start(loaded.config, loaded.warnings, ac.signal);
    } catch (e) {
      this.startAbort = null;
      if (ac.signal.aborted) {
        // 主动取消（有新的保存或 ST 正在退出），不是故障；下一轮（如果有）会覆盖这里的状态
        this.stateValue = 'standby';
        this.loadingConfig = null;
        this.standby = undefined;
        log.info('已取消这次启动（收到新的配置，或 ST 正在退出）。');
        return;
      }
      const message = redactError(e instanceof Error ? e.message : e, this.secretsOf(loaded.config));
      this.stateValue = 'standby';
      this.loadingConfig = null;
      this.standby = { reason: 'start-failed', errors: [{ field: '(runtime)', message }] };
      log.error(`silly-tg 启动失败：${message}。修正后在面板里再保存一次即可重试。`);
      return;
    }
    this.startAbort = null;
    this.loadingConfig = null;
    if (this.closed) {
      // 启动过程中 ST 要退出了：立刻停掉，不留下运行时
      this.stateValue = 'stopping';
      await this.stopRuntime(rt);
      this.stateValue = 'standby';
      return;
    }
    this.runtime = rt;
    this.stateValue = 'running';
  }
}
