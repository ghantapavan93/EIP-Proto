"""Load the Git-owned rule corpus (rules/*.yaml) into the database.

Idempotent: re-running with unchanged files changes nothing. A version that
already exists is never mutated — if the YAML for an existing version differs,
the loader refuses and tells you to add a new version instead. That refusal is
the point: history is append-only.

Statuses. ``in_force``, ``eliminated`` and ``amended`` are enacted: their
windows must not overlap and at most one may be open (``effective_to: null``).
``proposed`` (not law yet), ``vacated`` (a court set it aside) and ``stayed``
(paused by a court or the agency) are never in force. They sit outside the
window checks: a vacated version keeps the dates it was written with, for
history, and may overlap the enacted versions it never displaced; a proposed
version may have ``effective_from: null`` (no date until the regulator acts)
plus a ``vote_date``. Only a proposed version may be undated.

Annotations. ``vote_date``, ``deferrals`` (``[{provision, deferred_to,
source}]``: a clause whose compliance date moved while the text did not) and
``sources`` are not part of a version's fingerprint. They describe the version;
they do not change what it says. ``vote_date`` and ``deferrals`` are refreshed
in place on reload (audited as ``rule.version_annotated``), because a regulator
can move a vote or extend a waiver without touching the text.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from backstop.core import audit
from backstop.core.staleness import NEVER_IN_FORCE
from backstop.models import Rule, RuleVersion

VALID_CLASSIFICATIONS = {
    "INITIAL",
    "ADDS_REQUIREMENT",
    "REMOVES_REQUIREMENT",
    "TIGHTENS",
    "LOOSENS",
    "MODIFIES",
    "CLARIFIES",
    "RESTORES_PRIOR",
}
VALID_STATUS = {"in_force", "eliminated", "amended", "proposed", "vacated", "stayed"}


class RuleCorpusError(ValueError):
    pass


@dataclass
class LoadReport:
    rules_created: int = 0
    versions_created: int = 0
    unchanged: int = 0
    files: list[str] = field(default_factory=list)


def _as_date(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


_FINGERPRINT_FIELDS = ("status", "clause_text", "effective_from", "change_classification", "params")


def _fingerprint(version: dict, *, legacy: bool = False) -> str:
    """Stable hash of the fields that define a version (used to detect edits in place).

    ``effective_to`` is deliberately excluded: closing an open window (null -> date)
    is the one legal change, because appending version N+1 requires it. The
    loader checks that transition separately. ``legacy=True`` reproduces the
    pre-2026-09-23 hash (which included ``effective_to``) so databases seeded
    before the change still load. Annotations (``sources``, ``vote_date``,
    ``deferrals``) are excluded too: they describe a version without changing it.
    """
    fields = _FINGERPRINT_FIELDS + (("effective_to",) if legacy else ())
    subset = {k: version.get(k) for k in fields}
    return hashlib.sha256(json.dumps(subset, sort_keys=True, default=str).encode()).hexdigest()[:16]


SOURCE_AUTHORITIES = ("primary", "preamble", "secondary")


def _validated_sources(sources, path: Path, version) -> list[dict]:
    """Provenance ranked by authority: the regulation text outranks the preamble,
    which outranks a law-firm or trade summary. A secondary reading can raise a
    question for counsel; it can never override the primary text."""
    out = []
    for src in sources or []:
        if src.get("authority") not in SOURCE_AUTHORITIES:
            raise RuleCorpusError(f"{path.name}: v{version} source authority must be one of {SOURCE_AUTHORITIES}")
        out.append({"authority": src["authority"], "cite": str(src.get("cite", "")),
                    "url": str(src.get("url", "")), "reading": " ".join(str(src.get("reading", "")).split())})
    order = {a: i for i, a in enumerate(SOURCE_AUTHORITIES)}
    return sorted(out, key=lambda s: order[s["authority"]])


def _date_field(v: dict, key: str, path: Path) -> date | None:
    try:
        return _as_date(v.get(key))
    except ValueError as exc:
        raise RuleCorpusError(f"{path.name}: v{v.get('version')} {key} is not a date: {v.get(key)!r}") from exc


def _validated_deferrals(deferrals, path: Path, version) -> list[dict]:
    """A clause whose compliance date moved without the text changing (e.g. an FCC waiver)."""
    if deferrals is None:
        return []
    if not isinstance(deferrals, list):
        raise RuleCorpusError(f"{path.name}: v{version} deferrals must be a list")
    out = []
    for d in deferrals:
        if not isinstance(d, dict) or not str(d.get("provision") or "").strip():
            raise RuleCorpusError(f"{path.name}: v{version} each deferral needs a provision")
        deferred_to = _date_field({"version": version, "deferred_to": d.get("deferred_to")}, "deferred_to", path)
        if deferred_to is None:
            raise RuleCorpusError(f"{path.name}: v{version} each deferral needs deferred_to")
        out.append({"provision": " ".join(str(d["provision"]).split()), "deferred_to": deferred_to.isoformat(),
                    "source": " ".join(str(d.get("source") or "").split())})
    return out


def validate_rule_doc(doc: dict, path: Path) -> None:
    required = {"code", "title", "regulator", "citation", "versions"}
    missing = required - set(doc)
    if missing:
        raise RuleCorpusError(f"{path.name}: missing {sorted(missing)}")
    seen = set()
    previous_to: date | None = None
    seen_enacted = False
    for v in doc["versions"]:
        for key in ("version", "status", "effective_from", "clause_text", "change_classification"):
            if key not in v:
                raise RuleCorpusError(f"{path.name}: version missing '{key}'")
        if v["version"] in seen:
            raise RuleCorpusError(f"{path.name}: duplicate version {v['version']}")
        seen.add(v["version"])
        if v["status"] not in VALID_STATUS:
            raise RuleCorpusError(f"{path.name}: bad status {v['status']}")
        if v["change_classification"] not in VALID_CLASSIFICATIONS:
            raise RuleCorpusError(f"{path.name}: bad change_classification {v['change_classification']}")
        eff_from = _date_field(v, "effective_from", path)
        eff_to = _date_field(v, "effective_to", path)
        _date_field(v, "vote_date", path)
        _validated_deferrals(v.get("deferrals"), path, v["version"])
        if eff_from is None:
            if v["status"] != "proposed":
                raise RuleCorpusError(
                    f"{path.name}: v{v['version']} needs effective_from; only a proposed version may be undated"
                )
            if eff_to is not None:
                raise RuleCorpusError(f"{path.name}: v{v['version']} has effective_to but no effective_from")
        elif eff_to is not None and eff_to < eff_from:
            raise RuleCorpusError(f"{path.name}: v{v['version']} effective_to before effective_from")
        if v["status"] in NEVER_IN_FORCE:
            # Never in force: outside the window checks. A vacated version keeps its
            # original dates for history and may overlap the version it never displaced.
            continue
        assert eff_from is not None  # only a proposed version may be undated, and it was skipped above
        # An open previous window (effective_to null) runs forever, so any later enacted
        # version overlaps it: it must be closed first. date.max stands in for "open".
        if seen_enacted and eff_from <= (previous_to or date.max):
            raise RuleCorpusError(
                f"{path.name}: v{v['version']} overlaps the previous version's validity window"
            )
        seen_enacted = True
        previous_to = eff_to
    open_versions = [v for v in doc["versions"]
                     if v["status"] not in NEVER_IN_FORCE and v.get("effective_to") is None]
    if len(open_versions) > 1:
        raise RuleCorpusError(f"{path.name}: more than one enacted version with effective_to = null")


def is_api_proposal(version: RuleVersion) -> bool:
    """A version recorded through POST /rules/{code}/versions (a what-if, never law)."""
    return version.status == "proposed" and (version.git_commit or "").startswith("ui:")


def _renumber_colliding_proposals(session: Session, rule: Rule, doc: dict, path: Path, actor: str) -> None:
    """Git owns the version numbers. An API proposal that holds a number the YAML now defines
    moves to the next free number, so reviewed YAML always loads (ADR-001). The proposal keeps
    its content and history; the move is audited."""
    yaml_numbers = {int(v["version"]) for v in doc["versions"]}
    colliding = [v for v in rule.versions if v.version in yaml_numbers and is_api_proposal(v)]
    if not colliding:
        return
    next_free = max(yaml_numbers | {v.version for v in rule.versions}) + 1
    by_number = {int(v["version"]): v for v in doc["versions"]}
    for proposal in sorted(colliding, key=lambda v: v.version):
        yaml_v = by_number[proposal.version]
        enacted_as_is = (
            _as_date(yaml_v["effective_from"]) == proposal.effective_from
            and str(yaml_v["clause_text"]).strip() == proposal.clause_text.strip()
        )
        old_number, proposal.version = proposal.version, next_free
        next_free += 1
        session.flush()
        audit.record(
            session,
            actor=actor,
            event_type="rule.proposal_renumbered",
            entity_type="rule_version",
            entity_id=proposal.id,
            payload={
                "rule": rule.code,
                "from_version": old_number,
                "to_version": proposal.version,
                "reason": f"{path.name} defines v{old_number}",
                "yaml_matches_proposal": enacted_as_is,
            },
        )
    session.expire(rule, ["versions"])


def _refresh_annotations(session: Session, rule: Rule, stored: RuleVersion, yaml_v: dict, path: Path,
                         actor: str) -> None:
    """Bring ``vote_date`` and ``deferrals`` of an existing version in line with the YAML.

    They are annotations, not history: a regulator can reschedule a vote or extend a
    waiver without changing a word of the version. The change is audited.
    """
    vote_date = _as_date(yaml_v.get("vote_date"))
    deferrals = _validated_deferrals(yaml_v.get("deferrals"), path, yaml_v["version"])
    if stored.vote_date == vote_date and list(stored.deferrals or []) == deferrals:
        return
    before = {"vote_date": stored.vote_date.isoformat() if stored.vote_date else None,
              "deferrals": list(stored.deferrals or [])}
    stored.vote_date = vote_date
    stored.deferrals = deferrals
    audit.record(
        session,
        actor=actor,
        event_type="rule.version_annotated",
        entity_type="rule_version",
        entity_id=stored.id,
        payload={
            "rule": rule.code,
            "version": stored.version,
            "before": before,
            "after": {"vote_date": vote_date.isoformat() if vote_date else None, "deferrals": deferrals},
            "source": path.name,
        },
    )


def load_rules(session: Session, rules_dir: Path, *, actor: str = "system") -> LoadReport:
    report = LoadReport(files=[])
    for path in sorted(rules_dir.glob("*.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        validate_rule_doc(doc, path)
        report.files.append(path.name)
        rule = session.scalar(select(Rule).where(Rule.code == doc["code"]))
        if rule is None:
            rule = Rule(
                code=doc["code"],
                title=doc["title"],
                regulator=doc["regulator"],
                citation=doc["citation"],
                applies_to=list(doc.get("applies_to", [])),
                summary=(doc.get("summary") or "").strip(),
                source_url=doc.get("source_url", ""),
            )
            session.add(rule)
            session.flush()
            report.rules_created += 1
        else:
            # Descriptive fields may be refreshed; they are not part of history.
            rule.title = doc["title"]
            rule.citation = doc["citation"]
            rule.summary = (doc.get("summary") or "").strip()
            rule.source_url = doc.get("source_url", rule.source_url)
            rule.applies_to = list(doc.get("applies_to", rule.applies_to))

        _renumber_colliding_proposals(session, rule, doc, path, actor)
        existing = {v.version: v for v in rule.versions}
        for v in doc["versions"]:
            fp = _fingerprint(v)
            if v["version"] in existing:
                stored = existing[v["version"]]
                stored_fp = stored.params.get("_fingerprint")
                yaml_to = _as_date(v.get("effective_to"))
                legacy_match = stored_fp == _fingerprint(
                    {**v, "effective_to": stored.effective_to}, legacy=True
                )
                if stored_fp != fp and not legacy_match:
                    raise RuleCorpusError(
                        f"{path.name}: version {v['version']} was edited in place. "
                        "History is append-only — add a new version instead."
                    )
                if stored.effective_to != yaml_to:
                    # Only legal window change: closing an open version once.
                    if stored.effective_to is not None:
                        raise RuleCorpusError(
                            f"{path.name}: version {v['version']} effective_to changed "
                            f"{stored.effective_to} -> {yaml_to}. A closed window is final."
                        )
                    assert yaml_to is not None  # stored window was open and differs, so YAML closed it
                    stored.effective_to = yaml_to
                    audit.record(
                        session,
                        actor=actor,
                        event_type="rule.version_closed",
                        entity_type="rule_version",
                        entity_id=stored.id,
                        payload={
                            "rule": rule.code,
                            "version": stored.version,
                            "effective_to": yaml_to.isoformat(),
                            "source": path.name,
                        },
                    )
                if stored_fp != fp:
                    # Upgrade a legacy fingerprint in place (new dict so the JSON column is dirtied).
                    stored.params = {**stored.params, "_fingerprint": fp}
                _refresh_annotations(session, rule, stored, v, path, actor)
                report.unchanged += 1
                continue
            params = dict(v.get("params") or {})
            params["_fingerprint"] = fp
            rv = RuleVersion(
                rule_id=rule.id,
                version=int(v["version"]),
                status=v["status"],
                clause_text=str(v["clause_text"]).strip(),
                summary=str(v.get("summary") or "").strip(),
                effective_from=_as_date(v["effective_from"]),
                effective_to=_as_date(v.get("effective_to")),
                regulation_effective=_as_date(v.get("regulation_effective")),
                sources=_validated_sources(v.get("sources"), path, v["version"]),
                vote_date=_as_date(v.get("vote_date")),
                deferrals=_validated_deferrals(v.get("deferrals"), path, v["version"]),
                change_classification=v["change_classification"],
                params=params,
                disputed=bool(v.get("disputed", False)),
                dispute_note=str(v.get("dispute_note") or "").strip(),
                source_url=v.get("source_url", ""),
                git_commit=str(v.get("git_commit") or "yaml"),
            )
            session.add(rv)
            session.flush()
            report.versions_created += 1
            audit.record(
                session,
                actor=actor,
                event_type="rule.version_created",
                entity_type="rule_version",
                entity_id=rv.id,
                payload={
                    "rule": rule.code,
                    "version": rv.version,
                    "status": rv.status,
                    "effective_from": rv.effective_from.isoformat() if rv.effective_from else None,
                    "vote_date": rv.vote_date.isoformat() if rv.vote_date else None,
                    "effective_to": rv.effective_to.isoformat() if rv.effective_to else None,
                    "change_classification": rv.change_classification,
                    "source": path.name,
                },
            )
    audit.record(
        session,
        actor=actor,
        event_type="rules.reloaded",
        entity_type="rules",
        entity_id="corpus",
        payload={
            "files": report.files,
            "rules_created": report.rules_created,
            "versions_created": report.versions_created,
            "unchanged": report.unchanged,
        },
    )
    session.commit()
    return report
