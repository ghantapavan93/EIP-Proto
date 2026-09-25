"""Review queue and test cases: the human decision loop.

    GET  /api/review                        open work, grouped into actionable and advisory lanes
    GET  /api/review/{task_id}              one task with its evidence
    POST /api/review/{task_id}/transition   move a task through the state machine (role-checked)
    GET  /api/test-cases                    overrides captured as regression cases
    POST /api/test-cases/{id}/approve       approve a case so future runs replay it
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from backstop import schemas as s
from backstop.api.deps import SessionDep, User, UserDep, require_role
from backstop.api.serializers import task_lane, task_out
from backstop.core import review_actions
from backstop.models import (
    Asset,
    Contract,
    ContractVersion,
    ReviewTask,
    RuleAssetEdge,
    RuleVersion,
    RunResult,
    TestCase,
    Transcript,
)

router = APIRouter(tags=["review"])


@router.get("/review", response_model=list[s.ReviewTaskOut])
def list_tasks(session: SessionDep, user: UserDep, state: str | None = None, kind: str | None = None,
               lane: Literal["actionable", "advisory"] | None = None):
    q = select(ReviewTask).order_by(ReviewTask.opened_at.desc())
    if state:
        q = q.where(ReviewTask.state == state)
    if kind:
        q = q.where(ReviewTask.kind == kind)
    tasks = session.scalars(q).all()
    if lane:
        tasks = [t for t in tasks if task_lane(t) == lane]
    loaded = _prefetch(session, tasks)  # noqa: F841 — held so the identity map (weakly referenced) keeps them
    return [task_out(session, t, user.role) for t in tasks]


def _prefetch(session, tasks: Sequence[ReviewTask]) -> list:
    """Load everything task_out touches in a handful of IN queries.

    task_out resolves each task's rule version, artifact, edge and run result with
    session.get(); once those rows sit in the identity map, get() costs no SQL.
    The identity map only holds weak references, so the caller keeps the returned
    list alive while serializing. Without this the queue page issued ~550 queries.
    """
    loaded: list = []
    def ids(attr: str) -> list[str]:
        return sorted({getattr(t, attr) for t in tasks if getattr(t, attr)})

    if rv_ids := ids("rule_version_id"):
        loaded += session.scalars(select(RuleVersion).where(RuleVersion.id.in_(rv_ids))
                                  .options(selectinload(RuleVersion.rule))).all()
    if asset_ids := ids("asset_id"):
        loaded += session.scalars(select(Asset).where(Asset.id.in_(asset_ids))).all()
    if edge_ids := ids("edge_id"):
        loaded += session.scalars(select(RuleAssetEdge).where(RuleAssetEdge.id.in_(edge_ids))).all()
    if rr_ids := ids("run_result_id"):
        loaded += session.scalars(select(RunResult).where(RunResult.id.in_(rr_ids)).options(
            selectinload(RunResult.transcript),
            selectinload(RunResult.contract_version).selectinload(ContractVersion.contract),
        )).all()
    return loaded


@router.get("/review/{task_id}", response_model=s.ReviewTaskOut)
def get_task(task_id: str, session: SessionDep, user: UserDep):
    task = session.get(ReviewTask, task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    return task_out(session, task, user.role)


@router.post("/review/{task_id}/transition", response_model=s.ReviewTaskOut)
def transition(task_id: str, body: s.TransitionRequest, session: SessionDep, user: UserDep):
    # Row lock (Postgres; a no-op on SQLite, which serialises writers anyway) so
    # two reviewers deciding the same task cannot both pass the state check and
    # create two test cases.
    task = session.scalar(select(ReviewTask).where(ReviewTask.id == task_id).with_for_update())
    if task is None:
        raise HTTPException(404, "task not found")
    try:
        created_case = review_actions.transition_task(session, task, to=body.to, reason_code=body.reason_code,
                                                      note=body.note, actor=user.name, role=user.role)
    except review_actions.Refused as exc:
        session.commit()  # keep the task.transition_rejected row
        raise HTTPException(exc.status, exc.message) from exc
    session.commit()
    out = task_out(session, task, user.role)
    if created_case:
        out.payload = dict(out.payload, test_case_id=created_case.id)
    return out


@router.get("/test-cases", response_model=list[s.TestCaseOut])
def list_test_cases(session: SessionDep, user: UserDep):
    rows = session.scalars(select(TestCase).order_by(TestCase.created_at.desc())).all()
    return [_test_case_out(session, tc) for tc in rows]


def _test_case_out(session, tc: TestCase) -> s.TestCaseOut:
    contract = session.get(Contract, tc.contract_id)
    transcript = session.get(Transcript, tc.transcript_id) if tc.transcript_id else None
    return s.TestCaseOut(
        id=tc.id, review_task_id=tc.review_task_id, contract_code=contract.code if contract else "?",
        transcript_code=transcript.code if transcript else None, expected=tc.expected, reason_code=tc.reason_code,
        created_by=tc.created_by, approver=tc.approver, status=tc.status, expires_at=tc.expires_at,
        created_at=tc.created_at,
    )


@router.post("/test-cases/{case_id}/approve", response_model=s.TestCaseOut)
def approve_test_case(case_id: str, session: SessionDep, user: User = Depends(require_role("engineer", "admin"))):
    tc = session.get(TestCase, case_id)
    if tc is None:
        raise HTTPException(404, "test case not found")
    try:
        review_actions.approve_test_case(session, tc, actor=user.name)
    except review_actions.Refused as exc:
        raise HTTPException(exc.status, exc.message) from exc
    session.commit()
    return _test_case_out(session, tc)
