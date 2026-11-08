import type { TelegramUpdate } from './telegram';

/**
 * 取 update 的发送者 id。只认已知的几种 update 类型，其余一律返回 undefined（视为不允许）。
 * 注意：这里读的是 `from`（发送者），不是 chat.id，群里转发的内容不会冒充白名单用户。
 */
export function getSenderId(update: TelegramUpdate): number | undefined {
  const id = update.message?.from?.id ?? update.edited_message?.from?.id ?? update.callback_query?.from?.id;
  if (typeof id === 'number') return id;
  // stopped_message_generation 没有 from。草稿只能发到私聊，私聊的 chat.id 就是用户 id，所以只在 private 时用 chat.id。
  const stop = update.stopped_message_generation;
  if (stop?.chat?.type === 'private' && typeof stop.chat.id === 'number') return stop.chat.id;
  return undefined;
}

export function isAllowedUpdate(update: TelegramUpdate, allowedUserIds: readonly number[]): boolean {
  // 只处理私聊：白名单用户在群里 @bot 或发命令时，回复会发到群里，泄露聊天内容
  const chat = (update.message ?? update.edited_message ?? update.callback_query?.message)?.chat;
  if (chat && chat.type !== 'private') return false;
  const id = getSenderId(update);
  return id !== undefined && allowedUserIds.includes(id);
}
