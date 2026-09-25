import { ApiError } from '../api/errors';
import { getCredentials, type Credentials } from '../api/auth';
import type {
  AssetOut,
  AuditOut,
  CompareCell,
  CompareOut,
  ImpactOut,
  ImpactWhatIfOut,
  IngestResultOut,
  JsonObject,
  MetaOut,
  Page,
  PerContractDelta,
  PromptDiffOut,
  ReviewTaskOut,
  RuleOut,
  RuleVersionCreate,
  RuleVersionOut,
  RunCorpus,
  RunOut,
  RunRequest,
  RunResultOut,
  ScanOut,
  StatusOut,
  SourcesCheckOut,
  StaleItemOut,
  TestCaseOut,
  TranscriptOut,
  TransitionRequest,
} from '../api/types';
import { ASSETS, EDGES, findAsset, fixtureHash } from './assets';
import { CORPUS_HASH, INGESTED, INGESTED_CORPUS_HASH, ingestedOut, SCENARIOS, transcriptOut } from './corpus';
import { materializeRun, runTranscript } from './engine';
import { healthDeep, ingestFormats, matcherEvals, matcherEvalsMarkdown, ruleSources } from './extras';
import { CONTRACTS, CONTRACT_SET_HASH, MODELS, WORKFLOWS, findModel, findPromptVersion, modelBoard, PROVIDERS } from './registry';
import { RULES } from './rules';
import { evaluate, summarize, versionInForce } from './staleness';
import { SAMPLES, sandboxArtifact, sandboxTranscript } from './sandbox';
import { COMPARE_FAILURE_DEFINITION, compareStatistics, contractMetrics } from './metrics';
import { readiness } from './readiness';
import { fallbackMe } from '../lib/roles';
import { governingVersions, governs } from '../lib/ruleVersions';

/**
 * In-memory mock of the Backstop API. Same routes, same shapes, same refusal
 * codes (401/403/404/409/422) as the FastAPI backend. State lives for the page
 * session; reload to reseed.
 */

const DEMO_USERS: Record<string, { password: string; role: string }> = {
  reviewer: { password: 'reviewer', role: 'analyst' },
  analyst: { password: 'analyst', role: 'analyst' },
  engineer: { password: 'engineer', role: 'engineer' },
  admin: { password: 'admin', role: 'admin' },
};

const LATENCY_MS = 160;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ------------------------------------------------------------------ state

interface RunRecord {
  run: RunOut;
  results: RunResultOut[];
  corpus: RunCorpus;
}

interface State {
  rules: RuleOut[];
  runs: RunRecord[];
  tasks: ReviewTaskOut[];
  testCases: TestCaseOut[];
  audit: AuditOut[];
  scans: ScanOut[];
  ingested: TranscriptOut[];
  auditSeq: number;
}

const state: State = {
  rules: RULES.map((r) => ({ ...r, versions: r.versions.map((v) => ({ ...v })) })),
  runs: [],
  tasks: [],
  testCases: [],
  audit: [],
  scans: [],
  ingested: INGESTED.map((s) => ingestedOut(s, false)),
  auditSeq: 0,
};

const GENESIS = '0'.repeat(64);

/** Mock actor -> role: people keep their demo role; "system" rows are automation; "demo-seed:*" rows are seeded examples. */
function actorRole(actor: string): string {
  if (actor.startsWith('demo-seed:')) return 'demo-seed';
  return DEMO_USERS[actor]?.role ?? 'system';
}

function systemActorFor(entityType: string): string {
  if (entityType === 'run') return 'system:runner';
  if (entityType === 'rules') return 'system:rules-loader';
  return 'system:scanner';
}

function audit(actor: string, event_type: string, entity_type: string, entity_id: string, payload: JsonObject = {}, ts: string = nowIso()): AuditOut {
  state.auditSeq += 1;
  const prev = state.audit[state.audit.length - 1]?.row_hash ?? GENESIS;
  const role = actorRole(actor);
  const name = actor === 'system' ? systemActorFor(entity_type) : actor;
  const row_hash = fixtureHash(`${prev}|${ts}|${name}|${event_type}|${entity_type}|${entity_id}|${JSON.stringify(payload)}`);
  const event: AuditOut = {
    id: state.auditSeq,
    ts,
    actor: name,
    actor_role: role,
    event_type,
    entity_type,
    entity_id,
    payload,
    correlation_id: `mock-${entity_id.slice(0, 12)}`,
    prev_hash: prev,
    row_hash,
  };
  state.audit.push(event);
  return event;
}

// ------------------------------------------------------------------ seed: runs

function corpusHash(corpus: RunCorpus): string {
  return corpus === 'synthetic' ? CORPUS_HASH : corpus === 'ingested' ? INGESTED_CORPUS_HASH : fixtureHash(CORPUS_HASH + INGESTED_CORPUS_HASH);
}

function makeRun(id: string, promptVersion: number, modelId: string, adapter: string, ruleDate: string, trigger: string, startedAt: string, requestedBy: string, corpus: RunCorpus = 'synthetic'): RunRecord {
  const prompt = findPromptVersion('qa-handoff', promptVersion);
  const model = findModel(modelId);
  if (!prompt || !model) throw new Error('mock run: unknown prompt or model');
  const material = materializeRun(id, { promptVersion, modelId, ruleDate, corpus }, adapter);
  const started = new Date(startedAt);
  const durationMs = material.stats.latency_ms_total ?? 60_000;
  const cHash = corpusHash(corpus);
  const run: RunOut = {
    id,
    run_key: ['qa-handoff', prompt.prompt_hash.slice(0, 16), modelId, adapter, cHash.slice(0, 16), CONTRACT_SET_HASH.slice(0, 16), ruleDate].join(':'),
    workflow_code: 'qa-handoff',
    prompt_version: promptVersion,
    prompt_label: prompt.label,
    prompt_hash: prompt.prompt_hash,
    model_id: modelId,
    model_label: model.label,
    adapter,
    corpus_hash: cHash,
    corpus,
    contract_set_hash: CONTRACT_SET_HASH,
    rule_date: ruleDate,
    trigger,
    status: 'COMPLETE',
    gate: material.gate,
    started_at: started.toISOString(),
    finished_at: new Date(started.getTime() + durationMs).toISOString(),
    stats: { ...material.stats, corpus },
    requested_by: requestedBy,
    deduplicated: false,
    contracts: material.contracts,
  };
  return { run, results: material.results, corpus };
}

function seedRuns(): void {
  state.runs.push(
    makeRun('2af8b83d-5c1e-4b7a-9f0d-1a2b3c4d5e01', 1, 'sim-large', 'simulated', '2026-09-30', 'MANUAL', '2026-09-19T15:04:12Z', 'engineer'),
    makeRun('9c355594-e96b-4117-aeeb-103ec144d602', 1, 'sim-large', 'simulated', '2026-10-01', 'RULE', '2026-09-19T15:31:40Z', 'engineer'),
    makeRun('45234b21-7d3a-4c8e-b2f1-6e7d8c9b0a03', 2, 'sim-large', 'simulated', '2026-10-01', 'PROMPT', '2026-09-20T09:12:55Z', 'engineer'),
    makeRun('370b4848-7523-4acc-b76f-da9c29a5dd04', 2, 'sim-small', 'cassette', '2026-10-01', 'MODEL', '2026-09-21T11:47:03Z', 'admin'),
  );
}

export const RUN_IDS = {
  baseline: '2af8b83d-5c1e-4b7a-9f0d-1a2b3c4d5e01',
  ruleFlip: '9c355594-e96b-4117-aeeb-103ec144d602',
  promptV2: '45234b21-7d3a-4c8e-b2f1-6e7d8c9b0a03',
  modelSwap: '370b4848-7523-4acc-b76f-da9c29a5dd04',
};

// ------------------------------------------------------------------ review state machine

