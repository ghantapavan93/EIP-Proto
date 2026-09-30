"""Workflow runs: execute the AI workflow against contracts and compare the results.

    GET  /api/workflows, /api/prompts/{id}, /api/models[/board], /api/contracts, /api/transcripts
    POST /api/runs                              start an idempotent run (engineer)
    GET  /api/runs[/{id}]                       run history and gate verdicts
    GET  /api/runs/compare                      paired comparison with exact significance tests
    GET  /api/runs/{id}/results                 per-transcript, per-contract outcomes
    GET  /api/runs/{id}/transcripts/{code}      one transcript with model output and evidence spans
"""

from __future__ import annotations

import re
from datetime import date as date_type
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from backstop import schemas as s
from backstop.api.deps import SessionDep, SettingsDep, User, UserDep, require_role
from backstop.api.serializers import contract_out, result_out, run_out, transcript_out
from backstop.core import attribution, compare, stats
from backstop.harness.corpus import HOLDOUT_PREFIX
from backstop.harness.runner import execute_run
from backstop.models import (
    Contract,
    Model,
    PromptVersion,
    Run,
    RunResult,
    Transcript,
    Workflow,
    WorkflowOutput,
)

router = APIRouter(tags=["runs"])

_WS = re.compile(r"\s+")


@router.get("/workflows", response_model=list[s.WorkflowOut])
def list_workflows(session: SessionDep, user: UserDep):
    out = []
    for w in session.scalars(select(Workflow)).all():
        out.append(s.WorkflowOut(id=w.id, code=w.code, name=w.name, description=w.description,
                                 prompt_versions=[s.PromptVersionOut.model_validate(p) for p in w.prompt_versions]))
    return out


@router.get("/workflows/{code}", response_model=s.WorkflowOut)
def get_workflow(code: str, session: SessionDep, user: UserDep):
    w = session.scalar(select(Workflow).where(Workflow.code == code))
    if w is None:
        raise HTTPException(404, "workflow not found")
    return s.WorkflowOut(id=w.id, code=w.code, name=w.name, description=w.description,
                         prompt_versions=[s.PromptVersionOut.model_validate(p) for p in w.prompt_versions])


@router.get("/prompts/{prompt_id}", response_model=s.PromptVersionOut)
def get_prompt(prompt_id: str, session: SessionDep, user: UserDep):
    p = session.get(PromptVersion, prompt_id)
    if p is None:
        raise HTTPException(404, "prompt version not found")
    out = s.PromptVersionOut.model_validate(p)
    out.text = p.text
    return out


@router.get("/models", response_model=list[s.ModelOut])
def list_models(session: SessionDep, user: UserDep):
    return [s.ModelOut.model_validate(m) for m in session.scalars(select(Model).order_by(Model.provider, Model.model_id)).all()]


_CASSETTE_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


