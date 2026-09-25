"""ORM → schema helpers shared by routers."""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backstop import schemas as s
from backstop.core.impact import in_force_version
from backstop.core.lanes import task_lane  # noqa: F401 — re-exported for api modules
from backstop.core.state_machine import allowed_for_role
from backstop.models import (
    Asset,
    AssetVersion,
    Contract,
    ContractVersion,
    ReviewTask,
    Rule,
    RuleAssetEdge,
    RuleVersion,
    Run,
    RunResult,
    Transcript,
)


def edge_out(session: Session, edge: RuleAssetEdge) -> s.EdgeOut:
    rv = edge.rule_version
    asset = edge.asset
    return s.EdgeOut(
        id=edge.id,
        rule_version_id=rv.id,
        rule_version=rv.version,
        rule_code=rv.rule.code,
        asset_id=asset.id,
        asset_code=asset.code,
        asset_name=asset.name,
        asset_type=asset.type,
        asset_url=asset.url,
        asset_is_synthetic=asset.is_synthetic,
        owner_role=asset.owner_role,
        polarity=edge.polarity,
        evidence_span=edge.evidence_span,
        span_offset=edge.span_offset,
        detection=edge.detection,
        matcher=edge.matcher,
        confidence=edge.confidence,
        status=edge.status,
        confirmed_by=edge.confirmed_by,
        created_at=edge.created_at,
    )


def _version_out(v: RuleVersion) -> s.RuleVersionOut:
    out = s.RuleVersionOut.model_validate(v)
    # Internal bookkeeping (loader fingerprints) is not part of the rule.
    out.params = {k: val for k, val in (v.params or {}).items() if not str(k).startswith("_")}
    return out


def rule_out(session: Session, rule: Rule, as_of: date | None = None) -> s.RuleOut:
    as_of = as_of or date.today()
    current = in_force_version(rule, as_of)
    version_ids = [v.id for v in rule.versions]
    dependents = 0
    if version_ids:
        dependents = session.scalar(
            select(func.count(RuleAssetEdge.id)).where(
                RuleAssetEdge.rule_version_id.in_(version_ids), RuleAssetEdge.status == "confirmed"
            )
        ) or 0
    return s.RuleOut(
        id=rule.id,
        code=rule.code,
        title=rule.title,
        regulator=rule.regulator,
        citation=rule.citation,
        applies_to=list(rule.applies_to or []),
        summary=rule.summary,
        source_url=rule.source_url,
        versions=[_version_out(v) for v in rule.versions],
        in_force_version=current.version if current else None,
        dependents=dependents,
        contracts=[c.code for c in rule.contracts],
    )


def asset_out(session: Session, asset: Asset, *, detail: bool = False) -> s.AssetOut | s.AssetDetailOut:
    latest = session.scalar(
        select(AssetVersion).where(AssetVersion.asset_id == asset.id).order_by(AssetVersion.fetched_at.desc())
    )
    edge_count = session.scalar(select(func.count(RuleAssetEdge.id)).where(RuleAssetEdge.asset_id == asset.id)) or 0
    versions = [
        s.AssetVersionOut(id=v.id, content_hash=v.content_hash, fetched_at=v.fetched_at, fetch_mode=v.fetch_mode,
                          length=len(v.content_text))
        for v in asset.versions
    ]
    base: dict[str, Any] = dict(
        id=asset.id, code=asset.code, type=asset.type, name=asset.name, url=asset.url,
        source_system=asset.source_system, owner_role=asset.owner_role, is_synthetic=asset.is_synthetic,
        latest_hash=latest.content_hash if latest else None,
        latest_fetched_at=latest.fetched_at if latest else None,
        edge_count=edge_count, versions=versions,
    )
    if not detail:
        return s.AssetOut(**base)
    edges = session.scalars(select(RuleAssetEdge).where(RuleAssetEdge.asset_id == asset.id)).all()
    return s.AssetDetailOut(**base, content_text=latest.content_text if latest else "",
                            edges=[edge_out(session, e) for e in edges])


