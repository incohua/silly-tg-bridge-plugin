// 回复里的“行动选项”解析。纯函数 + 一个带热加载的规则读取器。
// 选项来自预设/角色卡提示词（让模型在回复末尾输出某种标签或编号列表），格式因预设而异，所以用规则描述：
//   block        正则源码，在原始消息（chat[i].mes）里找选项块，第 1 个捕获组是块内容
//   item         正则源码，对块内每一行匹配，第 1 个捕获组是选项文字（行首的编号等不要放进捕获组）
//   htmlSelector 可选，渲染后 html 里选项块对应的标签名（如 "suot"），用于把它从发给 Telegram 的正文里去掉
// 规则按顺序尝试，第一条解析出 1–MAX_CHOICES 个选项的规则生效。

import { readFileSync, statSync } from 'node:fs';

export const MAX_CHOICES = 12;

export interface ChoiceRule {
  name: string;
  block: string;
  item: string;
  htmlSelector?: string;
}

export interface CompiledChoiceRule {
  name: string;
  block: RegExp;
  item: RegExp;
  htmlSelector?: string;
}

export interface ParsedChoices {
  rule: string;
  choices: string[];
  /** 去掉选项块后的渲染文本。 */
  text: string;
  /** 去掉选项块后的渲染 html；html 里找不到对应标签时保持原样。 */
  html: string;
}

/** 编号：1. / 1、/ 1) / 1） / A. / （1） 等。 */
const NUMBERED_ITEM = '^\\s*[（(]?(?:\\d{1,2}|[A-Za-z])[.、)）:：]\\s*(.+?)\\s*$';

export const DEFAULT_RULES: readonly ChoiceRule[] = [
  { name: 'SUOT', block: '<SUOT>([\\s\\S]*?)</SUOT>', item: NUMBERED_ITEM, htmlSelector: 'suot' },
  {
    name: '标题+编号列表',
    block: '(?:^|\\n)[ \\t]*(?:【[^】\\n]{0,12}选项[^】\\n]{0,12}】|[^\\n]{0,12}选项[:：])[ \\t]*\\n((?:[ \\t]*[（(]?(?:\\d{1,2}|[A-Za-z])[.、)）:：][^\\n]+(?:\\n|$))+)\\s*$',
    item: NUMBERED_ITEM,
  },
];

export interface RuleIssue {
  rule: string;
  message: string;
}

/** 把规则编译成正则；非法的规则被跳过并返回原因。 */
export function compileRules(rules: readonly ChoiceRule[]): { rules: CompiledChoiceRule[]; issues: RuleIssue[] } {
  const out: CompiledChoiceRule[] = [];
  const issues: RuleIssue[] = [];
  for (const r of rules) {
    try {
      out.push({ name: r.name, block: new RegExp(r.block, 'i'), item: new RegExp(r.item), htmlSelector: r.htmlSelector });
    } catch (e) {
      issues.push({ rule: r.name, message: `正则无法编译：${(e as Error).message}` });
    }
  }
  return { rules: out, issues };
}

/** 校验从 JSON 读来的规则数组，返回合法的规则和问题。 */
export function validateRules(raw: unknown): { rules: ChoiceRule[]; issues: RuleIssue[] } {
  const issues: RuleIssue[] = [];
  if (!Array.isArray(raw)) return { rules: [], issues: [{ rule: '(root)', message: '规则文件必须是 JSON 数组，参考 choice-rules.example.json。' }] };
  const rules: ChoiceRule[] = [];
  raw.forEach((r, i) => {
    const o = r as Record<string, unknown> | null;
    const name = typeof o?.name === 'string' && o.name ? o.name : `#${i + 1}`;
    if (!o || typeof o !== 'object' || typeof o.block !== 'string' || typeof o.item !== 'string' || !o.block || !o.item) {
      issues.push({ rule: name, message: '每条规则需要字符串字段 block 和 item。' });
      return;
    }
    if (o.htmlSelector !== undefined && (typeof o.htmlSelector !== 'string' || !/^[A-Za-z][\w-]*$/.test(o.htmlSelector))) {
      issues.push({ rule: name, message: 'htmlSelector 必须是标签名，例如 "suot"。' });
      return;
    }
    rules.push({ name, block: o.block, item: o.item, htmlSelector: o.htmlSelector as string | undefined });
  });
  return { rules, issues };
}

/** 用一条规则解析 raw；没命中或选项数不在 1–MAX_CHOICES 返回 null。 */
export function extractChoices(raw: string, rule: CompiledChoiceRule): string[] | null {
  const m = rule.block.exec(raw);
  if (!m || m[1] === undefined) return null;
  const choices: string[] = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const im = rule.item.exec(line);
    if (im && im[1] !== undefined && im[1].trim()) choices.push(im[1].trim());
    else if (choices.length > 0) choices[choices.length - 1] += ` ${line.trim()}`; // 选项文字折行
  }
  return choices.length >= 1 && choices.length <= MAX_CHOICES ? choices : null;
}

