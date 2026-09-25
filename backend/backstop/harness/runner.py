"""Harness runner: seed the workflow/contracts/corpus, execute idempotent runs.

A run is keyed by everything that could change its outcome:

    run_key = workflow : prompt_hash : model : adapter : corpus_hash : contract_set_hash : rule_date

Submitting the same key twice returns the first run (`deduplicated=True`) and
writes a `run.deduplicated` audit event. Results are unique per
(run, transcript, contract version), so a crashed run can be resumed and
converges to the same state.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, date
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from backstop.config import Settings
from backstop.core import audit
from backstop.core.impact import in_force_version
from backstop.harness import adapters as ad
from backstop.harness import canary, cost, providers
from backstop.harness import contracts as ct
from backstop.harness import corpus as cp
from backstop.harness import workflow as wf
from backstop.models import (
    Asset,
    AssetVersion,
    Contract,
    ContractVersion,
    Model,
    PromptVersion,
    ReviewTask,
    Rule,
    RuleAssetEdge,
    Run,
    RunResult,
    TestCase,
    Transcript,
    Workflow,
    WorkflowOutput,
    utcnow,
)

WORKFLOW_CODE = "qa-handoff"

MODELS = [
    {"provider": "simulated", "model_id": "sim-large", "label": "Simulated — large (clean profile)", "pinned": True,
     "notes": "Deterministic stand-in. Defect profile in fixtures/simulated_profiles.yaml."},
    {"provider": "simulated", "model_id": "sim-small", "label": "Simulated — small (defect-prone profile)", "pinned": True,
     "notes": "Deterministic stand-in with declared defects (numeric hallucination, span paraphrase, PII leak, timestamp misread)."},
    {"provider": "anthropic", "model_id": "claude-sonnet-5", "label": "Claude Sonnet 5 (paid)", "pinned": True,
     "notes": "Optional paid model; needs ANTHROPIC_API_KEY. Never run in this build — no cassettes exist for it."},
    {"provider": "anthropic", "model_id": "claude-haiku-4-5-20251001", "label": "Claude Haiku 4.5 (paid)", "pinned": True,
     "notes": "Optional paid model; needs ANTHROPIC_API_KEY. Never run in this build — no cassettes exist for it."},
] + [
    {"provider": spec.provider, "model_id": spec.model_id, "label": spec.label, "pinned": True,
     "notes": f"{spec.tier}. {spec.notes}"}
    for spec in providers.MODELS
]


# ------------------------------------------------------------------ seeding


def seed_models(session: Session) -> None:
    for spec in MODELS:
        if session.scalar(select(Model).where(Model.model_id == spec["model_id"])) is None:
            session.add(Model(**spec))
    session.flush()


def seed_workflow(session: Session) -> Workflow:
    workflow = session.scalar(select(Workflow).where(Workflow.code == WORKFLOW_CODE))
    if workflow is None:
        workflow = Workflow(
            code=WORKFLOW_CODE,
            name="Post-call QA & handoff record",
            description="transcript → extract (model) → check (contracts) → compose (model) → route (deterministic)",
        )
        session.add(workflow)
        session.flush()
    for version, spec in wf.PROMPTS.items():
        pv = session.scalar(
            select(PromptVersion).where(PromptVersion.workflow_id == workflow.id, PromptVersion.version == version)
        )
        if pv is None:
            asset_code = f"prompt-{WORKFLOW_CODE}-v{version}"
            asset = session.scalar(select(Asset).where(Asset.code == asset_code))
            if asset is None:
                asset = Asset(
                    code=asset_code,
                    type="workflow_prompt",
                    name=f"Workflow prompt {WORKFLOW_CODE} {spec['label']}",
                    url=None,
                    source_system="backstop-repo",
                    owner_role="ai-enablement",
                    is_synthetic=False,
                )
                session.add(asset)
                session.flush()
            pv = PromptVersion(
                workflow_id=workflow.id,
                version=version,
                label=spec["label"],
                prompt_hash=wf.prompt_hash(spec["text"]),
                text=spec["text"],
                author=spec["author"],
                notes=spec["notes"],
                encodes_rule_versions=spec["encodes_rule_versions"],
                asset_id=asset.id,
            )
            session.add(pv)
            session.flush()
            _declare_prompt_edges(session, pv, asset)
    session.flush()
    return workflow


def _prompt_asset_version(session: Session, pv: PromptVersion, asset: Asset) -> AssetVersion:
    """A prompt is an artifact like any page: its text gets a content-hashed version,
    so evidence bundles can pin exactly which prompt text an edge was drawn from."""
    digest = hashlib.sha256(pv.text.encode("utf-8")).hexdigest()
    version = session.scalar(select(AssetVersion).where(AssetVersion.asset_id == asset.id,
                                                        AssetVersion.content_hash == digest))
    if version is None:
        version = AssetVersion(asset_id=asset.id, content_hash=digest, content_text=pv.text, fetch_mode="repo")
        session.add(version)
        session.flush()
    return version


def _declare_prompt_edges(session: Session, pv: PromptVersion, asset: Asset) -> None:
    """Manual edges from the prompt's declared rule dependencies (span = the encoding sentence)."""
    version = _prompt_asset_version(session, pv, asset)
    for dep in pv.encodes_rule_versions:
        rule = session.scalar(select(Rule).where(Rule.code == dep["rule"]))
        if rule is None:
            continue
        rv = next((v for v in rule.versions if v.version == dep["version"]), None)
        if rv is None:
            continue
        span = _encoding_sentence(pv.text, dep["rule"])
        exists = session.scalar(
            select(RuleAssetEdge).where(
                RuleAssetEdge.rule_version_id == rv.id,
                RuleAssetEdge.asset_id == asset.id,
                RuleAssetEdge.evidence_span == span,
            )
        )
        if exists is None:
            session.add(
                RuleAssetEdge(
                    rule_version_id=rv.id,
                    asset_id=asset.id,
                    asset_version_id=version.id,
                    polarity="ENFORCES",
                    evidence_span=span,
                    span_offset=max(0, pv.text.find(span)),
                    detection="manual",
                    matcher="declared-dependency",
                    confidence=1.0,
                    status="confirmed",
                    confirmed_by=pv.author or "ai-enablement",
                )
            )


