import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  choicesKeyboard,
  decodeChoiceRegen,
  encodeChoiceRegen,
  choicesText,
  ChoiceRuleStore,
  compileRules,
  decodeChoiceCallback,
  DEFAULT_RULES,
  encodeChoiceCallback,
  extractChoices,
  MAX_CHOICES,
  parseChoices,
  validateRules,
} from '../src/server/choices';

const rules = compileRules(DEFAULT_RULES).rules;

const suot = (n: number): string => `<SUOT>\n${Array.from({ length: n }, (_, i) => `${i + 1}. 选项内容${i + 1}：微笑着说“好”`).join('\n')}\n</SUOT>`;
const body = '她抬起头，看着你。\n\n“你来了。”';

describe('parseChoices：<SUOT> 样例', () => {
  it('7 个选项；正文去掉选项块（渲染文本里保留标签的情况）', () => {
    const raw = `${body}\n\n${suot(7)}`;
    const r = parseChoices(raw, '<p>她抬起头，看着你。</p><p>“你来了。”</p><suot>1. x</suot>', raw, rules)!;
    expect(r.rule).toBe('SUOT');
    expect(r.choices).toHaveLength(7);
    expect(r.choices[2]).toBe('选项内容3：微笑着说“好”');
    expect(r.text).toBe(body);
    expect(r.html).not.toMatch(/suot/i);
  });

  it('ST 消毒去掉标签、markdown 把选项渲染成 <ol>：兜底去掉末尾列表', () => {
    const raw = `${body}\n\n${suot(3)}`;
    const html = '<p>她抬起头，看着你。</p><p>“你来了。”</p><ol><li>选项内容1：微笑着说“好”</li><li>选项内容2：微笑着说“好”</li><li>选项内容3：微笑着说“好”</li></ol>';
    const text = `她抬起头，看着你。\n\n“你来了。”\n\n选项内容1：微笑着说“好”\n选项内容2：微笑着说“好”\n选项内容3：微笑着说“好”`;
    const r = parseChoices(raw, html, text, rules)!;
    expect(r.html).toBe('<p>她抬起头，看着你。</p><p>“你来了。”</p>');
    expect(r.text).toBe('她抬起头，看着你。\n\n“你来了。”');
  });

  it('ST 消毒后选项和上一行正文挤在同一个 <p>（用 <br> 分行）：只去掉选项行，正文保留', () => {
    const raw = `她抬起头。\n<SUOT>\n1. 去酒馆喝一杯\n2. 回家睡觉\n</SUOT>`;
    const html = '<p>她抬起头。<br><br>1. 去酒馆喝一杯<br>2. 回家睡觉<br></p>';
    const text = '她抬起头。\n\n1. 去酒馆喝一杯\n2. 回家睡觉';
    const r = parseChoices(raw, html, text, rules)!;
    expect(r.html).toBe('<p>她抬起头。</p>');
    expect(r.text).toBe('她抬起头。');
  });

  it('标签原样保留在 <p> 里时，不留下空段落；标签被转义成文字也能去掉', () => {
    const raw = `她抬起头。\n\n${suot(2)}`;
    const r1 = parseChoices(raw, '<p>她抬起头。</p><p><suot>1. a<br>2. b</suot></p>', raw, rules)!;
    expect(r1.html).toBe('<p>她抬起头。</p>');
    const r2 = parseChoices(raw, '<p>她抬起头。</p><p>&lt;SUOT&gt;<br>1. a<br>&lt;/SUOT&gt;</p>', raw, rules)!;
    expect(r2.html).toBe('<p>她抬起头。</p>');
  });

  it('文本兜底：正文末行恰好是一个很短的词，不会被当成选项', () => {
    const raw = `她说：\n好\n<SUOT>\n1. 好的，我知道了\n2. 不行\n</SUOT>`;
    const r = parseChoices(raw, '', '她说：\n好\n1. 好的，我知道了\n2. 不行', rules)!;
    expect(r.text).toBe('她说：\n好');
  });

  it('选项折行并入上一项；中文顿号和括号编号也能识别', () => {
    const raw = '<SUOT>\n1、第一项\n还没说完\n2）第二项\n（3）第三项\n</SUOT>';
    expect(extractChoices(raw, rules[0])).toEqual(['第一项 还没说完', '第二项', '第三项']);
  });

  it('旧页面没有 raw：不解析', () => {
    expect(parseChoices(undefined, '<p>x</p>', 'x', rules)).toBeNull();
    expect(parseChoices('', '<p>x</p>', 'x', rules)).toBeNull();
  });
});

describe('parseChoices：容错', () => {
  it('没有选项块、未闭合、空块、超过上限：返回 null，不丢正文', () => {
    expect(parseChoices(body, '<p>x</p>', body, rules)).toBeNull();
    expect(parseChoices(`${body}\n<SUOT>\n1. a`, '', body, rules)).toBeNull();
    expect(parseChoices(`${body}\n<SUOT>\n\n</SUOT>`, '', body, rules)).toBeNull();
    expect(parseChoices(`${body}\n${suot(MAX_CHOICES + 1)}`, '', body, rules)).toBeNull();
    expect(parseChoices(`${body}\n${suot(MAX_CHOICES)}`, '', body, rules)!.choices).toHaveLength(MAX_CHOICES);
  });

  it('去不干净时保留原文', () => {
    const raw = `${body}\n${suot(2)}`;
    const r = parseChoices(raw, '<p>别的内容</p>', '别的内容', rules)!;
    expect(r.choices).toHaveLength(2);
    expect(r.text).toBe('别的内容');
    expect(r.html).toBe('<p>别的内容</p>');
  });
});

