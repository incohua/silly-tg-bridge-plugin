// 本地 OpenAI 兼容 mock：/v1/models 与 /v1/chat/completions（stream 为 true 时流式）。联调用，复制自 spike/headless/mock-llm.mjs。
// 环境变量：MOCK_PORT（默认 8787）、MOCK_TOKENS（词数，默认 120）、MOCK_DELAY_MS（每词间隔，默认 25）。
import http from 'node:http';
const port = Number(process.env.MOCK_PORT || 8787);
const TOKENS = Number(process.env.MOCK_TOKENS || 120);
const DELAY = Number(process.env.MOCK_DELAY_MS || 25);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url.endsWith('/models')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
  }
  if (url.endsWith('/chat/completions') && req.method === 'POST') {
    let body = ''; for await (const c of req) body += c;
    let j = {}; try { j = JSON.parse(body); } catch { /* 非 JSON 请求体按空对象处理 */ }
    if (process.env.MOCK_DEBUG) console.log(body.slice(0,400)); console.log(new Date().toISOString(), 'chat', 'stream=', j.stream, 'msgs=', j.messages?.length, 'promptChars=', body.length);
    const words = Array.from({ length: TOKENS }, (_, i) => `词${i + 1}`);
    if (!j.stream) {
      // 非流式：等到整段“生成”完才一次性返回，耗时与流式相同（词数 × 每词间隔）
      await sleep(TOKENS * DELAY);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ id: 'm', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: words.join(' ') }, finish_reason: 'stop' }] }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let aborted = false; res.on('close', () => { aborted = true; });
    for (const w of words) {
      if (aborted) { console.log('client aborted'); return; }
      res.write(`data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: w + ' ' }, finish_reason: null }] })}\n\n`);
      await sleep(DELAY);
    }
    res.write(`data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.statusCode = 404; res.end('nf');
}).listen(port, '127.0.0.1', () => console.log('mock llm on', port));
