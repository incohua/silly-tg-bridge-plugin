// 酒馆“扩展”设置栏里的 Silly TG 配置抽屉。只在普通 ST 页面渲染；无头 host 页面不会走到这里。
// 所有来自服务端的文字都用 textContent 写入，不拼 HTML。
// 接口：GET/POST /api/plugins/silly-tg/config、GET /status，继承 ST 的会话和 CSRF 鉴权。
// 保存后服务端当场生效（热字段直接改，连接类字段自动重新连接），面板轮询 /status 显示连接结果，不再提示重启 ST。

import { ctx } from './adapter';
import type { RuntimeStatus } from '../shared/runtime-status';
import {
  buildPatch,
  classifyConfigFailure,
  describeRuntime,
  fieldLabel,
  INSTALL_GUIDE,
  LEVEL_ICON,
  POLL_TIMEOUT_NOTE,
  runtimeInProgress,
  runtimeSettling,
  saveResultMessage,
  type FormValues,
  type SettingsResponse,
  type SettingsValues,
} from './settings-model';
import { PLUGIN_BASE } from './uplink';

const CONTAINER_ID = 'extensions_settings2';
/** 保存后轮询 /status 的间隔与最长时间。 */
const POLL_INTERVAL_MS = 1000;
const POLL_MAX_MS = 30_000;
const RECONNECT = '保存后自动重新连接';
const ROOT_ID = 'silly_tg_settings';

type El = HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

interface Row {
  root: El;
  error: El;
}

function row(label: string, effect: string, control: El, hint?: string): Row {
  const root = el('div', { class: 'silly-tg-row', style: 'margin-bottom:10px' });
  const head = el('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:baseline' });
  head.append(el('label', {}, label), el('small', { style: 'opacity:.65' }, effect));
  root.append(head, control);
  if (hint) root.append(el('small', { style: 'opacity:.65;display:block' }, hint));
  const error = el('small', { style: 'color:var(--SmartThemeQuoteColor,#e66);display:block' });
  root.append(error);
  return { root, error };
}

/** 复制文字到剪贴板；不可用或被拒绝时选中文本，让用户自己按复制。 */
async function copyText(text: string, fallbackTarget: HTMLElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const range = document.createRange();
    range.selectNodeContents(fallbackTarget);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return false;
  }
}

/** 服务端插件没装时的引导。固定文案，全部用 textContent / 属性写入。 */
function buildGuide(): El {
  const g = INSTALL_GUIDE;
  const box = el('div', { class: 'silly-tg-guide' });
  box.append(el('b', {}, g.title), el('div', { style: 'margin:4px 0' }, g.intro));
  const code = el('code', { style: 'display:block;padding:6px 8px;margin:4px 0;word-break:break-all;user-select:all' }, g.command);
  const copy = el('input', { type: 'button', class: 'menu_button', value: '复制命令' });
  const copied = el('small', { style: 'margin-left:8px' });
  copy.addEventListener('click', () => {
    void copyText(g.command, code).then((ok) => {
      copied.textContent = ok ? '已复制' : '无法自动复制，已选中命令，请手动复制。';
    });
  });
  const row2 = el('div', { style: 'display:flex;align-items:center;margin-bottom:6px' });
  row2.append(copy, copied);
  box.append(code, row2);
  const ol = el('ol', { style: 'margin:0 0 6px 18px;padding:0' });
  for (const step of g.steps) ol.append(el('li', {}, step));
  box.append(ol);
  const link = el('a', { href: g.readmeUrl, target: '_blank', rel: 'noopener noreferrer' }, g.readmeText);
  box.append(link);
  return box;
}

const input = (type: string, placeholder = ''): HTMLInputElement => el('input', { type, class: 'text_pole', placeholder, autocomplete: 'off', style: 'width:100%' });

function select(options: Array<[string, string]>): HTMLSelectElement {
  const s = el('select', { class: 'text_pole', style: 'width:100%' });
  for (const [v, t] of options) s.append(el('option', { value: v }, t));
  return s;
}

export function mountSettings(): void {
  const mount = (): boolean => {
    const container = document.getElementById(CONTAINER_ID);
    if (!container || document.getElementById(ROOT_ID)) return !!container;
    buildDrawer(container);
    return true;
  };
  if (mount()) return;
  // 容器还没渲染：等 APP_READY，再退而轮询几秒
  try {
    const c = ctx();
    c.eventSource.once(c.eventTypes.APP_READY, () => void mount());
  } catch {
    // 忽略
  }
  let tries = 0;
  const t = setInterval(() => {
    if (mount() || ++tries > 20) clearInterval(t);
  }, 500);
}

