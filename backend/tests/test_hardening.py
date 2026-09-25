"""Regression tests for the 2026-09-23 audit: each test pins one gap that was found and fixed."""

from __future__ import annotations

import base64
import csv
import io
import shutil
from datetime import date
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from backstop import schemas as s
from backstop.api import deps
from backstop.config import Settings
from backstop.core import rules_loader
from backstop.core.rules_loader import RuleCorpusError, load_rules
from backstop.db import Base
from backstop.harness import runner
from backstop.harness.ingest import IngestError, ingest_csv
from backstop.main import app
from backstop.models import AuditEvent, Rule, Run


def auth(user: str, password: str | None = None) -> dict[str, str]:
    token = base64.b64encode(f"{user}:{password or user}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


# ------------------------------------------------------------------ rule corpus


@pytest.fixture
def scratch_rules(tmp_path, settings):
    """A private copy of the rule corpus loaded into a private database."""
    rules_dir = tmp_path / "rules"
    shutil.copytree(settings.rules_dir, rules_dir)
    engine = create_engine(f"sqlite:///{(tmp_path / 'rules.db').as_posix()}")
    Base.metadata.create_all(engine)
    Session = sessionmaker(engine, expire_on_commit=False)
    with Session() as session:
        load_rules(session, rules_dir, actor="tests")
    yield rules_dir, Session
    engine.dispose()


def _append_version(path: Path, *, close_previous_on: str, new_from: str) -> None:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    last = doc["versions"][-1]
    last["effective_to"] = date.fromisoformat(close_previous_on)
    doc["versions"].append({
        "version": last["version"] + 1, "status": "in_force", "effective_from": date.fromisoformat(new_from),
        "change_classification": "CLARIFIES", "clause_text": "Hypothetical CY2028 clarification.",
    })
    path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")


def test_appending_a_version_in_yaml_closes_the_open_window(scratch_rules):
    rules_dir, Session = scratch_rules
    _append_version(rules_dir / "soa-48h-wait.yaml", close_previous_on="2027-09-30", new_from="2027-10-01")
    with Session() as session:
        report = load_rules(session, rules_dir, actor="tests")
        assert report.versions_created == 1
        rule = session.scalar(select(Rule).where(Rule.code == "soa-48h-wait"))
        by_number = {v.version: v for v in rule.versions}
        assert by_number[2].effective_to == date(2027, 9, 30)
        assert by_number[3].effective_to is None
        closed = session.scalars(select(AuditEvent).where(AuditEvent.event_type == "rule.version_closed")).all()
        assert len(closed) == 1 and closed[0].payload["version"] == 2
        # Reloading the same corpus is a no-op, not an "edited in place" error.
        assert load_rules(session, rules_dir, actor="tests").versions_created == 0


def test_a_closed_window_cannot_move_and_text_edits_are_still_refused(scratch_rules):
    rules_dir, Session = scratch_rules
    path = rules_dir / "soa-48h-wait.yaml"
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    doc["versions"][0]["effective_to"] = date(2026, 9, 29)  # v1 was closed on 2026-09-30
    path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")
    with Session() as session, pytest.raises(RuleCorpusError, match="closed window is final"):
        load_rules(session, rules_dir, actor="tests")

    doc["versions"][0]["effective_to"] = date(2026, 9, 30)
    doc["versions"][0]["clause_text"] = "rewritten history"
    path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")
    with Session() as session, pytest.raises(RuleCorpusError, match="edited in place"):
        load_rules(session, rules_dir, actor="tests")


def test_legacy_fingerprints_still_load(scratch_rules):
    """Databases seeded before effective_to left the fingerprint must keep loading."""
    rules_dir, Session = scratch_rules
    with Session() as session:
        for path in sorted(rules_dir.glob("*.yaml")):
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            rule = session.scalar(select(Rule).where(Rule.code == doc["code"]))
            stored = {v.version: v for v in rule.versions}
            for v in doc["versions"]:
                # Exactly what the pre-2026-09-23 loader stored.
                row = stored[v["version"]]
                row.params = {**row.params, "_fingerprint": rules_loader._fingerprint(v, legacy=True)}
        session.commit()
    with Session() as session:
        assert load_rules(session, rules_dir, actor="tests").versions_created == 0
        upgraded = session.scalar(select(Rule).where(Rule.code == "soa-48h-wait")).versions[0]
        assert upgraded.params["_fingerprint"] != "", "legacy fingerprints are upgraded in place"


def test_version_create_schema_matches_the_loader_vocabulary():
    status = s.RuleVersionCreate.model_fields["status"].annotation.__args__
    classification = s.RuleVersionCreate.model_fields["change_classification"].annotation.__args__
    assert set(status) == rules_loader.VALID_STATUS
    assert set(classification) == rules_loader.VALID_CLASSIFICATIONS


def test_api_rejects_unknown_classification_and_proposed_is_never_in_force(client):
    bad = client.post("/api/rules/superlatives/versions", headers=auth("engineer"), json={
        "clause_text": "x", "effective_from": "2027-01-01", "change_classification": "BOGUS"})
    assert bad.status_code == 422
    ok = client.post("/api/rules/superlatives/versions", headers=auth("engineer"), json={
        "clause_text": "Proposed CY2028 text.", "effective_from": "2027-01-01", "change_classification": "MODIFIES"})
    assert ok.status_code == 201 and ok.json()["status"] == "proposed"
    impact = client.get("/api/rules/superlatives/impact?as_of=2027-02-01", headers=auth("analyst")).json()
    assert impact["in_force_version"] != ok.json()["version"], "a proposed version must not be in force"


# ------------------------------------------------------------------ runs


def test_failed_run_keeps_its_error_and_can_be_retried(session, settings, monkeypatch):
    def broken(*args, **kwargs):
        raise ValueError("no configured provider (test)")

    monkeypatch.setattr(runner.ad, "build_adapter", broken)
    first = runner.execute_run(session, settings, workflow_code="qa-handoff", prompt_version=2,
                               model_id="sim-large", adapter_kind="simulated", rule_date=date(2031, 1, 1),
                               limit=2, actor="tests")
    assert first.run.status == "FAILED"
    session.expire_all()
    stored = session.get(Run, first.run.id)
    assert "no configured provider" in stored.stats.get("error", ""), "the error must be persisted, not just returned"

    monkeypatch.undo()
    retry = runner.execute_run(session, settings, workflow_code="qa-handoff", prompt_version=2,
                               model_id="sim-large", adapter_kind="simulated", rule_date=date(2031, 1, 1),
                               limit=2, actor="tests")
    assert not retry.deduplicated and retry.run.id != first.run.id and retry.run.status == "COMPLETE"


def test_long_run_keys_fit_the_column():
    key = "qa-handoff:" + "x" * 300
    bounded = runner.bounded_run_key(key)
    assert len(bounded) <= runner.RUN_KEY_MAX
    assert bounded != runner.bounded_run_key(key + "y"), "distinct keys must stay distinct"
    assert runner.bounded_run_key("short") == "short"


@pytest.mark.parametrize("body", [
    {"limit": -1}, {"limit": 0}, {"judge_n": 500}, {"adapter": "bogus"}, {"trigger": "X" * 40}, {"corpus": "nope"},
])
def test_run_request_is_bounded(client, body):
    payload = {"prompt_version": 2, "model_id": "sim-large", "rule_date": "2026-10-01", **body}
    assert client.post("/api/runs", json=payload, headers=auth("engineer")).status_code == 422


# ------------------------------------------------------------------ endpoints


def test_live_source_check_does_not_turn_on_live_crawling(client, settings, monkeypatch):
    from backstop.scanner import sources as sources_mod

    monkeypatch.setattr(sources_mod, "check_sources", lambda *a, **k: {"checked": 0})
    before = settings.crawler_live
    assert client.post("/api/sources/check?live=true", headers=auth("engineer")).status_code == 200
    assert settings.crawler_live == before


@pytest.mark.parametrize("path", ["/api/audit?limit=-1", "/api/audit?offset=-5", "/api/transcripts?limit=99999999999999999999"])
def test_list_limits_are_bounded(client, path):
    assert client.get(path, headers=auth("analyst")).status_code == 422


def test_unknown_reason_code_is_rejected_and_audited(client):
    task = client.get("/api/review?kind=PROPOSED_EDGE&state=open", headers=auth("analyst")).json()[0]
    r = client.post(f"/api/review/{task['id']}/transition", headers=auth("analyst"),
                    json={"to": "verified", "reason_code": "made_up"})
    assert r.status_code == 422
    events = client.get(f"/api/audit?entity_id={task['id']}&event_type=task.transition_rejected",
                        headers=auth("analyst")).json()["items"]
    assert any("unknown reason_code" in e["payload"]["reason"] for e in events)


def test_export_validates_format_before_auditing(client):
    run = client.get("/api/runs", headers=auth("analyst")).json()[0]
    before = client.get("/api/audit?event_type=export.generated", headers=auth("analyst")).json()["total"]
    assert client.get(f"/api/runs/{run['id']}/export?format=bogus", headers=auth("analyst")).status_code == 422
    after = client.get("/api/audit?event_type=export.generated", headers=auth("analyst")).json()["total"]
    assert after == before


def test_csv_export_neutralises_formulas():
    from backstop.api.ops import _csv_safe

    assert _csv_safe("=HYPERLINK(\"x\")") == "'=HYPERLINK(\"x\")"
    assert _csv_safe("-1+1") == "'-1+1"
    assert _csv_safe("T001") == "T001" and _csv_safe(3) == 3


def test_deep_health_reports_default_credentials(client):
    body = client.get("/api/health/deep").json()
    assert body["database"] == "ok" and body["default_credentials"] is True


# ------------------------------------------------------------------ auth


def test_failed_logins_are_throttled_in_the_audit_log(client):
    deps._deny_seen.clear()
    long_name = "z" * 500
    for _ in range(5):
        assert client.get("/api/rules", headers=auth(long_name, "wrong")).status_code == 401
    rows = client.get("/api/audit?event_type=auth.denied&limit=500", headers=auth("analyst")).json()["items"]
    mine = [r for r in rows if r["actor"].startswith("zzz")]
    assert len(mine) == 1 and len(mine[0]["actor"]) <= 64


@pytest.mark.parametrize("users,expected", [
    ("a:pa:ss:analyst", {"a": ("pa:ss", "analyst")}),
    (" a:b:admin , ", {"a": ("b", "admin")}),
])
def test_user_table_parsing(users, expected):
    assert Settings(users=users).user_table() == expected


@pytest.mark.parametrize("users", ["a:b", "a:b:superuser", ":b:admin"])
def test_malformed_user_table_fails_fast(users):
    with pytest.raises(ValueError):
        Settings(users=users).user_table()


# ------------------------------------------------------------------ ingest


def _csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=["call_id", "product_line", "duration_seconds", "transcript"])
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()


