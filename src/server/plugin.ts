import { join } from 'node:path';
import type { Router } from 'express';
import type { SelfCheckItem } from '../shared/protocol';
import { VERSION, versionMismatchWarning } from '../shared/version';
import { isAllowedUpdate } from './access';
import { findChromium, type ChromiumLookup } from './chromium-path';
import { configSecrets, loadConfigFile, type Config } from './config';
import { deployExtension, type DeployResult } from './deploy-extension';
import { HostChannel } from './host-channel';
import { createFetch, describeProxy, resolveProxy, type FetchLike } from './http';
import { createLogger, type Logger } from './logger';
import { redactError } from './redact';
import { assignHotFields, registerSettingsRoutes } from './settings-api';
import { pollUpdates, TelegramApiError, TelegramClient, type TelegramUpdate } from './telegram';

/** 启动自检的汇总，供 /status 展示（bot 命令在后续步骤接入）。 */
export interface PluginStatus {
  telegram: 'ok' | 'skipped' | 'error';
  botUsername?: string;
  chromium: ChromiumLookup;
  /** Telegram 代理的来源和可读描述（不含账号密码），启动时记录一次。 */
  proxy: { source: 'config' | 'env' | 'none'; description: string };
  extension: DeployResult;
  /** 扩展上报的页面自检（CSRF、Mvu 等）。 */
  hostChecks: SelfCheckItem[];
  /** 最近一次页面错误。 */
  lastHostError?: string;
}

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
  /** 注册退出钩子（关闭 Chromium 等）。stop 时按注册的相反顺序执行，单个失败不影响其他。 */
  onShutdown(fn: () => Promise<void> | void): void;
  /** 收到白名单用户的 update 时的处理器，bot 模块接入时设置。 */
  setUpdateHandler(fn: (update: TelegramUpdate) => Promise<void> | void): void;
  stop(): Promise<void>;
}

export interface StartOptions {
  router: Router;
  /** 插件根目录（含 dist/ 和 config.json）。 */
  pluginDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  log?: Logger;
  /** 服务端版本，默认取构建时注入的版本。仅测试用。 */
  version?: string;
}

/** 连接 Telegram 失败时，按代理来源给出下一步建议。 */
function proxyFailureHint(proxy: ReturnType<typeof resolveProxy>): string {
  if (proxy.source === 'config') return '已配置 telegramProxy，检查代理是否可用。';
  if (proxy.source === 'env') return `正在使用环境变量 ${proxy.envName} 里的代理，检查代理是否可用；不想走代理就取消这个环境变量，或在 config.json 里设置 telegramProxy 覆盖它。`;
  return '如果你所在网络访问不了 Telegram，在 config.json 里配置 telegramProxy（或设置环境变量 HTTPS_PROXY）。';
}

/**
 * 插件启动。配置有问题时记录可操作的提示并返回 null，不抛错，ST 的其余部分不受影响。
 * 环境变量（仅用于联调和测试）：
 *   SILLY_TG_CONFIG   配置文件路径，默认 <pluginDir>/config.json
 *   SILLY_TG_OFFLINE  为 1 时不访问 Telegram（不 getMe、不轮询）
 *   SILLY_TG_DATA_DIR 数据目录，默认 <pluginDir>/data
 */
