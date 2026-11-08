import { describe, expect, it } from 'vitest';
import { CARD_PLACEHOLDER, splitPlainText, streamPreview } from '../src/server/text';

describe('streamPreview', () => {
  it('普通文本原样保留（去掉首尾空白）', () => {
    expect(streamPreview('  你好，世界\n第二行 ')).toBe('你好，世界\n第二行');
  });
  it('闭合和未闭合的代码块都换成占位', () => {
    expect(streamPreview('前文\n```html\n<html><body>x</body></html>\n```\n后文')).toBe(`前文\n${CARD_PLACEHOLDER}\n后文`);
    expect(streamPreview('前文\n```html\n<html><bo')).toBe(`前文\n${CARD_PLACEHOLDER}`);
  });
  it('去掉 HTML 标签、注释和写到一半的标签', () => {
    expect(streamPreview('<p>甲</p><!-- c -->乙<span style="color:red">丙</span><div cla')).toBe('甲乙丙');
    expect(streamPreview('a < b 且 c > d')).toBe('a < b 且 c > d');
  });
  it('超长时保留尾部并加省略号', () => {
    const s = 'x'.repeat(5000) + '结尾';
    const p = streamPreview(s, 100);
    expect(p).toHaveLength(100);
    expect(p.startsWith('…')).toBe(true);
    expect(p.endsWith('结尾')).toBe(true);
  });
  it('截断不切开代理对', () => {
    const p = streamPreview('😀'.repeat(60), 11);
    expect(p.length).toBeLessThanOrEqual(11);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(p)).toBe(false);
    expect(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p)).toBe(false);
  });
});

describe('splitPlainText', () => {
  it('短文本一段', () => {
    expect(splitPlainText('hello')).toEqual(['hello']);
    expect(splitPlainText('   ')).toEqual([]);
  });
  it('优先在空行处切，每段不超限，内容不丢', () => {
    const paras = Array.from({ length: 30 }, (_, i) => `第${i}段` + '字'.repeat(300));
    const text = paras.join('\n\n');
    const parts = splitPlainText(text, 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1000);
    expect(parts.join('\n\n')).toBe(text);
  });
  it('没有分隔符时硬切', () => {
    const text = 'a'.repeat(2500);
    const parts = splitPlainText(text, 1000);
    expect(parts.map((p) => p.length)).toEqual([1000, 1000, 500]);
    expect(parts.join('')).toBe(text);
  });
  it('超过 32768 字符的回复全部保留', () => {
    const text = Array.from({ length: 400 }, (_, i) => `行${i} ` + '内容'.repeat(50)).join('\n');
    expect(text.length).toBeGreaterThan(32768);
    const parts = splitPlainText(text);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join('\n')).toBe(text);
  });
  it('硬切不切开代理对', () => {
    const parts = splitPlainText('😀'.repeat(1000), 101);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(101);
      expect(/[\uD800-\uDBFF]$/.test(p)).toBe(false);
    }
    expect(parts.join('')).toBe('😀'.repeat(1000));
  });
});
