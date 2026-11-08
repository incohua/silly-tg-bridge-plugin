// 把 ST 渲染后的消息 HTML（.mes_text 的 innerHTML）转成 Telegram Rich Message 的 HTML，并按上限分段。
// 纯函数，不依赖浏览器 DOM；只依赖 htmlparser2 的流式解析器。
//
// 平台规则摘录（https://core.telegram.org/bots/api/rich-messages.md ，2026-11-07 核对）：
//   - 限制：32768 个 UTF-8 字符（富文本正文，含公式源码）；500 个块（含嵌套块、列表项、表格行、引用块、details）；
//     16 层嵌套；50 个媒体；表格 20 列。
//   - HTML 模式只支持文档列出的标签；不支持的标签会被拒绝，所以这里一律只输出白名单标签。
//   - 命名实体只支持 &lt; &gt; &amp; &quot; &apos; &nbsp; 等少数几个，所以输出只用 &amp; &lt; &gt; &quot;，
//     其余字符直接以 UTF-8 输出。
//   - 图片、视频、音频只能是独立的媒体块，且只支持 http/https。
//   - 表格单元格只能含行内格式。
//   - 代码块语言通过 <pre><code class="language-x"> 指定；独立的 <code> 不能带语言。
//   - sendRichMessage 的参数是 rich_message: { html }（InputRichMessage 的 html / markdown / blocks 三选一）。
//   文档没有写明 32768 是否把标记算进去；这里只按可见文字计数（含块间换行）。

import { Parser } from 'htmlparser2';

export const RICH_LIMITS = {
  maxChars: 32768,
  maxBlocks: 500,
  maxDepth: 16,
  maxMedia: 50,
  maxTableColumns: 20,
} as const;

export interface RichPart {
  /** 传给 sendRichMessage 的 rich_message.html */
  html: string;
  /** 这一段的可见纯文本，块之间用 \n 分隔 */
  text: string;
}

export interface PreInfo {
  text: string;
  /** 内容像酒馆助手的前端卡片（见 isFrontendCardSource） */
  isCard: boolean;
}

export interface RichOptions {
  /** 只能调低，不能超过 RICH_LIMITS */
  maxChars?: number;
  maxBlocks?: number;
  maxMedia?: number;
  /** 每个 <pre> 调用一次。返回 'drop' 时移除该代码块；默认保留。card-render 任务用它拿走卡片源码。 */
  onPre?: (info: PreInfo) => 'keep' | 'drop' | void;
  /** 对话（ST 渲染成 <q> 的带引号内容）的呈现：bold 加粗、italic 斜体、mark 高亮、plain 只保留引号。默认 plain。 */
  dialogueStyle?: DialogueStyle;
}

export type DialogueStyle = 'bold' | 'italic' | 'mark' | 'plain';

const DIALOGUE_TAGS: Record<DialogueStyle, 'b' | 'i' | 'mark' | null> = { bold: 'b', italic: 'i', mark: 'mark', plain: null };

// 当前这次 toRichMessages 调用的对话样式。转换是同步的，用模块级变量避免把参数穿过所有行内函数。
let dialogueTag: 'b' | 'i' | 'mark' | null = null;

/** 与酒馆助手 is_frontend 一致：包含 html>、<head> 或 <body。 */
export function isFrontendCardSource(text: string): boolean {
  return text.includes('html>') || text.includes('<head>') || text.includes('<body');
}

// ───────────────────────── 类型 ─────────────────────────

type Attrs = Record<string, string>;
type DNode = string | DEl;
interface DEl {
  n: string;
  a: Attrs;
  k: DNode[];
}

interface Text {
  t: 'text';
  v: string;
}
interface Br {
  t: 'br';
}
interface Media {
  t: 'media';
  tag: 'img' | 'video' | 'audio';
  src: string;
}
interface Fmt {
  t: 'el';
  tag: string;
  attrs: Attrs;
  kids: Inl[];
  hasMedia?: boolean;
}
type Inl = Text | Br | Media | Fmt;

interface Leaf {
  k: 'leaf';
  /** '' 表示匿名段落：顶层输出 <p>，bare 时（列表项内）直接输出行内内容 */
  tag: '' | 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'pre' | 'blockquote' | 'summary';
  bare?: boolean;
  lang?: string;
  inl: Inl[];
}
interface Box {
  k: 'box';
  tag: 'ul' | 'ol' | 'li' | 'details';
  attrs: Attrs;
  kids: Block[];
}
interface Hr {
  k: 'hr';
}
interface MediaBlock {
  k: 'media';
  m: Media;
}
interface Cell {
  th: boolean;
  attrs: Attrs;
  inl: Inl[];
}
interface Table {
  k: 'table';
  rows: Cell[][];
}
type Block = Leaf | Box | Hr | MediaBlock | Table;

