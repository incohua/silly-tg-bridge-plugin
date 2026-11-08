// 把无头浏览器、bot、看门狗和消息映射接到插件运行时上。
// 与 startPlugin 分开，单元测试启动插件时不会真的拉起 Chromium。
import { dirname, join } from 'node:path';
import { Bot, BOT_COMMANDS } from './bot';
import { ChoiceRuleStore } from './choices';
import { BrowserManager, type Launcher } from './browser';
import { BridgeStore } from './message-map';
import type { PluginRuntime } from './plugin';
import { puppeteerLauncher } from './puppeteer-launcher';
import { Watchdog } from './watchdog';

export interface Bridge {
  bot: Bot;
  browser: BrowserManager;
  watchdog: Watchdog;
  store: BridgeStore;
}

export function attachBridge(rt: PluginRuntime, opts: { launcher?: Launcher } = {}): Bridge {
  const { config, log, channel, telegram, status } = rt;
  const browser = new BrowserManager({
    log,
    host: channel,
    launcher: opts.launcher ?? puppeteerLauncher,
    executablePath: status.chromium.path,
    missingHint: status.chromium.hint,
    stBaseUrl: config.stBaseUrl,
    basicAuth: config.basicAuth,
    // 配置面板保存后热生效，所以用 getter 每次读最新值
    get lowMemory() {
      return config.lowMemory;
    },
    get idleShutdownMs() {
      return config.idleShutdownMinutes * 60_000;
    },
    testSkipCsrfPatch: process.env.SILLY_TG_TEST_SKIP_CSRF_PATCH === '1',
  });
  if (process.env.SILLY_TG_TEST_SKIP_CSRF_PATCH === '1') log.warn('SILLY_TG_TEST_SKIP_CSRF_PATCH=1：页面不安装 CSRF 补丁（仅用于测试）。');
  const store = new BridgeStore(join(rt.dataDir, 'state.json'), log);
  const notify = async (text: string): Promise<void> => {
    // 白名单里的都是私聊用户 id，私聊的 chat_id 就是用户 id
    for (const id of config.allowedUserIds) {
      await telegram.sendMessage({ chat_id: id, text }).catch((e) => log.warn(`通知用户失败：${(e as Error).message}`));
    }
  };
  const watchdog = new Watchdog({ browser, host: channel, log, notify });
  const choiceRules = new ChoiceRuleStore(join(dirname(rt.configPath), 'choice-rules.json'), log);
  const bot = new Bot({
    telegram,
    host: channel,
    browser,
    store,
    status,
    log,
    get idleShutdownMinutes() {
      return config.idleShutdownMinutes;
    },
    get dialogueStyle() {
      return config.dialogueStyle;
    },
    watchdogStatus: () => watchdog.status(),
    choiceRules: () => choiceRules.get(),
  });
  rt.setUpdateHandler((u) => bot.handleUpdate(u));
  // 命令菜单：输入 / 时可选。失败只记警告，不影响使用。
  if (process.env.SILLY_TG_OFFLINE !== '1') {
    telegram.setMyCommands([...BOT_COMMANDS]).catch((e) => log.warn(`注册命令菜单失败（不影响使用）：${(e as Error).message}`));
  }
  // 退出钩子按注册的相反顺序执行：先停看门狗（避免把正在关闭的浏览器当成故障），再关浏览器。
  rt.onShutdown(() => browser.dispose());
  rt.onShutdown(() => watchdog.dispose());

  // 启动后在后台打开 host 页面（ST 此时可能还没开始监听，BrowserManager 会等它）。
  // 失败只记日志：收到消息时会再试一次。
  if (status.chromium.path) {
    void browser.ensureRunning().catch(() => {});
  }
  return { bot, browser, watchdog, store };
}
