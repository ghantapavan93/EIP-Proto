"""Attribution: can a difference between two runs be pinned on one change?

A comparison is only as good as its isolation. Two runs may differ in the prompt,
the model (or how it was executed), the rule date, the calls scored, the contract
set, the judge policy and the approved overrides in force. When exactly one of
those differs, every difference in the results is attributable to it (subject to
the significance test). When two or more differ, the comparison is confounded:
the numbers are still true, but no single change can be credited or blamed.

For a confounded pair this module also searches the runs that already exist for
pairs that change one factor at a time, so a reviewer is pointed at a clean
comparison instead of being left with a caveat.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from backstop.models import Run

# Not fingerprinted yet (documented in docs/honesty.md): generation settings (temperature,
# max tokens, tool vs JSON mode), the simulated defect profile, the Ollama model digest,
# and which approved overrides are in scope (only their number is compared).

# Order is the order a reader scans them in: what was asked, of whom, under which rules, on what.
FACTORS: tuple[str, ...] = ("prompt", "model", "rule_date", "corpus", "contract_set", "judge", "overrides")

LABELS: dict[str, str] = {
    "prompt": "prompt",
    "model": "model",
    "rule_date": "rule date",
    "corpus": "calls scored",
    "contract_set": "contract set",
    "judge": "judge",
    "overrides": "approved overrides",
}

# Factors that reach only the judged (advisory) contracts; a change confined to them
# leaves the deterministic, release-blocking verdicts attributable to the other change.
JUDGED_ONLY: frozenset[str] = frozenset({"judge"})


@dataclass(frozen=True)
class RunFactors:
    """The value of every factor for one run: `key` is compared, `display` is shown."""

    run_id: str
    key: dict[str, str]
    display: dict[str, str]


def factors_of(run: Run) -> RunFactors:
    stats: dict[str, Any] = run.stats or {}
    model_id = run.model.model_id
    judge = stats.get("judge_model_id") or model_id
    judge_policy = "same model as the run" if judge == model_id else judge
    judge_n = stats.get("judge_n")
    overrides = int((stats.get("test_cases") or {}).get("in_scope", 0))
    corpus_name = stats.get("corpus", "synthetic")
    calls = stats.get("transcripts")
    key = {
        "prompt": run.prompt_version_id,
        "model": f"{model_id}|{run.adapter}",
        "rule_date": run.rule_date.isoformat(),
        "corpus": run.corpus_hash,
        "contract_set": run.contract_set_hash,
        "judge": f"{judge_policy}|{judge_n}" if judge_n else judge_policy,
        "overrides": str(overrides),
    }
    display = {
        "prompt": f"v{run.prompt_version.version}",
        "model": f"{model_id} ({run.adapter})",
        "rule_date": run.rule_date.isoformat(),
        "corpus": f"{corpus_name}, {calls} calls" if calls else corpus_name,
        "contract_set": run.contract_set_hash[:8],
        "judge": judge_policy,
        "overrides": f"{overrides} in scope",
    }
    return RunFactors(run_id=run.id, key=key, display=display)


# Factors that follow from another: the approved overrides in scope are the ones that
# touch the calls scored, so a different set of calls brings different overrides with it.
DERIVED_FROM: dict[str, str] = {"overrides": "corpus"}


def changed_factors(a: RunFactors, b: RunFactors) -> list[str]:
    changed = [f for f in FACTORS if a.key[f] != b.key[f]]
    return [f for f in changed if DERIVED_FROM.get(f) not in changed]


def _join(labels: list[str]) -> str:
    if len(labels) <= 2:
        return " and ".join(labels)
    return ", ".join(labels[:-1]) + " and " + labels[-1]


def isolating_pairs(a: RunFactors, b: RunFactors, candidates: Iterable[RunFactors]) -> list[dict[str, str]]:
    """For each factor that differs between A and B, an existing pair of runs (C, D) that
    differs in that factor alone and moves it the same way: C has A's value, D has B's.

    The other factors may sit at any shared value, so a confounded jump from A to B can
    decompose into a chain of clean steps (rule date, then prompt, then model). Pairs
    that include A or B are preferred; otherwise the newest pair wins (candidates are
    expected newest first).
    """
    pool: list[RunFactors] = [a, b] + [c for c in candidates if c.run_id not in (a.run_id, b.run_id)]
    out: list[dict[str, str]] = []
    for factor in changed_factors(a, b):
        best: tuple[int, int, str, str] | None = None
        for i, c in enumerate(pool):
            if c.key[factor] != a.key[factor]:
                continue
            for j, d in enumerate(pool):
                if d.key[factor] != b.key[factor] or changed_factors(c, d) != [factor]:
                    continue
                anchored = 0 if {c.run_id, d.run_id} & {a.run_id, b.run_id} else 1
                rank = (anchored, i + j, c.run_id, d.run_id)
                if best is None or rank[:2] < best[:2]:
                    best = rank
        if best is not None:
            out.append({"factor": factor, "label": LABELS[factor], "a_run_id": best[2], "b_run_id": best[3]})
    return out


def attribute(a: RunFactors, b: RunFactors, candidates: Iterable[RunFactors] = ()) -> dict[str, Any]:
    """Verdict, the factors that changed (with both values), what was held constant, and a
    plain-English summary a reviewer can act on."""
    changed = changed_factors(a, b)
    rows = [{"factor": f, "label": LABELS[f], "a": a.display[f], "b": b.display[f]} for f in changed]
    held = [LABELS[f] for f in FACTORS if f not in changed]
    labels = [LABELS[f] for f in changed]
    scope_note: str | None = None
    suggestions: list[dict[str, str]] = []

    if not changed:
        verdict = "repeat"
        summary = ("No tracked input differs between A and B. A difference comes from run-to-run variation "
                   "(which the significance test below weighs) or from something Backstop does not yet "
                   "fingerprint: generation settings, a simulated defect profile, or model weights re-pulled "
                   "under the same tag.")
    elif len(changed) == 1:
        verdict = "isolated"
        f = changed[0]
        summary = (f"Only the {LABELS[f]} changed ({a.display[f]} → {b.display[f]}). Every other tracked input "
                   f"was held constant, so the differences below are attributable to that change, subject to "
                   f"the significance test.")
    else:
        verdict = "confounded"
        suggestions = isolating_pairs(a, b, candidates)
        summary = (f"The {_join(labels)} changed together. The differences below are real, but they cannot "
                   f"be attributed to any one of these changes.")
        found = [s["label"] for s in suggestions]
        missing = [LABELS[f] for f in changed if LABELS[f] not in found]
        if found and not missing:
            summary += " Existing runs isolate each change on its own; compare those instead."
        elif found:
            summary += (f" Existing runs isolate the {_join(found)} change{'s' if len(found) > 1 else ''}; no pair "
                        f"isolates the {_join(missing)} change{'s' if len(missing) > 1 else ''} yet.")
        else:
            summary += " No existing pair of runs isolates them; start runs that change one thing at a time."
        primary = [f for f in changed if f not in JUDGED_ONLY]
        if len(primary) == 1:
            scope_note = (f"Deterministic, release-blocking contracts are still attributable to the "
                          f"{LABELS[primary[0]]} change; only the judged (advisory) contracts mix in the "
                          f"{_join([LABELS[f] for f in changed if f in JUDGED_ONLY])} change.")

    return {"verdict": verdict, "changed": rows, "held_constant": held, "summary": summary,
            "scope_note": scope_note, "isolating_pairs": suggestions}