def _encoding_sentence(text: str, rule_code: str) -> str:
    key = {
        "tpmo-disclaimer-timing": "disclaimer",
        "soa-48h-wait": "Scope of Appointment",
        "superlatives": "Superlatives",
    }.get(rule_code, rule_code)
    for line in text.splitlines():
        if key.lower() in line.lower() and line.strip().startswith(("1.", "2.", "3.")):
            return line.strip()
    return f"[declared dependency on {rule_code}]"


def contract_set_hash(contracts_dir) -> str:
    return hashlib.sha256((contracts_dir / "contracts.yaml").read_bytes()).hexdigest()[:16]


# Contract fields whose change alters what a verdict means. A YAML edit to any of
# them appends a ContractVersion; the Contract row mirrors the latest definition.
_CONTRACT_ROW_FIELDS = ("title", "description", "severity", "kind", "check", "owner_role")


def _contract_definition(spec: dict, rule: Rule | None) -> dict[str, Any]:
    """The YAML entry reduced to the fields that define a contract version."""
    return {
        "title": spec["title"],
        "description": (spec.get("description") or "").strip(),
        "severity": spec["severity"],
        "kind": spec["kind"],
        "check": spec["check"],
        "owner_role": spec.get("owner_role", "ai-enablement"),
        "rule_id": rule.id if rule else None,
        "spec": dict(spec.get("spec") or {}, n_runs=spec.get("n_runs")),
        "judge_model_id": spec.get("judge_model_id"),
        "n_runs": spec.get("n_runs"),
    }


def _stored_definition(contract: Contract) -> dict[str, Any]:
    latest = contract.versions[-1]
    return {
        **{f: getattr(contract, f) for f in _CONTRACT_ROW_FIELDS},
        "rule_id": contract.rule_id,
        # "_"-prefixed keys are bookkeeping written below, not part of the check's spec.
        "spec": {k: v for k, v in (latest.spec or {}).items() if not k.startswith("_")},
        "judge_model_id": latest.judge_model_id,
        "n_runs": latest.n_runs,
    }


