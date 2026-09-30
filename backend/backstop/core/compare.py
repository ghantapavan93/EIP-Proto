"""Is run B different from run A? Paired exact tests over stored verdicts.

Reads RunResult rows only; nothing is re-run. Same calls in both runs: McNemar on the
calls whose outcome changed. Different calls: Fisher on the two rates. Per-contract
p-values are Holm-adjusted across the family; the ALL-BLOCK row is the call-level
release question (a call fails if any BLOCK contract fails on it).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from backstop import schemas as s
from backstop.core import stats
from backstop.models import Contract, ContractVersion, Run, RunResult, Transcript, version_severity


@dataclass
class Cells:
    """One run's verdicts keyed by (transcript code, contract code)."""

    outcomes: dict[tuple[str, str], str] = field(default_factory=dict)
    not_evaluated: set[tuple[str, str]] = field(default_factory=set)
    severity: dict[str, str] = field(default_factory=dict)


def load_cells(session: Session, run_id: str) -> Cells:
    """Two flat queries instead of lazy-loading every result's transcript and contract."""
    cells = Cells()
    # Severity as the run was scored, not as the contract reads today.
    used = select(RunResult.contract_version_id).where(RunResult.run_id == run_id).distinct()
    for c_code, spec, current in session.execute(
            select(Contract.code, ContractVersion.spec, Contract.severity)
            .join(Contract, ContractVersion.contract_id == Contract.id)
            .where(ContractVersion.id.in_(used))):
        cells.severity[c_code] = version_severity(spec, current)
    base = (select(Transcript.code, Contract.code, RunResult.outcome)
            .join(Transcript, RunResult.transcript_id == Transcript.id)
            .join(ContractVersion, RunResult.contract_version_id == ContractVersion.id)
            .join(Contract, ContractVersion.contract_id == Contract.id)
            .where(RunResult.run_id == run_id))
    for t_code, c_code, outcome in session.execute(base):
        cells.outcomes[(t_code, c_code)] = outcome
    # Only ERROR cells can be "not evaluated" (unlabelled ingested calls); read evidence for those alone.
    errors = (select(Transcript.code, Contract.code, RunResult.evidence)
              .join(Transcript, RunResult.transcript_id == Transcript.id)
              .join(ContractVersion, RunResult.contract_version_id == ContractVersion.id)
              .join(Contract, ContractVersion.contract_id == Contract.id)
              .where(RunResult.run_id == run_id, RunResult.outcome == "ERROR"))
    for t_code, c_code, evidence in session.execute(errors):
        if isinstance(evidence, dict) and evidence.get("not_evaluated"):
            cells.not_evaluated.add((t_code, c_code))
    return cells


def compare_one(code: str, severity: str | None, fails: tuple[str, ...], a_map: dict[str, bool],
                 b_map: dict[str, bool], paired_mode: bool, excluded: int, what: str) -> s.ContractComparisonOut:
    """a_map/b_map: transcript code -> failed? for the cells each run scored."""
    shared = a_map.keys() & b_map.keys()
    table = stats.paired_table((a_map[t], b_map[t]) for t in shared)
    if paired_mode:
        a_k, a_n = table["both_fail"] + table["a_only_fail"], len(shared)
        b_k, b_n = table["both_fail"] + table["b_only_fail"], len(shared)
        result = stats.compare_rates(a_k, a_n, b_k, b_n, table, what=what)
    else:
        a_k, a_n = sum(a_map.values()), len(a_map)
        b_k, b_n = sum(b_map.values()), len(b_map)
        result = stats.compare_rates(a_k, a_n, b_k, b_n, None, what=what)
    return s.ContractComparisonOut(
        contract_code=code, severity=severity, failure_outcomes=list(fails), n_shared=len(shared),
        paired=s.PairedTableOut(**table) if paired_mode else None,
        a=s.RateOut(**result["a"]), b=s.RateOut(**result["b"]), discordant=result["discordant"],
        test=result["test"], p_value=result["p_value"], significant=result["significant"],
        direction=result["direction"], verdict=result["verdict"], cautions=result["cautions"],
        excluded_not_evaluated=excluded,
    )


def held_out_check(session: Session, run_a: Run, run_b: Run) -> s.HeldOutCheckOut | None:
    """The same prompt change replayed on the held-out calls, if both runs exist, phrased so a
    development-set result cannot be quoted without it."""

    def latest(run: Run) -> Run | None:
        candidates = session.scalars(
            select(Run).where(Run.prompt_version_id == run.prompt_version_id, Run.model_id == run.model_id,
                              Run.adapter == run.adapter, Run.rule_date == run.rule_date, Run.status == "COMPLETE")
            .order_by(Run.started_at.desc())
        ).all()
        return next((r for r in candidates if (r.stats or {}).get("corpus") == "holdout"), None)

    ha, hb = latest(run_a), latest(run_b)
    if ha is None or hb is None:
        return None
    held = compare_statistics(session, ha, hb, load_cells(session, ha.id), load_cells(session, hb.id)).overall
    va, vb = ha.prompt_version.version, hb.prompt_version.version
    n = (ha.stats or {}).get("transcripts") or "the"
    if held.direction in ("better", "worse"):
        finding = (f"prompt v{vb} is significantly {held.direction} than v{va} on the release-blocking "
                   f"contracts (p={stats.fmt_p(held.p_value)})")
    else:
        finding = f"prompts v{va} and v{vb} show no significant difference (p={stats.fmt_p(held.p_value)})"
    return s.HeldOutCheckOut(
        a_run_id=ha.id, b_run_id=hb.id, a_prompt_version=va, b_prompt_version=vb, direction=held.direction,
        p_value=held.p_value, summary=f"On the {n} held-out calls, {finding}.",
        contradicts_development=False)  # set by the caller, which knows the development verdict