interface Lim {
  maxChars: number;
  maxBlocks: number;
  maxMedia: number;
}
interface Ctx {
  lim: Lim;
  onPre?: RichOptions['onPre'];
}

// ───────────────────────── 解析 ─────────────────────────

const MAX_TREE_DEPTH = 128; // 超过的嵌套在建树时压平，保证后面的递归有界
const KEEP_LIMIT = RICH_LIMITS.maxDepth - 1; // 保留的包装元素链最长 15，匿名段落的 <p> 再 +1

const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'template',
  'head', 'title', 'meta', 'link', 'base', 'svg', 'canvas', 'select', 'datalist',
]);

function parseDom(html: string): DEl {
  const root: DEl = { n: '#root', a: {}, k: [] };
  const stack: DEl[] = [root];
  let overflow = 0;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (stack.length >= MAX_TREE_DEPTH) {
          overflow++;
          return;
        }
        const el: DEl = { n: name, a: attribs, k: [] };
        stack[stack.length - 1].k.push(el);
        stack.push(el);
      },
      onclosetag() {
        if (overflow > 0) overflow--;
        else if (stack.length > 1) stack.pop();
      },
      ontext(data) {
        stack[stack.length - 1].k.push(data);
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return root;
}

// ───────────────────────── 通用小工具 ─────────────────────────

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');

function cpLen(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}

/** 按码点切字符串：前 n 个码点 / 其余。 */
function cpSplit(s: string, n: number): [string, string] {
  let i = 0;
  let count = 0;
  while (i < s.length && count < n) {
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 2 : 1;
    count++;
  }
  return [s.slice(0, i), s.slice(i)];
}

function safeUrl(raw: string | undefined, schemes: readonly string[]): string | null {
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000- \u007f-\u009f]+/g, '');
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!m || !schemes.includes(m[1].toLowerCase())) return null;
  if (m[1].toLowerCase().startsWith('http')) {
    try {
      return new URL(cleaned).href;
    } catch {
      return null;
    }
  }
  return cleaned;
}

// 酒馆助手给前端代码块加的“显示前端代码块 / 显示代码块”按钮，是纯界面元素，不属于正文。
const UI_CHROME_CLASS = /(?:^|\s)TH-collapse-code-block-button(?:\s|$)/;
const isHidden = (a: Attrs): boolean =>
  a.hidden !== undefined || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style ?? '') || UI_CHROME_CLASS.test(a.class ?? '');

function plainOf(nodes: DNode[]): string {
  // 迭代，避免深层递归
  let out = '';
  const stack: DNode[] = [...nodes].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (typeof n === 'string') out += n;
    else if (n.n === 'br') out += '\n';
    else if (!DROP.has(n.n)) for (let i = n.k.length - 1; i >= 0; i--) stack.push(n.k[i]);
  }
  return out;
}

// ───────────────────────── DOM → 行内 ─────────────────────────

const FORMAT: Record<string, string> = {
  b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', ins: 'u', s: 's', strike: 's', del: 's',
  mark: 'mark', sub: 'sub', sup: 'sup', code: 'code', kbd: 'code', samp: 'code', tt: 'code', var: 'code',
  'tg-spoiler': 'tg-spoiler',
};

const BLOCKISH = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure', 'figcaption', 'form',
  'fieldset', 'center', 'address', 'dl', 'dt', 'dd', 'details', 'summary', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'pre', 'blockquote', 'ul', 'ol', 'li', 'hr', 'table', 'tr', 'caption', 'thead', 'tbody', 'tfoot', 'td', 'th',
  'body', 'html', 'legend', 'hgroup',
]);

const text = (v: string): Text => ({ t: 'text', v });

function mediaOf(el: DEl): Media | null {
  const tag = el.n as 'img' | 'video' | 'audio';
  let src: string | undefined = el.a.src;
  if (!src && tag !== 'img') {
    const source = el.k.find((c): c is DEl => typeof c !== 'string' && c.n === 'source');
    src = source?.a.src;
  }
  const url = safeUrl(src, ['http', 'https']);
  return url ? { t: 'media', tag, src: url } : null;
}

/** 正在 <q> 里面：里面的「」不再套第二层对话样式。 */
let inQuote = 0;

