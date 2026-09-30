/**
 * react-query hooks, one per endpoint.
 *
 * Every key starts with a family key (`keys.rules()`, `keys.review()`, …)
 * so one invalidation sweeps the whole family: `keys.rules()` covers the
 * list, each rule, its impact and its source checks. Mutations never list
 * keys themselves; they name what they changed and `invalidateAfterWrite`
 * maps that to families.
 */

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { api, download, downloadWithMeta, toQuery, upload } from './client';
import { isApiError } from './errors';
import type {
  AccessReviewOut,
  AssetDetailOut,
  AssetOut,
  AuditActorOut,
  AuditCheckpointOut,
  AuditOut,
  AuditQuery,
  AuditVerifyOut,
  CompareOut,
  ContractMetricsOut,
  ContractMetricsQuery,
  ContractOut,
  EvidenceFormat,
  EvidenceScope,
  ExportFormat,
  HealthDeepOut,
  ImpactOut,
  ImpactWhatIfOut,
  IngestFormatsOut,
  IngestResultOut,
  MatcherEvalOut,
  MeOut,
  MetaOut,
  ModelBoardOut,
  ModelOut,
  Page,
  PromptDiffOut,
  ReadinessOut,
  ReloadRulesOut,
  ReviewQuery,
  ReviewTaskOut,
  RuleOut,
  RuleSourceOut,
  RuleVersionCreate,
  RuleVersionOut,
  RunOut,
  RunRequest,
  RunResultOut,
  RunResultsQuery,
  RunTranscriptOut,
  SandboxArtifactOut,
  SandboxArtifactRequest,
  SandboxSamplesOut,
  SandboxTranscriptOut,
  SandboxTranscriptRequest,
  ScanOut,
  ScanRequest,
  SourcesCheckOut,
  StatusOut,
  TestCaseOut,
  TranscriptOut,
  TransitionRequest,
  WorkflowOut,
} from './types';

const ROOT = 'backstop';

/** Optional /models/board parameters; omitted ones take the server's defaults. */
export interface ModelBoardQuery {
  prompt?: number;
  ruleDate?: string;
}

export const keys = {
  all: [ROOT] as const,
  meta: () => [ROOT, 'meta'] as const,
  me: () => [ROOT, 'me'] as const,
  status: () => [ROOT, 'status'] as const,
  health: () => [ROOT, 'health'] as const,

  sandboxSamples: () => [ROOT, 'sandbox', 'samples'] as const,

  // family: the rule list, each rule, its impact (enacted and what-if) and its source checks
  rules: () => [ROOT, 'rules'] as const,
  rule: (code: string) => [...keys.rules(), code] as const,
  impact: (code: string, asOf: string) => [...keys.rule(code), 'impact', asOf] as const,
  impactWhatIf: (code: string, asOf: string, version: number) =>
    [...keys.impact(code, asOf), 'what-if', version] as const,
  ruleSources: (code: string) => [...keys.rule(code), 'sources'] as const,

  assets: () => [ROOT, 'assets'] as const,
  asset: (code: string) => [...keys.assets(), code] as const,

  workflows: () => [ROOT, 'workflows'] as const,
  workflow: (code: string) => [...keys.workflows(), code] as const,
  promptDiff: (a: string, b: string) => [ROOT, 'prompts', 'diff', a, b] as const,

  // family: the model list and the board (the board shows each model's latest run)
  models: () => [ROOT, 'models'] as const,
  modelBoard: (q: ModelBoardQuery) => [...keys.models(), 'board', q] as const,

  // family: the contract list and per-contract metrics (read from stored run results)
  contracts: () => [ROOT, 'contracts'] as const,
  contractMetrics: (code: string, q: ContractMetricsQuery) => [...keys.contracts(), code, 'metrics', q] as const,

  readiness: () => [ROOT, 'readiness'] as const,
  readinessAt: (asOf: string) => [...keys.readiness(), asOf] as const,

  transcripts: () => [ROOT, 'transcripts'] as const,
  transcriptPage: (limit: number, offset: number) => [...keys.transcripts(), limit, offset] as const,

  // family: run list, each run, its results and transcripts, and comparisons
  runs: () => [ROOT, 'runs'] as const,
  run: (id: string) => [...keys.runs(), id] as const,
  runResults: (id: string, q: RunResultsQuery) => [...keys.run(id), 'results', q] as const,
  runTranscript: (id: string, code: string) => [...keys.run(id), 'transcripts', code] as const,
  compare: (a: string, b: string) => [...keys.runs(), 'compare', a, b] as const,

  review: () => [ROOT, 'review'] as const,
  reviewList: (q: ReviewQuery) => [...keys.review(), 'list', q] as const,
  reviewTask: (id: string) => [...keys.review(), 'task', id] as const,

  testCases: () => [ROOT, 'test-cases'] as const,

  audit: () => [ROOT, 'audit'] as const,
  auditPage: (q: AuditQuery) => [...keys.audit(), 'page', q] as const,
  auditActors: () => [...keys.audit(), 'actors'] as const,

  evals: () => [ROOT, 'evals', 'matchers'] as const,
  ingestFormats: () => [ROOT, 'ingest', 'formats'] as const,

  access: () => [ROOT, 'admin', 'access'] as const,
  checkpoints: () => [ROOT, 'admin', 'checkpoints'] as const,
};

