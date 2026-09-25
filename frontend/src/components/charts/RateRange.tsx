import type { RateOut } from '../../api/types';
import { cn } from '../../lib/cn';
import { describeRate } from '../../lib/significance';
import type { Tone } from '../../lib/vocab';

/* Interval colour per tone: the 95% CI as a bar, the point estimate as a tick. Semantic only. */
const BAR: Record<Tone, string> = {
  neutral: 'bg-ink-3/35',
  slate: 'bg-slate/35',
  teal: 'bg-teal/45',
  green: 'bg-green/55',
  amber: 'bg-amber/45',
  red: 'bg-red/35',
};
const TICK: Record<Tone, string> = {
  neutral: 'bg-ink-2',
  slate: 'bg-slate',
  teal: 'bg-teal-ink',
  green: 'bg-green-ink',
  amber: 'bg-amber-ink',
  red: 'bg-red',
};

function pos(value: number, max: number): string {
  return `${Math.max(0, Math.min(100, (value / (max || 1)) * 100))}%`;
}

/**
 * One rate on a shared 0–max axis: a faint track, the 95% Wilson interval as
 * a bar, and a 2px tick at the point estimate. Purely visual; the numbers sit
 * next to it in text, and the accessible name repeats them.
 */
export function RateRange({ rate, max, tone = 'neutral', className, label }: { rate: RateOut; max: number; tone?: Tone; className?: string; label?: string }) {
  const empty = rate.rate === null;
  return (
    <div
      role="img"
      aria-label={`${label ? `${label}: ` : ''}${describeRate(rate)}`}
      className={cn('relative h-2.5 w-full rounded-[2px] bg-band', className)}
    >
      {!empty && (
        <>
          <span aria-hidden className={cn('absolute top-[3px] h-1 rounded-[1px]', BAR[tone])} style={{ left: pos(rate.ci_low, max), width: `calc(${pos(rate.ci_high, max)} - ${pos(rate.ci_low, max)} + 1px)` }} />
          <span aria-hidden className={cn('absolute top-0 h-2.5 w-[2px] -translate-x-1/2 rounded-[1px]', TICK[tone])} style={{ left: pos(rate.rate ?? 0, max) }} />
        </>
      )}
    </div>
  );
}

/** A above B on the same axis: A in neutral grey, B in the direction's colour. */
export function RatePair({ a, b, max, bTone, className }: { a: RateOut; b: RateOut; max: number; bTone: Tone; className?: string }) {
  return (
    <div className={cn('grid grid-cols-[12px_minmax(0,1fr)] items-center gap-x-1.5 gap-y-1', className)}>
      <span className="font-mono text-[10px] leading-none text-ink-3">A</span>
      <RateRange rate={a} max={max} tone="neutral" label="Run A failure rate" />
      <span className="font-mono text-[10px] leading-none text-ink-3">B</span>
      <RateRange rate={b} max={max} tone={bTone === 'neutral' ? 'slate' : bTone} label="Run B failure rate" />
    </div>
  );
}
