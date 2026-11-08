// 让无头页面连上用户在 ST 里配置的 API。
// spike 中发现：页面加载后 online_status 可能还是 no_connection，要点一次对应 API 的“连接”按钮。
// 只点按钮，不修改任何 API 设置（设置由用户在普通 ST 页面里配置，写入 settings.json 后重新加载 host 页面生效）。

import type { SelfCheckItem } from '../shared/protocol';
import { ctx } from './adapter';

const CONNECT_BUTTONS: Record<string, string> = {
  openai: '#api_button_openai',
  textgenerationwebui: '#api_button_textgenerationwebui',
  novel: '#api_button_novel',
  kobold: '#api_button',
};

const NO_CONNECTION = 'no_connection';

export const isConnected = (): boolean => {
  const s = ctx().onlineStatus;
  return !!s && s !== NO_CONNECTION;
};

/** 未连接时点一次连接按钮并等待结果。 */
export async function ensureApiConnected(timeoutMs = 15_000): Promise<SelfCheckItem> {
  const api = ctx().mainApi ?? '';
  if (isConnected()) return { name: 'api', ok: true, detail: `${api} 已连接` };
  const sel = CONNECT_BUTTONS[api];
  const btn = sel ? document.querySelector<HTMLElement>(sel) : null;
  if (!btn) return { name: 'api', ok: false, detail: `当前 API（${api || '未设置'}）未连接，且找不到对应的连接按钮。请在 ST 里配置并连接一次 API。` };
  btn.click();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (isConnected()) return { name: 'api', ok: true, detail: `${api} 已连接` };
  }
  return { name: 'api', ok: false, detail: `${api} 连接失败或超时（${ctx().onlineStatus ?? '未知状态'}）。检查 ST 里的 API 地址和密钥。` };
}
