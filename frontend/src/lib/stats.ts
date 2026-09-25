/**
 * Small, exact statistics. A port of backend/backstop/core/stats.py so the
 * mock API answers with the same numbers the backend would, and so the UI can
 * format p-values and intervals the same way. No dependencies.
 *
 * Conventions: rates are failure rates (k of n); intervals are 95% Wilson score
 * intervals; McNemar is the exact two-sided binomial on discordant pairs;
 * Fisher is the two-sided exact test for two independent draws.
 */

import type { ComparisonDirection, PairedTableOut, RateOut } from '../api/types';

export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function variance(values: number[]): number {
  if (!values.length) return 0;
  const m = mean(values);
  return values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
}

export const ALPHA = 0.05;
/** Below this many discordant pairs a comparison can hardly show anything; say so. */
export const MIN_DISCORDANT = 10;
const REL_TOL = 1e-7;

export const FAILURE_DEFINITION =
  'A cell fails when its outcome is FAIL or ERROR on a BLOCK contract, or FAIL, FLAG or ERROR on a ' +
  'FLAG contract. ERROR (no usable model output) counts as a failure: a release cannot ship an output ' +
  'it does not have. Unlabelled ingested cells (ERROR marked not_evaluated) are neither: they are ' +
  'excluded and counted as excluded_not_evaluated. Verdicts are raw; approved overrides are not applied.';

/** Outcomes that count as a failure for a contract of this severity. */
export function failureOutcomes(severity: string): string[] {
  return severity === 'BLOCK' ? ['FAIL', 'ERROR'] : ['FAIL', 'FLAG', 'ERROR'];
}

// ------------------------------------------------------------------ intervals

/** Wilson score interval for k/n; [0, 1] when n = 0. */
export function wilsonCi(k: number, n: number, z = 1.96): [number, number] {
  if (n < 0 || k < 0 || k > n) throw new RangeError(`need 0 <= k <= n, got k=${k}, n=${n}`);
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function rate(k: number, n: number): RateOut {
  const [lo, hi] = wilsonCi(k, n);
  return { k, n, rate: n ? k / n : null, ci_low: lo, ci_high: hi };
}

// ------------------------------------------------------------------ tests

const logFactorials: number[] = [0];
function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i += 1) logFactorials[i] = logFactorials[i - 1] + Math.log(i);
  return logFactorials[n];
}

