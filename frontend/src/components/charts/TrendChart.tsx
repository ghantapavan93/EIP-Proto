import { useState } from 'react';
import type { TrendPointOut } from '../../api/types';
import { cn } from '../../lib/cn';
import { axisMax, describeRate, fmtCi, fmtPct } from '../../lib/significance';
import { fmtDate } from '../../lib/format';

const W = 640;
const H = 132;
const PAD_X = 14;
const PAD_TOP = 10;
const PAD_BOTTOM = 14;

function corpusName(corpus: string): string {
  return corpus === 'holdout' ? 'held-out' : corpus === 'synthetic' ? 'development' : corpus;
}

/**
 * The x-axis caption. When every run started within the same hour (the demo replays its
 * recorded runs at startup) a date range would read as a trend over one instant, so the
 * caption says the points are in run order instead.
 */
function spanLabel(first: string, last: string, n: number): string {
  const hour = 60 * 60 * 1000;
  if (Math.abs(Date.parse(last) - Date.parse(first)) < hour) {
    return `${n} runs in run order, all started ${fmtDate(first)} (replayed together, not a trend over time)`;
  }
  return `${fmtDate(first)} → ${fmtDate(last)}`;
}

/**
 * Failure rate per run, oldest → newest: a 2px line through the observed
 * rates, a whisker for each 95% interval, filled dots for development runs
 * and hollow dots for held-out runs (the number that measures overfitting).
 * One series, so no legend box: the caption names it. Hover or focus a
 * point for its run; the table below carries every value.
 */
export function TrendChart({ points, className }: { points: TrendPointOut[]; className?: string }) {
  const [active, setActive] = useState<number | null>(null);
  if (!points.length) return null;
  const max = axisMax(points.map((p) => p.failure));
  const x = (i: number) => (points.length === 1 ? W / 2 : PAD_X + (i * (W - 2 * PAD_X)) / (points.length - 1));
  const y = (v: number) => PAD_TOP + (1 - Math.min(v, max) / max) * (H - PAD_TOP - PAD_BOTTOM);
  const scored = points.map((p, i) => ({ p, i })).filter(({ p }) => p.failure.rate !== null);
  const line = scored.map(({ p, i }, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.failure.rate ?? 0).toFixed(1)}`).join(' ');
  const hot = active !== null ? points[active] : null;
  const hasHoldout = points.some((p) => p.corpus === 'holdout');

  return (
    <div className={cn('relative', className)}>
      <div className="flex items-start gap-2">
        <div className="flex h-[132px] w-[26px] shrink-0 flex-col justify-between py-[6px] text-right font-mono text-[10px] text-ink-3" aria-hidden>
          <span>{fmtPct(max)}</span>
          <span>0%</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[132px] w-full" preserveAspectRatio="none" role="img" aria-label={`Failure rate across ${points.length} runs, oldest to newest`}>
          <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--color-hairline)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={y(max / 2)} y2={y(max / 2)} stroke="var(--color-hairline)" strokeWidth={1} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          {scored.map(({ p, i }) => (
            <line key={`w-${p.run_id}`} x1={x(i)} x2={x(i)} y1={y(p.failure.ci_low)} y2={y(p.failure.ci_high)} stroke="var(--color-slate)" strokeOpacity={0.35} strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={line} fill="none" stroke="var(--color-teal-ink)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      {/* dots are HTML so they stay round under the stretched viewBox, and take focus for keyboard readers */}
      <div className="pointer-events-none absolute inset-y-0 left-[34px] right-0" style={{ height: 132 }}>
        {scored.map(({ p, i }) => (
          <button
            key={p.run_id}
            type="button"
            className="pointer-events-auto absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-2"
            style={{ left: `${(x(i) / W) * 100}%`, top: y(p.failure.rate ?? 0) }}
            aria-label={`${fmtDate(p.started_at)} · ${p.model_id} prompt v${p.prompt_version} · ${corpusName(p.corpus)} · ${describeRate(p.failure)}`}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            data-corpus={p.corpus}
          >
            <span
              aria-hidden
              className={cn(
                'block h-2.5 w-2.5 rounded-full border-2 border-teal-ink ring-2 ring-surface',
                p.corpus === 'holdout' ? 'bg-surface' : 'bg-teal-ink',
                active === i && 'h-3 w-3',
              )}
            />
          </button>
        ))}
      </div>
      {hot && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-[6px] bg-ink px-2 py-1 text-[11.5px] leading-snug text-on-navy shadow-[0_8px_24px_-8px_rgb(16_24_40/0.35)]"
          style={{ left: `calc(34px + (100% - 34px) * ${x(active ?? 0) / W})`, top: Math.max(0, y(hot.failure.rate ?? 0) - 52) }}
          role="status"
        >
          <div className="font-mono">
            {fmtPct(hot.failure.rate)} · CI {fmtCi(hot.failure)} · {hot.failure.k}/{hot.failure.n}
          </div>
          <div className="whitespace-nowrap">
            {hot.model_id} · v{hot.prompt_version} · {corpusName(hot.corpus)}
          </div>
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 pl-[34px] text-[11px] text-ink-3">
        <span>
          {spanLabel(points[0].started_at, points[points.length - 1].started_at, points.length)} · line: observed failure rate · bar: 95% interval
        </span>
        {hasHoldout && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full border-2 border-teal-ink bg-surface" /> held-out run
          </span>
        )}
      </div>
    </div>
  );
}
