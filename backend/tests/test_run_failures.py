"""A run that crashes while scoring is recorded FAILED, never left RUNNING for requests to dedupe to."""

from __future__ import annotations

import inspect
from datetime import date

import pytest
from sqlalchemy import select

from backstop.api import ops
from backstop.harness import runner
from backstop.models import AuditEvent, Run

# A rule date no other test uses, so the run key is this test's own.
RULE_DATE = date(2026, 11, 17)


def _run(session, settings):
    return runner.execute_run(session, settings, workflow_code="qa-handoff", prompt_version=3, model_id="sim-large",
                              adapter_kind="simulated", rule_date=RULE_DATE, limit=3, actor="tests")


def test_a_crash_while_scoring_marks_the_run_failed_and_the_retry_runs(session, settings, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("review routing exploded")

    monkeypatch.setattr(runner, "_route_review", broken)
    with pytest.raises(RuntimeError, match="exploded"):
        _run(session, settings)

    session.expire_all()
    failed = session.scalars(select(Run).where(Run.rule_date == RULE_DATE)).one()
    assert failed.status == "FAILED" and failed.gate == "GREY" and failed.finished_at is not None
    assert failed.stats["error"] == "RuntimeError: review routing exploded"
    assert not failed.results, "partial results are rolled back with the failed attempt"
    assert session.scalar(select(AuditEvent).where(AuditEvent.event_type == "run.failed",
                                                   AuditEvent.entity_id == failed.id)) is not None

    monkeypatch.undo()
    retry = _run(session, settings)
    assert not retry.deduplicated and retry.run.id != failed.id
    assert retry.run.status == "COMPLETE"


def test_ingest_runs_in_the_threadpool_not_on_the_event_loop():
    assert not inspect.iscoroutinefunction(ops.ingest_transcripts)