def compare_statistics(session: Session | None, run_a: Run, run_b: Run, ca: Cells, cb: Cells) -> s.CompareStatisticsOut:
    """Is the difference between A and B signal or noise? Exact tests, Wilson intervals.

    Same calls in both runs: McNemar on the calls whose outcome changed. Different
    calls (the corpus changed): the pairing is gone, so Fisher on the two rates.
    """
    paired_mode = run_a.corpus_hash == run_b.corpus_hash
    severity = {**ca.severity, **cb.severity}

    def failed_by_contract(cells: Cells) -> dict[str, dict[str, bool]]:
        out: dict[str, dict[str, bool]] = {}
        for (t_code, c_code), outcome in cells.outcomes.items():
            if (t_code, c_code) in cells.not_evaluated:
                continue
            out.setdefault(c_code, {})[t_code] = outcome in stats.failure_outcomes(severity[c_code])
        return out

    fa, fb = failed_by_contract(ca), failed_by_contract(cb)
    excluded: dict[str, int] = {}
    for c_code in (c for _, c in (*ca.not_evaluated, *cb.not_evaluated)):
        excluded[c_code] = excluded.get(c_code, 0) + 1

    per_contract = [
        compare_one(code, severity[code], stats.failure_outcomes(severity[code]), fa.get(code, {}),
                     fb.get(code, {}), paired_mode, excluded.get(code, 0), what="this contract")
        for code in sorted(severity)
    ]
    for row, p_holm in zip(per_contract, stats.holm([r.p_value for r in per_contract]), strict=True):
        row.p_holm = p_holm
        row.significant_holm = row.significant and p_holm is not None and p_holm < stats.ALPHA
        if row.significant and not row.significant_holm:
            row.cautions.append(f"Not significant after Holm correction across {len(per_contract)} contracts "
                                f"(p_holm={stats.fmt_p(p_holm)}).")
            if row.direction != "none":
                # Eight contracts tested at once: a raw p under alpha is not a finding on its own.
                row.direction = "none"
                row.verdict = (f"No significant difference after Holm correction across {len(per_contract)} "
                               f"contracts (p={stats.fmt_p(row.p_value)}, p_holm={stats.fmt_p(p_holm)})")

    # Overall: a call fails if any BLOCK contract fails on it — the call-level release question.
    block = [c for c, sev in severity.items() if sev == "BLOCK"]

    def any_block(f: dict[str, dict[str, bool]]) -> dict[str, bool]:
        calls: dict[str, bool] = {}
        for code in block:
            for t_code, failed in f.get(code, {}).items():
                calls[t_code] = calls.get(t_code, False) or failed
        return calls

    overall = compare_one("ALL-BLOCK", "BLOCK", stats.failure_outcomes("BLOCK"), any_block(fa), any_block(fb),
                           paired_mode, sum(excluded.get(c, 0) for c in block),
                           what="the release-blocking contracts")
    if run_a.contract_set_hash != run_b.contract_set_hash:
        overall.cautions.append("The contract sets differ between the runs; ALL-BLOCK compares different checks.")

    held_out: s.HeldOutCheckOut | None = None
    cautions = ["One generation per call: a repeat of either run could move a few calls. "
                "Repeat generations would tighten these intervals."]
    corpus_a, corpus_b = (run_a.stats or {}).get("corpus", "synthetic"), (run_b.stats or {}).get("corpus", "synthetic")
    if not paired_mode:
        cautions.insert(0, "The runs scored different calls (corpus changed), so a paired test is invalid. "
                           "Rates are compared with Fisher's exact test on each run's own calls; two draws of "
                           "calls can differ on their own, so this does not isolate the change.")
    elif corpus_a == corpus_b == "synthetic" and run_a.prompt_version_id != run_b.prompt_version_id:
        held_out = held_out_check(session, run_a, run_b) if session is not None else None
        if held_out is not None:
            held_out.contradicts_development = held_out.direction != overall.direction
            # Lead with it: a development-set win the held-out calls contradict must never read as a win.
            cautions.insert(0, f"Held-out check: {held_out.summary} These development calls were read while "
                               f"writing the prompt; trust the held-out result.")
        else:
            cautions.append("Both runs are on the development calls the prompts were written against. A prompt "
                            "tuned on these calls can look significantly better here and still regress on unseen "
                            "calls; confirm on the held-out corpus.")
    return s.CompareStatisticsOut(mode="paired" if paired_mode else "unpaired", alpha=stats.ALPHA,
                                  failure_definition=stats.FAILURE_DEFINITION, cautions=cautions,
                                  overall=overall, per_contract=per_contract,
                                  held_out=held_out if paired_mode and corpus_a == "synthetic" else None)
