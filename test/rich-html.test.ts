import { describe, expect, it } from 'vitest';
import { Parser } from 'htmlparser2';
import {
  isFrontendCardSource,
  RICH_LIMITS,
  splitPlain,
  toPlainTexts,
  toRichMessages,
  type RichPart,
} from '../src/shared/rich-html';

// 所有夹具都是自己编写的，不含任何用户内容。

const html = (parts: RichPart[]): string => parts.map((p) => p.html).join('\n');
const flat = (s: string): string => s.replace(/\s+/g, '');
const joinedText = (parts: RichPart[]): string => parts.map((p) => p.text).join('\n');

/** 统计输出 HTML 的最大嵌套深度、块级标签数量、媒体数量。 */
function stats(out: string): { depth: number; media: number; tags: Set<string> } {
  let depth = 0;
  let max = 0;
  let media = 0;
  const tags = new Set<string>();
  const voids = new Set(['br', 'hr', 'img', 'input']);
  const p = new Parser(
    {
      onopentag(name) {
        tags.add(name);
        if (['img', 'video', 'audio', 'tg-document'].includes(name)) media++;
        if (voids.has(name)) return;
        depth++;
        max = Math.max(max, depth);
      },
      onclosetag(name) {
        if (voids.has(name)) return;
        depth--;
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true },
  );
  p.write(out);
  p.end();
  return { depth: max, media, tags };
}

describe('常见 ST 输出', () => {
  it('段落与强调', () => {
    const [part] = toRichMessages('<p>你好，<em>旅人</em>。<strong>欢迎</strong>回来。</p><p>第二段</p>');
    expect(part.html).toBe('<p>你好，<i>旅人</i>。<b>欢迎</b>回来。</p><p>第二段</p>');
    expect(part.text).toContain('你好，旅人。欢迎回来。');
  });

  it('del、ins、u、s、mark、sub、sup 映射', () => {
    const out = html(toRichMessages('<p><del>a</del><s>b</s><strike>c</strike><ins>d</ins><u>e</u><mark>f</mark><sub>g</sub><sup>h</sup></p>'));
    expect(out).toBe('<p><s>a</s><s>b</s><s>c</s><u>d</u><u>e</u><mark>f</mark><sub>g</sub><sup>h</sup></p>');
  });

  it('引用块保留，内部段落压成一个引用', () => {
    const out = html(toRichMessages('<blockquote><p>第一行</p><p>第二行</p></blockquote>'));
    expect(out).toBe('<blockquote>第一行<br>第二行</blockquote>');
  });

  it('有序与无序列表，含嵌套', () => {
    const out = html(
      toRichMessages('<ul><li>甲</li><li>乙<ol start="3"><li>丙</li></ol></li></ul>'),
    );
    expect(out).toContain('<ul><li>');
    expect(out).toContain('<ol start="3"><li>');
    expect(flat(joinedText(toRichMessages('<ul><li>甲</li><li>乙</li></ul>')))).toBe('甲乙');
  });

  it('代码块带语言，行内 code 保留', () => {
    const out = html(
      toRichMessages('<pre><code class="language-python">print(1 &lt; 2)\nx = 3</code></pre><p>用 <code>ls</code> 查看</p>'),
    );
    expect(out).toContain('<pre><code class="language-python">print(1 &lt; 2)\nx = 3</code></pre>');
    expect(out).toContain('<code>ls</code>');
  });

  it('代码块的语言类名被清洗', () => {
    const out = html(toRichMessages('<pre><code class="evil&quot; onclick=&quot;x">a</code></pre>'));
    expect(out).toBe('<pre>a</pre>');
  });

  it('代码块内的 HTML 作为文本转义', () => {
    const out = html(toRichMessages('<pre><code>&lt;div&gt;hi&lt;/div&gt;</code></pre>'));
    expect(out).toBe('<pre>&lt;div&gt;hi&lt;/div&gt;</pre>');
  });

  it('表格保留表头、单元格、colspan', () => {
    const out = html(
      toRichMessages(
        '<table><thead><tr><th>名称</th><th>值</th></tr></thead><tbody><tr><td colspan="2">合并</td></tr><tr><td>a</td><td><b>1</b></td></tr></tbody></table>',
      ),
    );
    expect(out).toBe(
      '<table><tr><th>名称</th><th>值</th></tr><tr><td colspan="2">合并</td></tr><tr><td>a</td><td><b>1</b></td></tr></table>',
    );
  });

  it('q 转为中文引号文字', () => {
    expect(html(toRichMessages('<p>他说<q>走吧</q></p>'))).toBe('<p>他说“走吧”</p>');
    // ST 生成的 <q> 里已经带着引号，不能再套一层
    expect(html(toRichMessages('<p>他说<q>"走吧"</q></p>'))).toBe('<p>他说"走吧"</p>');
    expect(html(toRichMessages('<p>他说<q>“走吧”</q></p>'))).toBe('<p>他说“走吧”</p>');
  });

  it('font、span 的样式与颜色被去掉，文字保留', () => {
    const out = html(
      toRichMessages('<p><font color="red">红字</font><span style="color:#f00;font-size:20px" class="x">内联样式</span></p>'),
    );
    expect(out).toBe('<p>红字内联样式</p>');
  });

  it('图片拆成独立媒体块，前后文字各成一段', () => {
    const out = html(toRichMessages('<p>前<img src="https://example.com/a.png" alt="A">后</p>'));
    expect(out).toBe('<p>前</p><img src="https://example.com/a.png"/><p>后</p>');
  });

  it('链接内的图片也被提到块级', () => {
    const out = html(toRichMessages('<p><a href="https://example.com/x"><img src="https://example.com/a.png"></a></p>'));
    expect(stats(out).media).toBe(1);
    expect(out).toContain('<img src="https://example.com/a.png"/>');
  });

  it('data: 图片不能发送，降级为 alt 文字', () => {
    const out = html(toRichMessages('<p><img src="data:image/png;base64,AAAA" alt="头像"></p>'));
    expect(out).toBe('<p>头像</p>');
  });

  it('标题、分隔线', () => {
    expect(html(toRichMessages('<h2>章节</h2><hr><p>正文</p>'))).toBe('<h2>章节</h2><hr/><p>正文</p>');
  });

  it('div 透明，裸文本与 br 合成段落', () => {
    const out = html(toRichMessages('<div>开头<br>换行<div>内层</div></div>'));
    expect(out).toBe('<p>开头<br>换行</p><p>内层</p>');
  });

  it('details/summary 保留', () => {
    const out = html(toRichMessages('<details open><summary>标题</summary><p>内容</p></details>'));
    expect(out).toBe('<details open><summary>标题</summary><p>内容</p></details>');
  });

  it('http、mailto、tel 链接保留，其余只留文字', () => {
    const out = html(
      toRichMessages(
        '<p><a href="https://example.com/?a=1&amp;b=2" target="_blank" class="c">甲</a><a href="mailto:a@b.co">乙</a><a href="tel:+123">丙</a><a href="tg://user?id=1">丁</a><a href="#top">戊</a></p>',
      ),
    );
    expect(out).toBe(
      '<p><a href="https://example.com/?a=1&amp;b=2">甲</a><a href="mailto:a@b.co">乙</a><a href="tel:+123">丙</a>丁戊</p>',
    );
  });

  it('空白折叠：缩进与换行不产生多余内容', () => {
    const out = html(toRichMessages('<div>\n  <p>  甲   乙  </p>\n  <p>丙</p>\n</div>'));
    expect(out).toBe('<p>甲 乙</p><p>丙</p>');
  });

  it('纯文本输入变成段落，换行变 br', () => {
    expect(html(toRichMessages('你好\n世界 & <3'))).toBe('<p>你好 世界 &amp; &lt;3</p>');
  });

  it('空输入与空白输入返回空数组', () => {
    expect(toRichMessages('')).toEqual([]);
    expect(toRichMessages('  \n <div> </div> ')).toEqual([]);
  });

  it('display:none 的内容被丢弃', () => {
    expect(html(toRichMessages('<p>可见</p><div style="display: none">隐藏</div>'))).toBe('<p>可见</p>');
  });
});

describe('恶意与异常输入', () => {
  it('javascript: 链接（含空白与大小写绕过）只留文字', () => {
    const out = html(
      toRichMessages(
        '<p><a href="javascript:alert(1)">甲</a><a href=" JaVa\tScRiPt:alert(1)">乙</a><a href="data:text/html,x">丙</a><a href="vbscript:x">丁</a></p>',
      ),
    );
    expect(out).toBe('<p>甲乙丙丁</p>');
  });

  it('事件属性、style、class、id 全部去掉', () => {
    const out = html(
      toRichMessages('<p onclick="x()" style="color:red" class="a" id="b"><b onmouseover="y()">加粗</b><img src="https://e.com/a.png" onerror="alert(1)" width="1"></p>'),
    );
    expect(out).not.toMatch(/onclick|onmouseover|onerror|style=|class=|id=|width/);
    expect(out).toContain('<b>加粗</b>');
  });

  it('script、style、iframe、object、template 连同内容被删除', () => {
    const out = html(
      toRichMessages(
        '<p>甲</p><script>alert(1)</script><style>p{color:red}</style><iframe src="https://e.com">帧内</iframe><object>obj</object><noscript>ns</noscript><template>tpl</template><p>乙</p>',
      ),
    );
    expect(out).toBe('<p>甲</p><p>乙</p>');
  });

  it('文本里的伪标签被转义，不会变成标签', () => {
    const out = html(toRichMessages('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'));
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('未知标签只保留内容', () => {
    expect(html(toRichMessages('<p><blink>闪</blink><custom-el>定制</custom-el></p>'))).toBe('<p>闪定制</p>');
  });

  it('video/audio 只接受 http(s) 的 src', () => {
    const out = html(
      toRichMessages(
        '<video src="https://e.com/v.mp4"></video><audio><source src="https://e.com/a.mp3"></audio><video src="file:///etc/passwd"></video>',
      ),
    );
    expect(out).toBe('<video src="https://e.com/v.mp4"></video><audio src="https://e.com/a.mp3"></audio>');
  });

  // 未闭合标签的个数：远超建树上限 MAX_TREE_DEPTH（128），足以覆盖“压平”分支。
  // 不用 10 万：htmlparser2 的标签栈用 unshift，未闭合标签多时耗时是平方级（10 万个约 1.3 秒），
  // 并行跑测试、CPU 繁忙时会超过 5 秒的用例超时。
  const UNCLOSED = 20_000;

  it('超深嵌套（块与行内）不抛错，输出深度不超过 16', () => {
    const n = 5000;
    const blocks = '<blockquote><div><ul><li>'.repeat(n) + '深' + '</li></ul></div></blockquote>'.repeat(n);
    const inline = '<p>' + '<b><i>'.repeat(n) + '深' + '</i></b>'.repeat(n) + '</p>';
    for (const input of [blocks, inline, '<div>'.repeat(UNCLOSED) + '深']) {
      const parts = toRichMessages(input);
      expect(parts.length).toBeGreaterThan(0);
      expect(joinedText(parts)).toContain('深');
      for (const p of parts) expect(stats(p.html).depth).toBeLessThanOrEqual(RICH_LIMITS.maxDepth);
    }
  });

  it('列表深度嵌套也受限制', () => {
    const input = '<ul><li>x'.repeat(40) + '</li></ul>'.repeat(40);
    const parts = toRichMessages(input);
    for (const p of parts) expect(stats(p.html).depth).toBeLessThanOrEqual(RICH_LIMITS.maxDepth);
  });

  it('1 MB 以上输入能在合理时间内完成并分段', () => {
    const para = '<p>' + '这是一段用于压力测试的文字。'.repeat(50) + '</p>';
    const input = para.repeat(2000); // 约 1.4 MB
    const t = Date.now();
    const parts = toRichMessages(input);
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(parts.length).toBeGreaterThan(10);
    for (const p of parts) expect(Array.from(p.text).length).toBeLessThanOrEqual(RICH_LIMITS.maxChars);
  });

  it('畸形 HTML（未闭合、错位）不抛错且保留正文', () => {
    const out = html(toRichMessages('<p>甲<b>乙<i>丙</b>丁</i></p></div><li>戊'));
    expect(flat(out.replace(/<[^>]+>/g, ''))).toBe('甲乙丙丁戊');
  });
});

describe('分段与上限', () => {
  const para = (s: string): string => `<p>${s}</p>`;

  it('小消息只有一段', () => {
    expect(toRichMessages(para('短'))).toHaveLength(1);
  });

  it('默认上限与文档一致', () => {
    expect(RICH_LIMITS).toMatchObject({ maxChars: 32768, maxBlocks: 500, maxDepth: 16, maxMedia: 50, maxTableColumns: 20 });
  });

  it('字符数边界：正好等于上限不切，多一个字符就切', () => {
    const exact = toRichMessages(para('a'.repeat(100)), { maxChars: 100 });
    expect(exact).toHaveLength(1);
    const over = toRichMessages(para('a'.repeat(101)), { maxChars: 100 });
    expect(over.length).toBeGreaterThan(1);
    for (const p of over) expect(Array.from(p.text).length).toBeLessThanOrEqual(100);
  });

  it('在块边界切分，不拆开可容纳的段落', () => {
    const input = Array.from({ length: 10 }, (_, i) => para(`${i}`.repeat(40))).join('');
    const parts = toRichMessages(input, { maxChars: 100 });
    expect(parts.length).toBe(5);
    for (const p of parts) expect((p.html.match(/<p>/g) ?? []).length).toBe(2);
  });

  it('单个超长段落按文本切开，内容完整，优先在空白处断开', () => {
    const words = Array.from({ length: 400 }, (_, i) => `词${i}`).join(' ');
    const parts = toRichMessages(para(`<b>${words}</b>`), { maxChars: 200 });
    expect(parts.length).toBeGreaterThan(3);
    expect(flat(joinedText(parts))).toBe(flat(words));
    for (const p of parts) {
      expect(Array.from(p.text).length).toBeLessThanOrEqual(200);
      expect(p.html.startsWith('<p><b>')).toBe(true); // 格式包裹在每段重新打开
    }
    // 断点落在空白处：除最后一段外，每段都不会把“词12”这样的词切成两半
    const tokens = joinedText(parts).split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(words.split(' '));
  });

  it('没有空白的超长文本硬切，且不切开代理对', () => {
    const emoji = '😀'.repeat(300);
    const parts = toRichMessages(para(emoji), { maxChars: 100 });
    expect(parts.length).toBe(3);
    expect(parts.map((p) => p.text).join('')).toBe(emoji);
    for (const p of parts) expect(Array.from(p.text).length).toBeLessThanOrEqual(100);
  });

  it('超长代码块按行切开，每段仍是 pre', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const parts = toRichMessages(`<pre><code class="language-js">${lines}</code></pre>`, { maxChars: 120 });
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(p.html).toMatch(/^<pre><code class="language-js">[\s\S]*<\/code><\/pre>$/);
    expect(parts.map((p) => p.text).join('')).toBe(lines);
  });

  it('块数上限：按 maxBlocks 分段', () => {
    const input = Array.from({ length: 25 }, (_, i) => para(`第${i}段`)).join('');
    const parts = toRichMessages(input, { maxBlocks: 10 });
    expect(parts).toHaveLength(3);
    for (const p of parts) expect((p.html.match(/<p>/g) ?? []).length).toBeLessThanOrEqual(10);
    expect(flat(joinedText(parts))).toBe(flat(Array.from({ length: 25 }, (_, i) => `第${i}段`).join('')));
  });

  it('默认 500 块上限：501 个段落至少分两段', () => {
    const input = Array.from({ length: 501 }, () => para('x')).join('');
    const parts = toRichMessages(input);
    expect(parts).toHaveLength(2);
    expect((parts[0].html.match(/<p>/g) ?? []).length).toBe(500);
  });

  it('列表项过多时按项切开，每段仍是完整的 ul', () => {
    const items = Array.from({ length: 30 }, (_, i) => `<li>项${i}</li>`).join('');
    const parts = toRichMessages(`<ul>${items}</ul>`, { maxBlocks: 11 });
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(p.html).toMatch(/^<ul>.*<\/ul>$/);
      expect((p.html.match(/<li>/g) ?? []).length).toBeLessThanOrEqual(10);
    }
    expect(flat(joinedText(parts))).toBe(flat(Array.from({ length: 30 }, (_, i) => `项${i}`).join('')));
  });

  it('有序列表切开后编号接续', () => {
    const items = Array.from({ length: 6 }, (_, i) => `<li>项${i}</li>`).join('');
    const parts = toRichMessages(`<ol>${items}</ol>`, { maxBlocks: 4 });
    expect(parts.length).toBe(2);
    expect(parts[0].html).toMatch(/^<ol>/);
    expect(parts[1].html).toMatch(/^<ol start="4">/);
  });

  it('媒体数量上限', () => {
    const imgs = Array.from({ length: 7 }, (_, i) => `<img src="https://e.com/${i}.png">`).join('');
    const parts = toRichMessages(imgs, { maxMedia: 3 });
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(stats(p.html).media).toBeLessThanOrEqual(3);
    expect(parts.reduce((n, p) => n + stats(p.html).media, 0)).toBe(7);
  });

  it('表格按行切开', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `<tr><td>r${i}</td></tr>`).join('');
    const parts = toRichMessages(`<table>${rows}</table>`, { maxBlocks: 6 });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.html).toMatch(/^<table>.*<\/table>$/);
    expect(flat(joinedText(parts))).toBe(flat(Array.from({ length: 12 }, (_, i) => `r${i}`).join('')));
  });

  it('超过 20 列的表格降级为逐行文字，内容不丢', () => {
    const cells = Array.from({ length: 25 }, (_, i) => `<td>c${i}</td>`).join('');
    const parts = toRichMessages(`<table><tr>${cells}</tr></table>`);
    expect(stats(html(parts)).tags.has('table')).toBe(false);
    for (let i = 0; i < 25; i++) expect(joinedText(parts)).toContain(`c${i}`);
  });

  it('引用块内超长内容被切开，每段仍是引用', () => {
    const text = Array.from({ length: 100 }, (_, i) => `句${i}`).join('，');
    const parts = toRichMessages(`<blockquote>${text}</blockquote>`, { maxChars: 100 });
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.html).toMatch(/^<blockquote>/);
    expect(flat(joinedText(parts))).toBe(flat(text));
  });

  it('默认上限下的真实超长回复（>32768 字符）分段后内容完整', () => {
    const paras = Array.from({ length: 300 }, (_, i) => `第${i}段：` + '内容'.repeat(60));
    const input = paras.map((p) => `<p>${p}</p>`).join('');
    const parts = toRichMessages(input);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const p of parts) expect(Array.from(p.text).length).toBeLessThanOrEqual(32768);
    expect(flat(joinedText(parts))).toBe(flat(paras.join('')));
  });

  it('分段后的拼接与不分段的结果文字一致（含格式与列表混合）', () => {
    const input =
      '<h2>标题</h2>' +
      Array.from({ length: 40 }, (_, i) => `<p>段${i} <em>斜</em><strong>粗</strong> 文字文字文字</p>`).join('') +
      '<ul>' + Array.from({ length: 20 }, (_, i) => `<li>项${i}</li>`).join('') + '</ul>' +
      '<blockquote>引用一二三四五六七八九十</blockquote>';
    const whole = flat(joinedText(toRichMessages(input)));
    for (const maxChars of [30, 77, 200]) {
      expect(flat(joinedText(toRichMessages(input, { maxChars })))).toBe(whole);
    }
  });
});

