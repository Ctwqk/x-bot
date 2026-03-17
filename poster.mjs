/**
 * Posts a tweet via Playwright connected to a host Chrome instance over CDP.
 *
 * Start host Chrome first:
 *   ./scripts/start-chrome.sh            # headless
 *   HEADLESS=false ./scripts/start-chrome.sh   # headed, for first-time login
 */

import { chromium } from 'playwright-core';

const CDP_BASE = (process.env.X_CDP_URL || 'http://127.0.0.1:18810').replace(/\/$/, '');

export async function postText(text) {
  const wsUrl = await getCdpWsUrl();
  return postTweet(wsUrl, text);
}

export async function checkCdp() {
  try {
    const res = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */

async function getCdpWsUrl() {
  let res;
  try {
    res = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    throw new Error(
      `Cannot reach Chrome CDP at ${CDP_BASE} — run: scripts/start-chrome.sh (${err.message})`,
    );
  }
  if (!res.ok) throw new Error(`CDP /json/version HTTP ${res.status}`);
  const info = await res.json();
  if (!info.webSocketDebuggerUrl) throw new Error('No webSocketDebuggerUrl from CDP');
  return info.webSocketDebuggerUrl;
}

async function postTweet(wsUrl, tweetText) {
  const browser = await chromium.connectOverCDP(wsUrl);
  try {
    const contexts = browser.contexts();
    let page = contexts
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('x.com') || p.url().includes('twitter.com'));

    if (!page) {
      const ctx = contexts[0] ?? await browser.newContext();
      page = await ctx.newPage();
    }

    await page.goto(
      `https://x.com/intent/post?text=${encodeURIComponent(tweetText)}`,
      { waitUntil: 'domcontentloaded', timeout: 15000 },
    );

    if (/\/login|\/i\/flow\/login/.test(page.url())) {
      return {
        ok: false,
        error: 'Not logged in. Run: HEADLESS=false scripts/start-chrome.sh and log into X.',
      };
    }

    const postBtn = page
      .locator('[data-testid="tweetButton"],[data-testid="postButton"]')
      .first();
    await postBtn.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(
      () => {
        const btn = document.querySelector(
          '[data-testid="tweetButton"],[data-testid="postButton"]',
        );
        return btn && !btn.disabled;
      },
      { timeout: 10000 },
    );

    await postBtn.click();

    try {
      await page.waitForURL(
        (url) => !url.toString().includes('/intent/post'),
        { timeout: 8000 },
      );
    } catch { /* some flows stay — not necessarily an error */ }

    const tweetId = await page
      .evaluate(() =>
        ([...document.querySelectorAll('a[href*="/status/"]')].pop()?.href || '')
          .match(/status\/(\d+)/)?.[1] ?? null,
      )
      .catch(() => null);

    return { ok: true, id: tweetId };
  } finally {
    await browser.close();
  }
}
