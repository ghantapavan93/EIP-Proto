/**
 * TypeScript mirror of backend/backstop/schemas.py (Pydantic v2).
 *
 * Conventions: `date` → ISO "YYYY-MM-DD" string; `datetime` → ISO 8601 string;
 * `dict[str, Any]` → `Record<string, unknown>` (narrow at the point of use,
 * never `any`). Vocabulary unions follow docs/api-contract.md verbatim; fields
 * typed with a union may still carry an unknown value from the API, so chip
 * mappers accept `string` and fall back to a neutral rendering.
 */

// ------------------------------------------------------------- vocabulary

export type ChangeClassification =
  | 'INITIAL'
  | 'ADDS_REQUIREMENT'
  | 'REMOVES_REQUIREMENT'
  | 'TIGHTENS'
  | 'LOOSENS'
  | 'MODIFIES'
  | 'CLARIFIES'
  /** a court vacated the newer text; the prior text governs again */
  | 'RESTORES_PRIOR';

/**
 * vacated: a court set the version aside (never enforced); stayed: enforcement
 * paused by a court or the agency; proposed: not law, only what-if.
 */
export type RuleVersionStatus = 'in_force' | 'eliminated' | 'amended' | 'proposed' | 'vacated' | 'stayed';

export type ArtifactType =
  | 'web_page'
  | 'scorecard_item'
  | 'script_section'
  | 'coaching_prompt'
  | 'email_template'
  | 'training_slide'
  | 'ivr_script'
  | 'workflow_prompt'
  | 'web_form'
  | 'comp_schedule'
  | 'dialer_policy';

export type EdgePolarity = 'ENFORCES' | 'PERMITS' | 'INFORMS';
export type EdgeDetection = 'deterministic' | 'llm' | 'manual';
export type EdgeStatus = 'proposed' | 'confirmed' | 'rejected' | 'superseded';

export type StalenessDirection = 'over_restrictive' | 'under_restrictive' | 'reverify';

export type ContractSeverity = 'BLOCK' | 'FLAG';
export type ContractKind = 'DETERMINISTIC' | 'JUDGED';

export type RunTrigger = 'RULE' | 'PROMPT' | 'MODEL' | 'MANUAL';
export type RunStatus = 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'FAILED';
export type Gate = 'GREEN' | 'AMBER' | 'RED' | 'GREY';
export type Outcome = 'PASS' | 'FAIL' | 'FLAG' | 'ERROR';
export type Route = 'PASS' | 'FLAG' | 'BLOCK';
export type Adapter = 'simulated' | 'cassette' | 'live' | 'anthropic';

export type ReviewKind = 'STALE_ASSET' | 'PROPOSED_EDGE' | 'FLAGGED_RESULT' | 'RULE_SOURCE_CHANGED';
export type ReviewState =
  | 'open'
  | 'in_review'
  | 'verified'
  | 'republished'
  | 'dismissed'
  | 'upheld'
  | 'overridden';

export type ReasonCode =
  | 'FALSE_POSITIVE_MATCHER'
  | 'FALSE_POSITIVE_JUDGE'
  | 'TRANSCRIPT_AMBIGUOUS'
  | 'RULE_EXCEPTION_APPLIES'
  | 'CORRECT_AS_FLAGGED'
  | 'ARTIFACT_ALREADY_UPDATED'
  | 'ARTIFACT_NOT_IN_SCOPE'
  | 'NEEDS_COUNSEL'
  | 'OTHER';

export type Role = 'analyst' | 'engineer' | 'admin';

export type TestCaseStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'EXPIRED';

export type JsonObject = Record<string, unknown>;

// ------------------------------------------------------------- meta / auth

export interface ProviderInfo {
  available: boolean;
  notes: string;
  rpm?: number;
  rpd?: number | null;
  models: string[];
  local_models?: string[];
}

export interface MetaOut {
  app: string;
  version: string;
  environment_label: string;
  adapters: Record<string, boolean>; // {"simulated": true, "cassette": true, "live": boolean, "anthropic": boolean}
  providers?: Record<string, ProviderInfo>;
  default_adapter: string;
  synthetic_notice: string;
  today: string;
  user: string | null;
  role: string | null;
}

// ------------------------------------------------------------- rules

/** Provenance authority, ranked primary → preamble → secondary. */
export type SourceAuthority = 'primary' | 'preamble' | 'secondary';

