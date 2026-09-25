"""Attribution, the audit hash chain, evidence bundles, review lanes, the status rail."""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from backstop.core import audit, evidence
from backstop.db import Base, install_append_only_guard
from backstop.harness import workflow as wf
from backstop.main import app


def auth(user: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{user}".encode()).decode()}


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def red_run(client):
    return client.post("/api/runs", json={"prompt_version": 1, "model_id": "sim-large", "rule_date": "2026-10-01",
                                          "trigger": "RULE"}, headers=auth("engineer")).json()


# ------------------------------------------------------------------ attribution


def test_user_actions_carry_the_role_and_one_correlation_id(client, red_run):
    rows = client.get(f"/api/audit?entity_id={red_run['id']}", headers=auth("analyst")).json()["items"]
    started = next(r for r in rows if r["event_type"] in ("run.started", "run.deduplicated"))
    assert started["actor"] == "engineer" and started["actor_role"] == "engineer"
    assert started["correlation_id"], "an HTTP action must carry its request id"
    same_action = client.get(f"/api/audit?correlation_id={started['correlation_id']}&limit=500",
                             headers=auth("analyst")).json()["items"]
    assert same_action and all(r["correlation_id"] == started["correlation_id"] for r in same_action)


def test_automation_is_labelled_system_never_a_person():
    assert audit.role_for("system:scanner") == "system"
    assert audit.role_for("engineer") == "engineer"
    assert audit.role_for("somebody-unknown") == "unknown"


# ------------------------------------------------------------------ hash chain


def test_the_live_chain_verifies(client, red_run):
    body = client.get("/api/audit/verify", headers=auth("analyst")).json()
    assert body["ok"] is True and body["checked"] > 0


def test_a_forged_row_breaks_verification(tmp_path):
    engine = create_engine(f"sqlite:///{(tmp_path / 'chain.db').as_posix()}")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        install_append_only_guard(conn)
    Session = sessionmaker(engine)
    with Session() as session:
        for i in range(3):
            audit.record(session, actor="system:scanner", event_type="scan.started", entity_type="scan",
                         entity_id=f"s{i}", payload={"i": i})
        session.commit()
        assert audit.verify_chain(session)["ok"] is True
        # UPDATE and DELETE are refused by the trigger; someone with INSERT can still
        # append a row that pretends to be legitimate. The chain catches it.
        session.execute(text(
            "INSERT INTO audit_events (ts, actor, actor_role, event_type, entity_type, entity_id, payload,"
            " prev_hash, row_hash) VALUES ('2026-09-23 00:00:00', 'mallory', 'admin', 'task.transitioned',"
            " 'review_task', 'x', '{}', 'bogus', 'bogus')"))
        session.commit()
        result = audit.verify_chain(session)
    assert result["ok"] is False and result["checked"] == 3
    engine.dispose()


# ------------------------------------------------------------------ evidence bundles


def test_run_bundle_is_self_hashed_and_its_export_is_audited(client, red_run):
    r = client.get(f"/api/evidence/runs/{red_run['id']}", headers=auth("analyst"))
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    bundle = r.json()
    assert bundle["schema"] == evidence.SCHEMA
    assert evidence.digest(bundle) == bundle["bundle_sha256"] == r.headers["x-bundle-sha256"]
    assert bundle["run"]["gate"] == "RED" and bundle["blocking_failures"] > 0
    assert bundle["run"]["prompt"]["sha256"] and bundle["run"]["model"]["id"] == "sim-large"
    assert bundle["audit_chain"]["verified"] is True
    exported = client.get(f"/api/audit?event_type=evidence.exported&entity_id={red_run['id']}",
                          headers=auth("analyst")).json()["items"]
    assert exported and exported[0]["payload"]["bundle_sha256"] == bundle["bundle_sha256"]
    assert exported[0]["actor"] == "analyst" and exported[0]["actor_role"] == "analyst"


def test_task_bundle_names_the_span_the_artifact_hash_and_the_rule(client):
    task = client.get("/api/review?kind=STALE_ASSET&state=open", headers=auth("engineer")).json()[0]
    bundle = client.get(f"/api/evidence/tasks/{task['id']}", headers=auth("engineer")).json()
    assert bundle["encoding"]["evidence_span"] and bundle["encoding"]["artifact"]["version_sha256"]
    assert bundle["rule_version_in_force"]["applies_from"] and bundle["rule_version_in_force"]["citation"]
    md = client.get(f"/api/evidence/tasks/{task['id']}?format=md", headers=auth("engineer"))
    assert md.status_code == 200 and md.text.startswith("# Evidence bundle") and "Audit trail" in md.text


def test_rule_bundle_lists_the_blast_radius(client):
    bundle = client.get("/api/evidence/rules/soa-48h-wait?as_of=2026-10-01", headers=auth("analyst")).json()
    assert bundle["subject"]["as_of"] == "2026-10-01" and bundle["stale_encodings"]
    assert all(s["encoding"]["artifact"]["version_sha256"] for s in bundle["stale_encodings"])


def test_evidence_requires_login(client, red_run):
    assert client.get(f"/api/evidence/runs/{red_run['id']}").status_code == 401


# ------------------------------------------------------------------ review lanes


def test_flag_severity_and_judged_results_are_advisory_aggregates(client):
    run = client.post("/api/runs", json={"prompt_version": 2, "model_id": "sim-small", "rule_date": "2026-10-01",
                                         "trigger": "MODEL"}, headers=auth("engineer")).json()
    tasks = [t for t in client.get("/api/review?kind=FLAGGED_RESULT", headers=auth("engineer")).json()
             if t["run_id"] == run["id"]]
    advisory = [t for t in tasks if t["lane"] == "advisory"]
    actionable = [t for t in tasks if t["lane"] == "actionable"]
    assert [t["contract_code"] for t in advisory] == ["J-COACH-01"], "20 judge flags become ONE advisory item"
    assert actionable and all(t["payload"]["severity"] == "BLOCK" for t in actionable)
    only_advisory = client.get("/api/review?lane=advisory", headers=auth("engineer")).json()
    assert only_advisory and all(t["lane"] == "advisory" for t in only_advisory)


# ------------------------------------------------------------------ status + health


def test_status_rail_is_live_state(client, red_run):
    body = client.get("/api/status", headers=auth("engineer")).json()
    assert body["counts"]["rules"] == 13 and body["counts"]["contracts"] == 8 and body["counts"]["golden_cases"] > 0
    assert body["last_run"]["gate"] in ("RED", "GREEN", "AMBER", "GREY")
    assert body["user"] == {"name": "engineer", "role": "engineer"}
    assert set(body["review"]) == {"actionable_open", "advisory_open"}
    assert client.get("/api/status").status_code == 401


def test_deep_health_lists_components_and_optional_ollama_never_fails_it(client):
    body = client.get("/api/health/deep").json()
    names = {c["name"]: c for c in body["components"]}
    assert {"api", "database", "rules", "artifacts", "runner", "ollama"} <= set(names)
    assert names["ollama"]["required"] is False
    assert body["status"] == "healthy" and body["ready"] is True


def test_eval_summary_is_labelled_as_fixtures(client):
    summary = client.get("/api/evals/matchers", headers=auth("analyst")).json()["summary"]
    assert summary["suite"] == "Golden Matcher Suite"
    assert "Not an estimate of production accuracy" in summary["disclaimer"]


# ------------------------------------------------------------------ regulatory semantics


def test_rule_versions_carry_applicability_and_ranked_sources(client):
    rule = client.get("/api/rules/call-recording-retention", headers=auth("analyst")).json()
    v2 = next(v for v in rule["versions"] if v["version"] == 2)
    assert v2["effective_from"] == "2026-10-01" and v2["regulation_effective"] == "2026-06-01"
    order = ["primary", "preamble", "secondary"]
    authorities = [src["authority"] for src in v2["sources"]]
    assert authorities[0] == "primary" and authorities == sorted(authorities, key=order.index)


def test_cy2027_superlatives_are_not_a_blanket_permission():
    labels = {"superlatives": [{"text": "the best plan", "substantiated": False},
                               {"text": "the top rated plan in Florida", "substantiated": False, "misleading": True}]}
    assert wf.truth_superlative_flags(labels, {"superlatives_substantiation_required": False}) == [
        "the top rated plan in Florida"]
    assert len(wf.truth_superlative_flags(labels, {"superlatives_substantiation_required": True})) == 2


# ------------------------------------------------------------------ the override loop closes


def test_an_approved_override_is_honoured_by_the_next_run(client):
    body = {"prompt_version": 1, "model_id": "sim-large", "rule_date": "2026-10-01", "trigger": "RULE"}
    first = client.post("/api/runs", json=body, headers=auth("engineer")).json()
    # Findings dedupe across reruns of the same prompt/model/rule date, so the open
    # task for a call may belong to an earlier run of this configuration.
    same_config = {r["id"] for r in client.get("/api/runs", headers=auth("engineer")).json()
                   if r["prompt_version"] == 1 and r["model_id"] == "sim-large" and r["rule_date"] == "2026-10-01"}
    task = next(t for t in client.get("/api/review?kind=FLAGGED_RESULT&state=open", headers=auth("engineer")).json()
                if t["contract_code"] == "C-SOA-01" and t["run_id"] in same_config
                and t["payload"].get("lane") == "actionable")
    r = client.post(f"/api/review/{task['id']}/transition", headers=auth("engineer"),
                    json={"to": "overridden", "reason_code": "TRANSCRIPT_AMBIGUOUS", "note": "walk-in"})
    case_id = r.json()["payload"]["test_case_id"]
    assert client.post(f"/api/test-cases/{case_id}/approve", headers=auth("admin")).status_code == 200

    second = client.post("/api/runs", json=body, headers=auth("engineer")).json()
    assert second["id"] != first["id"], "approval changes the run key; the rerun must not dedupe"
    assert second["stats"]["test_cases"]["applied"] >= 1
    assert second["stats"]["review_tasks_opened"] == 0, "every other finding is already open; nothing duplicates"
    bundle = client.get(f"/api/evidence/runs/{second['id']}", headers=auth("engineer")).json()
    decided = [f for f in bundle["findings"] if f["transcript"] == task["transcript_code"]
               and f["contract"]["code"] == "C-SOA-01"]
    assert decided and decided[0]["evidence"]["override"]["test_case_id"] == case_id
    assert second["gate"] == "RED", "the other blocking failures still gate the run"


def test_held_out_runs_open_nothing_for_reviewers():
    from datetime import date

    from backstop.config import get_settings
    from backstop.db import SessionLocal
    from backstop.harness import corpus as cp
    from backstop.harness.runner import execute_run, seed_corpus

    with SessionLocal() as session:
        seed_corpus(session, seed=cp.HOLDOUT_SEED, prefix=cp.HOLDOUT_PREFIX)
        session.commit()
        run = execute_run(session, get_settings(), workflow_code="qa-handoff", prompt_version=1, model_id="sim-large",
                          adapter_kind="simulated", rule_date=date(2026, 10, 1), actor="tests", corpus="holdout").run
        assert run.gate == "RED" and run.stats["review_tasks_opened"] == 0 and run.stats["advisory_items_opened"] == 0
        assert "held-out" in run.stats["review_suppressed"]


# ------------------------------------------------------------------ blind spots found 2026-09-23


def test_free_text_request_ids_never_reach_the_audit_log(client):
    r = client.get("/api/health/deep", headers={"X-Request-ID": "x' OR 1=1; see other action"})
    assert r.headers["X-Request-ID"] != "x' OR 1=1; see other action" and len(r.headers["X-Request-ID"]) == 16


def test_review_queue_query_count_does_not_grow_with_tasks(client):
    from sqlalchemy import event

    from backstop.db import engine

    count = {"n": 0}

    def _count(*_args, **_kwargs):
        count["n"] += 1

    event.listen(engine, "before_cursor_execute", _count)
    try:
        tasks = client.get("/api/review", headers=auth("engineer")).json()
    finally:
        event.remove(engine, "before_cursor_execute", _count)
    assert len(tasks) > 20 and count["n"] <= 15, f"{count['n']} queries for {len(tasks)} tasks"
