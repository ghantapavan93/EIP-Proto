from datetime import date

from backstop.core.staleness import EdgeView, VersionView, evaluate, summarize, version_in_force

V1 = VersionView("v1", 1, "in_force", date(2023, 9, 30), date(2026, 9, 30), "INITIAL")
V2_REMOVES = VersionView("v2", 2, "eliminated", date(2026, 10, 1), None, "REMOVES_REQUIREMENT")
V2_TIGHTENS = VersionView("v2", 2, "in_force", date(2026, 10, 1), None, "TIGHTENS")
V2_MODIFIES = VersionView("v2", 2, "in_force", date(2026, 10, 1), None, "MODIFIES", disputed=True)


def test_version_in_force_respects_the_boundary():
    versions = [V1, V2_REMOVES]
    assert version_in_force(versions, date(2026, 9, 30)).version == 1
    assert version_in_force(versions, date(2026, 10, 1)).version == 2
    assert version_in_force(versions, date(2020, 1, 1)) is None


def test_removed_requirement_makes_enforcing_artifacts_over_restrictive():
    edges = [EdgeView("e1", "asset-a", "v1", "ENFORCES")]
    before = evaluate([V1, V2_REMOVES], edges, date(2026, 9, 30))
    after = evaluate([V1, V2_REMOVES], edges, date(2026, 10, 1))
    assert before == []
    assert len(after) == 1
    assert after[0].direction == "over_restrictive"
    assert "removed" in after[0].reason


def test_tightened_rule_makes_old_encodings_under_restrictive():
    edges = [EdgeView("e1", "asset-a", "v1", "ENFORCES"), EdgeView("e2", "asset-b", "v1", "PERMITS")]
    verdicts = evaluate([V1, V2_TIGHTENS], edges, date(2026, 10, 1))
    assert {v.direction for v in verdicts} == {"under_restrictive"}


def test_modified_basis_needs_a_human_and_carries_the_dispute_flag():
    edges = [EdgeView("e1", "asset-a", "v1", "ENFORCES")]
    verdicts = evaluate([V1, V2_MODIFIES], edges, date(2026, 10, 1))
    assert verdicts[0].direction == "reverify"
    assert verdicts[0].disputed is True


def test_edges_bound_to_the_current_version_are_healthy():
    edges = [EdgeView("e1", "asset-a", "v2", "ENFORCES")]
    assert evaluate([V1, V2_REMOVES], edges, date(2026, 10, 1)) == []


def test_proposed_and_rejected_edges_are_ignored():
    edges = [EdgeView("e1", "asset-a", "v1", "ENFORCES", status="proposed"),
             EdgeView("e2", "asset-b", "v1", "ENFORCES", status="rejected")]
    assert evaluate([V1, V2_REMOVES], edges, date(2026, 10, 1)) == []


def test_opposite_directions_on_the_path_escalate_to_reverify():
    v2 = VersionView("v2", 2, "in_force", date(2024, 1, 1), date(2026, 9, 30), "TIGHTENS")
    v3 = VersionView("v3", 3, "in_force", date(2026, 10, 1), None, "LOOSENS")
    v1 = VersionView("v1", 1, "in_force", date(2023, 1, 1), date(2023, 12, 31), "INITIAL")
    edges = [EdgeView("e1", "asset-a", "v1", "ENFORCES")]
    verdicts = evaluate([v1, v2, v3], edges, date(2026, 10, 1))
    assert verdicts[0].direction == "reverify"
    assert "opposite" in verdicts[0].reason


def test_summary_counts_edges_and_distinct_artifacts():
    edges = [EdgeView("e1", "asset-a", "v1", "ENFORCES"), EdgeView("e2", "asset-a", "v1", "ENFORCES"),
             EdgeView("e3", "asset-b", "v1", "INFORMS")]
    counts = summarize(evaluate([V1, V2_REMOVES], edges, date(2026, 10, 1)))
    assert counts["total"] == 3
    assert counts["artifacts"] == 2
    assert counts["over_restrictive"] == 2
    assert counts["reverify"] == 1
