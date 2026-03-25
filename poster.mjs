/**
 * Posts a tweet via OpenCLI against a host Chrome instance over CDP.
 *
 * Start host Chrome first:
 *   ./scripts/start-chrome.sh                  # headless
 *   HEADLESS=false ./scripts/start-chrome.sh   # headed, for first-time login
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const CDP_BASE = (process.env.X_CDP_URL || 'http://127.0.0.1:18810').replace(/\/$/, '');
const OPENCLI_CDP_TARGET = process.env.OPENCLI_CDP_TARGET || 'about:blank';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_OPENCLI = path.join(SCRIPT_DIR, 'node_modules', '.bin', 'opencli');
const execFileAsync = promisify(execFile);

export async function postText(text) {
  await ensureCdpReachable();

  let rows;
  try {
    rows = await runOpencliWithRetry(['twitter', 'post', '-f', 'json', text]);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || typeof row !== 'object') {
    return { ok: false, error: 'opencli returned unexpected output' };
  }

  if (row.status !== 'success') {
    return { ok: false, error: row.message || 'opencli failed to post tweet' };
  }

  return { ok: true };
}

export async function checkCdp() {
  try {
    await ensureCdpReachable();
    await resolveOpencliCommand();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */

async function ensureCdpReachable() {
  let res;
  try {
    res = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    throw new Error(
      `Cannot reach Chrome CDP at ${CDP_BASE} — run: scripts/start-chrome.sh (${err.message})`,
    );
  }
  if (!res.ok) throw new Error(`CDP /json/version HTTP ${res.status}`);
}

async function runOpencli(args) {
  const command = await resolveOpencliCommand();
  const endpoint = await resolveOpencliEndpoint();
  const env = {
    ...process.env,
    OPENCLI_CDP_ENDPOINT: endpoint,
    OPENCLI_CDP_TARGET,
  };

  try {
    const { stdout } = await execFileAsync(command.bin, [...command.args, ...args], {
      env,
      timeout: 90000,
      maxBuffer: 1024 * 1024,
    });
    return parseJson(stdout);
  } catch (err) {
    const detail = [err.stderr, err.stdout, err.message]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .find(Boolean);
    throw new Error(normalizeOpencliError(detail || 'opencli command failed'));
  }
}

async function runOpencliWithRetry(args) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await runOpencli(args);
    } catch (err) {
      lastError = err;
      if (!shouldRetryOpencli(err) || attempt === 2) throw err;
      await sleep(2000);
    }
  }

  throw lastError;
}

async function resolveOpencliCommand() {
  if (existsSync(LOCAL_OPENCLI)) {
    return { bin: LOCAL_OPENCLI, args: [] };
  }

  try {
    await execFileAsync('opencli', ['--version'], { timeout: 10000 });
    return { bin: 'opencli', args: [] };
  } catch {
    try {
      await execFileAsync('npx', ['--no-install', 'opencli', '--version'], { timeout: 10000 });
      return { bin: 'npx', args: ['--no-install', 'opencli'] };
    } catch {
      throw new Error('opencli is not installed. Run npm install in x-bot first.');
    }
  }
}

async function resolveOpencliEndpoint() {
  if (!CDP_BASE.startsWith('http')) return CDP_BASE;

  const res = await fetch(`${CDP_BASE}/json`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return CDP_BASE;

  const targets = await res.json();
  const candidates = rankTargets(targets);

  for (const target of candidates) {
    if (await probeTarget(target.webSocketDebuggerUrl)) {
      return target.webSocketDebuggerUrl;
    }
  }

  return CDP_BASE;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse opencli JSON output: ${String(text).trim() || '(empty)'}`);
  }
}

function normalizeOpencliError(detail) {
  if (/not logged in|login/i.test(detail)) {
    return 'Not logged in. Run: HEADLESS=false scripts/start-chrome.sh and log into X.';
  }
  if (/Browser Extension is not connected/i.test(detail)) {
    return `opencli fell back to Browser Bridge but the extension is not connected. Set OPENCLI_CDP_ENDPOINT/X_CDP_URL to ${CDP_BASE} or install the opencli Browser Bridge extension.`;
  }
  return detail;
}

function shouldRetryOpencli(err) {
  const detail = err?.message || String(err);
  return /CDP command '.*' timed out/i.test(detail) || /CDP connect timeout/i.test(detail);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rankTargets(targets) {
  const preferred = OPENCLI_CDP_TARGET.toLowerCase();
  const pages = targets.filter((target) => target?.type === 'page' && target?.webSocketDebuggerUrl);

  const preferredPages = pages.filter((target) => matchesPreferredTarget(target, preferred));
  const fallbackPages = pages.filter((target) => !matchesPreferredTarget(target, preferred));
  return [...preferredPages, ...fallbackPages];
}

function matchesPreferredTarget(target, preferred) {
  if (!preferred) return false;
  const haystack = `${target.title || ''} ${target.url || ''}`.toLowerCase();
  return haystack.includes(preferred);
}

async function probeTarget(wsUrl) {
  try {
    return await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        resolve(false);
      }, 5000);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }));
      });

      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(String(event.data)); }
        catch { return; }

        if (msg.id === 1) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(!msg.error);
        }
      });

      ws.addEventListener('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}
