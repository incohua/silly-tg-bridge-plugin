// 插件的两层结构：
//   外壳（bootPlugin，ST 生命周期内只建一次）：设置面板路由、host 通道路由、部署 UI 扩展、运行时监管。
//     Express 的路由注册后不能卸载，所以通道对象跨重新加载存活（每次启动 Chromium 会换 nonce）。
//   运行时（startRuntime，每次重新加载都重建）：Telegram 客户端与轮询、无头浏览器、看门狗、bot、消息映射。
// 没有 config.json 或配置有误时外壳照常工作（面板可用、扩展已部署），运行时处于待命；
// 面板保存后由 Supervisor 停掉旧运行时、用新配置拉起，无需重启 ST。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Router } from 'express';
import type { SelfCheckItem } from '../shared/protocol';
import { VERSION, versionMismatchWarning } from '../shared/version';
import { isAllowedUpdate } from './access';
import { attachBridge, type Bridge } from './bridge';
import type { Launcher } from './browser';
import { findChromium, type ChromiumLookup } from './chromium-path';
import { configSecrets, loadConfigFile, type Config, type ConfigIssue } from './config';
import { deployExtension, type DeployResult } from './deploy-extension';
import { HostChannel } from './host-channel';
import { createFetch, describeProxy, resolveProxy, type FetchLike } from './http';
import { createLogger, switchableLogger, type Logger, type SwitchableLogger } from './logger';
import { redactError } from './redact';
import { assignHotFields, registerSettingsRoutes } from './settings-api';
import { Supervisor, type LoadResult } from './supervisor';
import { pollUpdates, TelegramApiError, TelegramClient, type TelegramUpdate } from './telegram';

/** 启动自检的汇总，供 /status 展示。 */
export interface PluginStatus {
  telegram: 'ok' | 'skipped' | 'error';
  botUsername?: string;
  /** 连接 Telegram 失败的原因和建议（已脱敏），配置面板展示。 */
  telegramError?: string;
  chromium: ChromiumLookup;
  /** Telegram 代理的来源和可读描述（不含账号密码），启动时记录一次。 */
  proxy: { source: 'config' | 'env' | 'none'; description: string };
  extension: DeployResult;
  /** 扩展上报的页面自检（CSRF、Mvu 等）。 */
  hostChecks: SelfCheckItem[];
  /** 最近一次页面错误。 */
  lastHostError?: string;
}

/** 一次加载出来的运行时。stop 后不可复用，重新加载会新建一个。 */
export interface PluginRuntime {
  config: Config;
  /** 配置文件路径（choice-rules.json 与它同目录）。 */
  configPath: string;
  /** 插件数据目录（state.json 等）。默认 <pluginDir>/data，可用环境变量 SILLY_TG_DATA_DIR 覆盖。 */
  dataDir: string;
  log: Logger;
  channel: HostChannel;
  telegram: TelegramClient;
  status: PluginStatus;
  /** 无头浏览器、bot 等（startRuntime 接上）。 */
  bridge?: Bridge;
  /** 注册退出钩子（关闭 Chromium 等）。stop 时按注册的相反顺序执行，单个失败不影响其他。 */
  onShutdown(fn: () => Promise<void> | void): void;
  /** 收到白名单用户的 update 时的处理器，bot 接入时设置。 */
  setUpdateHandler(fn: (update: TelegramUpdate) => Promise<void> | void): void;
  stop(): Promise<void>;
}

export interface BootOptions {
  router: Router;
  /** 插件根目录（含 dist/ 和 config.json）。 */
  pluginDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  log?: Logger;
  /** 服务端版本，默认取构建时注入的版本。仅测试用。 */
  version?: string;
  /** 以下仅测试用：Chromium 启动器、查找、扩展部署、超时。 */
  launcher?: Launcher;
  findChromium?: (configured?: string) => ChromiumLookup;
  deploy?: (opts: { pluginDir: string }) => Promise<DeployResult>;
  stopTimeoutMs?: number;
  reloadWaitMs?: number;
}

/** 插件外壳：ST 生命周期内唯一。 */
export interface PluginShell {
  configPath: string;
  dataDir: string;
  log: Logger;
  channel: HostChannel;
  extension: DeployResult;
  supervisor: Supervisor<PluginRuntime>;
  /** ST 退出：停掉运行时并关闭通道。 */
  stop(): Promise<void>;
}

