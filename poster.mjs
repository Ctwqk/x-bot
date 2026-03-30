import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const PLATFORM_BASE = (
  process.env.X_PLATFORM_API_BASE ||
  'http://127.0.0.1:3001/platforms/api/platforms/x'
).replace(/\/$/, '');
const CDP_BASE = (process.env.X_CDP_URL || 'http://127.0.0.1:18810').replace(/\/$/, '');
const X_VIDEO_SETTLE_MS = Number(process.env.X_VIDEO_SETTLE_MS || 31000);
const HELPER_PYTHON = process.env.X_MEDIA_HELPER_PYTHON || '/tmp/vp-platform-env/bin/python';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_HELPER_SCRIPT = path.join(SCRIPT_DIR, 'x_media_post.py');
const execFileAsync = promisify(execFile);

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

export async function postMediaText(text, mediaPaths, replyToUrl = '') {
  const cleanedText = String(text || '').trim();
  const cleanedPaths = Array.isArray(mediaPaths)
    ? mediaPaths.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  const replyUrl = String(replyToUrl || '').trim();

  if (!cleanedText) {
    return { ok: false, error: 'text is required' };
  }
  if (!cleanedPaths.length) {
    return { ok: false, error: 'media_paths is required' };
  }

  const args = [
    MEDIA_HELPER_SCRIPT,
    '--cdp-url', CDP_BASE,
    '--video-settle-ms', String(X_VIDEO_SETTLE_MS),
    '--text', cleanedText,
  ];
  if (replyUrl) {
    args.push('--reply-to-url', replyUrl);
  }
  for (const mediaPath of cleanedPaths) {
    args.push('--media', mediaPath);
  }

  try {
    const { stdout } = await execFileAsync(HELPER_PYTHON, args, {
      cwd: SCRIPT_DIR,
      timeout: 240000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout || '{}');
    if (!payload?.ok) {
      return { ok: false, error: payload?.error || 'media helper failed' };
    }
    return { ok: true, detail: payload?.detail, url: payload?.url };
  } catch (err) {
    const detail = [err?.stdout, err?.stderr, err?.message]
      .filter(Boolean)
      .map(value => String(value).trim())
      .find(Boolean);
    if (!detail) {
      return { ok: false, error: 'media helper failed' };
    }
    try {
      const payload = JSON.parse(detail);
      return { ok: false, error: payload?.error || 'media helper failed' };
    } catch {
      return { ok: false, error: detail };
    }
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