const norm = (s: string): string => s.replace(/\s+/g, '').replace(/[“”"'‘’*_~`]/g, '');
const plain = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

/** 选项开头的一小段（规范化后），用来判断一段文字是不是这些选项。 */
const heads = (choices: readonly string[]): string[] => choices.map((c) => norm(c).slice(0, 8)).filter(Boolean);

/** 行首的编号：数字可不带标点，字母必须带标点（避免把英文单词的首字母当编号）。 */
const OPT_PREFIX = /^\s*[（(]?(?:\d{1,2}[.、)）:：]?|[A-Za-z][.、)）:：])\s*/;

/** 一行（渲染后的文字）是不是某个选项。 */
function isOptionLine(line: string, hs: readonly string[]): boolean {
  const l = norm(line.replace(OPT_PREFIX, ''));
  return l !== '' && hs.some((h) => l.startsWith(h) || (l.length >= 2 && h.startsWith(l)));
}

function stripHtml(html: string, selector: string | undefined, choices: readonly string[]): string {
  const tail = (h: string): string => h.replace(/(?:<br\s*\/?>|\s)+$/i, '');
  const dropEmptyTailP = (h: string): string => h.replace(/(?:<p(?:\s[^>]*)?>\s*(?:<br\s*\/?>\s*)*<\/p>\s*)+$/i, '');
  if (selector) {
    const tag = selector.replace(/[^\w-]/g, '');
    // 标签可能原样保留，也可能被转义成文字（&lt;suot&gt;）
    const out = html.replace(new RegExp(`(?:<|&lt;)${tag}(?:\\s[^>]*?)?(?:>|&gt;)[\\s\\S]*?(?:<|&lt;)/${tag}(?:>|&gt;)`, 'gi'), '');
    if (out !== html) return tail(dropEmptyTailP(tail(out)));
  }
  // ST 的消毒会去掉未知标签（如 <SUOT>）只留内容，选项在正文末尾，常被 markdown 渲染成 <ol>，
  // 或者和上一行正文挤在同一个 <p> 里（用 <br> 分行）。
  // 兜底：末尾的 <ol>/<ul> 包含全部选项的开头就去掉；末尾的 <p> 只去掉尾部属于选项的行，正文行保留。
  const hs = heads(choices);
  const trimmed = tail(html);
  if (hs.length === 0) return html;
  for (const t of ['ol', 'ul', 'p']) {
    if (!new RegExp(`</${t}>$`, 'i').test(trimmed)) continue;
    const i = trimmed.toLowerCase().lastIndexOf(`<${t}`);
    if (i < 0) continue;
    const frag = trimmed.slice(i);
    if (!hs.every((h) => norm(plain(frag)).includes(h))) continue;
    if (t !== 'p') return tail(trimmed.slice(0, i));
    const open = /^<p(?:\s[^>]*)?>/i.exec(frag)?.[0];
    if (!open) continue;
    const lines = frag.slice(open.length, -'</p>'.length).split(/<br\s*\/?>/i);
    let removed = 0;
    while (lines.length > 0) {
      const line = plain(lines[lines.length - 1]);
      if (!norm(line)) lines.pop();
      else if (isOptionLine(line, hs)) {
        lines.pop();
        removed++;
      } else break;
    }
    if (removed < choices.length) continue;
    const keep = lines.length > 0 ? `${open}${lines.join('<br>')}</p>` : '';
    return tail(`${trimmed.slice(0, i)}${keep}`);
  }
  return html;
}

function stripText(text: string, rule: CompiledChoiceRule, choices: readonly string[]): string {
  const viaBlock = text.replace(rule.block, '');
  if (viaBlock !== text) return viaBlock.replace(/\s+$/, '');
  // 渲染文本里没有标签：去掉末尾与选项对应的行
  const hs = heads(choices);
  const lines = text.replace(/\s+$/, '').split('\n');
  let removed = 0;
  while (lines.length > 0) {
    const line = lines[lines.length - 1];
    if (!norm(line)) lines.pop();
    else if (isOptionLine(line, hs)) {
      lines.pop();
      removed++;
    } else break;
  }
  return removed >= choices.length ? lines.join('\n').replace(/\s+$/, '') : text;
}

/**
 * 在原始消息 raw 里解析选项；同时从渲染后的 text / html 里去掉选项块。
 * raw 为空（旧页面没有上报）时返回 null。去不干净时保留原文（宁可重复，不丢内容）。
 */
export function parseChoices(raw: string | undefined, html: string, text: string, rules: readonly CompiledChoiceRule[]): ParsedChoices | null {
  if (!raw) return null;
  for (const rule of rules) {
    const choices = extractChoices(raw, rule);
    if (!choices) continue;
    return { rule: rule.name, choices, text: stripText(text, rule, choices), html: stripHtml(html, rule.htmlSelector, choices) };
  }
  return null;
}

// ───────────── 按钮 ─────────────

export interface ChoiceCallback {
  token: string;
  n: number;
}

export const encodeChoiceCallback = (token: string, n: number): string => `o|${token}|${n}`;

/** 选项消息上的“重新生成”按钮：o|<令牌>|r。 */
export const encodeChoiceRegen = (token: string): string => `o|${token}|r`;

export function decodeChoiceRegen(data: string | undefined): string | null {
  const m = /^o\|([0-9a-f]{1,16})\|r$/.exec(data ?? '');
  return m ? m[1] : null;
}

export function decodeChoiceCallback(data: string | undefined): ChoiceCallback | null {
  const m = /^o\|([0-9a-f]{1,16})\|(\d{1,2})$/.exec(data ?? '');
  return m ? { token: m[1], n: Number(m[2]) } : null;
}

const LINE_MAX = 300;

/** 选项消息正文：完整的编号选项（过长的截断，按钮发送的仍是完整文字）。 */
export function choicesText(choices: readonly string[], layout: 'numbers' | 'rows' = 'numbers'): string {
  const cps = (s: string): string => {
    const a = Array.from(s);
    return a.length > LINE_MAX ? `${a.slice(0, LINE_MAX - 1).join('')}…` : s;
  };
  return `🎲 行动选项（点下面的${layout === 'rows' ? '按钮' : '数字'}选择）\n\n${choices.map((c, i) => `${i + 1}. ${cps(c)}`).join('\n')}`;
}

const BUTTON_TEXT_MAX = 26;

/** 选项按钮：numbers 每行 4 个数字；rows 每个选项一行，带序号和前几个字（点按发送的仍是完整文字）。 */
export function choicesKeyboard(
  token: string,
  count: number,
  layout: 'numbers' | 'rows' = 'numbers',
  choices: readonly string[] = [],
): Array<Array<{ text: string; callback_data: string }>> {
  const regen = [{ text: '🔄 重新生成', callback_data: encodeChoiceRegen(token) }];
  if (layout === 'rows') {
    return [...Array.from({ length: count }, (_, i) => {
      const a = Array.from(choices[i] ?? '');
      const label = a.length > BUTTON_TEXT_MAX ? `${a.slice(0, BUTTON_TEXT_MAX - 1).join('')}…` : a.join('');
      return [{ text: `${i + 1}. ${label}`.trim(), callback_data: encodeChoiceCallback(token, i) }];
    }), regen];
  }
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < count; i += 4) {
    rows.push(Array.from({ length: Math.min(4, count - i) }, (_, k) => ({ text: String(i + k + 1), callback_data: encodeChoiceCallback(token, i + k) })));
  }
  rows.push(regen);
  return rows;
}