/** 连接 Telegram 失败时，按代理来源给出下一步建议。 */
function proxyFailureHint(proxy: ReturnType<typeof resolveProxy>): string {
  if (proxy.source === 'config') return '已配置 telegramProxy，检查代理是否可用。';
  if (proxy.source === 'env') return `正在使用环境变量 ${proxy.envName} 里的代理，检查代理是否可用；不想走代理就取消这个环境变量，或在 config.json 里设置 telegramProxy 覆盖它。`;
  return '如果你所在网络访问不了 Telegram，在 config.json 里配置 telegramProxy（或设置环境变量 HTTPS_PROXY）。';
}

/**
 * 插件外壳启动。注册路由、部署扩展后立即返回；运行时在后台加载（不拖慢 ST 启动），
 * 测试用 shell.supervisor.whenSettled() 等它。配置缺失或有误不会抛错，只记日志并进入待命。
 * 环境变量（仅用于联调和测试）：
 *   SILLY_TG_CONFIG   配置文件路径，默认 <pluginDir>/config.json
 *   SILLY_TG_OFFLINE  为 1 时不访问 Telegram（不 getMe、不轮询、不注册命令菜单）
 *   SILLY_TG_DATA_DIR 数据目录，默认 <pluginDir>/data
 *   SILLY_TG_TEST_SKIP_CSRF_PATCH 为 1 时页面不安装 CSRF 补丁
 */
export async function bootPlugin(opts: BootOptions): Promise<PluginShell> {
  const env = opts.env ?? process.env;
  const log = switchableLogger(opts.log ?? createLogger());
  const configPath = env.SILLY_TG_CONFIG || join(opts.pluginDir, 'config.json');
  const dataDir = env.SILLY_TG_DATA_DIR || join(opts.pluginDir, 'data');
  const lookupChromium = opts.findChromium ?? findChromium;
  // 待命时面板显示的 Chromium 查找结果；每次加载运行时按配置里的 chromiumPath 重新查
  let chromium = lookupChromium();

  // 扩展部署结果在下面赋值；运行时启动时才读取
  let extension: DeployResult = { ok: false, reason: '尚未部署' };
  const channel = new HostChannel({ log });

  const load = (): LoadResult => {
    const r = loadConfigFile(configPath);
    if (r.ok) return { ok: true, config: r.config, warnings: r.warnings };
    return { ok: false, missing: !existsSync(configPath), errors: r.errors };
  };
  const supervisor = new Supervisor<PluginRuntime>({
    log,
    host: channel,
    chromium: () => chromium,
    secretsFor: (c) => configSecrets(c, env),
    load,
    start: (config, warnings, signal) => {
      chromium = lookupChromium(config.chromiumPath);
      return startRuntime({ opts, env, configPath, dataDir, channel, extension, chromium, shellLog: log }, config, warnings, signal);
    },
    stopTimeoutMs: opts.stopTimeoutMs,
  });

  // 配置面板的接口在配置有误或还没有配置文件时也要可用，否则没法用面板修好它。
  registerSettingsRoutes(opts.router, {
    configPath,
    log,
    live: () => supervisor.liveConfig(),
    runtime: { status: () => supervisor.status(), reload: () => supervisor.reload() },
    secrets: () => {
      const c = supervisor.liveConfig();
      return c ? configSecrets(c, env) : [];
    },
    applyHot: (c) => {
      const live = supervisor.liveConfig();
      if (!live) return;
      // 只更新热生效字段；连接类字段由重新加载生效
      assignHotFields(live, c);
      log.setLevel?.(c.logLevel);
    },
    reloadWaitMs: opts.reloadWaitMs,
  });
  channel.register(opts.router);

  // 扩展部署与配置无关：先 clone 插件、还没有配置的用户刷新页面就能看到面板
  extension = await (opts.deploy ?? deployExtension)({ pluginDir: opts.pluginDir });
  if (extension.ok) {
    log.info(extension.message ?? `UI 扩展已部署到 ${extension.target}`);
    if (extension.warning) log.warn(extension.warning);
  } else {
    log.warn(`UI 扩展未能部署：${extension.reason ?? ''}`);
    if (extension.manual) log.warn(extension.manual);
  }

  void supervisor.reload();

  return {
    configPath,
    dataDir,
    log,
    channel,
    extension,
    supervisor,
    stop: async () => {
      await supervisor.stop();
      channel.close();
    },
  };
}