const TRANSITIONS: Record<string, Record<string, string[]>> = {
  STALE_ASSET: {
    open: ['in_review', 'dismissed'],
    in_review: ['verified', 'dismissed'],
    verified: ['republished'],
  },
  PROPOSED_EDGE: {
    open: ['verified', 'dismissed'],
  },
  FLAGGED_RESULT: {
    open: ['in_review', 'upheld', 'overridden'],
    in_review: ['upheld', 'overridden'],
  },
  RULE_SOURCE_CHANGED: {
    open: ['in_review', 'dismissed'],
    in_review: ['verified', 'dismissed'],
  },
};
const DECIDER_ROLES = new Set(['analyst', 'engineer', 'admin']);
const REPUBLISH_ROLES = new Set(['engineer', 'admin']);
const REASON_REQUIRED = new Set(['dismissed', 'overridden', 'upheld']);

function allowedTransitions(task: ReviewTaskOut, role: string): string[] {
  const targets = TRANSITIONS[task.kind]?.[task.state] ?? [];
  return targets
    .filter((t) => {
      if (t === 'republished' && !REPUBLISH_ROLES.has(role)) return false;
      if (['verified', 'dismissed', 'upheld', 'overridden'].includes(t) && !DECIDER_ROLES.has(role)) return false;
      return true;
    })
    .sort();
}

function laneOf(task: ReviewTaskOut): 'actionable' | 'advisory' {
  return task.kind === 'FLAGGED_RESULT' && task.payload.aggregate === true ? 'advisory' : 'actionable';
}

function withTransitions(task: ReviewTaskOut, role: string): ReviewTaskOut {
  return { ...task, allowed_transitions: allowedTransitions(task, role), lane: laneOf(task) };
}

let taskSeq = 0;
function nextTaskId(): string {
  taskSeq += 1;
  return `task-${String(taskSeq).padStart(4, '0')}`;
}

function blankTask(kind: string, openedAt: string): ReviewTaskOut {
  return {
    id: nextTaskId(),
    kind,
    state: 'open',
    rule_code: null,
    rule_version: null,
    asset_code: null,
    asset_name: null,
    asset_type: null,
    asset_is_synthetic: null,
    edge_id: null,
    evidence_span: null,
    run_result_id: null,
    run_id: null,
    contract_code: null,
    transcript_code: null,
    staleness_direction: null,
    reason: '',
    assignee_role: 'compliance',
    reason_code: null,
    note: '',
    decided_by: null,
    opened_at: openedAt,
    closed_at: null,
    payload: {},
    allowed_transitions: [],
  };
}

function openStaleTask(rule: RuleOut, verdict: ReturnType<typeof evaluate>[number], asOf: string, openedAt: string): ReviewTaskOut {
  const e = verdict.edge;
  const asset = findAsset(e.asset_code);
  const task: ReviewTaskOut = {
    ...blankTask('STALE_ASSET', openedAt),
    rule_code: rule.code,
    rule_version: verdict.in_force_version,
    asset_code: e.asset_code,
    asset_name: e.asset_name,
    asset_type: e.asset_type,
    asset_is_synthetic: e.asset_is_synthetic,
    edge_id: e.id,
    evidence_span: e.evidence_span,
    staleness_direction: verdict.direction,
    reason: verdict.reason,
    assignee_role: asset?.owner_role ?? 'compliance',
    payload: { rule: rule.code, bound_version: verdict.bound_version, in_force_version: verdict.in_force_version, as_of: asOf, disputed: verdict.disputed },
  };
  state.tasks.push(task);
  audit('system', 'task.opened', 'review_task', task.id, { kind: task.kind, rule: rule.code, asset: e.asset_code }, openedAt);
  return task;
}

function openFlaggedTasks(rec: RunRecord, openedAt: string): number {
  let opened = 0;
  const bad = rec.results.filter((r) => r.outcome === 'FAIL' || r.outcome === 'FLAG');
  const byContract = new Map<string, RunResultOut[]>();
  for (const r of bad) byContract.set(r.contract_code, [...(byContract.get(r.contract_code) ?? []), r]);
  for (const [code, rows] of byContract) {
    const contract = CONTRACTS.find((c) => c.code === code);
    if (contract?.kind === 'JUDGED') {
      const first = rows[0];
      const mean = rows.reduce((a, r) => a + (typeof r.evidence.mean === 'number' ? r.evidence.mean : 0), 0) / rows.length;
      const task: ReviewTaskOut = {
        ...blankTask('FLAGGED_RESULT', openedAt),
        run_result_id: first.id,
        run_id: rec.run.id,
        contract_code: code,
        transcript_code: first.transcript_code,
        reason: `${code} flagged ${rows.length}/${rec.run.stats.transcripts as number} transcripts (advisory; judge mean ${mean.toFixed(2)})`,
        assignee_role: contract.owner_role,
        payload: { run_id: rec.run.id, contract: code, severity: contract.severity, aggregate: true, flagged_transcripts: rows.map((r) => r.transcript_code) },
      };
      state.tasks.push(task);
      audit('system', 'task.opened', 'review_task', task.id, { kind: task.kind, run: rec.run.id, contract: code, aggregate: true }, openedAt);
      opened += 1;
      continue;
    }
    for (const r of rows) {
      const task: ReviewTaskOut = {
        ...blankTask('FLAGGED_RESULT', openedAt),
        rule_code: contract?.rule_code ?? null,
        run_result_id: r.id,
        run_id: rec.run.id,
        contract_code: code,
        transcript_code: r.transcript_code,
        reason: `${code} ${r.outcome} on ${r.transcript_code}${typeof r.evidence.direction === 'string' ? ` — ${r.evidence.direction}` : ''}`,
        assignee_role: contract?.owner_role ?? 'compliance',
        payload: { run_id: rec.run.id, contract: code, severity: r.severity, transcript_id: `transcript-${r.transcript_code}` },
      };
      state.tasks.push(task);
      audit('system', 'task.opened', 'review_task', task.id, { kind: task.kind, run: rec.run.id, contract: code, transcript: r.transcript_code }, openedAt);
      opened += 1;
    }
  }
  rec.run.stats = { ...rec.run.stats, review_tasks_opened: opened };
  return opened;
}

function transitionSeed(task: ReviewTaskOut, to: string, actor: string, at: string, reasonCode: string | null, note: string): void {
  const from = task.state;
  task.state = to;
  task.note = note;
  task.reason_code = reasonCode;
  if (['verified', 'republished', 'dismissed', 'upheld', 'overridden'].includes(to)) task.decided_by = actor;
  if (['republished', 'dismissed', 'upheld', 'overridden'].includes(to)) task.closed_at = at;
  audit(actor, 'task.transitioned', 'review_task', task.id, { from, to, reason_code: reasonCode, note }, at);
}

