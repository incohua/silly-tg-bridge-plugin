// 自检里“稍后才会就绪”的项目（MVU 由角色脚本在聊天加载后异步初始化）：失败时隔一会儿复查，复查通过就不报失败。
export interface RetryOptions {
  /** 首次检查之外最多再复查几次。 */
  retries: number;
  delayMs: number;
  /** 返回 false 时放弃复查（页面已停止）。 */
  keepGoing?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export async function recheckUntilOk<T extends { ok: boolean }>(check: () => T, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let result = check();
  for (let i = 0; i < opts.retries && !result.ok; i++) {
    if (opts.keepGoing && !opts.keepGoing()) break;
    await sleep(opts.delayMs);
    result = check();
  }
  return result;
}
