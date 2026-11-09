// 服务端运行状态：GET/POST /api/plugins/silly-tg/config 与 GET /status 返回的 runtime 字段。
// 服务端（supervisor.ts）生成，配置面板（extension/settings-model.ts）展示，两边都从这里导入类型。
// 所有字符串在服务端已脱敏（不含 token、密码、代理凭据），也不含 Chromium 路径。

export type RuntimeState = 'standby' | 'starting' | 'running' | 'stopping';

/** 待命的原因：没有 config.json、配置有误、启动过程抛错。 */
export type StandbyReason = 'no-config' | 'invalid-config' | 'start-failed';

export interface RuntimeIssue {
  field: string;
  message: string;
}

export interface RuntimeStatus {
  state: RuntimeState;
  standbyReason?: StandbyReason;
  /** 待命时的原因清单（已脱敏）。 */
  errors?: RuntimeIssue[];
  /** ok 已连接；error 连接失败（见 telegramError）；skipped 没有连接（待命或离线模式）；pending 正在连接。 */
  telegram: 'ok' | 'error' | 'skipped' | 'pending';
  telegramError?: string;
  botUsername?: string;
  chromium: { found: boolean; hint?: string };
  /** 无头页面的扩展是否已连上服务端。 */
  hostConnected: boolean;
  hostPage?: { stVersion: string; extVersion?: string };
}
