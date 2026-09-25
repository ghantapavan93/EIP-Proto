"""Sandbox: check pasted text against the rule registry without storing it.

"Would it work on OUR data?" — paste an artifact (a script line, a scorecard
item, a web paragraph) and see which rule versions it encodes and whether each
one is current as of a date. The same deterministic matchers the scanner uses
find the encodings; the same staleness engine the impact view uses decides the
direction. Nothing about the text is persisted: the only write is one audit row
with the text's SHA-256 and counts.

The text is PII-redacted (ingest.redact) before anything reads it, so offsets
and spans refer to the redacted text.
"""

from __future__ import annotations

import hashlib
import unicodedata
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from backstop.core.impact import version_views
from backstop.core.staleness import (
    OVER,
    REVERIFY,
    SET_ASIDE,
    UNDER,
    EdgeView,
    VersionView,
    evaluate,
    version_in_force,
)
from backstop.harness.ingest import redact
from backstop.models import Rule
from backstop.scanner.matchers import Match, run_all

ARTIFACT_MAX_CHARS = 20_000
TRANSCRIPT_MAX_CHARS = 30_000
LABEL_MAX_CHARS = 80
_ALLOWED_CONTROLS = {"\t", "\n", "\r"}

ARTIFACT_NOTE = (
    "Nothing you pasted was stored: only a SHA-256 of the text and the counts went to the audit log. "
    "Matching is deterministic (the scanner's regular expressions), so the same text always gives the same "
    "answer, and text cannot instruct it. Medicare numbers, SSNs, dates of birth, phone numbers, emails and "
    "street addresses were redacted before "
    "matching; spans and offsets refer to the redacted text. A 'proposed' match is a reading a human must "
    "confirm; no match means none of the encoded phrasings was found, not that the text is compliant."
)


class SandboxTextError(ValueError):
    """Pasted text the sandbox refuses (reported as 422)."""


def check_text(text: str, *, max_chars: int, field: str = "text") -> str:
    """Validate pasted text: non-blank, within the cap, no control characters beyond tab/newline/CR.

    Emoji, accents and every printable script are fine. Lone surrogates (which a JSON
    body can carry as \\ud800) are refused: they cannot be hashed or matched.
    """
    if len(text) > max_chars:
        raise SandboxTextError(f"{field} is {len(text)} characters; the limit is {max_chars}")
    if not text.strip():
        raise SandboxTextError(f"{field} is empty or only whitespace")
    for i, ch in enumerate(text):
        if ch in _ALLOWED_CONTROLS:
            continue
        category = unicodedata.category(ch)
        if category == "Cc":
            raise SandboxTextError(f"{field} contains a control character (U+{ord(ch):04X}) at position {i}")
        if category == "Cs":
            raise SandboxTextError(f"{field} contains an unpaired surrogate at position {i}")
    return text


def check_label(label: str | None) -> str | None:
    if label is None:
        return None
    label = label.strip()
    if not label:
        return None
    return check_text(label, max_chars=LABEL_MAX_CHARS, field="label")


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ artifact check


def _verdict(rule: Rule, views: list[VersionView], match: Match, as_of: date) -> dict[str, Any] | None:
    bound = next((v for v in views if v.version == match.version), None)
    if bound is None:
        return None  # a matcher for a version the registry does not have; nothing honest to say
    in_force = version_in_force(views, as_of)
    orm = {v.version: v for v in rule.versions}
    direction: str | None = None
    disputed = False
    if in_force is None:
        verdict = "no_version_in_force"
        decisive = bound
        reason = f"no version of {rule.code} is in force on {as_of.isoformat()}; nothing to compare against"
    elif bound.id == in_force.id:
        verdict = "current"
        decisive = in_force
        disputed = in_force.disputed
        reason = f"encodes v{bound.version}, which is the version in force on {as_of.isoformat()}"
    elif bound.status not in SET_ASIDE and (bound.status == "proposed" or bound.version > in_force.version):
        verdict = "ahead"
        decisive = bound
        disputed = bound.disputed
        if bound.status == "proposed":
            when = (f"is proposed (from {bound.effective_from.isoformat()} if enacted)" if bound.effective_from
                    else "is proposed, with no effective date yet")
            reason = (f"encodes v{bound.version}, which {when}; v{in_force.version} is in force on "
                      f"{as_of.isoformat()} — a proposal is not law, so this is ahead of the rule, not stale")
        else:
            reason = (f"encodes v{bound.version}, which applies from {bound.effective_from.isoformat()}; "
                      f"v{in_force.version} is in force on {as_of.isoformat()} — ahead of the rule, not stale")
    else:
        # Older enacted version, or a vacated/stayed one (never law, so always stale).
        # The staleness engine decides the direction, exactly as it does for a scanned artifact.
        edge = EdgeView(id="sandbox", asset_id="sandbox", bound_version_id=bound.id, polarity=match.polarity)
        [stale] = evaluate(views, [edge], as_of)
        verdict = "stale"
        decisive = in_force
        direction, reason, disputed = stale.direction, stale.reason, stale.disputed
    if match.status == "proposed":
        reason = f"proposed match — a human must confirm this reading. {reason}"
    decisive_row = orm.get(decisive.version)
    return {
        "rule_code": rule.code,
        "rule_title": rule.title,
        "citation": rule.citation,
        "bound_version": bound.version,
        "bound_status": bound.status,
        "in_force_version": in_force.version if in_force else None,
        "polarity": match.polarity,
        "span": match.span,
        "offset": match.offset,
        "matcher": match.matcher,
        "confidence": match.confidence,
        "edge_status": match.status,
        "verdict": verdict,
        "direction": direction,
        "reason": reason,
        "applies_from": decisive.effective_from,
        "regulation_effective": decisive_row.regulation_effective if decisive_row else None,
        "disputed": disputed,
    }


