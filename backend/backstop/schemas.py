"""API response/request shapes (Pydantic v2). The frontend is built against these."""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field


def _as_utc(value: datetime) -> datetime:
    """Every timestamp leaves the API with an explicit offset.

    Timestamps are written as UTC, but SQLite hands them back naive; a browser parses a
    naive ISO string as *local* time, which put every run five hours in the future.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


Timestamp = Annotated[datetime, AfterValidator(_as_utc)]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ------------------------------------------------------------------ meta / auth


class MetaOut(BaseModel):
    app: str = "backstop"
    version: str
    environment_label: str
    adapters: dict[str, bool]  # {"simulated": True, "cassette": True, "live": bool}
    providers: dict[str, Any] = {}  # per provider: {available, notes, models[]}
    default_adapter: str
    synthetic_notice: str
    today: date
    user: str | None = None
    role: str | None = None


# ------------------------------------------------------------------ rules


class RuleVersionOut(ORM):
    id: str
    version: int
    # in_force | eliminated | amended | proposed | vacated | stayed (the last three are never in force)
    status: str
    clause_text: str
    summary: str
    effective_from: date | None  # null only for a proposed version with no date yet
    effective_to: date | None
    regulation_effective: date | None = None
    sources: list[dict[str, Any]] = Field(default_factory=list)
    vote_date: date | None = None  # when the regulator votes on a proposed version
    # [{provision, deferred_to (YYYY-MM-DD), source}]: compliance date moved, text unchanged
    deferrals: list[dict[str, Any]] = Field(default_factory=list)
    change_classification: str
    params: dict[str, Any]
    disputed: bool
    dispute_note: str
    source_url: str
    git_commit: str
    created_at: Timestamp


class RuleOut(ORM):
    id: str
    code: str
    title: str
    regulator: str
    citation: str
    applies_to: list[str]
    summary: str
    source_url: str
    versions: list[RuleVersionOut] = []
    in_force_version: int | None = None
    dependents: int = 0  # confirmed edges across all versions
    contracts: list[str] = []


class EdgeOut(ORM):
    id: str
    rule_version_id: str
    rule_version: int
    rule_code: str
    asset_id: str
    asset_code: str
    asset_name: str
    asset_type: str
    asset_url: str | None
    asset_is_synthetic: bool
    owner_role: str
    polarity: str
    evidence_span: str
    span_offset: int
    detection: str
    matcher: str
    confidence: float | None
    status: str
    confirmed_by: str | None
    created_at: Timestamp


class StaleItemOut(BaseModel):
    edge: EdgeOut
    bound_version: int
    in_force_version: int
    direction: str
    reason: str
    disputed: bool
    task_id: str | None = None
    task_state: str | None = None


class ImpactOut(BaseModel):
    rule_code: str
    as_of: date
    in_force_version: int | None
    counts: dict[str, int]
    stale: list[StaleItemOut]
    current_edges: list[EdgeOut]  # edges bound to the in-force version (healthy)
    contracts: list[str]
    prompt_versions: list[dict[str, Any]]  # prompts declaring this rule


class RuleVersionCreate(BaseModel):
    # Mirrors rules_loader.VALID_STATUS / VALID_CLASSIFICATIONS (checked by a test).
    status: Literal["in_force", "eliminated", "amended", "proposed", "vacated", "stayed"] = "proposed"
    clause_text: str = Field(min_length=1, max_length=20_000)
    summary: str = Field(default="", max_length=4_000)
    effective_from: date
    change_classification: Literal[
        "INITIAL", "ADDS_REQUIREMENT", "REMOVES_REQUIREMENT", "TIGHTENS", "LOOSENS", "MODIFIES", "CLARIFIES",
        "RESTORES_PRIOR",
    ]
    params: dict[str, Any] = Field(default_factory=dict)
    disputed: bool = False
    dispute_note: str = Field(default="", max_length=4_000)
    source_url: str = Field(default="", max_length=1_000)


# ------------------------------------------------------------------ assets / scans


class AssetVersionOut(ORM):
    id: str
    content_hash: str
    fetched_at: Timestamp
    fetch_mode: str
    length: int = 0


class AssetOut(ORM):
    id: str
    code: str
    type: str
    name: str
    url: str | None
    source_system: str
    owner_role: str
    is_synthetic: bool
    latest_hash: str | None = None
    latest_fetched_at: Timestamp | None = None
    edge_count: int = 0
    versions: list[AssetVersionOut] = []


class AssetDetailOut(AssetOut):
    content_text: str = ""
    edges: list[EdgeOut] = []


class ScanRequest(BaseModel):
    idempotency_key: str | None = None
    live: bool = False
    as_of: date | None = None


class ScanOut(ORM):
    id: str
    idempotency_key: str
    status: str
    started_at: Timestamp
    finished_at: Timestamp | None
    stats: dict[str, Any]
    deduplicated: bool = False


# ------------------------------------------------------------------ workflows / runs


class PromptVersionOut(ORM):
    id: str
    version: int
    label: str
    prompt_hash: str
    author: str
    notes: str
    encodes_rule_versions: list[Any]
    created_at: Timestamp
    text: str | None = None


class WorkflowOut(ORM):
    id: str
    code: str
    name: str
    description: str
    prompt_versions: list[PromptVersionOut] = []


class ModelOut(ORM):
    id: str
    provider: str
    model_id: str
    label: str
    pinned: bool
    notes: str


class ContractOut(ORM):
    id: str
    code: str
    title: str
    description: str
    kind: str
    severity: str
    owner_role: str
    check: str
    rule_code: str | None = None
    version: int = 1
    spec: dict[str, Any] = {}
    judge_model_id: str | None = None
    n_runs: int | None = None


class RunRequest(BaseModel):
    workflow: str = Field(default="qa-handoff", max_length=64)
    prompt_version: int = Field(ge=1)
    model_id: str = Field(min_length=1, max_length=120)
    adapter: Literal["simulated", "cassette", "live", "anthropic"] | None = None
    rule_date: date
    trigger: Literal["RULE", "PROMPT", "MODEL", "MANUAL"] = "MANUAL"
    limit: int | None = Field(default=None, ge=1, le=10_000)  # cap transcripts (for live runs)
    corpus: Literal["synthetic", "holdout", "ingested", "all"] = "synthetic"
    judge_model_id: str | None = Field(default=None, max_length=120)  # default: same model as the run
    # default: the contract's N (5); lower it on free tiers. Capped: each unit is
    # (transcripts + 6 canary notes) more judge calls on a paid provider.
    judge_n: int | None = Field(default=None, ge=1, le=10)


class ContractSummary(BaseModel):
    code: str
    title: str
    severity: str
    kind: str
    rule_code: str | None
    passed: int
    failed: int
    flagged: int
    errored: int


class RunOut(ORM):
    id: str
    run_key: str
    workflow_code: str
    prompt_version: int
    prompt_label: str
    prompt_hash: str
    model_id: str
    model_label: str
    adapter: str
    corpus_hash: str
    # "synthetic" (development calls T001-T060), "holdout" (H001-H060), "ingested" or "all"
    corpus: str = "synthetic"
    contract_set_hash: str
    rule_date: date
    trigger: str
    status: str
    gate: str
    started_at: Timestamp
    finished_at: Timestamp | None
    stats: dict[str, Any]
    requested_by: str
    deduplicated: bool = False
    contracts: list[ContractSummary] = []


class RunResultOut(ORM):
    id: str
    transcript_code: str
    contract_code: str
    severity: str
    outcome: str
    evidence: dict[str, Any]
    latency_ms: int


class TranscriptOut(ORM):
    id: str
    code: str
    product_line: str
    synthetic: bool
    duration_seconds: int
    labels: dict[str, Any]
    text: str | None = None


class RunTranscriptOut(BaseModel):
    transcript: TranscriptOut
    output: dict[str, Any]
    route: str
    latency_ms: int
    usage: dict[str, Any]
    error: str | None
    results: list[RunResultOut]
    spans: list[dict[str, Any]]  # [{label, text, offset, length, verified}]


class CompareCell(BaseModel):
    transcript_code: str
    contract_code: str
    a: str
    b: str


class CassetteSetOut(BaseModel):
    prompt_version: int | None  # None: recorded under a prompt hash no longer in the workflow
    prompt_hash: str
    generate: int
    judge: int
    canary: int


class ModelBoardRow(BaseModel):
    model: ModelOut
    tier: str                      # simulated | local | free-tier | paid
    supports_tools: bool | None = None
    availability: str              # simulated | ready | needs-key | not-pulled | offline
    availability_detail: str
    key_env: str | None = None
    cassettes: list[CassetteSetOut] = []
    latest_run: RunOut | None = None
    matched: bool = False          # latest_run matches the board's prompt version and rule date
    measured: bool = False         # latest_run's output came from a real model (live or cassette)


class ModelBoardOut(BaseModel):
    prompt_version: int
    rule_date: date
    providers: dict[str, Any]
    rows: list[ModelBoardRow]


class FactorChangeOut(BaseModel):
    factor: str  # prompt | model | rule_date | corpus | contract_set | judge | overrides
    label: str
    a: str
    b: str


class IsolatingPairOut(BaseModel):
    """An existing pair of runs that differs in `factor` alone."""

    factor: str
    label: str
    a_run_id: str
    b_run_id: str


class AttributionOut(BaseModel):
    """Can the difference between A and B be pinned on one change? (core/attribution.py)"""

    verdict: Literal["isolated", "confounded", "repeat"]
    changed: list[FactorChangeOut]
    held_constant: list[str]
    summary: str
    scope_note: str | None = None
    isolating_pairs: list[IsolatingPairOut] = []


class CompareOut(BaseModel):
    a: RunOut
    b: RunOut
    what_changed: dict[str, Any]  # {prompt: bool, model: bool, rule_date: bool, adapter: bool}
    attribution: AttributionOut | None = None
    newly_failing: list[CompareCell]
    newly_passing: list[CompareCell]
    unchanged_failing: int
    unchanged_passing: int
    # {contract_code, a_fail, b_fail, newly_failing, newly_passing, a_error, b_error};
    # a_fail/b_fail count FAIL, FLAG and ERROR (see failure_definition).
    per_contract: list[dict[str, Any]]
    failure_definition: str = ""
    statistics: CompareStatisticsOut | None = None


class RateOut(BaseModel):
    """k failures (or hits) out of n, with a 95% Wilson score interval."""

    k: int
    n: int
    rate: float | None  # None when n == 0
    ci_low: float
    ci_high: float


class PairedTableOut(BaseModel):
    """The same calls scored by both runs. a_only_fail = newly passing in B; b_only_fail = newly failing."""

    both_pass: int
    a_only_fail: int
    b_only_fail: int
    both_fail: int


class ContractComparisonOut(BaseModel):
    contract_code: str  # "ALL-BLOCK": a call fails if any BLOCK contract fails on it
    severity: str | None = None
    failure_outcomes: list[str]
    n_shared: int  # calls scored by both runs (the paired sample)
    paired: PairedTableOut | None  # None when the runs are on different corpora
    a: RateOut
    b: RateOut
    discordant: int | None  # b_only_fail + a_only_fail; None for an unpaired test
    test: str
    p_value: float
    p_holm: float | None = None  # Holm-adjusted across the per-contract family
    significant: bool
    direction: Literal["worse", "better", "none"]
    verdict: str
    cautions: list[str] = []
    excluded_not_evaluated: int = 0  # unlabelled (ingested) cells: not failures, not passes


class HeldOutCheckOut(BaseModel):
    """The same prompt change replayed on the held-out calls (never read while writing prompts)."""

    a_run_id: str
    b_run_id: str
    a_prompt_version: int
    b_prompt_version: int
    direction: str  # better | worse | none
    p_value: float | None
    summary: str
    contradicts_development: bool


class CompareStatisticsOut(BaseModel):
    mode: Literal["paired", "unpaired"]
    alpha: float
    failure_definition: str
    cautions: list[str] = []
    overall: ContractComparisonOut
    per_contract: list[ContractComparisonOut]
    held_out: HeldOutCheckOut | None = None


# ------------------------------------------------------------------ contract metrics


class ConfusionOut(BaseModel):
    unit: str  # "call" or "flagged phrase"
    positive: str  # what counts as a positive (a violation)
    tp: int
    fp: int
    fn: int
    tn: int | None  # None when true negatives are not countable (per-phrase flags)
    not_applicable: int = 0
    not_evaluated: int = 0
    no_output: int = 0  # ERROR cells: no valid model output to classify
    precision: RateOut
    recall: RateOut
    specificity: RateOut | None = None
    false_flag_rate: RateOut | None = None
    miss_rate: RateOut
    f1: float | None


class SliceOut(BaseModel):
    dimension: str  # scenario | product_line
    value: str
    n: int
    failure: RateOut
    tp: int | None = None
    fp: int | None = None
    fn: int | None = None
    tn: int | None = None
    summary: str
    notable: bool = False  # every violation missed, or the slice's CI sits above the overall rate


class RunContractMetricsOut(BaseModel):
    run_id: str
    started_at: Timestamp
    model_id: str
    prompt_version: int
    corpus: str
    rule_date: date
    adapter: str
    outcomes: dict[str, int]
    failure: RateOut
    excluded_not_evaluated: int = 0
    confusion: ConfusionOut | None = None
    slices: list[SliceOut] = []
    findings: list[str] = []


class TrendPointOut(BaseModel):
    run_id: str
    started_at: Timestamp
    model_id: str
    prompt_version: int
    corpus: str
    rule_date: date
    adapter: str
    failure: RateOut


class ContractMetricsOut(BaseModel):
    contract_code: str
    title: str
    kind: str
    severity: str
    check: str
    metric_family: Literal["judgment", "flags", "grounding", "judged"]
    failure_definition: str
    positive_definition: str | None = None
    selection: str
    runs: list[RunContractMetricsOut]
    trend: list[TrendPointOut]


CompareOut.model_rebuild()  # it names CompareStatisticsOut, declared after it


# ------------------------------------------------------------------ review


class ReviewTaskOut(ORM):
    id: str
    kind: str
    state: str
    rule_code: str | None = None
    rule_version: int | None = None
    asset_code: str | None = None
    asset_name: str | None = None
    asset_type: str | None = None
    asset_is_synthetic: bool | None = None
    edge_id: str | None = None
    evidence_span: str | None = None
    run_result_id: str | None = None
    run_id: str | None = None
    contract_code: str | None = None
    transcript_code: str | None = None
    staleness_direction: str | None
    reason: str
    assignee_role: str
    reason_code: str | None
    note: str
    decided_by: str | None
    opened_at: Timestamp
    closed_at: Timestamp | None
    payload: dict[str, Any]
    allowed_transitions: list[str] = []
    lane: str = "actionable"  # actionable (a human decides) | advisory (visible, not a queue)


class TransitionRequest(BaseModel):
    to: str = Field(max_length=32)
    reason_code: str | None = Field(default=None, max_length=48)
    note: str = Field(default="", max_length=4_000)


class TestCaseOut(ORM):
    id: str
    review_task_id: str
    contract_code: str
    transcript_code: str | None = None
    expected: dict[str, Any]
    reason_code: str
    created_by: str
    approver: str | None
    status: str
    expires_at: Timestamp
    created_at: Timestamp


# ------------------------------------------------------------------ audit


class AuditOut(ORM):
    id: int
    ts: Timestamp
    actor: str
    actor_role: str = "system"
    event_type: str
    entity_type: str
    entity_id: str
    payload: dict[str, Any]
    correlation_id: str | None = None
    prev_hash: str = ""
    row_hash: str = ""


class Page(BaseModel):
    items: list[Any]
    total: int


# ------------------------------------------------------------------ me / permissions


class PermissionOut(BaseModel):
    action: str
    label: str
    allowed: bool
    why: str


class RoleOut(BaseModel):
    role: str
    label: str
    description: str
    can: list[str]  # action ids from PermissionOut.action


class MeOut(BaseModel):
    name: str
    role: Literal["analyst", "engineer", "admin"]
    role_label: str
    role_description: str
    permissions: list[PermissionOut]
    roles: list[RoleOut]


# ------------------------------------------------------------------ sandbox (nothing persisted)


class SandboxArtifactRequest(BaseModel):
    # Caps and character rules are enforced by core.sandbox.check_text (422 with a plain message).
    text: str
    as_of: date | None = None
    label: str | None = None


class RedactionCounts(BaseModel):
    """One count per PII kind in ``core.pii.KINDS`` (checked by a test)."""

    medicare_number: int
    ssn: int
    dob: int
    phone: int = 0
    email: int = 0
    address: int = 0


class SandboxMatchOut(BaseModel):
    rule_code: str
    rule_title: str
    citation: str
    bound_version: int
    bound_status: str
    in_force_version: int | None
    polarity: str
    span: str
    offset: int
    matcher: str
    confidence: float | None
    edge_status: Literal["confirmed", "proposed"]
    verdict: Literal["current", "stale", "ahead", "no_version_in_force"]
    direction: Literal["over_restrictive", "under_restrictive", "reverify"] | None
    reason: str
    applies_from: date | None
    regulation_effective: date | None
    disputed: bool


class SandboxSummaryOut(BaseModel):
    matches: int
    stale: int  # confirmed readings only; a proposed reading is counted in needs_review
    current: int
    rules_touched: int
    over_restrictive: int
    under_restrictive: int
    reverify: int
    needs_review: int = 0  # proposed matches: a human must confirm what the sentence encodes


class SandboxArtifactOut(BaseModel):
    as_of: date
    label: str | None
    text_sha256: str
    chars: int
    redacted: RedactionCounts
    matches: list[SandboxMatchOut]
    summary: SandboxSummaryOut
    persisted: Literal[False] = False
    note: str


class SandboxTranscriptRequest(BaseModel):
    text: str
    product_line: Literal["MA", "PDP", "MEDIGAP", "LIFE"] = "MA"
    model_id: str | None = Field(default=None, max_length=100)


class SandboxContractOut(BaseModel):
    code: str
    title: str
    severity: str
    outcome: Literal["PASS", "FAIL", "FLAG", "ERROR", "NEEDS_LABEL"]
    evidence: dict[str, Any] | None = None
    why: str | None = None


class SandboxTranscriptOut(BaseModel):
    model_id: str
    latency_ms: int
    redacted: RedactionCounts
    output: dict[str, Any]
    contracts: list[SandboxContractOut]
    persisted: Literal[False] = False
    note: str


class SandboxSample(BaseModel):
    label: str
    text: str


class SandboxSamplesOut(BaseModel):
    artifacts: list[SandboxSample]
    transcripts: list[SandboxSample]


# ------------------------------------------------------------------ readiness (read-only)


class MilestoneOut(BaseModel):
    date: date
    label: str
    kind: Literal["rule_applies", "aep_start", "aep_end", "oep_start", "vote", "deferral_ends", "marketing_start"]
    rule_code: str | None = None
    version: int | None = None
    status: str | None = None
    days_from_as_of: int


class HorizonItemOut(BaseModel):
    rule_code: str
    rule_title: str
    version: int
    applies_from: date
    change_classification: str
    stale_encodings_on_that_date: int  # confirmed edges stale on applies_from (evaluated, nothing written)
    artifacts_on_that_date: int  # distinct artifacts behind those edges
    open_tasks: int  # open review tasks already keyed to this version


class OwnerQueueOut(BaseModel):
    role: str
    open: int
    actionable: int
    oldest_days: float | None
    median_age_days: float | None
    by_kind: dict[str, int]


class AepOut(BaseModel):
    date: date
    days_left: int


class BurnDownOut(BaseModel):
    target: date
    label: str
    open_actionable_now: int
    stale_encodings_on_target: int
    days_left: int
    aep: AepOut
    note: str = ""


class SetAsideVersionOut(BaseModel):
    rule_code: str
    version: int
    status: Literal["vacated", "stayed"]
    why: str
    source: str  # top-ranked source citation
    source_url: str = ""


class ProposedVersionOut(BaseModel):
    rule_code: str
    version: int
    vote_date: date | None
    why: str
    effective_from: date | None = None
    origin: Literal["yaml", "api"] = "yaml"


class ReadinessOut(BaseModel):
    as_of: date
    generated_at: Timestamp  # task ages are measured at this instant, not at as_of
    milestones: list[MilestoneOut]
    # Disjoint bands of enacted versions that start applying: "30" = as_of..as_of+30 days,
    # "60" = +31..+60, "90" = +61..+90.
    horizon: dict[str, list[HorizonItemOut]]
    owners: list[OwnerQueueOut]
    burn_down: BurnDownOut
    vacated: list[SetAsideVersionOut]
    proposed: list[ProposedVersionOut]


# ------------------------------------------------------------------ governance (admin)


class AccessAccountOut(BaseModel):
    name: str
    role: str
    role_label: str
    default_credentials: bool  # password == username: localhost only
    last_recorded_action_at: datetime | None  # audit rows record changes and exports, not page views
    last_recorded_action: str | None
    actions_30d: int
    denied_30d: int


class DeniedAttemptOut(BaseModel):
    ts: datetime
    actor: str
    kind: Literal["bad_credentials", "insufficient_role"]
    detail: str


class AccessActionOut(BaseModel):
    action: str
    label: str
    roles: list[str]
    rule: str


class AccessReviewOut(BaseModel):
    generated_at: datetime
    identity_source: str
    accounts: list[AccessAccountOut]
    default_credential_accounts: int
    denied_24h: int
    recent_denied: list[DeniedAttemptOut]
    matrix: list[AccessActionOut]
    roles: list[dict[str, Any]]


class AuditCheckpointOut(BaseModel):
    """A receipt to keep outside the database; GET /api/audit/verify?through_id=&tip= checks it."""

    id: int
    taken_at: datetime
    taken_by: str
    through_id: int
    tip: str
    rows_verified: int
    verify_path: str
