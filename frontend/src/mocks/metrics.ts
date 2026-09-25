import type {
  CompareStatisticsOut,
  ConfusionOut,
  ContractComparisonOut,
  ContractMetricsOut,
  RunContractMetricsOut,
  RunCorpus,
  RunOut,
  RunResultOut,
  SliceOut,
  TrendPointOut,
} from '../api/types';
import {
  ALPHA,
  FAILURE_DEFINITION,
  classifierMetrics,
  compareRates,
  failureOutcomes,
  fmtP,
  holm,
  pairedTable,
  rate,
} from '../lib/stats';
import { INGESTED, SCENARIOS, transcriptOut } from './corpus';
import { CONTRACTS } from './registry';

/**
 * Ports of backend api/contracts_metrics.py and the statistics half of
 * api/runs.py compare, over the mock's stored results. Nothing is re-run.
 */

export interface MetricsRun {
  run: RunOut;
  results: RunResultOut[];
  corpus: RunCorpus;
}

type Family = 'judgment' | 'flags' | 'grounding' | 'judged';

/** The mock's contracts carry older check names; the family follows the backend's check → family map. */
const FAMILIES: Record<string, Family> = {
  'C-TPMO-01': 'judgment',
  'C-SOA-01': 'judgment',
  'C-SUP-01': 'flags',
  'J-COACH-01': 'judged',
};

const POSITIVE: Record<string, string> = {
  judgment:
    'A call whose ground truth is non-compliant under the rule in force (a violation). TP = violation the model called non-compliant; FN = missed violation; FP = compliant call the model called non-compliant (false flag).',
  flags:
    'A superlative phrase ground truth says must be flagged. TP = flagged and should be; FN = should be flagged and was not; FP = flagged and should not be (exact phrase match, as the contract checks). True negatives are not countable per phrase.',
};

const SLICE_DIMENSIONS = ['scenario', 'product_line'] as const;

interface CallFacts {
  scenario: string;
  product_line: string;
}

const CALLS: Map<string, CallFacts> = new Map([
  ...SCENARIOS.map((sc): [string, CallFacts] => {
    const labels = transcriptOut(sc, false).labels;
    return [sc.code, { scenario: typeof labels.scenario === 'string' ? labels.scenario : 'unlabelled', product_line: sc.product_line }];
  }),
  ...INGESTED.map((s): [string, CallFacts] => [s.code, { scenario: 'unlabelled', product_line: s.product_line }]),
]);

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function ci(r: { ci_low: number; ci_high: number }): string {
  return `${Math.round(r.ci_low * 100)}%-${Math.round(r.ci_high * 100)}%`;
}

interface Tally {
  n: number;
  failures: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

const blank = (): Tally => ({ n: 0, failures: 0, tp: 0, fp: 0, fn: 0, tn: 0 });

function add(t: Tally, failed: boolean, cls: Partial<Record<'tp' | 'fp' | 'fn' | 'tn', number>> | null): void {
  t.n += 1;
  t.failures += failed ? 1 : 0;
  for (const [k, v] of Object.entries(cls ?? {}) as Array<['tp' | 'fp' | 'fn' | 'tn', number]>) t[k] += v;
}

function isNotEvaluated(r: RunResultOut): boolean {
  return r.outcome === 'ERROR' && r.evidence.not_evaluated === true;
}

function runMetrics(rec: MetricsRun, code: string, family: Family, fails: string[]): RunContractMetricsOut {
  const outcomes: Record<string, number> = {};
  const total = blank();
  const slices = new Map<string, Tally>();
  let notApplicable = 0;
  let notEvaluated = 0;
  let noOutput = 0;

  for (const r of rec.results.filter((x) => x.contract_code === code)) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    if (isNotEvaluated(r)) {
      notEvaluated += 1;
      continue;
    }
    const failed = fails.includes(r.outcome);
    const call = CALLS.get(r.transcript_code) ?? { scenario: 'unlabelled', product_line: 'unknown' };
    let cls: Partial<Record<'tp' | 'fp' | 'fn' | 'tn', number>> | null = null;
    if (family === 'judgment' || family === 'flags') {
      if (r.outcome === 'ERROR') noOutput += 1;
      else if (family === 'judgment') {
        const expected = r.evidence.expected;
        const got = r.evidence.got;
        // Medigap calls are out of scope for these CMS rules: neither a pass nor a violation.
        if (call.product_line === 'MEDIGAP' || r.evidence.not_applicable === true) notApplicable += 1;
        else if (typeof expected !== 'boolean' || typeof got !== 'boolean') noOutput += 1;
        else {
          const violation = !expected;
          const called = !got;
          cls = { [violation ? (called ? 'tp' : 'fn') : called ? 'fp' : 'tn']: 1 };
        }
      } else {
        const exp = new Set(Array.isArray(r.evidence.expected_flags) ? (r.evidence.expected_flags as string[]) : []);
        const got = new Set(Array.isArray(r.evidence.got_flags) ? (r.evidence.got_flags as string[]) : []);
        cls = {
          tp: [...exp].filter((f) => got.has(f)).length,
          fp: [...got].filter((f) => !exp.has(f)).length,
          fn: [...exp].filter((f) => !got.has(f)).length,
        };
      }
    }
    add(total, failed, cls);
    const values: Record<(typeof SLICE_DIMENSIONS)[number], string> = { scenario: call.scenario, product_line: call.product_line };
    for (const dim of SLICE_DIMENSIONS) {
      const key = `${dim}|${values[dim]}`;
      if (!slices.has(key)) slices.set(key, blank());
      add(slices.get(key) as Tally, failed, cls);
    }
  }

