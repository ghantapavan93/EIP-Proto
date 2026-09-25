"""Answers to the questions a senior reviewer asks when trying to break the system.

Each test pins one fix from the pre-review audit: nothing incomplete reads as
complete, nothing unknown reads as unchanged, and nothing a person pasted or typed
is kept where it cannot be removed.
"""

from __future__ import annotations

import base64
import threading
from datetime import date
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backstop.core import audit, evidence
from backstop.core.rules_loader import RuleCorpusError, validate_rule_doc
from backstop.harness import contracts as ct
from backstop.harness.runner import _override_still_applies
from backstop.main import app
from backstop.models import Base
from backstop.scanner import crawler, matchers


def auth(user: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{user}".encode()).decode()}


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------- evidence bundles


def test_a_bundle_says_when_its_audit_trail_is_cut_and_ignores_its_own_exports(client, monkeypatch):
    run = client.post("/api/runs", json={"prompt_version": 1, "model_id": "sim-large", "rule_date": "2026-10-01",
                                         "trigger": "RULE"}, headers=auth("engineer")).json()
    for _ in range(3):  # earlier exports must not crowd out the decisions
        client.get(f"/api/evidence/runs/{run['id']}", headers=auth("analyst"))
    bundle = client.get(f"/api/evidence/runs/{run['id']}", headers=auth("analyst")).json()
    assert bundle["audit_events_truncated"] is (bundle["audit_events_total"] > len(bundle["audit_events"]))
    assert not any(e["event_type"] == "evidence.exported" for e in bundle["audit_events"])

    # A run records run.started and run.completed (the tasks it opens are counted in the
    # latter), so a cap of one row is the smallest cut that must be disclosed.
    assert bundle["audit_events_total"] >= 2
    monkeypatch.setattr(evidence, "_MAX_AUDIT_ROWS", 1)
    cut = client.get(f"/api/evidence/runs/{run['id']}", headers=auth("analyst")).json()
    assert cut["audit_events_truncated"] is True and len(cut["audit_events"]) == 1
    assert cut["audit_events_total"] == bundle["audit_events_total"]
    newest = max(e["id"] for e in bundle["audit_events"])
    assert cut["audit_events"][0]["id"] == newest, "the newest rows are the ones kept"
    md = client.get(f"/api/evidence/runs/{run['id']}?format=md", headers=auth("analyst")).text
    assert f"newest 1 of {cut['audit_events_total']} rows" in md


# ---------------------------------------------------------------- audit chain on SQLite


def test_concurrent_audit_writes_on_sqlite_keep_one_chain(tmp_path):
    engine = create_engine(f"sqlite:///{(tmp_path / 'race.db').as_posix()}",
                           connect_args={"check_same_thread": False, "timeout": 30})
    Base.metadata.create_all(engine)
    Session = sessionmaker(engine)

    def writer(n: int) -> None:
        for i in range(10):
            with Session() as session:
                audit.record(session, actor="system:scanner", event_type="scan.started", entity_type="scan",
                             entity_id=f"w{n}-{i}")
                session.commit()

    threads = [threading.Thread(target=writer, args=(n,)) for n in range(6)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    with Session() as session:
        result = audit.verify_chain(session)
    engine.dispose()
    assert result["ok"] is True and result["checked"] == 60


# ---------------------------------------------------------------- what people type


def test_a_sandbox_label_is_redacted_before_it_reaches_the_audit_log(client):
    r = client.post("/api/sandbox/artifact", json={"text": "Agents must wait 48 hours after the SOA.",
                                                   "label": "Call for SSN 123-45-6789", "as_of": "2026-10-01"},
                    headers=auth("engineer"))
    assert r.status_code == 200, r.text
    rows = client.get("/api/audit?event_type=sandbox.artifact_checked&limit=1", headers=auth("admin")).json()["items"]
    assert "123-45-6789" not in str(rows[0]["payload"])


def _ingest(client, csv: str):
    return client.post("/api/ingest/transcripts", files={"file": ("x.csv", csv.encode(), "text/csv")},
                       headers=auth("engineer"))


def test_ingest_refuses_an_unknown_product_line_instead_of_relabelling_it(client):
    r = _ingest(client, "call_id,product_line,transcript\nPL-1,MEDSUPP,AGENT: hello\n")
    assert r.status_code == 422 and "MA, PDP, MEDIGAP, LIFE" in r.json()["detail"]


def test_ingest_flags_an_assumed_product_line(client):
    r = _ingest(client, "call_id,transcript\nPL-2,AGENT: hello there\n")
    assert r.status_code == 200, r.text
    assert r.json()["product_line_assumed"] == 1


# ---------------------------------------------------------------- reads never write the past


def test_reading_a_past_date_opens_no_review_tasks(client):
    before = len(client.get("/api/review", headers=auth("engineer")).json())
    r = client.get("/api/rules/soa-48h-wait/impact?as_of=2024-01-01", headers=auth("engineer"))
    assert r.status_code == 200
    assert len(client.get("/api/review", headers=auth("engineer")).json()) == before


def _rule(*windows):
    versions = [SimpleNamespace(status="in_force", effective_from=f, effective_to=t) for f, t in windows]
    return SimpleNamespace(versions=versions)


def test_past_means_an_older_rule_version_not_an_earlier_date():
    """The flip date stays actionable after it passes; only an older version is history."""
    from backstop.core.impact import reads_past_rule_state

    soa = _rule((date(2023, 9, 30), date(2026, 9, 30)), (date(2026, 10, 1), None))
    assert reads_past_rule_state(soa, date(2024, 1, 1), today=date(2026, 10, 2))       # v1 is history then
    assert not reads_past_rule_state(soa, date(2026, 10, 1), today=date(2026, 10, 2))  # flip day, after it passed
    assert not reads_past_rule_state(soa, date(2026, 10, 1), today=date(2026, 9, 25))  # the future is not past
    assert not reads_past_rule_state(soa, date(2024, 1, 1), today=date(2026, 9, 25))   # same version as today
    assert reads_past_rule_state(_rule((date(2025, 4, 11), None)), date(2024, 1, 1), today=date(2026, 9, 25))


# ---------------------------------------------------------------- overrides and rule changes


def _case(rule_logic):
    return SimpleNamespace(expected={"outcome": "PASS", "evidence_at_override": {"rule_logic": rule_logic}})


def test_an_override_does_not_survive_a_change_in_the_rule_it_was_decided_under():
    decided = {"min_hours": 0}
    assert _override_still_applies(_case(decided), ct.Verdict("FAIL", {"rule_logic": {"min_hours": 0}}))
    assert not _override_still_applies(_case(decided), ct.Verdict("FAIL", {"rule_logic": {"min_hours": 48}}))
    # contracts that read no rule parameters carry the override across rule dates
    assert _override_still_applies(_case(None), ct.Verdict("FAIL", {}))


# ---------------------------------------------------------------- the rule corpus and its sources


def test_a_block_page_or_redirect_is_unknown_not_unchanged():
    url = "https://www.law.cornell.edu/cfr/text/42/422.2267"
    assert crawler.suspect_content(url, url, "x" * 600) is None
    assert crawler.suspect_content(url, "https://law.cornell.edu/cfr/text/42/422.2267/", "x" * 600) is None
    assert "redirected" in crawler.suspect_content(url, "https://www.law.cornell.edu/", "x" * 600)
    assert "characters" in crawler.suspect_content(url, url, "Checking your browser before accessing")


def test_negated_wording_is_proposed_for_a_human_not_auto_confirmed():
    dropped = matchers.run_all("Agents no longer must wait 48 hours after the Scope of Appointment is signed.")
    kept = matchers.run_all("Agents must wait 48 hours after the Scope of Appointment is signed before the meeting.")
    assert [(m.rule_code, m.status) for m in dropped] == [("soa-48h-wait", "proposed")]
    assert [(m.rule_code, m.status) for m in kept] == [("soa-48h-wait", "confirmed")]


def test_a_later_version_cannot_start_inside_an_open_window(tmp_path):
    def v(n, eff_from, eff_to=None):
        return {"version": n, "status": "in_force", "effective_from": eff_from, "effective_to": eff_to,
                "clause_text": "c", "change_classification": "INITIAL" if n == 1 else "MODIFIES"}

    doc = {"code": "x", "title": "t", "regulator": "CMS", "citation": "c",
           "versions": [v(1, date(2020, 1, 1)), v(2, date(2025, 1, 1), date(2026, 1, 1))]}
    with pytest.raises(RuleCorpusError, match="overlaps the previous version"):
        validate_rule_doc(doc, tmp_path / "x.yaml")
    doc["versions"][0]["effective_to"] = date(2024, 12, 31)
    validate_rule_doc(doc, tmp_path / "x.yaml")


# ---------------------------------------------------------------- what an executive reads


def test_percentages_round_the_same_way_as_the_console():
    from backstop.api.contracts_metrics import _pct

    assert [_pct(v) for v in (0.625, 0.0833, 0.05, 0.0, 1.0, None)] == ["63%", "8.3%", "5%", "0%", "100%", "n/a"]


def test_the_audit_actor_filter_lists_people_who_acted_not_demo_defaults(client):
    client.post("/api/sandbox/artifact", json={"text": "Agents must wait 48 hours after the SOA."},
                headers=auth("engineer"))
    client.get("/api/me", headers={"Authorization": "Basic " + base64.b64encode(b"nobody:x").decode()})
    actors = client.get("/api/audit/actors", headers=auth("analyst")).json()
    assert any(a["actor"] == "engineer" and a["role"] == "engineer" for a in actors)
    assert all(a["role"] not in ("system", "unauthenticated", "unknown") for a in actors)
    assert not any(a["actor"].startswith(("system:", "unknown-user:")) for a in actors)


def test_inventory_metadata_follows_the_file_and_names_no_hosting_provider(session, settings):
    from backstop.models import Asset
    from backstop.scanner.service import load_inventory

    page = session.query(Asset).filter(Asset.code == "mfaq-soa").one()
    page.source_system = "vercel"  # what an older database holds
    session.flush()
    load_inventory(session, settings.fixtures_dir)
    assert page.source_system == "public-web"
    assert not session.query(Asset).filter(Asset.source_system.in_(("vercel", "netlify"))).count()
    session.rollback()


def test_one_team_reads_as_one_owner_queue(client):
    owners = [o["role"] for o in client.get("/api/readiness", headers=auth("analyst")).json()["owners"]]
    assert "qa-compliance" not in owners and len(owners) == len(set(owners))
