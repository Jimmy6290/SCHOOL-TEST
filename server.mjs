// ============================================================
// 开学小助手 · 服务端
// 零依赖 Node 单服务：静态页面 + 聊天代理（AI Key 在服务端）
//
// 用法：
//   node server.mjs            # 正式模式（需在 config.json 或环境变量配置 Key）
//   node server.mjs --mock     # 演示模式（不调真实 AI，返回模拟回复）
//   node server.mjs 9000       # 指定端口（默认 8000，或被 PORT 环境变量覆盖）
// ============================================================
import { createServer } from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const isMock = process.argv.includes('--mock') || process.env.MOCK === '1';
const portArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const port = Number(process.env.PORT || portArg || 8000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

// ---------- 配置加载（每次请求读取，改 config.json 即时生效） ----------
const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  botName: '开学小助手',
  welcomeMessage: '你好呀！我是开学小助手 🎓\n关于新生报到、宿舍、缴费、军训、食堂等开学问题，都可以直接问我～',
  quickQuestions: [
    '报到流程是怎样的？',
    '宿舍怎么安排？',
    '学费怎么交？',
    '军训什么时候开始？',
    '食堂情况怎么样？'
  ],
  systemPrompt:
    '你是"开学小助手"，一个专门解答大学新生开学期间日常问题的 AI 助手。\n' +
    '请始终使用简体中文，以友好、亲切、简洁的口语化方式回答新生提问。\n' +
    '解答范围包括：新生报到流程、宿舍安排与入住、学费与缴费方式、军训安排、校园食堂与生活、选课、校园卡、社团招新、交通路线等开学相关日常问题。\n' +
    '遇到不确定的信息时，请如实说明，并建议新生以学校官方通知或辅导员答复为准。\n\n' +
    '【知识库】\n（此处可粘贴学校的官方通知、常见问题解答等内容，后期补充即可，当前留空。）',
  rateLimit: { windowMs: 60000, max: 20 }
};

function loadConfig() {
  const cfg = { ...DEFAULTS, rateLimit: { ...DEFAULTS.rateLimit } };
  try {
    const file = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    Object.assign(cfg, file);
    if (file.rateLimit) cfg.rateLimit = { ...DEFAULTS.rateLimit, ...file.rateLimit };
  } catch { /* 没有 config.json 时用默认值 */ }
  // 环境变量覆盖（公网部署推荐：密钥等敏感项走环境变量，不入代码仓库）
  const envMap = {
    DEEPSEEK_API_KEY: 'apiKey',
    DEEPSEEK_BASE_URL: 'baseUrl',
    DEEPSEEK_MODEL: 'model',
    BOT_NAME: 'botName',
    WELCOME_MESSAGE: 'welcomeMessage',
    QUICK_QUESTIONS: 'quickQuestions',
    SYSTEM_PROMPT: 'systemPrompt'
  };
  for (const [envKey, field] of Object.entries(envMap)) {
    if (!process.env[envKey]) continue;
    if (field === 'quickQuestions') {
      cfg.quickQuestions = process.env[envKey].split('\n').map((x) => x.trim()).filter(Boolean);
    } else {
      cfg[field] = process.env[envKey];
    }
  }
  return cfg;
}

// ---------- 每 IP 限流（内存版） ----------
const rateMap = new Map();
function rateLimit(ip, cfg) {
  const { windowMs, max } = cfg.rateLimit;
  const now = Date.now();
  let rec = rateMap.get(ip);
  if (!rec || now - rec.start > windowMs) {
    rec = { start: now, count: 0 };
    rateMap.set(ip, rec);
  }
  rec.count++;
  if (rec.count > max) return false;
  return true;
}
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------- 工具 ----------
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function parseBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 20) return '消息条数不合法';
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object' || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
      return '消息格式不合法';
    }
    if (m.content.length > 4000) return '单条消息过长';
    total += m.content.length;
  }
  if (total > 20000) return '消息总长度超限';
  return null;
}

// ---------- 聊天接口（POST /api/chat，SSE 流式） ----------
async function handleChat(req, res) {
  const cfg = loadConfig();
  const ip = clientIp(req);
  if (!rateLimit(ip, cfg)) {
    sendJson(res, 429, { error: '请求过于频繁，请稍后再试' });
    return;
  }
  let body;
  try { body = await parseBody(req); } catch { sendJson(res, 400, { error: '请求体过大' }); return; }
  let payload;
  try { payload = JSON.parse(body); } catch { sendJson(res, 400, { error: '请求格式错误' }); return; }
  const invalid = validateMessages(payload.messages);
  if (invalid) { sendJson(res, 400, { error: invalid }); return; }

  if (isMock) {
    const lastUser = [...payload.messages].reverse().find((m) => m.role === 'user');
    const text = '（演示模式）你问的是：' + (lastUser ? lastUser.content : '？') + '\n\n这是本地演示模式的模拟回复。在 config.json 中填好 DeepSeek API Key 后重新启动，即可获得真实 AI 回答。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const chunks = text.match(/[\s\S]{1,8}/g) || [];
    let i = 0;
    const timer = setInterval(() => {
      if (i < chunks.length) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] }) + '\n\n');
        i++;
      } else {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, 80);
    return;
  }

  if (!cfg.apiKey) {
    sendJson(res, 500, { error: '服务暂未配置 API Key，请联系管理员' });
    return;
  }

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  req.on('close', () => { if (!res.writableEnded) controller.abort(); });

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: cfg.systemPrompt }, ...payload.messages.slice(-20)],
        stream: true,
        temperature: 0.7
      }),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e && e.name === 'AbortError' ? 'AI 服务响应超时' : '无法连接 AI 服务，请检查网络或接口地址';
    sendJson(res, 502, { error: msg });
    return;
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    let detail = 'AI 服务返回错误（' + upstream.status + '）';
    try {
      const j = await upstream.json();
      if (j && j.error && j.error.message) detail = j.error.message;
    } catch { /* ignore */ }
    sendJson(res, upstream.status >= 500 ? 502 : 400, { error: detail });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) res.write(Buffer.from(value));
    }
  } catch { /* 客户端断开等 */ }
  clearTimeout(timer);
  if (!res.writableEnded) res.end();
}

// ---------- HTTP 服务 ----------
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(u.pathname);

  try {
    if (req.method === 'GET' && pathname === '/api/config') {
      const cfg = loadConfig();
      sendJson(res, 200, {
        botName: cfg.botName,
        welcomeMessage: cfg.welcomeMessage,
        quickQuestions: cfg.quickQuestions
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/chat') {
      await handleChat(req, res);
      return;
    }

    // 静态文件
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'Method Not Allowed' }); return; }
    // 敏感文件不对外提供
    if (pathname === '/config.json' || pathname === '/.gitignore') { sendJson(res, 404, { error: 'Not Found' }); return; }
    let filePath = pathname === '/' ? '/index.html' : pathname;
    if (filePath.split('/').some((s) => s.startsWith('.'))) { sendJson(res, 404, { error: 'Not Found' }); return; }
    const file = normalize(join(root, filePath));
    if (!file.startsWith(root)) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    readFile(file, (err, data) => {
      if (err) { sendJson(res, 404, { error: 'Not Found' }); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch {
    sendJson(res, 500, { error: '服务器内部错误' });
  }
}).listen(port, () => {
  console.log('开学小助手' + (isMock ? '（演示模式）' : '') + '已启动：http://localhost:' + port);
});