@router.get("/models/board", response_model=s.ModelBoardOut)
def model_board(session: SessionDep, settings: SettingsDep, user: UserDep, prompt: int = 2,
                rule_date: date_type | None = None):
    """Every model side by side: where it runs, what it is worth, what it measured.

    One row per registered model with its provider's readiness (local Ollama probed, hosted
    free tiers by key), the cassette sets recorded for it, and its latest completed run for the
    board's prompt version and rule date (falling back to its latest run of any kind, marked
    unmatched). Simulated rows are declared profiles and say so; only live and cassette runs
    count as measured.
    """
    from backstop.harness import providers as pv
    from backstop.harness.openai_compat import probe_ollama_cached as probe_ollama

    rule_date = rule_date or date_type(2026, 10, 1)
    probe = probe_ollama(pv.PROVIDERS["ollama"].base_url)
    local_models = set(probe["models"])
    providers: dict[str, dict] = {}
    for name, provider in pv.PROVIDERS.items():
        providers[name] = {"available": probe["reachable"] if name == "ollama" else provider.available(),
                           "key_env": provider.key_env, "notes": provider.notes, "rpm": provider.rpm, "rpd": provider.rpd,
                           **({"local_models": sorted(local_models)} if name == "ollama" else {})}
    providers["anthropic"] = {"available": bool(settings.anthropic_api_key), "key_env": "ANTHROPIC_API_KEY",
                              "notes": "Paid API. Optional; nothing in the demo needs it."}
    providers["simulated"] = {"available": True, "key_env": None,
                              "notes": "Deterministic stand-ins with declared defect profiles. Not models."}

    prompt_by_hash = {p.prompt_hash: p.version for p in session.scalars(select(PromptVersion)).all()}
    cassette_root = settings.fixtures_dir / "cassettes"

    def cassette_sets(model_id: str) -> list[s.CassetteSetOut]:
        if not cassette_root.exists():
            return []
        safe = _CASSETTE_SAFE.sub("_", model_id)
        sets = []
        for prompt_dir in sorted(cassette_root.iterdir()):
            model_dir = prompt_dir / safe
            if not model_dir.is_dir():
                continue
            counts = {kind: len(list(model_dir.glob(f"*.{kind}.json"))) for kind in ("generate", "judge", "canary")}
            if any(counts.values()):
                sets.append(s.CassetteSetOut(prompt_version=prompt_by_hash.get(prompt_dir.name),
                                             prompt_hash=prompt_dir.name, **counts))
        return sets

    def availability(model: Model, spec: pv.ModelSpec | None) -> tuple[str, str, str | None]:
        if model.provider == "simulated":
            return "simulated", "declared defect profile, not a model", None
        if model.provider == "anthropic":
            return (("ready", "ANTHROPIC_API_KEY set", "ANTHROPIC_API_KEY") if settings.anthropic_api_key
                    else ("needs-key", "paid; set ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"))
        provider = pv.PROVIDERS.get(model.provider)
        if provider is None:
            return "offline", "unknown provider", None
        if model.provider == "ollama":
            name = model.model_id.partition("/")[2] or model.model_id
            if not probe["reachable"]:
                return "offline", "Ollama is not running on this machine (cassettes still replay)", None
            if name in local_models:
                return "ready", "pulled on this machine · $0 · nothing leaves the laptop", None
            return "not-pulled", f"Ollama is up; run `ollama pull {name}`", None
        if provider.available():
            return "ready", f"{provider.key_env} set · free tier ≈ {provider.rpm} RPM", provider.key_env
        return "needs-key", f"free key → {provider.key_env}", provider.key_env

    rows: list[s.ModelBoardRow] = []
    for model in session.scalars(select(Model).order_by(Model.provider, Model.model_id)).all():
        spec = pv.spec_for(model.model_id)
        state, detail, key_env = availability(model, spec)
        # The board compares models on the same 60 development calls; held-out and
        # ingested runs answer different questions and would make rows incomparable.
        complete = [r for r in session.scalars(select(Run).where(Run.model_id == model.id, Run.status == "COMPLETE")
                                               .order_by(Run.started_at.desc())).all()
                    if (r.stats or {}).get("corpus", "synthetic") == "synthetic"]
        matched_run = next((r for r in complete
                            if r.prompt_version.version == prompt and r.rule_date == rule_date), None)
        run = matched_run or (complete[0] if complete else None)
        rows.append(s.ModelBoardRow(
            model=s.ModelOut.model_validate(model),
            tier="simulated" if model.provider == "simulated" else "paid" if model.provider == "anthropic"
            else (spec.tier if spec else "local"),
            supports_tools=spec.supports_tools if spec else None,
            availability=state, availability_detail=detail, key_env=key_env,
            cassettes=cassette_sets(model.model_id),
            latest_run=run_out(session, run) if run else None,
            matched=matched_run is not None,
            measured=run is not None and run.adapter != "simulated" and not (run.stats or {}).get("adapter_errors"),
        ))
    return s.ModelBoardOut(prompt_version=prompt, rule_date=rule_date, providers=providers, rows=rows)


@router.get("/contracts", response_model=list[s.ContractOut])
def list_contracts(session: SessionDep, user: UserDep):
    return [contract_out(c) for c in session.scalars(select(Contract).order_by(Contract.code)).all()]


@router.get("/transcripts", response_model=list[s.TranscriptOut])
def list_transcripts(session: SessionDep, user: UserDep, limit: int = Query(100, ge=1, le=500),
                     offset: int = Query(0, ge=0),
                     corpus: Literal["synthetic", "holdout", "ingested", "all"] = Query("synthetic")):
    """The development corpus by default (plus ingested). The held-out calls stay out of
    sight unless asked for: nobody should read them while writing prompts."""
    q = select(Transcript).order_by(Transcript.code)
    if corpus == "synthetic":
        q = q.where(~Transcript.code.like(f"{HOLDOUT_PREFIX}%"))
    elif corpus == "holdout":
        q = q.where(Transcript.code.like(f"{HOLDOUT_PREFIX}%"))
    elif corpus == "ingested":
        q = q.where(Transcript.synthetic.is_(False))
    rows = session.scalars(q.offset(offset).limit(limit)).all()
    return [transcript_out(t) for t in rows]