function buildDrawer(container: HTMLElement): void {
  const root = el('div', { id: ROOT_ID });
  const drawer = el('div', { class: 'inline-drawer' });
  const header = el('div', { class: 'inline-drawer-toggle inline-drawer-header' });
  header.append(el('b', {}, 'Silly TG（Telegram 桥接）'), el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }));
  const content = el('div', { class: 'inline-drawer-content' });
  drawer.append(header, content);
  root.append(drawer);
  container.append(root);

  const banner = el('div', { style: 'margin-bottom:10px' });
  const form = el('div');
  content.append(banner, form);

  const f = {
    botToken: input('password', ''),
    allowedUserIds: input('text', '例如 123456789，多个用逗号分隔'),
    telegramProxy: input('text', '例如 http://127.0.0.1:7890，不需要留空'),
    stBaseUrl: input('text', 'http://127.0.0.1:8000'),
    basicAuthUser: input('text', 'ST 开启了 basic auth 时填'),
    basicAuthPassword: input('password', ''),
    idleShutdownMinutes: input('number', '0'),
    lowMemory: el('input', { type: 'checkbox' }),
    pageHeapLimitMB: input('number', '256'),
    dialogueStyle: select([
      ['bold', '加粗'],
      ['italic', '斜体'],
      ['mark', '高亮'],
      ['plain', '只保留引号'],
    ]),
    draftIntervalSeconds: input('number', '1'),
    draftMode: select([
      ['live', '逐步显示正文'],
      ['progress', '只显示进度'],
    ]),
    choiceLayout: select([
      ['numbers', '一排数字按钮'],
      ['rows', '每个选项一行'],
    ]),
    logLevel: select([
      ['info', 'info'],
      ['debug', 'debug'],
      ['warn', 'warn'],
      ['error', 'error'],
    ]),
  };
  const rows: Record<string, Row> = {
    botToken: row('Bot Token', RECONNECT, f.botToken),
    allowedUserIds: row('允许的用户 ID', '立即生效', f.allowedUserIds, '只有这些 Telegram 账号能使用 bot。'),
    telegramProxy: row('Telegram 代理', RECONNECT, f.telegramProxy),
    stBaseUrl: row('ST 地址', RECONNECT, f.stBaseUrl, '无头浏览器访问 ST 用的地址。'),
    basicAuth: row('ST 登录账号', RECONNECT, f.basicAuthUser),
    idleShutdownMinutes: row('空闲关闭（分钟）', '立即生效', f.idleShutdownMinutes, '0 表示不自动关闭无头浏览器。'),
    lowMemory: row('低内存模式', '下次启动浏览器时生效', f.lowMemory),
    pageHeapLimitMB: row(
      '页面内存上限（MB）',
      '下次启动浏览器时生效',
      f.pageHeapLimitMB,
      '低内存模式下无头页面 JS 内存的上限，128–4096，默认 256。页面内存会随运行时间缓慢增长，空闲时用量达到上限的 75% 就会自动重载页面回收；内存充裕的机器可以调大（例如 512），重载会少一些，但浏览器占用内存更多。',
    ),
    dialogueStyle: row('对话样式', '立即生效', f.dialogueStyle),
    draftIntervalSeconds: row('草稿刷新间隔（秒）', '立即生效', f.draftIntervalSeconds, '生成时每隔这么久更新一次草稿，0.5–30。调大可减少聊天窗口上下滚动。'),
    draftMode: row('草稿显示方式', '立即生效', f.draftMode, '“只显示进度”时生成过程中不显示正文，聊天窗口不会滚动。'),
    choiceLayout: row('行动选项按钮', '立即生效', f.choiceLayout),
    logLevel: row('日志级别', '立即生效', f.logLevel),
  };
  // 密码框放在账号框下面
  rows.basicAuth.root.insertBefore(f.basicAuthPassword, rows.basicAuth.error);
  f.basicAuthPassword.style.marginTop = '4px';
  for (const r of Object.values(rows)) form.append(r.root);

  const save = el('input', { type: 'button', class: 'menu_button', value: '保存' });
  const reconnect = el('input', { type: 'button', class: 'menu_button', value: '重新连接', title: '重新读取 config.json 并重新连接。手动改过文件后用它，不用重启 ST。', style: 'margin-left:6px' });
  const status = el('small', { style: 'margin-left:8px' });
  const foot = el('div', { style: 'margin-top:6px' });
  foot.append(save, reconnect, status);
  form.append(foot);
  // 运行状态：Telegram、Chromium、无头页面
  const runtimeBox = el('div', { class: 'silly-tg-runtime', style: 'margin-top:8px' });
  form.append(runtimeBox);
  form.append(el('small', { style: 'opacity:.65;display:block;margin-top:8px' }, 'Chromium 路径等未在此列出的选项只能在 config.json 里修改（手动改文件后点“重新连接”即可生效，不用重启 ST）。行动选项规则见插件目录下的 choice-rules.json（改完无需重启）。'));

  let original: SettingsValues | undefined;

  const clearErrors = (): void => {
    for (const r of Object.values(rows)) r.error.textContent = '';
  };
  const showErrors = (errs: Array<{ field: string; message: string }>): void => {
    for (const e of errs) {
      const r = rows[e.field] ?? rows[e.field === 'basicAuth' ? 'basicAuth' : ''];
      if (r) r.error.textContent = `${fieldLabel(e.field)}：${e.message}`;
      else status.textContent = `${fieldLabel(e.field)}：${e.message}`;
    }
  };

  const fill = (v: SettingsValues): void => {
    original = v;
    f.botToken.value = '';
    f.botToken.placeholder = v.botToken.set ? '已设置，留空表示不修改' : '123456789:AA...（从 @BotFather 获取）';
    f.allowedUserIds.value = v.allowedUserIds.join(', ');
    f.telegramProxy.value = v.telegramProxy;
    f.stBaseUrl.value = v.stBaseUrl;
    f.basicAuthUser.value = v.basicAuth?.username ?? '';
    f.basicAuthPassword.value = '';
    f.basicAuthPassword.placeholder = v.basicAuth?.passwordSet ? '已设置，留空表示不修改' : '密码';
    f.idleShutdownMinutes.value = String(v.idleShutdownMinutes);
    (f.lowMemory as HTMLInputElement).checked = v.lowMemory;
    f.pageHeapLimitMB.value = String(v.pageHeapLimitMB);
    f.dialogueStyle.value = v.dialogueStyle;
    f.draftIntervalSeconds.value = String(v.draftIntervalSeconds);
    f.draftMode.value = v.draftMode;
    f.choiceLayout.value = v.choiceLayout;
    f.logLevel.value = v.logLevel;
  };

  const showBanner = (r: SettingsResponse): void => {
    banner.textContent = '';
    // 待命原因在状态区逐条列出，这里只给一句提示
    if (r.exists === false) banner.append(el('div', {}, '还没有 config.json：填好 Bot Token 和允许的用户 ID 后保存，插件会立即启动，无需重启 ST。'));
    else if (r.runtime ? r.runtime.state === 'standby' && r.runtime.standbyReason !== 'no-config' : r.running === false) {
      banner.append(el('div', {}, '插件处于待命状态（配置有误或启动失败）。在下面修正后保存即可，无需重启 ST。'));
    }
  };

  const renderRuntime = (rt: RuntimeStatus | undefined): void => {
    runtimeBox.textContent = '';
    if (!rt) return;
    for (const line of describeRuntime(rt)) runtimeBox.append(el('div', { style: line.level === 'error' ? 'color:var(--SmartThemeQuoteColor,#e66)' : '' }, `${LEVEL_ICON[line.level]} ${line.text}`));
  };

  const request = async (method: 'GET' | 'POST', body?: unknown, path = '/config'): Promise<SettingsResponse> => {
    const headers = ctx().getRequestHeaders();
    const res = await fetch(`${PLUGIN_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    // 404 = ST 找不到插件的路由 = 服务端插件没装/没启用。必须先于 res.json() 判断（404 返回的不是 JSON）。
    if (classifyConfigFailure(res.status) === 'server-missing') return { ok: false, serverMissing: true };
    let json: SettingsResponse;
    try {
      json = (await res.json()) as SettingsResponse;
    } catch {
      return { ok: false, error: `服务端返回了无法解析的内容（HTTP ${res.status}）。插件可能没有加载，检查 ST 的 enableServerPlugins。` };
    }
    return res.ok ? json : { ...json, ok: false, error: json.error ?? `HTTP ${res.status}` };
  };

  // 轮询 /status，直到状态稳定或超过 30 秒。再次保存时作废上一轮。saved 有值时同步更新保存结果的提示。
  let pollToken = 0;
  const pollRuntime = (saved?: SettingsResponse): void => {
    const token = ++pollToken;
    const deadline = Date.now() + POLL_MAX_MS;
    let last = saved?.runtime;
    const tick = async (): Promise<void> => {
      if (token !== pollToken) return;
      if (Date.now() > deadline) {
        // 到点还在启动：明确告诉用户，而不是一直停在“正在重新连接…”
        if (!last || runtimeSettling(last)) {
          if (saved) status.textContent = `${saveResultMessage({ ...saved, runtime: last })}${POLL_TIMEOUT_NOTE}`;
          else runtimeBox.append(el('div', {}, `${LEVEL_ICON.pending} ${POLL_TIMEOUT_NOTE}`));
        }
        return;
      }
      try {
        const r = await request('GET', undefined, '/status');
        if (token !== pollToken || !r.ok || !r.runtime) return;
        last = r.runtime;
        renderRuntime(r.runtime);
        if (saved) status.textContent = saveResultMessage({ ...saved, runtime: r.runtime });
        if (!runtimeInProgress(r.runtime)) return;
      } catch {
        // 网络抖动：下一秒再试
      }
      setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    setTimeout(() => void tick(), POLL_INTERVAL_MS);
  };

  const load = async (): Promise<void> => {
    status.textContent = '读取中…';
    try {
      const r = await request('GET');
      if (r.serverMissing) {
        // 没装服务端插件：显示引导，不渲染配置表单
        banner.textContent = '';
        banner.append(buildGuide());
        form.style.display = 'none';
        status.textContent = '';
        return;
      }
      banner.textContent = '';
      form.style.display = '';
      if (!r.ok || !r.values) {
        status.textContent = r.error ?? '读取配置失败';
        return;
      }
      showBanner(r);
      fill(r.values);
      renderRuntime(r.runtime);
      status.textContent = '';
      if (r.runtime && runtimeInProgress(r.runtime)) pollRuntime();
    } catch (e) {
      status.textContent = `读取配置失败：${e instanceof Error ? e.message : String(e)}`;
    }
  };

  save.addEventListener('click', () => {
    void (async () => {
      clearErrors();
      const form: FormValues = {
        botToken: f.botToken.value,
        allowedUserIds: f.allowedUserIds.value,
        telegramProxy: f.telegramProxy.value,
        stBaseUrl: f.stBaseUrl.value,
        basicAuthUser: f.basicAuthUser.value,
        basicAuthPassword: f.basicAuthPassword.value,
        idleShutdownMinutes: f.idleShutdownMinutes.value,
        lowMemory: (f.lowMemory as HTMLInputElement).checked,
        pageHeapLimitMB: f.pageHeapLimitMB.value,
        dialogueStyle: f.dialogueStyle.value,
        draftIntervalSeconds: f.draftIntervalSeconds.value,
        draftMode: f.draftMode.value,
        choiceLayout: f.choiceLayout.value,
        logLevel: f.logLevel.value,
      };
      const built = buildPatch(form, original);
      if (!built.ok) {
        showErrors(built.errors);
        status.textContent = '有输入需要修正。';
        return;
      }
      status.textContent = '保存中…';
      try {
        const r = await request('POST', { settings: built.patch });
        if (!r.ok) {
          if (r.errors) {
            showErrors(r.errors);
            status.textContent = '没有保存：有输入需要修正。';
          } else status.textContent = r.error ?? (r.serverMissing ? '服务端插件未安装或未启用，请刷新页面查看安装引导。' : '保存失败');
          return;
        }
        status.textContent = saveResultMessage(r);
        if (r.values) fill(r.values);
        showBanner({ ...r, exists: true });
        renderRuntime(r.runtime);
        if (r.runtime && runtimeInProgress(r.runtime)) pollRuntime(r);
        else pollToken++;
      } catch (e) {
        status.textContent = `保存失败：${e instanceof Error ? e.message : String(e)}`;
      }
    })();
  });

  // 手动改过 config.json 后，按文件重新连接（服务端会先校验，文件有误就拒绝，不影响正在运行的实例）。
  reconnect.addEventListener('click', () => {
    void (async () => {
      clearErrors();
      status.textContent = '重新连接中…';
      try {
        const r = await request('POST', {}, '/reload');
        if (!r.ok) {
          if (r.errors?.length) status.textContent = `config.json 有误，没有重新连接：${r.errors.map((e) => `${fieldLabel(e.field)}：${e.message}`).join('；')}`;
          else status.textContent = r.error ?? (r.serverMissing ? '服务端插件未安装或未启用，请刷新页面查看安装引导。' : '重新连接失败');
          return;
        }
        status.textContent = saveResultMessage(r);
        if (r.values) fill(r.values);
        showBanner({ ...r, exists: true });
        renderRuntime(r.runtime);
        if (r.runtime && runtimeInProgress(r.runtime)) pollRuntime(r);
        else pollToken++;
      } catch (e) {
        status.textContent = `重新连接失败：${e instanceof Error ? e.message : String(e)}`;
      }
    })();
  });

  void load();
}