/** RuleVersionOut.sources entries. */
export interface RuleSourceRef {
  authority: SourceAuthority | string;
  cite: string;
  url: string;
  reading: string;
}

/** A provision of a version whose compliance date was pushed back. */
export interface RuleDeferral {
  provision: string;
  /** YYYY-MM-DD */
  deferred_to: string;
  source: string;
}

export interface RuleVersionOut {
  id: string;
  version: number;
  status: RuleVersionStatus | string;
  clause_text: string;
  summary: string;
  /**
   * "Applies from": the operational date this version governs from. Null for
   * a proposal still awaiting its vote (no date to apply from yet).
   */
  effective_from: string | null;
  effective_to: string | null;
  /** Legal effective date of the regulation itself (may precede effective_from). */
  regulation_effective?: string | null;
  sources?: RuleSourceRef[];
  change_classification: ChangeClassification | string;
  params: JsonObject;
  disputed: boolean;
  dispute_note: string;
  source_url: string;
  git_commit: string;
  created_at: string;
  /** scheduled vote on a proposal (an agency open meeting); null when none is scheduled */
  vote_date?: string | null;
  /** provisions whose compliance date moved later than effective_from */
  deferrals?: RuleDeferral[];
}

export interface RuleOut {
  id: string;
  code: string;
  title: string;
  regulator: string;
  citation: string;
  applies_to: string[];
  summary: string;
  source_url: string;
  versions: RuleVersionOut[];
  in_force_version: number | null;
  dependents: number; // confirmed edges across all versions
  contracts: string[];
}

export interface EdgeOut {
  id: string;
  rule_version_id: string;
  rule_version: number;
  rule_code: string;
  asset_id: string;
  asset_code: string;
  asset_name: string;
  asset_type: ArtifactType | string;
  asset_url: string | null;
  asset_is_synthetic: boolean;
  owner_role: string;
  polarity: EdgePolarity | string;
  evidence_span: string;
  span_offset: number;
  detection: EdgeDetection | string;
  matcher: string;
  confidence: number | null;
  status: EdgeStatus | string;
  confirmed_by: string | null;
  created_at: string;
}

export interface StaleItemOut {
  edge: EdgeOut;
  bound_version: number;
  in_force_version: number;
  direction: StalenessDirection | string;
  reason: string;
  disputed: boolean;
  task_id: string | null;
  task_state: string | null;
}

/** A declared rule-version dependency: PromptVersionOut.encodes_rule_versions[] and prompt diffs. */
export interface RuleVersionRef {
  rule: string;
  version: number;
}

/** ImpactOut.prompt_versions entries (dict[str, Any] in the contract; shape observed on the live API). */
export interface ImpactPromptVersion {
  id: string;
  workflow: string;
  version: number;
  label: string;
  prompt_hash: string;
  declared_version: number | null;
  stale: boolean;
}

/**
 * ImpactOut.counts. `total` counts edges (encodings); `artifacts` counts distinct
 * artifacts — the UI says "N artifacts · M encodings", never "M artifacts".
 */
export interface ImpactCounts {
  over_restrictive: number;
  under_restrictive: number;
  reverify: number;
  disputed: number;
  total: number;
  artifacts: number;
  [key: string]: number;
}

export interface ImpactOut {
  rule_code: string;
  as_of: string;
  in_force_version: number | null;
  counts: ImpactCounts;
  stale: StaleItemOut[];
  current_edges: EdgeOut[]; // edges bound to the in-force version (healthy)
  contracts: string[];
  prompt_versions: ImpactPromptVersion[];
}

/**
 * GET /rules/{code}/impact?include_proposed=true&assume_version=N — the same
 * blast radius as if a proposed version were enacted. Nothing is written: no
 * tasks, no audit rows. hypothetical=false means no proposal applied (see note).
 */
export interface ImpactWhatIfOut extends ImpactOut {
  hypothetical?: boolean;
  assumed_version?: number | null;
  note?: string;
}

export interface RuleVersionCreate {
  /** The API accepts only "proposed" (422 otherwise); enacted history comes from reviewed YAML. */
  status?: 'proposed';
  clause_text: string;
  summary?: string;
  effective_from: string;
  change_classification: string;
  params?: JsonObject;
  disputed?: boolean;
  dispute_note?: string;
  source_url?: string;
}

export interface RulesReloadOut {
  rules_created: number;
  versions_created: number;
  unchanged: number;
  files: string[];
}

