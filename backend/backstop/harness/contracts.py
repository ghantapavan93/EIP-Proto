"""Contract checks.

Every check is a pure function of (validated output | raw, transcript text,
labels, rule logic, spec) and returns a Verdict with evidence a reviewer can
read. Checks never call a model except `coaching_quality`, which is JUDGED,
advisory, and reports its variance.
"""

from __future__ import annotations

import math
import re
import statistics
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from backstop.harness import workflow as wf

_WS = re.compile(r"\s+")
# "$3,400", "$3400", "$0", "$12.50" — but never a trailing comma or period.
_MONEY = re.compile(r"\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?![\d,])")
_MBI_LIKE = re.compile(r"\b[1-9][A-Z][A-Z0-9]\d-?[A-Z][A-Z0-9]\d-?[A-Z]{2}\d{2}\b")
_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_DOB = re.compile(r"\b(0?[1-9]|1[0-2])/(0?[1-9]|[12]\d|3[01])/(19|20)\d{2}\b")


@dataclass
class Verdict:
    outcome: str  # PASS | FAIL | FLAG | ERROR
    evidence: dict[str, Any] = field(default_factory=dict)


def _norm(s: str) -> str:
    return _WS.sub(" ", s).strip().lower()


def _in_transcript(span: str | None, transcript: str) -> bool:
    if not span:
        return True
    return _norm(span) in _norm(transcript)


# ------------------------------------------------------------------ checks


def schema_valid(ctx: CheckContext) -> Verdict:
    if ctx.output is None:
        if not ctx.raw:
            # The adapter produced nothing (timeout, refusal, unsupported input): that is an
            # ERROR to investigate, not a schema violation by the model.
            return Verdict("ERROR", {"error": ctx.validation_error or "adapter returned no output"})
        return Verdict("FAIL", {"error": ctx.validation_error or "invalid output", "raw_keys": sorted(ctx.raw.keys())})
    return Verdict("PASS", {"fields": len(ctx.output.extraction.model_dump())})


def spans_verbatim(ctx: CheckContext) -> Verdict:
    if ctx.output is None:
        return Verdict("ERROR", {"error": "no valid output"})
    ex = ctx.output.extraction
    checked = {
        "disclaimer_span": ex.disclaimer_span,
        "benefits_span": ex.benefits_span,
        "soa_span": ex.soa_span,
        **{f"superlative[{i}]": s.text for i, s in enumerate(ex.superlatives)},
    }
    missing = {k: v for k, v in checked.items() if v and not _in_transcript(v, ctx.transcript)}
    if missing:
        return Verdict("FAIL", {"not_in_transcript": missing, "checked": len(checked)})
    return Verdict("PASS", {"checked": len([v for v in checked.values() if v])})


def numbers_grounded(ctx: CheckContext) -> Verdict:
    if ctx.output is None:
        return Verdict("ERROR", {"error": "no valid output"})
    summary = ctx.output.composition.summary

    def canon(value: str) -> str:
        return value.replace(" ", "").replace(",", "")

    figures = {canon(m.group(0)) for m in _MONEY.finditer(summary)}
    transcript_figures = {canon(m.group(0)) for m in _MONEY.finditer(ctx.transcript)}
    invented = sorted(f for f in figures if f not in transcript_figures)
    if invented:
        return Verdict("FAIL", {"invented_figures": invented, "summary_figures": sorted(figures),
                                "transcript_figures": sorted(transcript_figures)})
    return Verdict("PASS", {"summary_figures": sorted(figures)})


def pii_redacted(ctx: CheckContext) -> Verdict:
    if ctx.output is None:
        return Verdict("ERROR", {"error": "no valid output"})
    comp = ctx.output.composition
    prose = " ".join([comp.summary, comp.coaching_note, str(comp.crm_record)])
    hits: dict[str, list[str]] = {}
    for label, pattern in (("medicare_number", _MBI_LIKE), ("ssn", _SSN), ("dob", _DOB)):
        found = pattern.findall(prose)
        if found:
            hits[label] = [f if isinstance(f, str) else "".join(f) for f in found][:3]
    # Known PII values from labels must not appear either (belt and braces).
    for item in ctx.labels.get("pii", []):
        if item.get("value") and item["value"] in prose:
            hits.setdefault(item["type"], []).append("[known value present]")
    if hits:
        return Verdict("FAIL", {"pii_in_output": hits})
    return Verdict("PASS", {"pii_types_reported": ctx.output.extraction.pii_detected})


def _no_ground_truth(ctx: CheckContext) -> Verdict | None:
    """Ingested (real, unlabeled) transcripts cannot be judged against ground truth. Say so."""
    if ctx.labels.get("ingested") and ctx.labels.get("ground_truth") is None:
        return Verdict("ERROR", {"error": "no ground truth for ingested transcript; label it or review manually",
                                 "not_evaluated": True,
                                 "model_says": {k: v for k, v in (ctx.output.extraction.model_dump().items() if ctx.output else [])
                                                if k in ("disclaimer_compliant", "soa_wait_compliant", "disclaimer_basis")}})
    return None