describe('标题+编号列表 内置规则', () => {
  it('【行动选项】 加编号', () => {
    const raw = `${body}\n\n【行动选项】\nA. 去酒馆\nB. 回家\nC. 沉默`;
    const r = parseChoices(raw, '', raw, rules)!;
    expect(r.rule).toBe('标题+编号列表');
    expect(r.choices).toEqual(['去酒馆', '回家', '沉默']);
    expect(r.text).toBe(body);
  });
  it('正文里普通的编号列表不会被当成选项', () => {
    expect(parseChoices('你需要带上：\n1. 剑\n2. 盾', '', '', rules)).toBeNull();
  });
});

describe('性能', () => {
  it('“选项：”后面是一长行带很多编号、末尾还有别的文字：不会指数回溯', () => {
    const line = Array.from({ length: 40 }, (_, i) => `${i + 1}.选项`).join(' ');
    const raw = `开头\n选项：\n${line}\n然后是结尾的正文`;
    const t0 = Date.now();
    expect(parseChoices(raw, '', raw, rules)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('规则校验与编译', () => {
  it('validateRules：非数组、缺字段、非法 htmlSelector', () => {
    expect(validateRules({}).issues).toHaveLength(1);
    const v = validateRules([{ name: 'a', block: 'x(.*)', item: '(.*)' }, { name: 'b' }, { name: 'c', block: 'x', item: 'y', htmlSelector: '<bad>' }]);
    expect(v.rules.map((r) => r.name)).toEqual(['a']);
    expect(v.issues.map((i) => i.rule)).toEqual(['b', 'c']);
  });
  it('compileRules：非法正则被跳过并说明原因', () => {
    const c = compileRules([{ name: 'bad', block: '(', item: '(.*)' }, ...DEFAULT_RULES]);
    expect(c.issues).toHaveLength(1);
    expect(c.issues[0].rule).toBe('bad');
    expect(c.rules).toHaveLength(DEFAULT_RULES.length);
  });
});

describe('按钮', () => {
  it('回调编码往返；非法数据返回 null', () => {
    expect(decodeChoiceCallback(encodeChoiceCallback('abcd1234', 6))).toEqual({ token: 'abcd1234', n: 6 });
    expect(decodeChoiceCallback('o|zz|1')).toBeNull();
    expect(decodeChoiceCallback('c|abcd1234|1')).toBeNull();
    expect(encodeChoiceCallback('abcd1234', 11).length).toBeLessThanOrEqual(64);
  });
  it('键盘每行 4 个数字；正文截断过长选项', () => {
    const kb = choicesKeyboard('abcd1234', 7);
    expect(kb.map((r) => r.map((b) => b.text))).toEqual([['1', '2', '3', '4'], ['5', '6', '7'], ['🔄']]);
    const t = choicesText(['短', 'x'.repeat(500)]);
    expect(t).toMatch(/^行动选项/);
    expect(t).toMatch(/1\. 短/);
    expect(t.split('\n').at(-1)!.length).toBeLessThan(310);
  });
  it('🔄 回调编码：能解出令牌，且不会被当作选项', () => {
    expect(decodeChoiceRegen(encodeChoiceRegen('abcd1234'))).toBe('abcd1234');
    expect(decodeChoiceCallback(encodeChoiceRegen('abcd1234'))).toBeNull();
    expect(decodeChoiceRegen('o|abcd1234|1')).toBeNull();
    expect(encodeChoiceRegen('abcd1234').length).toBeLessThanOrEqual(64);
  });
  it('rows 排版：每个选项一行，文字过长截断', () => {
    const kb = choicesKeyboard('abcd1234', 2, 'rows', ['短', 'x'.repeat(100)]);
    expect(kb).toHaveLength(3);
    expect(kb[2][0].text).toBe('🔄');
    expect(kb[0][0].text).toBe('1. 短');
    expect(Array.from(kb[1][0].text).length).toBeLessThanOrEqual(30);
    expect(kb[1][0].callback_data).toBe(encodeChoiceCallback('abcd1234', 1));
    expect(choicesText(['a'], 'rows')).toMatch(/点下面的按钮/);
  });
});

describe('ChoiceRuleStore 热加载', () => {
  it('文件不存在只用内置规则；修改后下一次 get 生效；坏文件只警告一次', () => {
    const dir = mkdtempSync(join(tmpdir(), 'choices-'));
    const file = join(dir, 'choice-rules.json');
    const warns: string[] = [];
    const store = new ChoiceRuleStore(file, { warn: (m) => warns.push(m) });
    try {
      expect(store.get().map((r) => r.name)).toEqual(['SUOT', '标题+编号列表']);
      writeFileSync(file, JSON.stringify([{ name: '自定义', block: '<opt>([\\s\\S]*?)</opt>', item: '^-\\s*(.+)$' }]));
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      expect(store.get().map((r) => r.name)).toEqual(['自定义', 'SUOT', '标题+编号列表']);
      writeFileSync(file, '{坏的');
      utimesSync(file, new Date(), new Date(Date.now() + 10000));
      expect(store.get().map((r) => r.name)).toEqual(['SUOT', '标题+编号列表']);
      store.get();
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/不是合法的 JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
