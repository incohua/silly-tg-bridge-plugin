// UI 扩展入口。只在 host 模式工作：URL 的 hash 带 #silly_tg_host=<nonce>，且服务端接受了 hello。
// 用户另开的普通 ST 页面里，这个文件只在“扩展”设置栏渲染配置抽屉（settings-ui.ts，打开页面时读一次配置），
// 不注册消息监听，不连接 host 通道，也不处理命令。

import { decodeHostCommand, type HostCommand, type HostEvent, type SelfCheckItem } from '../shared/protocol';
import { VERSION } from '../shared/version';
import { ctx, detectApp, getHostApi, isKnownNoise, waitAppReady } from './adapter';
import { hostStatus, listCharacters, listChats, listPresets, newChat, openChat, selectCharacter, selectPreset } from './commands';
import { ensureApiConnected } from './api-connect';
import { applyCsrfPatchAndCheck } from './csrf';
import { startDialogWatcher } from './dialog-watcher';
import { captureToasts, runGeneration, type GenerationRequest } from './generation';
import { parseHostNonce, parseHostTestFlags } from './host-mode';
import { SerialQueue } from './queue';
import { restoreActiveCharacter } from './restore';
import { mountSettings } from './settings-ui';
import { claimSingleton, duplicateMessage } from './singleton';
import { PLUGIN_BASE, Uplink } from './uplink';

const HEARTBEAT_MS = 15_000;
const READY_TIMEOUT_MS = 180_000;
const LOG = '[silly-tg]';

async function stVersion(): Promise<string> {
  try {
    const r = await fetch('/version');
    const j = (await r.json()) as { pkgVersion?: string; agent?: string };
    return `${detectApp()} ${j.pkgVersion ?? j.agent ?? 'unknown'}`;
  } catch {
    return `${detectApp()} unknown`;
  }
}

function tavernHelperCheck(): SelfCheckItem {
  const ok = typeof (globalThis as Record<string, unknown>).TavernHelper === 'object';
  return ok
    ? { name: 'tavernHelper', ok: true }
    : { name: 'tavernHelper', ok: false, detail: '未检测到酒馆助手（JS-Slash-Runner）。前端卡片和变量功能不可用，纯文字对话不受影响。' };
}

function mvuCheck(): SelfCheckItem {
  const ok = typeof (globalThis as Record<string, unknown>).Mvu !== 'undefined';
  return ok
    ? { name: 'mvu', ok: true }
    : {
        name: 'mvu',
        ok: false,
        detail: '当前角色没有加载 MVU。如果这张卡依赖 MVU 变量，需要在酒馆助手里启用角色脚本；不用 MVU 的卡可以忽略。',
      };
}