def seed_contracts(session: Session, contracts_dir, *, actor: str = "system:seed") -> list[Contract]:
    """Sync contracts/contracts.yaml into the database.

    New contracts get v1. For an existing contract, a changed definition (title, description,
    severity, kind, check, owner, rule, spec, judge, n_runs) appends version N+1 effective today,
    updates the Contract row, and writes a ``contract.version_created`` audit event with the
    before/after of every changed field. Unchanged YAML is a no-op. Past runs keep pointing at
    the version they used; nothing is rewritten.
    """
    doc = yaml.safe_load((contracts_dir / "contracts.yaml").read_text(encoding="utf-8"))
    out: list[Contract] = []
    for spec in doc["contracts"]:
        contract = session.scalar(select(Contract).where(Contract.code == spec["code"]))
        rule = session.scalar(select(Rule).where(Rule.code == spec["rule"])) if spec.get("rule") else None
        wanted = _contract_definition(spec, rule)
        if contract is None:
            contract = Contract(code=spec["code"], rule_id=wanted["rule_id"],
                                **{f: wanted[f] for f in _CONTRACT_ROW_FIELDS})
            session.add(contract)
            session.flush()
        if not contract.versions:
            session.add(
                ContractVersion(
                    contract_id=contract.id,
                    version=1,
                    spec=wanted["spec"],
                    effective_from=date(2026, 9, 1),
                    judge_model_id=wanted["judge_model_id"],
                    n_runs=wanted["n_runs"],
                )
            )
            session.flush()
            session.refresh(contract, ["versions"])
        else:
            stored = _stored_definition(contract)
            if stored != wanted:
                changed = sorted(k for k in wanted if stored[k] != wanted[k])
                previous = contract.versions[-1]
                for f in _CONTRACT_ROW_FIELDS:
                    setattr(contract, f, wanted[f])
                contract.rule_id = wanted["rule_id"]
                cv = ContractVersion(
                    contract_id=contract.id,
                    version=previous.version + 1,
                    # The row fields are snapshotted so this version keeps its meaning
                    # (e.g. its severity) after the next edit moves the Contract row.
                    spec={**wanted["spec"], "_definition": {f: wanted[f] for f in _CONTRACT_ROW_FIELDS}},
                    effective_from=utcnow().date(),
                    judge_model_id=wanted["judge_model_id"],
                    n_runs=wanted["n_runs"],
                )
                session.add(cv)
                session.flush()
                session.refresh(contract, ["versions"])
                audit.record(
                    session,
                    actor=actor,
                    event_type="contract.version_created",
                    entity_type="contract",
                    entity_id=contract.id,
                    payload={
                        "contract": contract.code,
                        "version": cv.version,
                        "previous_version": previous.version,
                        "changed": changed,
                        "before": {k: stored[k] for k in changed},
                        "after": {k: wanted[k] for k in changed},
                        "source": "contracts.yaml",
                    },
                )
        out.append(contract)
    session.flush()
    return out


def seed_corpus(session: Session, seed: int = 2026, prefix: str = "T") -> str:
    corpus = cp.generate(seed, prefix)
    chash = cp.corpus_hash(corpus)
    for item in corpus:
        t = session.scalar(select(Transcript).where(Transcript.code == item["code"]))
        if t is None:
            session.add(
                Transcript(
                    code=item["code"],
                    corpus_hash=chash,
                    product_line=item["product_line"],
                    synthetic=True,
                    text=item["text"],
                    labels=item["labels"],
                    duration_seconds=item["duration_seconds"],
                )
            )
    session.flush()
    return chash


# ------------------------------------------------------------------ execution


@dataclass
class RunOutcome:
    run: Run
    deduplicated: bool


def _rule_params_in_force(session: Session, as_of: date) -> dict[str, dict[str, Any]]:
    params: dict[str, dict[str, Any]] = {}
    for rule in session.scalars(select(Rule)).all():
        v = in_force_version(rule, as_of)
        if v is not None:
            params[rule.code] = v.params
    return params


