"""Exact statistics (core/stats.py) against published values, and the compare/metrics logic
on hand-built cells where every count is known."""

from __future__ import annotations

import math
from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest

from backstop.api.contracts_metrics import _run_metrics
from backstop.api.runs import _Cells, _compare_statistics
from backstop.core import stats

# ------------------------------------------------------------------ Wilson


def test_wilson_matches_published_values():
    # 20/60 and 5/60: the 7B's in-sample and held-out v2 error counts on C-TPMO-01.
    assert stats.wilson_ci(20, 60) == pytest.approx((0.22729, 0.45943), abs=1e-5)
    assert stats.wilson_ci(5, 60) == pytest.approx((0.03612, 0.18069), abs=1e-5)
    # Newcombe (1998) Table I: 81/263 -> 0.2553 to 0.3662.
    assert stats.wilson_ci(81, 263) == pytest.approx((0.2553, 0.3662), abs=1e-4)


def test_wilson_edges_stay_inside_zero_one():
    low, high = stats.wilson_ci(0, 10)
    assert low == 0.0 and high == pytest.approx(0.2775, abs=1e-4)
    low, high = stats.wilson_ci(10, 10)
    assert high == 1.0 and low == pytest.approx(0.7225, abs=1e-4)
    assert stats.wilson_ci(0, 0) == (0.0, 1.0)
    assert stats.rate(0, 0)["rate"] is None
    with pytest.raises(ValueError):
        stats.wilson_ci(3, 2)


# ------------------------------------------------------------------ McNemar


def test_mcnemar_exact_known_values():
    # The recorded 7B C-TPMO-01 comparisons (v2 -> v3).
    assert stats.mcnemar_exact(2, 17)["p_value"] == pytest.approx(7.286e-4, rel=1e-3)  # development calls
    assert stats.mcnemar_exact(19, 0)["p_value"] == pytest.approx(3.815e-6, rel=1e-3)  # held-out calls
    # Symmetric in b and c; hand-computed: 2 * (1 + 10 + 45) / 2**10.
    assert stats.mcnemar_exact(8, 2)["p_value"] == stats.mcnemar_exact(2, 8)["p_value"] == pytest.approx(112 / 1024)


def test_mcnemar_without_discordant_pairs_is_no_evidence():
    out = stats.mcnemar_exact(0, 0)
    assert out["p_value"] == 1.0 and out["discordant"] == 0
    assert stats.mcnemar_exact(5, 5)["p_value"] == 1.0


def test_binomial_log_space_agrees_with_exact_integers():
    n, k = 1200, 560  # above the exact limit: the log-space path
    exact = 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    assert stats.binom_two_sided_half(k, n) == pytest.approx(exact, rel=1e-9)
    assert 0.0 <= stats.binom_two_sided_half(0, 5000) < 1e-300  # underflows cleanly, no OverflowError


# ------------------------------------------------------------------ Fisher


def test_fisher_exact_known_values():
    # Fisher's tea-tasting table: two-sided p = 34/70.
    assert stats.fisher_exact_2x2(3, 1, 1, 3)["p_value"] == pytest.approx(34 / 70)
    # scipy.stats.fisher_exact([[1, 9], [11, 3]]) -> 0.0027594561852200836
    assert stats.fisher_exact_2x2(1, 9, 11, 3)["p_value"] == pytest.approx(0.00275945618522, rel=1e-9)
    # In-sample 20/60 vs held-out 5/60 wrong verdicts for the 7B on v2.
    assert stats.fisher_exact_2x2(20, 40, 5, 55)["p_value"] == pytest.approx(0.0013085, rel=1e-4)
    assert stats.fisher_exact_2x2(0, 0, 0, 0)["p_value"] == 1.0
    assert stats.fisher_exact_2x2(0, 10, 0, 10)["p_value"] == 1.0


def test_holm_adjustment_is_monotone_and_ordered():
    assert stats.holm([0.01, 0.04, 0.03, None, 0.005]) == pytest.approx([0.03, 0.06, 0.06, None, 0.02])
    assert stats.holm([]) == []


def test_classifier_metrics_and_undefined_cells():
    m = stats.classifier_metrics(tp=6, fp=2, fn=2, tn=40)
    assert m["precision"]["rate"] == 0.75 and m["recall"]["rate"] == 0.75 and m["f1"] == pytest.approx(0.75)
    assert m["specificity"]["k"] == 40 and m["false_flag_rate"]["n"] == 42
    flags = stats.classifier_metrics(tp=0, fp=3, fn=0, tn=None)
    assert flags["specificity"] is None and flags["recall"]["rate"] is None and flags["f1"] == 0.0
    assert stats.classifier_metrics(0, 0, 0, 10)["f1"] is None


