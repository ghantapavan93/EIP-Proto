"""Append-only audit log.

Every state change in Backstop goes through `record`. The catalog below is the
complete vocabulary; the UI filters on it and tests assert on it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import event, select, text
from sqlalchemy.orm import Session

from backstop.models import AuditEvent, utcnow

ACTOR_MAX = 64  # AuditEvent.actor column width; Postgres rejects longer values.

EVENT_TYPES = {
    "rules.reloaded",
    "rule.version_created",
    "rule.version_closed",
    "rule.version_annotated",
    "rule.proposal_renumbered",
    "contract.version_created",
    "rule.source_checked",
    "export.generated",
    "evidence.exported",
    "ingest.completed",
    "scan.started",
    "scan.completed",
    "artifact.content_changed",
    "artifact.unchanged",
    "artifact.fetch_error",
    "edge.confirmed",
    "edge.proposed",
    "edge.rejected",
    "edge.superseded",
    "edge.restored",
    "staleness.evaluated",
    "task.opened",
    "task.transitioned",
    "task.transition_rejected",
    "run.started",
    "run.completed",
    "run.failed",
    "run.deduplicated",
    "run.egress_refused",
    "test_case.created",
    "test_case.approved",
    "auth.denied",
    "access.reviewed",
    "audit.checkpoint",
    "sandbox.artifact_checked",
    "sandbox.transcript_checked",
}


SYSTEM_ROLE = "system"
# Rows written by `backstop demo` to seed honestly-labelled examples (actors
# "demo-seed:<persona>"). Never a configured user, never a real decision.
DEMO_SEED_ROLE = "demo-seed"
GENESIS = "0" * 64
_CHAIN_KEY = "backstop.audit.last_hash"
_PG_CHAIN_LOCK = 0x42AC_7001  # pg_advisory_xact_lock key serialising chain appends


def role_for(actor: str) -> str:
    """Resolve an actor to its role without inventing anything.

    ``system:<component>`` is automation. ``demo-seed:<persona>`` is an example
    the demo seeded (labelled as such everywhere it shows). A configured username
    maps to its configured role. Anything else (test fixtures, unknown names) is
    "unknown".
    """
    if actor.startswith("system:"):
        return SYSTEM_ROLE
    if actor.startswith("demo-seed:"):
        return DEMO_SEED_ROLE
    from backstop.config import get_settings

    try:
        entry = get_settings().user_table().get(actor)
    except ValueError:
        entry = None
    return entry[1] if entry else "unknown"


def _as_utc(ts: datetime) -> datetime:
    return ts.replace(tzinfo=UTC) if ts.tzinfo is None else ts.astimezone(UTC)


def row_digest(prev_hash: str, *, ts: datetime, actor: str, actor_role: str, event_type: str,
               entity_type: str, entity_id: str, payload: dict[str, Any], correlation_id: str | None) -> str:
    canonical = json.dumps(
        {"ts": _as_utc(ts).isoformat(timespec="microseconds"), "actor": actor, "actor_role": actor_role,
         "event_type": event_type, "entity_type": entity_type, "entity_id": entity_id, "payload": payload,
         "correlation_id": correlation_id},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str,
    )
    return hashlib.sha256((prev_hash + canonical).encode("utf-8")).hexdigest()


# SQLite has no advisory locks: one process-wide lock serialises chain appends from
# first read of the tip until the transaction ends (commit or rollback).
_SQLITE_CHAIN_LOCK = threading.Lock()
_SQLITE_LOCK_HELD = "backstop.audit.sqlite_lock_held"
_SQLITE_LOCK_TIMEOUT_S = 10


def _last_hash(session: Session) -> str:
    cached = session.info.get(_CHAIN_KEY)
    if cached is not None:
        return cached
    bind = session.get_bind()
    if bind.dialect.name == "postgresql":
        # Held until this transaction ends, so concurrent writers append in turn
        # instead of forking the chain from the same predecessor.
        session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _PG_CHAIN_LOCK})
    elif bind.dialect.name == "sqlite" and not session.info.get(_SQLITE_LOCK_HELD):
        # Bounded wait: a session that never ends its transaction must not hang every
        # writer. After the timeout the append proceeds unlocked (the pre-lock behaviour).
        if _SQLITE_CHAIN_LOCK.acquire(timeout=_SQLITE_LOCK_TIMEOUT_S):
            session.info[_SQLITE_LOCK_HELD] = True
        else:
            logging.getLogger("backstop.audit").warning("audit chain lock not acquired in %ss", _SQLITE_LOCK_TIMEOUT_S)
    last = session.scalar(select(AuditEvent.row_hash).order_by(AuditEvent.id.desc()).limit(1))
    return last or GENESIS


@event.listens_for(Session, "after_commit")
@event.listens_for(Session, "after_rollback")
@event.listens_for(Session, "after_soft_rollback")
def _forget_chain_tip(session: Session, *args) -> None:
    session.info.pop(_CHAIN_KEY, None)
    if session.info.pop(_SQLITE_LOCK_HELD, None):
        _SQLITE_CHAIN_LOCK.release()


def record(
    session: Session,
    *,
    actor: str,
    event_type: str,
    entity_type: str,
    entity_id: str,
    payload: dict[str, Any] | None = None,
    role: str | None = None,
    correlation_id: str | None = None,
) -> AuditEvent:
    if event_type not in EVENT_TYPES:
        raise ValueError(f"unknown audit event type: {event_type}")
    from backstop.logging_setup import request_id_var

    actor = actor[:ACTOR_MAX]
    actor_role = role or role_for(actor)
    if correlation_id is None:
        rid = request_id_var.get()
        correlation_id = None if rid == "-" else rid[:64]
    payload = payload or {}
    ts = utcnow()
    prev_hash = _last_hash(session)
    row_hash = row_digest(prev_hash, ts=ts, actor=actor, actor_role=actor_role, event_type=event_type,
                          entity_type=entity_type, entity_id=entity_id, payload=payload,
                          correlation_id=correlation_id)
    event = AuditEvent(
        ts=ts,
        actor=actor,
        actor_role=actor_role,
        event_type=event_type,
        entity_type=entity_type,
        entity_id=entity_id,
        payload=payload,
        correlation_id=correlation_id,
        prev_hash=prev_hash,
        row_hash=row_hash,
    )
    session.add(event)
    session.info[_CHAIN_KEY] = row_hash
    return event


def verify_chain(session: Session, checkpoint: tuple[int, str] | None = None, *,
                 after: tuple[int, str] | None = None) -> dict[str, Any]:
    """Recompute every row's hash in id order. Reports the first break, if any.

    The chain alone is tamper-evident, not tamper-proof: someone able to drop the
    append-only triggers could rewrite every row and recompute a consistent chain.
    A checkpoint closes that gap. It is (row id, row hash) taken earlier and kept
    outside the database; if the chain no longer contains that exact hash at that
    row, history before the checkpoint was rewritten, and the result is not ok.

    ``after`` = (row id, row hash) of a row already verified: only later rows are
    checked, linking from that hash. ``checked`` then counts the later rows only.
    """
    expected_prev = after[1] if after else GENESIS
    checked = 0
    tip_id: int | None = after[0] if after else None
    seen_at_checkpoint: str | None = None
    rows = select(AuditEvent).order_by(AuditEvent.id)
    if after is not None:
        rows = rows.where(AuditEvent.id > after[0])
    for row in session.scalars(rows).yield_per(500):
        digest = row_digest(row.prev_hash, ts=row.ts, actor=row.actor, actor_role=row.actor_role,
                            event_type=row.event_type, entity_type=row.entity_type, entity_id=row.entity_id,
                            payload=row.payload or {}, correlation_id=row.correlation_id)
        if row.prev_hash != expected_prev or digest != row.row_hash:
            return {"ok": False, "checked": checked, "first_broken_id": row.id,
                    "reason": "prev_hash does not link" if row.prev_hash != expected_prev else "row content changed",
                    "tip": expected_prev, "tip_id": tip_id, "checkpoint": _checkpoint_result(checkpoint, None)}
        if checkpoint is not None and row.id == checkpoint[0]:
            seen_at_checkpoint = row.row_hash
        expected_prev = row.row_hash
        tip_id = row.id
        checked += 1
    result: dict[str, Any] = {"ok": True, "checked": checked, "first_broken_id": None, "reason": None, "tip": expected_prev,
              "tip_id": tip_id, "checkpoint": _checkpoint_result(checkpoint, seen_at_checkpoint)}
    if result["checkpoint"] is not None and not result["checkpoint"]["matches"]:
        result["ok"] = False
        result["reason"] = result["checkpoint"]["reason"]
    return result


# The status rail polls; re-hashing the whole log on every poll grows without bound. Rows
# are append-only (database triggers), so a verified prefix stays verified unless someone
# with DDL rights rewrites it, which the full check (GET /api/audit/verify) and admin
# checkpoints exist to catch. Per database URL: (tip row id, tip hash, rows verified).
_verified_tips: dict[str, tuple[int, str, int]] = {}
_VERIFIED_TIPS_LOCK = threading.Lock()


def verify_new_rows(session: Session) -> dict[str, Any]:
    """`verify_chain` for rows appended since the last successful call in this process.

    The cached tip row is re-read first: if its hash changed, the cache is dropped and the
    whole chain is verified again. ``checked`` is the total number of rows verified so far.
    """
    key = session.get_bind().engine.url.render_as_string(hide_password=True)
    with _VERIFIED_TIPS_LOCK:
        cached = _verified_tips.get(key)
        if cached is not None:
            tip_now = session.scalar(select(AuditEvent.row_hash).where(AuditEvent.id == cached[0]))
            if tip_now != cached[1]:
                cached = None
        result = verify_chain(session, after=(cached[0], cached[1]) if cached else None)
        result["checked"] += cached[2] if cached else 0
        if result["ok"] and result["tip_id"] is not None:
            _verified_tips[key] = (result["tip_id"], result["tip"], result["checked"])
        elif not result["ok"]:
            _verified_tips.pop(key, None)
        return result


def _checkpoint_result(checkpoint: tuple[int, str] | None, seen: str | None) -> dict[str, Any] | None:
    if checkpoint is None:
        return None
    through_id, tip = checkpoint
    if seen is None:
        reason = f"row {through_id} is missing from the chain: history was removed or rewritten"
    elif seen != tip:
        reason = f"row {through_id} no longer carries the checkpoint hash: history before it was rewritten"
    else:
        reason = None
    return {"through_id": through_id, "tip": tip, "matches": reason is None, "reason": reason}
