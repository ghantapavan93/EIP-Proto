import { Link } from 'react-router-dom';
import { useImpact, useImpactWhatIf } from '../../api/hooks';
import { Chip } from '../ui/Chip';
import { ErrorState } from '../ui/ErrorState';
import { LoadingState } from '../ui/LoadingState';
import { DirectionChip } from './DirectionChip';
import { fmtDate } from '../../lib/format';
import { cn } from '../../lib/cn';

/**
 * The blast radius as if a proposal were enacted, next to the enacted one on
 * the same date. Read-only on the server: no tasks, no audit rows. Labelled
 * HYPOTHETICAL so it is never read as the real exposure.
 */
export function WhatIfImpact({
  code,
  version,
  asOf,
  undated = false,
  voteDate = null,
}: {
  code: string;
  version: number;
  asOf: string;
  undated?: boolean;
  voteDate?: string | null;
}) {
  const whatIf = useImpactWhatIf(code, asOf, version);
  const enacted = useImpact(code, asOf);
  if (whatIf.isLoading) return <LoadingState rows={3} />;
  if (whatIf.error) return <ErrorState error={whatIf.error} title="What-if refused" />;
  const w = whatIf.data;
  if (!w) return null;
  const e = enacted.data;
  const rows: Array<[string, number, number | undefined, string]> = [
    ['Stale artifacts', w.counts.artifacts, e?.counts.artifacts, 'text-ink'],
    ['Stale encodings', w.counts.total, e?.counts.total, 'text-ink'],
    ['Under-restrictive', w.counts.under_restrictive, e?.counts.under_restrictive, 'text-red'],
    ['Over-restrictive', w.counts.over_restrictive, e?.counts.over_restrictive, 'text-amber-ink'],
    ['Re-verify', w.counts.reverify, e?.counts.reverify, 'text-slate'],
  ];
  return (
    <div
      className="rounded-[8px] border-2 border-dashed border-slate/50 bg-band/60 p-3"
      data-testid="what-if-impact"
      aria-label="Hypothetical blast radius"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="slate" filled>
          Hypothetical
        </Chip>
        <span className="text-[12.5px] font-semibold text-ink">
          If v{w.assumed_version ?? version} were enacted · as of {fmtDate(asOf)}
        </span>
      </div>
      {undated && (
        <p className="mt-2 text-[12.5px] leading-snug text-ink">
          v{version} has no date to apply from yet{voteDate ? ` (vote ${fmtDate(voteDate)})` : ''}, so this assumes it
          applies from <span className="font-mono">{fmtDate(asOf)}</span>. Pick another date above to move the
          assumption.
        </p>
      )}
      {!w.hypothetical && (
        <p className="mt-2 text-[12.5px] text-amber-ink">
          {w.note || 'The server did not apply the proposal; this is the enacted history.'}
        </p>
      )}
      <table className="mt-2 w-full text-[12.5px]" aria-label="Hypothetical versus enacted">
        <thead>
          <tr className="text-[11px] uppercase tracking-[0.04em] text-ink-2">
            <th className="py-1 text-left font-semibold" scope="col">
              As of {fmtDate(asOf)}
            </th>
            <th className="py-1 text-right font-semibold" scope="col">
              Enacted
            </th>
            <th className="py-1 text-right font-semibold" scope="col">
              Hypothetical
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, hyp, real, color]) => (
            <tr key={label} className="border-t border-hairline">
              <th scope="row" className="py-1 text-left font-medium text-ink-2">
                {label}
              </th>
              <td className="py-1 text-right font-mono text-ink-2">{real ?? '…'}</td>
              <td className={cn('py-1 text-right font-mono font-semibold', hyp ? color : 'text-ink-3')}>{hyp}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {w.stale.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-label="Artifacts that would be stale">
          {w.stale.map((it) => (
            <li key={it.edge.id} className="text-[12px] leading-snug">
              <div className="flex flex-wrap items-center gap-1.5">
                <DirectionChip direction={it.direction} />
                <Link to={`/artifacts/${encodeURIComponent(it.edge.asset_code)}`} className="font-semibold text-ink">
                  {it.edge.asset_name}
                </Link>
                <span className="font-mono text-[11px] text-ink-3">
                  bound v{it.bound_version} → v{it.in_force_version}
                </span>
              </div>
              <div className="text-ink-2">{it.reason}</div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11.5px] leading-snug text-ink-3">
        {w.note || 'Nothing was written: no review tasks, no audit rows.'}
      </p>
    </div>
  );
}
