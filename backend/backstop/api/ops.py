"""Operational endpoints: evals, rule-source watch, exports, prompt diff, ingest, deep health.

These are the answers to "why not Braintrust?", "what's your false-positive
rate?", "who tells the corpus the CFR changed?", "how does my data get in?",
and "where are the logs?".
"""

from __future__ import annotations

import csv
import difflib
import io
import json
from datetime import UTC, datetime
from typing import Literal

import yaml
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse
from sqlalchemy import func, select, text

from backstop import __version__
from backstop import schemas as s
from backstop.api.deps import SessionDep, SettingsDep, User, UserDep, require_role
from backstop.core import audit
from backstop.harness import ingest as ingest_mod
from backstop.models import (
    Asset,
    AssetVersion,
    Contract,
    PromptVersion,
    ReviewTask,
    Rule,
    RuleSourceCheck,
    Run,
    RunResult,
    Scan,
    Transcript,
)
from backstop.scanner import evaluate as eval_mod
from backstop.scanner import sources as sources_mod

router = APIRouter(tags=["ops"])

MAX_INGEST_BYTES = 20_000_000


# ------------------------------------------------------------------ health (deep)


def _component(name: str, state: str, detail: str, *, required: bool = True) -> dict[str, object]:
    return {"name": name, "state": state, "detail": detail, "required": required}


def _health(session, settings) -> dict[str, object]:
    """Component-level readiness. Optional providers never make the app unhealthy."""
    from backstop.harness import providers as pv
    from backstop.harness.contracts import REGISTRY
    from backstop.harness.openai_compat import probe_ollama_cached

    checks: dict[str, object] = {"version": __version__, "time": datetime.now(UTC).isoformat()}
    checks.update(rules=0, contracts=0, transcripts=0, artifact_versions=0, artifacts=0, last_scan=None)
    components: list[dict[str, object]] = [_component("api", "healthy", f"backstop {__version__}")]
    try:
        session.execute(text("SELECT 1"))
        checks["rules"] = session.scalar(select(func.count(Rule.id))) or 0
        checks["contracts"] = session.scalar(select(func.count(Contract.id))) or 0
        holdout = session.scalar(select(func.count(Transcript.id)).where(Transcript.code.like("H%"))) or 0
        checks["transcripts"] = (session.scalar(select(func.count(Transcript.id))) or 0) - holdout
        checks["holdout_transcripts"] = holdout
        checks["artifact_versions"] = session.scalar(select(func.count(AssetVersion.id))) or 0
        checks["artifacts"] = session.scalar(select(func.count(Asset.id))) or 0
        last_scan = session.scalar(select(Scan).order_by(Scan.started_at.desc()))
        checks["last_scan"] = {"id": last_scan.id, "status": last_scan.status,
                               "finished_at": s._as_utc(last_scan.finished_at).isoformat() if last_scan.finished_at else None} if last_scan else None
        checks["database"] = "ok"
        dialect = session.get_bind().dialect.name
        components.append(_component("database", "healthy", "PostgreSQL" if dialect == "postgresql" else dialect))
    except Exception as exc:  # noqa: BLE001 — readiness reports, it does not raise
        session.rollback()
        checks["database"] = f"error: {type(exc).__name__}"
        components.append(_component("database", "down", type(exc).__name__))
    db_ok = checks["database"] == "ok"
    components.append(_component("rules", "healthy" if checks["rules"] else "down", f"{checks['rules']} loaded"))
    components.append(_component("artifacts", "healthy" if checks["artifacts"] else "down",
                                 f"{checks['artifacts']} registered · {checks['artifact_versions']} versions"))
    missing = []
    if db_ok:
        missing = sorted({c.check for c in session.scalars(select(Contract)).all()} - set(REGISTRY))
    components.append(_component(
        "runner", "healthy" if db_ok and checks["contracts"] and not missing else "down",
        f"{checks['contracts']} contracts · {len(REGISTRY)} checks registered"
        + (f" · missing {', '.join(missing)}" if missing else "")))
    probe = probe_ollama_cached(pv.PROVIDERS["ollama"].base_url)
    components.append(_component(
        "ollama", "healthy" if probe["reachable"] else "offline",
        f"{len(probe['models'])} local models" if probe["reachable"] else "not reachable — recorded cassettes still replay",
        required=False))
    required_ok = all(c["state"] == "healthy" for c in components if c["required"])
    checks["components"] = components
    checks["status"] = "healthy" if required_ok else ("degraded" if db_ok else "down")
    checks["default_credentials"] = settings.uses_default_credentials()
    checks["adapters"] = {"simulated": True, "cassette": True, "anthropic": bool(settings.anthropic_api_key),
                          "live": probe["reachable"] or any(p.available() for n, p in pv.PROVIDERS.items() if n != "ollama")}
    checks["ready"] = required_ok
    return checks