def test_ingest_dedupes_within_a_batch_and_accepts_fractional_durations(session):
    raw = _csv([
        {"call_id": "dup-1", "product_line": "MA", "duration_seconds": "12.5", "transcript": "AGENT: hi"},
        {"call_id": "dup-1", "product_line": "MA", "duration_seconds": "12", "transcript": "AGENT: hi again"},
    ])
    report = ingest_csv(session, raw, actor="tests")
    assert report["created"] == 1 and report["skipped_existing"] == 1


@pytest.mark.parametrize("row,message", [
    ({"call_id": "", "transcript": "x"}, "empty"),
    ({"call_id": "=HYPERLINK(1)", "transcript": "x"}, "must be"),
    ({"call_id": "x" * 40, "transcript": "x"}, "must be"),
    ({"call_id": "ok-2", "duration_seconds": "ten", "transcript": "x"}, "not a number"),
    ({"call_id": "ok-3", "transcript": ""}, "empty"),
])
def test_ingest_rejects_bad_rows_with_a_line_number(session, row, message):
    with pytest.raises(IngestError, match=message) as exc:
        ingest_csv(session, _csv([row]), actor="tests")
    assert "line 2" in str(exc.value)


# ------------------------------------------------------------------ SPA-facing details


def test_spa_401_has_no_basic_challenge(client):
    spa = {"X-Requested-With": "XMLHttpRequest"}
    r = client.get("/api/rules", headers={**auth("analyst", "wrong"), **spa})
    assert r.status_code == 401 and "www-authenticate" not in r.headers
    assert "www-authenticate" not in client.get("/api/rules", headers=spa).headers
    assert client.get("/api/rules").headers["www-authenticate"] == "Basic"  # curl/CLI still get the challenge