function seedTasks(): void {
  const scanAt = '2026-09-21T13:41:30Z';
  audit('engineer', 'scan.started', 'scan', 'scan-0002', { idempotency_key: '2026-09-21-nightly', live: false, as_of: '2026-10-01' }, '2026-09-21T13:40:50Z');
  ASSETS.forEach((asset, i) => {
    const changed = asset.versions.length > 1;
    audit('system', changed ? 'artifact.content_changed' : 'artifact.unchanged', 'asset', asset.code, changed ? { new_hash: asset.latest_hash, versions: asset.versions.length } : { hash: asset.latest_hash }, `2026-09-21T13:41:0${i % 10}Z`);
  });
  for (const edge of EDGES) {
    if (edge.status === 'proposed') audit('system', 'edge.proposed', 'edge', edge.id, { asset: edge.asset_code, rule: edge.rule_code, confidence: edge.confidence, matcher: edge.matcher }, scanAt);
  }

  // STALE_ASSET tasks: opened by the as-of 2026-10-01 evaluation in the nightly scan
  for (const rule of state.rules) {
    const verdicts = evaluate(rule, EDGES.filter((e) => e.rule_code === rule.code), '2026-10-01');
    audit('system', 'staleness.evaluated', 'rule', rule.code, { as_of: '2026-10-01', ...summarize(verdicts) }, scanAt);
    for (const v of verdicts) openStaleTask(rule, v, '2026-10-01', scanAt);
  }

  // PROPOSED_EDGE task for the llm-detected footer edge
  const proposed = EDGES.find((e) => e.status === 'proposed');
  if (proposed) {
    const task: ReviewTaskOut = {
      ...blankTask('PROPOSED_EDGE', scanAt),
      rule_code: proposed.rule_code,
      rule_version: proposed.rule_version,
      asset_code: proposed.asset_code,
      asset_name: proposed.asset_name,
      asset_type: proposed.asset_type,
      asset_is_synthetic: proposed.asset_is_synthetic,
      edge_id: proposed.id,
      evidence_span: proposed.evidence_span,
      reason: `LLM proposer read this as the CY2024 disclaimer wording (confidence ${proposed.confidence}); needs a human read`,
      assignee_role: 'compliance',
      payload: { rule: proposed.rule_code, detection: 'llm' },
    };
    state.tasks.push(task);
    audit('system', 'task.opened', 'review_task', task.id, { kind: task.kind, edge: proposed.id }, scanAt);
  }

  // RULE_SOURCE_CHANGED: the nightly source check saw the LII page move
  const src: ReviewTaskOut = {
    ...blankTask('RULE_SOURCE_CHANGED', '2026-09-21T13:47:20Z'),
    rule_code: 'tpmo-disclaimer-text',
    rule_version: 2,
    reason: 'Source text for tpmo-disclaimer-text changed since the last check (hash differs). Read the excerpt; add a rule version if the clause moved.',
    assignee_role: 'compliance',
    payload: {
      rule: 'tpmo-disclaimer-text',
      source_url: 'https://www.law.cornell.edu/cfr/text/42/422.2267',
      previous_hash: fixtureHash('lii-422.2267:2026-09-19'),
      new_hash: fixtureHash('lii-422.2267:2026-09-21'),
      excerpt:
        '(41) Third-party marketing organizations must (i) verbally convey the following disclaimer prior to the discussion of any benefits: "We do not offer every plan available in your area. Currently we represent [insert number of organizations] organizations which offer [insert number of plans] products in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options." (ii) Include the disclaimer prominently on TPMO websites and in print and television advertisements.',
    },
  };
  state.tasks.push(src);
  audit('system', 'task.opened', 'review_task', src.id, { kind: src.kind, rule: 'tpmo-disclaimer-text' }, src.opened_at);

  // FLAGGED_RESULT tasks from the rule-flip run and the model-swap run
  const run2 = state.runs.find((r) => r.run.id === RUN_IDS.ruleFlip);
  const run4 = state.runs.find((r) => r.run.id === RUN_IDS.modelSwap);
  if (run2) openFlaggedTasks(run2, '2026-09-19T15:33:02Z');
  if (run4) openFlaggedTasks(run4, '2026-09-21T11:48:20Z');

  // Move a few tasks along so every state appears at least once.
  const stale = state.tasks.filter((t) => t.kind === 'STALE_ASSET');
  const byAsset = (code: string) => stale.find((t) => t.asset_code === code);
  const scWait = byAsset('sc-12');
  if (scWait) transitionSeed(scWait, 'in_review', 'analyst', '2026-09-21T14:05:10Z', null, 'Pulling the scorecard item from Attention; will confirm the weight before editing.');
  const sfmc = byAsset('sfmc-appt-confirm-04');
  if (sfmc) {
    transitionSeed(sfmc, 'in_review', 'engineer', '2026-09-21T14:10:00Z', null, '');
    transitionSeed(sfmc, 'verified', 'engineer', '2026-09-21T14:22:41Z', null, 'Copy updated in SFMC sandbox; awaiting publish to production on 2026-10-01 00:00 ET.');
  }
  const slide8 = byAsset('slide-08');
  if (slide8) {
    transitionSeed(slide8, 'in_review', 'analyst', '2026-09-21T14:30:00Z', null, '');
    transitionSeed(slide8, 'verified', 'engineer', '2026-09-21T14:41:12Z', null, '');
    transitionSeed(slide8, 'republished', 'engineer', '2026-09-21T14:44:03Z', null, 'Slide 8 replaced with the CY2027 timeline (SOA still required; no waiting period).');
  }
  const events = byAsset('web-medicarefaq-events');
  if (events) transitionSeed(events, 'dismissed', 'analyst', '2026-09-21T15:02:27Z', 'ARTIFACT_NOT_IN_SCOPE', 'Page is scheduled for removal in the Q4 content refresh; no edit needed.');
  const supTask = state.tasks.find((t) => t.kind === 'FLAGGED_RESULT' && t.contract_code === 'C-SUP-01');
  if (supTask) transitionSeed(supTask, 'upheld', 'analyst', '2026-09-19T16:12:44Z', 'CORRECT_AS_FLAGGED', 'Prompt v1 still applies the CY2024 superlative rule after Oct 1; fixed in prompt v2.');
  const factTask = state.tasks.find((t) => t.kind === 'FLAGGED_RESULT' && t.contract_code === 'C-FACT-01');
  if (factTask) transitionSeed(factTask, 'in_review', 'engineer', '2026-09-21T12:03:15Z', null, 'Checking whether sim-small rounds figures under $15 to $0.00.');

  // a rejected transition attempt, so the audit log shows the state machine refusing
  audit('analyst', 'task.transition_rejected', 'review_task', slide8?.id ?? 'task-0000', { from: 'republished', to: 'in_review', error: 'STALE_ASSET: republished -> in_review is not allowed' }, '2026-09-21T15:20:09Z');
  audit('analyst', 'auth.denied', 'review_task', sfmc?.id ?? 'task-0000', { attempted: 'republished', role: 'analyst', error: "role 'analyst' may not republish" }, '2026-09-21T15:21:40Z');

  const changedAssets = ASSETS.filter((a) => a.versions.length > 1).length;
  audit('system', 'scan.completed', 'scan', 'scan-0002', { artifacts: ASSETS.length, unchanged: ASSETS.length - changedAssets, new_versions: changedAssets, fetch_errors: 0, edges_new: 1, proposed_new: 1 }, '2026-09-21T13:42:11Z');
}

function stalenessSnapshot(asOf: string): Record<string, ReturnType<typeof summarize>> {
  const out: Record<string, ReturnType<typeof summarize>> = {};
  for (const rule of state.rules) {
    const verdicts = evaluate(rule, EDGES.filter((e) => e.rule_code === rule.code), asOf);
    if (verdicts.length) out[rule.code] = summarize(verdicts);
  }
  return out;
}

function seedScans(): void {
  const changedAssets = ASSETS.filter((a) => a.versions.length > 1).length;
  state.scans.push(
    {
      id: 'scan-0001',
      idempotency_key: '2026-09-19-seed',
      status: 'completed',
      started_at: '2026-09-19T21:14:00Z',
      finished_at: '2026-09-19T21:14:39Z',
      stats: { artifacts: ASSETS.length, unchanged: 0, new_versions: ASSETS.length, fetch_errors: 0, edges_new: EDGES.filter((e) => e.status === 'confirmed').length, edges_existing: 0, proposed_new: 0, mode: 'snapshot', as_of: '2026-09-19', staleness: {} },
      deduplicated: false,
    },
    {
      id: 'scan-0002',
      idempotency_key: '2026-09-21-nightly',
      status: 'completed',
      started_at: '2026-09-21T13:40:50Z',
      finished_at: '2026-09-21T13:42:11Z',
      stats: { artifacts: ASSETS.length, unchanged: ASSETS.length - changedAssets, new_versions: changedAssets, fetch_errors: 0, edges_new: 1, edges_existing: EDGES.length - 1, proposed_new: 1, mode: 'snapshot', as_of: '2026-10-01', staleness: stalenessSnapshot('2026-10-01') },
      deduplicated: false,
    },
  );
}