export async function startPlugin(opts: StartOptions): Promise<PluginRuntime | null> {
  const env = opts.env ?? process.env;
  const bootLog = opts.log ?? createLogger();
  const configPath = env.SILLY_TG_CONFIG || join(opts.pluginDir, 'config.json');

  const loaded = loadConfigFile(configPath);
  // 配置面板的接口在配置有误或还没有配置文件时也要可用，否则没法用面板修好它。
  const liveConfig: Config | null = loaded.ok ? loaded.config : null;
  let runtimeLog: Logger = bootLog;
  registerSettingsRoutes(opts.router, {
    configPath,
    log: bootLog,
    live: () => liveConfig,
    startErrors: () => (loaded.ok ? [] : loaded.errors),
    secrets: () => (liveConfig ? configSecrets(liveConfig) : []),
    applyHot: (c) => {
      if (!liveConfig) return;
      // 只更新热生效字段；其余字段要重启才生效，运行中的值保持不变
      assignHotFields(liveConfig, c);
      runtimeLog.setLevel?.(c.logLevel);
    },
  });
  if (!loaded.ok) {
    for (const e of loaded.errors) bootLog.error(`配置错误 [${e.field}]：${e.message}`);
    bootLog.error('silly-tg 未启动（SillyTavern 的其余功能不受影响）。修正配置后重启 ST。');
    return null;
  }
  const config = loaded.config;
  // 环境变量里的代理地址也可能带账号密码，一并从日志中隐去
  const secrets = configSecrets(config, env);
  const log = opts.log ?? createLogger({ level: config.logLevel, secrets });
  runtimeLog = log;
  for (const w of loaded.warnings) log.warn(`配置提示 [${w.field}]：${w.message}`);

  // Telegram 代理：config.json 的 telegramProxy 优先，其次环境变量（HTTPS_PROXY 等）
  const proxy = resolveProxy(config.telegramProxy, env);
  if (proxy.source !== 'none') log.info(`Telegram 代理：${describeProxy(proxy)}${proxy.noProxy ? `，NO_PROXY=${proxy.noProxy}` : ''}`);
  else if (proxy.ignored) log.warn(`环境变量里的代理 ${proxy.ignored} 协议不受支持（只支持 http/https），已忽略，将直连 Telegram。代理软件如果有 HTTP（混合）端口，请改用那个端口。`);

  const channel = new HostChannel({ log });
  channel.register(opts.router);

  const shutdownHooks: Array<() => Promise<void> | void> = [];
  let updateHandler: (u: TelegramUpdate) => Promise<void> | void = (u) => log.debug(`收到 update ${u.update_id}（bot 逻辑尚未接入）`);

  const status: PluginStatus = {
    telegram: 'skipped',
    chromium: findChromium(config.chromiumPath),
    proxy: { source: proxy.source, description: describeProxy(proxy) },
    extension: await deployExtension({ pluginDir: opts.pluginDir }),
    hostChecks: [],
  };

  // 扩展部署
  if (status.extension.ok) {
    log.info(status.extension.message ?? `UI 扩展已部署到 ${status.extension.target}`);
    if (status.extension.warning) log.warn(status.extension.warning);
  } else {
    log.warn(`UI 扩展未能部署：${status.extension.reason ?? ''}`);
    if (status.extension.manual) log.warn(status.extension.manual);
  }

  // Chromium
  if (status.chromium.warning) log.warn(status.chromium.warning);
  if (status.chromium.path) log.info(`使用 Chromium：${status.chromium.path}`);
  else log.warn(`没有找到 Chrome/Chromium，无头浏览器无法启动。${status.chromium.hint ?? ''}`);

  // 页面自检与错误
  channel.onEvent((e) => {
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

  // Telegram
  const telegram = new TelegramClient({
    token: config.botToken,
    fetch: opts.fetch ?? createFetch(proxy),
    log,
    secrets,
    apiRoot: config.telegramApiBase,
  });
  const abort = new AbortController();
  let polling: Promise<unknown> = Promise.resolve();
  if (env.SILLY_TG_OFFLINE === '1') {
    log.warn('SILLY_TG_OFFLINE=1：不连接 Telegram（仅联调用）。');
  } else {
    try {
      const me = await telegram.getMe();
      status.telegram = 'ok';
      status.botUsername = me.username;
      log.info(`Telegram 已连接，bot：@${me.username ?? me.id}`);
    } catch (e) {
      status.telegram = 'error';
      // Telegram 已经回应（带错误码）说明网络和代理是通的，不要再让用户去查代理。
      const hint =
        e instanceof TelegramApiError
          ? e.errorCode === 401
            ? 'Telegram 已响应，网络和代理没问题，是 botToken 被拒绝，检查 config.json 里的 botToken。'
            : ''
          : proxyFailureHint(proxy);
      log.error(`连接 Telegram 失败：${(e as Error).message}。${hint}将继续在后台重试。`);
    }
    polling = pollUpdates({
      client: telegram,
      signal: abort.signal,
      log,
      allowedUpdates: ['message', 'edited_message', 'callback_query', 'stopped_message_generation'],
      onUpdate: (u) => {
        if (!isAllowedUpdate(u, config.allowedUserIds)) {
          log.debug(`忽略非白名单 update ${u.update_id}`);
          return;
        }
        return updateHandler(u);
      },
    }).catch((e) => log.error(`轮询异常退出：${redactError(e, secrets)}`));
  }

  let stopped: Promise<void> | undefined;
  return {
    config,
    configPath,
    dataDir: env.SILLY_TG_DATA_DIR || join(opts.pluginDir, 'data'),
    log,
    channel,
    telegram,
    status,
    onShutdown: (fn) => void shutdownHooks.push(fn),
    setUpdateHandler: (fn) => void (updateHandler = fn),
    stop: () =>
      (stopped ??= (async () => {
        abort.abort();
        channel.close();
        for (const fn of shutdownHooks.reverse()) {
          try {
            await fn();
          } catch (e) {
            log.error(`退出钩子出错：${redactError(e, secrets)}`);
          }
        }
        // 轮询在 abort 后会很快返回；给个上限，避免卡住 ST 退出。
        await Promise.race([polling, new Promise((r) => setTimeout(r, 3000).unref())]);
      })()),
  };
}
