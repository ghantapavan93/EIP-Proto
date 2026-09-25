import { Link } from 'react-router-dom';
import { ArrowRight, GitCompareArrows } from 'lucide-react';
import type { AttributionOut, AttributionVerdict } from '../../api/types';
import type { Tone } from '../../lib/vocab';
import { cn } from '../../lib/cn';
import { Chip } from '../ui/Chip';
import { Eyebrow } from '../ui/Eyebrow';

const VERDICT: Record<AttributionVerdict, { tone: Tone; label: string; border: string }> = {
  isolated: { tone: 'green', label: 'Isolated', border: 'border-l-green' },
  confounded: { tone: 'amber', label: 'Confounded', border: 'border-l-amber' },
  repeat: { tone: 'slate', label: 'Repeat', border: 'border-l-slate' },
};

/**
 * "Can this difference be pinned on one change?" — the first question to ask of any
 * A/B result. Isolated: exactly one factor moved. Confounded: two or more moved, so
 * the page links existing runs that move them one at a time.
 */
export function AttributionPanel({ attribution }: { attribution: AttributionOut }) {
  const v = VERDICT[attribution.verdict];
  return (
    <section
      aria-label="Attribution"
      className={cn('card mb-4 border-l-[3px] px-4 py-3', v.border)}
      data-verdict={attribution.verdict}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow as="h2">Attribution</Eyebrow>
        <Chip tone={v.tone}>{v.label}</Chip>
      </div>
      <p className="mt-1.5 max-w-[80ch] text-[13.5px] leading-snug text-ink">{attribution.summary}</p>
      {attribution.scope_note && (
        <p className="mt-1 max-w-[80ch] text-[12.5px] leading-snug text-ink-2">{attribution.scope_note}</p>
      )}

      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <div className="eyebrow mb-1">Changed</div>
          {attribution.changed.length ? (
            <ul className="space-y-1" aria-label="Changed between A and B">
              {attribution.changed.map((c) => (
                <li key={c.factor} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                  <span className="min-w-[8.5rem] font-semibold text-ink">{c.label}</span>
                  <span className="font-mono text-ink-2">{c.a}</span>
                  <ArrowRight size={12} className="self-center text-ink-3" aria-label="to" />
                  <span className="font-mono text-ink">{c.b}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-ink-3">Nothing: both runs had the same inputs.</p>
          )}
        </div>
        <div>
          <div className="eyebrow mb-1">Held constant</div>
          <div className="flex flex-wrap gap-1" aria-label="Held constant">
            {attribution.held_constant.map((h) => (
              <Chip key={h} size="xs">
                {h}
              </Chip>
            ))}
          </div>
        </div>
      </div>

      {attribution.verdict === 'confounded' && attribution.isolating_pairs.length > 0 && (
        <div className="mt-3 border-t border-hairline pt-2.5">
          <div className="eyebrow mb-1.5">Clean comparisons — one change each</div>
          <ul className="flex flex-wrap gap-2" aria-label="Isolating comparisons">
            {attribution.isolating_pairs.map((p) => (
              <li key={p.factor}>
                <Link
                  to={`/runs/compare?a=${encodeURIComponent(p.a_run_id)}&b=${encodeURIComponent(p.b_run_id)}`}
                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-hairline bg-surface px-2.5 py-1 text-[12.5px] text-teal-ink hover:border-teal hover:bg-teal/5"
                >
                  <GitCompareArrows size={13} aria-hidden />
                  <span>
                    Only the <strong className="font-semibold">{p.label}</strong>
                  </span>
                  <span className="font-mono text-[11px] text-ink-3">
                    {p.a_run_id.slice(0, 8)} → {p.b_run_id.slice(0, 8)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
