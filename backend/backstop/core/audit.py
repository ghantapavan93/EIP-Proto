"""Append-only audit log.

Every state change in Backstop goes through `record`. The catalog below is the
complete vocabulary; the UI filters on it and tests assert on it.
"""

from __future__ import annotations

import hashlib
import json
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


def _last_hash(session: Session) -> str:
    cached = session.info.get(_CHAIN_KEY)
    if cached is not None:
        return cached
    bind = session.get_bind()
    if bind.dialect.name == "postgresql":
        # Held until this transaction ends, so concurrent writers append in turn
        # instead of forking the chain from the same predecessor.
        session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _PG_CHAIN_LOCK})
    last = session.scalar(select(AuditEvent.row_hash).order_by(AuditEvent.id.desc()).limit(1))
    return last or GENESIS


@event.listens_for(Session, "after_commit")
@event.listens_for(Session, "after_rollback")
def _forget_chain_tip(session: Session, *args) -> None:
    session.info.pop(_CHAIN_KEY, None)


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


def verify_chain(session: Session) -> dict[str, Any]:
    """Recompute every row's hash in id order. Reports the first break, if any."""
    expected_prev = GENESIS
    checked = 0
    for row in session.scalars(select(AuditEvent).order_by(AuditEvent.id)).yield_per(500):
        digest = row_digest(row.prev_hash, ts=row.ts, actor=row.actor, actor_role=row.actor_role,
                            event_type=row.event_type, entity_type=row.entity_type, entity_id=row.entity_id,
                            payload=row.payload or {}, correlation_id=row.correlation_id)
        if row.prev_hash != expected_prev or digest != row.row_hash:
            return {"ok": False, "checked": checked, "first_broken_id": row.id,
                    "reason": "prev_hash does not link" if row.prev_hash != expected_prev else "row content changed",
                    "tip": expected_prev}
        expected_prev = row.row_hash
        checked += 1
    return {"ok": True, "checked": checked, "first_broken_id": None, "reason": None, "tip": expected_prev}