/** GET /rules/{code}/sources — newest first. */
export interface RuleSourceOut {
  id: string;
  source_url: string;
  content_hash: string;
  excerpt: string;
  fetch_mode: string;
  error: string | null;
  changed: boolean;
  checked_at: string;
}

/** POST /sources/check?live= */
export interface SourcesCheckOut {
  checked: number;
  changed: number;
  unchanged: number;
  first_seen: number;
  errors: number;
  mode: string;
}

// ------------------------------------------------------------- assets / scans

export interface AssetVersionOut {
  id: string;
  content_hash: string;
  fetched_at: string;
  fetch_mode: string;
  length: number;
}

export interface AssetOut {
  id: string;
  code: string;
  type: ArtifactType | string;
  name: string;
  url: string | null;
  source_system: string;
  owner_role: string;
  is_synthetic: boolean;
  latest_hash: string | null;
  latest_fetched_at: string | null;
  edge_count: number;
  versions: AssetVersionOut[];
}

export interface AssetDetailOut extends AssetOut {
  content_text: string;
  edges: EdgeOut[];
}

export interface ScanRequest {
  idempotency_key?: string | null;
  live?: boolean;
  as_of?: string | null;
}

/** ScanOut.stats as observed on the live API (dict[str, Any] in the contract). */
export interface ScanStats {
  artifacts?: number;
  unchanged?: number;
  new_versions?: number;
  fetch_errors?: number;
  edges_new?: number;
  /** confirmed edges whose quoted span disappeared when the artifact changed */
  edges_superseded?: number;
  edges_existing?: number;
  proposed_new?: number;
  mode?: string;
  as_of?: string;
  staleness?: Record<string, ImpactCounts>;
  llm?: unknown;
  [key: string]: unknown;
}

export interface ScanOut {
  id: string;
  idempotency_key: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  stats: ScanStats;
  deduplicated: boolean;
}

// ------------------------------------------------------------- workflows / runs

export interface PromptVersionOut {
  id: string;
  version: number;
  label: string;
  prompt_hash: string;
  author: string;
  notes: string;
  encodes_rule_versions: RuleVersionRef[];
  created_at: string;
  text: string | null;
}

/** GET /prompts/diff?a=&b= (prompt version ids). */
export interface PromptDiffSide {
  id: string;
  version: number;
  label: string;
  prompt_hash: string;
}

export interface PromptDiffOut {
  a: PromptDiffSide;
  b: PromptDiffSide;
  unified_diff: string[];
  rule_dependencies: {
    removed: RuleVersionRef[];
    added: RuleVersionRef[];
    unchanged: RuleVersionRef[];
  };
}

export interface WorkflowOut {
  id: string;
  code: string;
  name: string;
  description: string;
  prompt_versions: PromptVersionOut[];
}

export interface ModelOut {
  id: string;
  provider: string;
  model_id: string;
  label: string;
  pinned: boolean;
  notes: string;
}

export interface CassetteSetOut {
  prompt_version: number | null;
  prompt_hash: string;
  generate: number;
  judge: number;
  canary: number;
}

export type ModelTier = 'simulated' | 'local' | 'free-tier' | 'paid';
export type ModelAvailability = 'simulated' | 'ready' | 'needs-key' | 'not-pulled' | 'offline';

export interface ModelBoardRow {
  model: ModelOut;
  tier: ModelTier | string;
  supports_tools: boolean | null;
  availability: ModelAvailability | string;
  availability_detail: string;
  key_env: string | null;
  cassettes: CassetteSetOut[];
  latest_run: RunOut | null;
  /** latest_run matches the board's prompt version and rule date */
  matched: boolean;
  /** latest_run's output came from a real model (live or cassette), not a declared profile */
  measured: boolean;
}

export interface ProviderBoardInfo {
  available: boolean;
  key_env: string | null;
  notes: string;
  rpm?: number;
  rpd?: number | null;
  local_models?: string[];
}

export interface ModelBoardOut {
  prompt_version: number;
  rule_date: string;
  providers: Record<string, ProviderBoardInfo>;
  rows: ModelBoardRow[];
}

export interface ContractOut {
  id: string;
  code: string;
  title: string;
  description: string;
  kind: ContractKind | string;
  severity: ContractSeverity | string;
  owner_role: string;
  check: string;
  rule_code: string | null;
  version: number;
  spec: JsonObject;
  judge_model_id: string | null;
  n_runs: number | null;
}

