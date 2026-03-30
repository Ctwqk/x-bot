from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import urlopen

import websockets


def _browser_ws_url(cdp_url: str) -> str:
    parsed = urlparse(cdp_url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"Unsupported CDP URL: {cdp_url}")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    payload = json.load(urlopen(f"{parsed.scheme}://{host}:{port}/json/version"))
    browser_ws = str(payload.get("webSocketDebuggerUrl") or "").strip()
    if not browser_ws:
        raise RuntimeError(f"Missing webSocketDebuggerUrl at {cdp_url}/json/version")
    return browser_ws


class CDPClient:
    def __init__(self, ws: websockets.ClientConnection):
        self._ws = ws
        self._next_id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._reader_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self._reader_task = asyncio.create_task(self._reader())

    async def close(self) -> None:
        if self._reader_task:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader_task

    async def _reader(self) -> None:
        async for raw in self._ws:
            data = json.loads(raw)
            message_id = data.get("id")
            if isinstance(message_id, int) and message_id in self._pending:
                future = self._pending.pop(message_id)
                if not future.done():
                    future.set_result(data)
                continue
            await self._events.put(data)

    async def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        session_id: str | None = None,
        timeout: float = 60.0,
    ) -> dict[str, Any]:
        self._next_id += 1
        message: dict[str, Any] = {"id": self._next_id, "method": method}
        if params is not None:
            message["params"] = params
        if session_id:
            message["sessionId"] = session_id
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[self._next_id] = future
        await self._ws.send(json.dumps(message))
        response = await asyncio.wait_for(future, timeout=timeout)
        if "error" in response:
            raise RuntimeError(f"{method} failed: {response['error']}")
        return response

    async def wait_for_event(self, predicate, timeout: float) -> dict[str, Any]:
        deadline = asyncio.get_running_loop().time() + timeout
        stash: list[dict[str, Any]] = []
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                for item in stash:
                    await self._events.put(item)
                raise asyncio.TimeoutError()
            event = await asyncio.wait_for(self._events.get(), remaining)
            if predicate(event):
                for item in stash:
                    await self._events.put(item)
                return event
            stash.append(event)

async def _session_call(
    cdp: CDPClient,
    session_id: str,
    method: str,
    params: dict[str, Any] | None = None,
    *,
    timeout: float = 60.0,
) -> dict[str, Any]:
    return await cdp.call(method, params=params, session_id=session_id, timeout=timeout)


async def _eval_value(cdp: CDPClient, session_id: str, expression: str) -> Any:
    result = await _session_call(
        cdp,
        session_id,
        "Runtime.evaluate",
        {"expression": expression, "returnByValue": True},
    )
    return result["result"]["result"].get("value")


def _wait_info_js() -> str:
    return """
JSON.stringify({
  url: location.href,
  textarea: document.querySelectorAll('[data-testid="tweetTextarea_0"]').length,
  file: document.querySelectorAll('input[type="file"]').length,
  body: (document.body?.innerText || '').slice(0, 300)
})
"""


def _focus_js() -> str:
    return """
(() => {
  const el = document.querySelector('[data-testid="tweetTextarea_0"]');
  if (!el) return false;
  el.click();
  el.focus();
  return true;
})()
"""


def _click_post_js() -> str:
    return """
(() => {
  const btn = document.querySelector('[data-testid="tweetButton"]');
  if (!btn) return false;
  btn.click();
  return true;
})()
"""


def _reply_click_js() -> str:
    return """
(() => {
  const btn = document.querySelector('[data-testid="reply"]');
  if (!btn) return false;
  btn.click();
  return true;
})()
"""


def _ready_js(media_paths: list[str]) -> str:
    media_names = json.dumps([Path(path).name for path in media_paths], ensure_ascii=False)
    return f"""
JSON.stringify((() => {{
  const names = {media_names};
  const bodyText = document.body?.innerText || '';
  const button = document.querySelector('[data-testid="tweetButton"]');
  const uploadComplete = names.some((name) => bodyText.includes(`${{name}}: Uploaded (100%)`));
  const uploadInFlight = /uploading|processing/i.test(bodyText);
  const hasMediaPreview = !!document.querySelector('video, [aria-label*="Image"], [aria-label*="Video"]');
  const buttonReady = !!(button && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true');
  return {{
    href: location.href,
    buttonReady,
    uploadComplete,
    uploadInFlight,
    hasMediaPreview,
    body: bodyText.slice(0, 500),
  }};
}})())
"""


async def _wait_for_compose(cdp: CDPClient, session_id: str) -> dict[str, Any]:
    info: dict[str, Any] | None = None
    for _ in range(60):
        raw = await _eval_value(cdp, session_id, _wait_info_js())
        info = json.loads(raw)
        if info["textarea"]:
            return info
        await asyncio.sleep(1)
    raise RuntimeError(f"compose not ready: {info}")