/**
 * What a write can change on the server, each mapped to the query family
 * that reads it. A mutation names its effects; it never lists keys.
 */
const EFFECT_FAMILIES = {
  rules: keys.rules,
  assets: keys.assets,
  review: keys.review,
  testCases: keys.testCases,
  runs: keys.runs,
  models: keys.models,
  contracts: keys.contracts,
  transcripts: keys.transcripts,
  readiness: keys.readiness,
  health: keys.health,
  checkpoints: keys.checkpoints,
} as const;

export type WriteEffect = keyof typeof EFFECT_FAMILIES;

/**
 * Refetch what a successful write made stale. Every write is audit-logged
 * and moves the status rail (counts, open tasks, audit rows), so those two
 * families always refresh; `effects` adds the domains the write touched.
 */
export function invalidateAfterWrite(qc: QueryClient, effects: readonly WriteEffect[] = []): void {
  const families = [keys.audit(), keys.status(), ...effects.map((effect) => EFFECT_FAMILIES[effect]())];
  for (const queryKey of families) void qc.invalidateQueries({ queryKey });
}

/** Status rail poll interval. */
export const STATUS_POLL_MS = 30_000;

type QueryOpts<T> = Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'>;

/** One retry smooths over a network blip; a 4xx (e.g. 401 → login) is a decision, not a blip. */
function retryUnlessClientError(count: number, err: Error): boolean {
  return count < 1 && !(isApiError(err) && err.status >= 400 && err.status < 500);
}

// ---------------------------------------------------------------- meta / identity

export function useMeta(opts?: QueryOpts<MetaOut>) {
  return useQuery<MetaOut, Error>({
    queryKey: keys.meta(),
    queryFn: () => api.get<MetaOut>('/meta'),
    staleTime: 5 * 60_000,
    retry: retryUnlessClientError,
    ...opts,
  });
}

/** GET /me: who is signed in, what their role may do and why. The source of every permission check in the UI. */
export function useMe(opts?: QueryOpts<MeOut>) {
  return useQuery<MeOut, Error>({
    queryKey: keys.me(),
    queryFn: () => api.get<MeOut>('/me'),
    staleTime: 5 * 60_000,
    retry: retryUnlessClientError,
    ...opts,
  });
}

// ---------------------------------------------------------------- status rail

/** GET /status: health, counts, last run, review lanes, audit chain, user. Polled every 30 s. */
export function useStatus(opts?: QueryOpts<StatusOut>) {
  return useQuery<StatusOut, Error>({
    queryKey: keys.status(),
    queryFn: () => api.get<StatusOut>('/status'),
    refetchInterval: STATUS_POLL_MS,
    staleTime: 10_000,
    retry: false,
    ...opts,
  });
}

