// host 模式判定（纯函数部分）。
// 只有 URL 的 hash 带 #silly_tg_host=<nonce> 的页面才可能是 host；之后还要服务端在 hello 时校验 nonce。
// 用户自己打开的普通 ST 页面没有这个标记，扩展什么都不做。
//
// 为什么放在 hash 而不是查询参数：ST 1.19 的首页 URL 只要带查询参数（任意 ?x=1），页面 DOM 就会出现两份
// （两个 #form_create、两个 #character_popup，2026-11-07 实测）。ST 打开或新建聊天时用 #form_create 重新保存角色卡，
// 重复字段会被存成数组，把角色卡写坏（实测 Seraphina 卡被写坏过）。hash 不会触发这个问题。

export const HOST_PARAM = 'silly_tg_host';
/** 只用于测试：带上这个标记时扩展不安装 CSRF 补丁（对照 Luker 等是否真的需要补丁）。由服务端环境变量控制。 */
export const SKIP_CSRF_PATCH_PARAM = 'silly_tg_test_skip_csrf_patch';

/** 服务端生成的 nonce 是 16 字节十六进制（32 个字符）。 */
const NONCE_RE = /^[0-9a-f]{32}$/;

/** hash 里的测试标记。纯函数。 */
export function parseHostTestFlags(hash: string): { skipCsrfPatch: boolean } {
  try {
    return { skipCsrfPatch: new URLSearchParams(hash.replace(/^#/, '')).get(SKIP_CSRF_PATCH_PARAM) === '1' };
  } catch {
    return { skipCsrfPatch: false };
  }
}

/** 从 location.hash 取 nonce（如 "#silly_tg_host=..."）。没有或格式不对返回 null。查询参数里的不认。 */
export function parseHostNonce(hash: string): string | null {
  let value: string | null;
  try {
    value = new URLSearchParams(hash.replace(/^#/, '')).get(HOST_PARAM);
  } catch {
    return null;
  }
  return value !== null && NONCE_RE.test(value) ? value : null;
}
