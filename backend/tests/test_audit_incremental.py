"""The status rail verifies only new audit rows; the full check still catches tampering."""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from backstop.core import audit
from backstop.db import Base, get_session
from backstop.main import app


def auth(user: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{user}".encode()).decode()}


def _append(session, n: int) -> None:
    for i in range(n):
        audit.record(session, actor="system:tests", event_type="task.opened", entity_type="review_task",
                     entity_id=f"t{i}", payload={"i": i})
    session.commit()


@pytest.fixture
def unguarded_db(tmp_path):
    """A database without the append-only triggers: the attacker already dropped them."""
    engine = create_engine(f"sqlite:///{(tmp_path / 'chain.db').as_posix()}")
    Base.metadata.create_all(engine)
    Session = sessionmaker(engine, expire_on_commit=False)
    yield Session
    engine.dispose()


@pytest.fixture
def hashed(monkeypatch):
    calls = {"n": 0}
    real = audit.row_digest

    def counting(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(audit, "row_digest", counting)
    return calls


def test_only_rows_appended_since_the_last_check_are_hashed(unguarded_db, hashed):
    with unguarded_db() as session:
        _append(session, 5)
        hashed["n"] = 0
        first = audit.verify_new_rows(session)
        assert first["ok"] and first["checked"] == 5 and hashed["n"] == 5

        hashed["n"] = 0
        assert audit.verify_new_rows(session)["checked"] == 5 and hashed["n"] == 0

        _append(session, 2)
        hashed["n"] = 0
        latest = audit.verify_new_rows(session)
        assert latest["ok"] and latest["checked"] == 7 and hashed["n"] == 2
        assert latest["tip"] == audit.verify_chain(session)["tip"]


def test_a_rewritten_tip_forces_a_full_recheck(unguarded_db):
    with unguarded_db() as session:
        _append(session, 3)
        tip_id = audit.verify_new_rows(session)["tip_id"]
        session.execute(text("UPDATE audit_events SET row_hash = :h WHERE id = :id"), {"h": "f" * 64, "id": tip_id})
        session.commit()
        result = audit.verify_new_rows(session)
        assert result["ok"] is False and result["first_broken_id"] == tip_id


def test_the_full_check_still_catches_a_rewrite_behind_the_cached_tip(seeded, unguarded_db):
    with unguarded_db() as session:
        _append(session, 4)
        assert audit.verify_new_rows(session)["ok"]
        session.execute(text("UPDATE audit_events SET payload = :p WHERE id = (SELECT MIN(id) FROM audit_events)"),
                        {"p": '{"i": 99}'})
        session.commit()

    def private_session():
        with unguarded_db() as s:
            yield s

    app.dependency_overrides[get_session] = private_session
    try:
        with TestClient(app) as client:
            full = client.get("/api/audit/verify", headers=auth("analyst")).json()
    finally:
        app.dependency_overrides.pop(get_session, None)
    assert full["ok"] is False and full["reason"] == "row content changed"
