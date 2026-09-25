import { describe, expect, it } from 'vitest';
import { mockRequest, RUN_IDS } from '../mocks/server';
import type {
  CompareOut,
  HealthDeepOut,
  ImpactOut,
  ImpactWhatIfOut,
  MatcherEvalOut,
  PromptDiffOut,
  ReviewTaskOut,
  RuleSourceOut,
  RunOut,
  RunResultOut,
  RunTranscriptOut,
  RuleOut,
  RuleVersionOut,
  TestCaseOut,
  TranscriptOut,
  WorkflowOut,
} from '../api/types';
import { ApiError } from '../api/errors';
import { runStats } from '../lib/runStats';
import { evidenceFamily } from '../lib/evidence';

const analyst = { username: 'analyst', password: 'analyst' };
const engineer = { username: 'engineer', password: 'engineer' };
const admin = { username: 'admin', password: 'admin' };

describe('mock server fixtures (shapes mirror the live API)', () => {
  it('rejects bad credentials with 401 but serves /health/deep without auth', async () => {
    const err = await mockRequest('GET', '/meta', undefined, { username: 'x', password: 'y' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    const health = (await mockRequest('GET', '/health/deep', undefined, null)) as HealthDeepOut;
    expect(health.ready).toBe(true);
    expect(health.rules).toBeGreaterThan(0);
  });

  it('tells the Oct 1 story: same prompt is GREEN on Sept 30 and RED on Oct 1; prompt v2 is GREEN; model swap is RED', async () => {
    const runs = (await mockRequest('GET', '/runs', undefined, analyst)) as RunOut[];
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get(RUN_IDS.baseline)?.gate).toBe('GREEN');
    expect(byId.get(RUN_IDS.ruleFlip)?.gate).toBe('RED');
    expect(byId.get(RUN_IDS.promptV2)?.gate).toBe('GREEN');
    expect(byId.get(RUN_IDS.modelSwap)?.gate).toBe('RED');

    // run.stats carries the live shape: contracts map, logic, latency, judge_stability, cost
    const s = runStats(byId.get(RUN_IDS.modelSwap));
    expect(s.contracts?.['C-FACT-01']?.FAIL).toBe(3);
    expect(s.judge_stability?.notes).toHaveLength(6);
    expect(s.judge_stability?.stable).toBe(false);
    expect(s.cost?.basis).toContain('cassette');
    expect(s.latency_ms_per_transcript).toBeGreaterThan(0);
    const flip = runStats(byId.get(RUN_IDS.ruleFlip));
    expect(flip.logic_in_force?.disclaimer_basis).toBe('ordering');
    expect(flip.logic_declared_by_prompt?.disclaimer_basis).toBe('timer');

    const promptChange = (await mockRequest('GET', `/runs/compare?a=${RUN_IDS.ruleFlip}&b=${RUN_IDS.promptV2}`, undefined, analyst)) as CompareOut;
    expect(promptChange.what_changed).toEqual({
      prompt: true,
      model: false,
      rule_date: false,
      adapter: false,
      corpus: false,
      cells_only_in_a: 0,
      cells_only_in_b: 0,
      contract_set: false,
    });
    expect(promptChange.newly_failing).toHaveLength(0);
    expect(promptChange.newly_passing.length).toBeGreaterThanOrEqual(10);
    expect(promptChange.per_contract[0]).toMatchObject({ contract_code: expect.any(String), a_fail: expect.any(Number), b_fail: expect.any(Number) });

    const modelChange = (await mockRequest('GET', `/runs/compare?a=${RUN_IDS.promptV2}&b=${RUN_IDS.modelSwap}`, undefined, analyst)) as CompareOut;
    expect(modelChange.what_changed.model).toBe(true);
    expect(modelChange.what_changed.adapter).toBe(true);
    expect(modelChange.newly_failing.filter((c) => c.contract_code === 'C-FACT-01')).toHaveLength(3);
  });

  it('writes the live evidence keys per contract family', async () => {
    const results = (await mockRequest('GET', `/runs/${RUN_IDS.modelSwap}/results?outcome=FAIL`, undefined, analyst)) as RunResultOut[];
    const fact = results.find((r) => r.contract_code === 'C-FACT-01');
    expect(fact?.evidence.invented_figures).toHaveLength(1);
    expect(evidenceFamily('C-FACT-01', fact?.evidence ?? {})).toBe('fact');
    const span = results.find((r) => r.contract_code === 'C-SPAN-01');
    expect(Object.keys((span?.evidence.not_in_transcript as Record<string, string>) ?? {})).toContain('benefits_span');
    const pii = results.find((r) => r.contract_code === 'C-PII-01');
    expect(evidenceFamily('C-PII-01', pii?.evidence ?? {})).toBe('pii');

    const flip = (await mockRequest('GET', `/runs/${RUN_IDS.ruleFlip}/results?outcome=FAIL&contract=C-TPMO-01`, undefined, analyst)) as RunResultOut[];
    expect(flip.length).toBeGreaterThan(0);
    // prompt v1 applied the 60s timer on Oct 1: some calls are falsely flagged (over-restrictive), some violations missed (under-restrictive)
    const falseFlag = flip.find((r) => r.evidence.got === false);
    expect(falseFlag?.evidence).toMatchObject({ expected: true, got: false, truth_basis: expect.stringContaining('ordering'), model_basis: expect.stringContaining('timer'), direction: expect.stringContaining('over_restrictive') });
    expect(flip.some((r) => typeof r.evidence.direction === 'string' && r.evidence.direction.startsWith('under_restrictive'))).toBe(true);

    const rt = (await mockRequest('GET', `/runs/${RUN_IDS.modelSwap}/transcripts/T018`, undefined, analyst)) as RunTranscriptOut;
    expect(rt.output.extraction).toMatchObject({ disclaimer_compliant: expect.any(Boolean), disclaimer_basis: expect.any(String), soa_wait_compliant: expect.any(Boolean) });
    expect(rt.spans.some((s) => !s.verified && s.offset === -1)).toBe(true);
    expect(rt.transcript.text?.startsWith('[00:00] AGENT:')).toBe(true);
  });

  it('computes the SOA blast radius with artifact and encoding counts and the live prompt_versions shape', async () => {
    const before = (await mockRequest('GET', '/rules/soa-48h-wait/impact?as_of=2026-09-30', undefined, analyst)) as ImpactOut;
    expect(before.in_force_version).toBe(1);
    expect(before.counts.over_restrictive).toBe(0);
    const after = (await mockRequest('GET', '/rules/soa-48h-wait/impact?as_of=2026-10-01', undefined, analyst)) as ImpactOut;
    expect(after.in_force_version).toBe(2);
    expect(after.counts.total).toBe(7);
    expect(after.counts.artifacts).toBe(6);
    expect(after.counts.over_restrictive).toBe(5);
    expect(after.counts.reverify).toBe(2);
    expect(after.stale.every((s) => s.task_id !== null)).toBe(true);
    expect(after.prompt_versions).toHaveLength(2);
    expect(after.prompt_versions[0]).toMatchObject({ workflow: 'qa-handoff', version: 1, declared_version: 1, stale: true });
    expect(after.prompt_versions[1]).toMatchObject({ version: 2, declared_version: 2, stale: false });

    const sources = (await mockRequest('GET', '/rules/soa-48h-wait/sources', undefined, analyst)) as RuleSourceOut[];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0].checked_at >= sources[sources.length - 1].checked_at).toBe(true);
  });

  it('diffs two prompt versions with their declared rule dependencies', async () => {
    const wf = (await mockRequest('GET', '/workflows/qa-handoff', undefined, analyst)) as WorkflowOut;
    expect(wf.prompt_versions[0].encodes_rule_versions[0]).toEqual({ rule: 'tpmo-disclaimer-timing', version: 1 });
    const diff = (await mockRequest('GET', `/prompts/diff?a=${wf.prompt_versions[0].id}&b=${wf.prompt_versions[1].id}`, undefined, analyst)) as PromptDiffOut;
    expect(diff.unified_diff[0]).toMatch(/^--- v1/);
    expect(diff.unified_diff.some((l) => l.startsWith('+'))).toBe(true);
    expect(diff.rule_dependencies.removed).toContainEqual({ rule: 'soa-48h-wait', version: 1 });
    expect(diff.rule_dependencies.added).toContainEqual({ rule: 'soa-48h-wait', version: 2 });
  });

  it('refuses illegal transitions with 409 and forbidden roles with 403, and creates a test case on override', async () => {
    const tasks = (await mockRequest('GET', '/review?kind=STALE_ASSET&state=republished', undefined, analyst)) as ReviewTaskOut[];
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0].payload).toMatchObject({ rule: expect.any(String), bound_version: 1, in_force_version: 2, as_of: '2026-10-01' });
    const illegal = await mockRequest('POST', `/review/${tasks[0].id}/transition`, { to: 'in_review', note: '' }, analyst).catch((e: unknown) => e);
    expect((illegal as ApiError).status).toBe(409);

    const verified = (await mockRequest('GET', '/review?state=verified', undefined, analyst)) as ReviewTaskOut[];
    expect(verified[0].allowed_transitions).toEqual([]); // analyst may not republish
    const forbidden = await mockRequest('POST', `/review/${verified[0].id}/transition`, { to: 'republished', note: '' }, analyst).catch((e: unknown) => e);
    expect((forbidden as ApiError).status).toBe(403);

    const sourceTasks = (await mockRequest('GET', '/review?kind=RULE_SOURCE_CHANGED', undefined, analyst)) as ReviewTaskOut[];
    expect(sourceTasks).toHaveLength(1);
    expect(sourceTasks[0].allowed_transitions).toEqual(['dismissed', 'in_review']);
    expect(sourceTasks[0].payload).toMatchObject({ source_url: expect.any(String), previous_hash: expect.any(String), new_hash: expect.any(String), excerpt: expect.any(String) });

    const flagged = (await mockRequest('GET', '/review?kind=FLAGGED_RESULT&state=open', undefined, engineer)) as ReviewTaskOut[];
    expect(flagged.some((t) => t.payload.aggregate === true && Array.isArray(t.payload.flagged_transcripts))).toBe(true);
    const target = flagged.find((t) => t.allowed_transitions.includes('overridden') && t.payload.aggregate !== true);
    expect(target).toBeDefined();
    const missingReason = await mockRequest('POST', `/review/${target?.id}/transition`, { to: 'overridden', note: 'x' }, engineer).catch((e: unknown) => e);
    expect((missingReason as ApiError).status).toBe(422);
    const overridden = (await mockRequest('POST', `/review/${target?.id}/transition`, { to: 'overridden', reason_code: 'FALSE_POSITIVE_JUDGE', note: 'judge variance' }, engineer)) as ReviewTaskOut;
    expect(overridden.state).toBe('overridden');
    expect(typeof overridden.payload.test_case_id).toBe('string');
    const tcs = (await mockRequest('GET', '/test-cases', undefined, engineer)) as TestCaseOut[];
    const tc = tcs.find((t) => t.id === overridden.payload.test_case_id);
    expect(tc?.status).toBe('PENDING_APPROVAL');
    const self = await mockRequest('POST', `/test-cases/${tc?.id}/approve`, {}, engineer).catch((e: unknown) => e);
    expect((self as ApiError).status).toBe(409);
    const approved = (await mockRequest('POST', `/test-cases/${tc?.id}/approve`, {}, admin)) as TestCaseOut;
    expect(approved.status).toBe('APPROVED');
    expect(approved.approver).toBe('admin');
  });

  it('records a proposal from an engineer (never law), refuses it from an analyst, and shows it only as a what-if', async () => {
    const body = { clause_text: 'SOA must be documented at least 24 hours before the appointment.', effective_from: '2027-01-01', change_classification: 'TIGHTENS', params: { min_hours_between_soa_and_appointment: 24 } };
    const denied = await mockRequest('POST', '/rules/soa-48h-wait/versions', body, analyst).catch((e: unknown) => e);
    expect((denied as ApiError).status).toBe(403);
    // the API records proposals only: any other status is refused with the ADR-001 reason
    const enact = await mockRequest('POST', '/rules/soa-48h-wait/versions', { ...body, status: 'in_force' }, engineer).catch((e: unknown) => e);
    expect((enact as ApiError).status).toBe(422);
    expect((enact as ApiError).message).toMatch(/reviewed YAML in git/);
    const created = (await mockRequest('POST', '/rules/soa-48h-wait/versions', body, engineer)) as RuleVersionOut;
    expect(created.version).toBe(3);
    expect(created.status).toBe('proposed');
    const again = await mockRequest('POST', '/rules/soa-48h-wait/versions', body, engineer).catch((e: unknown) => e);
    expect((again as ApiError).status).toBe(409);
    // the enacted history is untouched: v2 stays in force, its window stays open
    const impact = (await mockRequest('GET', '/rules/soa-48h-wait/impact?as_of=2027-01-01', undefined, engineer)) as ImpactOut;
    expect(impact.in_force_version).toBe(2);
    const rule = (await mockRequest('GET', '/rules/soa-48h-wait', undefined, engineer)) as RuleOut;
    expect(rule.versions.find((v) => v.version === 2)?.effective_to).toBeNull();
    // the what-if evaluates as if v3 were enacted, and says so
    const whatIf = (await mockRequest('GET', '/rules/soa-48h-wait/impact?as_of=2027-01-01&include_proposed=true&assume_version=3', undefined, engineer)) as ImpactWhatIfOut;
    expect(whatIf.hypothetical).toBe(true);
    expect(whatIf.assumed_version).toBe(3);
    expect(whatIf.in_force_version).toBe(3);
    expect(whatIf.stale.some((s) => s.bound_version === 2 && s.direction === 'under_restrictive')).toBe(true);
    expect(whatIf.stale.every((s) => s.task_id === null)).toBe(true);
    expect(whatIf.note).toMatch(/nothing was written/);
    const missing = await mockRequest('GET', '/rules/soa-48h-wait/impact?as_of=2027-01-01&assume_version=9', undefined, engineer).catch((e: unknown) => e);
    expect((missing as ApiError).status).toBe(404);
  });

  it('deduplicates scans and runs on identical inputs; ingested corpus reports ERROR for rule contracts', async () => {
    const first = (await mockRequest('POST', '/scans', { idempotency_key: 'test-manual' }, engineer)) as { id: string; deduplicated: boolean; stats: Record<string, unknown> };
    const second = (await mockRequest('POST', '/scans', { idempotency_key: 'test-manual' }, engineer)) as { id: string; deduplicated: boolean };
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
    expect(first.stats).toMatchObject({ artifacts: expect.any(Number), edges_new: expect.any(Number), proposed_new: expect.any(Number), mode: 'snapshot' });

    const dup = (await mockRequest('POST', '/runs', { workflow: 'qa-handoff', prompt_version: 2, model_id: 'sim-large', adapter: 'simulated', rule_date: '2026-10-01', trigger: 'MANUAL' }, engineer)) as RunOut;
    expect(dup.deduplicated).toBe(true);
    expect(dup.id).toBe(RUN_IDS.promptV2);

    const ingested = (await mockRequest('POST', '/runs', { workflow: 'qa-handoff', prompt_version: 2, model_id: 'sim-large', adapter: 'simulated', rule_date: '2026-10-01', trigger: 'MANUAL', corpus: 'ingested' }, engineer)) as RunOut;
    expect(ingested.deduplicated).toBe(false);
    expect(ingested.stats.transcripts).toBe(2);
    const tpmo = ingested.contracts.find((c) => c.code === 'C-TPMO-01');
    expect(tpmo?.errored).toBe(2);
    const rows = (await mockRequest('GET', `/runs/${ingested.id}/results?contract=C-TPMO-01`, undefined, engineer)) as RunResultOut[];
    expect(rows[0].evidence).toMatchObject({ error: expect.any(String) });
    expect('model_says' in rows[0].evidence).toBe(true);
  });

  it('marks every run with its corpus and compares only the cells both runs scored', async () => {
    const runs = (await mockRequest('GET', '/runs', undefined, analyst)) as RunOut[];
    const seeded = runs.find((r) => r.id === RUN_IDS.promptV2);
    expect(seeded?.corpus).toBe('synthetic');
    expect(seeded?.stats.corpus).toBe('synthetic');

    const ingested = (await mockRequest('POST', '/runs', { workflow: 'qa-handoff', prompt_version: 1, model_id: 'sim-large', adapter: 'simulated', rule_date: '2026-10-01', trigger: 'MANUAL', corpus: 'ingested' }, engineer)) as RunOut;
    expect(ingested.corpus).toBe('ingested');
    const cmp = (await mockRequest('GET', `/runs/compare?a=${RUN_IDS.promptV2}&b=${ingested.id}`, undefined, analyst)) as CompareOut;
    expect(cmp.what_changed.corpus).toBe(true);
    expect(cmp.what_changed.cells_only_in_a).toBe(480);
    expect(cmp.what_changed.cells_only_in_b).toBe(16);
    expect(cmp.newly_failing).toHaveLength(0);
    expect(cmp.newly_passing).toHaveLength(0);
    expect(cmp.per_contract.every((p) => p.a_fail === 0 && p.b_fail === 0)).toBe(true);
  });

  it('keeps held-out calls out of the transcript list and refuses a held-out run it cannot replay', async () => {
    const dev = (await mockRequest('GET', '/transcripts?limit=500', undefined, analyst)) as TranscriptOut[];
    expect(dev.some((t) => t.code.startsWith('H'))).toBe(false);
    expect(dev.filter((t) => t.synthetic)).toHaveLength(60);
    const holdout = (await mockRequest('GET', '/transcripts?corpus=holdout', undefined, analyst)) as TranscriptOut[];
    expect(holdout).toHaveLength(0);
    const health = (await mockRequest('GET', '/health/deep', undefined, null)) as HealthDeepOut;
    expect(health.holdout_transcripts).toBe(0);
    const err = await mockRequest('POST', '/runs', { prompt_version: 2, model_id: 'sim-large', adapter: 'simulated', rule_date: '2026-10-01', corpus: 'holdout' }, engineer).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(422);
  });

  it('mirrors the rule YAML wording: no quoted secondary source, the corrected dispute note', async () => {
    const rules = (await mockRequest('GET', '/rules', undefined, analyst)) as RuleOut[];
    const text = JSON.stringify(rules);
    expect(text).not.toMatch(/srbenefit/i);
    const clause = (code: string, version: number) => rules.find((r) => r.code === code)?.versions.find((v) => v.version === version)?.clause_text ?? '';
    expect(clause('soa-48h-wait', 2)).toMatch(/^\[Paraphrase of the CY2027 final rule per Crowell & Moring \(secondary\)/);
    expect(clause('superlatives', 2)).toMatch(/^\[Paraphrase of the CY2027 final rule per Crowell & Moring \(secondary\)/);
    for (const c of [clause('soa-48h-wait', 2), clause('superlatives', 2)]) expect(c).not.toContain('"');
    const retention = rules.find((r) => r.code === 'call-recording-retention')?.versions.find((v) => v.version === 2);
    expect(retention?.disputed).toBe(true);
    expect(retention?.dispute_note).toMatch(/^The CY2027 text drops "enrollment"/);
    expect(retention?.dispute_note).toContain('Correction 2026-09-23');
  });

  it('serves evals, ingest formats and exports', async () => {
    const evals = (await mockRequest('GET', '/evals/matchers', undefined, analyst)) as MatcherEvalOut;
    expect(evals.summary.cases).toBe(evals.cases.length);
    expect(evals.summary.precision).toBe(1);
    expect(Object.keys(evals.per_rule)).toContain('soa-48h-wait');
    const md = (await mockRequest('GET', '/evals/matchers.md', undefined, analyst)) as string;
    expect(md.startsWith('# Matcher evaluation report')).toBe(true);
    const formats = (await mockRequest('GET', '/ingest/formats', undefined, analyst)) as Record<string, { columns: Record<string, string> }>;
    expect(formats['attention-snowflake'].columns.call_id).toBeDefined();
    const csv = (await mockRequest('GET', `/runs/${RUN_IDS.baseline}/export?format=csv`, undefined, analyst)) as string;
    expect(csv.split('\n')[0]).toBe('run_id,transcript_code,contract_code,severity,outcome,latency_ms,evidence');
    const bt = (await mockRequest('GET', `/runs/${RUN_IDS.baseline}/export?format=braintrust`, undefined, analyst)) as { format: string; records: unknown[] };
    expect(bt.format).toBe('braintrust');
    expect(bt.records.length).toBe(480);
  });
});