def _rule_params_declared(session: Session, pv: PromptVersion) -> dict[str, dict[str, Any]]:
    params: dict[str, dict[str, Any]] = {}
    for dep in pv.encodes_rule_versions:
        rule = session.scalar(select(Rule).where(Rule.code == dep["rule"]))
        if rule is None:
            continue
        v = next((x for x in rule.versions if x.version == dep["version"]), None)
        if v is not None:
            params[rule.code] = v.params
    return params


def gate_for(results: list[RunResult], contracts_by_version: dict[str, Contract]) -> str:
    red = amber = False
    for r in results:
        if overridden(r):
            continue  # a human already decided this exact call; the approved test case says why
        if r.outcome == "ERROR" and isinstance(r.evidence, dict) and r.evidence.get("not_evaluated"):
            # An unlabelled call can't be judged: that needs a human (amber), it isn't a failure (red).
            amber = True
            continue
        contract = contracts_by_version[r.contract_version_id]
        if r.outcome in ("FAIL", "ERROR") and contract.severity == "BLOCK":
            red = True
        elif r.outcome in ("FLAG", "FAIL", "ERROR"):
            amber = True
    return "RED" if red else ("AMBER" if amber else "GREEN")


def overridden(result: RunResult) -> bool:
    return isinstance(result.evidence, dict) and "override" in result.evidence


def _approved_overrides(session: Session, transcripts: list[Transcript]) -> dict[tuple[str, str], TestCase]:
    """Approved, unexpired test cases keyed by (contract_id, transcript_id).

    This is the loop the review queue promises: a reviewer overrides a verdict on
    one call, a *different* person approves it, and from then on every run treats
    that exact contract-on-call verdict as decided — it is still computed and
    shown, but it no longer blocks the gate or reopens a task. Expiry puts it back.
    """
    ids = [t.id for t in transcripts]
    if not ids:
        return {}
    now = utcnow()
    cases = session.scalars(select(TestCase).where(
        TestCase.status == "APPROVED", TestCase.transcript_id.in_(ids))).all()
    return {(tc.contract_id, tc.transcript_id): tc for tc in cases
            if (tc.expires_at.replace(tzinfo=UTC) if tc.expires_at.tzinfo is None else tc.expires_at) > now}


RUN_KEY_MAX = 160  # Run.run_key column width


def bounded_run_key(key: str) -> str:
    """Keep the readable key when it fits; otherwise truncate and append a hash of the full key."""
    if len(key) <= RUN_KEY_MAX:
        return key
    digest = hashlib.sha256(key.encode()).hexdigest()[:16]
    return f"{key[: RUN_KEY_MAX - len(digest) - 1]}#{digest}"


def _resolve_adapter(model: Model, adapter_kind: str | None, settings: Settings) -> str:
    """Pick the adapter and refuse combinations that would mislabel a run."""
    if adapter_kind == "anthropic":
        adapter_kind = "live"
    if adapter_kind is None:
        # Simulated models run simulated; real models replay cassettes (falling
        # back to the live provider when it is configured) unless told otherwise.
        adapter_kind = "simulated" if model.provider == "simulated" else (
            settings.default_adapter if settings.default_adapter not in ("simulated", "anthropic") else "cassette"
        )
    if model.provider == "simulated" and adapter_kind != "simulated":
        raise ValueError("simulated models only run on the simulated adapter")
    if model.provider != "simulated" and adapter_kind == "simulated":
        raise ValueError(f"{model.model_id} is a real model; use adapter 'live' or 'cassette'")
    return adapter_kind