function seedAudit(): void {
  audit('admin', 'rules.reloaded', 'rules', 'rules/*.yaml', { rules_created: RULES.length, versions_created: RULES.length * 2, unchanged: 0, files: RULES.map((r) => `rules/${r.code}.yaml`) }, '2026-09-19T21:02:33Z');
  audit('engineer', 'scan.started', 'scan', 'scan-0001', { idempotency_key: '2026-09-19-seed', live: false }, '2026-09-19T21:14:00Z');
  audit('system', 'scan.completed', 'scan', 'scan-0001', { artifacts: ASSETS.length, new_versions: ASSETS.length }, '2026-09-19T21:14:39Z');
  EDGES.filter((e) => e.status === 'confirmed')
    .slice(0, 6)
    .forEach((e, i) => audit(e.confirmed_by ?? 'analyst', 'edge.confirmed', 'edge', e.id, { asset: e.asset_code, rule: `${e.rule_code}@${e.rule_version}`, polarity: e.polarity, detection: e.detection }, `2026-09-19T21:2${i}:00Z`));
  for (const rec of state.runs) {
    audit(rec.run.requested_by, 'run.started', 'run', rec.run.id, { trigger: rec.run.trigger, prompt_version: rec.run.prompt_version, model_id: rec.run.model_id, rule_date: rec.run.rule_date, adapter: rec.run.adapter, corpus: rec.corpus }, rec.run.started_at);
    audit('system', 'run.completed', 'run', rec.run.id, { gate: rec.run.gate, transcripts: rec.run.stats.transcripts as number, latency_ms_total: rec.run.stats.latency_ms_total as number }, rec.run.finished_at ?? rec.run.started_at);
  }
  audit('engineer', 'run.deduplicated', 'run', RUN_IDS.promptV2, { run_key: state.runs[2]?.run.run_key ?? '', requested_by: 'engineer' }, '2026-09-20T09:40:12Z');
}

/**
 * Two seeded examples of the override loop, as the backend's demo seed makes
 * them: a flagged call overridden with a reason, then approved by a different
 * person (one APPROVED, one still PENDING_APPROVAL). Their review tasks are
 * closed, so they never count as open work.
 */
function seedExampleTestCases(): void {
  const examples: Array<{ contract: string; transcript: string; reason: string; note: string; approved: boolean; at: string }> = [
    {
      contract: 'C-FACT-01',
      transcript: 'T018',
      reason: 'FALSE_POSITIVE_MATCHER',
      note: 'The agent said "twelve forty" and the model wrote $12.40 — same figure, spoken form. Not a fabricated number.',
      approved: true,
      at: '2026-09-20T10:14:00Z',
    },
    {
      contract: 'C-SUP-01',
      transcript: 'T031',
      reason: 'RULE_EXCEPTION_APPLIES',
      note: '"Best fit for your prescriptions" compares the caller’s own drug list; it is not a plan superlative.',
      approved: false,
      at: '2026-09-21T16:02:00Z',
    },
  ];
  for (const ex of examples) {
    const task: ReviewTaskOut = {
      ...blankTask('FLAGGED_RESULT', ex.at),
      run_id: RUN_IDS.promptV2,
      contract_code: ex.contract,
      transcript_code: ex.transcript,
      rule_code: CONTRACTS.find((c) => c.code === ex.contract)?.rule_code ?? null,
      reason: `${ex.contract} FAIL on ${ex.transcript} (seeded example)`,
      assignee_role: 'compliance',
      payload: { seeded_example: true, contract: ex.contract, transcript_id: `transcript-${ex.transcript}` },
    };
    state.tasks.push(task);
    audit('system', 'task.opened', 'review_task', task.id, { kind: task.kind, contract: ex.contract, transcript: ex.transcript, seeded_example: true }, ex.at);
    transitionSeed(task, 'overridden', 'demo-seed:qa-reviewer', ex.at, ex.reason, ex.note);
    const created = new Date(ex.at);
    const expires = new Date(created);
    expires.setUTCDate(expires.getUTCDate() + 365);
    const tc: TestCaseOut = {
      id: `tc-${String(state.testCases.length + 1).padStart(4, '0')}`,
      review_task_id: task.id,
      contract_code: ex.contract,
      transcript_code: ex.transcript,
      expected: { outcome: 'PASS', reason_code: ex.reason, note: ex.note, seeded_example: true },
      reason_code: ex.reason,
      created_by: 'demo-seed:qa-reviewer',
      approver: ex.approved ? 'demo-seed:compliance-lead' : null,
      status: ex.approved ? 'APPROVED' : 'PENDING_APPROVAL',
      expires_at: expires.toISOString(),
      created_at: ex.at,
    };
    state.testCases.push(tc);
    task.payload = { ...task.payload, test_case_id: tc.id };
    audit('demo-seed:qa-reviewer', 'test_case.created', 'test_case', tc.id, { review_task: task.id, contract: tc.contract_code, transcript: tc.transcript_code, expires_at: tc.expires_at, seeded_example: true }, ex.at);
    if (ex.approved) {
      audit('demo-seed:compliance-lead', 'test_case.approved', 'test_case', tc.id, { created_by: tc.created_by, seeded_example: true }, new Date(created.getTime() + 3_600_000).toISOString());
    }
  }
}

seedRuns();
seedAudit();
seedTasks();
seedExampleTestCases();
seedScans();

// ------------------------------------------------------------------ helpers

function ruleOut(rule: RuleOut): RuleOut {
  const inForce = versionInForce(rule, todayIso());
  return {
    ...rule,
    in_force_version: inForce?.version ?? null,
    dependents: EDGES.filter((e) => e.rule_code === rule.code && e.status === 'confirmed').length,
    contracts: CONTRACTS.filter((c) => c.rule_code === rule.code).map((c) => c.code),
  };
}

function assetSummary(asset: (typeof ASSETS)[number]): AssetOut {
  const { content_text: _text, edges: _edges, ...rest } = asset;
  return rest;
}

function impact(rule: RuleOut, asOf: string): ImpactOut {
  const edges = EDGES.filter((e) => e.rule_code === rule.code);
  const verdicts = evaluate(rule, edges, asOf);
  const inForce = versionInForce(rule, asOf);
  const stale: StaleItemOut[] = verdicts.map((v) => {
    const task = state.tasks.find((t) => t.kind === 'STALE_ASSET' && t.edge_id === v.edge.id && t.rule_version === v.in_force_version);
    return {
      edge: v.edge,
      bound_version: v.bound_version,
      in_force_version: v.in_force_version,
      direction: v.direction,
      reason: v.reason,
      disputed: v.disputed,
      task_id: task?.id ?? null,
      task_state: task?.state ?? null,
    };
  });
  const prompts = WORKFLOWS.flatMap((w) =>
    w.prompt_versions
      .filter((p) => p.encodes_rule_versions.some((ref) => ref.rule === rule.code))
      .map((p) => {
        const declared = p.encodes_rule_versions.find((ref) => ref.rule === rule.code)?.version ?? null;
        return {
          id: p.id,
          workflow: w.code,
          version: p.version,
          label: p.label,
          prompt_hash: p.prompt_hash,
          declared_version: declared,
          stale: inForce ? declared !== inForce.version : false,
        };
      }),
  );
  return {
    rule_code: rule.code,
    as_of: asOf,
    in_force_version: inForce?.version ?? null,
    counts: summarize(verdicts),
    stale,
    current_edges: inForce ? edges.filter((e) => e.rule_version_id === inForce.id && e.status === 'confirmed') : [],
    contracts: CONTRACTS.filter((c) => c.rule_code === rule.code).map((c) => c.code),
    prompt_versions: prompts,
  };
}

/**
 * What-if blast radius (backend rules_impact with include_proposed): evaluate
 * as if a proposed version were enacted from its effective_from, every enacted
 * window still open on that day closing the day before. In memory only: no
 * tasks, no audit rows.
 */
