import { describe, expect, it } from 'vitest';
import { mockRequest, RUN_IDS } from '../mocks/server';
import type { CompareOut, ContractMetricsOut, ImpactWhatIfOut, ReadinessOut, RuleOut, RuleVersionOut } from '../api/types';
import type { ApiError } from '../api/errors';
import { classifierMetrics, compareRates, fisherExact2x2, fmtP, holm, mcnemarExact, wilsonCi } from '../lib/stats';
import { axisMax, fmtCi, fmtPct, lostToHolm, plainVerdict } from '../lib/significance';
import { appliesLabel, classificationLabel, deferralLine, governs, latestGoverning, statusPresentation, versionStatusAsOf } from '../lib/ruleVersions';
import { countdownLabel, daysLabel, milestoneKindLabel, requiredPace, sortOwners } from '../lib/readiness';
import { auditSummary, eventLabel, eventTone } from '../lib/audit';
import { AUDIT_EVENT_TYPES } from '../lib/vocab';
import { redactionLine } from '../lib/sandbox';

const engineer = { username: 'engineer', password: 'engineer' };

describe('exact statistics (port of backend core/stats.py)', () => {
  it('matches the values the backend pins', () => {
    // backend test: McNemar b=2, c=17 -> p = 0.00073
    expect(mcnemarExact(2, 17).p_value).toBeCloseTo(0.000729, 5);
    expect(fmtP(mcnemarExact(2, 17).p_value)).toBe('0.00073');
    expect(mcnemarExact(0, 0).p_value).toBe(1);
    // scipy.stats.fisher_exact([[1, 9], [11, 3]]) -> 0.0027594
    expect(fisherExact2x2(1, 9, 11, 3).p_value).toBeCloseTo(0.0027594, 6);
    expect(fisherExact2x2(0, 0, 0, 0).p_value).toBe(1);
  });

  it('gives Wilson intervals that behave at the edges', () => {
    const [lo0, hi0] = wilsonCi(0, 10);
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(0.2775, 3);
    const [lo, hi] = wilsonCi(5, 10);
    expect(lo).toBeCloseTo(0.2366, 3);
    expect(hi).toBeCloseTo(0.7634, 3);
    expect(wilsonCi(0, 0)).toEqual([0, 1]);
  });

  it('adjusts with Holm in input order and never below the raw p', () => {
    expect(holm([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    expect(holm([null, 0.2])).toEqual([null, 0.2]);
  });

  it('formats p like Python and phrases verdicts with cautions', () => {
    expect(fmtP(7.3e-5)).toBe('7.3e-05');
    expect(fmtP(0.012)).toBe('0.012');
    expect(fmtP(0.43)).toBe('0.43');
    const few = compareRates(5, 60, 7, 60, { both_pass: 53, a_only_fail: 0, b_only_fail: 2, both_fail: 5 });
    expect(few.direction).toBe('none');
    expect(few.cautions[0]).toMatch(/too few changed calls/);
    const worse = compareRates(2, 60, 19, 60, { both_pass: 41, a_only_fail: 0, b_only_fail: 17, both_fail: 2 });
    expect(worse.direction).toBe('worse');
    expect(worse.verdict).toMatch(/^B is significantly worse/);
  });

  it('computes precision, recall and F1 with intervals; no specificity without true negatives', () => {
    const m = classifierMetrics(8, 2, 4, 40);
    expect(m.recall.rate).toBeCloseTo(8 / 12);
    expect(m.precision.rate).toBeCloseTo(0.8);
    expect(m.f1).toBeCloseTo((2 * 0.8 * (8 / 12)) / (0.8 + 8 / 12));
    expect(m.false_flag_rate?.k).toBe(2);
    expect(classifierMetrics(3, 1, 0, null).specificity).toBeNull();
  });
});

describe('significance wording', () => {
  const row = (over: Partial<Parameters<typeof plainVerdict>[0]>): Parameters<typeof plainVerdict>[0] => ({
    contract_code: 'C-X',
    failure_outcomes: ['FAIL', 'ERROR'],
    n_shared: 60,
    paired: { both_pass: 50, a_only_fail: 1, b_only_fail: 3, both_fail: 6 },
    a: { k: 7, n: 60, rate: 7 / 60, ci_low: 0.06, ci_high: 0.22 },
    b: { k: 9, n: 60, rate: 9 / 60, ci_low: 0.08, ci_high: 0.26 },
    discordant: 4,
    test: 'McNemar exact',
    p_value: 0.625,
    significant: false,
    direction: 'none',
    verdict: 'No significant difference',
    cautions: [],
    ...over,
  });

  it('says noise when it could be noise, and names the Holm loss', () => {
    expect(plainVerdict(row({}))).toBe('B fails more often, but the gap could be noise');
    expect(plainVerdict(row({ paired: { both_pass: 60, a_only_fail: 0, b_only_fail: 0, both_fail: 0 }, discordant: 0 }))).toBe('No call changed outcome');
    const holmLost = row({ direction: 'worse', significant: true, p_value: 0.02, p_holm: 0.14 });
    expect(lostToHolm(holmLost, 0.05)).toBe(true);
    expect(plainVerdict(holmLost, 0.05, 9)).toBe('B fails more often — unlikely to be chance on its own, but not after correcting for 9 contracts');
    expect(plainVerdict(row({ direction: 'better', significant: true, p_value: 0.001, p_holm: 0.009 }))).toBe('B fails less often — unlikely to be chance');
  });

  it('formats rates and picks a shared axis', () => {
    expect(fmtPct(0.4523)).toBe('45%');
    expect(fmtPct(0.045)).toBe('4.5%');
    expect(fmtCi({ ci_low: 0.33, ci_high: 0.57 })).toBe('33–57%');
    expect(axisMax([{ ci_high: 0.23 }, { ci_high: 0.41 }])).toBe(0.5);
    expect(axisMax([{ ci_high: 0.01 }])).toBe(0.1);
  });
});

describe('mock /runs/compare statistics', () => {
  it('leads with ALL-BLOCK, pairs the same calls, and adjusts every contract with Holm', async () => {
    const cmp = (await mockRequest('GET', `/runs/compare?a=${RUN_IDS.ruleFlip}&b=${RUN_IDS.promptV2}`, undefined, engineer)) as CompareOut;
    const st = cmp.statistics;
    expect(st).toBeTruthy();
    if (!st) return;
    expect(st.mode).toBe('paired');
    expect(st.overall.contract_code).toBe('ALL-BLOCK');
    expect(st.overall.paired).not.toBeNull();
    // the v2 prompt fixes the rule-date logic: fewer blocking failures, and the test says so
    expect(st.overall.direction).toBe('better');
    expect(st.per_contract.length).toBeGreaterThan(5);
    for (const r of st.per_contract) expect(r.p_holm ?? 1).toBeGreaterThanOrEqual(r.p_value - 1e-12);
    // development-corpus prompt change: the held-out caution is there
    expect(st.cautions.join(' ')).toMatch(/confirm on the held-out corpus/);
    expect(cmp.failure_definition).toMatch(/a_error\/b_error/);
    expect(cmp.per_contract.every((p) => typeof p.a_error === 'number' && typeof p.b_error === 'number')).toBe(true);
  });
});

describe('mock /contracts/{code}/metrics', () => {
  it('builds a confusion matrix per call for a judgment contract, with every call accounted for', async () => {
    const m = (await mockRequest('GET', `/contracts/C-TPMO-01/metrics?run_id=${RUN_IDS.ruleFlip}`, undefined, engineer)) as ContractMetricsOut;
    expect(m.metric_family).toBe('judgment');
    const run = m.runs[0];
    const c = run.confusion;
    expect(c).not.toBeNull();
    if (!c) return;
    expect(c.unit).toBe('call');
    expect((c.tn ?? 0) + c.tp + c.fp + c.fn + c.not_applicable + c.no_output).toBe(60);
    // prompt v1 still applies the 60-second timer after Oct 1: it false-flags compliant calls
    expect(c.fp).toBeGreaterThan(0);
    expect(run.findings[0]).toMatch(/violations|false flag/);
    expect(run.slices.some((s) => s.dimension === 'scenario')).toBe(true);
    expect(run.slices.some((s) => s.dimension === 'product_line')).toBe(true);
    expect(m.trend.length).toBeGreaterThanOrEqual(4);
  });

  it('has no true negatives for per-phrase flags and no matrix for grounding contracts', async () => {
    const sup = (await mockRequest('GET', '/contracts/C-SUP-01/metrics', undefined, engineer)) as ContractMetricsOut;
    expect(sup.metric_family).toBe('flags');
    expect(sup.runs[0].confusion?.tn).toBeNull();
    const fact = (await mockRequest('GET', '/contracts/C-FACT-01/metrics', undefined, engineer)) as ContractMetricsOut;
    expect(fact.metric_family).toBe('grounding');
    expect(fact.runs[0].confusion).toBeNull();
    // latest COMPLETE run per (model, prompt): three configurations in the seed
    expect(fact.runs).toHaveLength(3);
    const none = await mockRequest('GET', '/contracts/NOPE/metrics', undefined, engineer).catch((e: unknown) => e);
    expect((none as ApiError).status).toBe(404);
  });
});

describe('mock /readiness', () => {
  it('counts down to Oct 1 and AEP, lists what flips, and is honest about vacated and proposed rules', async () => {
    const r = (await mockRequest('GET', '/readiness?as_of=2026-09-25', undefined, engineer)) as ReadinessOut;
    expect(r.burn_down.target).toBe('2026-10-01');
    expect(r.burn_down.days_left).toBe(6);
    expect(r.burn_down.aep).toEqual({ date: '2026-10-15', days_left: 20 });
    expect(r.burn_down.stale_encodings_on_target).toBeGreaterThan(0);
    const kinds = new Set(r.milestones.map((m) => m.kind));
    for (const k of ['marketing_start', 'rule_applies', 'vote', 'deferral_ends', 'aep_start', 'aep_end', 'oep_start']) expect(kinds.has(k), k).toBe(true);
    expect(r.milestones.find((m) => m.kind === 'aep_start')).toMatchObject({ date: '2026-10-15', days_from_as_of: 20 });
    expect(r.milestones.find((m) => m.rule_code === 'agent-broker-compensation')?.label).toBe('agent-broker-compensation v3 applies (restores prior)');
    // bands are disjoint: Oct 1 sits in "30" only
    expect(r.horizon['30'].some((i) => i.applies_from === '2026-10-01' && i.stale_encodings_on_that_date > 0)).toBe(true);
    expect([...r.horizon['60'], ...r.horizon['90']].some((i) => i.applies_from === '2026-10-01')).toBe(false);
    expect(r.vacated.map((v) => `${v.rule_code}@${v.version}`)).toEqual(['agent-broker-compensation@2', 'tcpa-pewc-one-to-one@2']);
    expect(r.vacated[0].source_url).toMatch(/^https:/);
    expect(r.proposed).toContainEqual(expect.objectContaining({ rule_code: 'tcpa-consent-revocation', version: 2, vote_date: '2026-09-30', effective_from: null, origin: 'yaml' }));
    const ranked = sortOwners(r.owners);
    for (let i = 1; i < ranked.length; i += 1) expect(ranked[i - 1].oldest_days ?? -1).toBeGreaterThanOrEqual(ranked[i].oldest_days ?? -1);
    expect(r.burn_down.note).toMatch(/no trend line/);
  });

  it('never puts a vacated, stayed or proposed version in force', async () => {
    const abc = (await mockRequest('GET', '/rules/agent-broker-compensation', undefined, engineer)) as RuleOut;
    expect(abc.versions.find((v) => v.version === 2)?.status).toBe('vacated');
    // the one-to-one amendment (v2) was vacated before it took effect: v1 still governs, on any date
    const oneToOne = (await mockRequest('GET', '/rules/tcpa-pewc-one-to-one/impact?as_of=2026-09-25', undefined, engineer)) as { in_force_version: number | null };
    expect(oneToOne.in_force_version).toBe(1);
    const revocation = (await mockRequest('GET', '/rules/tcpa-consent-revocation', undefined, engineer)) as RuleOut;
    expect(revocation.in_force_version).toBe(1);
    // a proposal still awaiting its vote has no date: the what-if assumes it applies from as_of, and says so
    const whatIf = (await mockRequest('GET', '/rules/tcpa-consent-revocation/impact?as_of=2026-10-01&assume_version=2', undefined, engineer)) as ImpactWhatIfOut;
    expect(whatIf.hypothetical).toBe(true);
    expect(whatIf.in_force_version).toBe(2);
    expect(whatIf.note).toMatch(/no effective date yet, vote 2026-09-30; assumed from 2026-10-01/);
  });
});

describe('rule version vocabulary', () => {
  const base: RuleVersionOut = {
    id: 'x', version: 2, status: 'vacated', clause_text: '', summary: '', effective_from: '2024-10-01', effective_to: null,
    change_classification: 'TIGHTENS', params: {}, disputed: false, dispute_note: '', source_url: '', git_commit: '', created_at: '',
  };

  it('keeps vacated, stayed and proposed versions out of force and says why', () => {
    expect(governs(base)).toBe(false);
    expect(governs({ ...base, status: 'in_force' })).toBe(true);
    expect(governs({ ...base, status: 'in_force', effective_from: null })).toBe(false);
    expect(versionStatusAsOf(base, '2026-10-01', 2)).toBe('vacated');
    expect(statusPresentation(base)).toMatchObject({ tone: 'slate', strike: true });
    expect(statusPresentation({ ...base, status: 'stayed' }).tone).toBe('amber');
    expect(statusPresentation({ ...base, status: 'proposed', vote_date: '2026-09-30' })).toMatchObject({ dashed: true, note: 'Not law yet — vote on Sep 30, 2026.' });
    expect(latestGoverning({ versions: [{ ...base, version: 1, status: 'in_force', effective_from: '2022-10-01' }, base] })?.version).toBe(1);
  });

  it('labels an undated proposal by its vote, deferrals by their new date, and RESTORES_PRIOR in words', () => {
    expect(appliesLabel({ effective_from: null, vote_date: '2026-09-30' })).toBe('awaiting vote Sep 30, 2026');
    expect(appliesLabel({ effective_from: null, vote_date: null })).toBe('no date yet');
    expect(deferralLine({ provision: 'revoke-all', deferred_to: '2027-01-31', source: 'FCC' })).toBe('revoke-all deferred to Jan 31, 2027');
    expect(deferralLine({ provision: 'Revoke-all: a revocation made in response to one type of message applies to all', deferred_to: '2027-01-31', source: '' })).toBe('Revoke-all deferred to Jan 31, 2027');
    expect(classificationLabel('RESTORES_PRIOR')).toBe('RESTORES PRIOR');
  });
});

describe('readiness wording', () => {
  it('counts down in words and works out the pace', () => {
    expect(countdownLabel(0)).toBe('today');
    expect(countdownLabel(6)).toBe('in 6 days');
    expect(countdownLabel(-2)).toBe('2 days ago');
    expect(milestoneKindLabel('deferral_ends')).toBe('deferral ends');
    expect(milestoneKindLabel('aep_start')).toBe('AEP opens');
    expect(daysLabel(0)).toBe('<1 day');
    expect(daysLabel(0.4)).toBe('<1 day');
    expect(daysLabel(3.26)).toBe('3.3 days');
    expect(milestoneKindLabel('some_new_kind')).toBe('some new kind');
    expect(requiredPace(19, 6)).toBe(3.2);
    expect(requiredPace(0, 6)).toBeNull();
    expect(requiredPace(4, 0)).toBeNull();
  });
});

describe('audit vocabulary covers every backend event type', () => {
  // backend/backstop/core/audit.py EVENT_TYPES
  const BACKEND = [
    'rules.reloaded', 'rule.version_created', 'rule.version_closed', 'rule.version_annotated', 'rule.proposal_renumbered', 'contract.version_created',
    'rule.source_checked', 'export.generated', 'evidence.exported', 'ingest.completed', 'scan.started', 'scan.completed',
    'artifact.content_changed', 'artifact.unchanged', 'artifact.fetch_error', 'edge.confirmed', 'edge.proposed', 'edge.rejected',
    'edge.superseded', 'edge.restored', 'staleness.evaluated', 'task.opened', 'task.transitioned', 'task.transition_rejected',
    'run.started', 'run.completed', 'run.failed', 'run.deduplicated', 'run.egress_refused', 'test_case.created',
    'test_case.approved', 'auth.denied', 'sandbox.artifact_checked', 'sandbox.transcript_checked',
  ];

  it('has a label, a tone and a filter entry for each', () => {
    for (const t of BACKEND) {
      expect(AUDIT_EVENT_TYPES).toContain(t);
      // a labelled type never falls back to the neutral "unknown" tone
      expect(eventTone({ event_type: t, payload: { gate: 'GREEN' } }), t).not.toBe('neutral');
    }
    expect(eventLabel('rule.proposal_renumbered')).toBe('Proposal renumbered');
    expect(eventLabel('sandbox.artifact_checked')).toBe('Sandbox text checked');
    expect(eventTone({ event_type: 'run.egress_refused', payload: {} })).toBe('red');
  });

  it('summarises the new events in one line', () => {
    const row = (event_type: string, payload: Record<string, unknown>) => ({ id: 1, ts: '', actor: 'system:rules-loader', event_type, entity_type: 'rule_version', entity_id: 'x', payload });
    expect(auditSummary(row('rule.proposal_renumbered', { rule: 'tcpa-consent-revocation', from_version: 2, to_version: 3, reason: 'tcpa-consent-revocation.yaml defines v2', yaml_matches_proposal: false }))).toBe(
      'tcpa-consent-revocation proposal v2 → v3 · tcpa-consent-revocation.yaml defines v2 · enacted text differs from the proposal',
    );
    expect(auditSummary(row('contract.version_created', { contract: 'C-TPMO-01', version: 3, previous_version: 2, changed: ['spec', 'title'], source: 'contracts.yaml' }))).toBe(
      'C-TPMO-01 v2 → v3 · changed spec, title · contracts.yaml',
    );
    expect(auditSummary(row('rule.version_annotated', { rule: 'tcpa-consent-revocation', version: 1, after: { vote_date: null, deferrals: [{}] }, source: 'tcpa-consent-revocation.yaml' }))).toBe(
      'tcpa-consent-revocation v1 · 1 deferral · text unchanged · tcpa-consent-revocation.yaml',
    );
    expect(auditSummary(row('sandbox.artifact_checked', { text_sha256: 'abcdef0123456789', matches: 2, stale: 1, as_of: '2026-10-01' }))).toBe(
      '2 matches · 1 stale · as of 2026-10-01 · sha256 abcdef0123… · text not stored',
    );
  });
});

describe('sandbox redaction line', () => {
  it('names the new contact-detail kinds and skips zeros', () => {
    expect(redactionLine({ medicare_number: 0, ssn: 0, dob: 0, phone: 1, email: 2, address: 0 })).toBe('1 phone number · 2 email addresses');
  });
});
