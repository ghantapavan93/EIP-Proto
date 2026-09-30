/**
 * Words and numbers for "is this difference real?": plain-language verdicts
 * from the backend's exact tests, rate/interval formatting, and the shared
 * axis the inline interval bars are drawn on.
 */

import type { ContractComparisonOut, RateOut } from '../api/types';
import { fmtP, MIN_DISCORDANT } from './stats';
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

/**
 * True when the raw test was significant but the row did not survive the
 * Holm correction across the per-contract family (`significant_holm` is
 * null on the ALL-BLOCK row, which is a single test).
 */
export function lostToHolm(row: Pick<ContractComparisonOut, 'significant' | 'significant_holm'>): boolean {
  return row.significant && row.significant_holm === false;
}

/** Whether B fails more often than A: from the changed calls when paired, else from the two rates. */
function bFailsMore(row: ContractComparisonOut): boolean {
  if (row.paired) return row.paired.b_only_fail > row.paired.a_only_fail;
  return (row.b.rate ?? 0) > (row.a.rate ?? 0);
}

/**
 * One sentence a non-statistician can act on. `direction` is the server's
 * conclusion (already "none" when too few calls changed or the row fails
 * Holm); the backend's own verdict with the test stays next to it.
 */
export function plainVerdict(row: ContractComparisonOut, family = 0): string {
  const a = row.a.rate;
  const b = row.b.rate;
  if (row.a.n === 0 && row.b.n === 0) return 'Nothing scored in either run';
  if (row.direction === 'better') return 'B fails less often — unlikely to be chance';
  if (row.direction === 'worse') return 'B fails more often — unlikely to be chance';
  const more = bFailsMore(row) ? 'more' : 'less';
  if (lostToHolm(row))
    return `B fails ${more} often — unlikely to be chance on its own, but not after correcting for ${family || 'all'} contracts`;
  if (
    row.significant &&
    row.paired &&
    row.discordant !== null &&
    row.discordant > 0 &&
    row.discordant < MIN_DISCORDANT
  ) {
    return `B fails ${more} often, but only ${row.discordant} ${row.discordant === 1 ? 'call' : 'calls'} changed outcome — too few to conclude`;
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
