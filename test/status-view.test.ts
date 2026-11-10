import { describe, expect, it } from 'vitest';
import { displayWidth, escapeHtml, meter, renderStatusHtml } from '../src/server/status-view';

describe('status-view', () => {
  it('displayWidth：中文和全角算 2 列', () => {
    expect(displayWidth('TG')).toBe(2);
    expect(displayWidth('浏览器')).toBe(6);
    expect(displayWidth('（）')).toBe(4);
  });

  it('meter：按比例填充，越界时截断', () => {
    expect(meter(0, 256)).toBe('[░░░░░░░░░]');
    expect(meter(128, 256)).toBe('[█████░░░░]');
    expect(meter(999, 256)).toBe('[█████████]');
    expect(meter(10, 0)).toBe('[░░░░░░░░░]');
  });

  it('escapeHtml 只转义 Telegram HTML 需要的三个字符', () => {
    expect(escapeHtml('a<b>&"\'')).toBe('a&lt;b&gt;&amp;"\'');
  });

  it('标签按显示宽度对齐；空分组不输出', () => {
    const html = renderStatusHtml({
      issues: [],
      sections: [
        { title: '空', rows: [] },
        { title: '运行', rows: [{ label: '浏览器', mark: 'ok', value: '3 分钟' }, { label: 'API', value: 'x' }] },
      ],
    });
    expect(html).toBe('<b>📊 silly-tg  ✅</b>\n\n<b>运行</b>\n<pre>浏览器  ● 3 分钟\nAPI     x</pre>');
  });
});