describe('失败回退与纯文本', () => {
  it('toRichMessages 永不抛错：内部转换异常时回退为纯文本分段', () => {
    const parts = toRichMessages('<p>甲<b>乙</b></p>', {
      onPre: () => {
        throw new Error('boom');
      },
    });
    // 没有 pre，不会触发钩子；真正触发的情形见下一条
    expect(parts[0].text).toContain('甲乙');
  });

  it('钩子抛错时回退为纯文本，正文不丢，按 maxChars 分段', () => {
    const body = '这是正文。'.repeat(100);
    const parts = toRichMessages(`<p>${body}</p><pre>x</pre>`, {
      maxChars: 200,
      onPre: () => {
        throw new Error('boom');
      },
    });
    expect(parts.length).toBeGreaterThan(2);
    expect(flat(joinedText(parts))).toBe(flat(body + 'x'));
    for (const p of parts) {
      expect(Array.from(p.text).length).toBeLessThanOrEqual(200);
      expect(p.html).toMatch(/^<p>[^<]*(<br>[^<]*)*<\/p>$/); // 只含段落与换行
    }
  });

  it('非字符串输入也不抛错', () => {
    expect(toRichMessages(undefined as unknown as string)).toEqual([]);
    expect(toRichMessages(123 as unknown as string)).toEqual([]);
  });

  it('toPlainTexts：去标签、解码实体、块之间换行，按 4096 分段', () => {
    expect(toPlainTexts('<p>甲 &amp; 乙</p><p>丙<br>丁</p><script>x</script>')).toEqual(['甲 & 乙\n丙\n丁']);
    const long = '<p>' + 'a'.repeat(10000) + '</p>';
    const parts = toPlainTexts(long);
    expect(parts.length).toBe(3);
    for (const p of parts) expect(Array.from(p).length).toBeLessThanOrEqual(4096);
    expect(parts.join('')).toBe('a'.repeat(10000));
  });

  it('toPlainTexts 对超深嵌套不抛错', () => {
    const parts = toPlainTexts('<div>'.repeat(20_000) + '深'); // 规模的取舍见上面 UNCLOSED 的说明
    expect(parts.join('')).toContain('深');
  });

  it('splitPlain 优先在换行和空白处断开，拼接后与原文逐字一致', () => {
    const text = '第一行\n第二行 有空格\n' + 'x'.repeat(30) + '\n结尾';
    const parts = splitPlain(text, 12);
    expect(parts.join('')).toBe(text);
    for (const p of parts) expect(Array.from(p).length).toBeLessThanOrEqual(12);
    expect(parts[0]).toBe('第一行\n第二行 有空格\n'.slice(0, parts[0].length));
  });
});