def test_compare_rates_verdicts():
    worse = stats.compare_rates(5, 60, 24, 60, {"both_pass": 36, "a_only_fail": 0, "b_only_fail": 19, "both_fail": 5})
    assert worse["direction"] == "worse" and worse["significant"]
    assert worse["verdict"].startswith("B is significantly worse on this contract (p=3.8e-06)")
    few = stats.compare_rates(1, 60, 2, 60, {"both_pass": 57, "a_only_fail": 1, "b_only_fail": 2, "both_fail": 0})
    assert few["verdict"] == "No significant difference (p=1.00, n=3 discordant pairs)"
    assert any("too few changed calls to conclude" in c for c in few["cautions"])
    unpaired = stats.compare_rates(20, 60, 5, 60, None)
    assert unpaired["test"] == "Fisher exact (two-sided)" and unpaired["direction"] == "better"
    assert unpaired["discordant"] is None


# ------------------------------------------------------------------ compare on hand-built cells


def _run(corpus_hash="c1", corpus="synthetic", prompt="p2", contract_set="cs"):
    return SimpleNamespace(corpus_hash=corpus_hash, stats={"corpus": corpus}, prompt_version_id=prompt,
                           contract_set_hash=contract_set)


def _cells(rows, not_evaluated=()):
    cells = _Cells()
    for t, c, sev, outcome in rows:
        cells.outcomes[(t, c)] = outcome
        cells.severity[c] = sev
    cells.not_evaluated = set(not_evaluated)
    return cells


def test_compare_statistics_paired_with_errors_and_unlabelled_cells():
    a = _cells([(f"T{i}", "C-X", "BLOCK", "PASS") for i in range(12)]
               + [("T0", "C-SUP", "FLAG", "FLAG"), ("T1", "C-SUP", "FLAG", "PASS"),
                  ("U1", "C-X", "BLOCK", "ERROR")],
               not_evaluated={("U1", "C-X")})
    # B fails ten calls A passed: two by ERROR (no output), eight by FAIL.
    b = _cells([(f"T{i}", "C-X", "BLOCK", "ERROR" if i < 2 else "FAIL" if i < 10 else "PASS") for i in range(12)]
               + [("T0", "C-SUP", "FLAG", "PASS"), ("T1", "C-SUP", "FLAG", "PASS"),
                  ("U1", "C-X", "BLOCK", "ERROR")],
               not_evaluated={("U1", "C-X")})
    out = _compare_statistics(_run(prompt="p2"), _run(prompt="p3"), a, b)
    assert out.mode == "paired" and "ERROR" in out.failure_definition
    x = next(r for r in out.per_contract if r.contract_code == "C-X")
    assert x.paired.model_dump() == {"both_pass": 2, "a_only_fail": 0, "b_only_fail": 10, "both_fail": 0}
    assert x.b.k == 10 and x.n_shared == 12, "ERROR counts as a failure; the unlabelled call is excluded"
    assert x.excluded_not_evaluated == 2  # one per run
    assert x.p_value == pytest.approx(2 / 2**10) and x.direction == "worse"
    assert x.verdict.startswith("B is significantly worse")
    sup = next(r for r in out.per_contract if r.contract_code == "C-SUP")
    assert sup.failure_outcomes == ["FAIL", "FLAG", "ERROR"] and sup.a.k == 1 and sup.b.k == 0
    assert any("too few changed calls" in c for c in sup.cautions)
    assert out.overall.contract_code == "ALL-BLOCK" and out.overall.b.k == 10
    assert any("development calls" in c for c in out.cautions), "tuned-set warning for a prompt change on dev"


def test_compare_statistics_unpaired_when_the_corpus_changed():
    a = _cells([(f"T{i}", "C-X", "BLOCK", "FAIL" if i < 20 else "PASS") for i in range(60)])
    b = _cells([(f"H{i}", "C-X", "BLOCK", "FAIL" if i < 5 else "PASS") for i in range(60)])
    out = _compare_statistics(_run("dev"), _run("held", "holdout", contract_set="other"), a, b)
    assert out.mode == "unpaired" and "paired test is invalid" in out.cautions[0]
    x = out.per_contract[0]
    assert x.paired is None and x.n_shared == 0 and x.test == "Fisher exact (two-sided)"
    assert x.p_value == pytest.approx(0.0013085, rel=1e-4) and x.direction == "better"
    assert any("contract sets differ" in c for c in out.overall.cautions)