// ---------------------------------------------------------------- rules

export function useRules(opts?: QueryOpts<RuleOut[]>) {
  return useQuery<RuleOut[], Error>({ queryKey: keys.rules(), queryFn: () => api.get<RuleOut[]>('/rules'), ...opts });
}

export function useRule(code: string | undefined) {
  return useQuery<RuleOut, Error>({
    queryKey: keys.rule(code ?? ''),
    queryFn: () => api.get<RuleOut>(`/rules/${encodeURIComponent(code ?? '')}`),
    enabled: Boolean(code),
  });
}

function impactPath(code: string, asOf: string): string {
  return `/rules/${encodeURIComponent(code)}/impact${toQuery({ as_of: asOf })}`;
}

/** GET /rules/{code}/impact: the blast radius on `asOf`. Read-only; each stale item carries its open review task, if any. */
export function useImpact(code: string | undefined, asOf: string) {
  return useQuery<ImpactOut, Error>({
    queryKey: keys.impact(code ?? '', asOf),
    queryFn: () => api.get<ImpactOut>(impactPath(code ?? '', asOf)),
    enabled: Boolean(code) && Boolean(asOf),
    placeholderData: (prev) => prev,
  });
}

/** Impact of every listed rule at one date (the same cache entries useImpact reads). */
export function useImpactsAt(codes: string[], asOf: string) {
  return useQueries({
    queries: codes.map((code) => ({
      queryKey: keys.impact(code, asOf),
      queryFn: () => api.get<ImpactOut>(impactPath(code, asOf)),
      enabled: Boolean(asOf),
    })),
  });
}

/**
 * What-if blast radius: the impact as if proposed version `version` were
 * enacted. Read-only on the server (no tasks, no audit rows), and labelled
 * HYPOTHETICAL wherever it is shown.
 */
export function useImpactWhatIf(code: string | undefined, asOf: string, version: number | null) {
  return useQuery<ImpactWhatIfOut, Error>({
    queryKey: keys.impactWhatIf(code ?? '', asOf, version ?? 0),
    queryFn: () =>
      api.get<ImpactWhatIfOut>(
        `/rules/${encodeURIComponent(code ?? '')}/impact${toQuery({ as_of: asOf, include_proposed: true, assume_version: version })}`,
      ),
    enabled: Boolean(code) && Boolean(asOf) && version !== null,
    retry: false,
  });
}

/**
 * POST /rules/{code}/impact/evaluate (engineer/admin): open a review task for
 * every stale artifact on `asOf` that has none yet. Reading the impact never
 * opens tasks; this is the one write. 409 when `asOf` shows an older version
 * than the one in force today (that staleness is history, not work).
 */
export function useOpenStaleTasks(code: string) {
  const qc = useQueryClient();
  return useMutation<ImpactWhatIfOut, Error, { asOf: string }>({
    mutationFn: ({ asOf }) =>
      api.post<ImpactWhatIfOut>(`/rules/${encodeURIComponent(code)}/impact/evaluate${toQuery({ as_of: asOf })}`),
    // the rules family covers the impact reads that show each item's task
    onSuccess: () => invalidateAfterWrite(qc, ['rules', 'review', 'readiness']),
  });
}

export function useProposeVersion(code: string) {
  const qc = useQueryClient();
  return useMutation<RuleVersionOut, Error, RuleVersionCreate>({
    mutationFn: (body) => api.post<RuleVersionOut>(`/rules/${encodeURIComponent(code)}/versions`, body),
    onSuccess: () => invalidateAfterWrite(qc, ['rules', 'review', 'readiness']),
  });
}

