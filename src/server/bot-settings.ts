// /settings：在 Telegram 里切换常用设置。点一下按钮切到下一个值，保存到 config.json 并立即生效。
// 只开放热生效、不敏感的字段；token、白名单、代理等仍在酒馆扩展栏的面板里改。

export interface BotSettingsValues {
  dialogueStyle: string;
  draftMode: string;
  draftIntervalSeconds: number;
  choiceLayout: string;
}

export interface BotSettings {
  get(): BotSettingsValues;
  /** 校验、写入 config.json 并让运行中的配置立即生效；失败抛错（信息可直接展示给用户）。 */
  set(patch: Partial<BotSettingsValues>): void;
}

interface SettingDef {
  key: keyof BotSettingsValues;
  label: string;
  values: ReadonlyArray<readonly [string | number, string]>;
}

export const SETTING_DEFS: readonly SettingDef[] = [
  { key: 'dialogueStyle', label: '🗨️ 对话样式', values: [['bold', '加粗'], ['italic', '斜体'], ['mark', '高亮'], ['plain', '只保留引号']] },
  { key: 'draftMode', label: '👀 生成时预览', values: [['live', '逐步显示正文'], ['progress', '只显示进度']] },
  { key: 'draftIntervalSeconds', label: '⏱️ 预览刷新间隔', values: [[0.5, '0.5 秒'], [1, '1 秒'], [2, '2 秒'], [3, '3 秒'], [5, '5 秒'], [10, '10 秒']] },
  { key: 'choiceLayout', label: '🎲 行动选项按钮', values: [['numbers', '一排数字'], ['rows', '每项一行']] },
];

function valueLabel(def: SettingDef, current: string | number): string {
  return def.values.find(([v]) => v === current)?.[1] ?? (def.key === 'draftIntervalSeconds' ? `${current} 秒` : String(current));
}

/** 下一个值：按列表顺序循环；当前值不在列表里（比如面板里填了 2.5）时取列表里下一个更大的，没有就回到第一个。 */
export function nextValue(def: SettingDef, current: string | number): string | number {
  const i = def.values.findIndex(([v]) => v === current);
  if (i >= 0) return def.values[(i + 1) % def.values.length][0];
  if (typeof current === 'number') return def.values.find(([v]) => typeof v === 'number' && v > current)?.[0] ?? def.values[0][0];
  return def.values[0][0];
}

export function settingsText(): string {
  return '⚙️ 设置（点按钮切换到下一个值，立即生效并保存到 config.json）';
}

export function settingsKeyboard(values: BotSettingsValues): Array<Array<{ text: string; callback_data: string }>> {
  return SETTING_DEFS.map((def, i) => [{ text: `${def.label}：${valueLabel(def, values[def.key])}`, callback_data: `s|${i}` }]);
}

export function decodeSettingsCallback(data: string | undefined): number | null {
  const m = /^s\|(\d{1,2})$/.exec(data ?? '');
  return m && Number(m[1]) < SETTING_DEFS.length ? Number(m[1]) : null;
}