interface RuntimeContext {
  opts: BootOptions;
  env: NodeJS.ProcessEnv;
  configPath: string;
  dataDir: string;
  channel: HostChannel;
  extension: DeployResult;
  chromium: ChromiumLookup;
  shellLog: SwitchableLogger;
}

/**
 * 用一份已校验的配置拉起运行时：Telegram（getMe + 轮询）与无头浏览器、bot。失败时自己清理后抛出。
 * signal 触发（有新的保存或 ST 退出）时中止 getMe，不再拉起浏览器和轮询，清理后抛出。
 */
async function startRuntime(ctx: RuntimeContext, config: Config, warnings: ConfigIssue[], signal?: AbortSignal): Promise<PluginRuntime> {
  const { opts, env, channel } = ctx;
  // 环境变量里的代理地址也可能带账号密码，一并从日志中隐去
  const secrets = configSecrets(config, env);
  const log = opts.log ?? createLogger({ level: config.logLevel, secrets });
  ctx.shellLog.use(log);
  for (const w of warnings) log.warn(`配置提示 [${w.field}]：${w.message}`);

  // Telegram 代理：config.json 的 telegramProxy 优先，其次环境变量（HTTPS_PROXY 等）
  const proxy = resolveProxy(config.telegramProxy, env);
  if (proxy.source !== 'none') log.info(`Telegram 代理：${describeProxy(proxy)}${proxy.noProxy ? `，NO_PROXY=${proxy.noProxy}` : ''}`);
  else if (proxy.ignored) log.warn(`环境变量里的代理 ${proxy.ignored} 协议不受支持（只支持 http/https），已忽略，将直连 Telegram。代理软件如果有 HTTP（混合）端口，请改用那个端口。`);

  const status: PluginStatus = {
    telegram: 'skipped',
    chromium: ctx.chromium,
    proxy: { source: proxy.source, description: describeProxy(proxy) },
    extension: ctx.extension,
    hostChecks: [],
  };

  // Chromium
  if (status.chromium.warning) log.warn(status.chromium.warning);
  if (status.chromium.path) log.info(`使用 Chromium：${status.chromium.path}`);
  else log.warn(`没有找到 Chrome/Chromium，无头浏览器无法启动。${status.chromium.hint ?? ''}`);

  // 页面自检与错误。通道跨重新加载存活，所以订阅要在 stop 时退掉。
  const offEvent = channel.onEvent((e) => {
    if (e.type === 'hello') {
      // 只警告，不拒绝连接；旧版 UI 不带版本字段，不提示。
      const warning = versionMismatchWarning(opts.version ?? VERSION, e.extVersion);
      if (warning) log.warn(warning);
    } else if (e.type === 'selfCheck') {
      status.hostChecks = e.items;
      // CSRF 失败会导致提示词为空，记为错误；其余（MVU、酒馆助手、API）记为警告。
      for (const item of e.items) (item.ok ? log.info : item.name === 'csrf' ? log.error : log.warn)(`页面自检 ${item.name}：${item.ok ? '通过' : '失败'}${item.detail ? `（${item.detail}）` : ''}`);
    } else if (e.type === 'hostLog') {
      (e.level === 'warn' ? log.warn : log.info)(`页面：${e.message}`);
    } else if (e.type === 'hostError') {
      status.lastHostError = e.message;
      log.warn(`页面错误：${e.message}`);
    }
  });

  // 外部传入的 fetch 由外部负责；自己创建的（可能带代理 dispatcher）在 stop 时关掉
  const ownFetch = opts.fetch ? undefined : createFetch(proxy);
  const telegram = new TelegramClient({
    token: config.botToken,
    fetch: opts.fetch ?? ownFetch!,
    log,
    secrets,
    apiRoot: config.telegramApiBase,
  });
  const abort = new AbortController();
  let polling: Promise<unknown> = Promise.resolve();
  const shutdownHooks: Array<() => Promise<void> | void> = [];
  let updateHandler: (u: TelegramUpdate) => Promise<void> | void = (u) => log.debug(`收到 update ${u.update_id}（bot 逻辑尚未接入）`);
  let stopped: Promise<void> | undefined;

  const rt: PluginRuntime = {
    config,
    configPath: ctx.configPath,
    dataDir: ctx.dataDir,
    log,
    channel,
    telegram,
    status,
    onShutdown: (fn) => void shutdownHooks.push(fn),
    setUpdateHandler: (fn) => void (updateHandler = fn),
    stop: () =>
      (stopped ??= (async () => {
        abort.abort();
        offEvent();
        channel.close();
        for (const fn of shutdownHooks.reverse()) {
          try {
            await fn();
          } catch (e) {
            log.error(`退出钩子出错：${redactError(e, secrets)}`);
          }
        }
        // 轮询在 abort 后会很快返回；给个上限，避免卡住 ST 退出或重新加载。
        await Promise.race([polling, new Promise((r) => setTimeout(r, 3000).unref())]);
        // 轮询结束后再关代理连接池；每次重载都会新建一个，不关会一直攒着
        try {
          await ownFetch?.close?.();
        } catch (e) {
          log.debug(`关闭代理连接池出错：${redactError(e, secrets)}`);
        }
      })()),
  };

  try {
    const offline = env.SILLY_TG_OFFLINE === '1';
    if (offline) {
      log.warn('SILLY_TG_OFFLINE=1：不连接 Telegram（仅联调用）。');
    } else {
      try {
        const me = await telegram.getMe(signal);
        status.telegram = 'ok';
        status.botUsername = me.username;
        log.info(`Telegram 已连接，bot：@${me.username ?? me.id}`);
      } catch (e) {
        // 被取消（有新的保存或 ST 退出）：Supervisor 只记一行 info，不展示这里的原因
        if (signal?.aborted) throw new Error('启动已取消', { cause: e });
        status.telegram = 'error';
        // Telegram 已经回应（带错误码）说明网络和代理是通的，不要再让用户去查代理。
        const hint =
          e instanceof TelegramApiError
            ? e.errorCode === 401
              ? 'Telegram 已响应，网络和代理没问题，是 botToken 被拒绝，检查面板（或 config.json）里的 botToken。'
              : ''
            : proxyFailureHint(proxy);
        const message = redactError((e as Error).message, secrets);
        status.telegramError = `${message}。${hint}`;
        // 401 表示 token 被拒绝，轮询会停止，不能说“继续重试”
        const rejected = e instanceof TelegramApiError && e.errorCode === 401;
        log.error(`连接 Telegram 失败：${message}。${hint}${rejected ? '' : '将继续在后台重试。'}`);
      }
    }

    if (signal?.aborted) throw new Error('启动已取消');
    rt.bridge = attachBridge(rt, { launcher: opts.launcher, env });

    if (!offline) {
      // 重启后从上次处理到的位置继续，避免已经转给 ST 的消息被 Telegram 再投递一遍。按 bot 区分，换 token 不沿用
      const store = rt.bridge?.store;
      const botId = config.botToken.split(':')[0];
      const last = store?.lastUpdateId(botId);
      polling = pollUpdates({
        client: telegram,
        signal: abort.signal,
        log,
        initialOffset: last === undefined ? undefined : last + 1,
        onProcessed: (id) => store?.setLastUpdateId(botId, id),
        allowedUpdates: ['message', 'edited_message', 'callback_query', 'stopped_message_generation'],
        onUpdate: (u) => {
          // 每次实时读 allowedUserIds：面板保存后热生效
          if (!isAllowedUpdate(u, config.allowedUserIds)) {
            log.debug(`忽略非白名单 update ${u.update_id}`);
            return;
          }
          return updateHandler(u);
        },
      })
        .then((reason) => {
          if (reason === 'unauthorized') {
            status.telegram = 'error';
            status.telegramError = 'Telegram 拒绝了 botToken（401），轮询已停止。在面板里填写正确的 botToken 并保存即可恢复。';
          }
        })
        .catch((e) => log.error(`轮询异常退出：${redactError(e, secrets)}`));
    }
  } catch (e) {
    await rt.stop();
    throw e;
  }
  return rt;
}
