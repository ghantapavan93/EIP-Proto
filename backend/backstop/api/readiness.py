"""Readiness: what changes in the next 30/60/90 days, who owns the open work, and the
countdown to the next marketing season. Read-only: it evaluates staleness in memory and
never opens a task or writes an audit row.

Calendar facts (annual, verified against the CFR):
  * CY(N+1) marketing may begin October 1 of year N (42 CFR 422.2263(a)).
  * Annual coordinated election period (AEP): October 15 – December 7 (42 CFR 422.62(a)(2)(iii)).
  * MA Open Enrollment Period: January 1 – March 31 (42 CFR 422.62(a)(3)(i)).
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Query
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from backstop import schemas as s
from backstop.api.deps import SessionDep, UserDep
from backstop.core.impact import version_views
from backstop.core.lanes import lane_for
from backstop.core.rules_loader import is_api_proposal
from backstop.core.staleness import NEVER_IN_FORCE, SET_ASIDE, EdgeView, VersionView, evaluate
from backstop.core.state_machine import TRANSITIONS
from backstop.models import ReviewTask, Rule, RuleAssetEdge, utcnow

router = APIRouter(tags=["readiness"])

# Older rows used another slug for the same team; one owner must read as one queue.
_ROLE_ALIASES = {"qa-compliance": "compliance"}

MILESTONE_HORIZON_DAYS = 365
BANDS: tuple[tuple[str, int, int], ...] = (("30", 0, 30), ("60", 31, 60), ("90", 61, 90))
_KIND_ORDER = {"marketing_start": 0, "aep_start": 1, "aep_end": 2, "oep_start": 3, "rule_applies": 4,
               "vote": 5, "deferral_ends": 6}
_WHY_MAX = 400
_LABEL_CLAUSE_MAX = 90


def _next_on_or_after(as_of: date, month: int, day: int) -> date:
    candidate = date(as_of.year, month, day)
    return candidate if candidate >= as_of else date(as_of.year + 1, month, day)


def _calendar(as_of: date) -> list[dict]:
    marketing = _next_on_or_after(as_of, 10, 1)
    aep_start = _next_on_or_after(as_of, 10, 15)
    aep_end = _next_on_or_after(as_of, 12, 7)
    oep_start = _next_on_or_after(as_of, 1, 1)
    return [
        {"date": marketing, "kind": "marketing_start",
         "label": f"CY{marketing.year + 1} marketing may begin (42 CFR 422.2263(a))"},
        {"date": aep_start, "kind": "aep_start", "label": f"AEP opens for CY{aep_start.year + 1} coverage"},
        {"date": aep_end, "kind": "aep_end", "label": f"AEP closes (CY{aep_end.year + 1} coverage)"},
        {"date": oep_start, "kind": "oep_start", "label": f"MA Open Enrollment Period opens (CY{oep_start.year})"},
    ]


def _is_open(kind: str, state: str) -> bool:
    """Open = the state machine still allows a move out of this state for this kind."""
    moves = TRANSITIONS.get(kind)
    return bool(moves.get(state)) if moves is not None else state == "open"


def _open_states() -> set[str]:
    return {state for moves in TRANSITIONS.values() for state, nxt in moves.items() if nxt} | {"open"}


def _age_days(opened_at: datetime, now: datetime) -> float:
    opened = opened_at if opened_at.tzinfo is not None else opened_at.replace(tzinfo=UTC)
    return max(0.0, (now - opened).total_seconds() / 86_400)


def _clip(text: str, limit: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _why(summary: str, clause: str) -> str:
    return _clip(summary or clause, _WHY_MAX)


@router.get("/readiness", response_model=s.ReadinessOut)
def readiness(session: SessionDep, user: UserDep, as_of: date = Query(default_factory=date.today)):
    """Are we ready? Milestones for the next year, the 30/60/90-day horizon of rule versions that
    start applying (with the stale encodings they would expose that day), open work per owner,
    and the countdown to the next marketing season. Nothing is written."""
    now = utcnow()
    # Three queries: rules with versions, confirmed edges, open tasks.
    rules = session.scalars(select(Rule).options(selectinload(Rule.versions)).order_by(Rule.code)).all()
    rule_by_version: dict[str, Rule] = {v.id: r for r in rules for v in r.versions}
    edges_by_rule: dict[str, list[EdgeView]] = defaultdict(list)
    for edge_id, asset_id, version_id, polarity in session.execute(
        select(RuleAssetEdge.id, RuleAssetEdge.asset_id, RuleAssetEdge.rule_version_id, RuleAssetEdge.polarity)
        .where(RuleAssetEdge.status == "confirmed")
    ):
        rule = rule_by_version.get(version_id)
        if rule is not None:
            edges_by_rule[rule.id].append(EdgeView(id=edge_id, asset_id=asset_id, bound_version_id=version_id,
                                                   polarity=polarity))
    open_tasks = [
        row for row in session.execute(
            select(ReviewTask.kind, ReviewTask.state, ReviewTask.assignee_role, ReviewTask.opened_at,
                   ReviewTask.payload, ReviewTask.rule_version_id)
            .where(ReviewTask.state.in_(_open_states()))
        )
        if _is_open(row.kind, row.state)
    ]
    views: dict[str, list[VersionView]] = {r.id: version_views(r) for r in rules}

    def stale_on(rule: Rule, when: date) -> tuple[int, int]:
        verdicts = evaluate(views[rule.id], edges_by_rule.get(rule.id, []), when)
        return len(verdicts), len({v.asset_id for v in verdicts})

    open_by_version = Counter(t.rule_version_id for t in open_tasks if t.rule_version_id)

    # ---- milestones and horizon
    horizon_end = as_of + timedelta(days=MILESTONE_HORIZON_DAYS)
    milestones = [{**m, "rule_code": None, "version": None, "status": None} for m in _calendar(as_of)]
    horizon: dict[str, list[s.HorizonItemOut]] = {band: [] for band, _, _ in BANDS}
    vacated: list[s.SetAsideVersionOut] = []
    proposed: list[s.ProposedVersionOut] = []
    for rule in rules:
        for v in rule.versions:
            if v.status in SET_ASIDE:
                top = (v.sources or [{}])[0]
                vacated.append(s.SetAsideVersionOut(
                    rule_code=rule.code, version=v.version, status=v.status, why=_why(v.summary, v.clause_text),
                    source=top.get("cite") or v.source_url or rule.citation,
                    source_url=top.get("url") or v.source_url or ""))
                continue
            if v.status == "proposed":
                proposed.append(s.ProposedVersionOut(
                    rule_code=rule.code, version=v.version, vote_date=v.vote_date, why=_why(v.summary, v.clause_text),
                    effective_from=v.effective_from, origin="api" if is_api_proposal(v) else "yaml"))
                if v.vote_date is not None and as_of <= v.vote_date <= horizon_end:
                    milestones.append({"date": v.vote_date, "kind": "vote", "rule_code": rule.code,
                                       "version": v.version, "status": v.status,
                                       "label": f"{rule.regulator} vote on {rule.code} v{v.version} (proposed)"})
                continue
            if v.status in NEVER_IN_FORCE or v.effective_from is None:
                continue
            for d in v.deferrals or []:
                deferred_to = date.fromisoformat(d["deferred_to"])
                if as_of <= deferred_to <= horizon_end:
                    milestones.append({"date": deferred_to, "kind": "deferral_ends", "rule_code": rule.code,
                                       "version": v.version, "status": v.status,
                                       "label": (f"{rule.code} v{v.version}: deferral ends — "
                                                 f"{_clip(d['provision'], _LABEL_CLAUSE_MAX)}")})
            if not as_of <= v.effective_from <= horizon_end:
                continue
            milestones.append({"date": v.effective_from, "kind": "rule_applies", "rule_code": rule.code,
                               "version": v.version, "status": v.status,
                               "label": (f"{rule.code} v{v.version} applies "
                                         f"({v.change_classification.lower().replace('_', ' ')})")})
            offset = (v.effective_from - as_of).days
            band = next((b for b, lo, hi in BANDS if lo <= offset <= hi), None)
            if band is None:
                continue
            stale, artifacts = stale_on(rule, v.effective_from)
            horizon[band].append(s.HorizonItemOut(
                rule_code=rule.code, rule_title=rule.title, version=v.version, applies_from=v.effective_from,
                change_classification=v.change_classification, stale_encodings_on_that_date=stale,
                artifacts_on_that_date=artifacts, open_tasks=open_by_version.get(v.id, 0)))
    milestones.sort(key=lambda m: (m["date"], _KIND_ORDER[m["kind"]], m["rule_code"] or "", m["version"] or 0))
    for items in horizon.values():
        items.sort(key=lambda h: (h.applies_from, -h.stale_encodings_on_that_date, h.rule_code))

    # ---- owners (ages measured now, not at as_of)
    by_role: dict[str, list] = defaultdict(list)
    for t in open_tasks:
        role = t.assignee_role or "unassigned"
        by_role[_ROLE_ALIASES.get(role, role)].append(t)
    owners = []
    for role, tasks in by_role.items():
        ages = [_age_days(t.opened_at, now) for t in tasks if t.opened_at is not None]
        owners.append(s.OwnerQueueOut(
            role=role, open=len(tasks),
            actionable=sum(1 for t in tasks if lane_for(t.kind, t.payload) == "actionable"),
            oldest_days=round(max(ages), 1) if ages else None,
            median_age_days=round(statistics.median(ages), 1) if ages else None,
            by_kind=dict(sorted(Counter(t.kind for t in tasks).items())),
        ))
    owners.sort(key=lambda o: (-o.actionable, -o.open, o.role))

    # ---- burn-down to the next marketing season
    target = _next_on_or_after(as_of, 10, 1)
    aep = _next_on_or_after(as_of, 10, 15)
    burn_down = s.BurnDownOut(
        target=target,
        label=f"CY{target.year + 1} marketing changes apply",
        open_actionable_now=sum(o.actionable for o in owners),
        stale_encodings_on_target=sum(stale_on(rule, target)[0] for rule in rules),
        days_left=(target - as_of).days,
        aep=s.AepOut(date=aep, days_left=(aep - as_of).days),
        note=("Open counts are live. There is no history table, so there is no trend line; "
              "stale encodings on the target date are evaluated in memory and open no tasks."),
    )
    return s.ReadinessOut(
        as_of=as_of, generated_at=now,
        milestones=[s.MilestoneOut(**m, days_from_as_of=(m["date"] - as_of).days) for m in milestones],
        horizon=horizon, owners=owners, burn_down=burn_down,
        vacated=sorted(vacated, key=lambda x: (x.rule_code, x.version)),
        proposed=sorted(proposed, key=lambda x: (x.vote_date or date.max, x.rule_code, x.version)),
    )
