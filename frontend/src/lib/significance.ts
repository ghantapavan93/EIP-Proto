/**
 * Words and numbers for "is this difference real?": plain-language verdicts
 * from the backend's exact tests, rate/interval formatting, and the shared
 * axis the inline interval bars are drawn on.
 */

import type { ContractComparisonOut, RateOut } from '../api/types';
import { fmtP } from './stats';
import type { Tone } from './vocab';

/** 0.4523 → "45%"; below 10% one decimal ("4.5%") so small rates stay distinguishable. */
export function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const pct = value * 100;
  if (pct > 0 && pct < 10) return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
  return `${Math.round(pct)}%`;
}

/** "33–57%" — the 95% Wilson interval. */
export function fmtCi(r: Pick<RateOut, 'ci_low' | 'ci_high'>): string {
  return `${fmtPct(r.ci_low).replace('%', '')}–${fmtPct(r.ci_high)}`;
}

/** "45% (95% CI 33–57%, 27/60)" for titles and screen readers. */
export function describeRate(r: RateOut): string {
  if (r.rate === null) return 'no scored cells';
  return `${fmtPct(r.rate)} (95% CI ${fmtCi(r)}, ${r.k}/${r.n})`;
}

export function directionTone(direction: string | null | undefined): Tone {
  return direction === 'better' ? 'green' : direction === 'worse' ? 'red' : 'neutral';
}

export function directionLabel(direction: string | null | undefined): string {
  return direction === 'better' ? 'better' : direction === 'worse' ? 'worse' : 'no significant difference';
}

/** True when a raw-significant row does not survive the Holm correction. */
export function lostToHolm(row: Pick<ContractComparisonOut, 'significant' | 'p_holm'>, alpha: number): boolean {
  return row.significant && typeof row.p_holm === 'number' && row.p_holm >= alpha;
}

/**
 * One sentence a non-statistician can act on. The backend's own verdict
 * ("B is significantly worse … (p=…)") stays next to it for the reader who
 * wants the test.
 */
export function plainVerdict(row: ContractComparisonOut, alpha = 0.05, family = 0): string {
  const a = row.a.rate;
  const b = row.b.rate;
  if (row.a.n === 0 && row.b.n === 0) return 'Nothing scored in either run';
  if (row.direction === 'better' || row.direction === 'worse') {
    const head = row.direction === 'better' ? 'B fails less often — unlikely to be chance' : 'B fails more often — unlikely to be chance';
    return lostToHolm(row, alpha) ? `${head} on its own, but not after correcting for ${family || 'all'} contracts` : head;
  }
  if (row.paired && row.discordant === 0) return 'No call changed outcome';
  if (a !== null && b !== null && a === b) return 'Same failure rate; the calls that changed cancel out';
  if (a !== null && b !== null) return `B fails ${b > a ? 'more' : 'less'} often, but the gap could be noise`;
  return 'Not enough scored calls to say';
}

/** "p 0.00073" / "p 0.43"; Holm printed only when the server sent it. */
export function pLine(row: Pick<ContractComparisonOut, 'p_value' | 'p_holm'>): { p: string; holm: string | null } {
  return { p: fmtP(row.p_value), holm: typeof row.p_holm === 'number' ? fmtP(row.p_holm) : null };
}

/**
 * Upper end of the shared axis for interval bars: the largest upper CI bound,
 * rounded up to a 10% step (never below 10%), so small rates are not squashed
 * into the left edge and every row reads on the same scale.
 */
export function axisMax(rates: Array<Pick<RateOut, 'ci_high'>>): number {
  const top = Math.max(0, ...rates.map((r) => r.ci_high));
  return Math.min(1, Math.max(0.1, Math.ceil(top * 10 - 1e-9) / 10));
}

/**
 * A row's cautions, minus the one its verdict already states: when no paired
 * call changed outcome, "too few changed calls" repeats "No call changed
 * outcome" and only adds noise.
 */
export function rowCautions(row: ContractComparisonOut): string[] {
  if (row.paired && row.discordant === 0) return row.cautions.filter((c) => !/too few changed calls/.test(c));
  return row.cautions;
}
