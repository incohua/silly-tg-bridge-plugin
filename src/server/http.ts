import { ProxyAgent, fetch as undiciFetch } from 'undici';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 创建访问 Telegram 用的 fetch。
 * Node 内置的全局 fetch 没有公开的代理入口（其 undici 是内部版本，不接受外部 dispatcher），
 * 所以配了代理时改用打包进来的 undici：undici.fetch + ProxyAgent。不配代理时用全局 fetch。
 * 只支持 http/https 代理。
 */
export function createFetch(proxyUrl?: string): FetchLike {
  if (!proxyUrl) return (input, init) => fetch(input, init);
  const dispatcher = new ProxyAgent(proxyUrl);
  return (input, init) => undiciFetch(input, { ...(init as object), dispatcher }) as unknown as Promise<Response>;
}
