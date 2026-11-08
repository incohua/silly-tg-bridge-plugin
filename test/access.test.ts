import { describe, expect, it } from 'vitest';
import { getSenderId, isAllowedUpdate } from '../src/server/access';

const chat = { id: 1, type: 'private' };

describe('access', () => {
  it('白名单用户的消息和按钮回调放行', () => {
    expect(isAllowedUpdate({ update_id: 1, message: { message_id: 1, chat, from: { id: 42 } } }, [42])).toBe(true);
    expect(isAllowedUpdate({ update_id: 2, callback_query: { id: 'a', from: { id: 42 } } }, [42])).toBe(true);
  });
  it('非白名单、无发送者、未知类型一律拒绝', () => {
    expect(isAllowedUpdate({ update_id: 1, message: { message_id: 1, chat, from: { id: 7 } } }, [42])).toBe(false);
    expect(isAllowedUpdate({ update_id: 1, message: { message_id: 1, chat } }, [42])).toBe(false);
    expect(isAllowedUpdate({ update_id: 1, my_chat_member: { from: { id: 42 } } }, [42])).toBe(false);
  });
  it('停止按钮更新：只在私聊时用 chat.id', () => {
    const stop = (type: string, id: number) => ({ update_id: 9, stopped_message_generation: { chat: { id, type }, draft_id: 1 } });
    expect(getSenderId(stop('private', 5))).toBe(5);
    expect(getSenderId(stop('group', 5))).toBeUndefined();
    expect(isAllowedUpdate(stop('private', 5), [5])).toBe(true);
    expect(isAllowedUpdate(stop('private', 6), [5])).toBe(false);
  });

  it('白名单用户在群里发的消息也拒绝（回复会发到群里）', () => {
    const group = { id: -100, type: 'supergroup' };
    expect(isAllowedUpdate({ update_id: 1, message: { message_id: 1, chat: group, from: { id: 42 } } }, [42])).toBe(false);
    expect(isAllowedUpdate({ update_id: 2, callback_query: { id: 'a', from: { id: 42 }, message: { message_id: 1, chat: group } } }, [42])).toBe(false);
  });

  it('用发送者而不是 chat id 判断', () => {
    expect(getSenderId({ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'group' }, from: { id: 7 } } })).toBe(7);
  });
});
