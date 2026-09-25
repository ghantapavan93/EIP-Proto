"""Scan orchestration: inventory → fetch → hash → match → edges → tasks.

Idempotent end to end:
* same idempotency key → the existing scan is returned, nothing re-runs;
* same content → no new artifact version (unique on (asset, hash));
* same evidence → no new edge (unique on (rule version, asset, span));
* same stale (rule version, artifact) → no new review task.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from backstop.config import Settings
from backstop.core import audit, impact
from backstop.models import (
    Asset,
    AssetVersion,
    ReviewTask,
    Rule,
    RuleAssetEdge,
    RuleVersion,
    Scan,
    ScanArtifact,
    utcnow,
)
from backstop.scanner import crawler, matchers


@dataclass
class ScanOutcome:
    scan: Scan
    deduplicated: bool


def load_inventory(session: Session, fixtures_dir: Path) -> list[Asset]:
    """Ensure every artifact in fixtures/sources.yaml exists. Returns the assets."""
    doc = yaml.safe_load((fixtures_dir / "sources.yaml").read_text(encoding="utf-8"))
    assets: list[Asset] = []
    for page in doc.get("real_pages", []):
        asset = session.scalar(select(Asset).where(Asset.code == page["code"]))
        if asset is None:
            asset = Asset(
                code=page["code"],
                type="web_page",
                name=page["name"],
                url=page["url"],
                source_system=page.get("source_system", "web"),
                owner_role=page.get("owner_role", "marketing"),
                is_synthetic=False,
            )
            session.add(asset)
        else:
            # Descriptive metadata follows the inventory file; content and hashes never change here.
            asset.source_system = page.get("source_system", "web")
        assets.append(asset)
    for item in doc.get("synthetic", []):
        asset = session.scalar(select(Asset).where(Asset.code == item["code"]))
        if asset is None:
            asset = Asset(
                code=item["code"],
                type=item["type"],
                name=item["name"],
                url=None,
                source_system=item.get("source_system", "synthetic"),
                owner_role=item.get("owner_role", "compliance"),
                is_synthetic=True,
            )
            session.add(asset)
        assets.append(asset)
    session.flush()
    return assets


def _synthetic_text(fixtures_dir: Path, code: str) -> str | None:
    doc = yaml.safe_load((fixtures_dir / "sources.yaml").read_text(encoding="utf-8"))
    for item in doc.get("synthetic", []):
        if item["code"] == code:
            return crawler.normalize_text(item["text"])
    return None


def _rule_version(session: Session, code: str, version: int) -> RuleVersion | None:
    rule = session.scalar(select(Rule).where(Rule.code == code))
    if rule is None:
        return None
    return next((v for v in rule.versions if v.version == version), None)


def _propose_with_llm(session: Session, settings: Settings, assets: list[Asset], actor: str) -> dict:
    """Ask the model for semantic encodings the matchers cannot see; store only verified spans as proposals."""
    from backstop.scanner import llm_edges

    client = llm_edges.AnthropicProposer(settings.anthropic_api_key or "")
    summary = {"proposed": 0, "rejected_spans": 0, "errors": 0, "pairs": 0}
    rules = session.scalars(select(Rule)).all()
    for asset in assets:
        latest = session.scalar(
            select(AssetVersion).where(AssetVersion.asset_id == asset.id).order_by(AssetVersion.fetched_at.desc())
        )
        if latest is None:
            continue
        for rule in rules:
            # The version in force today: never a proposal, and never a vacated text that a
            # public source (eCFR) may still print.
            current = impact.in_force_version(rule, date.today())
            if current is None:
                continue
            summary["pairs"] += 1
            kept, rejected = llm_edges.propose_edges(
                client, f"{rule.title}\n{current.clause_text}\nparams: {current.params}", latest.content_text
            )
            summary["rejected_spans"] += len([r for r in rejected if "span" in r])
            summary["errors"] += len([r for r in rejected if "error" in r])
            for prop in kept:
                # The model proposes against the *current* clause; a human binds the version on review.
                exists = session.scalar(
                    select(RuleAssetEdge).where(
                        RuleAssetEdge.rule_version_id == current.id,
                        RuleAssetEdge.asset_id == asset.id,
                        RuleAssetEdge.evidence_span == prop.span,
                    )
                )
                if exists is not None:
                    continue
                edge = RuleAssetEdge(
                    rule_version_id=current.id, asset_id=asset.id, asset_version_id=latest.id,
                    polarity=prop.polarity, evidence_span=prop.span, span_offset=prop.offset, detection="llm",
                    matcher="llm-proposer", confidence=prop.confidence, status="proposed",
                )
                session.add(edge)
                session.flush()
                summary["proposed"] += 1
                audit.record(session, actor=actor, event_type="edge.proposed", entity_type="edge", entity_id=edge.id,
                             payload={"asset": asset.code, "rule": rule.code, "why": prop.why, "span": prop.span[:200]})
                session.add(ReviewTask(
                    kind="PROPOSED_EDGE", dedupe_key=f"edge:{edge.id}", state="open", rule_version_id=current.id,
                    asset_id=asset.id, edge_id=edge.id, reason=f"LLM proposed: {prop.why[:200]}",
                    assignee_role=asset.owner_role, payload={"rule": rule.code, "detection": "llm"},
                ))
    session.flush()
    return summary


def run_scan(
    session: Session,
    settings: Settings,
    *,
    idempotency_key: str,
    live: bool = False,
    as_of: date | None = None,
    actor: str = "system",
    use_llm: bool = False,
) -> ScanOutcome:
    existing = session.scalar(select(Scan).where(Scan.idempotency_key == idempotency_key))
    if existing is not None:
        return ScanOutcome(existing, deduplicated=True)

    scan = Scan(idempotency_key=idempotency_key, status="running", stats={})
    session.add(scan)
    session.flush()
    audit.record(
        session,
        actor=actor,
        event_type="scan.started",
        entity_type="scan",
        entity_id=scan.id,
        payload={"idempotency_key": idempotency_key, "live": live},
    )

    assets = load_inventory(session, settings.fixtures_dir)
    stats = {
        "artifacts": len(assets),
        "unchanged": 0,
        "new_versions": 0,
        "fetch_errors": 0,
        "edges_new": 0,
        "edges_existing": 0,
        "proposed_new": 0,
        "mode": "live" if live else "snapshot",
    }
    errors = 0

    for asset in assets:
        if asset.type == "web_page":
            if live and settings.crawler_live:
                result = crawler.fetch_live(
                    settings.fixtures_dir,
                    asset.code,
                    asset.url or "",
                    user_agent=settings.crawler_user_agent,
                    delay_seconds=settings.crawler_delay_seconds,
                )
            else:
                result = crawler.fetch_snapshot(settings.fixtures_dir, asset.code)
        else:
            text = _synthetic_text(settings.fixtures_dir, asset.code)
            if text is None:
                result = crawler.FetchResult(asset.code, "", "", "seed", 0, error="missing synthetic text")
            else:
                result = crawler.FetchResult(asset.code, text, crawler.content_hash(text), "seed", len(text))

        if result.error:
            errors += 1
            stats["fetch_errors"] += 1
            session.add(ScanArtifact(scan_id=scan.id, asset_id=asset.id, outcome="fetch_error", detail=result.error))
            audit.record(
                session,
                actor=actor,
                event_type="artifact.fetch_error",
                entity_type="asset",
                entity_id=asset.id,
                payload={"code": asset.code, "error": result.error},
            )
            continue

        version = session.scalar(
            select(AssetVersion).where(
                AssetVersion.asset_id == asset.id, AssetVersion.content_hash == result.content_hash
            )
        )
        if version is None:
            version = AssetVersion(
                asset_id=asset.id,
                content_hash=result.content_hash,
                content_text=result.text,
                scan_id=scan.id,
                fetch_mode=result.mode,
            )
            session.add(version)
            session.flush()
            stats["new_versions"] += 1
            session.add(ScanArtifact(scan_id=scan.id, asset_id=asset.id, outcome="new_version"))
            audit.record(
                session,
                actor=actor,
                event_type="artifact.content_changed",
                entity_type="asset",
                entity_id=asset.id,
                payload={"code": asset.code, "content_hash": result.content_hash, "mode": result.mode},
            )
        else:
            stats["unchanged"] += 1
            session.add(ScanArtifact(scan_id=scan.id, asset_id=asset.id, outcome="unchanged"))
            audit.record(
                session,
                actor=actor,
                event_type="artifact.unchanged",
                entity_type="asset",
                entity_id=asset.id,
                payload={"code": asset.code, "content_hash": result.content_hash},
            )

        # An edge is evidence that this artifact quotes a rule version. When the
        # artifact is edited and the quoted span is gone, the evidence is gone:
        # supersede the edge so a fixed page stops counting as stale.
        stats.setdefault("edges_superseded", 0)
        live_edges = session.scalars(
            select(RuleAssetEdge).where(
                RuleAssetEdge.asset_id == asset.id, RuleAssetEdge.status.in_(("confirmed", "proposed"))
            )
        ).all()
        for old in live_edges:
            if old.evidence_span and old.evidence_span not in result.text:
                old.status = "superseded"
                stats["edges_superseded"] += 1
                audit.record(session, actor=actor, event_type="edge.superseded", entity_type="edge",
                             entity_id=old.id, payload={"asset": asset.code, "span": old.evidence_span[:200],
                                                        "content_hash": result.content_hash})

        # Deterministic matchers run on every scan; edges are upserted by unique key.
        for match in matchers.run_all(result.text):
            rv = _rule_version(session, match.rule_code, match.version)
            if rv is None:
                continue
            edge = session.scalar(
                select(RuleAssetEdge).where(
                    RuleAssetEdge.rule_version_id == rv.id,
                    RuleAssetEdge.asset_id == asset.id,
                    RuleAssetEdge.evidence_span == match.span,
                )
            )
            if edge is not None:
                stats["edges_existing"] += 1
                if edge.status == "superseded":
                    # The span came back (page reverted): the binding is live again.
                    edge.status = match.status
                    edge.asset_version_id = version.id
                    audit.record(session, actor=actor, event_type="edge.restored", entity_type="edge",
                                 entity_id=edge.id, payload={"asset": asset.code, "rule": match.rule_code,
                                                             "version": match.version})
                continue
            edge = RuleAssetEdge(
                rule_version_id=rv.id,
                asset_id=asset.id,
                asset_version_id=version.id,
                polarity=match.polarity,
                evidence_span=match.span,
                span_offset=match.offset,
                detection="deterministic",
                matcher=match.matcher,
                confidence=match.confidence,
                status=match.status,
                confirmed_by="matcher" if match.status == "confirmed" else None,
            )
            session.add(edge)
            session.flush()
            stats["edges_new"] += 1
            audit.record(
                session,
                actor=actor,
                event_type="edge.confirmed" if match.status == "confirmed" else "edge.proposed",
                entity_type="edge",
                entity_id=edge.id,
                payload={
                    "asset": asset.code,
                    "rule": match.rule_code,
                    "version": match.version,
                    "polarity": match.polarity,
                    "matcher": match.matcher,
                    "span": match.span[:200],
                },
            )
            if match.status == "proposed":
                dedupe_key = f"edge:{edge.id}"
                task = ReviewTask(
                    kind="PROPOSED_EDGE",
                    dedupe_key=dedupe_key,
                    state="open",
                    rule_version_id=rv.id,
                    asset_id=asset.id,
                    edge_id=edge.id,
                    reason=match.note or "matcher proposed an edge that needs a human read",
                    assignee_role=asset.owner_role,
                    payload={"rule": match.rule_code, "version": match.version, "matcher": match.matcher},
                )
                session.add(task)
                session.flush()
                stats["proposed_new"] += 1
                audit.record(
                    session,
                    actor=actor,
                    event_type="task.opened",
                    entity_type="review_task",
                    entity_id=task.id,
                    payload={"kind": "PROPOSED_EDGE", "asset": asset.code, "rule": match.rule_code},
                )

    # Optional LLM edge proposer: only with a key, only proposals, only span-verified.
    if use_llm and settings.anthropic_api_key:
        stats["llm"] = _propose_with_llm(session, settings, assets, actor)
    elif use_llm:
        stats["llm"] = {"skipped": "ANTHROPIC_API_KEY not set — deterministic matchers only"}

    # Re-evaluate staleness for every rule as of the requested date.
    as_of = as_of or date.today()
    stats["staleness"] = impact.evaluate_all(session, as_of, actor=actor)
    stats["as_of"] = as_of.isoformat()

    scan.status = "partial" if errors else "completed"
    scan.finished_at = utcnow()
    scan.stats = stats
    audit.record(
        session,
        actor=actor,
        event_type="scan.completed",
        entity_type="scan",
        entity_id=scan.id,
        payload={"status": scan.status, "stats": stats},
    )
    session.commit()
    return ScanOutcome(scan, deduplicated=False)
