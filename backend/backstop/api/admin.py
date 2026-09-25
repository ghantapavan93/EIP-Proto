"""Governance: what the admin role adds over an engineer.

An engineer operates the harness; an admin governs it. Three things only an admin
may do, each answering a question an auditor or a CTO asks:

    GET  /api/admin/access               who can do what: accounts, roles, default
                                         passwords, last recorded action, denied attempts
    POST /api/admin/audit-checkpoints    anchor the audit chain: a receipt kept outside
                                         the database that later proves history unchanged
    GET  /api/admin/audit-checkpoints    checkpoints taken so far

The third governance action, adopting the rule corpus (POST /api/rules/reload),
lives with the rules router. Every admin action is itself audit-logged.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select

from backstop import schemas as s
from backstop.api.deps import SessionDep, SettingsDep, User, require_role
from backstop.core import audit, permissions
from backstop.models import AuditEvent, utcnow

router = APIRouter(prefix="/admin", tags=["governance"])

IDENTITY_SOURCE = (
    "Accounts come from the BACKSTOP_USERS environment variable, a stand-in for SSO. Production reads "
    "identities and role claims from the identity provider (OIDC); this review would read the same claims."
)
RECENT_DENIED = 25


def _denied_out(row: AuditEvent) -> s.DeniedAttemptOut:
    payload = row.payload or {}
    if row.entity_id == "role":
        required = " or ".join(payload.get("required", [])) or "another role"
        return s.DeniedAttemptOut(ts=row.ts, actor=row.actor, kind="insufficient_role",
                                  detail=f"signed in as {payload.get('role', '?')}; needed {required}")
    return s.DeniedAttemptOut(ts=row.ts, actor=row.actor, kind="bad_credentials",
                              detail=payload.get("reason", "bad credentials"))


@router.get("/access", response_model=s.AccessReviewOut)
def access_review(session: SessionDep, settings: SettingsDep, user: User = Depends(require_role("admin"))):
    """The access review an auditor asks for: every account, what its role may do, and who was refused."""
    now = utcnow()
    since_30d, since_24h = now - timedelta(days=30), now - timedelta(hours=24)
    table = settings.user_table()
    names = list(table)

    last: dict[str, tuple] = {}
    for actor, ts, event_type in session.execute(
        select(AuditEvent.actor, AuditEvent.ts, AuditEvent.event_type)
        .where(AuditEvent.actor.in_(names), AuditEvent.event_type != "auth.denied")
        .order_by(AuditEvent.id.desc())
    ):
        last.setdefault(actor, (ts, event_type))
    acted: dict[str, int] = dict(session.execute(
        select(AuditEvent.actor, func.count()).where(AuditEvent.actor.in_(names), AuditEvent.ts >= since_30d,
                                                    AuditEvent.event_type != "auth.denied")
        .group_by(AuditEvent.actor)
    ).tuples().all())
    denied: dict[str, int] = dict(session.execute(
        select(AuditEvent.actor, func.count()).where(AuditEvent.actor.in_(names), AuditEvent.ts >= since_30d,
                                                    AuditEvent.event_type == "auth.denied")
        .group_by(AuditEvent.actor)
    ).tuples().all())

    accounts = [
        s.AccessAccountOut(
            name=name, role=role, role_label=permissions.ROLE_INFO[role][0],
            default_credentials=password == name,
            last_recorded_action_at=last.get(name, (None, None))[0],
            last_recorded_action=last.get(name, (None, None))[1],
            actions_30d=acted.get(name, 0), denied_30d=denied.get(name, 0),
        )
        for name, (password, role) in sorted(table.items(), key=lambda kv: (permissions.ROLE_ORDER.index(kv[1][1]), kv[0]))
    ]
    recent = session.scalars(select(AuditEvent).where(AuditEvent.event_type == "auth.denied")
                             .order_by(AuditEvent.id.desc()).limit(RECENT_DENIED)).all()
    denied_24h = session.scalar(select(func.count()).where(AuditEvent.event_type == "auth.denied",
                                                           AuditEvent.ts >= since_24h)) or 0
    matrix = [s.AccessActionOut(action=a.action, label=a.label,
                                roles=[r for r in permissions.ROLE_ORDER if r in a.roles], rule=a.rule)
              for a in permissions.ACTIONS]
    out = s.AccessReviewOut(
        generated_at=now, identity_source=IDENTITY_SOURCE, accounts=accounts,
        default_credential_accounts=sum(a.default_credentials for a in accounts), denied_24h=denied_24h,
        recent_denied=[_denied_out(r) for r in recent], matrix=matrix, roles=permissions.roles_overview(),
    )
    audit.record(session, actor=user.name, event_type="access.reviewed", entity_type="access", entity_id="review",
                 payload={"accounts": len(accounts), "default_credential_accounts": out.default_credential_accounts,
                          "denied_24h": denied_24h})
    session.commit()
    return out


def _checkpoint_out(row: AuditEvent) -> s.AuditCheckpointOut:
    p = row.payload or {}
    return s.AuditCheckpointOut(
        id=row.id, taken_at=row.ts, taken_by=row.actor, through_id=p["through_id"], tip=p["tip"],
        rows_verified=p["rows_verified"], verify_path=f"/api/audit/verify?through_id={p['through_id']}&tip={p['tip']}",
    )


@router.post("/audit-checkpoints", response_model=s.AuditCheckpointOut, status_code=201)
def take_checkpoint(session: SessionDep, user: User = Depends(require_role("admin"))):
    """Verify the whole chain, then record its tip. Refused (409) while the chain is broken:
    a checkpoint must never bless tampered history."""
    chain = audit.verify_chain(session)
    if not chain["ok"]:
        raise HTTPException(409, f"audit chain is broken at row {chain['first_broken_id']} ({chain['reason']}); "
                                 "not checkpointing tampered history")
    if chain["tip_id"] is None:
        raise HTTPException(409, "the audit log is empty; there is nothing to checkpoint")
    row = audit.record(session, actor=user.name, event_type="audit.checkpoint", entity_type="audit",
                       entity_id=str(chain["tip_id"]),
                       payload={"through_id": chain["tip_id"], "tip": chain["tip"], "rows_verified": chain["checked"]})
    session.commit()
    return _checkpoint_out(row)


@router.get("/audit-checkpoints", response_model=list[s.AuditCheckpointOut])
def list_checkpoints(session: SessionDep, user: User = Depends(require_role("admin"))):
    rows = session.scalars(select(AuditEvent).where(AuditEvent.event_type == "audit.checkpoint")
                           .order_by(AuditEvent.id.desc()).limit(50)).all()
    return [_checkpoint_out(r) for r in rows]
