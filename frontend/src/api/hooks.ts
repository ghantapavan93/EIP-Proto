/**
 * react-query hooks, one per endpoint. Keys are namespaced under "backstop"
 * so a single invalidation can sweep a whole entity family.
 */

import { useMutation, useQueries, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { api, download, downloadWithMeta, toQuery, upload } from './client';
import { isApiError } from './errors';
import type {
  AssetDetailOut,
  AssetOut,
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
  PromptVersionOut,
  ReadinessOut,
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

export const keys = {
  all: ['backstop'] as const,
  meta: () => ['backstop', 'meta'] as const,
  me: () => ['backstop', 'me'] as const,
  sandboxSamples: () => ['backstop', 'sandbox', 'samples'] as const,
  rules: () => ['backstop', 'rules'] as const,
  rule: (code: string) => ['backstop', 'rules', code] as const,
  impact: (code: string, asOf: string) => ['backstop', 'rules', code, 'impact', asOf] as const,
  impactWhatIf: (code: string, asOf: string, version: number) => ['backstop', 'rules', code, 'impact', asOf, 'what-if', version] as const,
  ruleSources: (code: string) => ['backstop', 'rules', code, 'sources'] as const,
  assets: () => ['backstop', 'assets'] as const,
  asset: (code: string) => ['backstop', 'assets', code] as const,
  scans: () => ['backstop', 'scans'] as const,
  workflows: () => ['backstop', 'workflows'] as const,
  workflow: (code: string) => ['backstop', 'workflows', code] as const,
  prompt: (id: string) => ['backstop', 'prompts', id] as const,
  promptDiff: (a: string, b: string) => ['backstop', 'prompts', 'diff', a, b] as const,
  models: () => ['backstop', 'models'] as const,
  modelBoard: (prompt: number, ruleDate: string) => ['backstop', 'models', 'board', prompt, ruleDate] as const,
  contracts: () => ['backstop', 'contracts'] as const,
  contractMetrics: (code: string, q: ContractMetricsQuery) => ['backstop', 'contracts', code, 'metrics', q] as const,
  readiness: (asOf: string) => ['backstop', 'readiness', asOf] as const,
  transcripts: (limit: number, offset: number) => ['backstop', 'transcripts', limit, offset] as const,
  transcript: (code: string) => ['backstop', 'transcripts', code] as const,
  runs: () => ['backstop', 'runs'] as const,
  run: (id: string) => ['backstop', 'runs', id] as const,
  runResults: (id: string, q: RunResultsQuery) => ['backstop', 'runs', id, 'results', q] as const,
  runTranscript: (id: string, code: string) => ['backstop', 'runs', id, 'transcripts', code] as const,
  compare: (a: string, b: string) => ['backstop', 'runs', 'compare', a, b] as const,
  review: (q: ReviewQuery) => ['backstop', 'review', q] as const,
  reviewTask: (id: string) => ['backstop', 'review', 'task', id] as const,
  testCases: () => ['backstop', 'test-cases'] as const,
  audit: (q: AuditQuery) => ['backstop', 'audit', q] as const,
  evals: () => ['backstop', 'evals', 'matchers'] as const,
  ingestFormats: () => ['backstop', 'ingest', 'formats'] as const,
  health: () => ['backstop', 'health'] as const,
  status: () => ['backstop', 'status'] as const,
};

/** Status rail poll interval. */
export const STATUS_POLL_MS = 30_000;

type QueryOpts<T> = Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'>;

// ---------------------------------------------------------------- meta

export function useMeta(opts?: QueryOpts<MetaOut>) {
  return useQuery<MetaOut, Error>({
    queryKey: keys.meta(),
    queryFn: () => api.get<MetaOut>('/meta'),
    staleTime: 5 * 60_000,
    // One retry smooths over a network blip; a 4xx (e.g. 401 → login) is a decision, not a blip.
    retry: (count, err) => count < 1 && !(isApiError(err) && err.status >= 400 && err.status < 500),
    ...opts,
  });
}

/** Current role, or null while loading / signed out. */
export function useRole(): string | null {
  const { data } = useMeta();
  return data?.role ?? null;
}

export function canEdit(role: string | null | undefined): boolean {
  return role === 'engineer' || role === 'admin';
}

/**
 * GET /me: who is signed in, what their role may do and why. Older servers
 * without the route answer 404; callers fall back to lib/roles, so the query
 * never retries a 4xx.
 */
export function useMe(opts?: QueryOpts<MeOut>) {
  return useQuery<MeOut, Error>({
    queryKey: keys.me(),
    queryFn: () => api.get<MeOut>('/me'),
    staleTime: 5 * 60_000,
    retry: (count, err) => count < 1 && !(isApiError(err) && err.status >= 400 && err.status < 500),
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

export function useImpact(code: string | undefined, asOf: string) {
  return useQuery<ImpactOut, Error>({
    queryKey: keys.impact(code ?? '', asOf),
    queryFn: () => api.get<ImpactOut>(`/rules/${encodeURIComponent(code ?? '')}/impact${toQuery({ as_of: asOf })}`),
    enabled: Boolean(code) && Boolean(asOf),
    placeholderData: (prev) => prev,
  });
}

/** Impact of every listed rule at one date (the same cache entries useImpact reads). */
export function useImpactsAt(codes: string[], asOf: string) {
  return useQueries({
    queries: codes.map((code) => ({
      queryKey: keys.impact(code, asOf),
      queryFn: () => api.get<ImpactOut>(`/rules/${encodeURIComponent(code)}/impact${toQuery({ as_of: asOf })}`),
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

export function useProposeVersion(code: string) {
  const qc = useQueryClient();
  return useMutation<RuleVersionOut, Error, RuleVersionCreate>({
    mutationFn: (body) => api.post<RuleVersionOut>(`/rules/${encodeURIComponent(code)}/versions`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.rules() });
      void qc.invalidateQueries({ queryKey: ['backstop', 'audit'] });
      void qc.invalidateQueries({ queryKey: ['backstop', 'review'] });
      void qc.invalidateQueries({ queryKey: keys.status() });
      void qc.invalidateQueries({ queryKey: ['backstop', 'readiness'] });
    },
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['backstop', 'rules'] });
      void qc.invalidateQueries({ queryKey: ['backstop', 'review'] });
      void qc.invalidateQueries({ queryKey: ['backstop', 'audit'] });
      void qc.invalidateQueries({ queryKey: keys.status() });
    },
  });
}

// ---------------------------------------------------------------- assets / scans

export function useAssets(opts?: QueryOpts<AssetOut[]>) {
  return useQuery<AssetOut[], Error>({ queryKey: keys.assets(), queryFn: () => api.get<AssetOut[]>('/assets'), ...opts });
}

export function useAsset(code: string | undefined) {
  return useQuery<AssetDetailOut, Error>({
    queryKey: keys.asset(code ?? ''),
    queryFn: () => api.get<AssetDetailOut>(`/assets/${encodeURIComponent(code ?? '')}`),
    enabled: Boolean(code),
  });
}

export function useScans() {
  return useQuery<ScanOut[], Error>({ queryKey: keys.scans(), queryFn: () => api.get<ScanOut[]>('/scans') });
}

export function useRunScan() {
  const qc = useQueryClient();
  return useMutation<ScanOut, Error, ScanRequest>({
    mutationFn: (body) => api.post<ScanOut>('/scans', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.scans() });
      void qc.invalidateQueries({ queryKey: keys.assets() });
      void qc.invalidateQueries({ queryKey: ['backstop', 'rules'] });
      void qc.invalidateQueries({ queryKey: ['backstop', 'review'] });
      void qc.invalidateQueries({ queryKey: ['backstop', 'audit'] });
      void qc.invalidateQueries({ queryKey: keys.status() });
      void qc.invalidateQueries({ queryKey: ['backstop', 'readiness'] });
    },
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

export function usePrompt(id: string | undefined) {
  return useQuery<PromptVersionOut, Error>({
    queryKey: keys.prompt(id ?? ''),
    queryFn: () => api.get<PromptVersionOut>(`/prompts/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
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

/** Every model side by side: provider readiness, recorded cassettes, latest measured run. */
export function useModelBoard(prompt = 2, ruleDate = '2026-10-01') {
  return useQuery<ModelBoardOut, Error>({
    queryKey: keys.modelBoard(prompt, ruleDate),
    queryFn: () => api.get<ModelBoardOut>(`/models/board${toQuery({ prompt, rule_date: ruleDate })}`),
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
    queryKey: keys.readiness(asOf),
    queryFn: () => api.get<ReadinessOut>(`/readiness${toQuery({ as_of: asOf })}`),
    enabled: Boolean(asOf),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------- transcripts

export function useTranscripts(limit = 100, offset = 0) {
  return useQuery<TranscriptOut[], Error>({
    queryKey: keys.transcripts(limit, offset),
    queryFn: () => api.get<TranscriptOut[]>(`/transcripts${toQuery({ limit, offset })}`),
  });
}

export function useTranscript(code: string | undefined) {
  return useQuery<TranscriptOut, Error>({
    queryKey: keys.transcript(code ?? ''),
    queryFn: () => api.get<TranscriptOut>(`/transcripts/${encodeURIComponent(code ?? '')}`),
    enabled: Boolean(code),
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
      api.get<RunTranscriptOut>(
        `/runs/${encodeURIComponent(id ?? '')}/transcripts/${encodeURIComponent(code ?? '')}`,
      ),
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.runs() });
      void qc.invalidateQueries({ queryKey: ['backstop', 'review'] });
      void qc.invalidateQueries({ queryKey: ['backstop', 'audit'] });
      void qc.invalidateQueries({ queryKey: keys.status() });
      void qc.invalidateQueries({ queryKey: ['backstop', 'readiness'] });
      // contract accuracy and trend read stored results
      void qc.invalidateQueries({ queryKey: keys.contracts() });
    },
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
    queryKey: keys.review(q),
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

export function useTransition(id: string) {
  const qc = useQueryClient();
  return useMutation<ReviewTaskOut, Error, TransitionRequest>({
    mutationFn: (body) => api.post<ReviewTaskOut>(`/review/${encodeURIComponent(id)}/transition`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['backstop', 'review'] });
      void qc.invalidateQueries({ queryKey: keys.testCases() });
      void qc.invalidateQueries({ queryKey: ['backstop', 'rules'] });
      void qc.invalidateQueries({ queryKey: ['backstop', 'audit'] });
      void qc.invalidateQueries({ queryKey: keys.status() });
      void qc.invalidateQueries({ queryKey: ['backstop', 'readiness'] });
    },
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.testCases() });
      void qc.invalidateQueries({ queryKey: ['backstop', 'audit'] });
      void qc.invalidateQueries({ queryKey: ['backstop', 'review'] });
      void qc.invalidateQueries({ queryKey: keys.status() });
    },
  });
}

// ---------------------------------------------------------------- sandbox (nothing persisted)

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
  return useMutation<SandboxArtifactOut, Error, SandboxArtifactRequest>({
    mutationFn: (body) => api.post<SandboxArtifactOut>('/sandbox/artifact', body),
  });
}

/** POST /sandbox/transcript — one call through the local model. 409 = no model reachable, 504 = timed out. */
export function useSandboxTranscript() {
  return useMutation<SandboxTranscriptOut, Error, SandboxTranscriptRequest & { signal?: AbortSignal }>({
    mutationFn: ({ signal, ...body }) => api.post<SandboxTranscriptOut>('/sandbox/transcript', body, { signal }),
  });
}

// ---------------------------------------------------------------- audit

export function useAudit(q: AuditQuery) {
  return useQuery<Page<AuditOut>, Error>({
    queryKey: keys.audit(q),
    queryFn: () => api.get<Page<AuditOut>>(`/audit${toQuery(q)}`),
    placeholderData: (prev) => prev,
  });
}

/** GET /audit/verify — recompute the hash chain on demand. */
export function useVerifyAuditChain() {
  const qc = useQueryClient();
  return useMutation<AuditVerifyOut, Error, void>({
    mutationFn: () => api.get<AuditVerifyOut>('/audit/verify'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.status() }),
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['backstop', 'audit'] });
      void qc.invalidateQueries({ queryKey: keys.status() });
    },
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['backstop', 'transcripts'] });
      void qc.invalidateQueries({ queryKey: ['backstop', 'audit'] });
      void qc.invalidateQueries({ queryKey: keys.health() });
      void qc.invalidateQueries({ queryKey: keys.status() });
    },
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
