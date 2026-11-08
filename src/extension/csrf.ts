// CSRF 补丁和自检（spike 调整 1）。
// 现象：无头页面里 jQuery.ajax 发出的请求不带 X-CSRF-Token，tokenizer 等接口返回 403，
// 提示词被组装成空的 messages: []，请求照样发出，表面上看不出异常。原因未查清，ST 和 Luker 都按需要补丁处理。
// 做法：先探测一次（记录补丁前的状态，便于确认 Luker 是否也有此问题），再 $.ajaxSetup 补上头，再探测一次。

import type { SelfCheckItem } from '../shared/protocol';
import { ctx } from './adapter';
import type { JQueryLike, JQueryXhrLike } from './st-types';

/** 需要 CSRF 的无副作用接口：POST /api/ping（204）。返回 HTTP 状态，网络失败为 0。 */
async function probe($: JQueryLike): Promise<number> {
  try {
    await $.ajax({ type: 'POST', url: '/api/ping', cache: false });
    return 204;
  } catch (e) {
    return (e as JQueryXhrLike | undefined)?.status ?? 0;
  }
}

const ok2xx = (s: number): boolean => s >= 200 && s < 300;

export async function applyCsrfPatchAndCheck(opts: { skipPatch?: boolean } = {}): Promise<SelfCheckItem> {
  const $ = (globalThis as unknown as { $?: JQueryLike }).$;
  if (typeof $ !== 'function' || typeof $.ajaxSetup !== 'function') {
    return { name: 'csrf', ok: false, detail: '页面里没有 jQuery，无法安装 CSRF 补丁' };
  }
  const before = await probe($);
  if (opts.skipPatch) {
    // 测试开关：不装补丁，只报告探测结果
    const detail = `测试开关：未安装补丁，jQuery.ajax 自检 POST /api/ping 返回 ${before || '网络错误'}`;
    return { name: 'csrf', ok: ok2xx(before), detail };
  }
  $.ajaxSetup({
    beforeSend: (xhr) => {
      // 每次取最新 token：ST 在 firstLoadInit 开头获取，之后可能刷新。
      const token = ctx().getRequestHeaders()['X-CSRF-Token'];
      if (token) xhr.setRequestHeader('X-CSRF-Token', token);
    },
  });
  const after = await probe($);
  const detail = `jQuery.ajax 自检 POST /api/ping：补丁前 ${before || '网络错误'}，补丁后 ${after || '网络错误'}`;
  if (ok2xx(after)) return { name: 'csrf', ok: true, detail };
  return {
    name: 'csrf',
    ok: false,
    detail: `${detail}。需要 CSRF 的请求会失败，提示词可能被组装为空，暂停使用并检查 ST 版本或登录状态。`,
  };
}