function logComb(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

function logSumExp(values: number[]): number {
  const top = Math.max(...values);
  if (top === -Infinity) return top;
  return top + Math.log(values.reduce((acc, v) => acc + Math.exp(v - top), 0));
}

/** Two-sided exact binomial p for k successes in n trials at p = 0.5 (twice the smaller tail, capped at 1). */
export function binomTwoSidedHalf(k: number, n: number): number {
  if (n === 0) return 1;
  const small = Math.min(k, n - k);
  const logs = Array.from({ length: small + 1 }, (_, i) => logComb(n, i));
  return Math.min(1, 2 * Math.exp(logSumExp(logs) - n * Math.LN2));
}

/** Exact McNemar on discordant pairs b (failed only in B) and c (failed only in A). No pairs: p = 1. */
export function mcnemarExact(b: number, c: number): { discordant: number; p_value: number; test: string } {
  const n = b + c;
  return { discordant: n, p_value: binomTwoSidedHalf(Math.min(b, c), n), test: 'McNemar exact (two-sided binomial on discordant pairs, p=0.5)' };
}

/** Two-sided Fisher exact test for [[a, b], [c, d]] (rows = draws, columns = fail, pass). */
export function fisherExact2x2(a: number, b: number, c: number, d: number): { p_value: number; test: string } {
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  const lo = Math.max(0, col1 - row2);
  const hi = Math.min(row1, col1);
  let p = 1;
  if (total > 0 && lo !== hi) {
    const denom = logComb(total, col1);
    const logP = (x: number) => logComb(row1, x) + logComb(row2, col1 - x) - denom;
    const threshold = logP(a) + Math.log1p(REL_TOL);
    const logs: number[] = [];
    for (let x = lo; x <= hi; x += 1) {
      const lp = logP(x);
      if (lp <= threshold) logs.push(lp);
    }
    p = Math.min(1, Math.exp(logSumExp(logs)));
  }
  return { p_value: p, test: 'Fisher exact (two-sided)' };
}

/** Holm-Bonferroni adjusted p-values in input order; null entries are skipped. */
export function holm(pValues: Array<number | null>): Array<number | null> {
  const indexed = pValues
    .map((p, i) => [p, i] as const)
    .filter((x): x is readonly [number, number] => x[0] !== null)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const m = indexed.length;
  const out: Array<number | null> = pValues.map(() => null);
  let running = 0;
  indexed.forEach(([p, i], rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  });
  return out;
}

// ------------------------------------------------------------------ classifier metrics

export interface ClassifierMetrics {
  precision: RateOut;
  recall: RateOut;
  specificity: RateOut | null;
  false_flag_rate: RateOut | null;
  miss_rate: RateOut;
  f1: number | null;
}

/** Precision, recall, specificity and F1 with Wilson CIs; tn null when true negatives are not countable. */
export function classifierMetrics(tp: number, fp: number, fn: number, tn: number | null): ClassifierMetrics {
  const precision = rate(tp, tp + fp);
  const recall = rate(tp, tp + fn);
  let f1: number | null;
  if (precision.rate === null || recall.rate === null || precision.rate + recall.rate === 0) {
    f1 = tp + fp + fn === 0 ? null : 0;
  } else {
    f1 = (2 * precision.rate * recall.rate) / (precision.rate + recall.rate);
  }
  return {
    precision,
    recall,
    specificity: tn === null ? null : rate(tn, tn + fp),
    false_flag_rate: tn === null ? null : rate(fp, tn + fp),
    miss_rate: rate(fn, tp + fn),
    f1,
  };
}

// ------------------------------------------------------------------ run comparison

export function pairedTable(pairs: Iterable<[boolean, boolean]>): PairedTableOut {
  const t: PairedTableOut = { both_pass: 0, a_only_fail: 0, b_only_fail: 0, both_fail: 0 };
  for (const [a, b] of pairs) {
    if (a && b) t.both_fail += 1;
    else if (a) t.a_only_fail += 1;
    else if (b) t.b_only_fail += 1;
    else t.both_pass += 1;
  }
  return t;
}

/** p-value text as the backend writes it (Python formats): 7.3e-05 · 0.00073 · 0.012 · 0.43. */
export function fmtP(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return 'n/a';
  if (p < 0.0001) {
    const [mantissa, exp] = p.toExponential(1).split('e');
    const e = Number(exp);
    return `${mantissa}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  if (p < 0.001) return p.toFixed(5);
  return p < 0.1 ? p.toFixed(3) : p.toFixed(2);
}

export interface CompareRatesResult {
  a: RateOut;
  b: RateOut;
  discordant: number | null;
  test: string;
  p_value: number;
  significant: boolean;
  direction: ComparisonDirection;
  verdict: string;
  cautions: string[];
}

/** Compare failure rates of A and B: McNemar with a paired table, Fisher without; phrase a verdict. */
export function compareRates(aFail: number, aN: number, bFail: number, bN: number, paired: PairedTableOut | null, what = 'this contract'): CompareRatesResult {
  const cautions: string[] = [];
  let p: number;
  let test: string;
  let discordant: number | null;
  let worse: boolean;
  if (paired) {
    const m = mcnemarExact(paired.b_only_fail, paired.a_only_fail);
    p = m.p_value;
    test = m.test;
    discordant = m.discordant;
    worse = paired.b_only_fail > paired.a_only_fail;
    if (discordant < MIN_DISCORDANT) cautions.push(`Only ${discordant} call(s) changed outcome: too few changed calls to conclude.`);
  } else {
    const f = fisherExact2x2(aFail, aN - aFail, bFail, bN - bFail);
    p = f.p_value;
    test = f.test;
    discordant = null;
    worse = (bN ? bFail / bN : 0) > (aN ? aFail / aN : 0);
  }
  const significant = p < ALPHA && (discordant === null || discordant > 0);
  let direction: ComparisonDirection = 'none';
  let verdict: string;
  if (significant) {
    direction = worse ? 'worse' : 'better';
    verdict = `B is significantly ${direction} on ${what} (p=${fmtP(p)})`;
  } else {
    const tail = discordant !== null ? `n=${discordant} discordant pairs` : `n=${aN} vs ${bN} cells`;
    verdict = `No significant difference (p=${fmtP(p)}, ${tail})`;
  }
  return { a: rate(aFail, aN), b: rate(bFail, bN), discordant, test, p_value: p, significant, direction, verdict, cautions };
}
