import type { CostStats, JsonObject, JudgeStability, OutcomeCounts, RunOut, RunStats } from '../api/types';

/**
 * RunOut.stats is `dict[str, Any]` on the wire. These narrow it to the shape
 * observed on the live API without trusting it blindly.
 */

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

function judgeStability(v: unknown): JudgeStability | undefined {
  if (!isObject(v) || !Array.isArray(v.notes)) return undefined;
  const notes = v.notes
    .filter(isObject)
    .map((n) => {
      const band = numArray(n.band);
      return {
        id: typeof n.id === 'string' ? n.id : '',
        band: [band[0] ?? 0, band[1] ?? 0] as [number, number],
        scores: numArray(n.scores),
        mean: num(n.mean) ?? 0,
        variance: num(n.variance) ?? 0,
        in_band: n.in_band === true,
      };
    });
  return {
    notes,
    n_per_note: num(v.n_per_note) ?? (notes[0]?.scores.length ?? 0),
    out_of_band: num(v.out_of_band) ?? notes.filter((n) => !n.in_band).length,
    mean_variance: num(v.mean_variance) ?? 0,
    stable: v.stable === true,
    note: typeof v.note === 'string' ? v.note : '',
  };
}

function cost(v: unknown): CostStats | undefined {
  if (!isObject(v)) return undefined;
  const projection = isObject(v.projection)
    ? {
        calls_per_day: num(v.projection.calls_per_day) ?? 0,
        usd_per_day: num(v.projection.usd_per_day) ?? 0,
        usd_per_aep: num(v.projection.usd_per_aep) ?? 0,
        note: typeof v.projection.note === 'string' ? v.projection.note : undefined,
      }
    : undefined;
  return {
    usd: num(v.usd) ?? 0,
    per_call_usd: num(v.per_call_usd) ?? 0,
    basis: typeof v.basis === 'string' ? v.basis : '',
    projection,
    input_tokens: num(v.input_tokens),
    output_tokens: num(v.output_tokens),
  };
}

function contracts(v: unknown): Record<string, OutcomeCounts> | undefined {
  if (!isObject(v)) return undefined;
  const out: Record<string, OutcomeCounts> = {};
  for (const [code, counts] of Object.entries(v)) {
    if (!isObject(counts)) continue;
    out[code] = {
      PASS: num(counts.PASS) ?? 0,
      FAIL: num(counts.FAIL) ?? 0,
      FLAG: num(counts.FLAG) ?? 0,
      ERROR: num(counts.ERROR) ?? 0,
    };
  }
  return out;
}

export function runStats(run: Pick<RunOut, 'stats'> | undefined | null): RunStats {
  const s = run?.stats;
  if (!isObject(s)) return {};
  return {
    transcripts: num(s.transcripts),
    adapter_errors: num(s.adapter_errors),
    review_tasks_opened: num(s.review_tasks_opened),
    advisory_items_opened: num(s.advisory_items_opened),
    contracts: contracts(s.contracts),
    logic_in_force: isObject(s.logic_in_force) ? s.logic_in_force : undefined,
    logic_declared_by_prompt: isObject(s.logic_declared_by_prompt) ? s.logic_declared_by_prompt : undefined,
    latency_ms_total: num(s.latency_ms_total),
    latency_ms_per_transcript: num(s.latency_ms_per_transcript),
    judge_stability: judgeStability(s.judge_stability),
    cost: cost(s.cost),
    test_cases: isObject(s.test_cases) ? { ...s.test_cases, applied: num(s.test_cases.applied) } : undefined,
  };
}

/** How many approved override test cases the run honoured, or null when the server did not report it. */
export function testCasesApplied(run: Pick<RunOut, 'stats'> | undefined | null): number | null {
  return runStats(run).test_cases?.applied ?? null;
}

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdFmtSmall = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 5 });

export function fmtUsd(value: number | undefined | null, precise = false): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return precise ? usdFmtSmall.format(value) : usdFmt.format(value);
}