export function useRuleSources(code: string | undefined) {
  return useQuery<RuleSourceOut[], Error>({
    queryKey: keys.ruleSources(code ?? ''),
    queryFn: () => api.get<RuleSourceOut[]>(`/rules/${encodeURIComponent(code ?? '')}/sources`),
    enabled: Boolean(code),
  });
}

export function useCheckSources() {
  const qc = useQueryClient();
  return useMutation<SourcesCheckOut, Error, { live?: boolean }>({
    mutationFn: ({ live = false }) => api.post<SourcesCheckOut>(`/sources/check${toQuery({ live })}`),
    // a changed source opens a RULE_SOURCE_CHANGED review task
    onSuccess: () => invalidateAfterWrite(qc, ['rules', 'review']),
  });
}

/** POST /rules/reload — admin only: adopt the reviewed corpus in git into the running system. */
export function useReloadRules() {
  const qc = useQueryClient();
  return useMutation<ReloadRulesOut, Error, void>({
    mutationFn: () => api.post<ReloadRulesOut>('/rules/reload'),
    // new versions move every impact, readiness horizon and stale count
    onSuccess: () => invalidateAfterWrite(qc, ['rules', 'readiness']),
  });
}

// ---------------------------------------------------------------- assets / scans

export function useAssets(opts?: QueryOpts<AssetOut[]>) {
  return useQuery<AssetOut[], Error>({
    queryKey: keys.assets(),
    queryFn: () => api.get<AssetOut[]>('/assets'),
    ...opts,
  });
}

export function useAsset(code: string | undefined) {
  return useQuery<AssetDetailOut, Error>({
    queryKey: keys.asset(code ?? ''),
    queryFn: () => api.get<AssetDetailOut>(`/assets/${encodeURIComponent(code ?? '')}`),
    enabled: Boolean(code),
  });
}

export function useRunScan() {
  const qc = useQueryClient();
  return useMutation<ScanOut, Error, ScanRequest>({
    mutationFn: (body) => api.post<ScanOut>('/scans', body),
    // new artifact versions, edges and stale-artifact tasks
    onSuccess: () => invalidateAfterWrite(qc, ['assets', 'rules', 'review', 'readiness']),
  });
}

// ---------------------------------------------------------------- workflows / models / contracts

export function useWorkflows() {
  return useQuery<WorkflowOut[], Error>({
    queryKey: keys.workflows(),
    queryFn: () => api.get<WorkflowOut[]>('/workflows'),
    staleTime: 5 * 60_000,
  });
}

export function useWorkflow(code: string | undefined) {
  return useQuery<WorkflowOut, Error>({
    queryKey: keys.workflow(code ?? ''),
    queryFn: () => api.get<WorkflowOut>(`/workflows/${encodeURIComponent(code ?? '')}`),
    enabled: Boolean(code),
    staleTime: 5 * 60_000,
  });
}

export function usePromptDiff(a: string | null, b: string | null) {
  return useQuery<PromptDiffOut, Error>({
    queryKey: keys.promptDiff(a ?? '', b ?? ''),
    queryFn: () => api.get<PromptDiffOut>(`/prompts/diff${toQuery({ a, b })}`),
    enabled: Boolean(a) && Boolean(b) && a !== b,
  });
}

export function useModels() {
  return useQuery<ModelOut[], Error>({
    queryKey: keys.models(),
    queryFn: () => api.get<ModelOut[]>('/models'),
    staleTime: 5 * 60_000,
  });
}

/**
 * Every model side by side: provider readiness, recorded cassettes, latest
 * measured run. Without parameters the server picks the prompt version and
 * rule date; the response echoes the ones it used.
 */
export function useModelBoard(q: ModelBoardQuery = {}) {
  return useQuery<ModelBoardOut, Error>({
    queryKey: keys.modelBoard(q),
    queryFn: () => api.get<ModelBoardOut>(`/models/board${toQuery({ prompt: q.prompt, rule_date: q.ruleDate })}`),
    staleTime: 30_000,
  });
}