/**
 * synthetic = the 60 development calls (T001–T060) the prompts were written against;
 * holdout = 60 calls (H001–H060) recorded after the prompts were written (CLI only);
 * ingested = redacted real exports (no ground truth); all = everything.
 */
export type RunCorpus = 'synthetic' | 'holdout' | 'ingested' | 'all';

export interface RunRequest {
  workflow?: string;
  prompt_version: number;
  model_id: string;
  adapter?: string | null;
  rule_date: string;
  trigger?: string;
  limit?: number | null;
  /** default synthetic; ingested transcripts have no ground truth → rule contracts report ERROR */
  corpus?: RunCorpus;
  judge_model_id?: string | null;
  judge_n?: number | null;
}

/** RunOut.stats.judge_stability — six canary notes scored N times each. */
export interface JudgeCanaryNote {
  id: string;
  band: [number, number];
  scores: number[];
  mean: number;
  variance: number;
  in_band: boolean;
}

export interface JudgeStability {
  notes: JudgeCanaryNote[];
  n_per_note: number;
  out_of_band: number;
  mean_variance: number;
  stable: boolean;
  note: string;
}

/** RunOut.stats.cost */
export interface CostStats {
  usd: number;
  per_call_usd: number;
  basis: string;
  projection?: {
    calls_per_day: number;
    usd_per_day: number;
    usd_per_aep: number;
    note?: string;
  };
  input_tokens?: number;
  output_tokens?: number;
}

export interface OutcomeCounts {
  PASS: number;
  FAIL: number;
  FLAG: number;
  ERROR: number;
}

/** RunOut.stats as observed on the live API (dict[str, Any] in the contract). Narrow with lib/runStats. */
export interface RunStats {
  transcripts?: number;
  adapter_errors?: number;
  review_tasks_opened?: number;
  /** aggregate advisory observations (FLAG-severity / judged contracts), not tickets */
  advisory_items_opened?: number;
  contracts?: Record<string, OutcomeCounts>;
  logic_in_force?: Record<string, unknown>;
  logic_declared_by_prompt?: Record<string, unknown>;
  latency_ms_total?: number;
  latency_ms_per_transcript?: number;
  judge_stability?: JudgeStability;
  cost?: CostStats;
  /** approved override test cases this run honoured (applied = results pinned by a test case) */
  test_cases?: { applied?: number; [key: string]: unknown };
}

export type ExportFormat = 'braintrust' | 'langsmith' | 'csv';

export interface ContractSummary {
  code: string;
  title: string;
  severity: ContractSeverity | string;
  kind: ContractKind | string;
  rule_code: string | null;
  passed: number;
  failed: number;
  flagged: number;
  errored: number;
}

export interface RunOut {
  id: string;
  run_key: string;
  workflow_code: string;
  prompt_version: number;
  prompt_label: string;
  prompt_hash: string;
  model_id: string;
  model_label: string;
  adapter: Adapter | string;
  corpus_hash: string;
  /** Which call set the run replayed; missing on older servers means synthetic. Also in stats.corpus. */
  corpus?: RunCorpus | string;
  contract_set_hash: string;
  rule_date: string;
  trigger: RunTrigger | string;
  status: RunStatus | string;
  gate: Gate | string;
  started_at: string;
  finished_at: string | null;
  stats: JsonObject;
  requested_by: string;
  deduplicated: boolean;
  contracts: ContractSummary[];
}

export interface RunResultOut {
  id: string;
  transcript_code: string;
  contract_code: string;
  severity: ContractSeverity | string;
  outcome: Outcome | string;
  evidence: JsonObject;
  latency_ms: number;
}

export interface TranscriptOut {
  id: string;
  code: string;
  product_line: string;
  synthetic: boolean;
  duration_seconds: number;
  labels: JsonObject;
  text: string | null;
}

/** RunTranscriptOut.spans entries: [{label, text, offset, length, verified}] */
export interface SpanOut {
  label: string;
  text: string;
  offset: number;
  length: number;
  verified: boolean;
}

export interface RunTranscriptOut {
  transcript: TranscriptOut;
  output: JsonObject;
  route: Route | string;
  latency_ms: number;
  usage: JsonObject;
  error: string | null;
  results: RunResultOut[];
  spans: SpanOut[];
}

export interface CompareCell {
  transcript_code: string;
  contract_code: string;
  a: Outcome | string;
  b: Outcome | string;
}