async def _wait_for_media_ready(
    cdp: CDPClient,
    session_id: str,
    media_paths: list[str],
    settle_ms: int,
) -> dict[str, Any]:
    ready: dict[str, Any] | None = None
    ready_js = _ready_js(media_paths)
    for _ in range(180):
        raw = await _eval_value(cdp, session_id, ready_js)
        ready = json.loads(raw)
        if ready["buttonReady"] and not ready["uploadInFlight"] and (
            ready["uploadComplete"] or ready["hasMediaPreview"]
        ):
            if any(Path(path).suffix.lower() in {".mp4", ".mov", ".mkv", ".webm", ".m4v"} for path in media_paths):
                if settle_ms > 0:
                    await asyncio.sleep(settle_ms / 1000)
            return ready
        await asyncio.sleep(1)
    raise RuntimeError(f"upload not ready: {ready}")


async def _navigate_to_compose(cdp: CDPClient, session_id: str, reply_to_url: str | None) -> None:
    target_url = reply_to_url or "https://x.com/compose/tweet"
    await _session_call(cdp, session_id, "Page.navigate", {"url": target_url})
    await cdp.wait_for_event(
        lambda event: event.get("method") == "Page.loadEventFired" and event.get("sessionId") == session_id,
        60,
    )
    await asyncio.sleep(5)
    if reply_to_url:
        for _ in range(20):
            clicked = await _eval_value(cdp, session_id, _reply_click_js())
            if clicked:
                await asyncio.sleep(2)
                return
            await asyncio.sleep(1)
        raise RuntimeError("reply composer not available")


async def post_media(*, cdp_url: str, text: str, media_paths: list[str], reply_to_url: str | None, settle_ms: int) -> dict:
    browser_ws = _browser_ws_url(cdp_url)
    target_id: str | None = None
    async with websockets.connect(browser_ws, max_size=None) as ws:
        cdp = CDPClient(ws)
        await cdp.start()
        try:
            created = await cdp.call("Target.createTarget", {"url": "about:blank"})
            target_id = created["result"]["targetId"]
            attached = await cdp.call("Target.attachToTarget", {"targetId": target_id, "flatten": True})
            session_id = attached["result"]["sessionId"]

            for method in ("Page.enable", "Runtime.enable", "DOM.enable", "Network.enable"):
                await _session_call(cdp, session_id, method)

            await _navigate_to_compose(cdp, session_id, reply_to_url)
            await _wait_for_compose(cdp, session_id)

            await _eval_value(cdp, session_id, _focus_js())
            await _session_call(cdp, session_id, "Input.insertText", {"text": text})

            document = await _session_call(cdp, session_id, "DOM.getDocument", {"depth": 1, "pierce": True})
            root_id = document["result"]["root"]["nodeId"]
            file_input = await _session_call(
                cdp,
                session_id,
                "DOM.querySelector",
                {"nodeId": root_id, "selector": 'input[type="file"]'},
            )
            node_id = file_input["result"]["nodeId"]
            if not node_id:
                raise RuntimeError("file input not found")
            await _session_call(
                cdp,
                session_id,
                "DOM.setFileInputFiles",
                {"nodeId": node_id, "files": media_paths},
            )

            await _wait_for_media_ready(cdp, session_id, media_paths, settle_ms)

            await _eval_value(cdp, session_id, _click_post_js())
            response_event = await cdp.wait_for_event(
                lambda event: event.get("method") == "Network.responseReceived"
                and event.get("sessionId") == session_id
                and "CreateTweet" in event.get("params", {}).get("response", {}).get("url", ""),
                30,
            )
            request_id = response_event["params"]["requestId"]
            await cdp.wait_for_event(
                lambda event: event.get("method") == "Network.loadingFinished"
                and event.get("sessionId") == session_id
                and event.get("params", {}).get("requestId") == request_id,
                30,
            )
            body = await _session_call(cdp, session_id, "Network.getResponseBody", {"requestId": request_id})
            data = json.loads(body["result"]["body"])
            errors = data.get("errors") or []
            if errors:
                message = "; ".join(str(item.get("message") or item) for item in errors)
                raise RuntimeError(message)
            rest_id = (
                (((data.get("data") or {}).get("create_tweet") or {}).get("tweet_results") or {})
                .get("result", {})
                .get("rest_id")
            )
            if not rest_id:
                raise RuntimeError("CreateTweet succeeded but rest_id was missing")
            return {
                "ok": True,
                "detail": "Tweet posted successfully.",
                "url": f"https://x.com/i/status/{rest_id}",
                "rest_id": rest_id,
            }
        finally:
            if target_id:
                with contextlib.suppress(Exception):
                    await cdp.call("Target.closeTarget", {"targetId": target_id})
            await cdp.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cdp-url", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--reply-to-url", default="")
    parser.add_argument("--video-settle-ms", type=int, default=31_000)
    parser.add_argument("--media", action="append", default=[])
    args = parser.parse_args()

    if not args.media:
        print(json.dumps({"ok": False, "error": "media paths are required"}))
        return 1

    try:
        payload = asyncio.run(
            post_media(
                cdp_url=args.cdp_url,
                text=args.text,
                media_paths=args.media,
                reply_to_url=args.reply_to_url.strip() or None,
                settle_ms=args.video_settle_ms,
            )
        )
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