/** 「…」『…』是中文日系对话的引号，ST 不会把它们包成 <q>，这里按同样的对话样式处理。 */
const BRACKET_DIALOGUE = /(「[^「」]*」|『[^『』]*』)/;

function pushText(out: Inl[], v: string, depth: number): void {
  if (!dialogueTag || inQuote > 0 || depth >= KEEP_LIMIT || !/[「『]/.test(v)) {
    out.push(text(v));
    return;
  }
  for (const part of v.split(BRACKET_DIALOGUE)) {
    if (!part) continue;
    if (BRACKET_DIALOGUE.test(part)) {
      const kids = [text(part)];
      out.push({ t: 'el', tag: dialogueTag, attrs: {}, kids, hasMedia: false });
    } else out.push(text(part));
  }
}

const QUOTE_CHARS = new Set(['"', '“', '”', "'", '‘', '’', '「', '」', '『', '』', '《', '》']);

/** 行内模式：块级标签变成换行；media 为 false 时图片降级为 alt 文字。 */
function inlineOf(nodes: DNode[], depth: number, media: boolean): Inl[] {
  const out: Inl[] = [];
  const brOnce = (): void => {
    if (out.length && out[out.length - 1].t !== 'br') out.push({ t: 'br' });
  };
  for (const n of nodes) {
    if (typeof n === 'string') {
      pushText(out, n, depth);
      continue;
    }
    const name = n.n;
    if (DROP.has(name) || isHidden(n.a)) continue;
    if (name === 'br') out.push({ t: 'br' });
    else if (name === 'img' || name === 'video' || name === 'audio') {
      const m = media ? mediaOf(n) : null;
      if (m) out.push(m);
      else if (name === 'img' && n.a.alt) out.push(text(n.a.alt));
    } else if (name === 'q') {
      // ST 的引号包装会让 <q> 里本身就带着引号字符（"op"），已经有就不再套一层，否则变成 “"op"”。
      const inner = plainOf(n.k).trim();
      const quoted = inner.length >= 2 && QUOTE_CHARS.has(inner[0]) && QUOTE_CHARS.has(inner[inner.length - 1]);
      inQuote++;
      const inner2 = inlineOf(n.k, depth, media);
      inQuote--;
      const kids = quoted ? inner2 : [text('“'), ...inner2, text('”')];
      if (dialogueTag && depth < KEEP_LIMIT) out.push({ t: 'el', tag: dialogueTag, attrs: {}, kids, hasMedia: kids.some(hasMedia) });
      else out.push(...kids);
    } else if (name === 'a') {
      const href = safeUrl(n.a.href, ['http', 'https', 'mailto', 'tel']);
      const kids = inlineOf(n.k, depth + 1, media);
      if (href && depth < KEEP_LIMIT) out.push({ t: 'el', tag: 'a', attrs: { href }, kids, hasMedia: kids.some(hasMedia) });
      else out.push(...kids);
    } else if (FORMAT[name]) {
      const kids = inlineOf(n.k, depth + 1, media);
      if (depth < KEEP_LIMIT) out.push({ t: 'el', tag: FORMAT[name], attrs: {}, kids, hasMedia: kids.some(hasMedia) });
      else out.push(...kids);
    } else if (BLOCKISH.has(name)) {
      brOnce();
      if (name === 'li') out.push(text('· '));
      out.push(...inlineOf(n.k, depth, media));
      if (name === 'td' || name === 'th') out.push(text(' '));
      else brOnce();
    } else {
      out.push(...inlineOf(n.k, depth, media)); // span、font、未知标签：只留内容
    }
  }
  return out;
}

const hasMedia = (n: Inl): boolean => n.t === 'media' || (n.t === 'el' && !!n.hasMedia);

// ───────────────────────── 行内整理 ─────────────────────────

/** 折叠空白，去掉首尾换行、连续多余换行和空元素。 */
function normalize(nodes: Inl[]): Inl[] {
  let lastSpace = true;
  let has = false;
  let brRun = 0;
  let lastText: Text | null = null;
  const trimTail = (): void => {
    if (lastText && lastText.v.endsWith(' ')) lastText.v = lastText.v.slice(0, -1);
  };
  const walk = (list: Inl[]): Inl[] => {
    const out: Inl[] = [];
    for (const n of list) {
      if (n.t === 'text') {
        let v = n.v.replace(/[ \t\r\n\f]+/g, ' ');
        if (lastSpace && v.startsWith(' ')) v = v.slice(1);
        if (!v) continue;
        const t = text(v);
        lastText = t;
        lastSpace = v.endsWith(' ');
        has = true;
        brRun = 0;
        out.push(t);
      } else if (n.t === 'br') {
        if (!has || brRun >= 2) continue;
        trimTail();
        brRun++;
        lastSpace = true;
        out.push(n);
      } else if (n.t === 'el') {
        const kids = walk(n.kids);
        if (kids.length) out.push({ ...n, kids });
      } else {
        has = true;
        brRun = 0;
        lastSpace = false;
        out.push(n);
      }
    }
    return out;
  };
  const out = walk(nodes);
  trimTail();
  while (out.length && out[out.length - 1].t === 'br') out.pop();
  return out;
}

