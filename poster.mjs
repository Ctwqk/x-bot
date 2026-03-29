const PLATFORM_BASE = (
  process.env.X_PLATFORM_API_BASE ||
  'http://127.0.0.1:3001/platforms/api/platforms/x'
).replace(/\/$/, '');

export async function postText(text) {
  try {
    const response = await fetch(`${PLATFORM_BASE}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: payload?.detail || `platform publish failed with ${response.status}` };
    }
    return { ok: true, detail: payload?.detail, url: payload?.url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function checkCdp() {
  try {
    const response = await fetch(`${PLATFORM_BASE}/auth/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    return Boolean(payload?.browser_running || payload?.authenticated);
  } catch {
    return false;
  }
}
