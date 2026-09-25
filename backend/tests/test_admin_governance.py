"""What the admin role adds: access review, adopting the rule corpus, audit checkpoints.

An engineer operates the harness; an admin governs it. These tests pin the line
between the two and prove each governance action does what it claims.
"""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete
from sqlalchemy.orm import sessionmaker

from backstop.api import admin as admin_api
from backstop.core import audit
from backstop.main import app
from backstop.models import AuditEvent, Base


def auth(user: str, password: str | None = None) -> dict[str, str]:
    token = base64.b64encode(f"{user}:{password or user}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


GOVERNANCE = [("GET", "/api/admin/access"), ("GET", "/api/admin/audit-checkpoints"),
              ("POST", "/api/admin/audit-checkpoints"), ("POST", "/api/rules/reload")]


@pytest.mark.parametrize("user", ["analyst", "engineer"])
@pytest.mark.parametrize(("method", "path"), GOVERNANCE)
def test_only_an_admin_may_govern(client, user, method, path):
    r = client.request(method, path, headers=auth(user))
    assert r.status_code == 403, (user, path, r.text)
    assert f"role '{user}' may not do this" in r.json()["detail"]


def test_adopting_the_rule_corpus_is_an_admin_action(client):
    r = client.post("/api/rules/reload", headers=auth("admin"))
    assert r.status_code == 200 and "unchanged" in r.json()


# ---------------------------------------------------------------- access review


def test_access_review_lists_every_account_without_secrets(client):
    r = client.get("/api/admin/access", headers=auth("admin"))
    assert r.status_code == 200
    body = r.json()
    names = {a["name"]: a for a in body["accounts"]}
    assert {"analyst", "engineer", "admin"} <= set(names)
    assert names["engineer"]["role_label"] == "AI Enablement Engineer"
    assert all(a["default_credentials"] for a in names.values())  # the test accounts are password == username
    assert body["default_credential_accounts"] == len(names)
    assert set(names["admin"]) == {"name", "role", "role_label", "default_credentials", "last_recorded_action_at",
                                   "last_recorded_action", "actions_30d", "denied_30d"}  # nothing secret
    assert "admin:admin" not in r.text
    assert "OIDC" in body["identity_source"]


def test_access_review_shows_refusals_and_is_itself_audited(client):
    client.get("/api/me", headers=auth("engineer", "wrong-password"))
    client.post("/api/admin/audit-checkpoints", headers=auth("analyst"))
    body = client.get("/api/admin/access", headers=auth("admin")).json()
    kinds = {(d["actor"], d["kind"]) for d in body["recent_denied"]}
    assert ("engineer", "bad_credentials") in kinds
    assert ("analyst", "insufficient_role") in kinds
    role_denial = next(d for d in body["recent_denied"] if d["kind"] == "insufficient_role")
    assert role_denial["detail"] == "signed in as analyst; needed admin"
    assert body["denied_24h"] >= 2
    reviewed = client.get("/api/audit?event_type=access.reviewed", headers=auth("admin")).json()["items"]
    assert reviewed and reviewed[0]["actor"] == "admin" and reviewed[0]["actor_role"] == "admin"


def test_access_matrix_matches_the_permission_table(client):
    body = client.get("/api/admin/access", headers=auth("admin")).json()
    matrix = {row["action"]: row["roles"] for row in body["matrix"]}
    assert matrix["reload_rules"] == matrix["review_access"] == matrix["checkpoint_audit"] == ["admin"]
    assert matrix["start_runs"] == ["engineer", "admin"]
    assert matrix["decide_tasks"][0] == "analyst"


# ---------------------------------------------------------------- audit checkpoints


def test_a_checkpoint_is_a_receipt_that_verifies_later(client):
    r = client.post("/api/admin/audit-checkpoints", headers=auth("admin"))
    assert r.status_code == 201, r.text
    cp = r.json()
    assert cp["taken_by"] == "admin" and len(cp["tip"]) == 64 and cp["rows_verified"] > 0
    # More history after the checkpoint does not invalidate it.
    client.get("/api/admin/access", headers=auth("admin"))
    verified = client.get(cp["verify_path"], headers=auth("analyst")).json()
    assert verified["ok"] is True and verified["checkpoint"]["matches"] is True
    listed = client.get("/api/admin/audit-checkpoints", headers=auth("admin")).json()
    assert listed[0]["id"] == cp["id"]


def test_a_checkpoint_that_does_not_match_fails_verification(client):
    cp = client.post("/api/admin/audit-checkpoints", headers=auth("admin")).json()
    forged = client.get(f"/api/audit/verify?through_id={cp['through_id']}&tip={'0' * 64}",
                        headers=auth("analyst")).json()
    assert forged["ok"] is False and "rewritten" in forged["reason"]
    missing = client.get(f"/api/audit/verify?through_id=999999999&tip={cp['tip']}", headers=auth("analyst")).json()
    assert missing["ok"] is False and "missing" in missing["reason"]
    half = client.get(f"/api/audit/verify?through_id={cp['through_id']}", headers=auth("analyst"))
    assert half.status_code == 422


def test_no_checkpoint_over_a_broken_chain(client, monkeypatch):
    monkeypatch.setattr(admin_api.audit, "verify_chain", lambda session, checkpoint=None: {
        "ok": False, "first_broken_id": 7, "reason": "row content changed", "checked": 6, "tip": "x", "tip_id": 6})
    r = client.post("/api/admin/audit-checkpoints", headers=auth("admin"))
    assert r.status_code == 409 and "broken at row 7" in r.json()["detail"]


def test_a_checkpoint_catches_a_full_consistent_rewrite(tmp_path):
    """The attack the chain alone cannot see: drop the triggers, rewrite every row, and
    recompute a perfectly consistent chain. The checkpoint kept outside still catches it."""
    engine = create_engine(f"sqlite:///{(tmp_path / 'rewrite.db').as_posix()}")
    Base.metadata.create_all(engine)  # no append-only guard: the attacker removed it
    Session = sessionmaker(engine)
    with Session() as session:
        for decision in ("approved", "approved", "rejected"):
            audit.record(session, actor="system:scanner", event_type="task.transitioned", entity_type="review_task",
                         entity_id="t1", payload={"to": decision})
        session.commit()
        honest = audit.verify_chain(session)
        receipt = (honest["tip_id"], honest["tip"])

        session.execute(delete(AuditEvent))
        session.commit()
        for decision in ("approved", "approved", "approved"):  # history rewritten to hide the rejection
            audit.record(session, actor="system:scanner", event_type="task.transitioned", entity_type="review_task",
                         entity_id="t1", payload={"to": decision})
        session.commit()

        assert audit.verify_chain(session)["ok"] is True  # internally consistent: the chain alone is fooled
        checked = audit.verify_chain(session, receipt)
    assert checked["ok"] is False and checked["checkpoint"]["matches"] is False
    assert "rewritten" in checked["reason"] or "missing" in checked["reason"]
    engine.dispose()