function inlChars(nodes: Inl[]): number {
  let n = 0;
  for (const x of nodes) {
    if (x.t === 'text') n += cpLen(x.v);
    else if (x.t === 'br') n += 1;
    else if (x.t === 'el') n += inlChars(x.kids);
  }
  return n;
}

function inlText(nodes: Inl[]): string {
  let s = '';
  for (const x of nodes) {
    if (x.t === 'text') s += x.v;
    else if (x.t === 'br') s += '\n';
    else if (x.t === 'el') s += inlText(x.kids);
  }
  return s;
}

type Seg = { inl: Inl[] } | { media: Media };

/** 把行内节点里的媒体提到块级，前后的文字各成一段，格式包裹在每段里重新打开。 */
function hoist(nodes: Inl[]): Seg[] {
  const segs: Seg[] = [];
  let cur: Inl[] = [];
  const flush = (): void => {
    if (cur.length) segs.push({ inl: cur });
    cur = [];
  };
  for (const n of nodes) {
    if (n.t === 'media') {
      flush();
      segs.push({ media: n });
    } else if (n.t === 'el' && n.hasMedia) {
      for (const s of hoist(n.kids)) {
        if ('media' in s) {
          flush();
          segs.push(s);
        } else cur.push({ t: 'el', tag: n.tag, attrs: n.attrs, kids: s.inl });
      }
    } else cur.push(n);
  }
  flush();
  return segs;
}

// ───────────────────────── DOM → 块 ─────────────────────────

function flushRun(run: Inl[], out: Block[], bare: boolean): void {
  for (const seg of hoist(run)) {
    if ('media' in seg) out.push({ k: 'media', m: seg.media });
    else {
      const inl = normalize(seg.inl);
      if (inlChars(inl) > 0) out.push({ k: 'leaf', tag: '', bare, inl });
    }
  }
  run.length = 0;
}

function leafOf(tag: Leaf['tag'], nodes: DNode[], depth: number): Leaf | null {
  const inl = normalize(inlOfLeaf(nodes, depth));
  return inlChars(inl) > 0 ? { k: 'leaf', tag, inl } : null;
}
const inlOfLeaf = (nodes: DNode[], depth: number): Inl[] => inlineOf(nodes, depth, false);

function blocksOf(nodes: DNode[], depth: number, ctx: Ctx, bare = false): Block[] {
  const out: Block[] = [];
  const run: Inl[] = [];
  const flush = (): void => flushRun(run, out, bare);
  for (const n of nodes) {
    if (typeof n === 'string') {
      run.push(text(n));
      continue;
    }
    const name = n.n;
    if (DROP.has(name) || isHidden(n.a)) continue;
    if (!BLOCKISH.has(name)) {
      run.push(...inlineOf([n], depth, true));
      continue;
    }
    flush();
    if (/^h[1-6]$/.test(name) || name === 'p') {
      const tag = depth < KEEP_LIMIT ? (name as Leaf['tag']) : '';
      for (const seg of hoist(inlineOf(n.k, depth + 1, true))) {
        if ('media' in seg) out.push({ k: 'media', m: seg.media });
        else {
          const inl = normalize(seg.inl);
          if (inlChars(inl) > 0) out.push({ k: 'leaf', tag, bare: tag === '' && bare, inl });
        }
      }
    } else if (name === 'pre') {
      const leaf = preLeaf(n, ctx);
      if (leaf) out.push(leaf);
    } else if (name === 'blockquote') {
      const leaf = leafOf(depth < KEEP_LIMIT ? 'blockquote' : '', n.k, depth + 1);
      if (leaf) out.push(leaf);
    } else if (name === 'hr') {
      out.push({ k: 'hr' });
    } else if (name === 'ul' || name === 'ol') {
      out.push(...listOf(n, depth, ctx));
    } else if (name === 'details') {
      out.push(...detailsOf(n, depth, ctx));
    } else if (name === 'table') {
      out.push(...tableOf(n, depth, ctx));
    } else {
      out.push(...blocksOf(n.k, depth, ctx, bare)); // div、section、figure 等：透明
    }
    // 块级元素后的新 run 由 flush 重置
  }
  flush();
  return out;
}