def test_compare_holm_caution_when_only_raw_p_is_significant():
    rows_a, rows_b = [], []
    for code in ("C-A", "C-B", "C-C", "C-D"):
        rows_a += [(f"T{i}", code, "BLOCK", "PASS") for i in range(10)]
        rows_b += [(f"T{i}", code, "BLOCK", "FAIL" if (code == "C-A" and i < 6) else "PASS") for i in range(10)]
    out = _compare_statistics(_run(), _run(), _cells(rows_a), _cells(rows_b))
    first = out.per_contract[0]
    assert first.p_value == pytest.approx(2 / 64) and first.significant
    assert first.p_holm == pytest.approx(4 * 2 / 64)
    assert any("Holm" in c for c in first.cautions)


# ------------------------------------------------------------------ metrics on hand-built results


def _fake_run():
    return SimpleNamespace(id="r1", started_at=datetime(2026, 9, 25, tzinfo=UTC),
                           model=SimpleNamespace(model_id="m"), prompt_version=SimpleNamespace(version=2),
                           stats={"corpus": "synthetic"}, rule_date=date(2026, 10, 1), adapter="cassette")


def _judgment(expected, got, scenario, outcome=None, **extra):
    outcome = outcome or ("PASS" if expected == got else "FAIL")
    return outcome, {"expected": expected, "got": got, **extra}, "MA", {"scenario": scenario}


def test_judgment_confusion_matrix_is_exact():
    rows = (
        [_judgment(False, False, "B")] * 3  # TP: violations caught
        + [_judgment(False, True, "C")] * 4  # FN: every scenario-C violation missed
        + [_judgment(True, False, "A")] * 2  # FP: false flags
        + [_judgment(True, True, "A")] * 10  # TN
        + [("PASS", {"expected": True, "got": True, "not_applicable": "Medigap"}, "MEDIGAP", {"scenario": "I"})]
        + [("ERROR", {"error": "no valid output"}, "MA", {"scenario": "D"})]
        + [("ERROR", {"error": "no ground truth", "not_evaluated": True}, "MA", {"ingested": True})]
    )
    out = _run_metrics(_fake_run(), rows, "judgment", stats.failure_outcomes("BLOCK"))
    c = out.confusion
    assert (c.tp, c.fn, c.fp, c.tn) == (3, 4, 2, 10)
    assert (c.not_applicable, c.no_output, c.not_evaluated) == (1, 1, 1)
    assert c.recall.k == 3 and c.recall.n == 7 and c.precision.n == 5
    assert c.specificity.k == 10 and c.false_flag_rate.k == 2
    # Failure rate: 6 FAIL + 1 ERROR out of 21 scored cells; the unlabelled one is excluded.
    assert out.failure.k == 7 and out.failure.n == 21 and out.excluded_not_evaluated == 1
    assert out.outcomes == {"PASS": 14, "FAIL": 6, "ERROR": 2}
    sc = next(sl for sl in out.slices if sl.dimension == "scenario" and sl.value == "C")
    assert sc.fn == 4 and sc.tp == 0 and sc.notable and sc.summary.startswith("scenario C: 4/4 violations missed")
    assert out.findings[0].startswith("Missed 4 of 7 violations")
    assert "scenario C: 4/4 violations missed" in out.findings[1]
    assert {sl.value for sl in out.slices if sl.dimension == "product_line"} == {"MA", "MEDIGAP"}


def test_flag_metrics_count_phrases_and_have_no_true_negatives():
    rows = [
        ("FLAG", {"expected_flags": ["best plan", "lowest price"], "got_flags": ["best plan", "number one"]}, "MA",
         {"scenario": "F"}),
        ("PASS", {"expected_flags": [], "got_flags": []}, "MA", {"scenario": "A"}),
    ]
    out = _run_metrics(_fake_run(), rows, "flags", stats.failure_outcomes("FLAG"))
    c = out.confusion
    assert (c.tp, c.fp, c.fn, c.tn) == (1, 1, 1, None) and c.unit == "flagged phrase"
    assert c.specificity is None and out.failure.k == 1


def test_grounding_contracts_report_a_failure_rate_only():
    rows = [("FAIL", {}, "MA", {"scenario": "F"})] * 2 + [("PASS", {}, "MA", {"scenario": "A"})] * 18
    out = _run_metrics(_fake_run(), rows, "grounding", stats.failure_outcomes("BLOCK"))
    assert out.confusion is None and out.failure.k == 2 and out.failure.n == 20
    assert out.findings[0].startswith("Failed 2/20 (10%, 95% CI")
    f = next(sl for sl in out.slices if sl.value == "F")
    assert f.notable, "a slice whose whole CI sits above the overall rate is surfaced"
