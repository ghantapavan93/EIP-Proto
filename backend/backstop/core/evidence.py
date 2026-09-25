"""Evidence bundles: "what happened and why", exportable for a carrier, CMS or counsel.

A bundle is one self-contained JSON document (or its Markdown rendering) for a
review task, a run, or a rule's blast radius on a date. It carries the rule
version and its ranked sources, the artifact version hash and the exact matched
span, the prompt/model/contract identifiers, the result, the human decision and
who made it, and every related audit row with its chain hash.

The bundle hashes itself (``bundle_sha256`` over the canonical JSON without that
field) and embeds the audit chain's verification result and tip hash, so a
recipient can tell later whether the log it points into has been altered.
Nothing here writes; the API records ``evidence.exported``.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from backstop import __version__
from backstop.core import audit, impact
from backstop.core.lanes import task_lane
from backstop.models import (
    AssetVersion,
    AuditEvent,
    ReviewTask,
    Rule,
    RuleAssetEdge,
    RuleVersion,
    Run,
    RunResult,
    TestCase,
)

SCHEMA = "backstop.evidence-bundle/v1"
_MAX_AUDIT_ROWS = 400


def _iso(value: datetime | date | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        value = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return value.isoformat()


def _rule_version(rv: RuleVersion) -> dict[str, Any]:
    return {
        "rule_code": rv.rule.code,
        "rule_title": rv.rule.title,
        "citation": rv.rule.citation,
        "regulator": rv.rule.regulator,
        "version": rv.version,
        "status": rv.status,
        "applies_from": _iso(rv.effective_from),
        "applies_to": _iso(rv.effective_to),
        "regulation_effective": _iso(rv.regulation_effective),
        "change_classification": rv.change_classification,
        "clause_text": rv.clause_text,
        "sources": rv.sources or [],
        "disputed": rv.disputed,
        "dispute_note": rv.dispute_note or None,
        "source_url": rv.source_url,
    }


def _edge(session: Session, edge: RuleAssetEdge) -> dict[str, Any]:
    av = session.get(AssetVersion, edge.asset_version_id) if edge.asset_version_id else None
    return {
        "edge_id": edge.id,
        "status": edge.status,
        "polarity": edge.polarity,
        "detection": edge.detection,
        "matcher": edge.matcher,
        "confidence": edge.confidence,
        "confirmed_by": edge.confirmed_by,
        "evidence_span": edge.evidence_span,
        "span_offset": edge.span_offset,
        "bound_rule_version": edge.rule_version.version,
        "artifact": {
            "code": edge.asset.code,
            "name": edge.asset.name,
            "type": edge.asset.type,
            "url": edge.asset.url,
            "synthetic": edge.asset.is_synthetic,
            "owner_role": edge.asset.owner_role,
            "version_sha256": av.content_hash if av else None,
            "fetched_at": _iso(av.fetched_at) if av else None,
            "fetch_mode": av.fetch_mode if av else None,
        },
    }


def _run(run: Run) -> dict[str, Any]:
    stats = run.stats or {}
    return {
        "run_id": run.id,
        "run_key": run.run_key,
        "workflow": run.workflow.code,
        "prompt": {"version": run.prompt_version.version, "label": run.prompt_version.label,
                   "sha256": run.prompt_version.prompt_hash},
        "model": {"id": run.model.model_id, "provider": run.model.provider, "label": run.model.label},
        "adapter": run.adapter,
        "rule_date": _iso(run.rule_date),
        "trigger": run.trigger,
        "status": run.status,
        "gate": run.gate,
        "corpus_sha256": run.corpus_hash,
        "contract_set_sha256": run.contract_set_hash,
        "requested_by": run.requested_by,
        "started_at": _iso(run.started_at),
        "finished_at": _iso(run.finished_at),
        "contracts": stats.get("contracts", {}),
        "judge": {"model_id": stats.get("judge_model_id"), "n": stats.get("judge_n"),
                  "stability": stats.get("judge_stability")},
        "error": stats.get("error"),
    }


def _result(rr: RunResult) -> dict[str, Any]:
    cv = rr.contract_version
    return {
        "result_id": rr.id,
        "contract": {"code": cv.contract.code, "title": cv.contract.title, "kind": cv.contract.kind,
                     "severity": cv.contract.severity, "version": cv.version},
        "transcript": rr.transcript.code,
        "transcript_synthetic": rr.transcript.synthetic,
        "outcome": rr.outcome,
        "evidence": rr.evidence,
    }


def _task(session: Session, task: ReviewTask) -> dict[str, Any]:
    cases = session.scalars(select(TestCase).where(TestCase.review_task_id == task.id)).all()
    return {
        "task_id": task.id,
        "kind": task.kind,
        "lane": task_lane(task),
        "state": task.state,
        "reason": task.reason,
        "assignee_role": task.assignee_role,
        "staleness_direction": task.staleness_direction,
        "decision": {"reason_code": task.reason_code, "note": task.note or None, "decided_by": task.decided_by,
                     "closed_at": _iso(task.closed_at)},
        "opened_at": _iso(task.opened_at),
        "test_cases": [{"id": c.id, "status": c.status, "created_by": c.created_by, "approver": c.approver,
                        "reason_code": c.reason_code, "expires_at": _iso(c.expires_at)} for c in cases],
    }


def _audit_rows(session: Session, entity_ids: set[str]) -> dict[str, Any]:
    """The audit rows about this subject, newest kept when there are more than the cap.

    Rows recording earlier exports of a bundle are left out: they describe the bundle,
    not the subject, and would otherwise crowd out the decisions a reader needs.
    `total` and `truncated` say whether the list is complete; a bundle never implies
    it holds every row when it does not.
    """
    ids = sorted(i for i in entity_ids if i)
    if not ids:
        return {"total": 0, "included": 0, "truncated": False, "rows": []}
    about = AuditEvent.entity_id.in_(ids)
    corr = set(session.scalars(select(AuditEvent.correlation_id).where(about, AuditEvent.correlation_id.is_not(None))
                               .distinct()).all())
    # Pull in every row written by the same actions (shared correlation id).
    related = or_(about, AuditEvent.correlation_id.in_(sorted(corr))) if corr else about
    related = and_(related, AuditEvent.event_type != "evidence.exported")
    total = session.scalar(select(func.count()).select_from(AuditEvent).where(related)) or 0
    rows = list(reversed(session.scalars(
        select(AuditEvent).where(related).order_by(AuditEvent.id.desc()).limit(_MAX_AUDIT_ROWS)).all()))
    return {"total": total, "included": len(rows), "truncated": total > len(rows), "rows": [
        {"id": r.id, "ts": _iso(r.ts), "actor": r.actor, "actor_role": r.actor_role, "event_type": r.event_type,
         "entity_type": r.entity_type, "entity_id": r.entity_id, "correlation_id": r.correlation_id,
         "payload": r.payload, "prev_hash": r.prev_hash, "row_hash": r.row_hash} for r in rows]}


def _with_audit(section: dict[str, Any], audit_rows: dict[str, Any]) -> dict[str, Any]:
    section["audit_events"] = audit_rows["rows"]
    section["audit_events_total"] = audit_rows["total"]
    section["audit_events_truncated"] = audit_rows["truncated"]
    return section


def _finalize(session: Session, bundle: dict[str, Any], *, actor: str, role: str) -> dict[str, Any]:
    chain = audit.verify_chain(session)
    bundle = {
        "schema": SCHEMA,
        "generator": f"backstop {__version__}",
        "generated_at": _iso(datetime.now(UTC)),
        "generated_by": {"actor": actor, "role": role},
        "environment": "PROTOTYPE · SYNTHETIC DATA",
        **bundle,
        "audit_chain": {"verified": chain["ok"], "rows_checked": chain["checked"], "tip_sha256": chain["tip"],
                        "first_broken_id": chain["first_broken_id"]},
    }
    bundle["bundle_sha256"] = digest(bundle)
    return bundle


def digest(bundle: dict[str, Any]) -> str:
    body = {k: v for k, v in bundle.items() if k != "bundle_sha256"}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ bundles


def for_task(session: Session, task: ReviewTask, *, actor: str, role: str) -> dict[str, Any]:
    subject: dict[str, Any] = {"review_task": _task(session, task)}
    entity_ids = {task.id}
    if task.rule_version_id:
        rv = session.get_one(RuleVersion, task.rule_version_id)
        subject["rule_version_in_force"] = _rule_version(rv)
        entity_ids.add(rv.id)
    if task.edge_id:
        edge = session.get_one(RuleAssetEdge, task.edge_id)
        subject["encoding"] = _edge(session, edge)
        subject["bound_rule_version"] = _rule_version(edge.rule_version)
        entity_ids |= {edge.id, edge.asset_id}
    if task.run_result_id:
        rr = session.get_one(RunResult, task.run_result_id)
        subject["result"] = _result(rr)
        subject["run"] = _run(rr.run)
        entity_ids |= {rr.run_id}
        if (task.payload or {}).get("aggregate"):
            subject["result"]["aggregate_transcripts"] = (task.payload or {}).get("flagged_transcripts", [])
    _with_audit(subject, _audit_rows(session, entity_ids))
    return _finalize(session, {"subject": {"type": "review_task", "id": task.id}, **subject}, actor=actor, role=role)


def for_run(session: Session, run: Run, *, actor: str, role: str) -> dict[str, Any]:
    findings = [_result(rr) for rr in run.results if rr.outcome in ("FAIL", "FLAG")]
    findings.sort(key=lambda r: (r["contract"]["severity"] != "BLOCK", r["contract"]["code"], r["transcript"]))
    tasks = session.scalars(select(ReviewTask).join(RunResult, ReviewTask.run_result_id == RunResult.id)
                            .where(RunResult.run_id == run.id)).all()
    entity_ids = {run.id} | {t.id for t in tasks}
    return _finalize(session, _with_audit({
        "subject": {"type": "run", "id": run.id},
        "run": _run(run),
        "blocking_failures": sum(1 for f in findings if f["outcome"] == "FAIL" and f["contract"]["severity"] == "BLOCK"),
        "findings": findings,
        "review_tasks": [_task(session, t) for t in tasks],
    }, _audit_rows(session, entity_ids)), actor=actor, role=role)


def for_rule(session: Session, rule: Rule, as_of: date, *, actor: str, role: str) -> dict[str, Any]:
    verdicts, counts, tasks = impact.evaluate_rule(session, rule, as_of, actor=actor, open_tasks=False)
    in_force = impact.in_force_version(rule, as_of)
    stale: list[dict[str, Any]] = []
    for v in verdicts:
        edge = session.get_one(RuleAssetEdge, v.edge_id)
        task = tasks.get(v.edge_id)
        stale.append({"direction": v.direction, "reason": v.reason, "bound_version": v.bound_version,
                      "in_force_version": v.in_force_version, "disputed": v.disputed,
                      "encoding": _edge(session, edge), "review_task": _task(session, task) if task else None})
    entity_ids = {rule.id} | {rv.id for rv in rule.versions} | {s["encoding"]["edge_id"] for s in stale}
    entity_ids |= {s["review_task"]["task_id"] for s in stale if s["review_task"]}
    return _finalize(session, _with_audit({
        "subject": {"type": "rule", "id": rule.code, "as_of": as_of.isoformat()},
        "rule_version_in_force": _rule_version(in_force) if in_force else None,
        "history": [_rule_version(rv) for rv in rule.versions],
        "counts": counts,
        "stale_encodings": stale,
    }, _audit_rows(session, entity_ids)), actor=actor, role=role)


# ------------------------------------------------------------------ markdown


def to_markdown(bundle: dict[str, Any]) -> str:
    """A human-first rendering. The JSON is the record; this is for reading."""
    subject = bundle["subject"]
    lines = [
        f"# Evidence bundle — {subject['type']} `{subject['id']}`",
        "",
        f"- Generated {bundle['generated_at']} by **{bundle['generated_by']['actor']}** "
        f"({bundle['generated_by']['role']}) · {bundle['generator']} · {bundle['environment']}",
        f"- Bundle SHA-256 `{bundle['bundle_sha256']}`",
        f"- Audit chain: {'verified' if bundle['audit_chain']['verified'] else 'BROKEN'} over "
        f"{bundle['audit_chain']['rows_checked']} rows · tip `{bundle['audit_chain']['tip_sha256']}`",
        "",
    ]

    def rule_block(title: str, rv: dict[str, Any] | None) -> None:
        if not rv:
            return
        lines.extend([
            f"## {title}",
            "",
            f"**{rv['rule_code']} v{rv['version']}** — {rv['rule_title']}  ",
            f"Citation: `{rv['citation']}`  ",
            f"Applies from **{rv['applies_from']}**"
            + (f" to {rv['applies_to']}" if rv["applies_to"] else "")
            + (f" · regulation effective {rv['regulation_effective']}" if rv["regulation_effective"] else "")
            + f" · {rv['change_classification']}" + (" · **DISPUTED**" if rv["disputed"] else ""),
            "",
            f"> {rv['clause_text']}",
            "",
        ])
        if rv["sources"]:
            lines.append("| Authority | Source | Reading |")
            lines.append("|---|---|---|")
            for src in rv["sources"]:
                lines.append(f"| {src['authority']} | [{src['cite']}]({src['url']}) | {src['reading']} |")
            lines.append("")
        if rv["dispute_note"]:
            lines.extend([f"Open question for counsel: {rv['dispute_note']}", ""])

    rule_block("Rule version in force", bundle.get("rule_version_in_force"))
    task = bundle.get("review_task")
    if task:
        decision = task["decision"]
        lines.extend([
            "## Review decision",
            "",
            f"- Task `{task['task_id']}` · {task['kind']} · lane **{task['lane']}** · state **{task['state']}**",
            f"- Owner role: {task['assignee_role']} · opened {task['opened_at']}",
            f"- Decided by: **{decision['decided_by'] or '—'}** · reason `{decision['reason_code'] or '—'}` · "
            f"closed {decision['closed_at'] or '—'}",
            *( [f"- Note: {decision['note']}"] if decision["note"] else [] ),
            *[f"- Test case `{c['id']}` {c['status']} (created by {c['created_by']}, approver {c['approver'] or '—'})"
              for c in task["test_cases"]],
            "",
        ])
    enc = bundle.get("encoding")
    if enc:
        art = enc["artifact"]
        lines.extend([
            "## Artifact evidence",
            "",
            f"- **{art['name']}** (`{art['code']}`, {art['type']}{', synthetic' if art['synthetic'] else ''})"
            + (f" — {art['url']}" if art["url"] else ""),
            f"- Version SHA-256 `{art['version_sha256']}` · fetched {art['fetched_at']} ({art['fetch_mode']})",
            f"- Bound to rule v{enc['bound_rule_version']} · {enc['polarity']} · {enc['detection']} "
            f"({enc['matcher']}) · edge {enc['status']}",
            "",
            f"> {enc['evidence_span']}",
            "",
        ])
    run = bundle.get("run")
    if run:
        lines.extend([
            "## Run",
            "",
            f"- Run `{run['run_id']}` · gate **{run['gate']}** · {run['status']} · trigger {run['trigger']}",
            f"- Workflow {run['workflow']} · prompt v{run['prompt']['version']} `{run['prompt']['sha256']}`",
            f"- Model `{run['model']['id']}` ({run['model']['provider']}) via {run['adapter']} · rules as of {run['rule_date']}",
            f"- Corpus `{run['corpus_sha256']}` · contract set `{run['contract_set_sha256']}` · requested by {run['requested_by']}",
            "",
        ])
    result = bundle.get("result")
    if result:
        c = result["contract"]
        lines.extend([
            "## Result",
            "",
            f"- {c['code']} v{c['version']} ({c['kind']}, {c['severity']}) on `{result['transcript']}` → **{result['outcome']}**",
            "",
            "```json",
            json.dumps(result["evidence"], indent=2, ensure_ascii=False),
            "```",
            "",
        ])
    if "findings" in bundle:
        lines.extend([f"## Findings ({len(bundle['findings'])}; {bundle['blocking_failures']} blocking)", "",
                      "| Contract | Severity | Transcript | Outcome |", "|---|---|---|---|"])
        lines.extend(f"| {f['contract']['code']} | {f['contract']['severity']} | {f['transcript']} | {f['outcome']} |"
                     for f in bundle["findings"])
        lines.append("")
    if "stale_encodings" in bundle:
        lines.extend([f"## Stale encodings as of {subject.get('as_of')} ({len(bundle['stale_encodings'])})", "",
                      "| Direction | Artifact | Bound → in force | Span |", "|---|---|---|---|"])
        for s in bundle["stale_encodings"]:
            span = s["encoding"]["evidence_span"].replace("|", "\\|")[:120]
            lines.append(f"| {s['direction']} | {s['encoding']['artifact']['name']} | "
                         f"v{s['bound_version']} → v{s['in_force_version']} | {span} |")
        lines.append("")
    events = bundle.get("audit_events", [])
    total = bundle.get("audit_events_total", len(events))
    heading = (f"## Audit trail (newest {len(events)} of {total} rows; earlier rows are in the audit log)"
               if bundle.get("audit_events_truncated") else f"## Audit trail ({len(events)} rows)")
    lines.extend([heading, "", "| # | Time (UTC) | Actor | Event | Entity | Row hash |",
                  "|---|---|---|---|---|---|"])
    lines.extend(f"| {e['id']} | {e['ts']} | {e['actor']} ({e['actor_role']}) | {e['event_type']} | "
                 f"{e['entity_type']} `{e['entity_id'][:8]}` | `{e['row_hash'][:12]}` |" for e in events)
    lines.append("")
    return "\n".join(lines)
