"""Evals, canary, cost, rule-source watcher, exports, ingest, prompt diff, health, logging."""

from __future__ import annotations

import base64
import json

import pytest
from fastapi.testclient import TestClient

from backstop.harness import cost
from backstop.harness.adapters import SimulatedAdapter, load_profiles
from backstop.harness.canary import load_canary, run_canary
from backstop.harness.ingest import IngestError, ingest_csv, redact
from backstop.main import app
from backstop.scanner import evaluate as ev
from backstop.scanner.sources import check_sources


def auth(user: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{user}".encode()).decode()}


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


# ------------------------------------------------------------------ matcher eval


def test_matcher_eval_has_no_false_positives_and_documents_limitations(settings):
    report = ev.evaluate(settings.fixtures_dir / "matcher_golden.yaml")
    assert report.fp == 0, [c.id for c in report.cases if c.false_positive]
    assert report.recall >= 0.9
    # 2 documented near-miss FPs (soa-09, lf-03) + 14 real EIP quotes (r1-q*) that no encoded
    # rule covers yet; the latter expect no edge and carry a `gap` note (was 2 before 2026-09-25).
    assert report.known_limitations == 16
    assert sum(1 for c in report.cases if c.gap) == 14
    md = ev.render_markdown(report, settings.fixtures_dir / "matcher_golden.yaml")
    assert "precision" in md and "known limitation" in md and "real quotes no matcher covers" in md


def test_matcher_eval_endpoint(client):
    body = client.get("/api/evals/matchers", headers=auth("analyst")).json()
    assert body["summary"]["fp"] == 0
    assert "soa-48h-wait" in body["per_rule"]


# ------------------------------------------------------------------ judge canary + cost


def test_canary_separates_good_from_generic_notes(settings):
    profiles = load_profiles(settings.fixtures_dir)
    adapter = SimulatedAdapter("sim-large", profiles["sim-large"])
    result = run_canary(adapter, "rubric", load_canary(settings.fixtures_dir), 5)
    by_id = {n["id"]: n for n in result["notes"]}
    assert by_id["canary-good-1"]["mean"] > by_id["canary-generic-1"]["mean"]
    assert result["n_per_note"] == 5
    assert all(len(n["scores"]) == 5 for n in result["notes"] if "scores" in n)


def test_cost_is_zero_for_simulated_and_projected_for_live():
    sim = cost.estimate("sim-large", "simulated", 60, 0, 0)
    assert sim["usd"] == 0.0 and "simulated" in sim["basis"]
    live = cost.estimate("claude-sonnet-5", "anthropic", 60, 0, 0, judged_calls=330)
    assert live["usd"] > 0 and "estimated" in live["basis"]
    assert live["projection"]["usd_per_aep"] > live["projection"]["usd_per_day"] > 0
    measured = cost.estimate("claude-sonnet-5", "anthropic", 60, 90_000, 27_000)
    assert "measured" in measured["basis"]
    assert measured["usd"] == pytest.approx(90_000 / 1e6 * 3.0 + 27_000 / 1e6 * 15.0)


def test_run_stats_include_canary_and_cost(client):
    run = client.post("/api/runs", json={"prompt_version": 2, "model_id": "sim-small", "rule_date": "2026-10-01",
                                         "trigger": "MODEL"}, headers=auth("engineer")).json()
    assert run["stats"]["cost"]["usd"] == 0.0
    canary = run["stats"]["judge_stability"]
    assert canary is not None and canary["n_per_note"] == 5 and "stable" in canary


# ------------------------------------------------------------------ rule-source watcher


def test_source_watcher_snapshot_then_change_opens_a_task(session, settings, tmp_path, monkeypatch):
    # First pass on the frozen snapshots: everything first-seen, no tasks.
    first = check_sources(session, settings, live=False, actor="tests")
    assert first["errors"] == 0 and first["changed"] == 0
    # Second pass: unchanged.
    second = check_sources(session, settings, live=False, actor="tests")
    assert second["unchanged"] == second["checked"]
    # Simulate the regulator editing one page: point the watcher at a modified copy.
    from backstop.scanner import sources as src

    original_snapshot = src._snapshot
    real = original_snapshot(settings.fixtures_dir, "https://www.law.cornell.edu/cfr/text/42/422.2267")
    edited = tmp_path / "sources"
    edited.mkdir()
    for p in (settings.fixtures_dir / "sources").glob("*.html"):
        (edited / p.name).write_text(p.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
    # Edit inside the body (lxml drops anything appended after </html>).
    page = (edited / real.name).read_text(encoding="utf-8")
    assert "</body>" in page
    (edited / real.name).write_text(page.replace("</body>", "<p>amended clause text</p></body>", 1), encoding="utf-8")
    monkeypatch.setattr(src, "_snapshot", lambda fixtures_dir, url: edited / original_snapshot(fixtures_dir, url).name)
    third = check_sources(session, settings, live=False, actor="tests")
    assert third["changed"] >= 1
    from sqlalchemy import select

    from backstop.models import ReviewTask

    tasks = session.scalars(select(ReviewTask).where(ReviewTask.kind == "RULE_SOURCE_CHANGED")).all()
    assert tasks and tasks[0].payload["source_url"].endswith("422.2267")
    # Same change again → no duplicate task.
    fourth = check_sources(session, settings, live=False, actor="tests")
    assert fourth["unchanged"] >= 1
    assert len(session.scalars(select(ReviewTask).where(ReviewTask.kind == "RULE_SOURCE_CHANGED")).all()) == len(tasks)


# ------------------------------------------------------------------ exports + diff


def test_exports_in_three_shapes(client):
    run = client.get("/api/runs", headers=auth("analyst")).json()[0]
    bt = client.get(f"/api/runs/{run['id']}/export?format=braintrust", headers=auth("analyst")).json()
    assert bt["format"] == "braintrust" and bt["records"] and "scores" in bt["records"][0]
    ls = client.get(f"/api/runs/{run['id']}/export?format=langsmith", headers=auth("analyst")).json()
    assert ls["examples"] and ls["examples"][0]["feedback"]
    csv_resp = client.get(f"/api/runs/{run['id']}/export?format=csv", headers=auth("analyst"))
    assert csv_resp.status_code == 200 and csv_resp.text.startswith("run_id,")
    assert client.get(f"/api/runs/{run['id']}/export?format=xlsx", headers=auth("analyst")).status_code == 422


def test_prompt_diff_names_rule_dependency_changes(client):
    wf = client.get("/api/workflows/qa-handoff", headers=auth("analyst")).json()
    v1 = next(p for p in wf["prompt_versions"] if p["version"] == 1)["id"]
    v2 = next(p for p in wf["prompt_versions"] if p["version"] == 2)["id"]
    diff = client.get(f"/api/prompts/diff?a={v1}&b={v2}", headers=auth("analyst")).json()
    assert any(line.startswith("-") and "48 HOURS" in line for line in diff["unified_diff"])
    removed = {(d["rule"], d["version"]) for d in diff["rule_dependencies"]["removed"]}
    added = {(d["rule"], d["version"]) for d in diff["rule_dependencies"]["added"]}
    assert ("soa-48h-wait", 1) in removed and ("soa-48h-wait", 2) in added


# ------------------------------------------------------------------ ingest


def test_redaction_masks_pii_patterns():
    text, counts = redact("My number is 1XX4-XX2-XX18, SSN 123-45-6789, born 04/26/1958.")
    assert "[REDACTED-MEDICARE_NUMBER]" in text and "[REDACTED-SSN]" in text and "[REDACTED-DOB]" in text
    # Since 2026-09-25 redact() reports every PII kind it knows (phone, email, address added).
    assert counts == {"medicare_number": 1, "ssn": 1, "dob": 1, "phone": 0, "email": 0, "address": 0}


def test_ingest_sample_export_is_redacted_unlabeled_and_idempotent(session, settings):
    raw = (settings.fixtures_dir / "attention_export_sample.csv").read_text(encoding="utf-8")
    first = ingest_csv(session, raw, fmt="attention-snowflake", actor="tests")
    assert first["created"] == 2 and first["redacted"]["medicare_number"] == 1
    again = ingest_csv(session, raw, fmt="attention-snowflake", actor="tests")
    assert again["created"] == 0 and again["skipped_existing"] == 2
    with pytest.raises(IngestError):
        ingest_csv(session, "foo,bar\n1,2\n", fmt="attention-snowflake")


@pytest.mark.parametrize("name, data", [
    # Excel "CSV UTF-8": byte-order mark and CRLF line endings.
    ("bom-crlf", "\ufeffcall_id,transcript\r\nXL-BOM,\"Agent: hello,\r\nCustomer: hi\"\r\n".encode("utf-8")),
    # European-locale Excel: semicolon-delimited.
    ("semicolon", b"call_id;transcript\nXL-SEMI;Agent: hello there\n"),
    # Plain Excel "CSV" on Windows: cp1252, not UTF-8.
    ("cp1252", "Call_ID,Transcript\nXL-1252,Agent: caf\u00e9 \u2019quoted\u2019\n".encode("cp1252")),
])
def test_ingest_accepts_the_csv_variants_excel_writes(client, name, data):
    r = client.post("/api/ingest/transcripts", files={"file": (f"{name}.csv", data, "text/csv")},
                    headers=auth("engineer"))
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 1
    code = {"bom-crlf": "A-XL-BOM", "semicolon": "A-XL-SEMI", "cp1252": "A-XL-1252"}[name]
    text = client.get(f"/api/transcripts/{code}", headers=auth("engineer")).json()["text"]
    assert "\ufffd" not in text
    if name == "cp1252":
        assert "caf\u00e9 \u2019quoted\u2019" in text


def test_ingested_transcripts_report_no_ground_truth_honestly(client):
    run = client.post("/api/runs", json={"prompt_version": 2, "model_id": "sim-large", "rule_date": "2026-10-01",
                                         "corpus": "ingested"}, headers=auth("engineer")).json()
    rows = client.get(f"/api/runs/{run['id']}/results?transcript=A-SAMPLE-0001", headers=auth("analyst")).json()
    assert rows, "ingested transcript should be part of the corpus"
    assert all(r["outcome"] == "ERROR" for r in rows)
    assert any("simulated adapter cannot process ingested" in json.dumps(r["evidence"]) for r in rows)


# ------------------------------------------------------------------ health + logging


def test_deep_health_and_request_id(client):
    r = client.get("/api/health/deep", headers={"X-Request-ID": "trace-123"})
    assert r.status_code == 200 and r.json()["ready"] is True
    assert r.headers["X-Request-ID"] == "trace-123"
    r2 = client.get("/api/health")
    assert len(r2.headers["X-Request-ID"]) == 16