@router.get("/transcripts/{code}", response_model=s.TranscriptOut)
def get_transcript(code: str, session: SessionDep, user: UserDep):
    t = session.scalar(select(Transcript).where(Transcript.code == code))
    if t is None:
        raise HTTPException(404, "transcript not found")
    return transcript_out(t, with_text=True)


@router.post("/runs", response_model=s.RunOut)
def create_run(body: s.RunRequest, session: SessionDep, settings: SettingsDep,
               user: User = Depends(require_role("engineer", "admin"))):
    try:
        outcome = execute_run(
            session, settings, workflow_code=body.workflow, prompt_version=body.prompt_version,
            model_id=body.model_id, adapter_kind=body.adapter, rule_date=body.rule_date, trigger=body.trigger,
            limit=body.limit, actor=user.name, corpus=body.corpus,
            judge_model_id=body.judge_model_id, judge_n=body.judge_n,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except IntegrityError as exc:
        # Two identical requests raced on the unique run_key; the other one owns the run.
        session.rollback()
        raise HTTPException(409, "an identical run was just started; refresh the runs list") from exc
    return run_out(session, outcome.run, deduplicated=outcome.deduplicated)


@router.get("/runs", response_model=list[s.RunOut])
def list_runs(session: SessionDep, user: UserDep):
    runs = session.scalars(select(Run).order_by(Run.started_at.desc())).all()
    return [run_out(session, r) for r in runs]


# NOTE: declared before /runs/{run_id} so "compare" is not captured as an id.
@router.get("/runs/compare", response_model=s.CompareOut)
def compare_runs(session: SessionDep, user: UserDep, a: str = Query(...), b: str = Query(...)):
    run_a, run_b = session.get(Run, a), session.get(Run, b)
    if run_a is None or run_b is None:
        raise HTTPException(404, "run not found")

    ca, cb = compare.load_cells(session, run_a.id), compare.load_cells(session, run_b.id)
    ia, ib = ca.outcomes, cb.outcomes
    newly_failing, newly_passing = [], []
    unchanged_failing = unchanged_passing = 0
    per_contract: dict[str, dict[str, int]] = {}
    # Only (call, contract) cells both runs scored are comparable; runs over different
    # corpora would otherwise show every unmatched cell as a change.
    shared = set(ia) & set(ib)
    only_a, only_b = len(set(ia) - shared), len(set(ib) - shared)
    for key in sorted(shared):
        oa, ob = ia[key], ib[key]
        row = per_contract.setdefault(key[1], {"a_fail": 0, "b_fail": 0, "newly_failing": 0, "newly_passing": 0,
                                               "a_error": 0, "b_error": 0})
        row["a_fail"] += oa in ("FAIL", "FLAG", "ERROR")
        row["b_fail"] += ob in ("FAIL", "FLAG", "ERROR")
        row["a_error"] += oa == "ERROR"
        row["b_error"] += ob == "ERROR"
        if oa == "PASS" and ob != "PASS":
            newly_failing.append(s.CompareCell(transcript_code=key[0], contract_code=key[1], a=oa, b=ob))
            row["newly_failing"] += 1
        elif oa != "PASS" and ob == "PASS":
            newly_passing.append(s.CompareCell(transcript_code=key[0], contract_code=key[1], a=oa, b=ob))
            row["newly_passing"] += 1
        elif oa == ob == "PASS":
            unchanged_passing += 1
        else:
            unchanged_failing += 1
    what_changed = {
        "prompt": run_a.prompt_version_id != run_b.prompt_version_id,
        "model": run_a.model_id != run_b.model_id,
        "rule_date": run_a.rule_date != run_b.rule_date,
        "adapter": run_a.adapter != run_b.adapter,
        "corpus": run_a.corpus_hash != run_b.corpus_hash,
        "cells_only_in_a": only_a,
        "cells_only_in_b": only_b,
        "contract_set": run_a.contract_set_hash != run_b.contract_set_hash,
    }
    candidates = session.scalars(
        select(Run).where(Run.status == "COMPLETE").order_by(Run.started_at.desc())
        .options(selectinload(Run.model), selectinload(Run.prompt_version))
    ).all()
    attributed = attribution.attribute(attribution.factors_of(run_a), attribution.factors_of(run_b),
                                       [attribution.factors_of(r) for r in candidates])
    statistics = compare.compare_statistics(session, run_a, run_b, ca, cb)
    if attributed["verdict"] == "confounded":
        changed = [c["label"] for c in attributed["changed"]]
        statistics.cautions.insert(0, f"Confounded: {', '.join(changed)} changed together, so a significant "
                                      "difference here cannot be assigned to any one of them.")
    return s.CompareOut(
        a=run_out(session, run_a), b=run_out(session, run_b), what_changed=what_changed,
        attribution=s.AttributionOut(**attributed),
        newly_failing=newly_failing, newly_passing=newly_passing, unchanged_failing=unchanged_failing,
        unchanged_passing=unchanged_passing,
        per_contract=[{"contract_code": k, **v} for k, v in sorted(per_contract.items())],
        failure_definition=COMPARE_FAILURE_DEFINITION,
        statistics=statistics,
    )


COMPARE_FAILURE_DEFINITION = (
    "per_contract a_fail/b_fail count every non-PASS outcome (FAIL, FLAG and ERROR, including "
    "unlabelled not_evaluated cells); a_error/b_error break out the ERROR share. statistics uses the "
    "severity-aware definition: " + stats.FAILURE_DEFINITION
)


@router.get("/runs/{run_id}", response_model=s.RunOut)
def get_run(run_id: str, session: SessionDep, user: UserDep):
    run = session.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    return run_out(session, run)


@router.get("/runs/{run_id}/results", response_model=list[s.RunResultOut])
def run_results(run_id: str, session: SessionDep, user: UserDep, contract: str | None = None,
                outcome: str | None = None, transcript: str | None = None):
    run = session.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    rows = [result_out(rr) for rr in run.results]
    if contract:
        rows = [r for r in rows if r.contract_code == contract]
    if outcome:
        rows = [r for r in rows if r.outcome == outcome]
    if transcript:
        rows = [r for r in rows if r.transcript_code == transcript]
    rows.sort(key=lambda r: (r.transcript_code, r.contract_code))
    return rows


@router.get("/runs/{run_id}/transcripts/{code}", response_model=s.RunTranscriptOut)
def run_transcript(run_id: str, code: str, session: SessionDep, user: UserDep):
    run = session.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    t = session.scalar(select(Transcript).where(Transcript.code == code))
    if t is None:
        raise HTTPException(404, "transcript not found")
    wo = session.scalar(select(WorkflowOutput).where(WorkflowOutput.run_id == run.id, WorkflowOutput.transcript_id == t.id))
    results = session.scalars(select(RunResult).where(RunResult.run_id == run.id, RunResult.transcript_id == t.id)).all()
    output = wo.output if wo else {}
    ex = output.get("extraction", {}) if isinstance(output, dict) else {}
    spans = []
    norm_text = _WS.sub(" ", t.text).lower()
    for label in ("disclaimer_span", "benefits_span", "soa_span"):
        val = ex.get(label)
        if not val:
            continue
        idx = t.text.find(val)
        verified = idx >= 0 or _WS.sub(" ", val).lower() in norm_text
        spans.append({"label": label, "text": val, "offset": idx if idx >= 0 else -1, "length": len(val), "verified": verified})
    for i, sup in enumerate(ex.get("superlatives", []) or []):
        val = sup.get("text") if isinstance(sup, dict) else None
        if not val:
            continue
        idx = t.text.find(val)
        spans.append({"label": f"superlative[{i}]", "text": val, "offset": idx, "length": len(val), "verified": idx >= 0})
    return s.RunTranscriptOut(
        transcript=transcript_out(t, with_text=True), output=output, route=wo.route if wo else "BLOCK",
        latency_ms=wo.latency_ms if wo else 0, usage=wo.usage if wo else {}, error=wo.error if wo else "no output",
        results=[result_out(rr) for rr in sorted(results, key=lambda r: r.contract_version.contract.code)], spans=spans,
    )
