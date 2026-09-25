"""Evidence bundle export: GET /api/evidence/{tasks|runs|rules}/{id}?format=json|md."""

from __future__ import annotations

import json
from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import select

from backstop.api.deps import SessionDep, UserDep
from backstop.core import audit, evidence
from backstop.models import ReviewTask, Rule, Run

router = APIRouter(prefix="/evidence", tags=["evidence"])

Fmt = Literal["json", "md"]


def _respond(session, bundle: dict, *, fmt: str, user, entity_type: str, entity_id: str) -> Response:
    audit.record(session, actor=user.name, role=user.role, event_type="evidence.exported", entity_type=entity_type,
                 entity_id=entity_id, payload={"format": fmt, "bundle_sha256": bundle["bundle_sha256"],
                                               "schema": bundle["schema"], "audit_rows": len(bundle.get("audit_events", []))})
    session.commit()
    stem = f"backstop-evidence-{entity_type}-{entity_id[:12]}"
    if fmt == "md":
        body, media, name = evidence.to_markdown(bundle), "text/markdown; charset=utf-8", f"{stem}.md"
    else:
        body, media, name = json.dumps(bundle, indent=2, ensure_ascii=False), "application/json", f"{stem}.json"
    return Response(content=body, media_type=media, headers={
        "Content-Disposition": f'attachment; filename="{name}"', "X-Bundle-SHA256": bundle["bundle_sha256"]})


@router.get("/tasks/{task_id}")
def task_bundle(task_id: str, session: SessionDep, user: UserDep, format: Fmt = Query("json")):
    task = session.get(ReviewTask, task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    bundle = evidence.for_task(session, task, actor=user.name, role=user.role)
    return _respond(session, bundle, fmt=format, user=user, entity_type="review_task", entity_id=task.id)


@router.get("/runs/{run_id}")
def run_bundle(run_id: str, session: SessionDep, user: UserDep, format: Fmt = Query("json")):
    run = session.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    bundle = evidence.for_run(session, run, actor=user.name, role=user.role)
    return _respond(session, bundle, fmt=format, user=user, entity_type="run", entity_id=run.id)


@router.get("/rules/{code}")
def rule_bundle(code: str, session: SessionDep, user: UserDep, format: Fmt = Query("json"),
                as_of: date = Query(default_factory=date.today)):
    rule = session.scalar(select(Rule).where(Rule.code == code))
    if rule is None:
        raise HTTPException(404, "rule not found")
    bundle = evidence.for_rule(session, rule, as_of, actor=user.name, role=user.role)
    return _respond(session, bundle, fmt=format, user=user, entity_type="rule", entity_id=rule.id)
