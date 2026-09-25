import { isValidElement, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ReviewTaskOut, StatusOut } from '../../api/types';
import { HealthPopover } from './HealthPopover';
import { Chip } from '../ui/Chip';
import { fmtRelative, fmtTs } from '../../lib/format';
import { gateTone } from '../../lib/vocab';
import { groupActionable, taskLane } from '../../lib/review';
import { cn } from '../../lib/cn';

function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[12px] font-semibold tabular-nums text-ink', className)}>{children}</span>;
}

function Item({ to, title, children }: { to?: string; title?: string; children: ReactNode }) {
  const cls = 'inline-flex shrink-0 items-center gap-1 text-ink-2';
  return to ? (
    <Link to={to} title={title} className={cn(cls, 'hover:text-teal-ink hover:no-underline')}>
      {children}
    </Link>
  ) : (
    <span title={title} className={cls}>
      {children}
    </span>
  );
}

function Sep() {
  return (
    <span aria-hidden className="shrink-0 text-input">
      ·
    </span>
  );
}

/** Minute-resolution clock so "2m ago" stays true between polls. */
function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * The live system state for the top bar, from GET /api/status: the health word
 * (opens the component popover) and when the last run finished, with its gate.
 * The one place the teal wash is allowed: around the active system state.
 */
export function SystemPulse({ status }: { status: StatusOut | undefined }) {
  const now = useNow();
  const run = status?.last_run ?? null;
  return (
    <div role="group" aria-label="System state" className="flex min-w-0 items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.06em]">
      <HealthPopover status={status?.status ?? null} fallback={status?.components} />
      {status && (
        <Link
          to={run ? `/runs/${run.id}` : '/runs'}
          className="hidden shrink-0 items-center gap-1.5 text-ink-2 hover:text-teal-ink hover:no-underline md:inline-flex"
          title={run ? `Run ${run.id} · ${run.model_id} · prompt v${run.prompt_version} · ${run.trigger} · finished ${fmtTs(run.finished_at)}` : 'No completed run yet'}
        >
          last run
          {run ? (
            <>
              <Num className="normal-case tracking-normal">{fmtRelative(run.finished_at, now)}</Num>
              <Chip tone={gateTone(run.gate)} size="xs">
                {run.gate}
              </Chip>
            </>
          ) : (
            <Num>none</Num>
          )}
        </Link>
      )}
    </div>
  );
}

/**
 * Compact counts strip under the top bar, from GET /api/status (polled 30 s):
 * rules · artifacts · contracts · golden cases · review · advisory · chain.
 * Neutral by default; colour only where it carries meaning (the review chip,
 * the chain word).
 */
export function StatusRail({
  status,
  openTasks,
  error,
}: {
  status: StatusOut | undefined;
  /** open tasks (any lane), for the group count on the review item */
  openTasks?: ReviewTaskOut[];
  error?: unknown;
}) {
  const actionableTasks = openTasks?.filter((t) => taskLane(t) === 'actionable');
  const layout = actionableTasks ? groupActionable(actionableTasks) : null;

  // advisory + audit chain are extras beyond the core strip: shown on wide screens only, so 1280px never scrolls
  const WIDE_ONLY = new Set(['advisory', 'chain']);
  const items: ReactNode[] = status
    ? [
        <Item key="rules" to="/rules" title="Rules loaded from rules/*.yaml">
          <Num>{status.counts.rules}</Num> rules
        </Item>,
        <Item key="artifacts" to="/artifacts" title="Registered artifacts">
          <Num>{status.counts.artifacts}</Num> artifacts
        </Item>,
        <Item key="contracts" to="/contracts" title="Contracts every run is scored against">
          <Num>{status.counts.contracts}</Num> contracts
        </Item>,
        <Item key="golden" to="/evals" title="Golden Matcher Suite fixtures">
          <Num>{status.counts.golden_cases}</Num> golden cases
        </Item>,
        <Item
          key="review"
          to="/review"
          title={
            layout
              ? `${status.review.actionable_open} open tasks a human must decide: ${layout.groups.reduce((n, g) => n + g.tasks.length, 0)} blocking-failure calls in ${layout.groups.length} run × contract groups, plus ${layout.individual.length} artifact / source tasks`
              : 'Open tasks a human must decide'
          }
        >
          <Chip tone={status.review.actionable_open ? 'amber' : 'neutral'} size="xs">
            review
          </Chip>
          <Num>{status.review.actionable_open}</Num> actionable
          {layout !== null && status.review.actionable_open > 0 && (
            <span className="font-medium normal-case tracking-normal text-ink-3">
              ({layout.groups.length} {layout.groups.length === 1 ? 'group' : 'groups'} · {layout.individual.length} {layout.individual.length === 1 ? 'task' : 'tasks'})
            </span>
          )}
        </Item>,
        <Item key="advisory" to="/review?lane=advisory" title="Advisory observations — visible, not tickets">
          <Num>{status.review.advisory_open}</Num> advisory
        </Item>,
        <Item key="chain" to="/audit" title={status.audit_chain.verified ? `Audit hash chain verified over ${status.audit_chain.rows} rows` : 'Audit hash chain did not verify — open the audit log'}>
          chain{' '}
          <span className={status.audit_chain.verified ? 'text-green-ink' : 'text-red'}>{status.audit_chain.verified ? 'verified' : 'broken'}</span>
          <Num>{status.audit_chain.rows}</Num>
        </Item>,
      ]
    : [];

  return (
    <div
      role="region"
      aria-label="System status"
      className="flex h-8 min-w-0 items-center gap-2 border-b border-hairline bg-canvas px-3 text-[11px] font-semibold uppercase tracking-[0.05em] sm:px-6"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
        {status ? (
          items.map((node, i) => {
            const key = isValidElement(node) ? String(node.key) : String(i);
            return (
              <span key={key} className={cn('shrink-0 items-center gap-2.5', WIDE_ONLY.has(key) ? 'hidden 2xl:inline-flex' : 'inline-flex')}>
                {i > 0 && <Sep />}
                {node}
              </span>
            );
          })
        ) : error ? (
          <span className="normal-case tracking-normal text-red">status unavailable — {error instanceof Error ? error.message : 'request failed'}</span>
        ) : (
          <span className="normal-case tracking-normal text-ink-3" role="status">
            loading status…
          </span>
        )}
      </div>
    </div>
  );
}
