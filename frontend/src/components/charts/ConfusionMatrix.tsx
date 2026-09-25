import type { ConfusionOut } from '../../api/types';
import { cn } from '../../lib/cn';

/**
 * The 2×2 with positive = violation, in words a compliance lead uses:
 * violations caught / missed, false alarms, correctly compliant. Rows are the
 * ground truth, columns what the model said. When true negatives cannot be
 * counted (per-phrase flags) that cell says so instead of showing a zero.
 */
export function ConfusionMatrix({ confusion, className }: { confusion: ConfusionOut; className?: string }) {
  const c = confusion;
  const cell = 'flex flex-col justify-between gap-1 rounded-[6px] border px-3 py-2.5 min-h-[76px]';
  const unit = c.unit === 'call' ? 'calls' : `${c.unit}s`;
  return (
    <figure className={cn('m-0', className)} aria-label={`Confusion matrix per ${c.unit}, positive = violation`}>
      <div className="grid grid-cols-[76px_minmax(0,1fr)_minmax(0,1fr)] gap-1.5 text-[12px]">
        <span />
        <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-2">Model: violation</span>
        <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-2">Model: compliant</span>

        <span className="self-center text-[11px] font-semibold uppercase leading-tight tracking-[0.04em] text-ink-2">
          Truth: violation
        </span>
        <div className={cn(cell, 'border-green/40 bg-green/10')} data-testid="cm-tp">
          <span className="stat text-[22px] text-green-ink">{c.tp}</span>
          <span className="leading-tight text-ink">violations caught</span>
        </div>
        <div className={cn(cell, c.fn ? 'border-red/35 bg-red/8' : 'border-hairline bg-surface')} data-testid="cm-fn">
          <span className={cn('stat text-[22px]', c.fn ? 'text-red' : 'text-ink-3')}>{c.fn}</span>
          <span className="leading-tight text-ink">violations missed</span>
        </div>

        <span className="self-center text-[11px] font-semibold uppercase leading-tight tracking-[0.04em] text-ink-2">
          Truth: compliant
        </span>
        <div className={cn(cell, c.fp ? 'border-amber/40 bg-amber/10' : 'border-hairline bg-surface')} data-testid="cm-fp">
          <span className={cn('stat text-[22px]', c.fp ? 'text-amber-ink' : 'text-ink-3')}>{c.fp}</span>
          <span className="leading-tight text-ink">false alarms</span>
        </div>
        <div className={cn(cell, 'border-hairline bg-band')} data-testid="cm-tn">
          {c.tn === null ? (
            <>
              <span className="stat text-[15px] text-ink-3">n/a</span>
              <span className="leading-tight text-ink-2">correctly compliant — not countable per {c.unit}</span>
            </>
          ) : (
            <>
              <span className="stat text-[22px] text-ink">{c.tn}</span>
              <span className="leading-tight text-ink">correctly compliant</span>
            </>
          )}
        </div>
      </div>
      <figcaption className="mt-2 text-[11.5px] leading-snug text-ink-3">
        Counted per {c.unit}; positive = violation. {c.tp + c.fn} {c.tp + c.fn === 1 ? 'violation' : 'violations'} in the ground truth
        {c.tn !== null ? `, ${c.fp + c.tn} compliant ${unit}` : ''}.
      </figcaption>
    </figure>
  );
}
