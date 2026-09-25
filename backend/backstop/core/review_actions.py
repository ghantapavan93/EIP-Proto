"""Review-task decisions, shared by the API and the demo seed.

`transition_task` and `approve_test_case` are the one place a task changes
state or a test case is approved. The API maps `Refused` to an HTTP status;
`backstop demo` calls the same functions to seed its labelled examples, so an
example is created exactly the way a reviewer's decision would be.

Neither function commits: the caller owns the transaction (a refusal's audit
row is committed by the caller before it reports the refusal).
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from backstop.core import audit
from backstop.core import state_machine as sm
from backstop.models import ReviewTask, RuleAssetEdge, RunResult, TestCase, utcnow

TEST_CASE_LIFETIME = timedelta(days=365)


class Refused(Exception):
    """A decision the rules do not allow. `status` is the HTTP status the API reports."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def transition_task(
    session: Session,
    task: ReviewTask,
    *,
    to: str,
    reason_code: str | None,
    note: str,
    actor: str,
    role: str,
    test_case_extra: dict[str, Any] | None = None,
) -> TestCase | None:
    """Move `task` to `to` as `actor` (authorised as `role`). Returns the test case an override created.

    Every refusal is audit-logged as `task.transition_rejected` before `Refused` is raised.
    `test_case_extra` is merged into the created test case's `expected` (the demo seed marks
    its examples with it).
    """
    before = task.state

    def refuse(status: int, message: str) -> Refused:
        audit.record(session, actor=actor, event_type="task.transition_rejected", entity_type="review_task",
                     entity_id=task.id, payload={"from": before, "to": to, "reason": message})
        return Refused(status, message)

    try:
        sm.assert_transition(task.kind, task.state, to, role)
    except sm.IllegalTransition as exc:
        raise refuse(409, str(exc)) from exc
    except sm.Forbidden as exc:
        raise refuse(403, str(exc)) from exc

    needs_reason = to in (sm.DISMISSED, sm.OVERRIDDEN, sm.UPHELD)
    bad_code = reason_code is not None and reason_code not in sm.REASON_CODES
    if bad_code or (needs_reason and reason_code is None):
        if bad_code:
            message = f"unknown reason_code; use one of {sorted(sm.REASON_CODES)}"
        else:
            message = f"a reason_code from {sorted(sm.REASON_CODES)} is required for '{to}'"
        raise refuse(422, message)

    task.state = to
    task.reason_code = reason_code or task.reason_code
    task.note = note or task.note
    if sm.is_terminal(to) or to == sm.VERIFIED:
        task.decided_by = actor
    if sm.is_terminal(to):
        task.closed_at = utcnow()

    # Side effects that make the loop real.
    if task.kind == "PROPOSED_EDGE" and task.edge_id:
        edge = session.get(RuleAssetEdge, task.edge_id)
        if edge is not None:
            if to == sm.VERIFIED:
                edge.status, edge.confirmed_by = "confirmed", actor
                audit.record(session, actor=actor, event_type="edge.confirmed", entity_type="edge",
                             entity_id=edge.id, payload={"via_task": task.id})
            elif to == sm.DISMISSED:
                edge.status = "rejected"
                audit.record(session, actor=actor, event_type="edge.rejected", entity_type="edge",
                             entity_id=edge.id, payload={"via_task": task.id, "reason_code": reason_code})

    created_case: TestCase | None = None
    if task.kind == "FLAGGED_RESULT" and to == sm.OVERRIDDEN and task.run_result_id:
        rr = session.get(RunResult, task.run_result_id)
        if rr is not None:
            created_case = TestCase(
                review_task_id=task.id,
                contract_id=rr.contract_version.contract_id,
                transcript_id=rr.transcript_id,
                expected={"outcome": "PASS", "overrode": rr.outcome, "evidence_at_override": rr.evidence,
                          **(test_case_extra or {})},
                reason_code=reason_code or "OTHER",
                created_by=actor,
                status="PENDING_APPROVAL",
                expires_at=utcnow() + TEST_CASE_LIFETIME,
            )
            session.add(created_case)
            session.flush()
            audit.record(session, actor=actor, event_type="test_case.created", entity_type="test_case",
                         entity_id=created_case.id, payload={"task": task.id, "contract": rr.contract_version.contract.code,
                                                            "transcript": rr.transcript.code, "reason_code": reason_code})

    audit.record(session, actor=actor, event_type="task.transitioned", entity_type="review_task",
                 entity_id=task.id, payload={"from": before, "to": to, "reason_code": reason_code,
                                             "note": note, "test_case_id": created_case.id if created_case else None})
    return created_case


def approve_test_case(session: Session, tc: TestCase, *, actor: str) -> TestCase:
    """Approve a pending test case. The approver must not be its creator (two-person rule)."""
    if tc.created_by == actor:
        raise Refused(409, "approver must differ from the creator")
    if tc.status != "PENDING_APPROVAL":
        raise Refused(409, f"test case is {tc.status}")
    tc.status, tc.approver = "APPROVED", actor
    audit.record(session, actor=actor, event_type="test_case.approved", entity_type="test_case",
                 entity_id=tc.id, payload={"created_by": tc.created_by})
    return tc
