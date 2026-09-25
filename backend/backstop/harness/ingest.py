"""Transcript ingestion from export files.

This is how EIP's real data would enter, post-AEP, from the Attention →
Snowflake export rather than a vendor API. The column mapping below is a
documented *assumption* about that export's shape (Attention's Snowflake
integration syncs recordings, transcripts, scorecards and call metadata; the
exact column names are not public) and must be confirmed before use.

Ingested transcripts carry `synthetic=False` and no ground-truth labels, so
label-dependent contracts (C-TPMO-01, C-SOA-01, C-SUP-01) report ERROR with
"no ground truth" for them — honestly — while grounding contracts (spans,
figures, PII, schema) and the judged contract still run.
"""

from __future__ import annotations

import csv
import hashlib
import io
import os
import re
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from backstop.core import audit, pii
from backstop.models import Transcript

# Agent names are personal data too. Ingest stores initials ("Dana Whitfield" -> "D.W.")
# unless the operator opts out with BACKSTOP_INGEST_KEEP_AGENT_NAMES=1 (e.g. for coaching).
KEEP_AGENT_NAMES_ENV = "BACKSTOP_INGEST_KEEP_AGENT_NAMES"

PRODUCT_LINES = ("MA", "PDP", "MEDIGAP", "LIFE")

FORMATS: dict[str, dict[str, Any]] = {
    "attention-snowflake": {
        "description": "Assumed shape of the Attention → Snowflake call export. CONFIRM column names against the real export.",
        "columns": {
            "call_id": "unique call identifier (becomes the transcript code, prefixed A-)",
            "started_at": "ISO timestamp",
            "agent_name": "agent display name",
            "product_line": "MA | PDP | MEDIGAP | LIFE; any other value rejects the file; if absent, MA is assumed and flagged per call (product_line_assumed)",
            "duration_seconds": "integer",
            "transcript": "diarized text; lines like '[00:00:12] AGENT: ...' or 'AGENT: ...'",
        },
        "redaction": ("Medicare numbers, SSNs, dates of birth, phone numbers, emails and street addresses are "
                      "replaced with [REDACTED-*] before storage (backstop.core.pii). agent_name is stored as "
                      "initials unless BACKSTOP_INGEST_KEEP_AGENT_NAMES=1. Names spoken in the transcript are "
                      "NOT detected."),
    },
    "generic": {
        "description": "Minimal CSV: code, product_line, transcript.",
        "columns": {"code": "unique", "product_line": "MA | PDP | MEDIGAP | LIFE (absent: MA, flagged)", "transcript": "text"},
        "redaction": "same as attention-snowflake",
    },
}


CODE_MAX = 32  # Transcript.code column width
_CODE_OK = re.compile(r"[A-Za-z0-9._:-]+")


class IngestError(ValueError):
    pass


def redact(text: str) -> tuple[str, dict[str, int]]:
    """Redact PII (see ``backstop.core.pii``). Returns (text, counts per PII kind)."""
    return pii.redact(text)


def keep_agent_names() -> bool:
    return os.environ.get(KEEP_AGENT_NAMES_ENV, "").strip().lower() in ("1", "true", "yes")


def redact_agent_name(name: str | None, text: str) -> tuple[str | None, str, int]:
    """Replace the agent's name with initials in the label and wherever it appears verbatim
    (case-sensitive, whole words) in the transcript. Returns (label, text, replacements)."""
    if name is None or not name.strip() or keep_agent_names():
        return name, text, 0
    short = cast(str, pii.initials(name))  # name is non-blank here, so initials() returns a str
    text, n = re.subn(rf"(?<![\w-]){re.escape(name.strip())}(?![\w-])", short, text)
    return short, text, n


