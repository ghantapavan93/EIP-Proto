import { cn } from '../../lib/cn';
import { mean, variance } from '../../lib/stats';

export interface StatBarsProps {
  scores: number[];
  max?: number;
  /** threshold below which the bar reads amber */
  minMean?: number;
  className?: string;
}

/** Five judge scores as small vertical bars, plus mean and variance. */
export function StatBars({ scores, max = 5, minMean = 3.5, className }: StatBarsProps) {
  const m = mean(scores);
  const v = variance(scores);
  const belowMean = m < minMean;
  return (
    <div className={cn('flex items-end gap-4', className)}>
      <div className="flex items-end gap-1" role="img" aria-label={`scores ${scores.join(', ')}`}>
        {scores.map((s, i) => (
          <div key={i} className="flex flex-col items-center gap-1">
            <div className="flex h-12 w-4 items-end border-b border-hairline bg-band">
              <div
                className={cn('w-full', belowMean ? 'bg-amber' : 'bg-teal')}
                style={{ height: `${Math.max(4, (s / max) * 100)}%` }}
                title={`run ${i + 1}: ${s}`}
              />
            </div>
            <span className="font-mono text-[10px] text-ink-2">{s}</span>
          </div>
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 text-[12px]">
        <dt className="text-ink-2">mean</dt>
        <dd className={cn('font-mono', belowMean ? 'text-amber-ink' : 'text-ink')}>{m.toFixed(2)}</dd>
        <dt className="text-ink-2">variance</dt>
        <dd className={cn('font-mono', v > 0.5 ? 'text-amber-ink' : 'text-ink')}>{v.toFixed(2)}</dd>
        <dt className="text-ink-2">n</dt>
        <dd className="font-mono text-ink">{scores.length}</dd>
      </dl>
    </div>
  );
}