  const failure = rate(total.failures, total.n);
  let confusion: ConfusionOut | null = null;
  const findings: string[] = [];
  const classified = family === 'judgment' || family === 'flags';
  if (classified) {
    const m = classifierMetrics(total.tp, total.fp, total.fn, family === 'judgment' ? total.tn : null);
    confusion = {
      unit: family === 'judgment' ? 'call' : 'flagged phrase',
      positive: POSITIVE[family],
      tp: total.tp,
      fp: total.fp,
      fn: total.fn,
      tn: family === 'judgment' ? total.tn : null,
      not_applicable: notApplicable,
      not_evaluated: notEvaluated,
      no_output: noOutput,
      precision: m.precision,
      recall: m.recall,
      specificity: m.specificity,
      false_flag_rate: m.false_flag_rate,
      miss_rate: m.miss_rate,
      f1: m.f1,
    };
    const positives = total.tp + total.fn;
    let headline = positives
      ? `Missed ${total.fn} of ${positives} violations (recall ${pct(m.recall.rate)}, 95% CI ${ci(m.recall)}); ${total.fp} false flag(s)`
      : `No violations in the ground truth; ${total.fp} false flag(s)`;
    if (family === 'judgment' && m.false_flag_rate && total.fp + total.tn) {
      headline += ` of ${total.fp + total.tn} compliant calls (${pct(m.false_flag_rate.rate)})`;
    }
    if (noOutput) headline += `; ${noOutput} call(s) with no usable output`;
    findings.push(headline);
  } else {
    findings.push(`Failed ${total.failures}/${total.n} (${pct(failure.rate)}, 95% CI ${ci(failure)})`);
  }

  const sliceOut: SliceOut[] = [...slices.entries()]
    .map(([key, t]) => {
      const [dimension, value] = key.split('|');
      const f = rate(t.failures, t.n);
      const positives = t.tp + t.fn;
      const parts: string[] = [];
      if (classified && positives) parts.push(`${t.fn}/${positives} violations missed`);
      if (family === 'judgment' && t.fp + t.tn) parts.push(`${t.fp}/${t.fp + t.tn} false flags`);
      else if (family === 'flags' && t.fp) parts.push(`${t.fp} false flag(s)`);
      parts.push(`${t.failures}/${t.n} failed`);
      const allMissed = classified && positives > 0 && t.fn === positives;
      const aboveOverall = t.failures > 0 && failure.rate !== null && f.ci_low > failure.rate;
      return {
        dimension,
        value,
        n: t.n,
        failure: f,
        tp: classified ? t.tp : null,
        fp: classified ? t.fp : null,
        fn: classified ? t.fn : null,
        tn: family === 'judgment' ? t.tn : null,
        summary: `${dimension} ${value}: ${parts.join(', ')}`,
        notable: allMissed || aboveOverall,
      };
    })
    .sort((x, y) => SLICE_DIMENSIONS.indexOf(x.dimension as 'scenario') - SLICE_DIMENSIONS.indexOf(y.dimension as 'scenario') || x.value.localeCompare(y.value));
  findings.push(
    ...sliceOut
      .filter((x) => x.notable)
      .sort((x, y) => SLICE_DIMENSIONS.indexOf(x.dimension as 'scenario') - SLICE_DIMENSIONS.indexOf(y.dimension as 'scenario') || (y.fn ?? 0) - (x.fn ?? 0) || y.failure.k - x.failure.k)
      .map((x) => x.summary),
  );

