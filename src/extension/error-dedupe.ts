// 页面错误去重：同一条错误在窗口内只报一次。
// 记录会随时间清理，并有数量上限，避免长时间运行的无头页面里 Map 只增不减。

export const ERROR_DEDUPE_WINDOW_MS = 30_000;
export const ERROR_DEDUPE_MAX_ENTRIES = 200;

export function createErrorDedupe(windowMs = ERROR_DEDUPE_WINDOW_MS, maxEntries = ERROR_DEDUPE_MAX_ENTRIES) {
  // Map 按插入顺序迭代；每次写入前先删再设，保证最旧的在最前。
  const seen = new Map<string, number>();
  return {
    /** 窗口内已报过返回 false；否则记录并返回 true。 */
    shouldReport(message: string, now: number): boolean {
      if ((seen.get(message) ?? 0) > now - windowMs) return false;
      for (const [k, t] of seen) {
        if (t > now - windowMs) break;
        seen.delete(k);
      }
      seen.delete(message);
      seen.set(message, now);
      while (seen.size > maxEntries) seen.delete(seen.keys().next().value as string);
      return true;
    },
    get size(): number {
      return seen.size;
    },
  };
}
