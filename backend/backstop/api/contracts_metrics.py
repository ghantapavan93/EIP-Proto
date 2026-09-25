"""Per-contract metrics: how a model's verdicts compare with ground truth, and where it fails.

Everything here is read from stored results (RunResult.evidence carries expected/got);
no model is re-run. Contracts fall into four families:

  judgment  — C-TPMO-01, C-SOA-01: the model says compliant / non-compliant; ground
              truth says the same. A confusion matrix per call, positive = violation.
  flags     — C-SUP-01: the model flags superlative phrases; ground truth lists the
              phrases that must be flagged. A confusion matrix per flagged phrase
              (true negatives are not countable, so no specificity).
  grounding — schema, spans, facts, PII: pass/fail per call; failure rate with a CI.
  judged    — J-COACH-01: an advisory judge score; failure (FLAG) rate with a CI.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from backstop import schemas as s
from backstop.api.deps import SessionDep, UserDep
from backstop.core import stats
from backstop.models import Contract, ContractVersion, Run, RunResult, Transcript

router = APIRouter(tags=["contracts"])

FAMILIES: dict[str, Literal["judgment", "flags", "grounding", "judged"]] = {
    "disclaimer_judgment": "judgment",
    "soa_judgment": "judgment",
    "superlative_flags": "flags",
    "coaching_quality": "judged",
}
POSITIVE = {
    "judgment": ("A call whose ground truth is non-compliant under the rule in force (a violation). "
                 "TP = violation the model called non-compliant; FN = missed violation; "
                 "FP = compliant call the model called non-compliant (false flag)."),
    "flags": ("A superlative phrase ground truth says must be flagged. TP = flagged and should be; "
              "FN = should be flagged and was not; FP = flagged and should not be (exact phrase match, as the "
              "contract checks). True negatives are not countable per phrase."),
}
SLICE_DIMENSIONS = ("scenario", "product_line")


def _rate(k: int, n: int) -> s.RateOut:
    return s.RateOut(**stats.rate(k, n))


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.0%}"


def _ci(r: s.RateOut) -> str:
    return f"{r.ci_low:.0%}-{r.ci_high:.0%}"


@dataclass
class _Tally:
    n: int = 0
    failures: int = 0
    tp: int = 0
    fp: int = 0
    fn: int = 0
    tn: int = 0

    def add(self, failed: bool, cls: dict[str, int] | None) -> None:
        self.n += 1
        self.failures += failed
        for key, value in (cls or {}).items():
            setattr(self, key, getattr(self, key) + value)


@dataclass
class _RunAccumulator:
    outcomes: Counter = field(default_factory=Counter)
    total: _Tally = field(default_factory=_Tally)
    slices: dict[tuple[str, str], _Tally] = field(default_factory=dict)
    not_applicable: int = 0
    not_evaluated: int = 0
    no_output: int = 0


def _classify(family: str, outcome: str, evidence: dict[str, Any], acc: _RunAccumulator) -> dict[str, int] | None:
    """Confusion-matrix cell(s) for one result, or None when it cannot be classified."""
    if family not in ("judgment", "flags"):
        return None
    if outcome == "ERROR":
        acc.no_output += 1
        return None
    if family == "judgment":
        if evidence.get("not_applicable"):
            acc.not_applicable += 1
            return None
        expected, got = evidence.get("expected"), evidence.get("got")
        if not isinstance(expected, bool) or not isinstance(got, bool):
            acc.no_output += 1
            return None
        violation, called = not expected, not got
        key = ("tp" if called else "fn") if violation else ("fp" if called else "tn")
        return {key: 1}
    expected_flags = set(evidence.get("expected_flags") or [])
    got_flags = set(evidence.get("got_flags") or [])
    return {"tp": len(expected_flags & got_flags), "fp": len(got_flags - expected_flags),
            "fn": len(expected_flags - got_flags)}


def _slice_out(dimension: str, value: str, tally: _Tally, family: str, overall_rate: float | None) -> s.SliceOut:
    failure = _rate(tally.failures, tally.n)
    label = f"{dimension} {value}"
    classified = family in ("judgment", "flags")
    positives = tally.tp + tally.fn
    parts = []
    if classified and positives:
        parts.append(f"{tally.fn}/{positives} violations missed")
    if family == "judgment" and tally.fp + tally.tn:
        parts.append(f"{tally.fp}/{tally.fp + tally.tn} false flags")
    elif family == "flags" and tally.fp:
        parts.append(f"{tally.fp} false flag(s)")
    parts.append(f"{tally.failures}/{tally.n} failed")
    all_missed = classified and positives > 0 and tally.fn == positives
    above_overall = (tally.failures > 0 and overall_rate is not None and failure.ci_low > overall_rate)
    return s.SliceOut(
        dimension=dimension, value=value, n=tally.n, failure=failure,
        tp=tally.tp if classified else None, fp=tally.fp if classified else None,
        fn=tally.fn if classified else None, tn=tally.tn if family == "judgment" else None,
        summary=f"{label}: " + ", ".join(parts), notable=all_missed or above_overall,
    )


def _run_meta(run: Run) -> dict[str, Any]:
    return {"run_id": run.id, "started_at": run.started_at, "model_id": run.model.model_id,
            "prompt_version": run.prompt_version.version, "corpus": (run.stats or {}).get("corpus", "synthetic"),
            "rule_date": run.rule_date, "adapter": run.adapter}


def _run_metrics(run: Run, rows: list[Any], family: str, fails: tuple[str, ...]) -> s.RunContractMetricsOut:
    acc = _RunAccumulator()
    for outcome, evidence, product_line, labels in rows:
        evidence = evidence if isinstance(evidence, dict) else {}
        labels = labels if isinstance(labels, dict) else {}
        acc.outcomes[outcome] += 1
        if outcome == "ERROR" and evidence.get("not_evaluated"):
            acc.not_evaluated += 1
            continue
        failed = outcome in fails
        cls = _classify(family, outcome, evidence, acc)
        acc.total.add(failed, cls)
        values = {"scenario": labels.get("scenario") or "unlabelled",
                  "product_line": product_line or labels.get("product_line") or "unknown"}
        for dimension in SLICE_DIMENSIONS:
            acc.slices.setdefault((dimension, str(values[dimension])), _Tally()).add(failed, cls)

    failure = _rate(acc.total.failures, acc.total.n)
    confusion = None
    findings: list[str] = []
    if family in ("judgment", "flags"):
        t = acc.total
        m = stats.classifier_metrics(t.tp, t.fp, t.fn, t.tn if family == "judgment" else None)
        confusion = s.ConfusionOut(
            unit="call" if family == "judgment" else "flagged phrase", positive=POSITIVE[family],
            tp=t.tp, fp=t.fp, fn=t.fn, tn=t.tn if family == "judgment" else None,
            not_applicable=acc.not_applicable, not_evaluated=acc.not_evaluated, no_output=acc.no_output,
            precision=s.RateOut(**m["precision"]), recall=s.RateOut(**m["recall"]),
            specificity=s.RateOut(**m["specificity"]) if m["specificity"] else None,
            false_flag_rate=s.RateOut(**m["false_flag_rate"]) if m["false_flag_rate"] else None,
            miss_rate=s.RateOut(**m["miss_rate"]), f1=m["f1"],
        )
        recall = confusion.recall
        if t.tp + t.fn:
            headline = (f"Missed {t.fn} of {t.tp + t.fn} violations (recall {_pct(recall.rate)}, "
                        f"95% CI {_ci(recall)}); {t.fp} false flag(s)")
        else:
            headline = f"No violations in the ground truth; {t.fp} false flag(s)"
        if family == "judgment" and confusion.false_flag_rate is not None and t.fp + t.tn:
            headline += f" of {t.fp + t.tn} compliant calls ({_pct(confusion.false_flag_rate.rate)})"
        if acc.no_output:
            headline += f"; {acc.no_output} call(s) with no usable output"
        findings.append(headline)
    else:
        findings.append(f"Failed {acc.total.failures}/{acc.total.n} ({_pct(failure.rate)}, 95% CI {_ci(failure)})")

    order = {d: i for i, d in enumerate(SLICE_DIMENSIONS)}
    slices = [_slice_out(dim, value, tally, family, failure.rate)
              for (dim, value), tally in sorted(acc.slices.items(), key=lambda kv: (order[kv[0][0]], kv[0][1]))]
    findings += [sl.summary for sl in sorted((x for x in slices if x.notable),
                                             key=lambda x: (order[x.dimension], -(x.fn or 0), -x.failure.k))]
    return s.RunContractMetricsOut(
        **_run_meta(run), outcomes=dict(acc.outcomes), failure=failure, excluded_not_evaluated=acc.not_evaluated,
        confusion=confusion, slices=slices, findings=findings,
    )


def _latest_per_config(session, corpus: str, rule_date: date | None) -> list[Run]:
    """Latest COMPLETE run per (model, prompt version) on one corpus, newest first."""
    q = (select(Run).options(selectinload(Run.model), selectinload(Run.prompt_version))
         .where(Run.status == "COMPLETE").order_by(Run.started_at.desc()))
    if rule_date is not None:
        q = q.where(Run.rule_date == rule_date)
    picked: dict[tuple[str, str], Run] = {}
    for run in session.scalars(q):
        if (run.stats or {}).get("corpus", "synthetic") != corpus:
            continue
        picked.setdefault((run.model_id, run.prompt_version_id), run)
    return list(picked.values())


def _trend(session, contract: Contract, version_ids, limit: int) -> list[s.TrendPointOut]:
    counts: dict[str, Counter] = {}
    for run_id, outcome, n in session.execute(
            select(RunResult.run_id, RunResult.outcome, func.count())
            .where(RunResult.contract_version_id.in_(version_ids))
            .group_by(RunResult.run_id, RunResult.outcome)):
        counts.setdefault(run_id, Counter())[outcome] += n
    if not counts:
        return []
    not_evaluated: Counter = Counter()
    for run_id, evidence in session.execute(
            select(RunResult.run_id, RunResult.evidence)
            .where(RunResult.contract_version_id.in_(version_ids), RunResult.outcome == "ERROR")):
        if isinstance(evidence, dict) and evidence.get("not_evaluated"):
            not_evaluated[run_id] += 1
    runs = session.scalars(
        select(Run).options(selectinload(Run.model), selectinload(Run.prompt_version))
        .where(Run.id.in_(list(counts)), Run.status == "COMPLETE")
        .order_by(Run.started_at.desc()).limit(limit)).all()
    fails = stats.failure_outcomes(contract.severity)
    points = []
    for run in reversed(runs):  # oldest first
        c = counts[run.id]
        n = sum(c.values()) - not_evaluated[run.id]
        k = sum(c[o] for o in fails) - not_evaluated[run.id]  # not_evaluated cells are ERRORs
        points.append(s.TrendPointOut(**_run_meta(run), failure=_rate(k, n)))
    return points


@router.get("/contracts/{code}/metrics", response_model=s.ContractMetricsOut)
def contract_metrics(code: str, session: SessionDep, user: UserDep, run_id: str | None = None,
                     corpus: Literal["synthetic", "holdout", "ingested", "all"] = Query("synthetic"),
                     rule_date: date | None = None, trend_limit: int = Query(50, ge=1, le=500)):
    """Confusion matrix, precision/recall with Wilson CIs, per-scenario slices, and a trend.

    With run_id: that run. Without: the latest COMPLETE run per model and prompt version
    on `corpus` (default: the development calls), optionally at one rule date.
    """
    contract = session.scalar(select(Contract).where(Contract.code == code))
    if contract is None:
        raise HTTPException(404, "contract not found")
    version_ids = list(session.scalars(select(ContractVersion.id).where(ContractVersion.contract_id == contract.id)))
    if run_id is not None:
        run = session.get(Run, run_id)
        if run is None:
            raise HTTPException(404, "run not found")
        runs = [run]
        selection = f"run {run_id}"
    else:
        runs = _latest_per_config(session, corpus, rule_date)
        selection = (f"latest COMPLETE run per model and prompt version on corpus={corpus}"
                     + (f" at rule date {rule_date.isoformat()}" if rule_date else ""))

    rows_by_run: dict[str, list[Any]] = {r.id: [] for r in runs}
    if runs and version_ids:
        for run_id_, outcome, evidence, product_line, labels in session.execute(
                select(RunResult.run_id, RunResult.outcome, RunResult.evidence, Transcript.product_line,
                       Transcript.labels)
                .join(Transcript, RunResult.transcript_id == Transcript.id)
                .where(RunResult.run_id.in_(list(rows_by_run)), RunResult.contract_version_id.in_(version_ids))):
            rows_by_run[run_id_].append((outcome, evidence, product_line, labels))

    family = FAMILIES.get(contract.check, "grounding")
    fails = stats.failure_outcomes(contract.severity)
    return s.ContractMetricsOut(
        contract_code=contract.code, title=contract.title, kind=contract.kind, severity=contract.severity,
        check=contract.check, metric_family=family, failure_definition=stats.FAILURE_DEFINITION,
        positive_definition=POSITIVE.get(family), selection=selection,
        runs=[_run_metrics(r, rows_by_run[r.id], family, fails) for r in runs],
        trend=_trend(session, contract, version_ids, trend_limit),
    )
