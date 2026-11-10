// 把无头浏览器、bot、看门狗和消息映射接到插件运行时上（plugin.ts 的 startRuntime 调用）。
// 运行时重新加载时整套重建；BridgeStore 每次修改都同步落盘，新运行时读到的 state.json 是最新的。
import { dirname, join } from 'node:path';
import { Bot, BOT_COMMANDS } from './bot';
import { HeapGuard } from './heap-guard';
import { ChoiceRuleStore } from './choices';
import { BrowserManager, type Launcher } from './browser';
import { BridgeStore } from './message-map';
import type { PluginRuntime } from './plugin';
import { puppeteerLauncher } from './puppeteer-launcher';
import { saveSettingsPatch } from './settings-api';
import { Watchdog } from './watchdog';

export interface Bridge {
  bot: Bot;
  browser: BrowserManager;
  watchdog: Watchdog;
  heapGuard: HeapGuard;
  store: BridgeStore;
}

export function attachBridge(rt: PluginRuntime, opts: { launcher?: Launcher; env?: NodeJS.ProcessEnv } = {}): Bridge {
  const { config, log, channel, telegram, status } = rt;
  const env = opts.env ?? process.env;
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
    get pageHeapLimitMB() {
      return config.pageHeapLimitMB;
    },
    get idleShutdownMs() {
      return config.idleShutdownMinutes * 60_000;
    },
    testSkipCsrfPatch: env.SILLY_TG_TEST_SKIP_CSRF_PATCH === '1',
  });
  if (env.SILLY_TG_TEST_SKIP_CSRF_PATCH === '1') log.warn('SILLY_TG_TEST_SKIP_CSRF_PATCH=1：页面不安装 CSRF 补丁（仅用于测试）。');
  const store = new BridgeStore(join(rt.dataDir, 'state.json'), log);
  const notify = async (text: string): Promise<void> => {
    // 白名单里的都是私聊用户 id，私聊的 chat_id 就是用户 id。每次实时读：面板保存后热生效
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
    get draftIntervalMs() {
      return Math.round(config.draftIntervalSeconds * 1000);
    },
    get draftMode() {
      return config.draftMode;
    },
    get choiceLayout() {
      return config.choiceLayout;
    },
    settings: {
      get: () => ({
        dialogueStyle: config.dialogueStyle,
        draftMode: config.draftMode,
        draftIntervalSeconds: config.draftIntervalSeconds,
        choiceLayout: config.choiceLayout,
      }),
      set: (patch) => saveSettingsPatch(rt.configPath, config, patch),
    },
    watchdogStatus: () => watchdog.status(),
    heapStatus: () => heapGuard.status(),
    choiceRules: () => choiceRules.get(),
  });
  // 页面 JS 堆接近低内存模式的上限时，空闲时重载页面（见 heap-guard.ts）。上限按当前这个 Chromium 启动时的参数判断
  const heapGuard: HeapGuard = new HeapGuard({
    sample: () => browser.sampleHeapUsed(),
    limitMB: () => browser.heapLimitMB,
    isIdle: () => !bot.busy,
    recycle: () => bot.recyclePage(),
    log,
  });
  rt.setUpdateHandler((u) => bot.handleUpdate(u));
  // 命令菜单：输入 / 时可选。失败只记警告，不影响使用。
  if (env.SILLY_TG_OFFLINE !== '1') {
    telegram.setMyCommands([...BOT_COMMANDS]).catch((e) => log.warn(`注册命令菜单失败（不影响使用）：${(e as Error).message}`));
  }
  // 退出钩子按注册的相反顺序执行：先结束进行中的一轮，再停看门狗（避免把正在关闭的浏览器当成故障），最后关浏览器。
  rt.onShutdown(() => browser.dispose());
  rt.onShutdown(() => watchdog.dispose());
  // 最先执行：进行中的一轮立即收尾，不等页面（页面马上要关了）
  rt.onShutdown(() => bot.dispose());
  // 同样最先执行：停止过程中不能再触发回收
  rt.onShutdown(() => heapGuard.dispose());

  // 启动后在后台打开 host 页面（ST 此时可能还没开始监听，BrowserManager 会等它）。
  // 失败只记日志：收到消息时会再试一次。
  if (status.chromium.path) {
    void browser.ensureRunning().catch(() => {});
  }
  return { bot, browser, watchdog, heapGuard, store };
}