/** "$0.00 · simulated" or "$0.42 · measured" — the short cost line for a run. */
export function costLabel(c: CostStats | undefined): string {
  if (!c) return '—';
  const basis = c.basis.toLowerCase();
  const how = basis.includes('simulated') ? 'simulated' : basis.includes('estimat') ? 'estimated' : basis.includes('measur') ? 'measured' : c.basis || 'n/a';
  return `${fmtUsd(c.usd)} · ${how}`;
}

/** Totals across all contracts from the per-contract summaries (stats.contracts or run.contracts). */
export function outcomeTotals(run: RunOut): OutcomeCounts & { cells: number } {
  const totals = { PASS: 0, FAIL: 0, FLAG: 0, ERROR: 0, cells: 0 };
  for (const c of run.contracts) {
    totals.PASS += c.passed;
    totals.FAIL += c.failed;
    totals.FLAG += c.flagged;
    totals.ERROR += c.errored;
  }
  totals.cells = totals.PASS + totals.FAIL + totals.FLAG + totals.ERROR;
  return totals;
}

/**
 * The model that judged a run: stats.judge_model_id, else the one recorded on
 * the judge-stability block, else the run's own model (the default judge).
 */
export function judgeModelId(run: Pick<RunOut, 'stats' | 'model_id'>): string {
  const s = run.stats;
  if (isObject(s)) {
    if (typeof s.judge_model_id === 'string' && s.judge_model_id) return s.judge_model_id;
    const js = s.judge_stability;
    if (isObject(js) && typeof js.judge_model_id === 'string' && js.judge_model_id) return js.judge_model_id;
  }
  return run.model_id;
}

/** RunOut.corpus is optional: servers before the held-out split did not send it. */
type WithCorpus = { corpus?: string | null };

/** The fields that identify a gate-strip configuration. */
type ConfigFields = Pick<RunOut, 'workflow_code' | 'prompt_version' | 'model_id' | 'adapter' | 'rule_date' | 'stats'> &
  WithCorpus;

/**
 * Which call set a run replayed: RunOut.corpus, else stats.corpus, else
 * "synthetic" (servers before the held-out split only ran the development calls).
 */
export function runCorpus(run: Pick<RunOut, 'stats'> & WithCorpus): string {
  if (typeof run.corpus === 'string' && run.corpus) return run.corpus;
  const s = run.stats;
  if (isObject(s) && typeof s.corpus === 'string' && s.corpus) return s.corpus;
  return 'synthetic';
}

/**
 * A run over the 60 development calls. Only these are comparable with each
 * other on the change-trigger cards; held-out, ingested and "all" runs answer
 * different questions and must never become a card's A, B or baseline.
 */
export function isDevelopmentRun(run: Pick<RunOut, 'stats'> & WithCorpus): boolean {
  return runCorpus(run) === 'synthetic';
}

export const HOLDOUT_MODEL = 'qwen2.5:7b-instruct';

/**
 * The held-out overfitting check: the latest complete held-out runs of the
 * qwen2.5 7B model at prompt v2 (before the fix) and v3 (after), or null
 * unless both exist.
 */
type HoldoutFields = Pick<RunOut, 'stats' | 'model_id' | 'prompt_version' | 'status' | 'started_at'> & WithCorpus;

export function holdoutPair<T extends HoldoutFields>(runs: T[] | undefined): { before: T; after: T } | null {
  const latest = (version: number): T | undefined =>
    (runs ?? [])
      .filter(
        (r) =>
          runCorpus(r) === 'holdout' &&
          r.prompt_version === version &&
          r.status === 'COMPLETE' &&
          (r.model_id === HOLDOUT_MODEL || r.model_id.endsWith(`/${HOLDOUT_MODEL}`)),
      )
      .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
  const before = latest(2);
  const after = latest(3);
  return before && after ? { before, after } : null;
}