def contract_out(contract: Contract) -> s.ContractOut:
    cv: ContractVersion | None = contract.versions[-1] if contract.versions else None
    return s.ContractOut(
        id=contract.id, code=contract.code, title=contract.title, description=contract.description,
        kind=contract.kind, severity=contract.severity, owner_role=contract.owner_role, check=contract.check,
        rule_code=contract.rule.code if contract.rule else None,
        version=cv.version if cv else 1, spec=dict(cv.spec or {}) if cv else {},
        judge_model_id=cv.judge_model_id if cv else None, n_runs=cv.n_runs if cv else None,
    )


def run_out(session: Session, run: Run, *, deduplicated: bool = False) -> s.RunOut:
    contracts = session.scalars(select(Contract)).all()
    by_version = {c.versions[-1].id: c for c in contracts if c.versions}
    summary = run.stats.get("contracts", {}) if run.stats else {}
    contract_rows = []
    for c in contracts:
        counts = summary.get(c.code, {})
        contract_rows.append(
            s.ContractSummary(
                code=c.code, title=c.title, severity=c.severity, kind=c.kind,
                rule_code=c.rule.code if c.rule else None,
                passed=counts.get("PASS", 0), failed=counts.get("FAIL", 0),
                flagged=counts.get("FLAG", 0), errored=counts.get("ERROR", 0),
            )
        )
    _ = by_version
    return s.RunOut(
        id=run.id, run_key=run.run_key, workflow_code=run.workflow.code,
        prompt_version=run.prompt_version.version, prompt_label=run.prompt_version.label,
        prompt_hash=run.prompt_version.prompt_hash, model_id=run.model.model_id, model_label=run.model.label,
        adapter=run.adapter, corpus_hash=run.corpus_hash, corpus=(run.stats or {}).get("corpus", "synthetic"),
        contract_set_hash=run.contract_set_hash,
        rule_date=run.rule_date, trigger=run.trigger, status=run.status, gate=run.gate,
        started_at=run.started_at, finished_at=run.finished_at, stats=run.stats or {},
        requested_by=run.requested_by, deduplicated=deduplicated, contracts=contract_rows,
    )


def result_out(rr: RunResult) -> s.RunResultOut:
    return s.RunResultOut(
        id=rr.id, transcript_code=rr.transcript.code, contract_code=rr.contract_version.contract.code,
        severity=rr.contract_version.contract.severity, outcome=rr.outcome, evidence=rr.evidence,
        latency_ms=rr.latency_ms,
    )


def transcript_out(t: Transcript, *, with_text: bool = False) -> s.TranscriptOut:
    return s.TranscriptOut(id=t.id, code=t.code, product_line=t.product_line, synthetic=t.synthetic,
                           duration_seconds=t.duration_seconds, labels=t.labels, text=t.text if with_text else None)


def task_out(session: Session, task: ReviewTask, role: str) -> s.ReviewTaskOut:
    rule_code = rule_version = None
    if task.rule_version_id:
        rv = session.get(RuleVersion, task.rule_version_id)
        if rv:
            rule_code, rule_version = rv.rule.code, rv.version
    asset = session.get(Asset, task.asset_id) if task.asset_id else None
    edge = session.get(RuleAssetEdge, task.edge_id) if task.edge_id else None
    rr = session.get(RunResult, task.run_result_id) if task.run_result_id else None
    allowed = sorted(allowed_for_role(task.kind, task.state, role))
    return s.ReviewTaskOut(
        id=task.id, kind=task.kind, state=task.state, rule_code=rule_code, rule_version=rule_version,
        asset_code=asset.code if asset else None, asset_name=asset.name if asset else None,
        asset_type=asset.type if asset else None, asset_is_synthetic=asset.is_synthetic if asset else None,
        edge_id=task.edge_id, evidence_span=edge.evidence_span if edge else None,
        run_result_id=task.run_result_id, run_id=rr.run_id if rr else None,
        contract_code=rr.contract_version.contract.code if rr else None,
        transcript_code=rr.transcript.code if rr else None,
        staleness_direction=task.staleness_direction, reason=task.reason, assignee_role=task.assignee_role,
        reason_code=task.reason_code, note=task.note, decided_by=task.decided_by, opened_at=task.opened_at,
        closed_at=task.closed_at, payload=task.payload, allowed_transitions=allowed, lane=task_lane(task),
    )