export interface WhatChanged {
  prompt?: boolean;
  model?: boolean;
  rule_date?: boolean;
  adapter?: boolean;
  corpus?: boolean;
  contract_set?: boolean;
  /** (call, contract) cells only one run scored; they are excluded from every delta. */
  cells_only_in_a?: number;
  cells_only_in_b?: number;
  [key: string]: unknown;
}

/**
 * CompareOut.per_contract entries. a_fail/b_fail count every non-PASS outcome
 * (FAIL, FLAG and ERROR); a_error/b_error break out the ERROR share.
 */
export interface PerContractDelta {
  contract_code: string;
  a_fail: number;
  b_fail: number;
  newly_failing: number;
  newly_passing: number;
  a_error?: number;
  b_error?: number;
}

/** k failures (or hits) out of n, with a 95% Wilson score interval. rate is null when n = 0. */
export interface RateOut {
  k: number;
  n: number;
  rate: number | null;
  ci_low: number;
  ci_high: number;
}

/** The same calls scored by both runs. a_only_fail = newly passing in B; b_only_fail = newly failing. */
export interface PairedTableOut {
  both_pass: number;
  a_only_fail: number;
  b_only_fail: number;
  both_fail: number;
}

export type ComparisonDirection = 'worse' | 'better' | 'none';

export interface ContractComparisonOut {
  /** "ALL-BLOCK": a call fails if any BLOCK contract fails on it */
  contract_code: string;
  severity?: string | null;
  failure_outcomes: string[];
  /** calls scored by both runs (the paired sample) */
  n_shared: number;
  /** null when the runs scored different calls (unpaired test) */
  paired: PairedTableOut | null;
  a: RateOut;
  b: RateOut;
  /** b_only_fail + a_only_fail; null for an unpaired test */
  discordant: number | null;
  test: string;
  p_value: number;
  /** Holm-adjusted across the per-contract family; null on the overall row */
  p_holm?: number | null;
  significant: boolean;
  direction: ComparisonDirection | string;
  verdict: string;
  cautions: string[];
  /** unlabelled (ingested) cells: not failures, not passes */
  excluded_not_evaluated?: number;
}

export interface CompareStatisticsOut {
  mode: 'paired' | 'unpaired' | string;
  alpha: number;
  failure_definition: string;
  cautions: string[];
  overall: ContractComparisonOut;
  per_contract: ContractComparisonOut[];
}

export interface CompareOut {
  a: RunOut;
  b: RunOut;
  what_changed: WhatChanged;
  newly_failing: CompareCell[];
  newly_passing: CompareCell[];
  unchanged_failing: number;
  unchanged_passing: number;
  per_contract: PerContractDelta[];
  /** what a_fail/b_fail count (older servers omit it) */
  failure_definition?: string;
  /** "is this difference real?" — exact tests and Wilson intervals (older servers omit it) */
  statistics?: CompareStatisticsOut | null;
}

// ------------------------------------------------------------- contract metrics

export type MetricFamily = 'judgment' | 'flags' | 'grounding' | 'judged';

/** Confusion matrix with positive = violation. tn is null when true negatives are not countable. */
export interface ConfusionOut {
  /** "call" or "flagged phrase" */
  unit: string;
  positive: string;
  tp: number;
  fp: number;
  fn: number;
  tn: number | null;
  not_applicable: number;
  not_evaluated: number;
  /** ERROR cells: no valid model output to classify */
  no_output: number;
  precision: RateOut;
  recall: RateOut;
  specificity?: RateOut | null;
  false_flag_rate?: RateOut | null;
  miss_rate: RateOut;
  f1: number | null;
}

export interface SliceOut {
  /** scenario | product_line */
  dimension: string;
  value: string;
  n: number;
  failure: RateOut;
  tp?: number | null;
  fp?: number | null;
  fn?: number | null;
  tn?: number | null;
  summary: string;
  /** every violation missed, or the slice's CI sits above the overall rate */
  notable: boolean;
}

export interface RunContractMetricsOut {
  run_id: string;
  started_at: string;
  model_id: string;
  prompt_version: number;
  corpus: RunCorpus | string;
  rule_date: string;
  adapter: string;
  outcomes: Record<string, number>;
  failure: RateOut;
  excluded_not_evaluated: number;
  confusion: ConfusionOut | null;
  slices: SliceOut[];
  findings: string[];
}