def _select_transcripts(session: Session, corpus: str, limit: int | None) -> list[Transcript]:
    query = select(Transcript).order_by(Transcript.code)
    if corpus == "synthetic":
        # The development corpus only; the held-out draw is opt-in so no ordinary
        # run (or the demo's numbers) ever sees it.
        query = query.where(Transcript.synthetic.is_(True), Transcript.code.like("T%"))
    elif corpus == "holdout":
        query = query.where(Transcript.synthetic.is_(True), Transcript.code.like(f"{cp.HOLDOUT_PREFIX}%"))
    elif corpus == "ingested":
        query = query.where(Transcript.synthetic.is_(False))
    elif corpus != "all":
        raise ValueError("corpus must be synthetic, holdout, ingested or all")
    transcripts = list(session.scalars(query).all())
    if not transcripts:
        raise ValueError(f"no transcripts in corpus '{corpus}'")
    if limit is not None:
        if limit < 1:
            raise ValueError("limit must be >= 1")
        transcripts = transcripts[:limit]
    return transcripts


def _score(session: Session, run: Run, adapter, pv: PromptVersion, transcripts: list[Transcript],
           contracts: list[Contract], versions: dict[str, ContractVersion], logic_in_force: dict[str, Any],
           logic_declared: dict[str, Any], overrides: dict[tuple[str, str], TestCase],
           judge_n: int | None) -> tuple[list[RunResult], int, dict[str, int]]:
    """Generate one output per transcript and run every contract on it.

    The model sees what the prompt DECLARES; contracts judge against the rule IN
    FORCE on the run's date. When those differ, contracts fail — that is the point.
    """
    errors = 0
    results: list[RunResult] = []
    test_case_stats = {"in_scope": len(overrides), "applied": 0, "agreeing": 0}
    for t in transcripts:
        result = adapter.generate(pv.text, t.text, t.code, t.labels, logic_declared)
        output, validation_error = (None, result.error) if result.error else wf.validate_output(result.raw)
        route = "BLOCK"
        if output is not None:
            output.route = wf.route(output.extraction)
            route = output.route
        session.add(WorkflowOutput(
            run_id=run.id, transcript_id=t.id, output=output.model_dump() if output else result.raw, route=route,
            latency_ms=result.latency_ms, usage=result.usage, error=result.error or validation_error,
        ))
        if result.error:
            errors += 1
        ctx = ct.CheckContext(raw=result.raw, output=output, validation_error=validation_error, transcript=t.text,
                              transcript_code=t.code, labels=t.labels, logic=logic_in_force, spec={}, adapter=adapter)
        for contract in contracts:
            cv = versions[contract.id]
            ctx.spec = dict(cv.spec or {}, n_runs=judge_n or cv.n_runs)
            try:
                verdict = ct.REGISTRY[contract.check](ctx)
            except Exception as exc:  # noqa: BLE001 - a broken check is a result, not a crash
                verdict = ct.Verdict("ERROR", {"error": f"{type(exc).__name__}: {exc}"})
            case = overrides.get((contract.id, t.id))
            if case is not None:
                if verdict.outcome == case.expected.get("outcome", "PASS"):
                    test_case_stats["agreeing"] += 1
                elif verdict.outcome != "ERROR":  # a missing output is not what the human decided about
                    test_case_stats["applied"] += 1
                    verdict = ct.Verdict(verdict.outcome, {**(verdict.evidence or {}), "override": {
                        "test_case_id": case.id, "reason_code": case.reason_code,
                        "created_by": case.created_by, "approver": case.approver}})
            rr = RunResult(run_id=run.id, transcript_id=t.id, contract_version_id=cv.id, outcome=verdict.outcome,
                           evidence=verdict.evidence, latency_ms=result.latency_ms)
            session.add(rr)
            results.append(rr)
    session.flush()
    return results, errors, test_case_stats


