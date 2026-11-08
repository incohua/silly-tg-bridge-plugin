// 配置面板里不依赖 DOM 的部分：服务端响应的类型、表单值到提交内容的转换。可在 Node 中测试。

export interface SettingsValues {
  botToken: { set: boolean };
  allowedUserIds: number[];
  telegramProxy: string;
  stBaseUrl: string;
  basicAuth: { username: string; passwordSet: boolean } | null;
  idleShutdownMinutes: number;
  lowMemory: boolean;
  dialogueStyle: string;
  logLevel: string;
}

export interface SettingsResponse {
  ok: boolean;
  running?: boolean;
  startErrors?: Array<{ field: string; message: string }>;
  exists?: boolean;
  values?: SettingsValues;
  error?: string;
  errors?: Array<{ field: string; message: string }>;
  changed?: string[];
  hot?: string[];
  restart?: string[];
}

/** 表单里用户填的原始值（都是字符串/布尔）。 */
export interface FormValues {
  botToken: string;
  allowedUserIds: string;
  telegramProxy: string;
  stBaseUrl: string;
  basicAuthUser: string;
  basicAuthPassword: string;
  idleShutdownMinutes: string;
  lowMemory: boolean;
  dialogueStyle: string;
  logLevel: string;
}

export type ParsedIds = { ok: true; ids: number[] } | { ok: false; message: string };

/** 用逗号、空格或换行分隔的用户 ID。 */
export function parseUserIds(text: string): ParsedIds {
  const parts = text.split(/[\s,，、;；]+/).filter(Boolean);
  const ids: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p) || !Number.isSafeInteger(Number(p)) || Number(p) <= 0) {
      return { ok: false, message: `“${p}”不是用户数字 ID（应为纯数字，可向 @userinfobot 查询，不是用户名）。` };
    }
    ids.push(Number(p));
  }
  return { ok: true, ids: [...new Set(ids)] };
}

export type BuildResult = { ok: true; patch: Record<string, unknown> } | { ok: false; errors: Array<{ field: string; message: string }> };

/**
 * 表单值转成提交给服务端的 patch。
 * 密码类字段留空表示不修改；客户端不做字段校验（以服务端 validateConfig 为准），只处理格式转换。
 */
export function buildPatch(form: FormValues, original: SettingsValues | undefined): BuildResult {
  const errors: Array<{ field: string; message: string }> = [];
  const patch: Record<string, unknown> = {};

  if (form.botToken.trim()) patch.botToken = form.botToken.trim();

  const ids = parseUserIds(form.allowedUserIds);
  if (ids.ok) patch.allowedUserIds = ids.ids;
  else errors.push({ field: 'allowedUserIds', message: ids.message });

  patch.telegramProxy = form.telegramProxy.trim();
  patch.stBaseUrl = form.stBaseUrl.trim();

  if (form.basicAuthUser.trim()) patch.basicAuth = { username: form.basicAuthUser.trim(), password: form.basicAuthPassword };
  else if (original?.basicAuth) patch.basicAuth = null;

  const idle = form.idleShutdownMinutes.trim() === '' ? 0 : Number(form.idleShutdownMinutes);
  if (!Number.isFinite(idle)) errors.push({ field: 'idleShutdownMinutes', message: '空闲关闭时间必须是数字（分钟），0 表示不关闭。' });
  else patch.idleShutdownMinutes = idle;

  patch.lowMemory = form.lowMemory;
  patch.dialogueStyle = form.dialogueStyle;
  patch.logLevel = form.logLevel;

  return errors.length > 0 ? { ok: false, errors } : { ok: true, patch };
}

/** 保存结果的提示文字。 */
export function saveSummary(r: SettingsResponse): string {
  if (!r.changed || r.changed.length === 0) return '没有改动。';
  const parts: string[] = ['已保存。'];
  if (r.hot && r.hot.length > 0) parts.push(`已立即生效：${r.hot.map(fieldLabel).join('、')}。`);
  if (r.restart && r.restart.length > 0) parts.push(`需要重启 ST 才生效：${r.restart.map(fieldLabel).join('、')}。`);
  return parts.join('');
}

export const FIELD_LABELS: Record<string, string> = {
  botToken: 'Bot Token',
  allowedUserIds: '允许的用户 ID',
  telegramProxy: 'Telegram 代理',
  stBaseUrl: 'ST 地址',
  basicAuth: 'ST 登录账号',
  idleShutdownMinutes: '空闲关闭时间',
  lowMemory: '低内存模式',
  dialogueStyle: '对话样式',
  logLevel: '日志级别',
};

export const fieldLabel = (k: string): string => FIELD_LABELS[k] ?? k;
