"""Two honestly-labelled example test cases, seeded by `backstop demo`.

Without them the Test cases page is empty until someone overrides a finding and
a second person approves it. The examples go through the same code path a
reviewer's decision does (`core.review_actions`), by two named demo personas
whose audit rows carry the role "demo-seed", and every row they touch says
`seeded_example: true`. One is approved (so later runs honour it, as the
override loop promises); the other is left pending so both states show.

Runs the demo already executed are not re-scored: the demo's numbers are
computed before these exist, and its replays reuse those runs on restart.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from backstop.core import review_actions
from backstop.core import state_machine as sm
from backstop.models import Contract, Model, PromptVersion, ReviewTask, Run, TestCase, Transcript

QA_REVIEWER = "demo-seed:qa-reviewer"
COMPLIANCE_LEAD = "demo-seed:compliance-lead"
REASON_CODE = "TRANSCRIPT_AMBIGUOUS"
# (contract, approve?) — one of each state.
EXAMPLES: list[tuple[str, bool]] = [("C-SOA-01", True), ("C-TPMO-01", False)]
NOTE = ("Seeded example created by `backstop demo` to show the override → second-person approval loop. "
        "Not a real reviewer's decision about this call.")


def _source_run(session: Session) -> Run | None:
    """The v1 sim-large run on 2026-10-01 (the RULE act): prompt written for CY2024, rule date after the change."""
    return session.scalar(
        select(Run)
        .join(PromptVersion, Run.prompt_version_id == PromptVersion.id)
        .join(Model, Run.model_id == Model.id)
        .where(PromptVersion.version == 1, Model.model_id == "sim-large", Run.rule_date == date(2026, 10, 1),
               Run.trigger == "RULE", Run.status == "COMPLETE")
        .order_by(Run.started_at)
        .limit(1)
    )


def _open_finding(session: Session, run: Run, contract_code: str) -> ReviewTask | None:
    """The first open actionable finding for `contract_code` in `run`, by transcript code (deterministic)."""
    tasks = [
        t for t in session.scalars(select(ReviewTask).where(ReviewTask.kind == "FLAGGED_RESULT",
                                                            ReviewTask.state == sm.OPEN)).all()
        if (t.payload or {}).get("run_id") == run.id
        and (t.payload or {}).get("contract") == contract_code
        and (t.payload or {}).get("lane") == "actionable"
    ]
    if not tasks:
        return None
    codes = {tr.id: tr.code for tr in session.scalars(
        select(Transcript).where(Transcript.id.in_([t.payload.get("transcript_id") for t in tasks]))).all()}
    return min(tasks, key=lambda t: codes.get(t.payload.get("transcript_id"), "~"))


def seed_example_test_cases(session: Session) -> list[dict[str, Any]]:
    """Create the examples if they are missing (idempotent). Returns one line of facts per example."""
    existing = [tc for tc in session.scalars(select(TestCase)).all() if (tc.expected or {}).get("seeded_example")]
    contract_codes = {c.id: c.code for c in session.scalars(select(Contract)).all()}
    have = {contract_codes.get(tc.contract_id): tc for tc in existing}
    run = _source_run(session)
    report: list[dict[str, Any]] = []
    for code, approve in EXAMPLES:
        case = have.get(code)
        created = False
        if case is None and run is not None:
            task = _open_finding(session, run, code)
            if task is None:
                continue
            # Reassign: in-place mutation of a plain JSON column is not persisted.
            task.payload = {**(task.payload or {}), "seeded_example": True}
            case = review_actions.transition_task(
                session, task, to=sm.OVERRIDDEN, reason_code=REASON_CODE, note=NOTE,
                actor=QA_REVIEWER, role="analyst", test_case_extra={"seeded_example": True},
            )
            if case is None:
                continue
            if approve:
                review_actions.approve_test_case(session, case, actor=COMPLIANCE_LEAD)
            created = True
        if case is None:
            continue
        transcript = session.get(Transcript, case.transcript_id) if case.transcript_id else None
        report.append({"contract": code, "transcript": transcript.code if transcript else None,
                       "status": case.status, "created": created})
    session.commit()
    return report