function preLeaf(el: DEl, ctx: Ctx): Leaf | null {
  const raw = plainOf(el.k);
  const body = raw.replace(/^\n/, '');
  if (!body.trim()) return null;
  const code = el.k.find((c): c is DEl => typeof c !== 'string' && c.n === 'code');
  const m = /(?:^|\s)language-([\w+#.-]{1,30})(?:\s|$)/.exec(code?.a.class ?? '');
  if (ctx.onPre?.({ text: body, isCard: isFrontendCardSource(body) }) === 'drop') return null;
  return { k: 'leaf', tag: 'pre', lang: m?.[1], inl: [text(body)] };
}

function listOf(el: DEl, depth: number, ctx: Ctx): Block[] {
  const items: Block[] = [];
  let stray: DNode[] = [];
  const flushStray = (): void => {
    const kids = blocksOf(stray, depth + 2, ctx, true);
    if (kids.length) items.push({ k: 'box', tag: 'li', attrs: {}, kids });
    stray = [];
  };
  for (const c of el.k) {
    if (typeof c !== 'string' && c.n === 'li') {
      flushStray();
      if (isHidden(c.a)) continue;
      const kids = blocksOf(c.k, depth + 2, ctx, true);
      if (kids.length) items.push({ k: 'box', tag: 'li', attrs: {}, kids });
    } else stray.push(c);
  }
  flushStray();
  if (!items.length) return [];
  if (depth + 2 > KEEP_LIMIT) {
    // 太深：列表壳去掉，条目内容按段落输出
    return items.flatMap((i) => (i.k === 'box' ? i.kids : [i]));
  }
  const attrs: Attrs = {};
  const start = el.n === 'ol' ? /^\d{1,6}$/.exec(el.a.start ?? '') : null;
  if (start && start[0] !== '1') attrs.start = start[0];
  return [{ k: 'box', tag: el.n as 'ul' | 'ol', attrs, kids: items }];
}

function detailsOf(el: DEl, depth: number, ctx: Ctx): Block[] {
  const summaryEl = el.k.find((c): c is DEl => typeof c !== 'string' && c.n === 'summary');
  const rest = el.k.filter((c) => c !== summaryEl);
  const kids = blocksOf(rest, depth + 1, ctx);
  if (depth >= KEEP_LIMIT) {
    const s = summaryEl && leafOf('', summaryEl.k, depth);
    return [...(s ? [s] : []), ...kids];
  }
  const summary = (summaryEl && leafOf('summary', summaryEl.k, depth + 2)) ?? {
    k: 'leaf' as const, tag: 'summary' as const, inl: [text('详情')],
  };
  if (!kids.length && !summaryEl) return [];
  const attrs: Attrs = el.a.open !== undefined ? { open: '' } : {};
  return [{ k: 'box', tag: 'details', attrs, kids: [summary, ...kids] }];
}

const sizeAttr = (v: string | undefined): string | undefined => {
  const m = /^\d{1,2}$/.exec(v ?? '');
  return m && +m[0] > 1 && +m[0] <= RICH_LIMITS.maxTableColumns ? m[0] : undefined;
};

function tableOf(el: DEl, depth: number, ctx: Ctx): Block[] {
  const rows: Cell[][] = [];
  let caption: DNode[] | null = null;
  const collect = (nodes: DNode[]): void => {
    for (const c of nodes) {
      if (typeof c === 'string' || DROP.has(c.n) || isHidden(c.a)) continue;
      if (c.n === 'tr') {
        const cells: Cell[] = [];
        for (const d of c.k) {
          if (typeof d === 'string' || (d.n !== 'td' && d.n !== 'th') || isHidden(d.a)) continue;
          const attrs: Attrs = {};
          const cs = sizeAttr(d.a.colspan);
          const rs = sizeAttr(d.a.rowspan);
          if (cs) attrs.colspan = cs;
          if (rs) attrs.rowspan = rs;
          if (/^(left|center|right)$/i.test(d.a.align ?? '')) attrs.align = d.a.align.toLowerCase();
          cells.push({ th: d.n === 'th', attrs, inl: normalize(inlineOf(d.k, 3, false)) });
        }
        if (cells.length) rows.push(cells);
      } else if (c.n === 'caption') caption = c.k;
      else if (['thead', 'tbody', 'tfoot'].includes(c.n)) collect(c.k);
    }
  };
  collect(el.k);
  const out: Block[] = [];
  const cap = caption ? leafOf('p', caption, depth + 1) : null;
  if (cap) out.push(cap);
  if (!rows.length) return out;

  const cols = Math.max(...rows.map((r) => r.reduce((n, c) => n + +(c.attrs.colspan ?? 1), 0)));
  const rowChars = Math.max(...rows.map((r) => r.reduce((n, c) => n + inlChars(c.inl), 0)));
  if (cols > RICH_LIMITS.maxTableColumns || depth + 3 > KEEP_LIMIT || rowChars > ctx.lim.maxChars / 2) {
    // 放不进表格：逐行输出，单元格之间用 | 分隔
    for (const r of rows) {
      const inl: Inl[] = [];
      r.forEach((c, i) => {
        if (i) inl.push(text(' | '));
        inl.push(...c.inl);
      });
      const n = normalize(inl);
      if (inlChars(n) > 0) out.push({ k: 'leaf', tag: '', inl: n });
    }
    return out;
  }
  out.push({ k: 'table', rows });
  return out;
}

// ───────────────────────── 度量与切分 ─────────────────────────

interface M {
  chars: number;
  blocks: number;
  media: number;
}
const cache = new WeakMap<object, M>();

function measure(b: Block): M {
  const hit = cache.get(b);
  if (hit) return hit;
  let m: M;
  switch (b.k) {
    case 'leaf':
      m = { chars: inlChars(b.inl), blocks: b.bare ? 0 : 1, media: 0 };
      break;
    case 'hr':
      m = { chars: 0, blocks: 1, media: 0 };
      break;
    case 'media':
      m = { chars: 0, blocks: 1, media: 1 };
      break;
    case 'table':
      m = {
        chars: b.rows.reduce((n, r) => n + r.reduce((k, c) => k + inlChars(c.inl), 0), 0) + b.rows.length - 1,
        blocks: 1 + b.rows.length,
        media: 0,
      };
      break;
    case 'box': {
      m = { chars: 0, blocks: 1, media: 0 };
      for (const c of b.kids) {
        const x = measure(c);
        m.chars += x.chars;
        m.blocks += x.blocks;
        m.media += x.media;
      }
      m.chars += Math.max(0, b.kids.length - 1);
    }
  }
  cache.set(b, m);
  return m;
}

const fits = (m: M, lim: Lim): boolean => m.chars <= lim.maxChars && m.blocks <= lim.maxBlocks && m.media <= lim.maxMedia;

/** 把一段码点序列上限为 n 的前缀里找一个好断点（返回前缀码点数）。 */
function pickCut(prefix: string[], n: number, newlineOnly: boolean): number {
  const low = Math.max(1, Math.floor(n / 2));
  for (let p = n; p >= low; p--) if (prefix[p - 1] === '\n') return p;
  if (!newlineOnly) for (let p = n; p >= low; p--) if (/\s/.test(prefix[p - 1])) return p;
  return n;
}

function prefixCps(nodes: Inl[], n: number): string[] {
  const out: string[] = [];
  const walk = (list: Inl[]): void => {
    for (const x of list) {
      if (out.length >= n) return;
      if (x.t === 'text') for (const ch of x.v) { if (out.length >= n) return; out.push(ch); }
      else if (x.t === 'br') out.push('\n');
      else if (x.t === 'el') walk(x.kids);
    }
  };
  walk(nodes);
  return out;
}

/** 在第 c 个字符处切开，格式包裹在两边各自保留。 */
function splitAt(nodes: Inl[], c: number): [Inl[], Inl[]] {
  const head: Inl[] = [];
  const tail: Inl[] = [];
  let left = c;
  for (const n of nodes) {
    if (left <= 0) tail.push(n);
    else if (n.t === 'text') {
      const len = cpLen(n.v);
      if (len <= left) {
        head.push(n);
        left -= len;
      } else {
        const [a, b] = cpSplit(n.v, left);
        head.push(text(a));
        tail.push(text(b));
        left = 0;
      }
    } else if (n.t === 'br') {
      head.push(n);
      left -= 1;
    } else if (n.t === 'el') {
      const len = inlChars(n.kids);
      if (len <= left) {
        head.push(n);
        left -= len;
      } else {
        const [h, t] = splitAt(n.kids, left);
        if (h.length) head.push({ ...n, kids: h });
        if (t.length) tail.push({ ...n, kids: t });
        left = 0;
      }
    } else head.push(n);
  }
  return [head, tail];
}

function splitLeaf(b: Leaf, maxChars: number): Leaf[] {
  const out: Leaf[] = [];
  let rest = b.inl;
  while (inlChars(rest) > maxChars) {
    const cut = pickCut(prefixCps(rest, maxChars), maxChars, b.tag === 'pre');
    const [head, tail] = splitAt(rest, cut);
    out.push({ ...b, inl: head });
    rest = tail;
  }
  if (rest.length) out.push({ ...b, inl: rest });
  return out;
}

/** 把 b 切成若干个都满足 lim 的块；本身满足时原样返回。 */
function fitPieces(b: Block, lim: Lim): Block[] {
  if (fits(measure(b), lim)) return [b];
  switch (b.k) {
    case 'hr':
    case 'media':
      return [b];
    case 'leaf':
      return splitLeaf(b, lim.maxChars);
    case 'table': {
      const inner: Lim = { ...lim, maxBlocks: lim.maxBlocks - 1 };
      const chunks = groupBy(b.rows, (r) => ({ chars: r.reduce((n, c) => n + inlChars(c.inl), 0), blocks: 1, media: 0 }), inner);
      return chunks.map((rows) => ({ k: 'table' as const, rows }));
    }
    case 'box': {
      const inner: Lim = { ...lim, maxBlocks: lim.maxBlocks - 1 };
      const pieces = b.kids.flatMap((c) => fitPieces(c, inner));
      const chunks = groupBy(pieces, measure, inner);
      let liSeen = 0;
      const base = b.tag === 'ol' ? +(b.attrs.start ?? 1) : 1;
      return chunks.flatMap((kids, i) => {
        if (b.tag === 'details' && i > 0) return kids; // 续段没有 summary，直接作为普通块
        const attrs = { ...b.attrs };
        if (b.tag === 'ol' && liSeen > 0) attrs.start = String(base + liSeen);
        liSeen += kids.filter((k) => k.k === 'box' && k.tag === 'li').length;
        return [{ k: 'box' as const, tag: b.tag, attrs, kids }];
      });
    }
  }
}

/** 贪心装箱：块之间的换行也算一个字符。 */
function groupBy<T>(items: T[], size: (x: T) => M, lim: Lim): T[][] {
  const groups: T[][] = [];
  let cur: T[] = [];
  let m: M = { chars: 0, blocks: 0, media: 0 };
  for (const it of items) {
    const x = size(it);
    const next: M = {
      chars: m.chars + (cur.length ? 1 : 0) + x.chars,
      blocks: m.blocks + x.blocks,
      media: m.media + x.media,
    };
    if (cur.length && !fits(next, lim)) {
      groups.push(cur);
      cur = [it];
      m = { ...x };
    } else {
      cur.push(it);
      m = next;
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// ───────────────────────── 序列化 ─────────────────────────

function attrStr(attrs: Attrs): string {
  return Object.entries(attrs)
    .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escAttr(v)}"`))
    .join('');
}

function serInl(nodes: Inl[]): string {
  let s = '';
  for (const n of nodes) {
    if (n.t === 'text') s += esc(n.v);
    else if (n.t === 'br') s += '<br>';
    else if (n.t === 'el') s += `<${n.tag}${attrStr(n.attrs)}>${serInl(n.kids)}</${n.tag}>`;
  }
  return s;
}

function ser(b: Block): string {
  switch (b.k) {
    case 'hr':
      return '<hr/>';
    case 'media':
      return b.m.tag === 'img' ? `<img src="${escAttr(b.m.src)}"/>` : `<${b.m.tag} src="${escAttr(b.m.src)}"></${b.m.tag}>`;
    case 'leaf':
      if (b.tag === 'pre') {
        const body = esc(inlText(b.inl));
        return b.lang ? `<pre><code class="language-${b.lang}">${body}</code></pre>` : `<pre>${body}</pre>`;
      }
      if (b.tag === '') return b.bare ? serInl(b.inl) : `<p>${serInl(b.inl)}</p>`;
      return `<${b.tag}>${serInl(b.inl)}</${b.tag}>`;
    case 'box':
      return `<${b.tag}${attrStr(b.attrs)}>${b.kids.map(ser).join('')}</${b.tag}>`;
    case 'table':
      return (
        '<table>' +
        b.rows
          .map((r) => '<tr>' + r.map((c) => `<${c.th ? 'th' : 'td'}${attrStr(c.attrs)}>${serInl(c.inl)}</${c.th ? 'th' : 'td'}>`).join('') + '</tr>')
          .join('') +
        '</table>'
      );
  }
}

function blockText(b: Block): string {
  switch (b.k) {
    case 'hr':
    case 'media':
      return '';
    case 'leaf':
      return inlText(b.inl);
    case 'box':
      return b.kids.map(blockText).filter(Boolean).join('\n');
    case 'table':
      return b.rows.map((r) => r.map((c) => inlText(c.inl)).join(' ')).join('\n');
  }
}

// ───────────────────────── 纯文本回退 ─────────────────────────

/** 流式去标签：不建树，所以对任意深度的输入都安全。块级标签处换行，script/style 内容丢弃。 */
function streamText(html: string): string {
  let out = '';
  let skip = 0;
  let pre = 0;
  const nl = (): void => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const parser = new Parser(
    {
      onopentag(name) {
        if (DROP.has(name)) skip++;
        else if (name === 'br') out += '\n';
        else if (BLOCKISH.has(name)) {
          nl();
          if (name === 'pre') pre++;
        }
      },
      onclosetag(name) {
        if (DROP.has(name)) skip = Math.max(0, skip - 1);
        else if (BLOCKISH.has(name)) {
          nl();
          if (name === 'pre') pre = Math.max(0, pre - 1);
        }
      },
      ontext(data) {
        if (skip) return;
        if (pre) {
          out += data;
          return;
        }
        let v = data.replace(/[ \t\r\n\f]+/g, ' ');
        if ((!out || out.endsWith('\n') || out.endsWith(' ')) && v.startsWith(' ')) v = v.slice(1);
        out += v;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 切成不超过 max 个码点的若干段，优先在换行、其次在空白处断开；拼回去与原文逐字一致。 */
export function splitPlain(s: string, max: number): string[] {
  const cps = Array.from(s);
  const out: string[] = [];
  let start = 0;
  while (start < cps.length) {
    let end = Math.min(start + max, cps.length);
    if (end < cps.length) {
      const low = start + Math.max(1, Math.floor(max / 2));
      let cut = -1;
      for (let p = end; p >= low && cut < 0; p--) if (cps[p - 1] === '\n') cut = p;
      for (let p = end; p >= low && cut < 0; p--) if (/\s/.test(cps[p - 1])) cut = p;
      if (cut > 0) end = cut;
    }
    out.push(cps.slice(start, end).join(''));
    start = end;
  }
  return out;
}

/** 去掉所有标记的纯文本，按 sendMessage 的 4096 字符上限分段（rich 发送失败时的回退）。不抛错。 */
export function toPlainTexts(html: string, max = 4096): string[] {
  if (typeof html !== 'string') return [];
  let t: string;
  try {
    t = streamText(html);
  } catch {
    t = html.replace(/<[^>]*>/g, '');
  }
  return t ? splitPlain(t, max) : [];
}

// ───────────────────────── 入口 ─────────────────────────

function plainParts(html: string, maxChars: number): RichPart[] {
  return toPlainTexts(html, maxChars).map((t) => ({ html: `<p>${esc(t).replace(/\n/g, '<br>')}</p>`, text: t }));
}

/**
 * 把渲染后的消息 HTML 转成一个或多个 Rich Message 段。永不抛错：转换失败时回退为纯文本段。
 * 没有可见内容时返回 []。每段用 sendRichMessage({ rich_message: { html: part.html } }) 发送。
 */
export function toRichMessages(input: string, options: RichOptions = {}): RichPart[] {
  if (typeof input !== 'string') return [];
  const lim: Lim = {
    maxChars: Math.max(1, Math.min(options.maxChars ?? RICH_LIMITS.maxChars, RICH_LIMITS.maxChars)),
    maxBlocks: Math.max(2, Math.min(options.maxBlocks ?? RICH_LIMITS.maxBlocks, RICH_LIMITS.maxBlocks)),
    maxMedia: Math.max(1, Math.min(options.maxMedia ?? RICH_LIMITS.maxMedia, RICH_LIMITS.maxMedia)),
  };
  dialogueTag = DIALOGUE_TAGS[options.dialogueStyle ?? 'plain'];
  try {
    const blocks = blocksOf(parseDom(input).k, 0, { lim, onPre: options.onPre });
    const pieces = blocks.flatMap((b) => fitPieces(b, lim));
    return groupBy(pieces, measure, lim).map((g) => ({
      html: g.map(ser).join(''),
      text: g.map(blockText).filter(Boolean).join('\n'),
    }));
  } catch {
    try {
      return plainParts(input, lim.maxChars);
    } catch {
      return [];
    }
  } finally {
    dialogueTag = null;
    inQuote = 0;
  }
}