export function useContracts() {
  return useQuery<ContractOut[], Error>({
    queryKey: keys.contracts(),
    queryFn: () => api.get<ContractOut[]>('/contracts'),
    staleTime: 5 * 60_000,
  });
}

/** GET /contracts/{code}/metrics: confusion matrix, rates with Wilson CIs, slices, trend. */
export function useContractMetrics(code: string | undefined, q: ContractMetricsQuery = {}) {
  return useQuery<ContractMetricsOut, Error>({
    queryKey: keys.contractMetrics(code ?? '', q),
    queryFn: () => api.get<ContractMetricsOut>(`/contracts/${encodeURIComponent(code ?? '')}/metrics${toQuery(q)}`),
    enabled: Boolean(code),
    placeholderData: (prev) => prev,
  });
}

// ---------------------------------------------------------------- readiness

/** GET /readiness?as_of=: milestones, 30/60/90-day horizon, owner queues, burn-down, vacated and proposed rules. */
export function useReadiness(asOf: string) {
  return useQuery<ReadinessOut, Error>({
    queryKey: keys.readinessAt(asOf),
    queryFn: () => api.get<ReadinessOut>(`/readiness${toQuery({ as_of: asOf })}`),
    enabled: Boolean(asOf),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------- transcripts

export function useTranscripts(limit = 100, offset = 0) {
  return useQuery<TranscriptOut[], Error>({
    queryKey: keys.transcriptPage(limit, offset),
    queryFn: () => api.get<TranscriptOut[]>(`/transcripts${toQuery({ limit, offset })}`),
  });
}

// ---------------------------------------------------------------- runs

export function useRuns(opts?: QueryOpts<RunOut[]>) {
  return useQuery<RunOut[], Error>({ queryKey: keys.runs(), queryFn: () => api.get<RunOut[]>('/runs'), ...opts });
}

export function useRun(id: string | undefined) {
  return useQuery<RunOut, Error>({
    queryKey: keys.run(id ?? ''),
    queryFn: () => api.get<RunOut>(`/runs/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
  });
}

export function useRunResults(id: string | undefined, q: RunResultsQuery = {}, enabled = true) {
  return useQuery<RunResultOut[], Error>({
    queryKey: keys.runResults(id ?? '', q),
    queryFn: () => api.get<RunResultOut[]>(`/runs/${encodeURIComponent(id ?? '')}/results${toQuery(q)}`),
    enabled: Boolean(id) && enabled,
  });
}

export function useRunTranscript(id: string | undefined, code: string | undefined) {
  return useQuery<RunTranscriptOut, Error>({
    queryKey: keys.runTranscript(id ?? '', code ?? ''),
    queryFn: () =>
      api.get<RunTranscriptOut>(`/runs/${encodeURIComponent(id ?? '')}/transcripts/${encodeURIComponent(code ?? '')}`),
    enabled: Boolean(id) && Boolean(code),
  });
}

export function useCompare(a: string | null, b: string | null) {
  return useQuery<CompareOut, Error>({
    queryKey: keys.compare(a ?? '', b ?? ''),
    queryFn: () => api.get<CompareOut>(`/runs/compare${toQuery({ a, b })}`),
    enabled: Boolean(a) && Boolean(b),
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation<RunOut, Error, RunRequest>({
    mutationFn: (body) => api.post<RunOut>('/runs', body),
    // a run opens flagged-result tasks, becomes a model's latest run on the board,
    // and adds stored results that contract metrics read
    onSuccess: () => invalidateAfterWrite(qc, ['runs', 'review', 'readiness', 'contracts', 'models']),
  });
}

export function useExportRun() {
  return useMutation<string, Error, { id: string; format: ExportFormat }>({
    mutationFn: ({ id, format }) =>
      download(
        `/runs/${encodeURIComponent(id)}/export${toQuery({ format })}`,
        `backstop-run-${id.slice(0, 8)}.${format === 'csv' ? 'csv' : `${format}.json`}`,
      ),
  });
}

// ---------------------------------------------------------------- review

export function useReviewTasks(q: ReviewQuery = {}) {
  return useQuery<ReviewTaskOut[], Error>({
    queryKey: keys.reviewList(q),
    queryFn: () => api.get<ReviewTaskOut[]>(`/review${toQuery(q)}`),
  });
}

export function useReviewTask(id: string | undefined) {
  return useQuery<ReviewTaskOut, Error>({
    queryKey: keys.reviewTask(id ?? ''),
    queryFn: () => api.get<ReviewTaskOut>(`/review/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
  });
}

/** POST /review/{id}/transition. An override also creates a test case pending approval. */
export function useReviewTransition(id: string) {
  const qc = useQueryClient();
  return useMutation<ReviewTaskOut, Error, TransitionRequest>({
    mutationFn: (body) => api.post<ReviewTaskOut>(`/review/${encodeURIComponent(id)}/transition`, body),
    onSuccess: () => invalidateAfterWrite(qc, ['review', 'testCases', 'rules', 'readiness']),
  });
}

// ---------------------------------------------------------------- test cases

export function useTestCases() {
  return useQuery<TestCaseOut[], Error>({
    queryKey: keys.testCases(),
    queryFn: () => api.get<TestCaseOut[]>('/test-cases'),
  });
}

export function useApproveTestCase() {
  const qc = useQueryClient();
  return useMutation<TestCaseOut, Error, string>({
    mutationFn: (id) => api.post<TestCaseOut>(`/test-cases/${encodeURIComponent(id)}/approve`),
    onSuccess: () => invalidateAfterWrite(qc, ['testCases', 'review']),
  });
}

// ---------------------------------------------------------------- sandbox (nothing persisted but an audit hash)

export function useSandboxSamples() {
  return useQuery<SandboxSamplesOut, Error>({
    queryKey: keys.sandboxSamples(),
    queryFn: () => api.get<SandboxSamplesOut>('/sandbox/samples'),
    staleTime: 30 * 60_000,
    retry: false,
  });
}

/** POST /sandbox/artifact — deterministic matchers over pasted text; stores only a SHA-256 in the audit log. */
export function useSandboxArtifact() {
  const qc = useQueryClient();
  return useMutation<SandboxArtifactOut, Error, SandboxArtifactRequest>({
    mutationFn: (body) => api.post<SandboxArtifactOut>('/sandbox/artifact', body),
    onSuccess: () => invalidateAfterWrite(qc),
  });
}

/** POST /sandbox/transcript — one call through the local model. 409 = no model reachable, 504 = timed out. */
export function useSandboxTranscript() {
  const qc = useQueryClient();
  return useMutation<SandboxTranscriptOut, Error, SandboxTranscriptRequest & { signal?: AbortSignal }>({
    mutationFn: ({ signal, ...body }) => api.post<SandboxTranscriptOut>('/sandbox/transcript', body, { signal }),
    onSuccess: () => invalidateAfterWrite(qc),
  });
}

// ---------------------------------------------------------------- audit

/** GET /audit/actors — the people who appear in the log, for the actor filter. */
export function useAuditActors() {
  return useQuery<AuditActorOut[], Error>({
    queryKey: keys.auditActors(),
    queryFn: () => api.get<AuditActorOut[]>('/audit/actors'),
    staleTime: 60_000,
  });
}

export function useAudit(q: AuditQuery) {
  return useQuery<Page<AuditOut>, Error>({
    queryKey: keys.auditPage(q),
    queryFn: () => api.get<Page<AuditOut>>(`/audit${toQuery(q)}`),
    placeholderData: (prev) => prev,
  });
}

/** GET /audit/verify — recompute the hash chain on demand. A read: it only refreshes the rail's chain badge. */
export function useVerifyAuditChain() {
  const qc = useQueryClient();
  return useMutation<AuditVerifyOut, Error, void>({
    mutationFn: () => api.get<AuditVerifyOut>('/audit/verify'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.status() }),
  });
}

/** GET /audit/verify?through_id=&tip= — does the chain still contain this checkpoint? */
export function useVerifyCheckpoint() {
  return useMutation<AuditVerifyOut, Error, { through_id: number; tip: string }>({
    mutationFn: ({ through_id, tip }) => api.get<AuditVerifyOut>(`/audit/verify${toQuery({ through_id, tip })}`),
  });
}

// ---------------------------------------------------------------- governance (admin)

/** GET /admin/access — admin only; the server audit-logs every review. */
export function useAccessReview(enabled: boolean) {
  return useQuery<AccessReviewOut, Error>({
    queryKey: keys.access(),
    queryFn: () => api.get<AccessReviewOut>('/admin/access'),
    enabled,
    staleTime: 30_000,
  });
}

export function useAuditCheckpoints(enabled: boolean) {
  return useQuery<AuditCheckpointOut[], Error>({
    queryKey: keys.checkpoints(),
    queryFn: () => api.get<AuditCheckpointOut[]>('/admin/audit-checkpoints'),
    enabled,
  });
}

/** POST /admin/audit-checkpoints — refused (409) while the chain is broken. */
export function useTakeCheckpoint() {
  const qc = useQueryClient();
  return useMutation<AuditCheckpointOut, Error, void>({
    mutationFn: () => api.post<AuditCheckpointOut>('/admin/audit-checkpoints'),
    onSuccess: () => invalidateAfterWrite(qc, ['checkpoints']),
  });
}

// ---------------------------------------------------------------- evidence bundles

export interface EvidenceRequest {
  scope: EvidenceScope;
  /** task id, run id, or rule code */
  id: string;
  format: EvidenceFormat;
  /** rules only: the evaluation date */
  asOf?: string;
}

export interface EvidenceResult {
  filename: string;
  sha256: string | null;
}

export function evidencePath({ scope, id, format, asOf }: EvidenceRequest): string {
  return `/evidence/${scope}/${encodeURIComponent(id)}${toQuery({ format, as_of: scope === 'rules' ? asOf : undefined })}`;
}

/** Download an evidence bundle (the export itself is audit-logged server-side). */
export function useExportEvidence() {
  const qc = useQueryClient();
  return useMutation<EvidenceResult, Error, EvidenceRequest>({
    mutationFn: async (req) => {
      const stem = `backstop-evidence-${req.scope.replace(/s$/, '')}-${req.id.slice(0, 12)}`;
      const { name, sha256 } = await downloadWithMeta(evidencePath(req), `${stem}.${req.format}`);
      return { filename: name, sha256 };
    },
    onSuccess: () => invalidateAfterWrite(qc),
  });
}

// ---------------------------------------------------------------- evals / ingest / health

export function useMatcherEvals() {
  return useQuery<MatcherEvalOut, Error>({
    queryKey: keys.evals(),
    queryFn: () => api.get<MatcherEvalOut>('/evals/matchers'),
    staleTime: 5 * 60_000,
  });
}

export function useIngestFormats() {
  return useQuery<IngestFormatsOut, Error>({
    queryKey: keys.ingestFormats(),
    queryFn: () => api.get<IngestFormatsOut>('/ingest/formats'),
    staleTime: 5 * 60_000,
  });
}

export function useIngestTranscripts() {
  const qc = useQueryClient();
  return useMutation<IngestResultOut, Error, { file: File; format: string }>({
    mutationFn: ({ file, format }) => upload<IngestResultOut>(`/ingest/transcripts${toQuery({ format })}`, file),
    onSuccess: () => invalidateAfterWrite(qc, ['transcripts', 'health']),
  });
}

/** /health/deep needs no auth; the header is harmless when present. */
export function useHealthDeep(enabled: boolean) {
  return useQuery<HealthDeepOut, Error>({
    queryKey: keys.health(),
    queryFn: () => api.get<HealthDeepOut>('/health/deep', { noAuthRedirect: true }),
    enabled,
    staleTime: 10_000,
  });
}