export interface TrendPointOut {
  run_id: string;
  started_at: string;
  model_id: string;
  prompt_version: number;
  corpus: RunCorpus | string;
  rule_date: string;
  adapter: string;
  failure: RateOut;
}

/** GET /contracts/{code}/metrics?run_id=&corpus=&rule_date= */
export interface ContractMetricsOut {
  contract_code: string;
  title: string;
  kind: string;
  severity: string;
  check: string;
  metric_family: MetricFamily | string;
  failure_definition: string;
  positive_definition: string | null;
  selection: string;
  runs: RunContractMetricsOut[];
  trend: TrendPointOut[];
}

export interface ContractMetricsQuery {
  run_id?: string;
  corpus?: RunCorpus;
  rule_date?: string;
}

// ------------------------------------------------------------- readiness

/**
 * rule_applies = an enacted version starts to govern; vote = a proposal is
 * voted on; deferral_ends = a deferred provision lands; marketing_start /
 * aep_start / aep_end / oep_start = the Medicare calendar.
 */
export type MilestoneKind = 'rule_applies' | 'vote' | 'deferral_ends' | 'marketing_start' | 'aep_start' | 'aep_end' | 'oep_start';

export interface ReadinessMilestone {
  date: string;
  label: string;
  kind: MilestoneKind | string;
  rule_code?: string | null;
  version?: number | null;
  status?: string | null;
  /** negative when the milestone is already past */
  days_from_as_of: number;
}

/** One rule version that starts to govern inside the horizon, and what is not ready for it. */
export interface ReadinessHorizonItem {
  rule_code: string;
  rule_title: string;
  version: number;
  applies_from: string;
  change_classification: string;
  stale_encodings_on_that_date: number;
  artifacts_on_that_date: number;
  open_tasks: number;
}

export interface ReadinessOwner {
  role: string;
  open: number;
  actionable: number;
  oldest_days: number | null;
  median_age_days: number | null;
  by_kind: Record<string, number>;
}

export interface ReadinessBurnDown {
  target: string;
  label: string;
  open_actionable_now: number;
  stale_encodings_on_target: number;
  days_left: number;
  aep: { date: string; days_left: number };
  /** what the numbers can and cannot say (no history table, so no trend line) */
  note?: string;
}

/** A version a court or agency set aside: kept for the record, never enforced. */
export interface ReadinessVacated {
  rule_code: string;
  version: number;
  status?: 'vacated' | 'stayed' | string;
  why: string;
  /** top-ranked source citation */
  source: string;
  source_url?: string;
}

export interface ReadinessProposed {
  rule_code: string;
  version: number;
  vote_date: string | null;
  why: string;
  effective_from?: string | null;
  /** yaml = in the reviewed corpus; api = recorded from the UI */
  origin?: 'yaml' | 'api' | string;
}

/** GET /readiness?as_of= */
export interface ReadinessOut {
  as_of: string;
  /** owner ages are measured at this instant, not at as_of */
  generated_at?: string;
  milestones: ReadinessMilestone[];
  /**
   * Disjoint bands of enacted versions that start applying: "30" = as_of..+30
   * days, "60" = +31..+60, "90" = +61..+90.
   */
  horizon: Record<string, ReadinessHorizonItem[]>;
  owners: ReadinessOwner[];
  burn_down: ReadinessBurnDown;
  vacated: ReadinessVacated[];
  proposed: ReadinessProposed[];
}

// ------------------------------------------------------------- review

export interface ReviewTaskOut {
  id: string;
  kind: ReviewKind | string;
  state: ReviewState | string;
  rule_code: string | null;
  rule_version: number | null;
  asset_code: string | null;
  asset_name: string | null;
  asset_type: string | null;
  asset_is_synthetic: boolean | null;
  edge_id: string | null;
  evidence_span: string | null;
  run_result_id: string | null;
  run_id: string | null;
  contract_code: string | null;
  transcript_code: string | null;
  staleness_direction: StalenessDirection | string | null;
  reason: string;
  assignee_role: string;
  reason_code: ReasonCode | string | null;
  note: string;
  decided_by: string | null;
  opened_at: string;
  closed_at: string | null;
  payload: JsonObject;
  allowed_transitions: string[];
  /** actionable = a human decides; advisory = visible aggregate, not a work item */
  lane?: ReviewLane | string;
}

export type ReviewLane = 'actionable' | 'advisory';

export interface TransitionRequest {
  to: string;
  reason_code?: string | null;
  note?: string;
}

