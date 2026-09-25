"""Audit log: read the append-only event trail and verify its hash chain.

    GET /api/audit          filtered, newest-first page of audit events
    GET /api/audit/actors   the people who appear in the log (for the actor filter)
    GET /api/audit/verify   recompute the SHA-256 chain; names the first broken link.
                            With ?through_id=&tip= it also checks an admin checkpoint.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select

from backstop import schemas as s
from backstop.api.deps import SessionDep, UserDep
from backstop.models import AuditEvent

router = APIRouter(tags=["audit"])


# Actors that are not people: automation, refused logins and names no account matches.
_NON_PERSON_ROLES = ("system", "unauthenticated", "unknown")


@router.get("/audit/actors")
def audit_actors(session: SessionDep, user: UserDep):
    """Every person (and seeded demo persona) with at least one audit row, busiest first."""
    rows = session.execute(
        select(AuditEvent.actor, AuditEvent.actor_role, func.count().label("events"))
        .where(AuditEvent.actor_role.not_in(_NON_PERSON_ROLES))
        .group_by(AuditEvent.actor, AuditEvent.actor_role)
        .order_by(func.count().desc(), AuditEvent.actor)
    ).all()
    return [{"actor": a, "role": r, "events": n} for a, r, n in rows]


@router.get("/audit/verify")
def audit_verify(session: SessionDep, user: UserDep, through_id: int | None = Query(None, ge=1),
                 tip: str | None = Query(None, pattern="^[0-9a-f]{64}$")):
    """Recompute the audit hash chain. ok=False names the first row that no longer links.

    Pass a checkpoint (through_id + tip, from POST /api/admin/audit-checkpoints) to also
    prove the history up to that row is the history that was checkpointed.
    """
    from backstop.core import audit

    if (through_id is None) != (tip is None):
        raise HTTPException(422, "a checkpoint needs both through_id and tip")
    return audit.verify_chain(session, (through_id, tip) if through_id is not None and tip is not None else None)


@router.get("/audit", response_model=s.Page)
def audit_log(session: SessionDep, user: UserDep, entity_type: str | None = None, event_type: str | None = None,
              entity_id: str | None = None, actor: str | None = None, correlation_id: str | None = None, limit: int = Query(100, ge=1, le=500),
              offset: int = Query(0, ge=0)):
    q = select(AuditEvent)
    if entity_type:
        q = q.where(AuditEvent.entity_type == entity_type)
    if event_type:
        q = q.where(AuditEvent.event_type == event_type)
    if entity_id:
        q = q.where(AuditEvent.entity_id == entity_id)
    if actor:
        q = q.where(AuditEvent.actor == actor)
    if correlation_id:
        q = q.where(AuditEvent.correlation_id == correlation_id)
    total = session.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = session.scalars(q.order_by(AuditEvent.id.desc()).offset(offset).limit(limit)).all()
    return s.Page(items=[s.AuditOut.model_validate(r) for r in rows], total=total)
