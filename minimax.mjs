/**
 * Managed chat completion client.
 * If `LLM_BASE_URL` is set, route requests through watchdog/gateway.
 * Otherwise fall back to the direct MiniMax-compatible endpoint.
 */

import { randomUUID } from 'crypto';

const API_BASE = (process.env.LLM_BASE_URL || process.env.MINIMAX_API_BASE || 'https://api.minimax.io/v1').replace(/\/$/, '');
const MODEL = process.env.LLM_MODEL || process.env.MINIMAX_MODEL || 'MiniMax-M2.5-highspeed';

export async function chat(systemPrompt, userPrompt) {
  const apiKey = process.env.LLM_API_KEY || process.env.MINIMAX_API_KEY || '';
  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source: 'x-bot',
      client_request_id: `x-bot:${randomUUID()}`,
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 200,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => String(res.status));
    throw new Error(`MiniMax ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('MiniMax returned empty content');
  return content;
}

export { MODEL };
