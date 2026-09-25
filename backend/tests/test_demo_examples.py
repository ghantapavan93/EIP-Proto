"""`backstop demo` seeds two labelled example test cases without moving the demo's numbers.

Runs against its own throwaway SQLite database so the shared test database's
runs and approvals cannot change what this asserts.
"""

from __future__ import annotations

import tempfile
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from backstop.core.rules_loader import load_rules
from backstop.db import Base, install_append_only_guard
from backstop.harness import demo_examples as dx
from backstop.harness import runner
from backstop.models import AuditEvent, ReviewTask, Run, Transcript
from backstop.models import TestCase as CaseRow  # aliased: pytest would try to collect "TestCase"

PLAN = [  # the demo's four simulated acts
    (1, "sim-large", date(2026, 9, 30), "MANUAL"),
    (1, "sim-large", date(2026, 10, 1), "RULE"),
    (2, "sim-large", date(2026, 10, 1), "PROMPT"),
    (2, "sim-small", date(2026, 10, 1), "MODEL"),
]


@pytest.fixture(scope="module")
def demo_db(settings):
    path = Path(tempfile.mkdtemp(prefix="backstop-demo-")) / "demo.db"
    engine = create_engine(f"sqlite:///{path.as_posix()}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        install_append_only_guard(conn)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with factory() as session:
        load_rules(session, settings.rules_dir, actor="tests")
        runner.seed_models(session)
        runner.seed_workflow(session)
        runner.seed_contracts(session, settings.contracts_dir)
        runner.seed_corpus(session)
        session.commit()
    yield factory
    engine.dispose()


def _run_plan(session, settings):
    return [
        runner.execute_run(session, settings, workflow_code="qa-handoff", prompt_version=p, model_id=m,
                           adapter_kind="simulated", rule_date=rd, trigger=t, actor="system:runner",
                           reuse_pre_override_run=True)
        for p, m, rd, t in PLAN
    ]


def test_examples_are_seeded_labelled_and_idempotent(demo_db, settings):
    with demo_db() as session:
        first = _run_plan(session, settings)
        rule_run = first[1].run
        numbers = {o.run.id: o.run.stats["contracts"] for o in first}
        assert rule_run.stats["contracts"]["C-TPMO-01"]["FAIL"] == 14
        assert rule_run.stats["contracts"]["C-SOA-01"]["FAIL"] == 8

        report = dx.seed_example_test_cases(session)
        assert [(r["contract"], r["status"], r["created"]) for r in report] == [
            ("C-SOA-01", "APPROVED", True), ("C-TPMO-01", "PENDING_APPROVAL", True)]

        cases = session.scalars(select(CaseRow)).all()
        assert len(cases) == 2
        for case in cases:
            assert case.expected["seeded_example"] is True
            assert case.reason_code == "TRANSCRIPT_AMBIGUOUS" and case.created_by == dx.QA_REVIEWER
            task = session.get(ReviewTask, case.review_task_id)
            assert task.state == "overridden" and task.payload["seeded_example"] is True
            assert task.payload["run_id"] == rule_run.id and task.payload["lane"] == "actionable"
            assert "Seeded example" in task.note and task.decided_by == dx.QA_REVIEWER
        approved = next(c for c in cases if c.status == "APPROVED")
        assert approved.approver == dx.COMPLIANCE_LEAD != approved.created_by

        rows = session.scalars(select(AuditEvent).where(AuditEvent.actor.like("demo-seed:%"))).all()
        assert {r.actor_role for r in rows} == {"demo-seed"}
        assert {r.event_type for r in rows} == {"task.transitioned", "test_case.created", "test_case.approved"}

        # Deterministic pick: the lowest transcript code among the run's open findings.
        soa_case = next(c for c in cases if c.status == "APPROVED")
        assert session.get(Transcript, soa_case.transcript_id).code == report[0]["transcript"]

        # Idempotent: a second demo invocation reuses every run and seeds nothing new.
        runs_before = len(session.scalars(select(Run)).all())
        again = _run_plan(session, settings)
        assert all(o.deduplicated for o in again)
        assert {o.run.id: o.run.stats["contracts"] for o in again} == numbers
        assert len(session.scalars(select(Run)).all()) == runs_before
        report2 = dx.seed_example_test_cases(session)
        assert [r["created"] for r in report2] == [False, False]
        assert len(session.scalars(select(CaseRow)).all()) == 2


def test_later_runs_honour_the_approved_example(demo_db, settings):
    with demo_db() as session:
        approved = session.scalars(select(CaseRow).where(CaseRow.status == "APPROVED")).one()
        # Not the demo: no reuse flag, so the approval changes the key and the override applies.
        out = runner.execute_run(session, settings, workflow_code="qa-handoff", prompt_version=1,
                                 model_id="sim-large", adapter_kind="simulated", rule_date=date(2026, 10, 1),
                                 trigger="RULE", actor="tests")
        assert out.deduplicated is False
        assert out.run.stats["test_cases"]["applied"] == 1
        overridden = [r for r in out.run.results if runner.overridden(r)]
        assert [r.evidence["override"]["test_case_id"] for r in overridden] == [approved.id]
        # The verdict is still computed and counted; it just no longer decides anything.
        assert out.run.stats["contracts"]["C-SOA-01"]["FAIL"] == 8
