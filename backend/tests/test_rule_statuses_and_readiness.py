"""Vacated / stayed / undated-proposed rule versions, annotations, the new rules and matchers,
and the read-only readiness endpoint (2026-09-25)."""

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

from backstop import schemas as s
from backstop.core import pii, staleness
from backstop.core.impact import in_force_version
from backstop.core.rules_loader import RuleCorpusError, _fingerprint, load_rules, validate_rule_doc
from backstop.core.staleness import (
    OVER,
    REVERIFY,
    UNDER,
    EdgeView,
    VersionView,
    evaluate,
    version_in_force,
)
from backstop.db import Base
from backstop.main import app
from backstop.models import AuditEvent, ReviewTask, Rule
from backstop.scanner import matchers


def auth(user: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{user}".encode()).decode()}


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


def V(n, status, start, end=None, cls="INITIAL", disputed=False):  # noqa: N802 - reads like a table row
    return VersionView(id=f"v{n}", version=n, status=status, effective_from=start, effective_to=end,
                       change_classification=cls, disputed=disputed)


def E(bound, polarity="ENFORCES", asset="a1"):  # noqa: N802
    return EdgeView(id=f"e-{bound}-{polarity}-{asset}", asset_id=asset, bound_version_id=bound, polarity=polarity)


# The compensation shape: v1 baseline, v2 vacated rewrite, v3 the restored text with new caps.
COMP = [
    V(1, "in_force", date(2023, 9, 30), date(2026, 9, 30)),
    V(2, "vacated", date(2024, 10, 1), None, "TIGHTENS"),
    V(3, "in_force", date(2026, 10, 1), None, "RESTORES_PRIOR"),
]
# The one-to-one shape: the vacated version is the highest number.
PEWC = [V(1, "in_force", date(2023, 9, 30)), V(2, "vacated", date(2025, 1, 27), None, "TIGHTENS")]


# ------------------------------------------------------------------ staleness engine


@pytest.mark.parametrize("status", ["vacated", "stayed", "proposed"])
def test_set_aside_and_proposed_versions_are_never_in_force(status):
    versions = [V(1, "in_force", date(2023, 9, 30)), V(2, status, date(2025, 1, 1), None, "TIGHTENS")]
    for as_of in (date(2024, 1, 1), date(2025, 1, 1), date(2030, 1, 1)):
        assert version_in_force(versions, as_of).version == 1


def test_undated_proposal_is_never_in_force_and_never_stale():
    versions = [V(1, "in_force", date(2025, 4, 11)), V(2, "proposed", None, None, "MODIFIES")]
    assert version_in_force(versions, date(2026, 12, 1)).version == 1
    assert evaluate(versions, [E("v2")], date(2026, 12, 1)) == []  # ahead of the rule, not stale


def test_the_vacated_rewrite_is_skipped_and_the_restored_text_is_in_force():
    assert version_in_force(COMP, date(2025, 6, 1)).version == 1
    assert version_in_force(COMP, date(2026, 10, 1)).version == 3


def test_an_artifact_enforcing_a_vacated_tightening_is_over_restrictive():
    [v] = evaluate(COMP, [E("v2")], date(2026, 10, 1))
    assert v.direction == OVER and "(vacated)" in v.reason and "a court vacated" in v.reason
    # Before v3, too: the vacated text was never the law.
    [early] = evaluate(COMP, [E("v2")], date(2025, 6, 1))
    assert early.direction == OVER and early.in_force_version == 1


def test_a_vacated_version_numbered_above_the_current_one_is_stale_not_ahead():
    [v] = evaluate(PEWC, [E("v2", "INFORMS")], date(2026, 10, 1))
    assert v.direction == REVERIFY and v.bound_version == 2 and v.in_force_version == 1


def test_a_vacated_loosening_is_under_restrictive_when_relied_on():
    versions = [V(1, "in_force", date(2023, 1, 1)), V(2, "stayed", date(2024, 1, 1), None, "LOOSENS")]
    [v] = evaluate(versions, [E("v2", "PERMITS")], date(2025, 1, 1))
    assert v.direction == UNDER and "stayed" in v.reason


def test_the_path_skips_the_vacated_version():
    # Bound to v1 at v3: only RESTORES_PRIOR is on the path. The vacated TIGHTENS must not
    # turn this into under_restrictive.
    [v] = evaluate(COMP, [E("v1")], date(2026, 10, 1))
    assert v.direction == REVERIFY and "restored" in v.reason


# ------------------------------------------------------------------ loader validation


def _doc(*versions):
    return {"code": "x", "title": "x", "regulator": "CMS", "citation": "x", "versions": list(versions)}


def _v(n, status, start, end=None, **extra):
    return {"version": n, "status": status, "effective_from": start, "effective_to": end,
            "change_classification": extra.pop("cls", "INITIAL"), "clause_text": f"v{n}", **extra}


def test_loader_accepts_a_vacated_version_that_overlaps_the_version_it_never_displaced():
    validate_rule_doc(_doc(_v(1, "in_force", "2023-09-30", "2026-09-30"),
                           _v(2, "vacated", "2024-10-01", cls="TIGHTENS"),
                           _v(3, "in_force", "2026-10-01", cls="RESTORES_PRIOR")), Path("x.yaml"))


def test_loader_accepts_an_open_enacted_version_plus_an_undated_proposal():
    validate_rule_doc(_doc(_v(1, "in_force", "2025-04-11"),
                           _v(2, "proposed", None, vote_date="2026-09-30", cls="MODIFIES")), Path("x.yaml"))


@pytest.mark.parametrize("doc, message", [
    (_doc(_v(1, "in_force", None)), "only a proposed version may be undated"),
    (_doc(_v(1, "proposed", None, "2027-01-01")), "effective_to but no effective_from"),
    (_doc(_v(1, "in_force", "2025-01-01", vote_date="soon")), "vote_date is not a date"),
    (_doc(_v(1, "in_force", "2025-01-01", deferrals=[{"deferred_to": "2027-01-31"}])), "needs a provision"),
    (_doc(_v(1, "in_force", "2025-01-01", deferrals=[{"provision": "revoke-all"}])), "needs deferred_to"),
    (_doc(_v(1, "in_force", "2025-01-01"), _v(2, "in_force", "2026-01-01")), "more than one enacted version"),
    (_doc(_v(1, "vacated", "2025-01-01", cls="RESTORES_PRIOR"), _v(2, "bogus", "2026-01-01")), "bad status"),
])
def test_loader_refuses_malformed_versions(doc, message):
    with pytest.raises(RuleCorpusError, match=message):
        validate_rule_doc(doc, Path("x.yaml"))


def test_annotations_are_not_part_of_the_fingerprint():
    base = _v(1, "in_force", "2025-04-11")
    annotated = {**base, "vote_date": "2026-09-30",
                 "deferrals": [{"provision": "p", "deferred_to": "2027-01-31", "source": "s"}],
                 "sources": [{"authority": "primary", "cite": "c"}]}
    assert _fingerprint(base) == _fingerprint(annotated)


@pytest.fixture
def scratch_rules(tmp_path, settings):
    rules_dir = tmp_path / "rules"
    shutil.copytree(settings.rules_dir, rules_dir)
    engine = create_engine(f"sqlite:///{(tmp_path / 'rules.db').as_posix()}")
    Base.metadata.create_all(engine)
    Session = sessionmaker(engine, expire_on_commit=False)
    with Session() as session:
        load_rules(session, rules_dir, actor="tests")
    yield rules_dir, Session
    engine.dispose()


def test_a_moved_vote_or_extended_deferral_is_refreshed_in_place_and_audited(scratch_rules):
    rules_dir, Session = scratch_rules
    path = rules_dir / "tcpa-consent-revocation.yaml"
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    doc["versions"][1]["vote_date"] = date(2026, 10, 28)
    doc["versions"][0]["deferrals"][0]["deferred_to"] = date(2027, 6, 30)
    path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")
    with Session() as session:
        report = load_rules(session, rules_dir, actor="tests")  # no "edited in place" refusal
        assert report.versions_created == 0
        rule = session.scalar(select(Rule).where(Rule.code == "tcpa-consent-revocation"))
        v1, v2 = rule.versions
        assert v2.vote_date == date(2026, 10, 28) and v2.effective_from is None
        assert v1.deferrals[0]["deferred_to"] == "2027-06-30"
        events = session.scalars(select(AuditEvent).where(AuditEvent.event_type == "rule.version_annotated")).all()
        assert {e.payload["version"] for e in events} == {1, 2}
        # A second reload changes nothing and writes no further annotation rows.
        load_rules(session, rules_dir, actor="tests")
        assert session.scalar(select(func.count(AuditEvent.id))
                              .where(AuditEvent.event_type == "rule.version_annotated")) == 2


# ------------------------------------------------------------------ the loaded corpus


def test_the_new_rules_resolve_as_the_report_verified(session):
    def rule(code):
        return session.scalar(select(Rule).where(Rule.code == code))

    comp = rule("agent-broker-compensation")
    assert [v.status for v in comp.versions] == ["in_force", "vacated", "in_force"]
    assert in_force_version(comp, date(2026, 9, 25)).version == 1
    v3 = in_force_version(comp, date(2026, 10, 1))
    assert v3.version == 3 and v3.change_classification == "RESTORES_PRIOR"
    assert v3.params["fmv_initial"]["national"] == 725 and v3.params["fmv_renewal"]["national"] == 363
    assert (v3.params["pdp_initial"], v3.params["pdp_renewal"]) == (130, 65)
    assert (v3.params["referral_cap_ma"], v3.params["referral_cap_pdp"]) == (100, 25)

    pewc = rule("tcpa-pewc-one-to-one")
    assert in_force_version(pewc, date(2026, 10, 1)).version == 1 and pewc.versions[1].status == "vacated"
    assert in_force_version(rule("tpmo-data-sharing-consent"), date(2026, 10, 1)).version == 1

    revoke = rule("tcpa-consent-revocation")
    v1, v2 = revoke.versions
    assert v1.deferrals == [{"provision": v1.deferrals[0]["provision"], "deferred_to": "2027-01-31",
                             "source": v1.deferrals[0]["source"]}]
    assert "revoke-all" in v1.deferrals[0]["provision"].lower()
    assert v2.status == "proposed" and v2.effective_from is None and v2.vote_date == date(2026, 9, 30)
    assert in_force_version(revoke, date(2027, 6, 1)).version == 1

    soa = rule("soa-all-personal-marketing-appointments")
    assert in_force_version(soa, date(2026, 9, 30)).version == 1
    assert in_force_version(soa, date(2026, 10, 1)).params["includes_inbound"] is True

    fl = rule("fl-telesolicitation-hours-frequency").versions[0]
    assert fl.disputed and fl.params["latest_local"] == "20:00" and fl.params["max_calls_per_24h_same_subject"] == 3

    disclaimer = in_force_version(rule("tpmo-disclaimer-text"), date(2026, 10, 1))
    assert "You can always contact Medicare.gov or 1-800-MEDICARE for help with plan choices" in disclaimer.clause_text


def test_rule_versions_carry_vote_date_and_deferrals_in_the_api(client):
    body = client.get("/api/rules/tcpa-consent-revocation", headers=auth("analyst")).json()
    v1, v2 = body["versions"]
    assert v2["effective_from"] is None and v2["vote_date"] == "2026-09-30" and v2["status"] == "proposed"
    assert v1["deferrals"][0]["deferred_to"] == "2027-01-31" and v1["vote_date"] is None
    assert body["in_force_version"] == 1


def test_what_if_on_an_undated_proposal_assumes_as_of_and_writes_nothing(client, session):
    audit_before = session.scalar(select(func.count(AuditEvent.id)))
    tasks_before = session.scalar(select(func.count(ReviewTask.id)))
    r = client.get("/api/rules/tcpa-consent-revocation/impact",
                   params={"as_of": "2026-11-15", "assume_version": 2}, headers=auth("engineer"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["hypothetical"] is True and body["in_force_version"] == 2
    assert "no effective date yet" in body["note"] and "2026-11-15" in body["note"]
    # Without assume_version, an undated proposal is never picked up.
    plain = client.get("/api/rules/tcpa-consent-revocation/impact",
                       params={"as_of": "2026-11-15", "include_proposed": True}, headers=auth("analyst")).json()
    assert plain["hypothetical"] is False and plain["in_force_version"] == 1
    session.expire_all()
    assert session.scalar(select(func.count(ReviewTask.id))) == tasks_before
    assert session.scalar(select(func.count(AuditEvent.id))) == audit_before


# ------------------------------------------------------------------ matchers and sandbox


def test_sandbox_flags_the_vacated_compensation_text_and_the_one_to_one_reference(client):
    text = ("Per 42 CFR 422.2274(e)(2), carrier administrative payments must be counted as compensation. "
            "Following the FCC one-to-one consent rule, you consent to calls from one seller at a time.")
    body = client.post("/api/sandbox/artifact", json={"text": text, "as_of": "2026-10-01"},
                       headers=auth("analyst")).json()
    by_rule = {m["rule_code"]: m for m in body["matches"]}
    comp = by_rule["agent-broker-compensation"]
    assert comp["bound_status"] == "vacated" and comp["verdict"] == "stale"
    assert comp["direction"] == "over_restrictive" and comp["in_force_version"] == 3
    pewc = by_rule["tcpa-pewc-one-to-one"]
    assert pewc["verdict"] == "stale" and pewc["direction"] == "reverify" and pewc["in_force_version"] == 1


def test_sandbox_reports_the_cy2027_caps_as_ahead_before_october(client):
    text = "Initial-year MA commission for CY2027: $725 per enrollment (national)."
    body = client.post("/api/sandbox/artifact", json={"text": text, "as_of": "2026-09-25"},
                       headers=auth("analyst")).json()
    [m] = [m for m in body["matches"] if m["rule_code"] == "agent-broker-compensation"]
    assert m["verdict"] == "ahead" and m["bound_version"] == 3 and m["in_force_version"] == 1


def test_an_inbound_soa_exemption_is_under_restrictive_from_october(client):
    text = "Inbound transfers: no Scope of Appointment is needed when the caller calls in to enroll."
    body = client.post("/api/sandbox/artifact", json={"text": text, "as_of": "2026-10-01"},
                       headers=auth("analyst")).json()
    [m] = [m for m in body["matches"] if m["rule_code"] == "soa-all-personal-marketing-appointments"]
    assert m["verdict"] == "stale" and m["direction"] == "under_restrictive"
    before = client.post("/api/sandbox/artifact", json={"text": text, "as_of": "2026-09-30"},
                         headers=auth("analyst")).json()
    assert [x["verdict"] for x in before["matches"] if x["rule_code"] == m["rule_code"]] == ["current"]


def test_two_hits_in_one_sentence_make_one_edge():
    text = ("Following the FCC one-to-one consent rule, you consent to calls and texts from one seller at a time: "
            "Elite Insurance Partners, including by autodialer and prerecorded message.")
    hits = [m for m in matchers.run_all(text) if m.rule_code == "tcpa-pewc-one-to-one"]
    assert len(hits) == 1


def test_scan_links_the_new_synthetic_artifacts(session):
    from backstop.models import Asset, RuleAssetEdge, RuleVersion

    rows = session.execute(
        select(Asset.code, Rule.code, RuleVersion.version, RuleAssetEdge.status)
        .join(RuleAssetEdge, RuleAssetEdge.asset_id == Asset.id)
        .join(RuleVersion, RuleVersion.id == RuleAssetEdge.rule_version_id)
        .join(Rule, Rule.id == RuleVersion.rule_id)
        .where(Asset.code.in_(["lead-form-consent-01", "comp-sheet-2027", "dialer-policy-04"]))
    ).all()
    got = {(a, r, v, st) for a, r, v, st in rows}
    assert ("comp-sheet-2027", "agent-broker-compensation", 2, "confirmed") in got
    assert ("lead-form-consent-01", "tcpa-pewc-one-to-one", 2, "confirmed") in got
    assert ("lead-form-consent-01", "tpmo-data-sharing-consent", 1, "proposed") in got
    assert ("dialer-policy-04", "soa-all-personal-marketing-appointments", 1, "confirmed") in got
    assert ("dialer-policy-04", "fl-telesolicitation-hours-frequency", 1, "proposed") in got


# ------------------------------------------------------------------ schemas


def test_redaction_counts_cover_every_pii_kind():
    assert set(s.RedactionCounts.model_fields) == set(pii.KINDS)


def test_version_create_schema_knows_the_new_vocabulary():
    status = s.RuleVersionCreate.model_fields["status"].annotation.__args__
    classification = s.RuleVersionCreate.model_fields["change_classification"].annotation.__args__
    assert {"vacated", "stayed"} <= set(status) and "RESTORES_PRIOR" in classification
    assert staleness.NEVER_IN_FORCE == {"proposed", "vacated", "stayed"}


# ------------------------------------------------------------------ readiness


def test_readiness_six_days_before_october(client, session):
    audit_before = session.scalar(select(func.count(AuditEvent.id)))
    tasks_before = session.scalar(select(func.count(ReviewTask.id)))
    r = client.get("/api/readiness", params={"as_of": "2026-09-25"}, headers=auth("analyst"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["as_of"] == "2026-09-25"

    kinds = {(m["kind"], m["date"]) for m in body["milestones"]}
    assert {("marketing_start", "2026-10-01"), ("aep_start", "2026-10-15"), ("aep_end", "2026-12-07"),
            ("oep_start", "2027-01-01"), ("vote", "2026-09-30"), ("deferral_ends", "2027-01-31")} <= kinds
    applies = {(m["rule_code"], m["version"]) for m in body["milestones"] if m["kind"] == "rule_applies"}
    assert {("agent-broker-compensation", 3), ("soa-all-personal-marketing-appointments", 2),
            ("soa-48h-wait", 2)} <= applies
    assert ("agent-broker-compensation", 2) not in applies  # vacated: never applies
    dates = [m["date"] for m in body["milestones"]]
    assert dates == sorted(dates)
    vote = next(m for m in body["milestones"] if m["kind"] == "vote")
    assert vote["days_from_as_of"] == 5 and vote["rule_code"] == "tcpa-consent-revocation"

    assert set(body["horizon"]) == {"30", "60", "90"}
    oct1 = {(h["rule_code"], h["version"]): h for h in body["horizon"]["30"]}
    assert ("soa-48h-wait", 2) in oct1 and oct1[("soa-48h-wait", 2)]["stale_encodings_on_that_date"] > 0
    assert oct1[("soa-48h-wait", 2)]["applies_from"] == "2026-10-01"
    assert body["horizon"]["60"] == [] and body["horizon"]["90"] == []

    assert body["owners"] and all(o["open"] >= o["actionable"] >= 0 for o in body["owners"])
    assert sum(sum(o["by_kind"].values()) for o in body["owners"]) == sum(o["open"] for o in body["owners"])

    bd = body["burn_down"]
    assert bd["target"] == "2026-10-01" and bd["label"] == "CY2027 marketing changes apply"
    assert bd["days_left"] == 6 and bd["aep"] == {"date": "2026-10-15", "days_left": 20}
    assert bd["stale_encodings_on_target"] >= sum(h["stale_encodings_on_that_date"] for h in body["horizon"]["30"]
                                                  if h["applies_from"] == "2026-10-01")
    assert bd["open_actionable_now"] == sum(o["actionable"] for o in body["owners"])

    vacated = {(v["rule_code"], v["version"]) for v in body["vacated"]}
    assert vacated == {("agent-broker-compensation", 2), ("tcpa-pewc-one-to-one", 2)}
    assert all(v["why"] and v["source"] for v in body["vacated"])
    proposed = {(p["rule_code"], p["version"]): p for p in body["proposed"]}
    assert proposed[("tcpa-consent-revocation", 2)]["vote_date"] == "2026-09-30"

    session.expire_all()
    assert session.scalar(select(func.count(ReviewTask.id))) == tasks_before
    assert session.scalar(select(func.count(AuditEvent.id))) == audit_before


def test_readiness_rolls_the_calendar_forward_after_aep_opens(client):
    body = client.get("/api/readiness", params={"as_of": "2026-11-01"}, headers=auth("analyst")).json()
    by_kind = {m["kind"]: m["date"] for m in body["milestones"] if m["rule_code"] is None}
    assert by_kind["aep_end"] == "2026-12-07" and by_kind["aep_start"] == "2027-10-15"
    assert by_kind["marketing_start"] == "2027-10-01"
    assert body["burn_down"]["target"] == "2027-10-01" and body["burn_down"]["label"] == "CY2028 marketing changes apply"
    assert all(m["kind"] != "vote" for m in body["milestones"])  # the vote date has passed
    assert body["proposed"][0]["vote_date"] == "2026-09-30"  # still listed, with its date


def test_readiness_requires_sign_in(client):
    assert client.get("/api/readiness").status_code == 401
