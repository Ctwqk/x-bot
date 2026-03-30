/**
 * x-bot HTTP service
 *
 * Exposes a simple HTTP API for posting to X via MiniMax plus the unified
 * VideoProcess platform browser manager. Other services can keep using this
 * compatibility layer without managing X automation directly.
 *
 * POST /post       { source, title, link?, summary? }  LLM-generated tweet
 * POST /post/raw   { text }                             Post text as-is
 * GET  /health     { ok, cdp, model }
 *
 * Env vars:
 *   PORT              HTTP port (default 7710)
 *   MINIMAX_API_KEY   Required for /post
 *   MINIMAX_MODEL     Model name (default MiniMax-M2.5-highspeed)
 *   X_PLATFORM_API_BASE Unified platform API base (default http://127.0.0.1:3001/platforms/api/platforms/x)
 *   XBOT_LANGUAGE     zh | en | auto (default auto)
 */

import { createServer } from 'node:http';
import { chat, MODEL } from './minimax.mjs';
import { postMediaText, postText, checkCdp } from './poster.mjs';

const PORT = Number(process.env.PORT || 7710);
const TWEET_MAX = 280;
const TCO_LEN = 23;

/* ------------------------------------------------------------------ */
/*  Content generation                                                */
/* ------------------------------------------------------------------ */

async function generateTweet(item) {
  const urlCost = item.link ? TCO_LEN + 1 : 0;
  const budget = TWEET_MAX - urlCost;

  const lang = process.env.XBOT_LANGUAGE || 'auto';
  const langInstruction =
    lang === 'zh' ? '用中文回复。' :
    lang === 'en' ? 'Reply in English.' :
    '语言跟随文章语言（中文文章用中文，英文文章用英文）。';

  const summary = item.summary ? `\n摘要：${item.summary.slice(0, 300)}` : '';

  const system =
    `你是一位专业的社交媒体编辑，擅长将新闻改写为吸引人的推文。` +
    `${langInstruction}` +
    `只输出推文正文，不要加引号、不要加 hashtag、不要加 URL，` +
    `字数严格控制在 ${budget} 字符以内（含空格）。`;

  const user = `来源：${item.source}\n标题：${item.title}${summary}`;

  const body = await chat(system, user);
  const trimmed = body.length <= budget ? body : `${body.slice(0, budget - 1)}…`;
  return item.link ? `${trimmed}\n${item.link}` : trimmed;
}

function fallbackTweet(item) {
  const tag = `[${item.source}] `;
  const urlCost = item.link ? TCO_LEN + 1 : 0;
  const available = TWEET_MAX - urlCost - tag.length;
  const title = item.title.replace(/\s+/g, ' ').trim();
  const body = title.length <= available ? title : `${title.slice(0, available - 1)}…`;
  return item.link ? `${tag}${body}\n${item.link}` : `${tag}${body}`;
}

/* ------------------------------------------------------------------ */
/*  HTTP server                                                       */
/* ------------------------------------------------------------------ */

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    const cdp = await checkCdp();
    return json(res, 200, { ok: true, cdp, model: MODEL });
  }

  // POST /post — LLM-generated tweet from news item
  if (req.method === 'POST' && url.pathname === '/post') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { source, title, link, summary } = body;
    if (!source || !title) return json(res, 400, { error: 'source and title are required' });

    let text;
    try {
      text = await generateTweet({ source, title, link, summary });
    } catch (err) {
      console.warn('[x-bot] MiniMax failed, using fallback:', err.message);
      text = fallbackTweet({ source, title, link });
    }

    console.log(`[x-bot] Posting: ${text.slice(0, 80)}…`);
    const result = await postText(text);
    if (!result.ok) console.error('[x-bot] Post failed:', result.error);
    return json(res, result.ok ? 200 : 502, result);
  }

  // POST /post/raw — post arbitrary text directly
  if (req.method === 'POST' && url.pathname === '/post/raw') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { text } = body;
    if (!text) return json(res, 400, { error: 'text is required' });

    console.log(`[x-bot] Raw post: ${text.slice(0, 80)}…`);
    const result = await postText(text);
    if (!result.ok) console.error('[x-bot] Post failed:', result.error);
    return json(res, result.ok ? 200 : 502, result);
  }

  // POST /post/media/raw — post arbitrary text with local media paths
  if (req.method === 'POST' && url.pathname === '/post/media/raw') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { text, media_paths: mediaPaths, reply_to_url: replyToUrl } = body;
    if (!text) return json(res, 400, { error: 'text is required' });
    if (!Array.isArray(mediaPaths) || mediaPaths.length === 0) {
      return json(res, 400, { error: 'media_paths is required' });
    }

    console.log(`[x-bot] Raw media post: ${String(text).slice(0, 80)}… (${mediaPaths.length} file(s))`);
    const result = await postMediaText(text, mediaPaths, replyToUrl);
    if (!result.ok) console.error('[x-bot] Media post failed:', result.error);
    return json(res, result.ok ? 200 : 502, result);
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`[x-bot] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[x-bot] MiniMax model: ${MODEL}`);
  console.log(`[x-bot] Platform API: ${process.env.X_PLATFORM_API_BASE || 'http://127.0.0.1:3001/platforms/api/platforms/x'}`);
});
