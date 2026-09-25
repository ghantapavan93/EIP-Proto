import type { OutcomeCounts } from '../../api/types';
import { fmtNumber } from '../../lib/format';
import { cn } from '../../lib/cn';

/**
 * Segment fills. Every one is ≥3:1 against the white card (non-text minimum):
 * green-ink 5.57 · red 6.80 · amber 3.19 · slate 10.46. The legend beside the
 * bar carries the same numbers as text, so colour is never the only channel.
 */
const SEGMENTS: Array<{ key: keyof OutcomeCounts; label: string; bar: string; dot: string }> = [
  { key: 'PASS', label: 'pass', bar: 'bg-green-ink', dot: 'bg-green-ink' },
  { key: 'FAIL', label: 'fail', bar: 'bg-red', dot: 'bg-red' },
  { key: 'FLAG', label: 'flag', bar: 'bg-amber', dot: 'bg-amber' },
  { key: 'ERROR', label: 'error', bar: 'bg-slate', dot: 'bg-slate' },
];

/**
 * One-glance stacked bar of a run's contract results: PASS / FAIL / FLAG /
 * ERROR proportions, with a text legend that doubles as the accessible
 * equivalent. Segments are proportional; a non-zero minority gets at least
 * 2px so a single failure never disappears.
 */
export function OutcomeBar({ counts, className, caption = 'contract results' }: { counts: OutcomeCounts & { total: number }; className?: string; caption?: string }) {
  const summary = SEGMENTS.map((s) => `${fmtNumber(counts[s.key])} ${s.label}`).join(' · ');
  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-[2px] bg-band" role="img" aria-label={`${summary} of ${fmtNumber(counts.total)} ${caption}`}>
        {SEGMENTS.map((s) =>
          counts[s.key] > 0 ? (
            <span
              key={s.key}
              className={cn('h-full', s.bar)}
              style={{ flexGrow: counts[s.key], flexBasis: 0, minWidth: 2 }}
              title={`${s.key} ${fmtNumber(counts[s.key])} of ${fmtNumber(counts.total)}`}
            />
          ) : null,
        )}
      </div>
      <div aria-hidden className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] leading-none text-ink-2 tabular-nums">
        {SEGMENTS.map((s) => (
          <span key={s.key} className={cn('inline-flex items-center gap-1', counts[s.key] === 0 && 'text-ink-3')}>
            <span className={cn('h-1.5 w-1.5 rounded-[1px]', counts[s.key] ? s.dot : 'bg-input')} />
            <span className={cn('font-mono', counts[s.key] > 0 && s.key !== 'PASS' ? 'font-semibold text-ink' : '')}>{fmtNumber(counts[s.key])}</span> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
