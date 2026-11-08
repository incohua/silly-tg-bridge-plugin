// host 页面启动后恢复最近使用的角色。
// ST 只有在“自动加载上次聊天”（power_user.auto_load_chat）开启时才会这样做，默认关闭。
// 无头页面每次启动（包括空闲关闭后被唤醒）都会是空白状态，所以在 host 模式里主动恢复一次：
// 读取 settings.json 里 ST 自己记录的 active_character（用户最近选过的角色），打开它的最近聊天。
// 不修改任何设置。群聊暂不处理（/chats 等在后续步骤实现）。

import { ctx } from './adapter';

/** 从 /api/settings/get 的响应里取 active_character。ST 返回 {settings: "<json 字符串>"}。纯函数。 */
export function activeCharacterFromSettingsResponse(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  let s = (body as { settings?: unknown }).settings;
  if (typeof s === 'string') {
    try {
      s = JSON.parse(s);
    } catch {
      return null;
    }
  }
  const v = (s as { active_character?: unknown } | undefined)?.active_character;
  return typeof v === 'string' && v ? v : null;
}

export type RestoreResult = { restored: false; reason: string } | { restored: true; name: string };

/**
 * 已有打开的角色时不动。selectCharacterById 可能被导入弹窗挡住，不等待它完成（弹窗由 dialog-watcher 处理），
 * 只等到 characterId 变化或超时。
 */
export async function restoreActiveCharacter(timeoutMs = 20_000): Promise<RestoreResult> {
  const c = ctx();
  if ((c.characterId !== undefined && c.characterId !== null) || c.groupId) return { restored: false, reason: '已有打开的聊天' };
  let key: string | null = null;
  try {
    const res = await fetch('/api/settings/get', { method: 'POST', headers: c.getRequestHeaders(), body: '{}', cache: 'no-cache' });
    key = activeCharacterFromSettingsResponse(await res.json());
  } catch (e) {
    return { restored: false, reason: `读取设置失败：${(e as Error).message}` };
  }
  if (!key) return { restored: false, reason: 'ST 没有记录最近使用的角色' };
  const index = c.characters.findIndex((ch) => ch.avatar === key);
  if (index < 0) return { restored: false, reason: `最近使用的角色 ${key} 已不存在` };
  if (typeof c.selectCharacterById !== 'function') return { restored: false, reason: 'selectCharacterById 不可用' };
  void Promise.resolve(c.selectCharacterById(index)).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const now = ctx();
    if (String(now.characterId) === String(index) && now.getCurrentChatId()) return { restored: true, name: c.characters[index].name ?? key };
  }
  return { restored: false, reason: `打开角色 ${key} 超时` };
}
