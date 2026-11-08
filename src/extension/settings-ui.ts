// 酒馆“扩展”设置栏里的 Silly TG 配置抽屉。只在普通 ST 页面渲染；无头 host 页面不会走到这里。
// 所有来自服务端的文字都用 textContent 写入，不拼 HTML。
// 接口：GET/POST /api/plugins/silly-tg/config，继承 ST 的会话和 CSRF 鉴权。

import { ctx } from './adapter';
import { buildPatch, fieldLabel, saveSummary, type FormValues, type SettingsResponse, type SettingsValues } from './settings-model';
import { PLUGIN_BASE } from './uplink';

const CONTAINER_ID = 'extensions_settings2';
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
    dialogueStyle: select([
      ['bold', '加粗'],
      ['italic', '斜体'],
      ['mark', '高亮'],
      ['plain', '只保留引号'],
    ]),
    logLevel: select([
      ['info', 'info'],
      ['debug', 'debug'],
      ['warn', 'warn'],
      ['error', 'error'],
    ]),
  };
  const rows: Record<string, Row> = {
    botToken: row('Bot Token', '重启 ST 后生效', f.botToken),
    allowedUserIds: row('允许的用户 ID', '重启 ST 后生效', f.allowedUserIds, '只有这些 Telegram 账号能使用 bot。'),
    telegramProxy: row('Telegram 代理', '重启 ST 后生效', f.telegramProxy),
    stBaseUrl: row('ST 地址', '重启 ST 后生效', f.stBaseUrl, '无头浏览器访问 ST 用的地址。'),
    basicAuth: row('ST 登录账号', '重启 ST 后生效', f.basicAuthUser),
    idleShutdownMinutes: row('空闲关闭（分钟）', '立即生效', f.idleShutdownMinutes, '0 表示不自动关闭无头浏览器。'),
    lowMemory: row('低内存模式', '下次启动浏览器时生效', f.lowMemory),
    dialogueStyle: row('对话样式', '立即生效', f.dialogueStyle),
    logLevel: row('日志级别', '立即生效', f.logLevel),
  };
  // 密码框放在账号框下面
  rows.basicAuth.root.insertBefore(f.basicAuthPassword, rows.basicAuth.error);
  f.basicAuthPassword.style.marginTop = '4px';
  for (const r of Object.values(rows)) form.append(r.root);

  const save = el('input', { type: 'button', class: 'menu_button', value: '保存' });
  const status = el('small', { style: 'margin-left:8px' });
  const foot = el('div', { style: 'margin-top:6px' });
  foot.append(save, status);
  form.append(foot);
  form.append(el('small', { style: 'opacity:.65;display:block;margin-top:8px' }, 'Chromium 路径等未在此列出的选项只能在 config.json 里修改。行动选项规则见插件目录下的 choice-rules.json（改完无需重启）。'));

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
    f.dialogueStyle.value = v.dialogueStyle;
    f.logLevel.value = v.logLevel;
  };

  const showBanner = (r: SettingsResponse): void => {
    banner.textContent = '';
    if (r.exists === false) banner.append(el('div', {}, '还没有 config.json：填好 Bot Token 和允许的用户 ID 后保存，然后重启 ST。'));
    else if (r.running === false) {
      banner.append(el('div', {}, '插件当前没有启动（配置有误）。修正后保存并重启 ST：'));
      for (const e of r.startErrors ?? []) banner.append(el('div', { style: 'opacity:.8' }, `· ${e.field}：${e.message}`));
    }
  };

  const request = async (method: 'GET' | 'POST', body?: unknown): Promise<SettingsResponse> => {
    const headers = ctx().getRequestHeaders();
    const res = await fetch(`${PLUGIN_BASE}/config`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json: SettingsResponse;
    try {
      json = (await res.json()) as SettingsResponse;
    } catch {
      return { ok: false, error: `服务端返回了无法解析的内容（HTTP ${res.status}）。插件可能没有加载，检查 ST 的 enableServerPlugins。` };
    }
    return res.ok ? json : { ...json, ok: false, error: json.error ?? `HTTP ${res.status}` };
  };

  const load = async (): Promise<void> => {
    status.textContent = '读取中…';
    try {
      const r = await request('GET');
      if (!r.ok || !r.values) {
        status.textContent = r.error ?? '读取配置失败';
        return;
      }
      showBanner(r);
      fill(r.values);
      status.textContent = '';
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
        dialogueStyle: f.dialogueStyle.value,
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
          } else status.textContent = r.error ?? '保存失败';
          return;
        }
        status.textContent = saveSummary(r);
        if (r.values) fill(r.values);
        showBanner({ ...r, running: undefined, exists: true });
      } catch (e) {
        status.textContent = `保存失败：${e instanceof Error ? e.message : String(e)}`;
      }
    })();
  });

  void load();
}
