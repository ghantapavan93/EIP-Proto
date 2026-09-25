"""Change-impact evaluation: rule versions × edges × as-of date → stale set + review tasks.

Shared by the API (`GET /rules/{code}/impact`) and the scanner (which
re-evaluates after every scan). Task creation is idempotent by construction:
one STALE_ASSET task per (rule version in force, artifact).
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from backstop.core import audit
from backstop.core.staleness import (
    NEVER_IN_FORCE,
    EdgeView,
    StaleVerdict,
    VersionView,
    evaluate,
    summarize,
)
from backstop.models import Asset, ReviewTask, Rule, RuleAssetEdge, RuleVersion


def version_views(rule: Rule) -> list[VersionView]:
    return [
        VersionView(
            id=v.id,
            version=v.version,
            status=v.status,
            effective_from=v.effective_from,
            effective_to=v.effective_to,
            change_classification=v.change_classification,
            disputed=v.disputed,
        )
        for v in rule.versions
    ]


def edge_views(session: Session, rule: Rule) -> list[EdgeView]:
    version_ids = [v.id for v in rule.versions]
    if not version_ids:
        return []
    edges = session.scalars(
        select(RuleAssetEdge).where(RuleAssetEdge.rule_version_id.in_(version_ids))
    ).all()
    return [
        EdgeView(
            id=e.id,
            asset_id=e.asset_id,
            bound_version_id=e.rule_version_id,
            polarity=e.polarity,
            status=e.status,
        )
        for e in edges
    ]


def evaluate_rule(
    session: Session,
    rule: Rule,
    as_of: date,
    *,
    actor: str = "system",
    open_tasks: bool = True,
    always_audit: bool = False,
) -> tuple[list[StaleVerdict], dict[str, int], dict[str, ReviewTask]]:
    """Compute verdicts; optionally upsert STALE_ASSET tasks. Returns (verdicts, counts, tasks_by_edge).

    A `staleness.evaluated` audit event is written when the evaluation changed
    something (opened tasks) or when the caller asks for it (scans). Reads from
    the UI that change nothing do not spam the log.
    """
    verdicts = evaluate(version_views(rule), edge_views(session, rule), as_of)
    counts = summarize(verdicts)
    in_force = in_force_version(rule, as_of)
    tasks_by_edge: dict[str, ReviewTask] = {}
    if in_force is None:
        return verdicts, counts, tasks_by_edge

    opened = 0
    for verdict in verdicts:
        dedupe_key = f"stale:{in_force.id}:{verdict.asset_id}"
        task = session.scalar(select(ReviewTask).where(ReviewTask.dedupe_key == dedupe_key))
        if task is None and open_tasks:
            asset = session.get(Asset, verdict.asset_id)
            task = ReviewTask(
                kind="STALE_ASSET",
                dedupe_key=dedupe_key,
                state="open",
                rule_version_id=in_force.id,
                asset_id=verdict.asset_id,
                edge_id=verdict.edge_id,
                staleness_direction=verdict.direction,
                reason=verdict.reason,
                assignee_role=(asset.owner_role if asset else "compliance"),
                payload={
                    "rule": rule.code,
                    "bound_version": verdict.bound_version,
                    "in_force_version": verdict.in_force_version,
                    "as_of": as_of.isoformat(),
                    "disputed": verdict.disputed,
                },
            )
            session.add(task)
            session.flush()
            opened += 1
            audit.record(
                session,
                actor=actor,
                event_type="task.opened",
                entity_type="review_task",
                entity_id=task.id,
                payload={
                    "kind": task.kind,
                    "rule": rule.code,
                    "asset_id": verdict.asset_id,
                    "direction": verdict.direction,
                    "reason": verdict.reason,
                },
            )
        if task is not None:
            tasks_by_edge[verdict.edge_id] = task

    if opened or always_audit:
        audit.record(
            session,
            actor=actor,
            event_type="staleness.evaluated",
            entity_type="rule",
            entity_id=rule.id,
            payload={
                "rule": rule.code,
                "as_of": as_of.isoformat(),
                "in_force_version": in_force.version,
                "counts": counts,
                "tasks_opened": opened,
                "stale_asset_ids": [v.asset_id for v in verdicts],
            },
        )
    return verdicts, counts, tasks_by_edge


def evaluate_all(session: Session, as_of: date, *, actor: str = "system") -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for rule in session.scalars(select(Rule)).all():
        _, counts, _ = evaluate_rule(session, rule, as_of, actor=actor, always_audit=True)
        out[rule.code] = counts
    return out


def in_force_version(rule: Rule, as_of: date) -> RuleVersion | None:
    """Mirror of ``staleness.version_in_force`` for ORM rows (proposed, vacated and stayed
    versions are never in force)."""
    for v in rule.versions:
        if v.status in NEVER_IN_FORCE or v.effective_from is None:
            continue
        if v.effective_from <= as_of and (v.effective_to is None or as_of <= v.effective_to):
            return v
    return None
