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
    """Fetch politely and refresh the snapshot. Never raises; errors are data."""
    try:
        time.sleep(delay_seconds)
        with httpx.Client(follow_redirects=True, timeout=timeout, headers={"User-Agent": user_agent}) as client:
            resp = client.get(url)
            resp.raise_for_status()
            html = resp.text
    except Exception as exc:  # noqa: BLE001 - surfaced as artifact-level fetch_error
        return FetchResult(code, "", "", "live", 0, error=f"{type(exc).__name__}: {exc}")
    path = snapshot_path(fixtures_dir, code)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(html, encoding="utf-8")
    text = normalize_html(html)
    return FetchResult(code, text, content_hash(text), "live", len(html))