def check_artifact(session: Session, text: str, *, as_of: date, label: str | None) -> dict[str, Any]:
    """Match `text` against every rule and resolve each match as of `as_of`. Writes nothing."""
    redacted_text, counts = redact(text)
    rules = {r.code: r for r in session.scalars(select(Rule).options(selectinload(Rule.versions))).all()}
    views = {code: version_views(rule) for code, rule in rules.items()}
    items: list[dict[str, Any]] = []
    seen: set[tuple[str, int, int, str]] = set()
    for match in sorted(run_all(redacted_text), key=lambda m: (m.offset, m.rule_code, m.version, m.matcher)):
        key = (match.rule_code, match.version, match.offset, match.span)
        rule = rules.get(match.rule_code)
        if rule is None or key in seen:
            continue
        seen.add(key)
        item = _verdict(rule, views[rule.code], match, as_of)
        if item is not None:
            items.append(item)
    # A proposed match ("agents no longer need to wait 48 hours") may mean the opposite of what
    # the matcher saw. It is listed with its provisional verdict but never counted as stale.
    confirmed = [i for i in items if i["edge_status"] != "proposed"]
    stale = [i for i in confirmed if i["verdict"] == "stale"]
    summary = {
        "matches": len(items),
        "stale": len(stale),
        "needs_review": len(items) - len(confirmed),
        "current": sum(1 for i in confirmed if i["verdict"] == "current"),
        "rules_touched": len({i["rule_code"] for i in items}),
        "over_restrictive": sum(1 for i in stale if i["direction"] == OVER),
        "under_restrictive": sum(1 for i in stale if i["direction"] == UNDER),
        "reverify": sum(1 for i in stale if i["direction"] == REVERIFY),
    }
    return {
        "as_of": as_of,
        "label": label,
        "text_sha256": sha256(text),
        "chars": len(text),
        "redacted": counts,
        "matches": items,
        "summary": summary,
        "persisted": False,
        "note": ARTIFACT_NOTE,
    }


# ------------------------------------------------------------------ samples

SAMPLES: dict[str, list[dict[str, str]]] = {
    "artifacts": [
        {
            "label": "Scheduling script line: 48-hour SOA wait (stale from 2026-10-01)",
            "text": (
                "Appointment scheduling (SYNTHETIC EXAMPLE). Agents must wait at least 48 hours after the "
                "Scope of Appointment is signed before holding a personal marketing appointment, unless the "
                "beneficiary walked in."
            ),
        },
        {
            "label": "Call-script opening: CY2027 TPMO disclaimer (current from 2026-10-01)",
            "text": (
                "Call opening (SYNTHETIC EXAMPLE). Read the TPMO disclaimer before you discuss any plan "
                "benefits: \"We do not offer every plan available in your area. Currently we represent 7 "
                "organizations which offer 42 products in your area. Please contact Medicare.gov or "
                "1-800-MEDICARE to get information on all of your options.\""
            ),
        },
        {
            "label": "Ad-review note on a superlative (CY2024 rule; loosened 2026-10-01)",
            "text": (
                "Ad copy review (SYNTHETIC EXAMPLE). Draft headline: \"The best Medicare Advantage plans in "
                "Example County!\" Hold for edits: superlatives are prohibited unless substantiated by data "
                "cited in the ad."
            ),
        },
    ],
    "transcripts": [
        {
            "label": "Synthetic MA call: disclaimer before benefits, SOA signed on the call",
            "text": (
                "[00:00] AGENT: Thanks for calling, this is Sam Sample. This is a SYNTHETIC test call; every "
                "name and plan in it is made up. Am I speaking with Mrs. Testcase?\n"
                "[00:07] CUSTOMER: Yes, this is Pat Testcase.\n"
                "[00:11] AGENT: This call is recorded for quality and compliance.\n"
                "[00:16] AGENT: We do not offer every plan available in your area. Currently we represent 7 "
                "organizations which offer 42 products in your area. Please contact Medicare.gov or "
                "1-800-MEDICARE to get information on all of your options.\n"
                "[00:34] CUSTOMER: Okay.\n"
                "[00:37] AGENT: I've emailed you a Scope of Appointment so we can talk about Medicare Advantage "
                "plans. Can you sign it now?\n"
                "[00:48] CUSTOMER: Signed.\n"
                "[00:52] AGENT: Thank you. The Example Health Plan (fictional) has a $0 monthly premium and a "
                "$4,500 maximum out-of-pocket.\n"
                "[01:05] CUSTOMER: Does it cover my dentist?\n"
                "[01:09] AGENT: It includes preventive dental. It's the best plan in the county.\n"
                "[01:15] CUSTOMER: Let's talk again on Friday.\n"
                "[01:19] AGENT: I'll book a follow-up appointment for Friday at 10 a.m."
            ),
        },
    ],
}