@router.get("/health/deep")
def deep_health(session: SessionDep, settings: SettingsDep):
    """Readiness with substance: DB reachable, corpus loaded, runner wired, providers probed."""
    return _health(session, settings)


@router.get("/status")
def status_rail(session: SessionDep, settings: SettingsDep, user: UserDep):
    """Everything the global status rail shows, from live state (nothing hardcoded)."""
    from backstop.api.serializers import task_lane

    health = _health(session, settings)
    golden = yaml.safe_load((settings.fixtures_dir / "matcher_golden.yaml").read_text(encoding="utf-8"))
    last_run = session.scalar(select(Run).where(Run.status.in_(("COMPLETE", "FAILED")))
                              .order_by(Run.finished_at.desc().nulls_last()))
    # Same definition as /api/readiness: everything not yet closed (open, in review,
    # verified awaiting republish) is outstanding work, not just untouched tasks.
    from backstop.api.readiness import _open_states

    open_tasks = session.scalars(select(ReviewTask).where(ReviewTask.state.in_(_open_states()))).all()
    lanes = {"actionable": 0, "advisory": 0}
    for t in open_tasks:
        lanes[task_lane(t)] += 1
    chain = audit.verify_chain(session) if health["database"] == "ok" else {"ok": False, "checked": 0}
    return {
        "status": health["status"],
        "components": health["components"],
        "counts": {"rules": health["rules"], "artifacts": health["artifacts"], "contracts": health["contracts"],
                   "golden_cases": len(golden.get("cases", [])), "transcripts": health["transcripts"]},
        "last_run": {"id": last_run.id, "finished_at": s._as_utc(last_run.finished_at) if last_run.finished_at else None,
                     "gate": last_run.gate, "status": last_run.status, "model_id": last_run.model.model_id,
                     "prompt_version": last_run.prompt_version.version, "trigger": last_run.trigger} if last_run else None,
        "review": {"actionable_open": lanes["actionable"], "advisory_open": lanes["advisory"]},
        "audit_chain": {"verified": chain["ok"], "rows": chain["checked"]},
        "user": {"name": user.name, "role": user.role},
        "environment_label": settings.environment_label,
    }


# ------------------------------------------------------------------ matcher evaluation


@router.get("/evals/matchers")
def matcher_eval(settings: SettingsDep, user: UserDep):
    report = eval_mod.evaluate(settings.fixtures_dir / "matcher_golden.yaml")
    return report.to_dict()


@router.get("/evals/matchers.md", response_class=PlainTextResponse)
def matcher_eval_markdown(settings: SettingsDep, user: UserDep):
    path = settings.fixtures_dir / "matcher_golden.yaml"
    return eval_mod.render_markdown(eval_mod.evaluate(path), path)


# ------------------------------------------------------------------ rule sources