export interface TestCaseOut {
  id: string;
  review_task_id: string;
  contract_code: string;
  transcript_code: string | null;
  expected: JsonObject;
  reason_code: string;
  created_by: string;
  approver: string | null;
  status: TestCaseStatus | string;
  expires_at: string;
  created_at: string;
}

// ------------------------------------------------------------- evals / ingest / health

export interface MatcherEvalCounts {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
}

export interface MatcherEvalCase {
  id: string;
  text: string;
  expected: Array<[string, number]>;
  detected: Array<[string, number]>;
  detected_status: Record<string, string>;
  false_positive: Array<[string, number]>;
  false_negative: Array<[string, number]>;
  known_limitation: boolean;
}

/** GET /evals/matchers */
export interface MatcherEvalOut {
  summary: MatcherEvalCounts & {
    cases: number;
    known_limitations: number;
    suite?: string;
    /** "fixture": metrics describe curated fixtures, not production accuracy */
    metric_scope?: string;
    disclaimer?: string;
    positives?: number;
    negatives?: number;
  };
  per_rule: Record<string, MatcherEvalCounts>;
  cases: MatcherEvalCase[];
}

/** GET /ingest/formats */
export interface IngestFormat {
  description: string;
  columns: Record<string, string>;
  redaction: string;
}

export type IngestFormatsOut = Record<string, IngestFormat>;

/** POST /ingest/transcripts?format= */
export interface IngestResultOut {
  format: string;
  created: number;
  skipped_existing: number;
  redacted: { medicare_number: number; ssn: number; dob: number; [key: string]: number };
  batch_hash: string;
  note: string;
}

export type ComponentState = 'healthy' | 'offline' | 'down' | string;

/** One readiness component: api, database, rules, artifacts, runner, ollama (optional). */
export interface HealthComponent {
  name: string;
  state: ComponentState;
  detail: string;
  /** optional components (ollama) never make the app unhealthy */
  required: boolean;
}

export type SystemStatus = 'healthy' | 'degraded' | 'down';

/** GET /health/deep (no auth) */
export interface HealthDeepOut {
  version: string;
  time: string;
  database: string;
  rules: number;
  contracts: number;
  /** transcripts excluding the held-out calls */
  transcripts: number;
  /** held-out calls (H001–H060), kept out of every default view */
  holdout_transcripts?: number;
  artifact_versions: number;
  artifacts?: number;
  last_scan: { id: string; status: string; finished_at: string | null } | null;
  adapters: Record<string, boolean>;
  ready: boolean;
  status?: SystemStatus | string;
  components?: HealthComponent[];
  /** true while any account still has password == username (localhost demo only). */
  default_credentials?: boolean;
}

/** GET /status — everything the global status rail shows. */
export interface StatusOut {
  status: SystemStatus | string;
  components: HealthComponent[];
  counts: { rules: number; artifacts: number; contracts: number; golden_cases: number; transcripts: number };
  last_run: {
    id: string;
    finished_at: string | null;
    gate: Gate | string;
    status: RunStatus | string;
    model_id: string;
    prompt_version: number;
    trigger: RunTrigger | string;
  } | null;
  review: { actionable_open: number; advisory_open: number };
  audit_chain: { verified: boolean; rows: number };
  user: { name: string; role: Role | string };
  environment_label: string;
}

// ------------------------------------------------------------- evidence bundles

export type EvidenceScope = 'tasks' | 'runs' | 'rules';
export type EvidenceFormat = 'json' | 'md';

// ------------------------------------------------------------- audit

export interface AuditOut {
  id: number;
  ts: string;
  /** "system:scanner" etc. for automation; a username for people */
  actor: string;
  /** "system" | analyst | engineer | admin | unauthenticated */
  actor_role?: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload: JsonObject;
  /** rows written by one request / CLI invocation share this id */
  correlation_id?: string | null;
  prev_hash?: string;
  row_hash?: string;
}

/** GET /audit/verify */
export interface AuditVerifyOut {
  ok: boolean;
  checked: number;
  first_broken_id: number | null;
  reason: string | null;
  tip: string;
}

export interface Page<T> {
  items: T[];
  total: number;
}

// ------------------------------------------------------------- query params

export interface AuditQuery {
  entity_type?: string;
  event_type?: string;
  entity_id?: string;
  actor?: string;
  correlation_id?: string;
  limit?: number;
  offset?: number;
}

export interface ReviewQuery {
  state?: string;
  kind?: string;
  lane?: ReviewLane;
}