// ───────────── 规则文件（热加载） ─────────────

export interface RuleLogger {
  warn(msg: string): void;
}

/** 读取 choice-rules.json，按 mtime 缓存：文件改了下一次 get() 就会重新读。用户规则排在内置规则之前。 */
export class ChoiceRuleStore {
  private cached: CompiledChoiceRule[];
  private mtime = -1;
  private warned = '';

  constructor(
    private readonly file: string | undefined,
    private readonly log: RuleLogger,
  ) {
    this.cached = compileRules(DEFAULT_RULES).rules;
  }

  get(): CompiledChoiceRule[] {
    if (!this.file) return this.cached;
    let mtime: number;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      mtime = 0; // 文件不存在：只用内置规则
    }
    if (mtime === this.mtime) return this.cached;
    this.mtime = mtime;
    const issues: RuleIssue[] = [];
    let user: ChoiceRule[] = [];
    if (mtime > 0) {
      try {
        const v = validateRules(JSON.parse(readFileSync(this.file, 'utf8')));
        user = v.rules;
        issues.push(...v.issues);
      } catch (e) {
        issues.push({ rule: '(file)', message: `${this.file} 无法读取或不是合法的 JSON：${(e as Error).message.slice(0, 120)}` });
      }
    }
    const c = compileRules([...user, ...DEFAULT_RULES]);
    issues.push(...c.issues);
    this.cached = c.rules;
    const sig = JSON.stringify(issues);
    if (issues.length > 0 && sig !== this.warned) for (const i of issues) this.log.warn(`选项规则 [${i.rule}]：${i.message}`);
    this.warned = sig;
    return this.cached;
  }
}
