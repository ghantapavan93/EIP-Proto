"""Matcher evaluation against the labeled golden set.

Answers "what is your false-positive rate?" with numbers instead of adjectives.
Precision-first: a false positive costs a reviewer a click; a false negative is
covered by the LLM proposer and by the next human who reads the artifact.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from backstop.scanner import matchers


@dataclass
class CaseResult:
    id: str
    text: str
    expected: set[tuple[str, int]]
    detected: set[tuple[str, int]]
    detected_status: dict[tuple[str, int], str]
    true_positive: set[tuple[str, int]] = field(default_factory=set)
    false_positive: set[tuple[str, int]] = field(default_factory=set)
    false_negative: set[tuple[str, int]] = field(default_factory=set)
    known_limitation: bool = False
    gap: str = ""
    # Detections whose (rule, version) was expected but whose status was not (e.g. an
    # incomplete disclaimer tagged "confirmed" where a human read was expected).
    wrong_status: set[tuple[str, int]] = field(default_factory=set)


@dataclass
class EvalReport:
    cases: list[CaseResult]
    tp: int
    fp: int
    fn: int
    precision: float
    recall: float
    per_rule: dict[str, dict[str, float | int]]
    known_limitations: int

    def to_dict(self) -> dict:
        return {
            "summary": {"cases": len(self.cases), "tp": self.tp, "fp": self.fp, "fn": self.fn,
                        "precision": round(self.precision, 3), "recall": round(self.recall, 3),
                        "known_limitations": self.known_limitations,
                        "suite": "Golden Matcher Suite",
                        "metric_scope": "fixture",
                        "disclaimer": ("Hand-authored regression fixtures. Not an estimate of production "
                                       "accuracy: the cases were written by the same person who wrote the "
                                       "matchers, so they catch regressions, not unknown unknowns."),
                        "positives": sum(1 for c in self.cases if c.expected),
                        "negatives": sum(1 for c in self.cases if not c.expected)},
            "per_rule": self.per_rule,
            "cases": [
                {"id": c.id, "text": c.text, "expected": sorted(c.expected), "detected": sorted(c.detected),
                 "detected_status": {f"{k[0]}@{k[1]}": v for k, v in c.detected_status.items()},
                 "false_positive": sorted(c.false_positive), "false_negative": sorted(c.false_negative),
                 "known_limitation": c.known_limitation, "gap": c.gap,
                 "wrong_status": sorted(c.wrong_status)}
                for c in self.cases
            ],
        }


def evaluate(golden_path: Path) -> EvalReport:
    doc = yaml.safe_load(golden_path.read_text(encoding="utf-8"))
    cases: list[CaseResult] = []
    per_rule: dict[str, dict[str, int]] = {}
    for case in doc["cases"]:
        expected = {(e["rule"], int(e["version"])) for e in case.get("expect", [])}
        # Optional status expectation: `status: proposed|confirmed` (`proposed: true` is the old spelling).
        expected_status = {
            (e["rule"], int(e["version"])): e.get("status") or ("proposed" if e.get("proposed") else None)
            for e in case.get("expect", [])
        }
        hits = matchers.run_all(case["text"])
        detected = {(h.rule_code, h.version) for h in hits}
        status = {(h.rule_code, h.version): h.status for h in hits}
        # Right edge, wrong status counts as both a false positive and a false negative:
        # "confirmed current" on an incomplete disclaimer is exactly the false green to catch.
        wrong_status = {k for k in expected & detected if expected_status.get(k) and status[k] != expected_status[k]}
        # Known limitations: a near-miss case that still expects an edge (the matcher fires on
        # context the golden set deliberately stresses), or a case marked `known_limitation`
        # (e.g. a real quote no encoded rule covers yet; `gap` says what is missing).
        known_limitation = bool(case.get("known_limitation")) or (case["id"].endswith("near-miss") and bool(expected))
        cr = CaseResult(
            id=case["id"], text=case["text"], expected=expected, detected=detected, detected_status=status,
            true_positive=(expected & detected) - wrong_status,
            false_positive=(detected - expected) | wrong_status,
            false_negative=(expected - detected) | wrong_status,
            known_limitation=known_limitation, gap=str(case.get("gap") or ""), wrong_status=wrong_status,
        )
        cases.append(cr)
        for rule, _ in expected | detected:
            per_rule.setdefault(rule, {"tp": 0, "fp": 0, "fn": 0})
        for rule, _ in cr.true_positive:
            per_rule[rule]["tp"] += 1
        for rule, _ in cr.false_positive:
            per_rule[rule]["fp"] += 1
        for rule, _ in cr.false_negative:
            per_rule[rule]["fn"] += 1
    tp = sum(len(c.true_positive) for c in cases)
    fp = sum(len(c.false_positive) for c in cases)
    fn = sum(len(c.false_negative) for c in cases)
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    per_rule_out: dict[str, dict[str, float | int]] = {}
    for rule, b in sorted(per_rule.items()):
        p = b["tp"] / (b["tp"] + b["fp"]) if b["tp"] + b["fp"] else 1.0
        r = b["tp"] / (b["tp"] + b["fn"]) if b["tp"] + b["fn"] else 1.0
        per_rule_out[rule] = {**b, "precision": round(p, 3), "recall": round(r, 3)}
    return EvalReport(cases=cases, tp=tp, fp=fp, fn=fn, precision=precision, recall=recall,
                      per_rule=per_rule_out, known_limitations=sum(1 for c in cases if c.known_limitation))


def render_markdown(report: EvalReport, golden_path: Path) -> str:
    lines = [
        "# Golden Matcher Suite",
        "",
        f"Fixtures: `{golden_path.name}` · {len(report.cases)} curated cases · generated by `backstop eval-matchers`.",
        "",
        "> **Hand-authored regression fixtures. Not an estimate of production accuracy.** The cases",
        "> were written by the author of the matchers; they catch regressions, not unknown unknowns.",
        "> A production estimate needs a labeled sample of EIP's real artifacts.",
        "",
        "Precision-first by design: a false positive costs a reviewer one click; a false negative is",
        "covered by the LLM proposer and by the next human who reads the artifact. Cases whose ids end",
        "in `near-miss` but still expect an edge are *documented known limitations* — the matcher fires",
        "on context words the golden set deliberately stresses.",
        "",
        "## Summary",
        "",
        "| cases | TP | FP | FN | fixture precision | fixture recall | known limitations |",
        "|---|---|---|---|---|---|---|",
        f"| {len(report.cases)} | {report.tp} | {report.fp} | {report.fn} | **{report.precision:.3f}** | **{report.recall:.3f}** | {report.known_limitations} |",
        "",
        "## Per rule",
        "",
        "| rule | TP | FP | FN | precision | recall |",
        "|---|---|---|---|---|---|",
    ]
    for rule, b in report.per_rule.items():
        lines.append(f"| `{rule}` | {b['tp']} | {b['fp']} | {b['fn']} | {b['precision']:.3f} | {b['recall']:.3f} |")
    lines += ["", "## Misses and false positives", ""]
    problems = [c for c in report.cases if c.false_positive or c.false_negative]
    if not problems:
        lines.append("None.")
    for c in problems:
        kind = "FP" if c.false_positive else "FN"
        tag = " *(documented known limitation)*" if c.known_limitation else ""
        lines.append(f"- **{c.id}** [{kind}]{tag} — \"{c.text}\"")
        if c.false_positive:
            lines.append(f"  - detected but not expected: {sorted(c.false_positive)}")
        if c.wrong_status:
            lines.append(f"  - right edge, wrong status: {sorted(c.wrong_status)}")
        if c.false_negative:
            lines.append(f"  - expected but not detected: {sorted(c.false_negative)}")
    gaps = [c for c in report.cases if c.gap]
    if gaps:
        lines += ["", "## Known limitations: real quotes no matcher covers", "",
                  "Kept in the suite so the gap stays visible. They expect no edge from today's rules, so",
                  "they do not move precision or recall; each says what would be needed to catch it.", ""]
        for c in gaps:
            lines.append(f"- **{c.id}**: \"{c.text}\"")
            lines.append(f"  - {c.gap}")
    lines += ["", "## Proposed-only detections", ""]
    proposed = [(c.id, k) for c in report.cases for k, s in c.detected_status.items() if s == "proposed"]
    if not proposed:
        lines.append("None.")
    for cid, key in proposed:
        lines.append(f"- {cid}: `{key[0]}@{key[1]}` proposed for human review")
    lines.append("")
    return "\n".join(lines)