def disclaimer_judgment(ctx: CheckContext) -> Verdict:
    if ctx.output is None:
        return Verdict("ERROR", {"error": "no valid output"})
    if (ngt := _no_ground_truth(ctx)) is not None:
        return ngt
    expected, basis = wf.truth_disclaimer_compliant(ctx.labels, ctx.logic)
    got = ctx.output.extraction.disclaimer_compliant
    evidence = {
        "expected": expected,
        "got": got,
        "truth_basis": basis,
        "model_basis": ctx.output.extraction.disclaimer_basis,
        "rule_logic": {"basis": ctx.logic["disclaimer_basis"], "window_seconds": ctx.logic["disclaimer_window_seconds"]},
        "disclaimer_seconds": ctx.labels.get("disclaimer_seconds"),
        "benefits_started_seconds": ctx.labels.get("benefits_started_seconds"),
        "model_disclaimer_seconds": ctx.output.extraction.disclaimer_seconds,
    }
    if ctx.labels.get("product_line") == "MEDIGAP":
        evidence["not_applicable"] = "Medigap — TPMO disclaimer rules do not apply"
        return Verdict("PASS", evidence)
    if expected != got:
        evidence["direction"] = "over_restrictive (false flag)" if (expected and not got) else "under_restrictive (missed violation)"
        return Verdict("FAIL", evidence)
    return Verdict("PASS", evidence)


def soa_judgment(ctx: CheckContext) -> Verdict:
    if ctx.output is None:
        return Verdict("ERROR", {"error": "no valid output"})
    if (ngt := _no_ground_truth(ctx)) is not None:
        return ngt
    expected, basis = wf.truth_soa_wait_compliant(ctx.labels, ctx.logic)
    got = ctx.output.extraction.soa_wait_compliant
    evidence = {
        "expected": expected,
        "got": got,
        "truth_basis": basis,
        "rule_logic": {"min_hours": ctx.logic["soa_min_hours"]},
        "appointment_hours_after_soa": ctx.labels.get("appointment_hours_after_soa"),
        "soa_exception": ctx.labels.get("soa_exception"),
    }
    if ctx.labels.get("product_line") == "MEDIGAP":
        evidence["not_applicable"] = "Medigap"
        return Verdict("PASS", evidence)
    if expected != got:
        evidence["direction"] = "over_restrictive (false flag)" if (expected and not got) else "under_restrictive (missed violation)"
        return Verdict("FAIL", evidence)
    return Verdict("PASS", evidence)


def superlative_flags(ctx: CheckContext) -> Verdict:
    if ctx.output is None:
        return Verdict("ERROR", {"error": "no valid output"})
    if (ngt := _no_ground_truth(ctx)) is not None:
        return ngt
    expected = set(wf.truth_superlative_flags(ctx.labels, ctx.logic))
    got = {s.text for s in ctx.output.extraction.superlatives if s.flagged}
    evidence = {"expected_flags": sorted(expected), "got_flags": sorted(got),
                "substantiation_required": ctx.logic["superlatives_substantiation_required"]}
    if expected != got:
        return Verdict("FLAG", evidence)
    return Verdict("PASS", evidence)


def coaching_quality(ctx: CheckContext) -> Verdict:
    if ctx.output is None:
        return Verdict("ERROR", {"error": "no valid output"})
    n = int(ctx.spec.get("n_runs") or 5)
    rubric = ctx.spec.get("rubric", "Score the coaching note from 1 to 5.")
    scores, meta = ctx.adapter.judge(rubric, ctx.output.composition.coaching_note, ctx.transcript, ctx.transcript_code, n)
    clean = [s for s in scores if not (isinstance(s, float) and math.isnan(s))]
    if not clean:
        return Verdict("ERROR", {"error": "judge returned no scores", "meta": meta})
    mean = statistics.fmean(clean)
    variance = statistics.pvariance(clean) if len(clean) > 1 else 0.0
    threshold = float(ctx.spec.get("threshold", 3.0))
    evidence = {"scores": clean, "n": len(clean), "mean": round(mean, 2), "variance": round(variance, 3),
                "threshold": threshold, "judge": meta, "advisory": True}
    return Verdict("FLAG" if mean < threshold else "PASS", evidence)


@dataclass
class CheckContext:
    raw: dict[str, Any]
    output: wf.WorkflowOutput | None
    validation_error: str | None
    transcript: str
    transcript_code: str
    labels: dict[str, Any]
    logic: dict[str, Any]
    spec: dict[str, Any]
    adapter: Any


REGISTRY: dict[str, Callable[[CheckContext], Verdict]] = {
    "schema_valid": schema_valid,
    "spans_verbatim": spans_verbatim,
    "numbers_grounded": numbers_grounded,
    "pii_redacted": pii_redacted,
    "disclaimer_judgment": disclaimer_judgment,
    "soa_judgment": soa_judgment,
    "superlative_flags": superlative_flags,
    "coaching_quality": coaching_quality,
}