export interface RunResultsQuery {
  contract?: string;
  outcome?: string;
  transcript?: string;
}

// ------------------------------------------------------------- identity / roles

/** One line of "what you can do": GET /me permissions[]. */
export interface MePermission {
  action: string;
  label: string;
  allowed: boolean;
  /** why it is allowed or refused, in plain words ("Engineers and admins can start runs") */
  why: string;
}

/** GET /me roles[]: the role explainer. */
export interface RoleInfo {
  role: Role | string;
  label: string;
  description: string;
  can: string[];
}

/** GET /me */
export interface MeOut {
  name: string;
  role: Role | string;
  role_label: string;
  role_description: string;
  permissions: MePermission[];
  roles: RoleInfo[];
}

// ------------------------------------------------------------- sandbox (nothing persisted)

export interface RedactionCounts {
  medicare_number: number;
  ssn: number;
  dob: number;
  /** newer servers also redact contact details */
  phone?: number;
  email?: number;
  address?: number;
  [key: string]: number | undefined;
}

export type SandboxVerdict = 'current' | 'stale' | 'ahead' | 'no_version_in_force';

/** POST /sandbox/artifact request. */
export interface SandboxArtifactRequest {
  /** ≤ 20 000 characters */
  text: string;
  /** YYYY-MM-DD; server default is today */
  as_of?: string;
  label?: string;
}

/** One rule encoding found in the pasted text, judged as of the request date. */
export interface SandboxMatch {
  rule_code: string;
  rule_title: string;
  citation: string;
  /** the rule version the phrasing encodes */
  bound_version: number;
  bound_status: RuleVersionStatus | string;
  /** the version in force on as_of; null when none is */
  in_force_version: number | null;
  polarity: EdgePolarity | string;
  /** verbatim sentence around the hit, in the redacted text */
  span: string;
  /** character offset of `span` in the redacted text */
  offset: number;
  matcher: string;
  confidence: number | null;
  /** confirmed | proposed (a phrasing that needs a human read) */
  edge_status: EdgeStatus | string;
  verdict: SandboxVerdict | string;
  direction: StalenessDirection | string | null;
  reason: string;
  /** "applies from" of the in-force version (operational date) */
  applies_from: string | null;
  /** legal effective date of the regulation, when it differs */
  regulation_effective: string | null;
  disputed: boolean;
}

export interface SandboxArtifactSummary {
  matches: number;
  stale: number;
  current: number;
  rules_touched: number;
  over_restrictive: number;
  under_restrictive: number;
  reverify: number;
}

/** POST /sandbox/artifact response. */
export interface SandboxArtifactOut {
  as_of: string;
  label: string | null;
  text_sha256: string;
  chars: number;
  redacted: RedactionCounts;
  matches: SandboxMatch[];
  summary: SandboxArtifactSummary;
  /** always false: the sandbox stores nothing */
  persisted: boolean;
  note: string;
}

export type SandboxProductLine = 'MA' | 'PDP' | 'MEDIGAP' | 'LIFE';

/** POST /sandbox/transcript request. */
export interface SandboxTranscriptRequest {
  /** ≤ 30 000 characters */
  text: string;
  product_line?: SandboxProductLine;
  model_id?: string;
}

export type SandboxOutcome = Outcome | 'NEEDS_LABEL';

export interface SandboxContractResult {
  code: string;
  title: string;
  severity: ContractSeverity | string;
  outcome: SandboxOutcome | string;
  /** NEEDS_LABEL rows: {model_says: {...}} — the model's own answer, shown, not graded */
  evidence: JsonObject | null;
  /** plain-language reason; null on graded grounding rows */
  why: string | null;
}

/** POST /sandbox/transcript response (200). 409 = no local model; 504 = timed out. */
export interface SandboxTranscriptOut {
  model_id: string;
  latency_ms: number;
  redacted: RedactionCounts;
  /** the workflow output: {extraction, composition, route} */
  output: JsonObject;
  /** optional: cited spans located in the redacted text */
  spans?: SpanOut[];
  /** optional: deterministic route, when sent outside `output` */
  route?: Route | string;
  contracts: SandboxContractResult[];
  persisted: boolean;
  note: string;
}

export interface SandboxSample {
  label: string;
  text: string;
}

/** GET /sandbox/samples */
export interface SandboxSamplesOut {
  artifacts: SandboxSample[];
  transcripts: SandboxSample[];
}