  return {
    run_id: rec.run.id,
    started_at: rec.run.started_at,
    model_id: rec.run.model_id,
    prompt_version: rec.run.prompt_version,
    corpus: rec.corpus,
    rule_date: rec.run.rule_date,
    adapter: rec.run.adapter,
    outcomes,
    failure,
    excluded_not_evaluated: notEvaluated,
    confusion,
    slices: sliceOut,
    findings,
  };
}

function latestPerConfig(runs: MetricsRun[], corpus: string, ruleDate: string | null): MetricsRun[] {
  const picked = new Map<string, MetricsRun>();
  for (const rec of [...runs].sort((a, b) => (a.run.started_at < b.run.started_at ? 1 : -1))) {
    if (rec.run.status !== 'COMPLETE') continue;
    if (ruleDate && rec.run.rule_date !== ruleDate) continue;
    if (corpus !== 'all' && rec.corpus !== corpus) continue;
    const key = `${rec.run.model_id}|${rec.run.prompt_version}`;
    if (!picked.has(key)) picked.set(key, rec);
  }
  return [...picked.values()];
}

function trend(runs: MetricsRun[], code: string, fails: string[]): TrendPointOut[] {
  return runs
    .filter((rec) => rec.run.status === 'COMPLETE' && rec.results.some((r) => r.contract_code === code))
    .sort((a, b) => (a.run.started_at < b.run.started_at ? -1 : 1))
    .map((rec) => {
      const rows = rec.results.filter((r) => r.contract_code === code && !isNotEvaluated(r));
      return {
        run_id: rec.run.id,
        started_at: rec.run.started_at,
        model_id: rec.run.model_id,
        prompt_version: rec.run.prompt_version,
        corpus: rec.corpus,
        rule_date: rec.run.rule_date,
        adapter: rec.run.adapter,
        failure: rate(rows.filter((r) => fails.includes(r.outcome)).length, rows.length),
      };
    });
}

export function contractMetrics(code: string, runs: MetricsRun[], query: URLSearchParams): ContractMetricsOut | null {
  const contract = CONTRACTS.find((c) => c.code === code);
  if (!contract) return null;
  const family = FAMILIES[code] ?? 'grounding';
  const fails = failureOutcomes(contract.severity);
  const runId = query.get('run_id');
  const corpus = query.get('corpus') || 'synthetic';
  const ruleDate = query.get('rule_date');
  let selected: MetricsRun[];
  let selection: string;
  if (runId) {
    const rec = runs.find((r) => r.run.id === runId);
    if (!rec) return null;
    selected = [rec];
    selection = `run ${runId}`;
  } else {
    selected = latestPerConfig(runs, corpus, ruleDate);
    selection = `latest COMPLETE run per model and prompt version on corpus=${corpus}${ruleDate ? ` at rule date ${ruleDate}` : ''}`;
  }
  return {
    contract_code: contract.code,
    title: contract.title,
    kind: contract.kind,
    severity: contract.severity,
    check: contract.check,
    metric_family: family,
    failure_definition: FAILURE_DEFINITION,
    positive_definition: POSITIVE[family] ?? null,
    selection,
    runs: selected.map((rec) => runMetrics(rec, code, family, fails)),
    trend: trend(runs, code, fails),
  };
}

// ------------------------------------------------------------------ compare statistics

