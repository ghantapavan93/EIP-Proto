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


def verify_chain(session: Session, checkpoint: tuple[int, str] | None = None) -> dict[str, Any]:
    """Recompute every row's hash in id order. Reports the first break, if any.

    The chain alone is tamper-evident, not tamper-proof: someone able to drop the
    append-only triggers could rewrite every row and recompute a consistent chain.
    A checkpoint closes that gap. It is (row id, row hash) taken earlier and kept
    outside the database; if the chain no longer contains that exact hash at that
    row, history before the checkpoint was rewritten, and the result is not ok.
    """
    expected_prev = GENESIS
    checked = 0
    tip_id: int | None = None
    seen_at_checkpoint: str | None = None
    for row in session.scalars(select(AuditEvent).order_by(AuditEvent.id)).yield_per(500):
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