async function main(): Promise<void> {
  // 扩展加载时立刻读取：ST 之后可能改写 hash。
  const nonce = parseHostNonce(location.hash);
  const testFlags = parseHostTestFlags(location.hash);
  if (!getHostApi()) return;
  // 普通页面：只在“扩展”设置栏里渲染配置抽屉，不注册任何监听、不连接服务端通道。
  if (!nonce) {
    mountSettings();
    return;
  }

  let alive = true;
  const cleanups: Array<() => void> = [];
  const shutdown = (reason: string): void => {
    if (!alive) return;
    alive = false;
    for (const fn of cleanups.splice(0)) fn();
    console.warn(`${LOG} host 模式已停止：${reason}`);
  };
  const uplink = new Uplink(nonce, () => shutdown('服务端拒绝了 nonce（页面已过期）'));
  const report = (e: HostEvent): void => void uplink.send(e);
  const queue = new SerialQueue();

  // 1. 弹窗监视最先启动：首次启动欢迎弹窗会挡住 firstLoadInit，APP_READY 要等它关掉才会发生。
  const lastDialog = { text: '', at: 0 };
  cleanups.push(
    startDialogWatcher({
      onDismiss: (d) => {
        if (d.text === lastDialog.text && Date.now() - lastDialog.at < 30_000) return;
        lastDialog.text = d.text;
        lastDialog.at = Date.now();
        report({ type: 'hostLog', level: 'info', message: `已自动关闭弹窗（${d.button}）：${d.text}` });
      },
    }),
  );
  captureToasts();

  // 2. 等前端就绪
  if ((await waitAppReady(READY_TIMEOUT_MS)) === 'timeout') {
    report({ type: 'hostLog', level: 'warn', message: `等待 APP_READY 超过 ${READY_TIMEOUT_MS / 1000} 秒，继续初始化` });
  }
  if (!alive) return;

  // 3. CSRF 补丁和自检（在 hello 之前，保证之后的生成请求都带上头）
  const csrf = await applyCsrfPatchAndCheck({ skipPatch: testFlags.skipCsrfPatch });

  // 3b. 恢复最近使用的角色（ST 默认不自动加载上次聊天，无头页面每次启动都是空白）。在 hello 之前完成，
  //     这样服务端认为页面就绪时，第一条消息就有角色可用。
  const restored = await queue.run(() => restoreActiveCharacter());
  report({
    type: 'hostLog',
    level: restored.restored ? 'info' : 'warn',
    message: restored.restored ? `已打开最近使用的角色：${restored.name}` : `没有自动打开角色：${restored.reason}`,
  });

  // 4. hello：服务端校验 nonce，不通过就静默退出
  let helloStatus = 0;
  for (let i = 0; i < 5 && alive; i++) {
    try {
      helloStatus = await uplink.sendNow({
        type: 'hello',
        nonce,
        stVersion: await stVersion(),
        hasTavernHelper: typeof (globalThis as Record<string, unknown>).TavernHelper === 'object',
        extVersion: VERSION,
      });
      if (helloStatus < 500) break;
    } catch {
      // 网络错误，重试
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (helloStatus !== 200) {
    shutdown(`hello 未被接受（HTTP ${helloStatus || '网络错误'}）`);
    return;
  }

  // 5. 下行 SSE
  const es = new EventSource(`${PLUGIN_BASE}/host/events?nonce=${encodeURIComponent(nonce)}`);
  cleanups.push(() => es.close());
  es.onmessage = (m) => {
    let raw: unknown;
    try {
      raw = JSON.parse(m.data as string);
    } catch {
      return;
    }
    const cmd = decodeHostCommand(raw);
    if (!cmd) {
      const id = (raw as { id?: unknown })?.id;
      if (typeof id === 'string') report({ type: 'rpcResult', id, ok: false, error: '无法识别的命令' });
      return;
    }
    handleCommand(cmd);
  };
  es.onerror = () => {
    // 连接中断时 EventSource 会自动重连；服务端返回非 200（nonce 已换）时变为 CLOSED，不再重连。
    if (es.readyState === EventSource.CLOSED) shutdown('SSE 连接被关闭');
  };

  // 6. 心跳
  const hb = setInterval(() => report({ type: 'heartbeat' }), HEARTBEAT_MS);
  cleanups.push(() => clearInterval(hb));

  // 7. 自检：CSRF、酒馆助手、MVU、API 连接
  const runChecks = async (): Promise<void> => {
    const api = await queue.run(() => ensureApiConnected());
    if (alive) report({ type: 'selfCheck', items: [csrf, tavernHelperCheck(), mvuCheck(), api] });
  };
  void runChecks();
  // MVU 由角色脚本在聊天加载后异步初始化，切换聊天后稍等再查一次。
  const c = ctx();
  let chatTimer: ReturnType<typeof setTimeout> | null = null;
  const onChatChanged = (): void => {
    if (chatTimer) clearTimeout(chatTimer);
    chatTimer = setTimeout(() => void runChecks(), 3000);
  };
  c.eventSource.on(c.eventTypes.CHAT_CHANGED, onChatChanged);
  cleanups.push(() => c.eventSource.removeListener(c.eventTypes.CHAT_CHANGED, onChatChanged));

  // 8. 页面错误上报（过滤忽略清单，同一条 30 秒内只报一次）
  const seen = new Map<string, number>();
  const reportError = (message: string): void => {
    if (isKnownNoise({ kind: 'error', message })) return;
    const now = Date.now();
    if ((seen.get(message) ?? 0) > now - 30_000) return;
    seen.set(message, now);
    report({ type: 'hostError', message: message.slice(0, 500) });
  };
  const onError = (e: ErrorEvent): void => reportError(`${e.message}${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`);
  const onRejection = (e: PromiseRejectionEvent): void => {
    const r = e.reason as { message?: unknown } | undefined;
    reportError(`未处理的 Promise 拒绝：${typeof r?.message === 'string' ? r.message : String(e.reason)}`);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  cleanups.push(() => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  });

  function handleCommand(cmd: HostCommand): void {
    const reply = (ok: boolean, result?: unknown, error?: string): void => report({ type: 'rpcResult', id: cmd.id, ok, result, error });
    const fail = (e: unknown): void => reply(false, undefined, e instanceof Error ? e.message : String(e));
    try {
      const generation = (generationId: string, request: GenerationRequest): void => {
        let started = false;
        queue
          .run(async () => {
            await ensureApiConnected();
            await runGeneration({
              generationId,
              request,
              report,
              onStarted: () => {
                started = true;
                reply(true, { generationId });
              },
            });
          })
          .catch((e) => {
            if (!started) fail(e);
            else report({ type: 'generationFailed', generationId, reason: (e as Error).message });
          });
      };
      const queued = (fn: () => unknown): void => {
        queue.run(fn).then(
          (r) => reply(true, r),
          (e) => fail(e),
        );
      };
      switch (cmd.type) {
        case 'send':
          generation(cmd.generationId, { kind: 'send', text: cmd.text });
          return;
        case 'regenerate':
          generation(cmd.generationId, { kind: 'regenerate', chatId: cmd.chatId, messageId: cmd.messageId });
          return;
        case 'listCharacters':
          queued(listCharacters);
          return;
        case 'selectCharacter':
          queued(() => selectCharacter(cmd.characterId));
          return;
        case 'listChats':
          queued(listChats);
          return;
        case 'openChat':
          queued(() => openChat(cmd.fileName));
          return;
        case 'newChat':
          queued(newChat);
          return;
        case 'listPresets':
          queued(listPresets);
          return;
        case 'selectPreset':
          queued(() => selectPreset(cmd.name));
          return;
        // 重新加载无头页面，让它读到 ST 里新增的预设等数据（ST 只在页面加载时读一次，别的标签页里的改动它看不到）。
        // 先回应再刷新；页面重载后重新连上 host 通道并发 hello。
        case 'refreshPage':
          if (hostStatus().generating) {
            fail(new Error('正在生成，暂不刷新页面'));
            return;
          }
          reply(true, {});
          setTimeout(() => location.reload(), 300);
          return;
        // 不进队列：生成进行中也要立即执行
        case 'stop':
          reply(true, { stopped: ctx().stopGeneration() });
          return;
        case 'getStatus':
          reply(true, hostStatus());
          return;
        default:
          reply(false, undefined, `命令 ${cmd.type} 不支持`);
      }
    } catch (e) {
      fail(e);
    }
  }

  console.info(`${LOG} host 模式已启动`);
}

// 单例保护：必须在任何 await 之前同步占位。已有另一份在运行时，本份只警告，不做任何事。
const claim = claimSingleton(globalThis as unknown as Record<string, unknown>, VERSION);
if (claim.ok) {
  main().catch((e) => console.error(`${LOG} host 初始化失败`, e));
} else {
  const msg = duplicateMessage(claim.existingVersion, VERSION);
  console.warn(`${LOG} ${msg}`);
  try {
    (globalThis as unknown as { toastr?: { warning?: (m: string, t?: string) => unknown } }).toastr?.warning?.(msg, 'Silly TG');
  } catch {
    // toast 只是提示，失败不影响
  }
}
