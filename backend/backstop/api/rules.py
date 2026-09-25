"""Rule registry: versioned, effective-dated rules and their change impact.

    GET  /api/rules                   every rule with its versions, as of a date
    POST /api/rules/reload            adopt rules/*.yaml (admin; append-only; edited versions are refused)
    GET  /api/rules/{code}            one rule and its versions, as of a date
    GET  /api/rules/{code}/impact     what-if: which artifacts go stale on a given date
    POST /api/rules/{code}/versions   propose a new version (never in force until adopted)
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from backstop import schemas as s
from backstop.api.deps import SessionDep, SettingsDep, User, UserDep, require_role
from backstop.api.serializers import edge_out, rule_out
from backstop.core import audit, impact, permissions, staleness
from backstop.core.rules_loader import RuleCorpusError, _fingerprint, load_rules
from backstop.models import PromptVersion, Rule, RuleAssetEdge, RuleVersion, utcnow

router = APIRouter(prefix="/rules", tags=["rules"])

# A proposal dated past this is a typo, not a plan (and would sort after every real version).
MAX_EFFECTIVE_FROM = date(2100, 12, 31)
ENACT_REFUSAL = (
    "The API may only create status 'proposed'. In-force history comes from reviewed YAML in git "
    "(rules/<code>.yaml, merged by a second person, then POST /rules/reload); see ADR-001."
)


class ImpactWhatIfOut(s.ImpactOut):
    """ImpactOut plus the what-if markers. With include_proposed=false these are always
    hypothetical=false / assumed_version=None, so existing clients see the old shape."""

    hypothetical: bool = False
    assumed_version: int | None = None
    note: str = ""


def _rule(session, code: str) -> Rule:
    rule = session.scalar(select(Rule).where(Rule.code == code))
    if rule is None:
        raise HTTPException(404, f"rule {code} not found")
    return rule


@router.get("", response_model=list[s.RuleOut])
def list_rules(session: SessionDep, user: UserDep, as_of: date | None = None):
    rules = session.scalars(select(Rule).order_by(Rule.code)).all()
    return [rule_out(session, r, as_of) for r in rules]


@router.post("/reload")
def reload_rules(session: SessionDep, settings: SettingsDep, user: User = Depends(require_role("admin"))):
    try:
        report = load_rules(session, settings.rules_dir, actor=user.name)
    except RuleCorpusError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"rules_created": report.rules_created, "versions_created": report.versions_created,
            "unchanged": report.unchanged, "files": report.files}


@router.get("/{code}", response_model=s.RuleOut)
def get_rule(code: str, session: SessionDep, user: UserDep, as_of: date | None = None):
    return rule_out(session, _rule(session, code), as_of)


def _assumed_proposal(rule: Rule, as_of: date, assume_version: int | None) -> RuleVersion | None:
    """The proposed version a what-if assumes: the one asked for, else the newest dated
    proposal already effective on `as_of`. An undated proposal (awaiting a vote) is only
    assumed when asked for by number."""
    proposals = [v for v in rule.versions if v.status == "proposed"]
    if assume_version is not None:
        chosen = next((v for v in proposals if v.version == assume_version), None)
        if chosen is None:
            raise HTTPException(404, f"{rule.code} has no proposed version {assume_version}")
        return chosen
    effective = [v for v in proposals if v.effective_from is not None and v.effective_from <= as_of]
    return max(effective, key=lambda v: v.version) if effective else None


def _views_assuming(rule: Rule, assumed: RuleVersion, assumed_from: date) -> list[staleness.VersionView]:
    """Version views as if `assumed` were enacted from `assumed_from`: every enacted window
    still open on that date closes the day before. In memory only."""
    cut = assumed_from - timedelta(days=1)
    views = []
    for v in impact.version_views(rule):
        if v.id == assumed.id:
            v = replace(v, status="in_force", effective_from=assumed_from, effective_to=None)
        elif (v.status not in staleness.NEVER_IN_FORCE and v.effective_from is not None and v.effective_from <= cut
              and (v.effective_to is None or v.effective_to > cut)):
            v = replace(v, effective_to=cut)
        views.append(v)
    return views


@router.get("/{code}/impact", response_model=ImpactWhatIfOut)
def rule_impact(code: str, session: SessionDep, user: UserDep, as_of: date = Query(default_factory=date.today),
                include_proposed: bool = False, assume_version: int | None = None):
    """Blast radius of a rule as of a date.

    Default: evaluates the enacted history and (for owning roles) opens STALE_ASSET tasks.
    ``include_proposed=true`` is a what-if: it evaluates as if a proposed version were enacted
    (``assume_version`` if given, else the newest dated proposal effective on ``as_of``). An
    undated proposal (e.g. awaiting a vote) is assumed to take effect on ``as_of``. A what-if
    writes nothing: no tasks, no audit events.
    """
    rule = _rule(session, code)
    want_what_if = include_proposed or assume_version is not None
    assumed = _assumed_proposal(rule, as_of, assume_version) if want_what_if else None
    tasks: dict = {}
    note = ""
    if assumed is not None:
        assumed_from = assumed.effective_from or as_of
        views = _views_assuming(rule, assumed, assumed_from)
        verdicts = staleness.evaluate(views, impact.edge_views(session, rule), as_of)
        counts = staleness.summarize(verdicts)
        current_view = staleness.version_in_force(views, as_of)
        current = next((v for v in rule.versions if current_view is not None and v.id == current_view.id), None)
        dated = (f"from {assumed.effective_from.isoformat()}" if assumed.effective_from else
                 f"no effective date yet{f', vote {assumed.vote_date.isoformat()}' if assumed.vote_date else ''}; "
                 f"assumed from {as_of.isoformat()}")
        note = (f"what-if: v{assumed.version} (proposed, {dated}) treated as "
                "enacted; no tasks were opened and nothing was written")
    else:
        if want_what_if:
            note = f"no proposed version of {rule.code} is effective on {as_of.isoformat()}; enacted history shown"
        # Reading the blast radius upserts STALE_ASSET tasks (idempotent) only for
        # roles that own them; an analyst's read changes nothing.
        # Reading an older state of the rule ("what was stale in 2024?") must not put that
        # period's work into today's queue.
        may_open = (user.role in permissions.OPEN_STALE_TASK_ROLES
                    and not impact.reads_past_rule_state(rule, as_of, date.today()))
        verdicts, counts, tasks = impact.evaluate_rule(session, rule, as_of, actor=user.name, open_tasks=may_open)
        session.commit()
        current = impact.in_force_version(rule, as_of)
    edges_by_id = {e.id: e for e in session.scalars(
        select(RuleAssetEdge).where(RuleAssetEdge.rule_version_id.in_([v.id for v in rule.versions]))
    ).all()}
    stale = []
    for v in verdicts:
        edge = edges_by_id[v.edge_id]
        task = tasks.get(v.edge_id)
        stale.append(s.StaleItemOut(
            edge=edge_out(session, edge), bound_version=v.bound_version, in_force_version=v.in_force_version,
            direction=v.direction, reason=v.reason, disputed=v.disputed,
            task_id=task.id if task else None, task_state=task.state if task else None,
        ))
    order = {"under_restrictive": 0, "over_restrictive": 1, "reverify": 2}
    stale.sort(key=lambda x: (order.get(x.direction, 9), x.edge.asset_name))
    healthy = [edge_out(session, e) for e in edges_by_id.values()
               if current is not None and e.rule_version_id == current.id and e.status == "confirmed"]
    prompts = session.scalars(select(PromptVersion)).all()
    declaring = [
        {"id": p.id, "workflow": p.workflow.code, "version": p.version, "label": p.label, "prompt_hash": p.prompt_hash,
         "declared_version": next(d["version"] for d in p.encodes_rule_versions if d["rule"] == rule.code),
         "stale": current is not None and next(d["version"] for d in p.encodes_rule_versions if d["rule"] == rule.code) != current.version}
        for p in prompts if any(d.get("rule") == rule.code for d in p.encodes_rule_versions)
    ]
    return ImpactWhatIfOut(
        rule_code=rule.code, as_of=as_of, in_force_version=current.version if current else None, counts=counts,
        stale=stale, current_edges=healthy, contracts=[c.code for c in rule.contracts], prompt_versions=declaring,
        hypothetical=assumed is not None, assumed_version=assumed.version if assumed else None, note=note,
    )


@router.post("/{code}/versions", response_model=s.RuleVersionOut, status_code=201)
def propose_version(code: str, body: s.RuleVersionCreate, session: SessionDep,
                    user: User = Depends(require_role("engineer", "admin"))):
    """Record a *proposed* version for what-if analysis. Never law: a proposal does not close
    its predecessor's window and is never in force. Enactment is a reviewed YAML change (ADR-001)."""
    if body.status != "proposed":
        raise HTTPException(422, ENACT_REFUSAL)
    if body.effective_from > MAX_EFFECTIVE_FROM:
        raise HTTPException(422, f"effective_from must be on or before {MAX_EFFECTIVE_FROM.isoformat()}")
    rule = _rule(session, code)
    clause = body.clause_text.strip()
    duplicate = next((v for v in rule.versions
                      if v.effective_from == body.effective_from and v.clause_text.strip() == clause), None)
    if duplicate is not None:
        raise HTTPException(409, f"{rule.code} v{duplicate.version} ({duplicate.status}) already has this "
                                 "effective_from and clause_text")
    enacted = [v for v in rule.versions if v.status not in staleness.NEVER_IN_FORCE and v.effective_from is not None]
    last_enacted = max(enacted, key=lambda v: v.effective_from) if enacted else None
    if last_enacted is not None and body.effective_from <= last_enacted.effective_from:
        raise HTTPException(422, "effective_from must be after the latest enacted version's effective_from")
    last = rule.versions[-1] if rule.versions else None
    number = (last.version + 1) if last else 1
    params = dict(body.params)
    params["_fingerprint"] = _fingerprint({
        "status": body.status, "clause_text": clause,
        "effective_from": body.effective_from, "change_classification": body.change_classification,
        "params": body.params,
    })
    rv = RuleVersion(
        rule_id=rule.id, version=number, status=body.status,
        clause_text=clause, summary=body.summary.strip(), effective_from=body.effective_from,
        effective_to=None, change_classification=body.change_classification, params=params,
        disputed=body.disputed, dispute_note=body.dispute_note, source_url=body.source_url,
        git_commit=f"ui:{user.name}@{utcnow().isoformat()}",
    )
    session.add(rv)
    session.flush()
    audit.record(session, actor=user.name, event_type="rule.version_created", entity_type="rule_version",
                 entity_id=rv.id, payload={"rule": rule.code, "version": rv.version, "status": rv.status,
                                           "effective_from": rv.effective_from.isoformat(),
                                           "change_classification": rv.change_classification, "source": "api"})
    session.commit()
    session.refresh(rv)
    return s.RuleVersionOut.model_validate(rv)
