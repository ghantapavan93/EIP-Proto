"""Regression tests for the 2026-09-25 depth audit (bugs 1-4) and the r1 matcher findings.

Bug 1: the API could enact rule versions (and brick the next restart).
Bug 2: contract YAML edits were silently ignored.
Bug 3: the "what-if" blast radius for a proposed version was never shown.
Bug 4: PII redaction was narrow and real transcripts could reach hosted free tiers.
"""

from __future__ import annotations

import base64
import shutil
from datetime import date
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from backstop import cli
from backstop.core import pii
from backstop.core.rules_loader import load_rules
from backstop.db import Base
from backstop.harness import adapters as ad
from backstop.harness import providers, runner
from backstop.harness.adapters import AdapterResult, RealDataGuard
from backstop.harness.ingest import KEEP_AGENT_NAMES_ENV, ingest_csv
from backstop.main import app
from backstop.models import AuditEvent, Contract, ReviewTask, Rule, RuleVersion, Transcript
from backstop.scanner import matchers

REPO = Path(__file__).resolve().parents[2]


def auth(user: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{user}".encode()).decode()}


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


@pytest.fixture
def private_db(tmp_path):
    engine = create_engine(f"sqlite:///{(tmp_path / 'private.db').as_posix()}")
    Base.metadata.create_all(engine)
    Session = sessionmaker(engine, expire_on_commit=False)
    yield Session
    engine.dispose()


# ====================================================================== bug 1


def _propose(client, code: str, **body):
    payload = {"clause_text": "Proposed clause.", "effective_from": "2027-01-01", "change_classification": "MODIFIES"}
    payload.update(body)
    return client.post(f"/api/rules/{code}/versions", headers=auth("engineer"), json=payload)


@pytest.mark.parametrize("status", ["in_force", "eliminated", "amended"])
def test_api_cannot_enact_a_rule_version(client, session, status):
    before = session.scalar(select(Rule).where(Rule.code == "superlatives"))
    windows = {v.version: v.effective_to for v in before.versions}
    r = _propose(client, "superlatives", status=status, clause_text=f"Enact attempt {status}.",
                 effective_from="2027-04-01")
    assert r.status_code == 422
    assert "proposed" in r.json()["detail"] and "ADR-001" in r.json()["detail"]
    session.expire_all()
    after = session.scalar(select(Rule).where(Rule.code == "superlatives"))
    assert {v.version: v.effective_to for v in after.versions} == windows, "no window may move"


def test_api_rejects_a_duplicate_proposal_with_409(client):
    first = _propose(client, "call-recording-retention", clause_text="Duplicate-check clause.",
                     effective_from="2027-02-02")
    assert first.status_code == 201 and first.json()["status"] == "proposed"
    again = _propose(client, "call-recording-retention", clause_text="  Duplicate-check clause.  ",
                     effective_from="2027-02-02")
    assert again.status_code == 409


def test_api_rejects_effective_from_beyond_2100(client):
    r = _propose(client, "call-recording-retention", clause_text="Far future.", effective_from="2101-01-01")
    assert r.status_code == 422 and "2100" in r.json()["detail"]


def test_an_api_proposal_never_breaks_reload_or_seed(client, settings):
    """The 2026-09-25 repro: propose, then reload and reseed. Both must succeed."""
    assert _propose(client, "superlatives", clause_text="Proposal before a restart.",
                    effective_from="2027-05-01").status_code == 201
    reload = client.post("/api/rules/reload", headers=auth("admin"))
    assert reload.status_code == 200, reload.text
    cli.seed()  # what the Docker CMD runs on every start; raises typer.Exit(1) on refusal


def test_yaml_that_claims_a_proposal_number_renumbers_the_proposal(tmp_path, settings, private_db):
    """Git owns version numbers: reviewed YAML v3 must load even when an API proposal holds v3."""
    rules_dir = tmp_path / "rules"
    shutil.copytree(settings.rules_dir, rules_dir)
    with private_db() as session:
        load_rules(session, rules_dir, actor="tests")
        rule = session.scalar(select(Rule).where(Rule.code == "soa-48h-wait"))
        session.add(RuleVersion(rule_id=rule.id, version=3, status="proposed", clause_text="What-if text.",
                                effective_from=date(2027, 10, 1), change_classification="MODIFIES",
                                params={}, git_commit="ui:engineer@2026-09-25T00:00:00"))
        session.commit()

    path = rules_dir / "soa-48h-wait.yaml"
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    doc["versions"][-1]["effective_to"] = date(2027, 9, 30)
    doc["versions"].append({"version": 3, "status": "in_force", "effective_from": date(2027, 10, 1),
                            "change_classification": "CLARIFIES", "clause_text": "Reviewed CY2028 text."})
    path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")

    with private_db() as session:
        report = load_rules(session, rules_dir, actor="tests")
        assert report.versions_created == 1
        rule = session.scalar(select(Rule).where(Rule.code == "soa-48h-wait"))
        by_number = {v.version: v for v in rule.versions}
        assert by_number[3].status == "in_force" and by_number[3].clause_text == "Reviewed CY2028 text."
        assert by_number[4].status == "proposed" and by_number[4].clause_text == "What-if text."
        moved = session.scalars(select(AuditEvent).where(AuditEvent.event_type == "rule.proposal_renumbered")).all()
        assert [(e.payload["from_version"], e.payload["to_version"]) for e in moved] == [(3, 4)]
        assert load_rules(session, rules_dir, actor="tests").versions_created == 0, "reload is a no-op"


# ====================================================================== bug 3


def _row_counts(session) -> tuple[int, int]:
    session.expire_all()
    return (session.scalar(select(func.count()).select_from(ReviewTask)),
            session.scalar(select(func.count()).select_from(AuditEvent)))


def test_what_if_evaluates_a_proposal_as_enacted_and_writes_nothing(client, session):
    as_of = "2027-08-01"
    baseline = client.get(f"/api/rules/soa-48h-wait/impact?as_of={as_of}", headers=auth("engineer")).json()
    assert baseline["hypothetical"] is False and baseline["in_force_version"] == 2
    proposed = _propose(client, "soa-48h-wait", clause_text="What-if: a waiting period returns.",
                        effective_from="2027-07-01", change_classification="ADDS_REQUIREMENT").json()

    before = _row_counts(session)
    what_if = client.get(f"/api/rules/soa-48h-wait/impact?as_of={as_of}&include_proposed=true",
                         headers=auth("engineer")).json()
    assert _row_counts(session) == before, "a what-if opens no tasks and writes no audit events"

    assert what_if["hypothetical"] is True and what_if["assumed_version"] == proposed["version"]
    assert what_if["in_force_version"] == proposed["version"]
    assert "what-if" in what_if["note"]
    # v2-bound encodings (the prompts that declare v2) become stale under an added requirement.
    assert what_if["counts"]["under_restrictive"] > baseline["counts"]["under_restrictive"]
    assert all(item["task_id"] is None for item in what_if["stale"])
    assert any(p["declared_version"] == 2 and p["stale"] for p in what_if["prompt_versions"])

    # Default behaviour is unchanged: the proposal is still not law.
    again = client.get(f"/api/rules/soa-48h-wait/impact?as_of={as_of}", headers=auth("engineer")).json()
    assert again["in_force_version"] == 2 and again["hypothetical"] is False
    assert again["counts"] == baseline["counts"]


def test_what_if_before_the_proposal_starts_falls_back_to_enacted_history(client):
    body = client.get("/api/rules/soa-48h-wait/impact?as_of=2026-10-02&include_proposed=true",
                      headers=auth("analyst")).json()
    assert body["hypothetical"] is False and body["in_force_version"] == 2
    assert "no proposed version" in body["note"]
    missing = client.get("/api/rules/soa-48h-wait/impact?as_of=2027-08-01&assume_version=99",
                         headers=auth("analyst"))
    assert missing.status_code == 404


# ====================================================================== bug 2


@pytest.fixture
def contract_env(tmp_path, settings, private_db):
    contracts_dir = tmp_path / "contracts"
    shutil.copytree(settings.contracts_dir, contracts_dir)
    with private_db() as session:
        load_rules(session, settings.rules_dir, actor="tests")
        runner.seed_contracts(session, contracts_dir)
        session.commit()
    return contracts_dir, private_db


def _edit_contract(contracts_dir: Path, code: str, **changes) -> None:
    path = contracts_dir / "contracts.yaml"
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    next(c for c in doc["contracts"] if c["code"] == code).update(changes)
    path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")


def _contract_events(session) -> list[AuditEvent]:
    return session.scalars(select(AuditEvent).where(AuditEvent.event_type == "contract.version_created")).all()


def test_unchanged_contract_yaml_is_a_no_op(contract_env):
    contracts_dir, Session = contract_env
    with Session() as session:
        runner.seed_contracts(session, contracts_dir)
        session.commit()
        assert all(len(c.versions) == 1 for c in session.scalars(select(Contract)).all())
        assert _contract_events(session) == []


def test_a_contract_yaml_edit_appends_a_version_and_moves_the_row(contract_env):
    contracts_dir, Session = contract_env
    _edit_contract(contracts_dir, "C-SUP-01", severity="BLOCK")
    with Session() as session:
        runner.seed_contracts(session, contracts_dir, actor="tests")
        session.commit()
        contract = session.scalar(select(Contract).where(Contract.code == "C-SUP-01"))
        assert contract.severity == "BLOCK", "the gate must use the new severity"
        assert [v.version for v in contract.versions] == [1, 2]
        assert contract.versions[-1].spec["_definition"]["severity"] == "BLOCK"
        events = _contract_events(session)
        assert len(events) == 1 and events[0].payload["changed"] == ["severity"]
        assert events[0].payload["before"] == {"severity": "FLAG"} and events[0].payload["after"] == {"severity": "BLOCK"}
        # Other contracts are untouched, and a second seed is a no-op.
        others = session.scalars(select(Contract).where(Contract.code != "C-SUP-01")).all()
        assert all(len(c.versions) == 1 for c in others)
        runner.seed_contracts(session, contracts_dir, actor="tests")
        session.commit()
        assert len(_contract_events(session)) == 1


def test_contract_spec_and_kind_edits_are_versioned(contract_env):
    contracts_dir, Session = contract_env
    _edit_contract(contracts_dir, "J-COACH-01", spec={"threshold": 3.5, "rubric": "Stricter rubric."})
    _edit_contract(contracts_dir, "C-FACT-01", title="Every dollar figure is grounded (v2)")
    with Session() as session:
        runner.seed_contracts(session, contracts_dir, actor="tests")
        session.commit()
        judged = session.scalar(select(Contract).where(Contract.code == "J-COACH-01"))
        assert judged.versions[-1].version == 2 and judged.versions[-1].spec["threshold"] == 3.5
        fact = session.scalar(select(Contract).where(Contract.code == "C-FACT-01"))
        assert fact.title.endswith("(v2)") and len(fact.versions) == 2
        assert sorted(e.payload["contract"] for e in _contract_events(session)) == ["C-FACT-01", "J-COACH-01"]


# ====================================================================== bug 4: redaction


def test_pii_golden_scores():
    cases = yaml.safe_load((REPO / "fixtures" / "pii_golden.yaml").read_text(encoding="utf-8"))["cases"]
    report = pii.score_golden(cases)
    assert report["cases"] >= 30 and report["negatives"] >= 10
    # Negatives (dollar figures, plan IDs, call timestamps, toll-free numbers) are never redacted.
    assert report["fp"] == 0, report["failures"]
    assert report["precision"] == 1.0 and report["recall"] >= 0.9, report
    # Every miss is a documented limitation, never a silent one.
    assert all(f["limitation"] for f in report["failures"]), report["failures"]


@pytest.mark.parametrize("text, kind", [
    ("1eg4 te5 mk73", "medicare_number"),
    ("social security 123 45 6789", "ssn"),
    ("DOB: 1948-03-14", "dob"),
    ("born March 14, 1948", "dob"),
    ("(512) 555-0142", "phone"),
    ("jane.doe@example.com", "email"),
    ("742 Evergreen Terrace", "address"),
])
def test_redaction_covers_the_audit_probe_formats(text, kind):
    redacted, counts = pii.redact(f"Customer said {text} on the call.")
    assert counts[kind] == 1 and text not in redacted


@pytest.mark.parametrize("text", [
    "Plan H1234-001 has a $1,234.56 deductible.",
    "Call started 2026-10-02T14:03:11Z; [00:01:20] AGENT: hello.",
    "Please contact 1-800-MEDICARE (1-800-633-4227).",
    "Coverage starts January 1, 2027.",
])
def test_redaction_leaves_plan_ids_money_timestamps_and_toll_free_numbers(text):
    assert pii.redact(text)[0] == text


CSV = (
    "call_id,started_at,agent_name,product_line,duration_seconds,transcript\n"
    'PII-1,2026-10-02T14:03:11Z,Dana Whitfield,MA,60,"AGENT: This is Dana Whitfield. CUSTOMER: My number is '
    '(512) 555-0142, email jo@example.com, I live at 12 Oak Street, born March 3, 1951, social 123456789."\n'
)


def test_ingest_stores_no_raw_pii_and_agent_initials(private_db, monkeypatch):
    monkeypatch.delenv(KEEP_AGENT_NAMES_ENV, raising=False)
    with private_db() as session:
        report = ingest_csv(session, CSV, actor="tests")
        t = session.scalar(select(Transcript).where(Transcript.code == "A-PII-1"))
        for secret in ("Dana Whitfield", "555-0142", "jo@example.com", "12 Oak Street", "March 3, 1951", "123456789"):
            assert secret not in t.text and secret not in str(t.labels), secret
        assert t.labels["agent"] == "D.W." and "This is D.W." in t.text
        assert report["redacted"]["agent_name"] == 1 and report["redacted"]["phone"] == 1
        assert t.text.count("[REDACTED-") == 5


def test_ingest_can_keep_agent_names_when_configured(private_db, monkeypatch):
    monkeypatch.setenv(KEEP_AGENT_NAMES_ENV, "1")
    with private_db() as session:
        ingest_csv(session, CSV, actor="tests")
        t = session.scalar(select(Transcript).where(Transcript.code == "A-PII-1"))
        assert t.labels["agent"] == "Dana Whitfield"


# ====================================================================== bug 4: egress guard


class RecordingAdapter:
    name = "recording"

    def __init__(self):
        self.generated: list[str] = []
        self.judged: list[str] = []

    def generate(self, prompt_text, transcript_text, transcript_code, labels, logic):
        self.generated.append(transcript_code)
        return AdapterResult(raw={}, latency_ms=1, usage={})

    def judge(self, rubric, coaching_note, transcript_text, transcript_code, n):
        self.judged.append(transcript_code)
        return [4.0], {}


REAL = {"ingested": True}
SYNTHETIC = {"scenario": "A"}


@pytest.mark.parametrize("model_id", ["groq/llama-3.1-8b-instant", "gemini/gemini-2.5-flash",
                                      "openrouter/google/gemma-3-27b-it:free"])
def test_real_transcripts_never_reach_hosted_free_tiers(model_id):
    inner = RecordingAdapter()
    guard = RealDataGuard(inner, model_id)
    refused = guard.generate("p", "text", "A-1", REAL, {})
    assert refused.error and refused.error.startswith("refused:") and "free tier" in refused.error
    assert inner.generated == [], "nothing may be sent"
    assert guard.generate("p", "text", "T001", SYNTHETIC, {}).error is None
    assert inner.generated == ["T001"]


def test_local_models_may_receive_real_transcripts():
    inner = RecordingAdapter()
    assert RealDataGuard(inner, "ollama/qwen2.5:7b-instruct").generate("p", "t", "A-1", REAL, {}).error is None
    assert inner.generated == ["A-1"]


def test_anthropic_needs_explicit_configuration(monkeypatch):
    monkeypatch.delenv(providers.ANTHROPIC_REAL_DATA_ENV, raising=False)
    inner = RecordingAdapter()
    assert "BACKSTOP_ALLOW_ANTHROPIC_REAL_DATA" in RealDataGuard(inner, "claude-sonnet-5").generate(
        "p", "t", "A-1", REAL, {}).error
    monkeypatch.setenv(providers.ANTHROPIC_REAL_DATA_ENV, "1")
    assert RealDataGuard(inner, "claude-sonnet-5").generate("p", "t", "A-1", REAL, {}).error is None


def test_a_hosted_judge_is_refused_notes_about_real_calls():
    inner = RecordingAdapter()
    guard = RealDataGuard(inner, "ollama/qwen2.5:7b-instruct", judge_model_id="gemini/gemini-2.5-flash-lite")
    guard.generate("p", "t", "A-1", REAL, {})
    scores, meta = guard.judge("rubric", "note", "t", "A-1", 3)
    assert scores == [] and meta["refused"] and inner.judged == []
    guard.generate("p", "t", "T001", SYNTHETIC, {})
    assert guard.judge("rubric", "note", "t", "T001", 3)[0] == [4.0]


def test_build_adapter_wraps_every_live_adapter(monkeypatch, settings):
    monkeypatch.setattr(ad, "_live_adapter", lambda *a, **k: RecordingAdapter())
    live = ad.build_adapter("live", model_id="groq/llama-3.1-8b-instant", fixtures_dir=settings.fixtures_dir,
                            prompt_hash="x", api_key=None)
    assert isinstance(live, RealDataGuard)
    recorder = ad.build_adapter("cassette", model_id="groq/llama-3.1-8b-instant", fixtures_dir=settings.fixtures_dir,
                                prompt_hash="x", api_key=None, record=True)
    assert isinstance(recorder.fallback, RealDataGuard)


# ====================================================================== matchers (r1 findings)


def _hits(text: str) -> set[tuple[str, int, str]]:
    return {(m.rule_code, m.version, m.status) for m in matchers.run_all(text)}


def test_short_form_disclaimer_is_not_a_compliant_v2_encoding():
    short = ("We do not offer every plan available in your area. Any information we provide is limited to those "
             "plans we do offer in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on "
             "all of your options.")
    assert _hits(short) == {("tpmo-disclaimer-text", 2, "proposed")}
    note = next(m.note for m in matchers.run_all(short))
    assert "incomplete disclaimer" in note and "organization/plan counts" in note
    full = ("We do not offer every plan available in your area. Currently we represent 26 organizations which "
            "offer 3,740 products in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information "
            "on all of your options.")
    assert _hits(full) == {("tpmo-disclaimer-text", 2, "confirmed")}


def test_carrier_availability_is_not_a_licensing_claim():
    assert _hits("AARP MedicareRx Preferred. Available in all 50 states and Washington, D.C.") == set()
    assert _hits("Licensed in All 50 States") == {("eip-licensing-footprint", 2, "confirmed")}


def test_a_superlative_listicle_opens_a_bounded_number_of_reviews():
    page = " ".join(f"Plan {i} has the lowest premium in the county." for i in range(12))
    found = [m for m in matchers.run_all(page) if m.rule_code == "superlatives"]
    assert len(found) == 3 and "+9 more" in found[-1].note
