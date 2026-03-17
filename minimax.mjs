/**
 * MiniMax chat completion client (OpenAI-compatible).
 */

const API_BASE = (process.env.MINIMAX_API_BASE || 'https://api.minimax.io/v1').replace(/\/$/, '');
const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.5-highspeed';

export async function chat(systemPrompt, userPrompt) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('Missing MINIMAX_API_KEY');

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
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