def ingest_csv(session: Session, raw: str, *, fmt: str = "attention-snowflake", actor: str = "system") -> dict[str, Any]:
    if fmt not in FORMATS:
        raise IngestError(f"unknown format {fmt}; known: {sorted(FORMATS)}")
    # Excel's "CSV UTF-8" starts with a byte-order mark that would otherwise become part of
    # the first header, and European-locale Excel writes ";" (or tab) instead of ",".
    raw = raw.removeprefix("\ufeff")
    header = raw.split("\n", 1)[0]
    delimiter = max((",", ";", "\t"), key=header.count) if header else ","
    reader = csv.DictReader(io.StringIO(raw), delimiter=delimiter)
    if reader.fieldnames:
        reader.fieldnames = [(name or "").strip().lower() for name in reader.fieldnames]
    required = {"call_id", "transcript"} if fmt == "attention-snowflake" else {"code", "transcript"}
    missing = required - set(reader.fieldnames or [])
    if missing:
        raise IngestError(f"missing columns {sorted(missing)}; expected {list(FORMATS[fmt]['columns'])}")
    created = skipped = 0
    product_assumed = 0
    redacted_total = dict.fromkeys((*pii.KINDS, "agent_name"), 0)
    batch_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    seen: set[str] = set()
    for line_no, row in enumerate(reader, start=2):  # line 1 is the header
        raw_code = (row.get("call_id") if fmt == "attention-snowflake" else row.get("code")) or ""
        raw_code = raw_code.strip()
        if not raw_code:
            raise IngestError(f"line {line_no}: empty {'call_id' if fmt == 'attention-snowflake' else 'code'}")
        code = f"A-{raw_code}" if fmt == "attention-snowflake" else raw_code
        if len(code) > CODE_MAX or not _CODE_OK.fullmatch(code):
            raise IngestError(f"line {line_no}: code {code[:40]!r} must be <= {CODE_MAX} chars of [A-Za-z0-9._:-]")
        if row.get("transcript") is None or not row["transcript"].strip():
            raise IngestError(f"line {line_no}: transcript is empty or the row is short")
        if code in seen or session.scalar(select(Transcript).where(Transcript.code == code)) is not None:
            skipped += 1
            continue
        seen.add(code)
        try:
            duration = round(float(row.get("duration_seconds") or 0))
        except (ValueError, OverflowError) as exc:
            raise IngestError(f"line {line_no}: duration_seconds {row.get('duration_seconds')!r} is not a number") from exc
        text, counts = redact(row["transcript"])
        agent, text, agent_hits = redact_agent_name(row.get("agent_name"), text)
        counts["agent_name"] = agent_hits
        for k, v in counts.items():
            redacted_total[k] += v
        # Which rules apply depends on the product line (TPMO and SOA rules do not govern
        # Medigap). An unknown value is refused, never relabelled. A missing one (exports
        # without the column) is assumed MA and flagged on the call and in the report.
        raw_product = (row.get("product_line") or "").strip().upper()
        if raw_product and raw_product not in PRODUCT_LINES:
            raise IngestError(f"line {line_no}: product_line {row.get('product_line')!r} must be one of "
                              f"{', '.join(PRODUCT_LINES)}")
        product_line = raw_product or "MA"
        product_assumed += not raw_product
        session.add(Transcript(
            code=code, corpus_hash=f"ingest:{batch_hash}", product_line=product_line, synthetic=False, text=text,
            labels={"ingested": True, "format": fmt, "agent": agent, "started_at": row.get("started_at"),
                    "ground_truth": None, "redacted": counts, "product_line_assumed": not raw_product},
            duration_seconds=duration,
        ))
        created += 1
    session.flush()
    report = {"format": fmt, "created": created, "skipped_existing": skipped, "redacted": redacted_total, "batch_hash": batch_hash,
              "product_line_assumed": product_assumed,
              "note": "ingested transcripts have no ground truth; rule-judgment contracts will report ERROR for them"}
    audit.record(session, actor=actor, event_type="ingest.completed", entity_type="transcripts", entity_id=batch_hash, payload=report)
    session.commit()
    return report
