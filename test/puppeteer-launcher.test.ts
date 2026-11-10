import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const sessions: Array<{ send: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> }> = [];
  const state = { failNext: false, detachThrows: false };
  const page = {
    createCDPSession: vi.fn(async () => {
      const s = {
        send: vi.fn(async () => {
          if (state.failNext) {
            state.failNext = false;
            throw new Error('Session closed');
          }
          return { usedSize: 42 };
        }),
        detach: vi.fn(async () => {
          if (state.detachThrows) throw new Error('detach failed');
        }),
      };
      sessions.push(s);
      return s;
    }),
  };
  const browser = { process: () => ({ pid: 1 }), newPage: async () => page, close: async () => {}, on: () => {} };
  return { sessions, state, page, browser };
});

vi.mock('puppeteer-core', () => ({ default: { launch: vi.fn(async () => h.browser) } }));

import { puppeteerLauncher } from '../src/server/puppeteer-launcher';

describe('puppeteerLauncher heapUsed', () => {
  it('出错时先 detach 旧会话再抛出原错误；下次调用新建会话', async () => {
    const b = await puppeteerLauncher({ executablePath: '/x', args: [], userDataDir: '/tmp/x' });
    const page = await b.newPage();
    await expect(page.heapUsed()).resolves.toBe(42);
    expect(h.sessions).toHaveLength(1);

    h.state.failNext = true;
    await expect(page.heapUsed()).rejects.toThrow('Session closed');
    expect(h.sessions[0]!.detach).toHaveBeenCalledTimes(1);

    await expect(page.heapUsed()).resolves.toBe(42);
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]!.detach).not.toHaveBeenCalled();
  });

  it('detach 自己出错也不吞掉原错误', async () => {
    const b = await puppeteerLauncher({ executablePath: '/x', args: [], userDataDir: '/tmp/x' });
    const page = await b.newPage();
    await page.heapUsed();
    h.state.failNext = true;
    h.state.detachThrows = true;
    await expect(page.heapUsed()).rejects.toThrow('Session closed');
    h.state.detachThrows = false;
  });
});