/**
 * Home gate strip grouping: one row per distinct configuration. Adapter,
 * judge model and corpus are part of the key, so e.g. qwen2.5:3b judged by
 * itself and qwen2.5:3b judged by 7B are two rows, and a held-out replay never
 * hides the development run of the same configuration.
 */
export function gateStripKey(run: ConfigFields): string {
  const judge = judgeModelId(run);
  const corpus = runCorpus(run);
  const parts = [run.workflow_code, run.prompt_version, run.model_id, run.adapter ?? '', judge, run.rule_date, corpus];
  return parts.join('|');
}

/** Latest run per gateStripKey, newest first. */
export function latestPerConfiguration<T extends ConfigFields & Pick<RunOut, 'started_at'>>(
  runs: T[] | undefined,
): T[] {
  const map = new Map<string, T>();
  for (const r of runs ?? []) {
    const key = gateStripKey(r);
    const prev = map.get(key);
    if (!prev || prev.started_at < r.started_at) map.set(key, r);
  }
  return [...map.values()].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}

/**
 * Current blocking failures on a run: FAIL + ERROR on BLOCK-severity
 * contracts (the backend's RED rule). Severities come from the contracts API;
 * a contract missing there falls back to the run's own summary severity.
 */
export function blockingFailures(
  run: Pick<RunOut, 'stats' | 'contracts'> | null | undefined,
  severityByCode: ReadonlyMap<string, string>,
): { failures: number; contracts: string[] } {
  if (!run) return { failures: 0, contracts: [] };
  const perContract = runStats(run).contracts ?? {};
  const summarySeverity = new Map(run.contracts.map((c) => [c.code, c.severity]));
  let failures = 0;
  const hit: string[] = [];
  for (const [code, counts] of Object.entries(perContract)) {
    const severity = severityByCode.get(code) ?? summarySeverity.get(code);
    if (severity !== 'BLOCK') continue;
    const n = counts.FAIL + counts.ERROR;
    if (n > 0) {
      failures += n;
      hit.push(code);
    }
  }
  return { failures, contracts: hit };
}

/**
 * The change-trigger cards compare runs over the same 60 development calls.
 * Held-out, ingested and "all" runs are filtered out before anything below
 * picks a card's A, B or baseline.
 */
export function latestByTrigger(runs: RunOut[] | undefined, trigger: string): RunOut | undefined {
  return runs
    ?.filter((r) => r.trigger === trigger && isDevelopmentRun(r))
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
}

export function baselineFor(
  runs: RunOut[] | undefined,
  b: RunOut | undefined,
  differ: 'prompt' | 'model',
): RunOut | undefined {
  if (!runs || !b || !isDevelopmentRun(b)) return undefined;
  const earlier = runs
    .filter((r) => r.id !== b.id && r.started_at <= b.started_at && isDevelopmentRun(r))
    .sort((x, y) => (x.started_at < y.started_at ? 1 : -1));
  const match = earlier.find((r) =>
    differ === 'prompt'
      ? r.prompt_hash !== b.prompt_hash && r.model_id === b.model_id && r.rule_date === b.rule_date
      : r.model_id !== b.model_id && r.prompt_hash === b.prompt_hash && r.rule_date === b.rule_date,
  );
  return match ?? earlier[0];
}

/** Sum stats.contracts (per-contract PASS/FAIL/FLAG/ERROR) into one set of counts. */
export function sumOutcomes(byContract: Record<string, OutcomeCounts> | undefined): (OutcomeCounts & { total: number }) | null {
  if (!byContract) return null;
  const t = { PASS: 0, FAIL: 0, FLAG: 0, ERROR: 0, total: 0 };
  for (const c of Object.values(byContract)) {
    t.PASS += c.PASS;
    t.FAIL += c.FAIL;
    t.FLAG += c.FLAG;
    t.ERROR += c.ERROR;
  }
  t.total = t.PASS + t.FAIL + t.FLAG + t.ERROR;
  return t.total > 0 ? t : null;
}
