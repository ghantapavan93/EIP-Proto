import type {
  ContractSummary,
  JsonObject,
  JudgeStability,
  RunCorpus,
  RunOut,
  RunResultOut,
  RunStats,
  RunTranscriptOut,
  SpanOut,
} from '../api/types';
import {
  buildTranscript,
  INGESTED,
  ingestedOut,
  prng,
  SCENARIOS,
  transcriptOut,
  type IngestedSample,
  type Scenario,
} from './corpus';
import { CONTRACTS } from './registry';

/**
 * Deterministic replay harness for the mock. Given (prompt version, model,
 * rule date) it produces the workflow output for every transcript and judges
 * each contract against ground truth derived from the scenario, writing the
 * same evidence keys the live backend writes. The point of the fixture: the
 * same prompt can be right on Sept 30 and wrong on Oct 1.
 */

export const RULE_FLIP = '2026-10-01';

export interface RunParams {
  promptVersion: number;
  modelId: string;
  ruleDate: string;
  corpus?: RunCorpus;
}

interface RuleLogic {
  disclaimer_basis: 'timer' | 'ordering';
  disclaimer_window_seconds: number;
  soa_min_hours: number;
  superlatives_substantiation_required: boolean;
}

export function logicFor(ruleDate: string): RuleLogic {
  const after = ruleDate >= RULE_FLIP;
  return {
    disclaimer_basis: after ? 'ordering' : 'timer',
    disclaimer_window_seconds: after ? 0 : 60,
    soa_min_hours: after ? 0 : 48,
    superlatives_substantiation_required: !after,
  };
}

/** What the prompt version tells the model to believe. */
export function logicForPrompt(promptVersion: number): RuleLogic {
  return promptVersion >= 2 ? logicFor(RULE_FLIP) : logicFor('2026-09-30');
}

// model quirks (sim-small only)
const HALLUCINATED_FIGURE = new Set([8, 20, 57]);
const PARAPHRASED_SPAN = new Set([18, 23, 35, 44, 49]);
const PII_LEAK = new Set([51]);
const WEAK_COACHING = new Set([1, 3, 4, 15, 16, 18, 19, 23, 24, 38, 41, 42, 43, 46, 47, 50, 52, 53, 54, 58]);

function span(text: string, label: string, haystack: string, verified = true): SpanOut {
  const offset = verified ? haystack.indexOf(text) : -1;
  return { label, text, offset, length: text.length, verified: verified && offset >= 0 };
}

function basisText(logic: RuleLogic, disclaimerAt: number | null, benefitsAt: number): string {
  if (disclaimerAt === null) return `${logic.disclaimer_basis}: disclaimer not delivered`;
  return logic.disclaimer_basis === 'timer'
    ? `timer: delivered at ${disclaimerAt}s, window ${logic.disclaimer_window_seconds}s`
    : `ordering: delivered at ${disclaimerAt}s, benefits at ${benefitsAt}s`;
}

export interface TranscriptEvaluation {
  output: JsonObject;
  route: string;
  spans: SpanOut[];
  results: Array<Omit<RunResultOut, 'id'>>;
  latency_ms: number;
  usage: JsonObject;
  error: string | null;
}

function pushResult(
  results: Array<Omit<RunResultOut, 'id'>>,
  code: string,
  transcriptCode: string,
  outcome: string,
  evidence: JsonObject,
  latency: number,
): void {
  const contract = CONTRACTS.find((c) => c.code === code);
  results.push({
    transcript_code: transcriptCode,
    contract_code: code,
    severity: contract?.severity ?? 'BLOCK',
    outcome,
    evidence,
    latency_ms: latency,
  });
}