@router.get("/rules/{code}/sources")
def rule_source_history(code: str, session: SessionDep, user: UserDep):
    rule = session.scalar(select(Rule).where(Rule.code == code))
    if rule is None:
        raise HTTPException(404, "rule not found")
    rows = session.scalars(
        select(RuleSourceCheck).where(RuleSourceCheck.rule_id == rule.id).order_by(RuleSourceCheck.checked_at.desc())
    ).all()
    return [{"id": r.id, "source_url": r.source_url, "content_hash": r.content_hash, "excerpt": r.excerpt,
             "fetch_mode": r.fetch_mode, "error": r.error, "changed": r.changed, "checked_at": s._as_utc(r.checked_at)}
            for r in rows]


@router.post("/sources/check")
def check_rule_sources(session: SessionDep, settings: SettingsDep, live: bool = False,
                       user: User = Depends(require_role("engineer", "admin"))):
    # `live` is scoped to this call. Never flip settings.crawler_live here: the
    # Settings object is process-wide (lru_cache) and would turn every later
    # scan into a live crawl.
    return sources_mod.check_sources(session, settings, live=live, actor=user.name)


# ------------------------------------------------------------------ prompt diff


@router.get("/prompts/diff")
def prompt_diff(session: SessionDep, user: UserDep, a: str = Query(...), b: str = Query(...)):
    pa, pb = session.get(PromptVersion, a), session.get(PromptVersion, b)
    if pa is None or pb is None:
        raise HTTPException(404, "prompt version not found")
    diff = list(difflib.unified_diff(
        pa.text.splitlines(), pb.text.splitlines(),
        fromfile=f"v{pa.version} ({pa.prompt_hash})", tofile=f"v{pb.version} ({pb.prompt_hash})", lineterm="",
    ))
    deps_a = {(d["rule"], d["version"]) for d in pa.encodes_rule_versions}
    deps_b = {(d["rule"], d["version"]) for d in pb.encodes_rule_versions}
    return {
        "a": {"id": pa.id, "version": pa.version, "label": pa.label, "prompt_hash": pa.prompt_hash},
        "b": {"id": pb.id, "version": pb.version, "label": pb.label, "prompt_hash": pb.prompt_hash},
        "unified_diff": diff,
        "rule_dependencies": {
            "removed": [{"rule": r, "version": v} for r, v in sorted(deps_a - deps_b)],
            "added": [{"rule": r, "version": v} for r, v in sorted(deps_b - deps_a)],
            "unchanged": [{"rule": r, "version": v} for r, v in sorted(deps_a & deps_b)],
        },
    }


# ------------------------------------------------------------------ exports


def _results_rows(session, run: Run):
    for rr in session.scalars(select(RunResult).where(RunResult.run_id == run.id)).all():
        contract = rr.contract_version.contract
        yield {
            "run_id": run.id, "run_key": run.run_key, "workflow": run.workflow.code, "prompt_version": run.prompt_version.version,
            "prompt_hash": run.prompt_version.prompt_hash, "model_id": run.model.model_id, "adapter": run.adapter,
            "rule_date": run.rule_date.isoformat(), "trigger": run.trigger, "gate": run.gate,
            "transcript": rr.transcript.code, "product_line": rr.transcript.product_line,
            "contract": contract.code, "severity": contract.severity, "kind": contract.kind, "outcome": rr.outcome,
            "evidence": rr.evidence, "latency_ms": rr.latency_ms,
        }


_CSV_FORMULA_PREFIXES = frozenset({"=", "+", "-", "@", chr(9), chr(13)})


def _csv_safe(value):
    """Neutralise spreadsheet formula injection (a transcript code like =HYPERLINK(...))."""
    if isinstance(value, str) and value[:1] in _CSV_FORMULA_PREFIXES:
        return "'" + value
    return value