def _route_review(session: Session, run: Run, results: list[RunResult],
                  contracts_by_version: dict[str, Contract], n_transcripts: int,
                  *, finding_scope: str) -> tuple[int, int]:
    """Open review items. Returns (actionable tasks opened, advisory items opened).

    The point is a SMALLER human review surface, not a ticket per observation:
      actionable — one task per FAIL of a BLOCK-severity deterministic contract
                   (deduplicated per run/transcript/contract). These gate a release.
      advisory   — FLAG-severity and JUDGED contracts: one aggregate item per
                   run × contract, listing the transcripts. Visible, never a queue.
    ERROR is not a finding about the call — it is a missing output (adapter failure,
    invalid schema, no ground truth) that the schema contract or the run's
    adapter_errors already surface — so it opens nothing. Nor does a verdict an
    approved test case already decided, nor a finding already open: the same
    prompt, model and rule date failing the same contract on the same call (e.g. a
    rerun that only swaps the judge) is one finding, not two tasks.
    """
    opened = advisory = 0
    grouped: dict[str, list[RunResult]] = {}
    for rr in results:
        if rr.outcome in ("PASS", "ERROR") or overridden(rr):
            continue
        contract = contracts_by_version[rr.contract_version_id]
        if contract.kind == "JUDGED" or contract.severity != "BLOCK":
            grouped.setdefault(contract.code, []).append(rr)
            continue
        dedupe_key = f"finding:{finding_scope}:{rr.transcript_id}:{contract.code}"
        if session.scalar(select(ReviewTask).where(ReviewTask.dedupe_key == dedupe_key)) is None:
            session.add(ReviewTask(
                kind="FLAGGED_RESULT", dedupe_key=dedupe_key, state="open", run_result_id=rr.id,
                reason=f"{contract.code} {rr.outcome}: {contract.title}", assignee_role="qa-compliance",
                payload={"run_id": run.id, "contract": contract.code, "severity": contract.severity,
                         "transcript_id": rr.transcript_id, "lane": "actionable"},
            ))
            opened += 1
    for code, flagged in grouped.items():
        contract = contracts_by_version[flagged[0].contract_version_id]
        dedupe_key = f"judged:{run.id}:{code}"
        if session.scalar(select(ReviewTask).where(ReviewTask.dedupe_key == dedupe_key)) is not None:
            continue
        if contract.kind == "JUDGED":
            means = [m for m in (r.evidence.get("mean") for r in flagged if isinstance(r.evidence, dict)) if m is not None]
            detail = f"judge mean {round(sum(means) / max(1, len(means)), 2)}"
        else:
            detail = f"{contract.severity}-severity, deterministic"
        session.add(ReviewTask(
            kind="FLAGGED_RESULT", dedupe_key=dedupe_key, state="open", run_result_id=flagged[0].id,
            reason=f"{code} flagged {len(flagged)}/{n_transcripts} transcripts (advisory; {detail})",
            assignee_role=contract.owner_role,
            payload={"run_id": run.id, "contract": code, "severity": contract.severity, "aggregate": True,
                     "lane": "advisory", "flagged_transcripts": [r.transcript.code for r in flagged][:60]},
        ))
        advisory += 1
    session.flush()
    return opened, advisory


def _fail_run(session: Session, run: Run, actor: str, error: str) -> RunOutcome:
    run.status = "FAILED"
    run.gate = "GREY"
    run.finished_at = utcnow()
    # Reassign: in-place mutation of a plain JSON column is not persisted.
    run.stats = {**(run.stats or {}), "error": error}
    audit.record(session, actor=actor, event_type="run.failed", entity_type="run", entity_id=run.id,
                 payload={"error": error})
    session.commit()
    return RunOutcome(run, deduplicated=False)


