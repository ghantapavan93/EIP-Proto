"""Rule-source watcher.

For each rule, fetch (or replay) its primary source page, normalize, hash, and
compare with the last check. A changed hash opens a RULE_SOURCE_CHANGED review
task for the rule's owner. The corpus is never edited by code — a human reads
the diff and decides whether a new rule version is warranted.

Snapshot mode replays fixtures/sources/<rule>.html; live mode refreshes it.
Pages that refuse automated fetches are recorded as errors, not guessed.
"""

from __future__ import annotations

import hashlib
import re
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session

from backstop.config import Settings
from backstop.core import audit
from backstop.core.impact import in_force_version
from backstop.core.staleness import NEVER_IN_FORCE
from backstop.models import ReviewTask, Rule, RuleSourceCheck
from backstop.scanner import crawler

_SAFE = re.compile(r"[^a-z0-9-]+")


def _snapshot(fixtures_dir: Path, url: str) -> Path:
    """One snapshot per source URL (several rules may cite the same page)."""
    host = _SAFE.sub("-", (urlparse(url).netloc or "source").lower()).strip("-")
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:10]
    return fixtures_dir / "sources" / f"{host}-{digest}.html"


def _excerpt(text: str, limit: int = 600) -> str:
    # Try to center the excerpt on the clause language that matters most.
    for needle in ("prior to the discussion of any benefits", "6 years", "48", "superlative", "educational event"):
        i = text.find(needle)
        if i >= 0:
            lo = max(0, i - limit // 2)
            return text[lo : lo + limit]
    return text[:limit]


def _version_for_task(rule: Rule, as_of: date | None) -> str | None:
    """The version a source-change task is about: the one in force, else the newest enacted one."""
    current = in_force_version(rule, as_of or date.today())
    if current is None:
        enacted = [v for v in rule.versions if v.status not in NEVER_IN_FORCE]
        current = enacted[-1] if enacted else (rule.versions[-1] if rule.versions else None)
    return current.id if current else None


def check_sources(session: Session, settings: Settings, *, live: bool = False, actor: str = "system",
                  as_of: date | None = None) -> dict:
    stats = {"checked": 0, "changed": 0, "unchanged": 0, "first_seen": 0, "errors": 0, "mode": "live" if live else "snapshot"}
    for rule in session.scalars(select(Rule)).all():
        url = rule.source_url
        if not url:
            continue
        stats["checked"] += 1
        path = _snapshot(settings.fixtures_dir, url)
        if live:
            result = crawler.fetch_live(settings.fixtures_dir, f"../sources/{path.stem}", url,
                                        user_agent=settings.crawler_user_agent,
                                        delay_seconds=settings.crawler_delay_seconds)
        elif path.exists():
            html = path.read_text(encoding="utf-8", errors="replace")
            text = crawler.normalize_html(html)
            result = crawler.FetchResult(rule.code, text, crawler.content_hash(text), "snapshot", len(html))
        else:
            result = crawler.FetchResult(rule.code, "", "", "snapshot", 0, error="no snapshot for this source")

        previous = session.scalar(
            select(RuleSourceCheck).where(RuleSourceCheck.rule_id == rule.id, RuleSourceCheck.content_hash.is_not(None))
            .order_by(RuleSourceCheck.checked_at.desc())
        )
        check = RuleSourceCheck(rule_id=rule.id, source_url=url, fetch_mode=result.mode)
        if result.error:
            stats["errors"] += 1
            check.error = result.error
            session.add(check)
            continue
        check.content_hash = result.content_hash
        check.excerpt = _excerpt(result.text)
        if previous is None:
            stats["first_seen"] += 1
        elif previous.content_hash != result.content_hash:
            stats["changed"] += 1
            check.changed = True
        else:
            stats["unchanged"] += 1
        session.add(check)
        session.flush()
        if check.changed:
            dedupe_key = f"source:{rule.id}:{result.content_hash}"
            if session.scalar(select(ReviewTask).where(ReviewTask.dedupe_key == dedupe_key)) is None:
                task = ReviewTask(
                    kind="RULE_SOURCE_CHANGED", dedupe_key=dedupe_key, state="open",
                    rule_version_id=_version_for_task(rule, as_of),
                    reason=f"Primary source for {rule.code} changed ({url}). Read the diff; decide whether a new rule version is needed.",
                    assignee_role="compliance",
                    payload={"rule": rule.code, "source_url": url, "previous_hash": previous.content_hash,
                             "new_hash": result.content_hash, "excerpt": check.excerpt},
                )
                session.add(task)
                session.flush()
                audit.record(session, actor=actor, event_type="task.opened", entity_type="review_task",
                             entity_id=task.id, payload={"kind": task.kind, "rule": rule.code, "source_url": url})
        audit.record(session, actor=actor, event_type="rule.source_checked", entity_type="rule", entity_id=rule.id,
                     payload={"rule": rule.code, "source_url": url, "content_hash": result.content_hash,
                              "changed": check.changed, "mode": result.mode})
    session.commit()
    return stats
