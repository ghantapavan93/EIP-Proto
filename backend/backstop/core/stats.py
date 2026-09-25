"""Small, exact statistics for comparing runs. Pure Python; no scipy.

Every function returns plain numbers or dicts so API code can serialize them
directly. Tests pin the known values (e.g. McNemar b=2, c=17 -> p = 0.00073).

Conventions
-----------
* Rates are failure rates: k failures out of n scored cells.
* Confidence intervals are Wilson score intervals (95% by default). They behave
  at k = 0 and k = n, where the normal approximation collapses to a point.
* McNemar is the exact two-sided binomial test on the discordant pairs of a
  paired table (same calls scored by two runs). It is exact at every n.
* Fisher's exact test is for two independent draws (different calls), where a
  paired test is invalid.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

ALPHA = 0.05
# Below this many discordant pairs a comparison can hardly show anything; say so.
MIN_DISCORDANT = 10
# Exact integer arithmetic up to this many trials; log-space above it.
_EXACT_LIMIT = 1000
_REL_TOL = 1e-7  # ties in Fisher's two-sided sum


FAILURE_DEFINITION = (
    "A cell fails when its outcome is FAIL or ERROR on a BLOCK contract, or FAIL, FLAG or ERROR on a "
    "FLAG contract. ERROR (no usable model output) counts as a failure: a release cannot ship an output "
    "it does not have. Unlabelled ingested cells (ERROR marked not_evaluated) are neither: they are "
    "excluded and counted as excluded_not_evaluated. Verdicts are raw; approved overrides are not applied."
)


def failure_outcomes(severity: str) -> tuple[str, ...]:
    """Outcomes that count as a failure for a contract of this severity."""
    return ("FAIL", "ERROR") if severity == "BLOCK" else ("FAIL", "FLAG", "ERROR")


# ------------------------------------------------------------------ intervals


def wilson_ci(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion k/n. (0, 1) when n == 0."""
    if n < 0 or k < 0 or k > n:
        raise ValueError(f"need 0 <= k <= n, got k={k}, n={n}")
    if n == 0:
        return 0.0, 1.0
    p = k / n
    z2 = z * z
    denom = 1 + z2 / n
    centre = (p + z2 / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def rate(k: int, n: int, z: float = 1.96) -> dict[str, Any]:
    """k/n with its Wilson interval, as a plain dict. rate is None when n == 0."""
    low, high = wilson_ci(k, n, z)
    return {"k": k, "n": n, "rate": (k / n) if n else None, "ci_low": low, "ci_high": high}


# ------------------------------------------------------------------ tests


def _log_comb(n: int, k: int) -> float:
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def _logsumexp(values: Sequence[float]) -> float:
    top = max(values)
    if top == -math.inf:
        return top
    return top + math.log(sum(math.exp(v - top) for v in values))


def binom_two_sided_half(k: int, n: int) -> float:
    """Two-sided exact binomial p for k successes in n trials with p = 0.5.

    For p = 0.5 the distribution is symmetric, so the two-sided p is twice the
    smaller tail, capped at 1.
    """
    if n == 0:
        return 1.0
    k = min(k, n - k)
    if n <= _EXACT_LIMIT:
        tail = sum(math.comb(n, i) for i in range(k + 1))
        return min(1.0, 2 * tail / 2**n)  # int / int is correctly rounded for big ints
    log_tail = _logsumexp([_log_comb(n, i) for i in range(k + 1)]) - n * math.log(2)
    return min(1.0, 2 * math.exp(log_tail))


def mcnemar_exact(b: int, c: int) -> dict[str, Any]:
    """Exact two-sided McNemar test on discordant pairs b and c.

    b and c are the two off-diagonal cells of a paired 2x2 table (for runs A and
    B on the same calls: b = failed only in B, c = failed only in A). Under the
    null each discordant pair is equally likely to go either way, so the test is
    a binomial(b + c, 0.5). No discordant pairs means no evidence: p = 1.
    """
    if b < 0 or c < 0:
        raise ValueError("discordant counts must be non-negative")
    n = b + c
    return {"b": b, "c": c, "discordant": n, "p_value": binom_two_sided_half(min(b, c), n),
            "test": "McNemar exact (two-sided binomial on discordant pairs, p=0.5)"}


def fisher_exact_2x2(a: int, b: int, c: int, d: int) -> dict[str, Any]:
    """Two-sided Fisher exact test for the table [[a, b], [c, d]].

    Rows are the two draws (e.g. run A, run B); columns are (fail, pass). The
    two-sided p sums every table with the same margins that is no more likely
    than the observed one (the usual "minimum likelihood" definition, as in
    scipy.stats.fisher_exact and R's fisher.test).
    """
    if min(a, b, c, d) < 0:
        raise ValueError("cell counts must be non-negative")
    row1, row2, col1 = a + b, c + d, a + c
    total = row1 + row2
    lo, hi = max(0, col1 - row2), min(row1, col1)
    if total == 0 or lo == hi:
        p = 1.0
    else:
        log_denominator = _log_comb(total, col1)

        def log_p(x: int) -> float:
            return _log_comb(row1, x) + _log_comb(row2, col1 - x) - log_denominator

        observed = log_p(a)
        threshold = observed + math.log1p(_REL_TOL)
        logs = [lp for x in range(lo, hi + 1) if (lp := log_p(x)) <= threshold]
        p = min(1.0, math.exp(_logsumexp(logs)))
    if b * c == 0:
        odds_ratio = math.inf if a * d > 0 else (0.0 if b * c > 0 else math.nan)
    else:
        odds_ratio = (a * d) / (b * c)
    return {"table": [[a, b], [c, d]], "odds_ratio": odds_ratio, "p_value": p,
            "test": "Fisher exact (two-sided)"}


def holm(p_values: Sequence[float | None]) -> list[float | None]:
    """Holm-Bonferroni adjusted p-values, in the input order. None entries are skipped."""
    indexed = sorted(((p, i) for i, p in enumerate(p_values) if p is not None))
    m = len(indexed)
    adjusted: list[float | None] = [None] * len(p_values)
    running = 0.0
    for rank, (p, i) in enumerate(indexed):
        running = max(running, min(1.0, (m - rank) * p))
        adjusted[i] = running
    return adjusted


# ------------------------------------------------------------------ classifier metrics


def classifier_metrics(tp: int, fp: int, fn: int, tn: int | None, z: float = 1.96) -> dict[str, Any]:
    """Precision, recall (sensitivity), specificity and F1, each rate with a Wilson CI.

    tn may be None when true negatives are not countable (e.g. per-phrase flags);
    specificity and the false-flag rate are then None.
    """
    out: dict[str, Any] = {
        "precision": rate(tp, tp + fp, z),
        "recall": rate(tp, tp + fn, z),
        "specificity": rate(tn, tn + fp, z) if tn is not None else None,
        "false_flag_rate": rate(fp, tn + fp, z) if tn is not None else None,
        "miss_rate": rate(fn, tp + fn, z),
    }
    precision, recall = out["precision"]["rate"], out["recall"]["rate"]
    if precision is None or recall is None or precision + recall == 0:
        out["f1"] = None if (tp + fp + fn) == 0 else 0.0
    else:
        out["f1"] = 2 * precision * recall / (precision + recall)
    return out


# ------------------------------------------------------------------ run comparison


def paired_table(pairs: Iterable[tuple[bool, bool]]) -> dict[str, int]:
    """Count (a_failed, b_failed) pairs into the four cells of a paired table."""
    table = {"both_pass": 0, "a_only_fail": 0, "b_only_fail": 0, "both_fail": 0}
    for a_failed, b_failed in pairs:
        if a_failed and b_failed:
            table["both_fail"] += 1
        elif a_failed:
            table["a_only_fail"] += 1
        elif b_failed:
            table["b_only_fail"] += 1
        else:
            table["both_pass"] += 1
    return table


def fmt_p(p: float | None) -> str:
    if p is None:
        return "n/a"
    if p < 0.0001:
        return f"{p:.1e}"
    if p < 0.001:
        return f"{p:.5f}"
    return f"{p:.3f}" if p < 0.1 else f"{p:.2f}"


def compare_rates(a_fail: int, a_n: int, b_fail: int, b_n: int,
                  paired: Mapping[str, int] | None, *, alpha: float = ALPHA,
                  what: str = "this contract") -> dict[str, Any]:
    """Compare failure rates of runs A and B and phrase a verdict.

    With a paired table (same calls in both runs) the test is exact McNemar on
    the discordant pairs; without one (different calls) it is Fisher exact on
    the two rates, and the result says so.
    """
    cautions: list[str] = []
    if paired is not None:
        b_disc, c_disc = paired["b_only_fail"], paired["a_only_fail"]
        test = mcnemar_exact(b_disc, c_disc)
        p = test["p_value"]
        discordant = b_disc + c_disc
        worse = b_disc > c_disc
        if discordant < MIN_DISCORDANT:
            cautions.append(f"Only {discordant} call(s) changed outcome: too few changed calls to conclude.")
    else:
        test = fisher_exact_2x2(a_fail, a_n - a_fail, b_fail, b_n - b_fail)
        p = test["p_value"]
        discordant = None
        worse = (b_fail / b_n if b_n else 0.0) > (a_fail / a_n if a_n else 0.0)
    significant = p < alpha and (discordant is None or discordant > 0)
    if significant:
        direction = "worse" if worse else "better"
        verdict = f"B is significantly {direction} on {what} (p={fmt_p(p)})"
    else:
        direction = "none"
        tail = f"n={discordant} discordant pairs" if discordant is not None else f"n={a_n} vs {b_n} cells"
        verdict = f"No significant difference (p={fmt_p(p)}, {tail})"
    return {"a": rate(a_fail, a_n), "b": rate(b_fail, b_n), "discordant": discordant,
            "test": test["test"], "p_value": p, "significant": significant, "direction": direction,
            "verdict": verdict, "cautions": cautions}