export function evaluateTranscript(sc: Scenario, params: RunParams): TranscriptEvaluation {
  const small = params.modelId === 'sim-small';
  const truth = logicFor(params.ruleDate);
  const belief = logicForPrompt(params.promptVersion);
  const built = buildTranscript(sc);
  const text = built.text;
  const rand = prng(500 + sc.index * 31 + (small ? 7 : 0) + params.promptVersion * 3);
  const latency = small ? 380 + Math.floor(rand() * 200) : 910 + Math.floor(rand() * 400);
  const medigap = sc.product_line === 'MEDIGAP';

  // ---- disclaimer judgment ------------------------------------------------
  const delivered = sc.disclaimerAt !== null;
  const timerOk = delivered && (sc.disclaimerAt as number) <= 60;
  const orderingOk = delivered && (sc.disclaimerAt as number) < sc.benefitsAt;
  const gotTpmo = medigap || (belief.disclaimer_basis === 'timer' ? timerOk : orderingOk);
  const expTpmo = medigap || (truth.disclaimer_basis === 'timer' ? timerOk : orderingOk);

  // ---- SOA judgment -------------------------------------------------------
  const soaOk = (minHours: number) => medigap || sc.soaException !== null || sc.soaHours >= minHours;
  const gotSoa = soaOk(belief.soa_min_hours);
  const expSoa = soaOk(truth.soa_min_hours);

  // ---- superlatives -------------------------------------------------------
  const supText = `the best plan`;
  const gotFlags = !medigap && belief.superlatives_substantiation_required && sc.superlative ? [supText] : [];
  const expFlags = !medigap && truth.superlatives_substantiation_required && sc.superlative ? [supText] : [];

  // ---- model quirks -------------------------------------------------------
  const hallucinate = small && HALLUCINATED_FIGURE.has(sc.index);
  const paraphrase = small && PARAPHRASED_SPAN.has(sc.index);
  const leak = small && PII_LEAK.has(sc.index) && sc.mbiReadBack;
  const weak = small && WEAK_COACHING.has(sc.index);

  const invented = hallucinate ? `$${Number(sc.moop) + 10}` : null;
  const benefitsSpan = paraphrase
    ? built.sentences.benefits.replace('monthly premium', 'premium per month')
    : built.sentences.benefits;

  // ---- spans --------------------------------------------------------------
  const spans: SpanOut[] = [];
  if (built.sentences.disclaimer) spans.push(span(built.sentences.disclaimer, 'disclaimer_span', text));
  spans.push(span(benefitsSpan, 'benefits_span', text, !paraphrase));
  spans.push(span(built.sentences.soa, 'soa_span', text));

  // ---- composition --------------------------------------------------------
  const clock = (s: number | null) => (s === null ? 'never' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  const coachingNote = weak
    ? 'Good call overall. Keep it up and remember compliance.'
    : !gotTpmo
      ? belief.disclaimer_basis === 'timer'
        ? `The TPMO disclaimer landed at ${clock(sc.disclaimerAt)}, outside the first minute. Open with it right after the recording notice, before the ZIP code question.`
        : `Benefits discussion started at ${clock(sc.benefitsAt)} but the disclaimer was delivered at ${clock(sc.disclaimerAt)}. Deliver the disclaimer before you describe any plan benefit.`
      : !gotSoa
        ? `The appointment ran ${sc.soaHours} hours after the Scope of Appointment with no stated exception. Confirm the SOA timing before discussing plans.`
        : gotFlags.length
          ? `You said "the best plan in ${sc.county} County" without citing data. Describe the benefit — network, premium, MOOP — instead of the ranking.`
          : `Clean call: disclaimer at ${clock(sc.disclaimerAt)}, SOA on file ${sc.soaHours} hours ahead, premium quoted verbatim. Next step: confirm the cardiologist's network status in writing.`;

  const route = !gotTpmo || !gotSoa ? 'BLOCK' : gotFlags.length ? 'FLAG' : 'PASS';

  const extraction: JsonObject = {
    product_line: sc.product_line,
    carrier: sc.carrier,
    disclaimer_delivered: delivered,
    disclaimer_seconds: sc.disclaimerAt,
    disclaimer_span: built.sentences.disclaimer,
    benefits_started_seconds: sc.benefitsAt,
    benefits_span: benefitsSpan,
    disclaimer_compliant: gotTpmo,
    disclaimer_basis: medigap ? 'n/a: Medigap' : basisText(belief, sc.disclaimerAt, sc.benefitsAt),
    soa_collected: true,
    soa_span: built.sentences.soa,
    appointment_scheduled: true,
    appointment_hours_after_soa: sc.soaHours,
    soa_exception: sc.soaException,
    soa_wait_compliant: gotSoa,
    superlatives: sc.superlative ? [{ text: `the best plan in ${sc.county} County`, flagged: gotFlags.length > 0 }] : [],
    numeric_claims: [
      { value: `$${sc.premium}`, context: 'monthly premium' },
      { value: `$${sc.deductible}`, context: 'drug deductible' },
      { value: invented ?? `$${sc.moop}`, context: 'maximum out-of-pocket' },
    ],
    pii_detected: sc.mbiReadBack ? ['medicare_number'] : [],
  };

  const output: JsonObject = {
    extraction,
    composition: {
      summary: `${sc.customer} (${sc.product_line}) discussed the ${sc.carrier} plan with ${sc.agent}. Premium $${sc.premium}/month, drug deductible $${sc.deductible}, maximum out-of-pocket ${invented ?? `$${sc.moop}`}. TPMO disclaimer at ${clock(sc.disclaimerAt)}; SOA documented ${sc.soaHours}h before the appointment${sc.soaException ? ` (${sc.soaException.replace('_', ' ')} exception)` : ''}.`,
      coaching_note: coachingNote,
      crm_record: {
        customer: sc.customer,
        product_line: sc.product_line,
        carrier: sc.carrier,
        quoted_premium: `$${sc.premium}`,
        max_out_of_pocket: invented ?? `$${sc.moop}`,
        soa_on_file: true,
        soa_hours_before_appointment: sc.soaHours,
        medicare_number: leak ? '1EG4-TE5-MK73' : sc.mbiReadBack ? '[REDACTED-MBI]' : null,
        next_step: 'Send enrollment summary; confirm cardiologist network status.',
      },
    },
    route,
  };

  // ---- contracts (real evidence keys) ---------------------------------------
  const results: Array<Omit<RunResultOut, 'id'>> = [];
  const push = (code: string, outcome: string, evidence: JsonObject) => pushResult(results, code, sc.code, outcome, evidence, latency);

  push('C-SCHEMA-01', 'PASS', { fields: Object.keys(extraction).length });

  const missing: Record<string, string> = {};
  for (const s of spans) if (!s.verified) missing[s.label] = s.text;
  push('C-SPAN-01', Object.keys(missing).length ? 'FAIL' : 'PASS', Object.keys(missing).length ? { not_in_transcript: missing, checked: spans.length } : { checked: spans.length });

  const transcriptFigures = [`$${sc.premium}`, `$${sc.deductible}`, `$${sc.moop}`];
  push(
    'C-FACT-01',
    invented ? 'FAIL' : 'PASS',
    invented
      ? { invented_figures: [invented], summary_figures: [`$${sc.premium}`, `$${sc.deductible}`, invented], transcript_figures: transcriptFigures }
      : { summary_figures: [`$${sc.premium}`, `$${sc.deductible}`, `$${sc.moop}`] },
  );

  push('C-PII-01', leak ? 'FAIL' : 'PASS', leak ? { pii_in_output: { medicare_number: ['1XX4-XX5-XX73', '[known value present]'] } } : { pii_types_reported: sc.mbiReadBack ? ['medicare_number'] : [] });

  const tpmoEvidence: JsonObject = {
    expected: expTpmo,
    got: gotTpmo,
    truth_basis: medigap ? 'n/a: Medigap calls are out of scope' : basisText(truth, sc.disclaimerAt, sc.benefitsAt),
    model_basis: medigap ? 'n/a: Medigap calls are out of scope' : basisText(belief, sc.disclaimerAt, sc.benefitsAt),
    rule_logic: { basis: truth.disclaimer_basis, window_seconds: truth.disclaimer_window_seconds },
    disclaimer_seconds: sc.disclaimerAt,
    benefits_started_seconds: sc.benefitsAt,
    model_disclaimer_seconds: sc.disclaimerAt,
  };
  if (gotTpmo !== expTpmo) tpmoEvidence.direction = gotTpmo ? 'under_restrictive (missed violation)' : 'over_restrictive (false flag)';
  push('C-TPMO-01', gotTpmo === expTpmo ? 'PASS' : 'FAIL', tpmoEvidence);

  const soaEvidence: JsonObject = {
    expected: expSoa,
    got: gotSoa,
    truth_basis: medigap ? 'n/a: Medigap calls are out of scope' : `appointment ${sc.soaHours}h after SOA; minimum ${truth.soa_min_hours.toFixed(1)}h`,
    rule_logic: { min_hours: truth.soa_min_hours },
    appointment_hours_after_soa: sc.soaHours,
    soa_exception: sc.soaException,
  };
  if (gotSoa !== expSoa) soaEvidence.direction = gotSoa ? 'under_restrictive (missed violation)' : 'over_restrictive (false flag)';
  push('C-SOA-01', gotSoa === expSoa ? 'PASS' : 'FAIL', soaEvidence);

  const supMatch = gotFlags.join('|') === expFlags.join('|');
  push('C-SUP-01', supMatch ? 'PASS' : 'FLAG', { expected_flags: expFlags, got_flags: gotFlags, substantiation_required: truth.superlatives_substantiation_required });

  // judged contract: five scores from the pinned judge
  const jr = prng(9000 + sc.index * 13 + (small ? 1 : 0));
  const base = weak ? 1.9 : small ? 4.0 : 4.4;
  const scores = Array.from({ length: 5 }, () => Number(Math.max(1, Math.min(5, base + (jr() - 0.5) * (weak ? 0.9 : 0.8))).toFixed(2)));
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  const threshold = 3.0;
  push('J-COACH-01', mean < threshold ? 'FLAG' : 'PASS', {
    scores,
    n: 5,
    mean: Number(mean.toFixed(2)),
    variance: Number(variance.toFixed(3)),
    threshold,
    judge: { simulated: true, judge_model: params.modelId, temperature: 'n/a (seeded)' },
    advisory: true,
  });

  return {
    output,
    route,
    spans,
    results,
    latency_ms: latency,
    usage: {
      simulated: true,
      profile: small
        ? { label: 'Simulated — small model profile (defect-prone)', numeric_hallucination: 0.06, span_paraphrase: 0.05, pii_leak: 0.2, coaching_quality: 3.7 }
        : { label: 'Simulated — large model profile (clean)', numeric_hallucination: 0, span_paraphrase: 0, pii_leak: 0, coaching_quality: 4.4 },
    },
    error: null,
  };
}

/** Ingested transcripts have no ground truth: rule contracts report ERROR with what the model said. */
export function evaluateIngested(sample: IngestedSample, params: RunParams): TranscriptEvaluation {
  const small = params.modelId === 'sim-small';
  const latency = small ? 420 : 980;
  const medigap = sample.product_line === 'MEDIGAP';
  const disclaimerAt = sample.text.includes('We do not offer every plan') ? 12 : null;
  const extraction: JsonObject = {
    product_line: sample.product_line,
    carrier: medigap ? null : 'Humana',
    disclaimer_delivered: disclaimerAt !== null,
    disclaimer_seconds: disclaimerAt,
    disclaimer_compliant: medigap ? true : disclaimerAt !== null,
    disclaimer_basis: medigap ? 'n/a: Medigap' : 'ordering: delivered at 12s, benefits at 46s',
    soa_collected: !medigap,
    soa_wait_compliant: true,
    soa_exception: null,
    superlatives: [],
    numeric_claims: medigap ? [{ value: '$158', context: 'Plan G monthly' }, { value: '$121', context: 'Plan N monthly' }] : [{ value: '$0', context: 'monthly premium' }, { value: '$6600', context: 'maximum out-of-pocket' }],
    pii_detected: sample.redacted.medicare_number ? ['medicare_number (redacted at ingest)'] : [],
  };
  const output: JsonObject = {
    extraction,
    composition: {
      summary: `Ingested call ${sample.code} (${sample.product_line}) handled by ${sample.agent}. Figures quoted verbatim; PII redacted at ingest.`,
      coaching_note: 'Disclaimer delivered before benefits. Confirm the SOA was signed before the plan review.',
      crm_record: { agent: sample.agent, product_line: sample.product_line, ingested: true, batch: 'attention-snowflake' },
    },
    route: 'PASS',
  };
  const results: Array<Omit<RunResultOut, 'id'>> = [];
  const push = (code: string, outcome: string, evidence: JsonObject) => pushResult(results, code, sample.code, outcome, evidence, latency);
  push('C-SCHEMA-01', 'PASS', { fields: Object.keys(extraction).length });
  push('C-SPAN-01', 'PASS', { checked: 0 });
  push('C-FACT-01', 'PASS', { summary_figures: medigap ? ['$158', '$121'] : ['$0', '$6600'] });
  push('C-PII-01', 'PASS', { pii_types_reported: [] });
  // not_evaluated: unlabelled, so neither a pass nor a failure (the backend marks these cells the same way)
  const noTruth = (field: string) => ({ error: 'no ground truth for ingested transcript', model_says: extraction[field], not_evaluated: true });
  push('C-TPMO-01', 'ERROR', noTruth('disclaimer_compliant'));
  push('C-SOA-01', 'ERROR', noTruth('soa_wait_compliant'));
  push('C-SUP-01', 'ERROR', noTruth('superlatives'));
  push('J-COACH-01', 'PASS', { scores: [4.1, 4.3, 4.0, 4.2, 4.1], n: 5, mean: 4.14, variance: 0.011, threshold: 3.0, judge: { simulated: true, judge_model: params.modelId, temperature: 'n/a (seeded)' }, advisory: true });
  return {
    output,
    route: 'PASS',
    spans: disclaimerAt === null ? [] : [span('We do not offer every plan available in your area.', 'disclaimer_span', sample.text)],
    results,
    latency_ms: latency,
    usage: { simulated: true, ingested: true },
    error: null,
  };
}

// ------------------------------------------------------------- run materialization

function judgeStability(modelId: string, seed: number): JudgeStability {
  const small = modelId === 'sim-small';
  const jr = prng(seed);
  const spec: Array<[string, [number, number], number]> = [
    ['canary-good-1', [3.8, 5.0], 4.2],
    ['canary-good-2', [3.8, 5.0], 3.9],
    ['canary-generic-1', [1.0, 2.6], 1.9],
    ['canary-generic-2', [1.0, 2.6], 2.0],
    ['canary-mid-1', [2.4, 4.0], small ? 2.0 : 3.2],
    ['canary-mid-2', [2.4, 4.0], 2.7],
  ];
  const notes = spec.map(([id, band, center]) => {
    const scores = Array.from({ length: 5 }, () => Number((center + (jr() - 0.5) * (small ? 0.9 : 0.5)).toFixed(2)));
    const mean = Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2));
    const variance = Number((scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length).toFixed(3));
    return { id, band, scores, mean, variance, in_band: mean >= band[0] && mean <= band[1] };
  });
  const out = notes.filter((n) => !n.in_band).length;
  return {
    notes,
    n_per_note: 5,
    out_of_band: out,
    mean_variance: Number((notes.reduce((a, n) => a + n.variance, 0) / notes.length).toFixed(3)),
    stable: out === 0,
    note: 'canary means outside their bands indicate JUDGE drift; compare across runs before trusting a judged flag',
  };
}

