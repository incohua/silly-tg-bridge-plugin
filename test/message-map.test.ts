import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BridgeStore, type ReplyRecord } from '../src/server/message-map';
import { captureLogger, noopLogger } from './helpers';

const file = (): string => join(mkdtempSync(join(tmpdir(), 'silly-tg-store-')), 'sub', 'state.json');
const rec = (over: Partial<ReplyRecord> = {}): ReplyRecord => ({
  telegramChatId: 7,
  telegramMessageIds: [10, 11],
  stChatId: 'A - 1',
  stMessageId: 3,
  sentAt: 1000,
  ...over,
});

describe('BridgeStore', () => {
  it('写入后重新加载仍在（ST 重启后可重新生成上一条、恢复会话）', () => {
    const f = file();
    const a = new BridgeStore(f, noopLogger);
    a.recordReply(rec());
    a.recordReply(rec({ telegramChatId: 8, stMessageId: 5 }));
    a.setSession({ characterAvatar: 'x.png', chatId: 'A - 1' });
    const b = new BridgeStore(f, noopLogger);
    expect(b.lastReply(7)).toEqual(rec());
    expect(b.lastReply(8)?.stMessageId).toBe(5);
    expect(b.lastReply(9)).toBeUndefined();
    expect(b.session).toEqual({ characterAvatar: 'x.png', chatId: 'A - 1' });
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('同一条 ST 消息重新生成后替换旧记录；removeReply 删除', () => {
    const s = new BridgeStore(file(), noopLogger);
    s.recordReply(rec());
    s.recordReply(rec({ telegramMessageIds: [20] }));
    expect(s.lastReply(7)?.telegramMessageIds).toEqual([20]);
    s.removeReply(s.lastReply(7)!);
    expect(s.lastReply(7)).toBeUndefined();
  });

  it('最多保留 100 条', () => {
    const f = file();
    const s = new BridgeStore(f, noopLogger);
    for (let i = 0; i < 130; i++) s.recordReply(rec({ stMessageId: i }));
    expect((JSON.parse(readFileSync(f, 'utf8')) as { replies: unknown[] }).replies).toHaveLength(100);
    expect(s.lastReply(7)?.stMessageId).toBe(129);
  });

  it('文件损坏或字段不对：从空开始并给出提示，不抛错', () => {
    const f = file();
    new BridgeStore(f, noopLogger).setSession({ chatId: 'x' });
    writeFileSync(f, '{not json');
    const log = captureLogger();
    const s = new BridgeStore(f, log);
    expect(s.session).toBeUndefined();
    expect(log.lines.join('\n')).toMatch(/不是合法的 JSON/);
    writeFileSync(f, JSON.stringify({ version: 1, replies: [{ telegramChatId: 'x' }, rec()], session: { chatId: 5 } }));
    const t = new BridgeStore(f, noopLogger);
    expect(t.lastReply(7)).toEqual(rec());
    expect(t.session).toBeUndefined();
  });
});
