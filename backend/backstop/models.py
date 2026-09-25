"""Persistence model.

Design rules that matter for the demo and for the argument the demo makes:

* Temporal validity is first-class. A rule is versioned with effective dates;
  nothing is updated in place. "What was the rule on Sept 30?" and "what is it
  on Oct 1?" are both answerable.
* Edges bind an artifact to the *rule version* whose clause it encodes. That
  binding is what makes staleness computable instead of vibes.
* Every run is keyed by everything that could change its outcome
  (workflow, prompt hash, model, corpus hash, contract set hash, rule date),
  so re-running is idempotent and comparisons are honest.
* Review tasks are deduplicated by a unique key; re-evaluating never opens a
  second task for the same (rule version, artifact).
* audit_events is append-only and is the artifact a carrier oversight
  conversation actually wants.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backstop.db import Base


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(UTC)


# --------------------------------------------------------------------------- rules


class Rule(Base):
    __tablename__ = "rules"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    regulator: Mapped[str] = mapped_column(String(32))  # CMS | STATE_DOI | FCC | EIP
    citation: Mapped[str] = mapped_column(String(200))
    applies_to: Mapped[list] = mapped_column(JSON, default=list)  # ["MA", "PDP", "MEDIGAP", "LIFE"]
    summary: Mapped[str] = mapped_column(Text, default="")
    source_url: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    versions: Mapped[list[RuleVersion]] = relationship(
        back_populates="rule", order_by="RuleVersion.version", cascade="all, delete-orphan"
    )
    contracts: Mapped[list[Contract]] = relationship(back_populates="rule")


class RuleVersion(Base):
    __tablename__ = "rule_versions"
    __table_args__ = (UniqueConstraint("rule_id", "version", name="uq_rule_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    rule_id: Mapped[str] = mapped_column(ForeignKey("rules.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    # in_force | eliminated | amended | proposed | vacated | stayed. proposed, vacated and
    # stayed are never in force, whatever their dates say (staleness.NEVER_IN_FORCE).
    status: Mapped[str] = mapped_column(String(24))
    clause_text: Mapped[str] = mapped_column(Text)
    summary: Mapped[str] = mapped_column(Text, default="")
    # Null only for a proposed version that has no date yet (e.g. an FCC item awaiting a vote).
    effective_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    # ADDS_REQUIREMENT | REMOVES_REQUIREMENT | TIGHTENS | LOOSENS | MODIFIES | CLARIFIES
    # | RESTORES_PRIOR | INITIAL
    change_classification: Mapped[str] = mapped_column(String(32), default="INITIAL")
    # effective_from is when the version APPLIES to EIP's workflow. The legal
    # effective date of the regulation can differ (CY2027 rule: effective
    # 2026-06-01, marketing provisions apply 2026-10-01).
    regulation_effective: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Provenance, ranked: [{authority: primary|preamble|secondary, cite, url, reading}].
    sources: Mapped[list] = mapped_column(JSON, default=list)
    # Annotations (not part of the version's fingerprint; the loader refreshes them in place):
    # the date a regulator votes on a proposed version, and clauses whose compliance date was
    # deferred without changing the text: [{provision, deferred_to (ISO date), source}].
    vote_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    deferrals: Mapped[list] = mapped_column(JSON, default=list)
    params: Mapped[dict] = mapped_column(JSON, default=dict)  # machine-readable knobs for contracts
    disputed: Mapped[bool] = mapped_column(Boolean, default=False)
    dispute_note: Mapped[str] = mapped_column(Text, default="")
    source_url: Mapped[str] = mapped_column(String(500), default="")
    git_commit: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    rule: Mapped[Rule] = relationship(back_populates="versions")
    edges: Mapped[list[RuleAssetEdge]] = relationship(back_populates="rule_version")


# --------------------------------------------------------------------------- assets


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    code: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    # web_page | scorecard_item | script_section | coaching_prompt | email_template
    # | training_slide | ivr_script | workflow_prompt
    type: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(200))
    url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    source_system: Mapped[str] = mapped_column(String(64))  # public-web | attention(synthetic) | sfmc(synthetic) ...
    owner_role: Mapped[str] = mapped_column(String(64), default="compliance")
    is_synthetic: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    versions: Mapped[list[AssetVersion]] = relationship(
        back_populates="asset", order_by="AssetVersion.fetched_at", cascade="all, delete-orphan"
    )
    edges: Mapped[list[RuleAssetEdge]] = relationship(back_populates="asset")


class AssetVersion(Base):
    __tablename__ = "asset_versions"
    __table_args__ = (UniqueConstraint("asset_id", "content_hash", name="uq_asset_content"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"), index=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    content_text: Mapped[str] = mapped_column(Text)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    scan_id: Mapped[str | None] = mapped_column(ForeignKey("scans.id"), nullable=True)
    fetch_mode: Mapped[str] = mapped_column(String(16), default="snapshot")  # live | snapshot | seed | repo

    asset: Mapped[Asset] = relationship(back_populates="versions")


class Scan(Base):
    __tablename__ = "scans"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    idempotency_key: Mapped[str] = mapped_column(String(120), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="running")  # running|completed|partial|failed
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stats: Mapped[dict] = mapped_column(JSON, default=dict)


class ScanArtifact(Base):
    __tablename__ = "scan_artifacts"

    scan_id: Mapped[str] = mapped_column(ForeignKey("scans.id"), primary_key=True)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"), primary_key=True)
    outcome: Mapped[str] = mapped_column(String(24))  # unchanged|new_version|fetch_error|extract_error
    detail: Mapped[str] = mapped_column(Text, default="")


class RuleAssetEdge(Base):
    """An artifact encodes a rule clause. The edge binds to the *rule version* it encodes."""

    __tablename__ = "rule_asset_edges"
    __table_args__ = (
        UniqueConstraint("rule_version_id", "asset_id", "evidence_span", name="uq_edge_span"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    rule_version_id: Mapped[str] = mapped_column(ForeignKey("rule_versions.id"), index=True)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"), index=True)
    asset_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("asset_versions.id"), nullable=True
    )
    polarity: Mapped[str] = mapped_column(String(16))  # ENFORCES | PERMITS | INFORMS
    evidence_span: Mapped[str] = mapped_column(Text)
    span_offset: Mapped[int] = mapped_column(Integer, default=0)
    detection: Mapped[str] = mapped_column(String(16))  # deterministic | llm | manual
    matcher: Mapped[str] = mapped_column(String(64), default="")
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="confirmed")  # proposed|confirmed|rejected|superseded
    confirmed_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    rule_version: Mapped[RuleVersion] = relationship(back_populates="edges")
    asset: Mapped[Asset] = relationship(back_populates="edges")


# ------------------------------------------------------------------------ contracts


class Contract(Base):
    __tablename__ = "contracts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    rule_id: Mapped[str | None] = mapped_column(ForeignKey("rules.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String(16))  # DETERMINISTIC | JUDGED
    severity: Mapped[str] = mapped_column(String(8))  # BLOCK | FLAG
    owner_role: Mapped[str] = mapped_column(String(64), default="ai-enablement")
    check: Mapped[str] = mapped_column(String(64))  # registered check function name
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    rule: Mapped[Rule | None] = relationship(back_populates="contracts")
    versions: Mapped[list[ContractVersion]] = relationship(
        back_populates="contract", order_by="ContractVersion.version", cascade="all, delete-orphan"
    )


class ContractVersion(Base):
    __tablename__ = "contract_versions"
    __table_args__ = (UniqueConstraint("contract_id", "version", name="uq_contract_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    contract_id: Mapped[str] = mapped_column(ForeignKey("contracts.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    spec: Mapped[dict] = mapped_column(JSON, default=dict)
    effective_from: Mapped[date] = mapped_column(Date)
    judge_model_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    n_runs: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    contract: Mapped[Contract] = relationship(back_populates="versions")


# ------------------------------------------------------------------------ workflows


class Workflow(Base):
    __tablename__ = "workflows"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")

    prompt_versions: Mapped[list[PromptVersion]] = relationship(
        back_populates="workflow", order_by="PromptVersion.version"
    )


class PromptVersion(Base):
    __tablename__ = "prompt_versions"
    __table_args__ = (UniqueConstraint("workflow_id", "version", name="uq_prompt_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflows.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    label: Mapped[str] = mapped_column(String(80))
    prompt_hash: Mapped[str] = mapped_column(String(64), index=True)
    text: Mapped[str] = mapped_column(Text)
    author: Mapped[str] = mapped_column(String(64), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    # Which rule versions this prompt encodes (declared dependency; drives change-impact).
    encodes_rule_versions: Mapped[list] = mapped_column(JSON, default=list)
    asset_id: Mapped[str | None] = mapped_column(ForeignKey("assets.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    workflow: Mapped[Workflow] = relationship(back_populates="prompt_versions")


class Model(Base):
    __tablename__ = "models"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    provider: Mapped[str] = mapped_column(String(32))  # anthropic | simulated
    model_id: Mapped[str] = mapped_column(String(80), unique=True)
    label: Mapped[str] = mapped_column(String(120))
    pinned: Mapped[bool] = mapped_column(Boolean, default=True)
    notes: Mapped[str] = mapped_column(Text, default="")


class Transcript(Base):
    __tablename__ = "transcripts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    corpus_hash: Mapped[str] = mapped_column(String(64), index=True)
    product_line: Mapped[str] = mapped_column(String(16))  # MA | PDP | MEDIGAP | LIFE
    synthetic: Mapped[bool] = mapped_column(Boolean, default=True)
    text: Mapped[str] = mapped_column(Text)
    labels: Mapped[dict] = mapped_column(JSON, default=dict)  # ground truth used by contracts
    duration_seconds: Mapped[int] = mapped_column(Integer, default=0)


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_key: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflows.id"))
    prompt_version_id: Mapped[str] = mapped_column(ForeignKey("prompt_versions.id"))
    model_id: Mapped[str] = mapped_column(ForeignKey("models.id"))
    adapter: Mapped[str] = mapped_column(String(16))  # anthropic | cassette | simulated
    corpus_hash: Mapped[str] = mapped_column(String(64))
    contract_set_hash: Mapped[str] = mapped_column(String(64))
    rule_date: Mapped[date] = mapped_column(Date)
    trigger: Mapped[str] = mapped_column(String(16), default="MANUAL")  # RULE|PROMPT|MODEL|MANUAL
    status: Mapped[str] = mapped_column(String(16), default="QUEUED")  # QUEUED|RUNNING|COMPLETE|FAILED
    gate: Mapped[str] = mapped_column(String(8), default="GREY")  # GREEN|AMBER|RED|GREY
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stats: Mapped[dict] = mapped_column(JSON, default=dict)
    requested_by: Mapped[str] = mapped_column(String(64), default="system")

    workflow: Mapped[Workflow] = relationship()
    prompt_version: Mapped[PromptVersion] = relationship()
    model: Mapped[Model] = relationship()
    outputs: Mapped[list[WorkflowOutput]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    results: Mapped[list[RunResult]] = relationship(back_populates="run", cascade="all, delete-orphan")


class WorkflowOutput(Base):
    __tablename__ = "workflow_outputs"
    __table_args__ = (UniqueConstraint("run_id", "transcript_id", name="uq_output_run_transcript"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    transcript_id: Mapped[str] = mapped_column(ForeignKey("transcripts.id"), index=True)
    output: Mapped[dict] = mapped_column(JSON, default=dict)
    route: Mapped[str] = mapped_column(String(8), default="PASS")  # PASS | FLAG | BLOCK
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    usage: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    run: Mapped[Run] = relationship(back_populates="outputs")
    transcript: Mapped[Transcript] = relationship()


class RunResult(Base):
    __tablename__ = "run_results"
    __table_args__ = (
        UniqueConstraint("run_id", "transcript_id", "contract_version_id", name="uq_result"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    transcript_id: Mapped[str] = mapped_column(ForeignKey("transcripts.id"), index=True)
    contract_version_id: Mapped[str] = mapped_column(ForeignKey("contract_versions.id"), index=True)
    outcome: Mapped[str] = mapped_column(String(8))  # PASS | FAIL | FLAG | ERROR
    evidence: Mapped[dict] = mapped_column(JSON, default=dict)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)

    run: Mapped[Run] = relationship(back_populates="results")
    transcript: Mapped[Transcript] = relationship()
    contract_version: Mapped[ContractVersion] = relationship()


# --------------------------------------------------------------------------- review


class ReviewTask(Base):
    __tablename__ = "review_tasks"
    __table_args__ = (UniqueConstraint("dedupe_key", name="uq_review_dedupe"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    kind: Mapped[str] = mapped_column(String(24))  # STALE_ASSET | PROPOSED_EDGE | FLAGGED_RESULT
    dedupe_key: Mapped[str] = mapped_column(String(200))
    state: Mapped[str] = mapped_column(String(16), default="open")
    rule_version_id: Mapped[str | None] = mapped_column(ForeignKey("rule_versions.id"), nullable=True)
    asset_id: Mapped[str | None] = mapped_column(ForeignKey("assets.id"), nullable=True)
    edge_id: Mapped[str | None] = mapped_column(ForeignKey("rule_asset_edges.id"), nullable=True)
    run_result_id: Mapped[str | None] = mapped_column(ForeignKey("run_results.id"), nullable=True)
    staleness_direction: Mapped[str | None] = mapped_column(String(24), nullable=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    assignee_role: Mapped[str] = mapped_column(String(64), default="compliance")
    reason_code: Mapped[str | None] = mapped_column(String(48), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    decided_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)


class TestCase(Base):
    __tablename__ = "test_cases"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    review_task_id: Mapped[str] = mapped_column(ForeignKey("review_tasks.id"), index=True)
    contract_id: Mapped[str] = mapped_column(ForeignKey("contracts.id"))
    transcript_id: Mapped[str | None] = mapped_column(ForeignKey("transcripts.id"), nullable=True)
    expected: Mapped[dict] = mapped_column(JSON, default=dict)
    reason_code: Mapped[str] = mapped_column(String(48))
    created_by: Mapped[str] = mapped_column(String(64))
    approver: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="PENDING_APPROVAL")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RuleSourceCheck(Base):
    """A hashed observation of a rule's primary source (eCFR/LII/Federal Register page).

    The same mechanism that watches EIP's estate for stale encodings watches the
    regulator for changed text. A changed hash opens a RULE_SOURCE_CHANGED task;
    nothing about the rule is edited automatically.
    """

    __tablename__ = "rule_source_checks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    rule_id: Mapped[str] = mapped_column(ForeignKey("rules.id"), index=True)
    source_url: Mapped[str] = mapped_column(String(500))
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    excerpt: Mapped[str] = mapped_column(Text, default="")
    fetch_mode: Mapped[str] = mapped_column(String(16), default="snapshot")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    changed: Mapped[bool] = mapped_column(Boolean, default=False)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(64))
    # "analyst" | "engineer" | "admin" for an authenticated user; "system" for
    # system:<component> actors (never a fabricated person).
    actor_role: Mapped[str] = mapped_column(String(32), default="system")
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    entity_type: Mapped[str] = mapped_column(String(32), index=True)
    entity_id: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    # The HTTP request id (or a CLI invocation id) — ties every row one action wrote together.
    correlation_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # Hash chain: row_hash = sha256(prev_hash + canonical row). Any edit, delete or
    # reorder breaks verification (GET /api/audit/verify). Tamper-evident, not tamper-proof.
    prev_hash: Mapped[str] = mapped_column(String(64), default="")
    row_hash: Mapped[str] = mapped_column(String(64), default="")
