// 本地假的 Telegram Bot API，只用于离线联调（配合 config.json 的 telegramApiBase）。
// 用法：node test/fixtures/fake-bot-api.mjs [port]，默认 8790。
//
// Bot API：POST /bot<token>/<method>
//   getMe、getUpdates（长轮询）、sendMessage、sendRichMessage、sendMessageDraft、sendChatAction、
//   answerCallbackQuery、editMessageText、deleteMessage，其余方法也返回 ok。
// 控制接口：
//   POST /_control/message  {"text": "...", "fromId": 1, "chatId": 1}  注入一条私聊消息 update
//   POST /_control/update   任意 update 对象（update_id 自动分配）
//   GET  /_control/calls    已收到的 Bot API 调用（JSON 数组）
//   POST /_control/reset    清空调用记录和待注入的错误
//   POST /_control/fail     {"method": "sendRichMessage", "count": 1, "error_code": 400, "description": "...", "retry_after": 1}
//                           让接下来 count 次该方法的调用返回错误（429 时带 parameters.retry_after）
// 每次调用也以一行 JSON 打到 stdout，token 替换为 ***。
import http from 'node:http';

const port = Number(process.argv[2] || process.env.FAKE_BOT_PORT || 8790);
const calls = [];
const queue = [];
const waiters = new Set();
let nextUpdateId = 1;
let nextMessageId = 1000;
/** method -> 待返回的错误列表 */
const failures = new Map();

function enqueue(update) {
  queue.push({ update_id: nextUpdateId++, ...update });
  for (const w of waiters) w();
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function send(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function getUpdates(params) {
  const offset = params.offset ?? 0;
  while (queue.length && queue[0].update_id < offset) queue.shift();
  if (queue.length === 0 && params.timeout) {
    await new Promise((resolve) => {
      const done = () => {
        waiters.delete(done);
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(done, Math.min(params.timeout, 30) * 1000);
      waiters.add(done);
    });
  }
  return queue.slice(0, params.limit ?? 100);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const body = await readBody(req);

    if (url.pathname === '/_control/message') {
      const fromId = body.fromId ?? 1;
      const chatId = body.chatId ?? fromId;
      enqueue({
        message: {
          message_id: nextMessageId++,
          from: { id: fromId, is_bot: false, first_name: 'Tester' },
          chat: { id: chatId, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: String(body.text ?? ''),
        },
      });
      return send(res, { ok: true });
    }
    if (url.pathname === '/_control/update') {
      enqueue(body);
      return send(res, { ok: true });
    }
    if (url.pathname === '/_control/calls') return send(res, calls);
    if (url.pathname === '/_control/fail') {
      const list = failures.get(body.method) ?? [];
      for (let i = 0; i < (body.count ?? 1); i++) list.push(body);
      failures.set(body.method, list);
      return send(res, { ok: true });
    }
    if (url.pathname === '/_control/reset') {
      calls.length = 0;
      failures.clear();
      return send(res, { ok: true });
    }

    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!m) return send(res, { ok: false, error_code: 404, description: 'Not Found' }, 404);
    const method = m[2];
    const fail = failures.get(method)?.shift();
    let rec = null;
    if (method !== 'getUpdates') {
      rec = { t: new Date().toISOString(), method, params: body, ...(fail ? { injectedError: fail.error_code ?? 400 } : {}) };
      calls.push(rec);
      console.log(JSON.stringify(rec));
    }
    if (fail) {
      const code = fail.error_code ?? 400;
      return send(res, {
        ok: false,
        error_code: code,
        description: fail.description ?? (code === 429 ? 'Too Many Requests: retry after 1' : 'Bad Request: injected error'),
        ...(code === 429 ? { parameters: { retry_after: fail.retry_after ?? 1 } } : {}),
      });
    }
    switch (method) {
      case 'getMe':
        return send(res, { ok: true, result: { id: 424242, is_bot: true, first_name: 'Fake', username: 'fake_silly_tg_bot' } });
      case 'getUpdates':
        return send(res, { ok: true, result: await getUpdates(body) });
      case 'sendRichMessage':
      case 'sendMessage': {
        const result = { message_id: nextMessageId++, chat: { id: body.chat_id, type: 'private' }, date: Math.floor(Date.now() / 1000) };
        if (method === 'sendMessage') result.text = body.text;
        if (rec) rec.messageId = result.message_id;
        return send(res, { ok: true, result });
      }
      default:
        return send(res, { ok: true, result: true });
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`fake bot api on ${port}`));