function compareOne(
  code: string,
  severity: string,
  aMap: Map<string, boolean>,
  bMap: Map<string, boolean>,
  paired: boolean,
  excluded: number,
  what: string,
): ContractComparisonOut {
  const shared = [...aMap.keys()].filter((t) => bMap.has(t));
  const table = pairedTable(shared.map((t): [boolean, boolean] => [aMap.get(t) as boolean, bMap.get(t) as boolean]));
  const result = paired
    ? compareRates(table.both_fail + table.a_only_fail, shared.length, table.both_fail + table.b_only_fail, shared.length, table, what)
    : compareRates([...aMap.values()].filter(Boolean).length, aMap.size, [...bMap.values()].filter(Boolean).length, bMap.size, null, what);
  return {
    contract_code: code,
    severity,
    failure_outcomes: failureOutcomes(severity),
    n_shared: shared.length,
    paired: paired ? table : null,
    a: result.a,
    b: result.b,
    discordant: result.discordant,
    test: result.test,
    p_value: result.p_value,
    p_holm: null,
    significant: result.significant,
    direction: result.direction,
    verdict: result.verdict,
    cautions: result.cautions,
    excluded_not_evaluated: excluded,
  };
}

export function compareStatistics(a: MetricsRun, b: MetricsRun): CompareStatisticsOut {
  const paired = a.run.corpus_hash === b.run.corpus_hash;
  const severity = new Map(CONTRACTS.map((c) => [c.code, c.severity]));
  const excluded = new Map<string, number>();
  const failedBy = (rec: MetricsRun) => {
    const out = new Map<string, Map<string, boolean>>();
    for (const r of rec.results) {
      if (isNotEvaluated(r)) {
        excluded.set(r.contract_code, (excluded.get(r.contract_code) ?? 0) + 1);
        continue;
      }
      if (!out.has(r.contract_code)) out.set(r.contract_code, new Map());
      out.get(r.contract_code)?.set(r.transcript_code, failureOutcomes(severity.get(r.contract_code) ?? 'BLOCK').includes(r.outcome));
    }
    return out;
  };
  const fa = failedBy(a);
  const fb = failedBy(b);
  const codes = [...severity.keys()].sort();
  const perContract = codes.map((code) =>
    compareOne(code, severity.get(code) ?? 'BLOCK', fa.get(code) ?? new Map(), fb.get(code) ?? new Map(), paired, excluded.get(code) ?? 0, 'this contract'),
  );
  holm(perContract.map((r) => r.p_value)).forEach((pHolm, i) => {
    const row = perContract[i];
    row.p_holm = pHolm;
    if (row.significant && pHolm !== null && pHolm >= ALPHA) {
      row.cautions.push(`Not significant after Holm correction across ${perContract.length} contracts (p_holm=${fmtP(pHolm)}).`);
    }
  });

  const block = codes.filter((c) => severity.get(c) === 'BLOCK');
  const anyBlock = (f: Map<string, Map<string, boolean>>) => {
    const calls = new Map<string, boolean>();
    for (const code of block) for (const [t, failed] of f.get(code) ?? []) calls.set(t, (calls.get(t) ?? false) || failed);
    return calls;
  };
  const overall = compareOne(
    'ALL-BLOCK',
    'BLOCK',
    anyBlock(fa),
    anyBlock(fb),
    paired,
    block.reduce((n, c) => n + (excluded.get(c) ?? 0), 0),
    'the release-blocking contracts',
  );
  if (a.run.contract_set_hash !== b.run.contract_set_hash) overall.cautions.push('The contract sets differ between the runs; ALL-BLOCK compares different checks.');

  const cautions = ['One generation per call: a repeat of either run could move a few calls. Repeat generations would tighten these intervals.'];
  if (!paired) {
    cautions.unshift(
      "The runs scored different calls (corpus changed), so a paired test is invalid. Rates are compared with Fisher's exact test on each run's own calls; two draws of calls can differ on their own, so this does not isolate the change.",
    );
  } else if (a.corpus === 'synthetic' && b.corpus === 'synthetic' && a.run.prompt_version !== b.run.prompt_version) {
    cautions.push(
      'Both runs are on the development calls the prompts were written against. A prompt tuned on these calls can look significantly better here and still regress on unseen calls; confirm on the held-out corpus.',
    );
  }
  return { mode: paired ? 'paired' : 'unpaired', alpha: ALPHA, failure_definition: FAILURE_DEFINITION, cautions, overall, per_contract: perContract };
}

export const COMPARE_FAILURE_DEFINITION =
  'per_contract a_fail/b_fail count every non-PASS outcome (FAIL, FLAG and ERROR, including unlabelled not_evaluated cells); a_error/b_error break out the ERROR share. statistics uses the severity-aware definition: ' +
  FAILURE_DEFINITION;
