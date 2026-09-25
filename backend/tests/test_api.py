"""API tests through FastAPI's TestClient (auth, roles, impact, review loop, audit)."""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from backstop.main import app


def auth(user: str) -> dict[str, str]:
    token = base64.b64encode(f"{user}:{user}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


def test_requests_without_credentials_are_refused(client):
    assert client.get("/api/rules").status_code == 401


def test_meta_reports_adapters_and_role(client):
    r = client.get("/api/meta", headers=auth("analyst"))
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == "analyst"
    assert body["adapters"]["simulated"] is True
    assert body["adapters"]["anthropic"] is False


def test_analysts_cannot_start_runs_or_scans(client):
    r = client.post("/api/scans", json={}, headers=auth("analyst"))
    assert r.status_code == 403
    r = client.post("/api/runs", json={"prompt_version": 2, "model_id": "sim-large", "rule_date": "2026-10-01"},
                    headers=auth("analyst"))
    assert r.status_code == 403


def test_impact_flips_on_the_effective_date(client):
    before = client.get("/api/rules/soa-48h-wait/impact?as_of=2026-09-30", headers=auth("analyst")).json()
    # An analyst's read is pure: same verdicts, but it opens no review tasks.
    tasks_before = len(client.get("/api/review?kind=STALE_ASSET", headers=auth("analyst")).json())
    read_only = client.get("/api/rules/soa-48h-wait/impact?as_of=2026-10-01", headers=auth("analyst")).json()
    assert len(client.get("/api/review?kind=STALE_ASSET", headers=auth("analyst")).json()) == tasks_before
    after = client.get("/api/rules/soa-48h-wait/impact?as_of=2026-10-01", headers=auth("engineer")).json()
    assert read_only["counts"] == after["counts"]
    assert before["in_force_version"] == 1 and before["counts"]["total"] == 0
    assert after["in_force_version"] == 2 and after["counts"]["over_restrictive"] >= 5
    assert any(not item["edge"]["asset_is_synthetic"] for item in after["stale"]), "a real page must be in the blast radius"
    assert all(item["task_state"] == "open" for item in after["stale"])
    assert any(p["version"] == 1 and p["stale"] for p in after["prompt_versions"])


def test_disputed_rule_is_carried_not_resolved(client):
    rule = client.get("/api/rules/call-recording-retention", headers=auth("analyst")).json()
    v2 = next(v for v in rule["versions"] if v["version"] == 2)
    assert v2["disputed"] is True and "counsel" in v2["dispute_note"]


def test_review_state_machine_over_http(client):
    tasks = client.get("/api/review?kind=PROPOSED_EDGE&state=open", headers=auth("analyst")).json()
    assert tasks, "the scan should have proposed at least one edge"
    task = tasks[0]
    assert set(task["allowed_transitions"]) == {"dismissed", "verified"}
    r = client.post(f"/api/review/{task['id']}/transition", json={"to": "republished"}, headers=auth("analyst"))
    assert r.status_code == 409
    r = client.post(f"/api/review/{task['id']}/transition", json={"to": "dismissed"}, headers=auth("analyst"))
    assert r.status_code == 422  # a reason code is required
    r = client.post(f"/api/review/{task['id']}/transition",
                    json={"to": "dismissed", "reason_code": "ARTIFACT_NOT_IN_SCOPE", "note": "SOA retention, not recording"},
                    headers=auth("analyst"))
    assert r.status_code == 200 and r.json()["state"] == "dismissed"
    log = client.get(f"/api/audit?entity_id={task['id']}", headers=auth("analyst")).json()
    types = [e["event_type"] for e in log["items"]]
    assert "task.transition_rejected" in types and "task.transitioned" in types


def test_override_creates_a_test_case_that_needs_a_different_approver(client):
    run = client.post("/api/runs", json={"prompt_version": 1, "model_id": "sim-large", "rule_date": "2026-10-01",
                                         "trigger": "RULE"}, headers=auth("engineer")).json()
    assert run["gate"] == "RED"
    tasks = [t for t in client.get("/api/review?kind=FLAGGED_RESULT&state=open", headers=auth("engineer")).json()
             if t["run_id"] == run["id"] and t["contract_code"] == "C-TPMO-01"]
    assert tasks
    r = client.post(f"/api/review/{tasks[0]['id']}/transition",
                    json={"to": "overridden", "reason_code": "TRANSCRIPT_AMBIGUOUS", "note": "benefits mention was generic"},
                    headers=auth("engineer"))
    assert r.status_code == 200
    case_id = r.json()["payload"]["test_case_id"]
    cases = client.get("/api/test-cases", headers=auth("engineer")).json()
    case = next(c for c in cases if c["id"] == case_id)
    assert case["status"] == "PENDING_APPROVAL" and case["created_by"] == "engineer"
    same = client.post(f"/api/test-cases/{case_id}/approve", headers=auth("engineer"))
    assert same.status_code == 409
    other = client.post(f"/api/test-cases/{case_id}/approve", headers=auth("admin"))
    assert other.status_code == 200 and other.json()["status"] == "APPROVED"


def test_compare_names_what_changed(client):
    a = client.post("/api/runs", json={"prompt_version": 1, "model_id": "sim-large", "rule_date": "2026-09-30"},
                    headers=auth("engineer")).json()
    b = client.post("/api/runs", json={"prompt_version": 1, "model_id": "sim-large", "rule_date": "2026-10-01",
                                       "trigger": "RULE"}, headers=auth("engineer")).json()
    cmp = client.get(f"/api/runs/compare?a={a['id']}&b={b['id']}", headers=auth("analyst")).json()
    assert cmp["what_changed"] == {"prompt": False, "model": False, "rule_date": True, "adapter": False,
                                   "corpus": False, "contract_set": False,
                                   "cells_only_in_a": 0, "cells_only_in_b": 0}
    assert len(cmp["newly_failing"]) == 25 and cmp["newly_passing"] == []


def test_run_transcript_marks_unverified_spans(client):
    runs = client.get("/api/runs", headers=auth("analyst")).json()
    small = next((r for r in runs if r["model_id"] == "sim-small"), None)
    if small is None:
        small = client.post("/api/runs", json={"prompt_version": 2, "model_id": "sim-small", "rule_date": "2026-10-01",
                                               "trigger": "MODEL"}, headers=auth("engineer")).json()
    failing = client.get(f"/api/runs/{small['id']}/results?contract=C-SPAN-01&outcome=FAIL", headers=auth("analyst")).json()
    assert failing
    detail = client.get(f"/api/runs/{small['id']}/transcripts/{failing[0]['transcript_code']}", headers=auth("analyst")).json()
    assert any(not s["verified"] for s in detail["spans"])
    assert detail["transcript"]["synthetic"] is True


def test_model_board_separates_measured_from_declared(client, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    # A simulated run exists for sim-large at v2 / Oct 1 after the tests above; sim-small too.
    client.post("/api/runs", json={"prompt_version": 2, "model_id": "sim-large", "rule_date": "2026-10-01"},
                headers=auth("engineer"))
    board = client.get("/api/models/board?prompt=2&rule_date=2026-10-01", headers=auth("analyst")).json()
    assert board["prompt_version"] == 2 and board["rule_date"] == "2026-10-01"
    rows = {r["model"]["model_id"]: r for r in board["rows"]}

    sim = rows["sim-large"]
    assert sim["tier"] == "simulated" and sim["availability"] == "simulated"
    assert sim["latest_run"]["gate"] == "GREEN" and sim["matched"] is True
    assert sim["measured"] is False, "a declared profile is never 'measured'"

    groq = rows["groq/llama-3.1-8b-instant"]
    assert groq["tier"] == "free-tier" and groq["availability"] == "needs-key" and groq["key_env"] == "GROQ_API_KEY"
    assert groq["latest_run"] is None and groq["cassettes"] == []

    local = rows["ollama/qwen2.5:7b-instruct"]
    assert local["tier"] == "local" and local["availability"] in ("ready", "not-pulled", "offline")
    assert board["providers"]["ollama"]["key_env"] is None
    assert board["providers"]["simulated"]["available"] is True