def execute_run(
    session: Session,
    settings: Settings,
    *,
    workflow_code: str,
    prompt_version: int,
    model_id: str,
    adapter_kind: str | None,
    rule_date: date,
    trigger: str = "MANUAL",
    limit: int | None = None,
    actor: str = "system",
    corpus: str = "synthetic",
    judge_model_id: str | None = None,
    judge_n: int | None = None,
    reuse_pre_override_run: bool = False,
    record: bool = False,
) -> RunOutcome:
    """One run: resolve → key (dedupe) → score → route review items → gate and stats.

    ``reuse_pre_override_run`` is for ``backstop demo`` only: when approved test cases
    change the key, a COMPLETE run under the key *without* them is returned instead of
    executing again, so restarting the demo never re-scores its story runs (their
    numbers are asserted). Every other caller leaves it off and honours the overrides.
    """
    workflow = session.scalar(select(Workflow).where(Workflow.code == workflow_code))
    if workflow is None:
        raise ValueError(f"unknown workflow {workflow_code}")
    pv = session.scalar(
        select(PromptVersion).where(PromptVersion.workflow_id == workflow.id, PromptVersion.version == prompt_version)
    )
    if pv is None:
        raise ValueError(f"unknown prompt version {prompt_version}")
    model = session.scalar(select(Model).where(Model.model_id == model_id))
    if model is None:
        raise ValueError(f"unknown model {model_id}")
    adapter_kind = _resolve_adapter(model, adapter_kind, settings)
    judge_model_id = judge_model_id or model_id
    if judge_model_id != model_id and model.provider == "simulated":
        raise ValueError("simulated runs judge with the simulated adapter only")
    if judge_n is not None and not 1 <= judge_n <= 10:
        raise ValueError("judge_n must be between 1 and 10")
    transcripts = _select_transcripts(session, corpus, limit)

    # ---- key: same inputs, same run (idempotent), unless the last attempt failed
    corpus_hash = hashlib.sha256("|".join(f"{t.code}:{t.corpus_hash}" for t in transcripts).encode()).hexdigest()[:16]
    cs_hash = contract_set_hash(settings.contracts_dir)
    tag = "" if judge_model_id == model_id and judge_n is None else f":judge={judge_model_id}:n={judge_n or 'default'}"
    # Approving an override changes what a run means, so it changes the key:
    # otherwise the rerun after approval would dedupe to the run before it.
    overrides = _approved_overrides(session, transcripts)
    pre_override_key = bounded_run_key(
        f"{workflow_code}:{pv.prompt_hash}:{model_id}:{adapter_kind}:{corpus_hash}:{cs_hash}:{rule_date.isoformat()}{tag}"
    )
    if overrides:
        tag += ":tc=" + hashlib.sha256("|".join(sorted(tc.id for tc in overrides.values())).encode()).hexdigest()[:8]
    run_key = bounded_run_key(
        f"{workflow_code}:{pv.prompt_hash}:{model_id}:{adapter_kind}:{corpus_hash}:{cs_hash}:{rule_date.isoformat()}{tag}"
    )
    existing = session.scalar(select(Run).where(Run.run_key == run_key))
    if existing is None and overrides and reuse_pre_override_run:
        existing = session.scalar(select(Run).where(Run.run_key == pre_override_key, Run.status == "COMPLETE"))
    retry_of: str | None = None
    if existing is not None and existing.status == "FAILED":
        # A failed run has no verdict to reuse; caching it would pin the failure
        # (e.g. a missing API key) forever. Retire its key and run again.
        retry_of = existing.id
        existing.run_key = bounded_run_key(f"{run_key}:failed:{existing.id[:8]}")
        session.flush()
        existing = None
    if existing is not None:
        audit.record(session, actor=actor, event_type="run.deduplicated", entity_type="run", entity_id=existing.id,
                     payload={"run_key": run_key})
        session.commit()
        return RunOutcome(existing, deduplicated=True)

    run = Run(run_key=run_key, workflow_id=workflow.id, prompt_version_id=pv.id, model_id=model.id,
              adapter=adapter_kind, corpus_hash=corpus_hash, contract_set_hash=cs_hash, rule_date=rule_date,
              trigger=trigger, status="RUNNING", gate="GREY", requested_by=actor,
              stats={"transcripts": len(transcripts), "corpus": corpus})
    session.add(run)
    session.flush()
    audit.record(session, actor=actor, event_type="run.started", entity_type="run", entity_id=run.id,
                 payload={"run_key": run_key, "prompt_version": prompt_version, "model": model_id,
                          "adapter": adapter_kind, "rule_date": rule_date.isoformat(), "trigger": trigger,
                          "retry_of": retry_of})
    try:
        adapter = ad.build_adapter(adapter_kind, model_id=model_id, fixtures_dir=settings.fixtures_dir,
                                   prompt_hash=pv.prompt_hash, api_key=settings.anthropic_api_key,
                                   judge_model_id=judge_model_id, record=record)
    except ValueError as exc:
        return _fail_run(session, run, actor, str(exc))

    # ---- score
    contracts = list(session.scalars(select(Contract)).all())
    versions = {c.id: c.versions[-1] for c in contracts}
    contracts_by_version = {c.versions[-1].id: c for c in contracts}
    logic_in_force = wf.rule_logic_from_params(_rule_params_in_force(session, rule_date))
    logic_declared = wf.rule_logic_from_params(_rule_params_declared(session, pv))
    results, errors, test_case_stats = _score(session, run, adapter, pv, transcripts, contracts, versions,
                                              logic_in_force, logic_declared, overrides, judge_n)
    if corpus == "holdout":
        # Held-out calls are never put in front of a reviewer: reading them would turn
        # them into development calls. Their results are for the numbers only.
        opened = advisory = 0
    else:
        opened, advisory = _route_review(session, run, results, contracts_by_version, len(transcripts),
                                         # hashed: dedupe_key is 200 chars and model ids can be long
                                         finding_scope=hashlib.sha256(
                                             f"{pv.prompt_hash}:{model_id}:{rule_date.isoformat()}".encode()
                                         ).hexdigest()[:16])

    # ---- gate: a run whose adapter produced nothing has no verdict — GREY, not RED
    run.status = "COMPLETE" if errors < len(transcripts) else "FAILED"
    run.gate = gate_for(results, contracts_by_version) if run.status == "COMPLETE" else "GREY"
    run.finished_at = utcnow()
    summary: dict[str, dict[str, int]] = {}
    for rr in results:
        code = contracts_by_version[rr.contract_version_id].code
        summary.setdefault(code, {"PASS": 0, "FAIL": 0, "FLAG": 0, "ERROR": 0})[rr.outcome] += 1

    # ---- judge canary (only when a judged contract ran): the judge re-scores fixed
    # notes against author-set bands. A calibration check, not longitudinal drift.
    judged = [c for c in contracts if c.kind == "JUDGED"]
    n_judge = int(judge_n or (versions[judged[0].id].n_runs if judged else 0) or 5)
    canary_set = canary.load_canary(settings.fixtures_dir) if judged else []
    judge_stability = None
    if judged and run.status == "COMPLETE":
        rubric = (versions[judged[0].id].spec or {}).get("rubric", "")
        judge_stability = canary.run_canary(adapter, rubric, canary_set, n_judge)
        if judge_stability is not None:
            judge_stability["judge_model_id"] = judge_model_id

    outputs = list(run.outputs)
    usage_in = sum(int((o.usage or {}).get("input_tokens", 0) or 0) for o in outputs)
    usage_out = sum(int((o.usage or {}).get("output_tokens", 0) or 0) for o in outputs)
    judged_calls = n_judge * (len(transcripts) + len(canary_set)) if judged else 0
    run.stats = {
        "transcripts": len(transcripts),
        "corpus": corpus,
        "adapter_errors": errors,
        "review_tasks_opened": opened,
        "advisory_items_opened": advisory,
        # approved overrides touching this corpus: applied = verdict differed and was set
        # aside by the test case; agreeing = the model now produces the corrected verdict.
        "test_cases": test_case_stats,
        "review_suppressed": "held-out corpus: results are numbers only" if corpus == "holdout" else None,
        "contracts": summary,
        "logic_in_force": logic_in_force,
        "logic_declared_by_prompt": logic_declared,
        "latency_ms_total": sum(o.latency_ms for o in outputs),
        "latency_ms_per_transcript": round(sum(o.latency_ms for o in outputs) / max(1, len(outputs))),
        "judge_stability": judge_stability,
        "judge_model_id": judge_model_id,
        "judge_n": n_judge if judged else None,
        "cost": cost.estimate(model_id, adapter_kind, len(transcripts), usage_in, usage_out, judged_calls=judged_calls),
    }
    audit.record(session, actor=actor, event_type="run.completed", entity_type="run", entity_id=run.id,
                 payload={"gate": run.gate, "status": run.status, "contracts": summary, "review_tasks_opened": opened,
                          "advisory_items_opened": advisory})
    session.commit()
    return RunOutcome(run, deduplicated=False)