describe('前端卡片钩子', () => {
  const card = '<pre><code>&lt;html&gt;&lt;body&gt;&lt;div id="app"&gt;&lt;/div&gt;&lt;/body&gt;&lt;/html&gt;</code></pre>';

  it('isFrontendCardSource 与酒馆助手判定一致', () => {
    expect(isFrontendCardSource('<html><body></body></html>')).toBe(true);
    expect(isFrontendCardSource('<head><title>x</title>')).toBe(true);
    expect(isFrontendCardSource('<body class="a">')).toBe(true);
    expect(isFrontendCardSource('console.log(1)')).toBe(false);
  });

  it('默认把卡片当普通代码块，正文不丢', () => {
    const out = html(toRichMessages(`<p>前文</p>${card}<p>后文</p>`));
    expect(out).toContain('<pre>');
    expect(out).toContain('&lt;div id="app"&gt;');
    expect(out).toContain('前文');
    expect(out).toContain('后文');
  });

  it('dialogueStyle：对话加粗或高亮，默认只保留引号；已有引号不重复', () => {
    const src = '<p>她说<q>"走吧"</q>，又补了一句<q>快点</q><em>（回头）</em></p>';
    expect(html(toRichMessages(src))).toBe('<p>她说"走吧"，又补了一句“快点”<i>（回头）</i></p>');
    expect(html(toRichMessages(src, { dialogueStyle: 'bold' }))).toBe('<p>她说<b>"走吧"</b>，又补了一句<b>“快点”</b><i>（回头）</i></p>');
    expect(html(toRichMessages(src, { dialogueStyle: 'italic' }))).toBe('<p>她说<i>"走吧"</i>，又补了一句<i>“快点”</i><i>（回头）</i></p>');
    expect(html(toRichMessages(src, { dialogueStyle: 'mark' }))).toBe('<p>她说<mark>"走吧"</mark>，又补了一句<mark>“快点”</mark><i>（回头）</i></p>');
    // 样式只作用于当次调用
    expect(html(toRichMessages('<p><q>走</q></p>'))).toBe('<p>“走”</p>');
  });

  it('dialogueStyle 也作用于「」『』对话（ST 不会把它们包成 <q>）；<q> 里的不重复套', () => {
    const src = '<p>她低声说「借过，劳烦借过……」，心想『糟了』。</p><p><q>他说「好」</q></p>';
    expect(html(toRichMessages(src, { dialogueStyle: 'italic' }))).toBe('<p>她低声说<i>「借过，劳烦借过……」</i>，心想<i>『糟了』</i>。</p><p><i>“他说「好」”</i></p>');
    expect(html(toRichMessages(src))).toBe('<p>她低声说「借过，劳烦借过……」，心想『糟了』。</p><p>“他说「好」”</p>');
  });

  it('酒馆助手的“显示前端代码块”按钮不进正文，代码块本身默认保留', () => {
    const out = html(
      toRichMessages(`<p>前文</p><div class="TH-render">${card}<div class="TH-collapse-code-block-button">显示前端代码块</div><iframe srcdoc="x"></iframe></div>`),
    );
    expect(out).not.toContain('显示前端代码块');
    expect(out).toContain('<pre>');
    expect(out).toContain('前文');
  });

  it("onPre 返回 'drop' 时移除该 pre", () => {
    const seen: boolean[] = [];
    const out = html(
      toRichMessages(`<p>前文</p>${card}<pre>echo 1</pre>`, {
        onPre: ({ isCard }) => {
          seen.push(isCard);
          return isCard ? 'drop' : 'keep';
        },
      }),
    );
    expect(seen).toEqual([true, false]);
    expect(out).toBe('<p>前文</p><pre>echo 1</pre>');
  });
});