def test_allowed_transitions_respect_the_role(client):
    tasks = client.get("/api/review?kind=STALE_ASSET", headers=auth("analyst")).json()
    confirmed = [t for t in tasks if t["state"] == "verified"]
    for task in confirmed:
        assert "republished" not in task["allowed_transitions"], "analysts may not republish"


def test_source_history_timestamps_carry_utc(client):
    client.post("/api/sources/check", headers=auth("engineer"))
    rows = client.get("/api/rules/tpmo-disclaimer-timing/sources", headers=auth("analyst")).json()
    assert rows and all(r["checked_at"].endswith(("Z", "+00:00")) for r in rows)


# ------------------------------------------------------------------ fixed artifacts stop being stale


def test_a_fixed_artifact_drops_out_of_the_blast_radius_and_a_revert_restores_it(session, settings, monkeypatch):
    from backstop.models import Asset, RuleAssetEdge
    from backstop.scanner import service

    synthetic = {item["code"] for item in yaml.safe_load(
        (settings.fixtures_dir / "sources.yaml").read_text(encoding="utf-8"))["synthetic"]}
    edge = session.scalar(select(RuleAssetEdge).join(Asset).where(
        RuleAssetEdge.status == "confirmed", Asset.code.in_(synthetic)))
    asset_code, span = edge.asset.code, edge.evidence_span
    original = service._synthetic_text

    def fixed_text(fixtures_dir, code):
        text = original(fixtures_dir, code)
        return text.replace(span, "[rewritten to the current rule]") if code == asset_code else text

    monkeypatch.setattr(service, "_synthetic_text", fixed_text)
    outcome = service.run_scan(session, settings, idempotency_key="tests:fixed", live=False,
                               as_of=date(2026, 10, 1), actor="tests")
    assert outcome.scan.stats["edges_superseded"] >= 1
    session.refresh(edge)
    assert edge.status == "superseded"

    monkeypatch.undo()
    outcome = service.run_scan(session, settings, idempotency_key="tests:reverted", live=False,
                               as_of=date(2026, 10, 1), actor="tests")
    session.refresh(edge)
    assert edge.status == "confirmed", "the span is back, so the evidence is live again"
    # Anything superseded by the revert is evidence that only the edited text carried.
    superseded = session.scalars(select(RuleAssetEdge).where(
        RuleAssetEdge.asset_id == edge.asset_id, RuleAssetEdge.status == "superseded")).all()
    assert len(superseded) == outcome.scan.stats["edges_superseded"]
    assert all("[rewritten to the current rule]" in e.evidence_span or e.evidence_span not in
               service._synthetic_text(settings.fixtures_dir, asset_code) for e in superseded)


# ------------------------------------------------------------------ audit log is append-only in the DB


def test_audit_rows_cannot_be_updated_or_deleted(session):
    from sqlalchemy import text as sql
    from sqlalchemy.exc import DatabaseError

    row_id = session.scalar(select(AuditEvent.id).limit(1))
    for statement in ("UPDATE audit_events SET actor = 'mallory' WHERE id = :id",
                      "DELETE FROM audit_events WHERE id = :id"):
        with pytest.raises(DatabaseError, match="append-only"):
            session.execute(sql(statement), {"id": row_id})
        session.rollback()


def test_unlabelled_calls_gate_amber_not_red():
    from types import SimpleNamespace

    from backstop.harness.runner import gate_for

    block = SimpleNamespace(severity="BLOCK")
    not_evaluated = SimpleNamespace(outcome="ERROR", contract_version_id="cv", evidence={"not_evaluated": True})
    real_failure = SimpleNamespace(outcome="FAIL", contract_version_id="cv", evidence={})
    assert gate_for([not_evaluated], {"cv": block}) == "AMBER"
    assert gate_for([not_evaluated, real_failure], {"cv": block}) == "RED"