function impactWhatIf(rule: RuleOut, asOf: string, assumeVersion: number | null, path: string): ImpactWhatIfOut {
  const proposals = rule.versions.filter((v) => v.status === 'proposed');
  let assumed: RuleVersionOut | undefined;
  if (assumeVersion !== null) {
    assumed = proposals.find((v) => v.version === assumeVersion);
    if (!assumed) throw new ApiError(404, `${rule.code} has no proposed version ${assumeVersion}`, path);
  } else {
    assumed = proposals.filter((v) => v.effective_from !== null && v.effective_from <= asOf).sort((x, y) => y.version - x.version)[0];
  }
  if (!assumed) {
    return { ...impact(rule, asOf), hypothetical: false, assumed_version: null, note: `no proposed version of ${rule.code} is effective on ${asOf}; enacted history shown` };
  }
  // An undated proposal (awaiting a vote) is assumed to take effect on as_of, and the note says so.
  const assumedFrom = assumed.effective_from ?? asOf;
  const dated = assumed.effective_from
    ? `from ${assumed.effective_from}`
    : `no effective date yet${assumed.vote_date ? `, vote ${assumed.vote_date}` : ''}; assumed from ${asOf}`;
  const d = new Date(`${assumedFrom}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const cut = d.toISOString().slice(0, 10);
  const hypothetical: RuleOut = {
    ...rule,
    versions: rule.versions.map((v) => {
      if (v.id === assumed?.id) return { ...v, status: 'in_force', effective_from: assumedFrom, effective_to: null };
      if (governs(v) && v.effective_from <= cut && (v.effective_to === null || v.effective_to > cut)) return { ...v, effective_to: cut };
      return v;
    }),
  };
  return {
    ...impact(hypothetical, asOf),
    hypothetical: true,
    assumed_version: assumed.version,
    note: `what-if: v${assumed.version} (proposed, ${dated}) treated as enacted; no tasks were opened and nothing was written`,
  };
}

const BAD = new Set(['FAIL', 'FLAG', 'ERROR']);

function compare(a: RunRecord, b: RunRecord): CompareOut {
  const key = (r: RunResultOut) => `${r.transcript_code}|${r.contract_code}`;
  const bMap = new Map(b.results.map((r) => [key(r), r]));
  const aKeys = new Set(a.results.map(key));
  // Only cells both runs scored are comparable (same as the backend).
  const cells_only_in_a = a.results.filter((r) => !bMap.has(key(r))).length;
  const cells_only_in_b = b.results.filter((r) => !aKeys.has(key(r))).length;
  const shared = (r: RunResultOut) => aKeys.has(key(r)) && bMap.has(key(r));
  const newly_failing: CompareCell[] = [];
  const newly_passing: CompareCell[] = [];
  let unchanged_failing = 0;
  let unchanged_passing = 0;
  for (const ra of a.results) {
    const rb = bMap.get(key(ra));
    if (!rb) continue;
    const aBad = BAD.has(ra.outcome);
    const bBad = BAD.has(rb.outcome);
    const cell = { transcript_code: ra.transcript_code, contract_code: ra.contract_code, a: ra.outcome, b: rb.outcome };
    if (!aBad && bBad) newly_failing.push(cell);
    else if (aBad && !bBad) newly_passing.push(cell);
    else if (aBad && bBad) unchanged_failing += 1;
    else unchanged_passing += 1;
  }
  const per_contract: PerContractDelta[] = CONTRACTS.map((c) => ({
    contract_code: c.code,
    a_fail: a.results.filter((r) => shared(r) && r.contract_code === c.code && BAD.has(r.outcome)).length,
    b_fail: b.results.filter((r) => shared(r) && r.contract_code === c.code && BAD.has(r.outcome)).length,
    newly_failing: newly_failing.filter((x) => x.contract_code === c.code).length,
    newly_passing: newly_passing.filter((x) => x.contract_code === c.code).length,
    a_error: a.results.filter((r) => shared(r) && r.contract_code === c.code && r.outcome === 'ERROR').length,
    b_error: b.results.filter((r) => shared(r) && r.contract_code === c.code && r.outcome === 'ERROR').length,
  })).sort((x, y) => x.contract_code.localeCompare(y.contract_code));
  return {
    failure_definition: COMPARE_FAILURE_DEFINITION,
    statistics: compareStatistics(a, b),
    a: a.run,
    b: b.run,
    what_changed: {
      prompt: a.run.prompt_hash !== b.run.prompt_hash,
      model: a.run.model_id !== b.run.model_id,
      rule_date: a.run.rule_date !== b.run.rule_date,
      adapter: a.run.adapter !== b.run.adapter,
      corpus: a.run.corpus_hash !== b.run.corpus_hash,
      cells_only_in_a,
      cells_only_in_b,
      contract_set: a.run.contract_set_hash !== b.run.contract_set_hash,
    },
    newly_failing,
    newly_passing,
    unchanged_failing,
    unchanged_passing,
    per_contract,
  };
}

function promptDiff(aId: string, bId: string): PromptDiffOut {
  const all = WORKFLOWS.flatMap((w) => w.prompt_versions);
  const a = all.find((p) => p.id === aId) ?? notFound(`prompt ${aId}`);
  const b = all.find((p) => p.id === bId) ?? notFound(`prompt ${bId}`);
  const aLines = (a.text ?? '').split(/(?<=\. )/);
  const bLines = (b.text ?? '').split(/(?<=\. )/);
  const unified: string[] = [`--- v${a.version} (${a.prompt_hash.slice(0, 16)})`, `+++ v${b.version} (${b.prompt_hash.slice(0, 16)})`, `@@ -1,${aLines.length} +1,${bLines.length} @@`];
  const bSet = new Set(bLines);
  const aSet = new Set(aLines);
  for (const line of aLines) unified.push(bSet.has(line) ? ` ${line}` : `-${line}`);
  for (const line of bLines) if (!aSet.has(line)) unified.push(`+${line}`);
  const refKey = (r: { rule: string; version: number }) => `${r.rule}@${r.version}`;
  const aRefs = new Set(a.encodes_rule_versions.map(refKey));
  const bRefs = new Set(b.encodes_rule_versions.map(refKey));
  return {
    a: { id: a.id, version: a.version, label: a.label, prompt_hash: a.prompt_hash },
    b: { id: b.id, version: b.version, label: b.label, prompt_hash: b.prompt_hash },
    unified_diff: unified,
    rule_dependencies: {
      removed: a.encodes_rule_versions.filter((r) => !bRefs.has(refKey(r))),
      added: b.encodes_rule_versions.filter((r) => !aRefs.has(refKey(r))),
      unchanged: a.encodes_rule_versions.filter((r) => bRefs.has(refKey(r))),
    },
  };
}

function exportRun(rec: RunRecord, format: string): unknown {
  const { run, results } = rec;
  if (format === 'csv') {
    const header = 'run_id,transcript_code,contract_code,severity,outcome,latency_ms,evidence';
    const rows = results.map((r) => [run.id, r.transcript_code, r.contract_code, r.severity, r.outcome, r.latency_ms, JSON.stringify(JSON.stringify(r.evidence))].join(','));
    return [header, ...rows].join('\n');
  }
  if (format === 'langsmith') {
    return {
      format: 'langsmith',
      dataset: `backstop/${run.workflow_code}`,
      examples: results.map((r) => ({ inputs: { transcript: r.transcript_code, prompt_hash: run.prompt_hash, rule_date: run.rule_date }, outputs: { contract: r.contract_code, outcome: r.outcome }, metadata: { run_id: run.id, model: run.model_id, adapter: run.adapter, evidence: r.evidence } })),
    };
  }
  return {
    format: 'braintrust',
    project: 'backstop',
    experiment: run.run_key,
    records: results.map((r) => ({ input: { transcript: r.transcript_code, prompt_hash: run.prompt_hash, rule_date: run.rule_date }, output: { contract: r.contract_code, outcome: r.outcome }, scores: { pass: r.outcome === 'PASS' ? 1 : 0 }, metadata: { severity: r.severity, evidence: r.evidence } })),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parse(path: string): { segments: string[]; query: URLSearchParams } {
  const [p, q = ''] = path.split('?');
  return { segments: p.split('/').filter(Boolean), query: new URLSearchParams(q) };
}

function asObject(body: unknown): JsonObject {
  return typeof body === 'object' && body !== null ? (body as JsonObject) : {};
}

function notFound(what: string): never {
  throw new ApiError(404, `${what} not found`, '');
}

function requireEditor(role: string, what: string, path: string): void {
  if (!['engineer', 'admin'].includes(role)) throw new ApiError(403, `role '${role}' may not ${what}`, path);
}

// ------------------------------------------------------------------ router

export async function mockRequest(method: string, path: string, body?: unknown, credentials?: Credentials | null): Promise<unknown> {
  await sleep(LATENCY_MS);
  const { segments, query } = parse(path);
  const [head, second, third, fourth] = segments;

  // /health and /health/deep need no auth
  if (method === 'GET' && head === 'health') {
    const last = state.scans[state.scans.length - 1];
    const deep = healthDeep(SCENARIOS.length + state.ingested.length, last ? { id: last.id, status: last.status, finished_at: last.finished_at } : null);
    return second === 'deep' ? deep : { ready: deep.ready, version: deep.version };
  }

  const creds = credentials === undefined ? getCredentials() : credentials;
  const user = creds ? DEMO_USERS[creds.username] : undefined;
  if (!creds || !user || user.password !== creds.password) {
    throw new ApiError(401, 'Not authenticated', path, { detail: 'Not authenticated' });
  }
  const actor = creds.username;
  const role = user.role;

  // ---- meta
  if (method === 'GET' && head === 'meta') {
    const meta: MetaOut = {
      app: 'backstop',
      version: '0.1.0-mock',
      environment_label: 'PROTOTYPE · SYNTHETIC DATA',
      adapters: { simulated: true, cassette: true, live: true, anthropic: false },
      providers: Object.fromEntries(Object.entries(PROVIDERS).map(([name, info]) => [name, { ...info, models: MODELS.filter((m) => m.provider === name).map((m) => m.model_id) }])),
      default_adapter: 'cassette',
      synthetic_notice:
        'All call transcripts and internal artifacts are synthetic. Public web pages are real, fetched read-only and attributed. Simulated model runs use declared defect profiles; cassette runs replay recorded model output; live runs require an API key.',
      today: todayIso(),
      user: actor,
      role,
    };
    return meta;
  }

  // ---- identity
  if (method === 'GET' && head === 'me') return fallbackMe(actor, role);

  // ---- sandbox: nothing persisted; only the hash is audited
  if (head === 'sandbox') {
    if (method === 'GET' && second === 'samples') return SAMPLES;
    if (method === 'POST' && second === 'artifact') {
      const out = await sandboxArtifact(asObject(body), state.rules, todayIso(), path);
      audit(actor, 'sandbox.artifact_checked', 'sandbox', out.text_sha256, { text_sha256: out.text_sha256, chars: out.chars, matches: out.summary.matches, stale: out.summary.stale, as_of: out.as_of, label: out.label });
      return out;
    }
    if (method === 'POST' && second === 'transcript') {
      const out = await sandboxTranscript(asObject(body), path);
      const text = typeof asObject(body).text === 'string' ? (asObject(body).text as string) : '';
      const digest = fixtureHash(text);
      audit(actor, 'sandbox.transcript_checked', 'sandbox', digest, { text_sha256: digest, chars: text.length, model_id: out.model_id, latency_ms: out.latency_ms, outcomes: Object.fromEntries(out.contracts.map((c) => [c.code, c.outcome])) });
      return out;
    }
  }

  // ---- rules
  if (head === 'rules') {
    if (method === 'GET' && !second) return state.rules.map(ruleOut);
    if (method === 'POST' && second === 'reload') {
      audit(actor, 'rules.reloaded', 'rules', 'rules/*.yaml', { unchanged: state.rules.length });
      return { rules_created: 0, versions_created: 0, unchanged: state.rules.length, files: state.rules.map((r) => `rules/${r.code}.yaml`) };
    }
    const rule = state.rules.find((r) => r.code === second) ?? notFound(`rule ${second}`);
    if (method === 'GET' && !third) return ruleOut(rule);
    if (method === 'GET' && third === 'impact') {
      const asOf = query.get('as_of') || todayIso();
      const assume = query.get('assume_version');
      if (query.get('include_proposed') === 'true' || assume) return impactWhatIf(rule, asOf, assume ? Number(assume) : null, path);
      return impact(rule, asOf);
    }
    if (method === 'GET' && third === 'sources') return ruleSources(rule.code);
    if (method === 'POST' && third === 'versions') {
      requireEditor(role, 'propose rule versions', path);
      const req = asObject(body) as unknown as RuleVersionCreate & { status?: string };
      // Same refusal as the backend: the API records proposals only (ADR-001).
      if ((req.status ?? 'proposed') !== 'proposed') {
        throw new ApiError(
          422,
          "The API may only create status 'proposed'. In-force history comes from reviewed YAML in git (rules/<code>.yaml, merged by a second person, then POST /rules/reload); see ADR-001.",
          path,
        );
      }
      if (!req.clause_text || !req.effective_from || !req.change_classification) {
        throw new ApiError(422, 'clause_text, effective_from and change_classification are required', path);
      }
      const clause = req.clause_text.trim();
      const duplicate = rule.versions.find((v) => v.effective_from === req.effective_from && v.clause_text.trim() === clause);
      if (duplicate) {
        throw new ApiError(409, `${rule.code} v${duplicate.version} (${duplicate.status}) already has this effective_from and clause_text`, path);
      }
      const lastEnacted = governingVersions(rule).pop();
      if (lastEnacted && req.effective_from <= lastEnacted.effective_from) {
        throw new ApiError(422, "effective_from must be after the latest enacted version's effective_from", path);
      }
      // A proposal never closes its predecessor's window: it is not law.
      const latest = [...rule.versions].sort((a, b) => b.version - a.version)[0];
      const version: RuleVersionOut = {
        id: `rv-${rule.code}-${(latest?.version ?? 0) + 1}`,
        version: (latest?.version ?? 0) + 1,
        status: 'proposed',
        clause_text: req.clause_text,
        summary: req.summary ?? '',
        effective_from: req.effective_from,
        effective_to: null,
        change_classification: req.change_classification,
        params: req.params ?? {},
        disputed: req.disputed ?? false,
        dispute_note: req.dispute_note ?? '',
        source_url: req.source_url ?? '',
        git_commit: 'uncommitted',
        created_at: nowIso(),
      };
      rule.versions.push(version);
      audit(actor, 'rule.version_created', 'rule_version', version.id, { rule: rule.code, version: version.version, status: version.status, effective_from: version.effective_from, change_classification: version.change_classification, source: 'api' });
      return version;
    }
  }

  // ---- sources check
  if (head === 'sources' && second === 'check' && method === 'POST') {
    requireEditor(role, 'check rule sources', path);
    const live = query.get('live') === 'true';
    const out: SourcesCheckOut = { checked: 7, changed: 0, unchanged: 7, first_seen: 0, errors: 0, mode: live ? 'live' : 'snapshot' };
    audit(actor, 'scan.completed', 'scan', `sources:${todayIso()}`, { kind: 'rule_sources', ...out });
    return out;
  }

  // ---- assets
  if (head === 'assets' && method === 'GET') {
    if (!second) return ASSETS.map(assetSummary);
    return findAsset(second) ?? notFound(`asset ${second}`);
  }

  // ---- scans
  if (head === 'scans') {
    if (method === 'GET' && !second) return state.scans;
    if (method === 'GET') return state.scans.find((s) => s.id === second) ?? notFound(`scan ${second}`);
    if (method === 'POST') {
      requireEditor(role, 'run scans', path);
      const req = asObject(body);
      const key = typeof req.idempotency_key === 'string' && req.idempotency_key ? req.idempotency_key : `${todayIso()}-${Date.now()}`;
      const existing = state.scans.find((s) => s.idempotency_key === key);
      if (existing) return { ...existing, deduplicated: true };
      const asOf = typeof req.as_of === 'string' && req.as_of ? req.as_of : todayIso();
      const scan: ScanOut = {
        id: `scan-${String(state.scans.length + 1).padStart(4, '0')}`,
        idempotency_key: key,
        status: 'completed',
        started_at: nowIso(),
        finished_at: new Date(Date.now() + 1400).toISOString(),
        stats: { artifacts: ASSETS.length, unchanged: ASSETS.length, new_versions: 0, fetch_errors: 0, edges_new: 0, edges_existing: EDGES.length, proposed_new: 0, mode: req.live === true ? 'live' : 'snapshot', as_of: asOf, staleness: stalenessSnapshot(asOf) },
        deduplicated: false,
      };
      state.scans.push(scan);
      audit(actor, 'scan.started', 'scan', scan.id, { idempotency_key: key, live: req.live === true, as_of: asOf });
      audit('system', 'scan.completed', 'scan', scan.id, { ...scan.stats, staleness: undefined });
      return scan;
    }
  }

  // ---- workflows / prompts / models / contracts
  if (head === 'workflows' && method === 'GET') {
    if (!second) return WORKFLOWS.map((w) => ({ ...w, prompt_versions: w.prompt_versions.map((p) => ({ ...p, text: null })) }));
    return WORKFLOWS.find((w) => w.code === second) ?? notFound(`workflow ${second}`);
  }
  if (head === 'prompts' && method === 'GET') {
    if (second === 'diff') return promptDiff(query.get('a') ?? '', query.get('b') ?? '');
    return WORKFLOWS.flatMap((w) => w.prompt_versions).find((p) => p.id === second) ?? notFound(`prompt ${second}`);
  }
  if (head === 'models' && method === 'GET') {
    if (second === 'board') {
      return modelBoard(state.runs.map((r) => r.run), Number(query.get('prompt') ?? 2), query.get('rule_date') || '2026-10-01');
    }
    return MODELS;
  }
  if (head === 'contracts' && method === 'GET') {
    if (!second) return CONTRACTS;
    if (third === 'metrics') {
      const runId = query.get('run_id');
      if (runId && !state.runs.some((r) => r.run.id === runId)) notFound('run');
      return contractMetrics(second, state.runs, query) ?? notFound('contract');
    }
  }

  // ---- readiness: what flips next, who owns the open work
  if (head === 'readiness' && method === 'GET') {
    return readiness(state.rules, EDGES, state.tasks, query.get('as_of') || todayIso(), laneOf);
  }

  // ---- transcripts
  if (head === 'transcripts' && method === 'GET') {
    if (second) {
      const sc = SCENARIOS.find((s) => s.code === second);
      if (sc) return transcriptOut(sc, true);
      const sample = INGESTED.find((s) => s.code === second);
      if (sample) return ingestedOut(sample, true);
      return state.ingested.find((t) => t.code === second) ?? notFound(`transcript ${second}`);
    }
    const limit = Number(query.get('limit') ?? 50);
    const offset = Number(query.get('offset') ?? 0);
    // The mock carries no held-out calls (H001–H060); "synthetic" (the default) and "all" match.
    const corpus = query.get('corpus') ?? 'synthetic';
    const development = SCENARIOS.map((s) => transcriptOut(s, false));
    const all: TranscriptOut[] =
      corpus === 'holdout' ? [] : corpus === 'ingested' ? [...state.ingested] : [...development, ...state.ingested];
    return all.slice(offset, offset + limit);
  }

  // ---- runs
  if (head === 'runs') {
    if (method === 'GET' && !second) return state.runs.map((r) => r.run).sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
    if (method === 'GET' && second === 'compare') {
      const a = state.runs.find((r) => r.run.id === query.get('a')) ?? notFound(`run ${query.get('a')}`);
      const b = state.runs.find((r) => r.run.id === query.get('b')) ?? notFound(`run ${query.get('b')}`);
      return compare(a, b);
    }
    if (method === 'POST' && !second) {
      requireEditor(role, 'start runs', path);
      const req = asObject(body) as unknown as RunRequest;
      const workflow = req.workflow ?? 'qa-handoff';
      const prompt = findPromptVersion(workflow, Number(req.prompt_version));
      const model = findModel(req.model_id);
      if (!prompt) throw new ApiError(422, `unknown prompt version ${req.prompt_version} for ${workflow}`, path);
      if (!model) throw new ApiError(422, `unknown model ${req.model_id}`, path);
      const adapter = req.adapter ?? 'simulated';
      if (adapter === 'anthropic') throw new ApiError(409, 'adapter "anthropic" is not available: ANTHROPIC_API_KEY is not set', path);
      if (!req.rule_date) throw new ApiError(422, 'rule_date is required', path);
      if (req.corpus === 'holdout') throw new ApiError(422, "no transcripts in corpus 'holdout'", path);
      const corpus: RunCorpus = req.corpus === 'ingested' || req.corpus === 'all' ? req.corpus : 'synthetic';
      const runKey = [workflow, prompt.prompt_hash.slice(0, 16), model.model_id, adapter, corpusHash(corpus).slice(0, 16), CONTRACT_SET_HASH.slice(0, 16), req.rule_date].join(':');
      const existing = state.runs.find((r) => r.run.run_key === runKey);
      if (existing) {
        audit(actor, 'run.deduplicated', 'run', existing.run.id, { run_key: runKey });
        return { ...existing.run, deduplicated: true };
      }
      const id = `${fixtureHash(runKey).slice(0, 8)}-${fixtureHash(runKey + 'x').slice(0, 4)}-4${fixtureHash(runKey + 'y').slice(0, 3)}-a${fixtureHash(runKey + 'z').slice(0, 3)}-${fixtureHash(runKey + 'w').slice(0, 12)}`;
      const rec = makeRun(id, prompt.version, model.model_id, adapter, req.rule_date, req.trigger ?? 'MANUAL', nowIso(), actor, corpus);
      state.runs.push(rec);
      audit(actor, 'run.started', 'run', id, { trigger: rec.run.trigger, prompt_version: rec.run.prompt_version, model_id: rec.run.model_id, rule_date: rec.run.rule_date, adapter, corpus });
      const opened = openFlaggedTasks(rec, nowIso());
      audit('system', 'run.completed', 'run', id, { gate: rec.run.gate, transcripts: rec.run.stats.transcripts as number, review_tasks_opened: opened });
      return rec.run;
    }
    const rec = state.runs.find((r) => r.run.id === second) ?? notFound(`run ${second}`);
    if (method === 'GET' && !third) return rec.run;
    if (method === 'GET' && third === 'export') return exportRun(rec, query.get('format') ?? 'braintrust');
    if (method === 'GET' && third === 'results') {
      const contract = query.get('contract');
      const outcome = query.get('outcome');
      const transcript = query.get('transcript');
      return rec.results.filter((r) => (!contract || r.contract_code === contract) && (!outcome || r.outcome === outcome) && (!transcript || r.transcript_code === transcript));
    }
    if (method === 'GET' && third === 'transcripts' && fourth) {
      return runTranscript(rec.run, fourth, rec.results) ?? notFound(`transcript ${fourth}`);
    }
  }

  // ---- review
  if (head === 'review') {
    if (method === 'GET' && !second) {
      const st = query.get('state');
      const kind = query.get('kind');
      const lane = query.get('lane');
      return state.tasks
        .filter((t) => (!st || t.state === st) && (!kind || t.kind === kind) && (!lane || laneOf(t) === lane))
        .sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1))
        .map((t) => withTransitions(t, role));
    }
    const task = state.tasks.find((t) => t.id === second) ?? notFound(`review task ${second}`);
    if (method === 'GET') return withTransitions(task, role);
    if (method === 'POST' && third === 'transition') {
      const req = asObject(body) as unknown as TransitionRequest;
      const legal = TRANSITIONS[task.kind]?.[task.state] ?? [];
      if (!legal.includes(req.to)) {
        audit(actor, 'task.transition_rejected', 'review_task', task.id, { from: task.state, to: req.to, error: `${task.kind}: ${task.state} -> ${req.to} is not allowed` });
        throw new ApiError(409, `${task.kind}: ${task.state} -> ${req.to} is not allowed`, path);
      }
      if (!allowedTransitions(task, role).includes(req.to)) {
        audit(actor, 'auth.denied', 'review_task', task.id, { attempted: req.to, role });
        throw new ApiError(403, req.to === 'republished' ? `role '${role}' may not republish` : `role '${role}' may not decide review tasks`, path);
      }
      if (REASON_REQUIRED.has(req.to) && !req.reason_code) throw new ApiError(422, `reason_code is required for '${req.to}'`, path);
      const from = task.state;
      task.state = req.to;
      task.note = req.note ?? task.note;
      task.reason_code = req.reason_code ?? task.reason_code;
      if (['verified', 'republished', 'dismissed', 'upheld', 'overridden'].includes(req.to)) task.decided_by = actor;
      if (['republished', 'dismissed', 'upheld', 'overridden'].includes(req.to)) task.closed_at = nowIso();
      audit(actor, 'task.transitioned', 'review_task', task.id, { from, to: req.to, reason_code: req.reason_code ?? null, note: req.note ?? '' });
      if (req.to === 'overridden' && task.contract_code) {
        const expires = new Date();
        expires.setUTCFullYear(expires.getUTCFullYear() + 1);
        const tc: TestCaseOut = {
          id: `tc-${String(state.testCases.length + 1).padStart(4, '0')}`,
          review_task_id: task.id,
          contract_code: task.contract_code,
          transcript_code: task.transcript_code,
          expected: { outcome: 'PASS', reason_code: req.reason_code, note: req.note ?? '', overrides: task.payload.severity ?? null },
          reason_code: req.reason_code ?? 'OTHER',
          created_by: actor,
          approver: null,
          status: 'PENDING_APPROVAL',
          expires_at: expires.toISOString(),
          created_at: nowIso(),
        };
        state.testCases.push(tc);
        task.payload = { ...task.payload, test_case_id: tc.id };
        audit(actor, 'test_case.created', 'test_case', tc.id, { review_task: task.id, contract: tc.contract_code, transcript: tc.transcript_code, expires_at: tc.expires_at });
      }
      return withTransitions(task, role);
    }
  }

  // ---- test cases
  if (head === 'test-cases') {
    if (method === 'GET') return state.testCases;
    if (method === 'POST' && third === 'approve') {
      requireEditor(role, 'approve test cases', path);
      const tc = state.testCases.find((t) => t.id === second) ?? notFound(`test case ${second}`);
      if (tc.created_by === actor) throw new ApiError(409, 'approver must differ from creator', path);
      if (tc.status !== 'PENDING_APPROVAL') throw new ApiError(409, `test case is ${tc.status}`, path);
      tc.status = 'APPROVED';
      tc.approver = actor;
      audit(actor, 'test_case.approved', 'test_case', tc.id, { created_by: tc.created_by });
      return tc;
    }
  }

  // ---- evals / ingest
  if (head === 'evals' && method === 'GET') {
    if (second === 'matchers') return matcherEvals();
    if (second === 'matchers.md') return matcherEvalsMarkdown();
  }
  if (head === 'ingest') {
    if (method === 'GET' && second === 'formats') return ingestFormats();
    if (method === 'POST' && second === 'transcripts') {
      requireEditor(role, 'ingest transcripts', path);
      const format = query.get('format') ?? 'attention-snowflake';
      const req = asObject(body);
      const filename = typeof req.filename === 'string' ? req.filename : 'upload.csv';
      const batchHash = fixtureHash(`${filename}:${String(req.size ?? 0)}`);
      const seen = state.ingested.some((t) => t.labels.batch_hash === batchHash);
      const created = seen ? 0 : 2;
      if (!seen) {
        for (let i = 1; i <= 2; i++) {
          const code = `A-${batchHash.slice(0, 6).toUpperCase()}-${String(i).padStart(4, '0')}`;
          state.ingested.push({
            id: `transcript-${code}`,
            code,
            product_line: i === 1 ? 'MA' : 'PDP',
            synthetic: false,
            duration_seconds: 140 + i * 17,
            labels: { ingested: true, format, agent: 'Dana', started_at: nowIso(), ground_truth: null, redacted: { medicare_number: i === 1 ? 1 : 0, ssn: 0, dob: 1 }, batch_hash: batchHash },
            text: null,
          });
        }
      }
      const out: IngestResultOut = {
        format,
        created,
        skipped_existing: seen ? 2 : 0,
        redacted: { medicare_number: created ? 1 : 0, ssn: 0, dob: created ? 2 : 0 },
        batch_hash: batchHash,
        note: 'Ingested transcripts carry no ground truth; rule contracts report ERROR for them until labels exist.',
      };
      audit(actor, 'scan.completed', 'scan', `ingest:${batchHash.slice(0, 8)}`, { kind: 'ingest', file: filename, ...out, redacted: undefined });
      return out;
    }
  }

  // ---- status rail
  if (head === 'status' && method === 'GET') {
    const deep = healthDeep(SCENARIOS.length + state.ingested.length, null);
    const done = state.runs
      .filter((r) => r.run.status === 'COMPLETE' || r.run.status === 'FAILED')
      .sort((a, b) => ((a.run.finished_at ?? '') < (b.run.finished_at ?? '') ? 1 : -1));
    const last = done[0]?.run;
    const open = state.tasks.filter((t) => t.state === 'open');
    const out: StatusOut = {
      status: deep.status ?? 'healthy',
      components: deep.components ?? [],
      counts: {
        rules: state.rules.length,
        artifacts: ASSETS.length,
        contracts: CONTRACTS.length,
        golden_cases: matcherEvals().summary.cases,
        transcripts: SCENARIOS.length + state.ingested.length,
      },
      last_run: last
        ? { id: last.id, finished_at: last.finished_at, gate: last.gate, status: last.status, model_id: last.model_id, prompt_version: last.prompt_version, trigger: last.trigger }
        : null,
      review: {
        actionable_open: open.filter((t) => laneOf(t) === 'actionable').length,
        advisory_open: open.filter((t) => laneOf(t) === 'advisory').length,
      },
      audit_chain: { verified: true, rows: state.audit.length },
      user: { name: actor, role },
      environment_label: 'PROTOTYPE · SYNTHETIC DATA',
    };
    return out;
  }

  // ---- evidence bundles
  if (head === 'evidence' && method === 'GET' && second && third) {
    const format = query.get('format') ?? 'json';
    const entityType = second === 'tasks' ? 'review_task' : second === 'runs' ? 'run' : 'rule';
    const sha = fixtureHash(`${second}/${third}/${query.get('as_of') ?? ''}/${state.audit.length}`);
    audit(actor, 'evidence.exported', entityType, third, { format, bundle_sha256: sha, schema: 'backstop.evidence/1', audit_rows: 0 });
    const bundle = { schema: 'backstop.evidence/1', subject: { type: entityType, id: third }, as_of: query.get('as_of'), exported_by: { name: actor, role }, bundle_sha256: sha };
    return format === 'md' ? `# Evidence bundle - ${entityType} ${third}\n\nsha256 ${sha}\n` : bundle;
  }

  // ---- audit
  if (head === 'audit' && method === 'GET' && second === 'verify') {
    return { ok: true, checked: state.audit.length, first_broken_id: null, reason: null, tip: state.audit[state.audit.length - 1]?.row_hash ?? GENESIS };
  }
  if (head === 'audit' && method === 'GET') {
    const entityType = query.get('entity_type');
    const eventType = query.get('event_type');
    const entityId = query.get('entity_id');
    const actorFilter = query.get('actor');
    const correlation = query.get('correlation_id');
    const limit = Number(query.get('limit') ?? 50);
    const offset = Number(query.get('offset') ?? 0);
    const rows = [...state.audit]
      .filter(
        (e) =>
          (!entityType || e.entity_type === entityType) &&
          (!eventType || e.event_type === eventType) &&
          (!entityId || e.entity_id === entityId) &&
          (!actorFilter || e.actor === actorFilter) &&
          (!correlation || e.correlation_id === correlation),
      )
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id));
    const page: Page<AuditOut> = { items: rows.slice(offset, offset + limit), total: rows.length };
    return page;
  }

  throw new ApiError(404, `mock: no route for ${method} /api/${segments.join('/')}`, path);
}

/** Exposed for tests. */
export const __mockState = state;