export interface RunMaterial {
  results: RunResultOut[];
  contracts: ContractSummary[];
  gate: string;
  stats: RunStats & JsonObject;
  transcriptCount: number;
}

export function corpusFor(corpus: RunCorpus | undefined): { synthetic: Scenario[]; ingested: IngestedSample[] } {
  const c = corpus ?? 'synthetic';
  // The mock has no held-out calls, so a "holdout" corpus is empty (the server refuses it).
  return {
    synthetic: c === 'synthetic' || c === 'all' ? SCENARIOS : [],
    ingested: c === 'ingested' || c === 'all' ? INGESTED : [],
  };
}

export function materializeRun(runId: string, params: RunParams, adapter: string): RunMaterial {
  const results: RunResultOut[] = [];
  const { synthetic, ingested } = corpusFor(params.corpus);
  let n = 0;
  let latencyTotal = 0;
  const add = (ev: TranscriptEvaluation) => {
    latencyTotal += ev.latency_ms;
    for (const r of ev.results) {
      n += 1;
      results.push({ id: `${runId}-r${String(n).padStart(3, '0')}`, ...r });
    }
  };
  for (const sc of synthetic) add(evaluateTranscript(sc, params));
  for (const s of ingested) add(evaluateIngested(s, params));

  const contracts: ContractSummary[] = CONTRACTS.map((c) => {
    const rows = results.filter((r) => r.contract_code === c.code);
    return {
      code: c.code,
      title: c.title,
      severity: c.severity,
      kind: c.kind,
      rule_code: c.rule_code,
      passed: rows.filter((r) => r.outcome === 'PASS').length,
      failed: rows.filter((r) => r.outcome === 'FAIL').length,
      flagged: rows.filter((r) => r.outcome === 'FLAG').length,
      errored: rows.filter((r) => r.outcome === 'ERROR').length,
    };
  });
  const blockBroken = contracts.some((c) => c.severity === 'BLOCK' && c.failed > 0);
  const anyFlag = contracts.some((c) => c.flagged > 0 || c.errored > 0);
  const gate = blockBroken ? 'RED' : anyFlag ? 'AMBER' : 'GREEN';
  const transcriptCount = synthetic.length + ingested.length;
  const truth = logicFor(params.ruleDate);
  const declared = logicForPrompt(params.promptVersion);
  const live = adapter === 'anthropic';
  const perCall = live ? 0.0042 : 0;
  const stats: RunStats & JsonObject = {
    transcripts: transcriptCount,
    adapter_errors: 0,
    review_tasks_opened: 0,
    contracts: Object.fromEntries(contracts.map((c) => [c.code, { PASS: c.passed, FAIL: c.failed, FLAG: c.flagged, ERROR: c.errored }])),
    logic_in_force: { ...truth },
    logic_declared_by_prompt: { ...declared },
    latency_ms_total: latencyTotal,
    latency_ms_per_transcript: transcriptCount ? Math.round(latencyTotal / transcriptCount) : 0,
    judge_stability: judgeStability(params.modelId, 4242 + params.promptVersion),
    cost: {
      usd: Number((perCall * transcriptCount).toFixed(4)),
      per_call_usd: perCall,
      basis: live ? 'measured from adapter usage' : adapter === 'cassette' ? 'cassette adapter — estimated from recorded usage' : 'simulated adapter — no model calls',
      projection: {
        calls_per_day: 3000,
        usd_per_day: Number((perCall * 3000).toFixed(2)),
        usd_per_aep: Number((perCall * 3000 * 54).toFixed(2)),
        note: 'volume is an assumption (3,000 calls/day, 54-day AEP); replace with the floor’s real call counts',
      },
    },
  };
  return { results, contracts, gate, stats, transcriptCount };
}

export function runTranscript(run: RunOut, code: string, results: RunResultOut[]): RunTranscriptOut | null {
  const params: RunParams = { promptVersion: run.prompt_version, modelId: run.model_id, ruleDate: run.rule_date };
  const sc = SCENARIOS.find((s) => s.code === code);
  const sample = INGESTED.find((s) => s.code === code);
  if (!sc && !sample) return null;
  const ev = sc ? evaluateTranscript(sc, params) : evaluateIngested(sample as IngestedSample, params);
  return {
    transcript: sc ? transcriptOut(sc, true) : ingestedOut(sample as IngestedSample, true),
    output: ev.output,
    route: ev.route,
    latency_ms: ev.latency_ms,
    usage: ev.usage,
    error: ev.error,
    results: results.filter((r) => r.transcript_code === code),
    spans: ev.spans,
  };
}
