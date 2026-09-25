"""Golden-fixture tests: the demo's numbers are asserted, not eyeballed."""

from datetime import date

from sqlalchemy import func, select

from backstop.core.rules_loader import RuleCorpusError, load_rules
from backstop.harness.runner import execute_run
from backstop.models import AssetVersion, ReviewTask, Rule, RuleAssetEdge
from backstop.scanner.service import run_scan


def _counts(run, code):
    return run.stats["contracts"][code]


def test_v1_before_oct_1_is_green(session, settings):
    out = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=1, model_id="sim-large",
                      adapter_kind="simulated", rule_date=date(2026, 9, 30), actor="tests")
    assert out.run.gate == "GREEN"
    assert _counts(out.run, "C-TPMO-01")["FAIL"] == 0


def test_rule_flip_breaks_the_old_prompt(session, settings):
    out = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=1, model_id="sim-large",
                      adapter_kind="simulated", rule_date=date(2026, 10, 1), trigger="RULE", actor="tests")
    assert out.run.gate == "RED"
    # Scenario B (10 late-but-ordered) + C (4 early-but-unordered) disclaimers.
    assert _counts(out.run, "C-TPMO-01")["FAIL"] == 14
    # Scenario D: 8 appointments inside the old 48-hour window.
    assert _counts(out.run, "C-SOA-01")["FAIL"] == 8
    # Scenario F: 3 unsubstantiated superlatives the old prompt still flags.
    assert _counts(out.run, "C-SUP-01")["FLAG"] == 3
    assert out.run.stats["logic_in_force"]["disclaimer_basis"] == "ordering"
    assert out.run.stats["logic_declared_by_prompt"]["disclaimer_basis"] == "timer"


def test_updated_prompt_is_green_after_oct_1(session, settings):
    out = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=2, model_id="sim-large",
                      adapter_kind="simulated", rule_date=date(2026, 10, 1), trigger="PROMPT", actor="tests")
    assert out.run.gate == "GREEN"


def test_model_swap_surfaces_grounding_defects(session, settings):
    out = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=2, model_id="sim-small",
                      adapter_kind="simulated", rule_date=date(2026, 10, 1), trigger="MODEL", actor="tests")
    assert out.run.gate == "RED"
    assert _counts(out.run, "C-SPAN-01")["FAIL"] > 0
    assert _counts(out.run, "C-PII-01")["FAIL"] > 0
    assert _counts(out.run, "C-TPMO-01")["FAIL"] == 0  # rule judgments are unaffected by the model swap
    judged = _counts(out.run, "J-COACH-01")
    assert judged["FLAG"] > 0 and judged["FAIL"] == 0  # advisory: flags, never fails


def test_runs_are_idempotent(session, settings):
    first = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=2, model_id="sim-large",
                        adapter_kind="simulated", rule_date=date(2026, 10, 1), actor="tests")
    second = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=2, model_id="sim-large",
                         adapter_kind="simulated", rule_date=date(2026, 10, 1), actor="tests")
    assert second.deduplicated is True
    assert second.run.id == first.run.id


def test_simulated_models_cannot_run_on_the_live_adapter(session, settings):
    import pytest

    with pytest.raises(ValueError):
        execute_run(session, settings, workflow_code="qa-handoff", prompt_version=2, model_id="sim-large",
                    adapter_kind="anthropic", rule_date=date(2026, 10, 1), actor="tests")


def test_scan_twice_changes_nothing(session, settings):
    versions_before = session.scalar(select(func.count(AssetVersion.id)))
    edges_before = session.scalar(select(func.count(RuleAssetEdge.id)))
    tasks_before = session.scalar(select(func.count(ReviewTask.id)))
    outcome = run_scan(session, settings, idempotency_key="tests:scan-2", live=False, actor="tests")
    assert outcome.deduplicated is False
    assert outcome.scan.stats["new_versions"] == 0
    assert outcome.scan.stats["edges_new"] == 0
    assert session.scalar(select(func.count(AssetVersion.id))) == versions_before
    assert session.scalar(select(func.count(RuleAssetEdge.id))) == edges_before
    assert session.scalar(select(func.count(ReviewTask.id))) == tasks_before
    again = run_scan(session, settings, idempotency_key="tests:scan-2", live=False, actor="tests")
    assert again.deduplicated is True


def test_real_page_encodes_the_retired_soa_rule(session):
    rule = session.scalar(select(Rule).where(Rule.code == "soa-48h-wait"))
    v1 = next(v for v in rule.versions if v.version == 1)
    edges = session.scalars(select(RuleAssetEdge).where(RuleAssetEdge.rule_version_id == v1.id)).all()
    real = [e for e in edges if not e.asset.is_synthetic and e.asset.type == "web_page" and e.status == "confirmed"]
    assert real, "the frozen MedicareFAQ SOA page should carry the 48-hour encoding"
    assert any("48" in e.evidence_span for e in real)


def test_rules_loader_is_idempotent_and_refuses_in_place_edits(session, settings, tmp_path):
    report = load_rules(session, settings.rules_dir, actor="tests")
    assert report.versions_created == 0 and report.unchanged > 0
    # Copy one rule, tamper with an existing version's clause text, and expect a refusal.
    src = (settings.rules_dir / "soa-48h-wait.yaml").read_text(encoding="utf-8")
    (tmp_path / "soa-48h-wait.yaml").write_text(src.replace("48 hours after", "72 hours after"), encoding="utf-8")
    import pytest

    with pytest.raises(RuleCorpusError):
        load_rules(session, tmp_path, actor="tests")
    session.rollback()
