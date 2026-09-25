"""Audit log: read the append-only event trail and verify its hash chain.

    GET /api/audit          filtered, newest-first page of audit events
    GET /api/audit/verify   recompute the SHA-256 chain; names the first broken link
"""

from __future__ import annotations

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from backstop import schemas as s
from backstop.api.deps import SessionDep, UserDep
from backstop.models import AuditEvent

router = APIRouter(tags=["audit"])


@router.get("/audit/verify")
def audit_verify(session: SessionDep, user: UserDep):
    """Recompute the audit hash chain. ok=False names the first row that no longer links."""
    from backstop.core import audit

    return audit.verify_chain(session)


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
