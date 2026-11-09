// 读取页面 JS 堆用量，随心跳上报给服务端。纯函数，便于测试。
// performance.memory 是 Chromium 的非标准 API（无头模式同样有）；其他浏览器没有就返回 undefined。
// usedJSHeapSize 在非跨源隔离页面是分桶近似值，对“是否接近上限”的判断够用。

import type { HeapUsage } from '../shared/protocol';

export function readHeap(perf: unknown = (globalThis as { performance?: unknown }).performance): HeapUsage | undefined {
  const mem = (perf as { memory?: { usedJSHeapSize?: unknown; jsHeapSizeLimit?: unknown } } | undefined)?.memory;
  if (!mem) return undefined;
  const { usedJSHeapSize: used, jsHeapSizeLimit: limit } = mem;
  if (typeof used !== 'number' || typeof limit !== 'number') return undefined;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used < 0 || limit < 0) return undefined;
  return { used, limit };
}
