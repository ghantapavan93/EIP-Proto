"""Fetch, normalize and hash artifact content.

Two modes:

* snapshot (default) — read the frozen copy under fixtures/pages/<code>.html.
  The demo never depends on the live network.
* live — fetch the page with an identified user agent and a polite delay,
  then refresh the snapshot. Used by `backstop scan --live` on Day 1 and by
  nobody during the demo.

Normalization is deliberately conservative: strip scripts/styles/SVG, collapse
whitespace. Hashing the *normalized* text means markup churn (a new class
name, a reordered attribute) does not produce a new artifact version.
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from bs4 import BeautifulSoup

_WS = re.compile(r"\s+")
_DROP_TAGS = ("script", "style", "svg", "noscript", "iframe", "template")


@dataclass(frozen=True)
class FetchResult:
    code: str
    text: str
    content_hash: str
    mode: str  # live | snapshot
    raw_length: int
    error: str | None = None


def normalize_html(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(_DROP_TAGS):
        tag.decompose()
    text = soup.get_text(separator=" ")
    return _WS.sub(" ", text).strip()


def normalize_text(text: str) -> str:
    return _WS.sub(" ", text).strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def snapshot_path(fixtures_dir: Path, code: str) -> Path:
    # `code` may be a relative override like "../sources/<name>" (rule-source watcher).
    return (fixtures_dir / "pages" / f"{code}.html").resolve()


def fetch_snapshot(fixtures_dir: Path, code: str) -> FetchResult:
    path = snapshot_path(fixtures_dir, code)
    if not path.exists():
        return FetchResult(code, "", "", "snapshot", 0, error=f"no snapshot at {path.name}")
    html = path.read_text(encoding="utf-8", errors="replace")
    text = normalize_html(html)
    return FetchResult(code, text, content_hash(text), "snapshot", len(html))


def fetch_live(
    fixtures_dir: Path,
    code: str,
    url: str,
    *,
    user_agent: str,
    delay_seconds: float,
    timeout: float = 30.0,
) -> FetchResult:
    """Fetch politely and refresh the snapshot. Never raises; errors are data.

    A 200 is not proof the page arrived: a bot challenge, an empty shell or a redirect
    to a home page all return 200. Those are reported as errors (UNKNOWN), never hashed
    as the page, and the committed snapshot is left untouched.
    """
    try:
        time.sleep(delay_seconds)
        with httpx.Client(follow_redirects=True, timeout=timeout, headers={"User-Agent": user_agent}) as client:
            resp = client.get(url)
            resp.raise_for_status()
            html = resp.text
            final_url = str(resp.url)
    except Exception as exc:  # noqa: BLE001 - surfaced as artifact-level fetch_error
        return FetchResult(code, "", "", "live", 0, error=f"{type(exc).__name__}: {exc}")
    text = normalize_html(html)
    suspect = suspect_content(url, final_url, text)
    if suspect:
        return FetchResult(code, "", "", "live", len(html), error=f"suspect content: {suspect}")
    path = snapshot_path(fixtures_dir, code)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(html, encoding="utf-8")
    return FetchResult(code, text, content_hash(text), "live", len(html))


MIN_PAGE_CHARS = 500


def _page_key(url: str) -> tuple[str, str]:
    """Host without www. and path without a trailing slash: http→https or www moves are the same page."""
    parts = urlsplit(url)
    return (parts.hostname or "").removeprefix("www."), parts.path.rstrip("/")


def _same_page(a: str, b: str) -> bool:
    return _page_key(a) == _page_key(b)


def suspect_content(requested_url: str, final_url: str, text: str) -> str | None:
    """Why a successful response is probably not the page asked for, or None."""
    if not _same_page(requested_url, final_url):
        return f"redirected to {final_url}"
    if len(text) < MIN_PAGE_CHARS:
        return f"only {len(text)} characters of text (a block page or an empty shell?)"
    return None
