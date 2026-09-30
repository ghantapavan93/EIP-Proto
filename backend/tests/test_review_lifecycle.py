"""What counts as outstanding review work, and when a task is closed."""

from __future__ import annotations

import base64
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from backstop.core import state_machine as sm
from backstop.core.review_actions import transition_task
from backstop.main import app
from backstop.models import ReviewTask


def auth(user: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{user}".encode()).decode()}


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


def _task(session, kind: str, state: str, role: str) -> ReviewTask:
    task = ReviewTask(kind=kind, state=state, dedupe_key=f"test:{uuid.uuid4()}", assignee_role=role,
                      payload={"lane": "actionable"})
    session.add(task)
    return task


def _status_open(client) -> int:
    review = client.get("/api/status", headers=auth("analyst")).json()["review"]
    return review["actionable_open"] + review["advisory_open"]


def _readiness_owners(client) -> dict[str, int]:
    body = client.get("/api/readiness", params={"as_of": "2026-09-25"}, headers=auth("analyst")).json()
    return {o["role"]: o["open"] for o in body["owners"]}


def test_status_and_readiness_agree_on_what_is_open(client, session):
    role = f"queue-{uuid.uuid4().hex[:8]}"
    before_status = _status_open(client)
    before_readiness = sum(_readiness_owners(client).values())
    assert before_status == before_readiness

    tasks = [
        _task(session, "PROPOSED_EDGE", sm.VERIFIED, role),        # confirmed edge: done
        _task(session, "RULE_SOURCE_CHANGED", sm.VERIFIED, role),  # adopted rule change: done
        _task(session, "STALE_ASSET", sm.VERIFIED, role),          # still to republish: open
        _task(session, "STALE_ASSET", sm.REPUBLISHED, role),       # done
    ]
    session.commit()
    try:
        owners = _readiness_owners(client)
        assert owners[role] == 1
        assert _status_open(client) == before_status + 1
        assert sum(owners.values()) == _status_open(client)
    finally:
        session.execute(delete(ReviewTask).where(ReviewTask.id.in_([t.id for t in tasks])))
        session.commit()


def test_confirming_an_edge_closes_the_task(session):
    task = _task(session, "PROPOSED_EDGE", sm.OPEN, "compliance")
    session.flush()
    transition_task(session, task, to=sm.VERIFIED, reason_code=None, note="", actor="analyst", role="analyst")
    assert task.closed_at is not None and task.decided_by == "analyst"
    session.rollback()


def test_verifying_a_stale_artifact_leaves_it_open_until_republished(session):
    task = _task(session, "STALE_ASSET", sm.IN_REVIEW, "compliance")
    session.flush()
    transition_task(session, task, to=sm.VERIFIED, reason_code=None, note="", actor="analyst", role="analyst")
    assert task.closed_at is None and task.decided_by == "analyst"
    transition_task(session, task, to=sm.REPUBLISHED, reason_code=None, note="", actor="engineer", role="engineer")
    assert task.closed_at is not None
    session.rollback()