@router.get("/runs/{run_id}/export")
def export_run(run_id: str, session: SessionDep, user: UserDep,
               format: Literal["braintrust", "langsmith", "csv"] = Query("braintrust")):
    """Export a run in the shape an eval vendor ingests, or as flat CSV for Power BI.

    braintrust → one record per (transcript, contract): {input, output, expected, scores, metadata}
    langsmith  → one example per transcript: {inputs, outputs, metadata} with per-contract feedback
    csv        → flat rows for Snowflake/Power BI
    """
    run = session.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    rows = list(_results_rows(session, run))
    audit.record(session, actor=user.name, event_type="export.generated", entity_type="run", entity_id=run.id,
                 payload={"format": format, "rows": len(rows)})
    session.commit()
    if format == "csv":
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=[k for k in rows[0].keys() if k != "evidence"] + ["evidence_json"] if rows else ["empty"])
        writer.writeheader()
        for r in rows:
            flat = {k: _csv_safe(v) for k, v in r.items() if k != "evidence"}
            flat["evidence_json"] = _csv_safe(json.dumps(r["evidence"], ensure_ascii=False))
            writer.writerow(flat)
        return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                                 headers={"Content-Disposition": f"attachment; filename=backstop-run-{run.id[:8]}.csv"})
    if format == "braintrust":
        records = [{
            "input": {"transcript": r["transcript"], "prompt_hash": r["prompt_hash"], "rule_date": r["rule_date"]},
            "output": {"contract": r["contract"], "outcome": r["outcome"]},
            "expected": {"outcome": "PASS"},
            "scores": {r["contract"]: 1.0 if r["outcome"] == "PASS" else 0.0},
            "metadata": {k: r[k] for k in ("model_id", "adapter", "severity", "kind", "trigger", "gate", "product_line")},
            "evidence": r["evidence"],
        } for r in rows]
        return {"format": "braintrust", "project": "backstop", "experiment": run.run_key, "records": records}
    if format == "langsmith":
        by_transcript: dict[str, dict] = {}
        for r in rows:
            ex = by_transcript.setdefault(r["transcript"], {
                "inputs": {"transcript": r["transcript"], "prompt_hash": r["prompt_hash"], "rule_date": r["rule_date"]},
                "outputs": {}, "metadata": {"model_id": r["model_id"], "adapter": r["adapter"], "gate": r["gate"]},
                "feedback": [],
            })
            ex["feedback"].append({"key": r["contract"], "score": 1.0 if r["outcome"] == "PASS" else 0.0,
                                   "value": r["outcome"], "comment": json.dumps(r["evidence"])[:500]})
        return {"format": "langsmith", "dataset": "backstop", "experiment": run.run_key, "examples": list(by_transcript.values())}
    raise HTTPException(422, "format must be braintrust, langsmith or csv")


# ------------------------------------------------------------------ ingest


@router.post("/ingest/transcripts")
async def ingest_transcripts(file: UploadFile, session: SessionDep,
                             user: User = Depends(require_role("engineer", "admin")), format: str = Query("attention-snowflake")):
    """Load transcripts from an export file. Nothing here is EIP's data; the shape is documented in
    fixtures/attention_export_sample.csv and must be confirmed against the real export."""
    data = await file.read(MAX_INGEST_BYTES + 1)
    if len(data) > MAX_INGEST_BYTES:
        raise HTTPException(413, f"export larger than {MAX_INGEST_BYTES // 1_000_000} MB; split it or use the batch loader")
    try:
        raw = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        # Excel on Windows saves plain "CSV" as cp1252; decoding it as UTF-8 would turn
        # every curly quote and accented name into U+FFFD.
        raw = data.decode("cp1252", errors="replace")
    try:
        report = ingest_mod.ingest_csv(session, raw, fmt=format, actor=user.name)
    except ingest_mod.IngestError as exc:
        raise HTTPException(422, str(exc)) from exc
    return report


@router.get("/ingest/formats")
def ingest_formats(user: UserDep):
    return ingest_mod.FORMATS


# ------------------------------------------------------------------ schemas re-exported for docs


_ = s
