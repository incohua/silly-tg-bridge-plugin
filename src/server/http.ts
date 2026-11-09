import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 按优先级排列的代理环境变量，取第一个非空的。 */
export const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const;
const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'] as const;

/**
 * 最终生效的 Telegram 代理。
 * - config：config.json 的 telegramProxy
 * - env：环境变量（HTTPS_PROXY 等，NO_PROXY 生效）
 * - none：直连；ignored 非空表示环境变量里有代理但协议不支持，已被忽略
 */
export interface ProxyResolution {
  source: 'config' | 'env' | 'none';
  /** 含凭据的完整地址，只用于创建代理，绝不能写进日志或 /status。 */
  url?: string;
  /** 来源是环境变量时，具体是哪个变量。 */
  envName?: string;
  noProxy?: string;
  /** 被忽略的环境变量代理说明（已去掉凭据），例如 "ALL_PROXY=socks5://127.0.0.1:1080"。 */
  ignored?: string;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** 解析最终使用的代理：config.json 的 telegramProxy 优先，其次环境变量，都没有则直连。纯函数。 */
export function resolveProxy(configProxy: string | undefined, env: NodeJS.ProcessEnv = process.env): ProxyResolution {
  if (configProxy) return { source: 'config', url: configProxy };
  const envName = PROXY_ENV_KEYS.find((k) => env[k]?.trim());
  if (!envName) return { source: 'none' };
  const raw = env[envName]!.trim();
  const u = parseUrl(raw);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
    // 只显示名称和协议/主机，不带凭据；解析不了的值连原文都不显示
    return { source: 'none', ignored: `${envName}=${u && u.host ? `${u.protocol}//${u.host}` : '（无法识别的地址）'}` };
  }
  const noProxyKey = NO_PROXY_ENV_KEYS.find((k) => env[k]?.trim());
  return { source: 'env', url: raw, envName, noProxy: noProxyKey ? env[noProxyKey]!.trim() : undefined };
}

/** 代理的可读描述，只含来源和主机，不含账号密码。用于日志和 /status。 */
export function describeProxy(r: ProxyResolution): string {
  const host = r.url ? parseUrl(r.url)?.host : undefined;
  if (r.source === 'config') return `配置 telegramProxy（${host ?? '地址无效'}）`;
  if (r.source === 'env') return `环境变量 ${r.envName}（${host ?? '地址无效'}）`;
  return r.ignored ? `无（直连；已忽略 ${r.ignored}，只支持 http/https 代理）` : '无（直连）';
}

/**
 * 创建访问 Telegram 用的 fetch。
 * Node 内置的全局 fetch 没有公开的代理入口（其 undici 是内部版本，不接受外部 dispatcher），
 * 所以用代理时改用打包进来的 undici：undici.fetch + ProxyAgent / EnvHttpProxyAgent。不用代理时用全局 fetch。
 * 参数：字符串视为 config.json 里的代理地址；也可以传 resolveProxy 的结果。不会自己去读环境变量。
 * 只支持 http/https 代理。
 */
export function createFetch(proxy?: string | ProxyResolution): FetchLike {
  const r: ProxyResolution = typeof proxy === 'string' ? { source: 'config', url: proxy } : (proxy ?? { source: 'none' });
  if (r.source === 'none' || !r.url) return (input, init) => fetch(input, init);
  const dispatcher =
    r.source === 'env'
      ? // 显式传入全部三项，不让 undici 再去读一遍环境变量；noProxy 为空串表示没有例外
        new EnvHttpProxyAgent({ httpProxy: r.url, httpsProxy: r.url, noProxy: r.noProxy ?? '' })
      : new ProxyAgent(r.url);
  return (input, init) => undiciFetch(input, { ...(init as object), dispatcher }) as unknown as Promise<Response>;
}
