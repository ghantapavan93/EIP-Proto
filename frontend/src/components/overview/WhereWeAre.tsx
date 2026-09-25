import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, X } from 'lucide-react';
import { useImpactsAt, useReviewTasks, useRules, useRuns, useStatus } from '../../api/hooks';
import type { RunOut } from '../../api/types';
import { flipDate } from '../../lib/guide';
import { groupActionable, taskLane } from '../../lib/review';
import { latestByTrigger } from '../../lib/runStats';
import { fmtDate, fmtNumber } from '../../lib/format';
import { cn } from '../../lib/cn';
import { GateChip } from '../runs/GateChip';
import { TickNumber } from '../ui/TickNumber';
import { latestGoverning } from '../../lib/ruleVersions';

export const HONEST_LINE = 'Prototype · synthetic calls · real public pages · recorded real-model runs';

function Step({ n, title, to, children, stale }: { n: number; title: string; to: string; children: ReactNode; stale?: boolean }) {
  return (
    <li className="min-w-0">
      <Link
        to={to}
        className="group flex h-full gap-2.5 rounded-[6px] px-2 py-2 text-ink transition-colors hover:bg-teal/6 hover:no-underline"
      >
        <span
          aria-hidden
          className={cn(
            'mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-semibold',
            stale ? 'border-amber/50 bg-amber/12 text-amber-ink' : 'border-teal/40 bg-teal/10 text-teal-ink',
          )}
        >
          {n}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1 text-[12.5px] font-semibold text-ink">
            <span className="sr-only">Step {n}: </span>
            {title}
            <ArrowRight size={12} aria-hidden className="text-ink-3 transition-transform group-hover:text-teal-ink motion-safe:group-hover:translate-x-0.5 motion-reduce:transition-none" />
          </span>
          <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-2">{children}</span>
        </span>
      </Link>
    </li>
  );
}

function gateLine(label: string, run: RunOut | undefined) {
  if (!run) return null;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {label} <GateChip gate={run.gate} />
    </span>
  );
}

/**
 * "Where we are": the whole story in four live steps, above the trigger
 * cards. Each step is a link to the screen that proves it; every number is
 * read from the API. Dismissible (remembered in localStorage).
 */
export function WhereWeAre({ today, onDismiss, animate }: { today: string; onDismiss: () => void; animate: boolean }) {
  const rules = useRules();
  const runs = useRuns();
  const status = useStatus();
  const open = useReviewTasks({ state: 'open' });

  const latestDates = useMemo(
    () => (rules.data ?? []).map((r) => latestGoverning(r)?.effective_from).filter((d): d is string => Boolean(d)),
    [rules.data],
  );
  const flip = flipDate(latestDates, today);
  const codes = useMemo(() => (rules.data ?? []).map((r) => r.code), [rules.data]);
  const impacts = useImpactsAt(codes, flip ?? '');
  const impactsReady = codes.length > 0 && impacts.every((q) => q.data);
  const stale = impacts.reduce((n, q) => n + (q.data?.counts.total ?? 0), 0);
  const staleArtifacts = new Set(impacts.flatMap((q) => q.data?.stale.map((s) => s.edge.asset_code) ?? [])).size;
  const heaviest = impacts.map((q) => q.data).filter(Boolean).sort((a, b) => (b?.counts.total ?? 0) - (a?.counts.total ?? 0))[0];

  const promptRun = latestByTrigger(runs.data, 'PROMPT');
  const modelRun = latestByTrigger(runs.data, 'MODEL');
  const actionable = (open.data ?? []).filter((t) => taskLane(t) === 'actionable');
  const groups = groupActionable(actionable).groups.length;
  const advisory = (open.data ?? []).length - actionable.length;
  const chain = status.data?.audit_chain;

  return (
    <section aria-label="Where we are" className="card accent-card px-3 pb-2.5 pt-3 sm:px-4">
      <div className="flex items-start justify-between gap-3 px-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-ink">Where we are</h2>
          <p className="mt-0.5 text-[12px] text-ink-2">{HONEST_LINE}</p>
        </div>
        <button type="button" className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[12px] text-ink-2 transition-colors hover:bg-band hover:text-ink" onClick={onDismiss} aria-label="Hide the where-we-are guide">
          <X size={13} aria-hidden /> <span className="hidden sm:inline">Hide</span>
        </button>
      </div>
      <ol className={cn('mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-4', animate && 'stagger')}>
        <Step n={1} title={flip ? `${fmtDate(flip)} rule change` : 'Rule change'} to={heaviest && flip ? `/rules/${encodeURIComponent(heaviest.rule_code)}?as_of=${flip}` : '/rules'} stale={stale > 0}>
          {impactsReady ? (
            <>
              <span className={cn('font-mono font-semibold', stale ? 'text-amber-ink' : 'text-green-ink')}>
                <TickNumber value={stale} from={0} />
              </span>{' '}
              stale {stale === 1 ? 'encoding' : 'encodings'}
              {staleArtifacts > 0 && <> in {staleArtifacts} artifacts</>}
            </>
          ) : (
            'counting stale encodings…'
          )}
        </Step>
        <Step n={2} title="Prompt & model changes" to="/runs">
          {promptRun || modelRun ? (
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              {gateLine(promptRun ? `prompt v${promptRun.prompt_version}` : '', promptRun)}
              {gateLine('model swap', modelRun)}
            </span>
          ) : (
            'no prompt or model run yet'
          )}
        </Step>
        <Step n={3} title="Review" to="/review">
          {open.data ? (
            <>
              <span className="font-mono font-semibold text-ink">{fmtNumber(actionable.length)}</span> actionable ({groups} {groups === 1 ? 'group' : 'groups'}) · <span className="font-mono">{fmtNumber(advisory)}</span> advisory
            </>
          ) : (
            'loading…'
          )}
        </Step>
        <Step n={4} title="Evidence" to="/audit">
          {chain ? (
            <>
              audit chain{' '}
              <span className={chain.verified ? 'font-semibold text-green-ink' : 'font-semibold text-red'}>{chain.verified ? 'verified' : 'broken'}</span> (<span className="font-mono">{fmtNumber(chain.rows)}</span> rows)
            </>
          ) : (
            'loading…'
          )}
        </Step>
      </ol>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-2 pt-2.5">
        <p className="text-[12.5px] text-ink-2">Have a script or page of your own? See what Backstop makes of it — nothing is stored.</p>
        <Link to="/try" className="btn btn-sm hover:no-underline">
          Try it with your own text <ArrowRight size={13} aria-hidden />
        </Link>
      </div>
    </section>
  );
}
