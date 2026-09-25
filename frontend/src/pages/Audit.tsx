import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Cog, Link2, ShieldCheck, ShieldAlert, X } from 'lucide-react';
import { useAudit, useAuditActors, useContracts, useRuns, useVerifyAuditChain } from '../api/hooks';
import type { AuditOut, AuditVerifyOut, RunOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Field } from '../components/layout/Page';
import { Chip } from '../components/ui/Chip';
import { JsonView } from '../components/ui/JsonView';
import { KeyValue } from '../components/ui/KeyValue';
import { SkeletonRows } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { fmtNumber, fmtRelative, fmtTs, parsePageParam, shortHash } from '../lib/format';
import { AUDIT_ENTITY_TYPES, AUDIT_EVENT_TYPES } from '../lib/vocab';
import {
  actorName,
  auditEntityLink,
  auditSummary,
  auditTransition,
  eventLabel,
  eventTone,
  isSystemActor,
  SYSTEM_ACTORS,
  type AuditContext,
} from '../lib/audit';
import { cn } from '../lib/cn';

const PAGE_SIZE = 25;
const EVENT_TYPES = [...AUDIT_EVENT_TYPES, 'evidence.exported'].filter((t, i, all) => all.indexOf(t) === i);

/** Who acted: automation reads as a teal "system" chip; people show their role. */
export function ActorCell({ row }: { row: Pick<AuditOut, 'actor' | 'actor_role'> }) {
  const system = isSystemActor(row);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {/* avatar: initials for a person (slate on slate/10, 8.85:1), a gear for automation (teal-ink on teal/10, 5.13:1) */}
      <span
        aria-hidden
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold uppercase',
          system ? 'bg-teal/10 text-teal-ink' : 'bg-slate/10 text-slate',
        )}
      >
        {system ? <Cog size={11} /> : row.actor.slice(0, 2)}
      </span>
      <span className={cn('truncate', system ? 'text-ink-2' : 'font-medium text-ink')} title={row.actor}>
        {actorName(row.actor)}
      </span>
      <Chip tone={system ? 'teal' : row.actor_role === 'unauthenticated' ? 'red' : 'slate'} size="xs">
        {system ? 'system' : row.actor_role ?? 'user'}
      </Chip>
    </span>
  );
}

function HashLine({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 py-0.5">
      <span className="text-ink-2">{label}</span>
      <span className="break-all font-mono text-[11px] text-ink" title={value ?? undefined}>
        {value || '—'}
      </span>
    </div>
  );
}

function AuditDetail({ row, onCorrelation }: { row: AuditOut; onCorrelation: (id: string) => void }) {
  const transition = auditTransition(row);
  const link = auditEntityLink(row);
  const p = row.payload ?? {};
  const quote = typeof p.span === 'string' ? p.span : typeof p.note === 'string' && p.note ? p.note : null;
  const reason = typeof p.reason === 'string' ? p.reason : typeof p.error === 'string' ? p.error : null;
  return (
    <div className="grid grid-cols-1 gap-4 px-3 py-3 text-[12px] lg:grid-cols-2">
      <div className="space-y-3">
        <section>
          <div className="eyebrow mb-1">Evidence</div>
          <KeyValue
            rows={[
              { key: 'Event', value: <span className="font-mono">{row.event_type}</span> },
              { key: 'Entity', value: <span className="font-mono">{row.entity_type} · {row.entity_id}</span> },
              ...(link ? [{ key: 'Open', value: <Link to={link.to}>{link.label} →</Link>, mono: false }] : []),
              ...(reason ? [{ key: 'Reason', value: reason, mono: false }] : []),
            ]}
          />
          {quote && <blockquote className="quote mt-2 text-[12px]">{quote}</blockquote>}
        </section>
        {transition && (
          <section>
            <div className="eyebrow mb-1">Before → after</div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="neutral">{transition.from.replace(/_/g, ' ')}</Chip>
              <span aria-hidden className="text-ink-3">→</span>
              <Chip tone={row.event_type === 'task.transition_rejected' ? 'red' : 'slate'}>{transition.to.replace(/_/g, ' ')}</Chip>
              {typeof p.reason_code === 'string' && <span className="font-mono text-[11px] text-ink-2">{p.reason_code}</span>}
              {row.event_type === 'task.transition_rejected' && <span className="text-[11px] text-red">refused — state unchanged</span>}
            </div>
          </section>
        )}
        <section>
          <div className="eyebrow mb-1">Hashes</div>
          <HashLine label="row_hash" value={row.row_hash} />
          <HashLine label="prev_hash" value={row.prev_hash} />
          <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 py-0.5">
            <span className="text-ink-2">correlation</span>
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-ink">{row.correlation_id ?? '—'}</span>
              {row.correlation_id && (
                <button type="button" className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-ink hover:underline" onClick={() => onCorrelation(row.correlation_id ?? '')}>
                  <Link2 size={11} aria-hidden /> Same action
                </button>
              )}
            </span>
          </div>
        </section>
      </div>
      <section className="min-w-0">
        <div className="eyebrow mb-1">Raw payload</div>
        <JsonView value={row.payload} collapsedBelow={2} className="max-h-[320px] overflow-auto border border-hairline bg-band p-2" />
      </section>
    </div>
  );
}

function VerifyResult({ result }: { result: AuditVerifyOut }) {
  if (result.ok) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[8px] border border-green/40 bg-green/10 px-3.5 py-2 text-[13px] text-ink">
        <ShieldCheck size={15} className="shrink-0 text-green-ink" aria-hidden />
        <span className="font-semibold text-green-ink">Chain verified</span>
        <span className="text-ink-2">
          · every row&apos;s hash recomputed from the row before it · <span className="font-mono text-ink">{fmtNumber(result.checked)}</span> rows · tip{' '}
          <span className="font-mono text-ink" title={result.tip}>
            {shortHash(result.tip, 12)}
          </span>
        </span>
      </div>
    );
  }
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[8px] border border-red/30 bg-red/6 px-3.5 py-2 text-[13px] text-ink">
      <ShieldAlert size={15} className="shrink-0 text-red" aria-hidden />
      <span className="font-semibold text-red">Chain broken at row #{result.first_broken_id}</span>
      <span>
        · {result.reason} · <span className="font-mono">{fmtNumber(result.checked)}</span> rows verified before it
      </span>
    </div>
  );
}

export function AuditPage() {
  useTopBar([{ label: 'Audit' }]);
  const [params, setParams] = useSearchParams();
  const eventType = params.get('event_type') ?? '';
  const entityType = params.get('entity_type') ?? '';
  const entityId = params.get('entity_id') ?? '';
  const actor = params.get('actor') ?? '';
  const correlationId = params.get('correlation_id') ?? '';
  const page = parsePageParam(params.get('page'));
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const verify = useVerifyAuditChain();
  // The real accounts and seeded personas that have acted, not a fixed list of demo names.
  const actors = useAuditActors();
  const people = actors.data ?? [];

  const audit = useAudit({
    event_type: eventType || undefined,
    entity_type: entityType || undefined,
    entity_id: entityId || undefined,
    actor: actor || undefined,
    correlation_id: correlationId || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  // Context for one-line summaries: run identity and contract severities (both usually cached).
  const runs = useRuns();
  const contracts = useContracts();
  const ctx = useMemo<AuditContext>(
    () => ({
      runsById: new Map<string, RunOut>((runs.data ?? []).map((r) => [r.id, r])),
      severityByCode: new Map((contracts.data ?? []).map((c) => [c.code, c.severity])),
    }),
    [runs.data, contracts.data],
  );

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const total = audit.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows = audit.data?.items;

  return (
    <div>
      <PageHeader
        eyebrow="Append-only · hash-chained"
        title="Audit log"
        description="Every state change, in a closed vocabulary — each row carries the hash of the row before it, so an edit anywhere breaks the chain from that row on."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {verify.error ? <span className="text-[12px] text-red">Verify failed: {verify.error.message}</span> : null}
            <button type="button" className="btn btn-outline" onClick={() => verify.mutate()} disabled={verify.isPending}>
              <ShieldCheck size={13} aria-hidden /> {verify.isPending ? 'Verifying…' : 'Verify chain'}
            </button>
          </div>
        }
      />
      {verify.data && (
        <div className="px-4 pb-3 sm:px-6">
          <VerifyResult result={verify.data} />
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3 border-b border-hairline px-4 pb-3 sm:px-6">
        <Field label="Event type" htmlFor="au-event">
          <select id="au-event" className="input h-8 w-[210px] text-[12px]" value={eventType} onChange={(e) => setParam('event_type', e.target.value)}>
            <option value="">all</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {eventLabel(t)} · {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Actor" htmlFor="au-actor">
          <select id="au-actor" className="input h-8 w-[170px] text-[12px]" value={actor} onChange={(e) => setParam('actor', e.target.value)}>
            <option value="">all</option>
            <optgroup label="People">
              {people.map((p) => (
                <option key={p.actor} value={p.actor}>
                  {p.actor} · {p.role}
                </option>
              ))}
            </optgroup>
            <optgroup label="System">
              {SYSTEM_ACTORS.map((a) => (
                <option key={a} value={a}>
                  {actorName(a)}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        <Field label="Entity type" htmlFor="au-entity">
          <select id="au-entity" className="input h-8 w-[140px] text-[12px]" value={entityType} onChange={(e) => setParam('entity_type', e.target.value)}>
            <option value="">all</option>
            {AUDIT_ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Entity id" htmlFor="au-id">
          <input id="au-id" className="input h-8 w-[180px] font-mono text-[12px]" value={entityId} onChange={(e) => setParam('entity_id', e.target.value)} placeholder="run or task id…" />
        </Field>
        {correlationId && (
          <div>
            <span className="label">Same action</span>
            <span className="inline-flex h-8 items-center gap-1 rounded-[6px] border border-teal bg-teal/5 pl-2 pr-1 font-mono text-[12px] text-slate">
              {correlationId}
              <button type="button" className="inline-flex h-5 w-5 items-center justify-center text-ink-2 hover:text-slate" aria-label="Clear correlation filter" onClick={() => setParam('correlation_id', '')}>
                <X size={12} aria-hidden />
              </button>
            </span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2 text-[12px] text-ink-2">
          <span className="font-mono tabular-nums">
            {fmtNumber(total)} events · page {page + 1}/{pages}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setParam('page', String(page - 1))}>
            Prev
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={page + 1 >= pages} onClick={() => setParam('page', String(page + 1))}>
            Next
          </button>
        </div>
      </div>
      <div className="px-4 py-4 sm:px-6">
        <div className="overflow-auto rounded-[8px] border border-hairline bg-surface shadow-[var(--shadow-card)]" style={{ maxHeight: 'calc(100vh - 290px)', minHeight: 240 }}>
          <table className="dt dt-fixed">
            <caption className="sr-only">Audit log</caption>
            <colgroup>
              <col style={{ width: 28 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 176 }} />
              <col style={{ width: 172 }} />
              <col />
              <col style={{ width: 104 }} />
            </colgroup>
            <thead>
              <tr>
                <th aria-label="Expand" />
                <th>When (UTC)</th>
                <th>Actor</th>
                <th>Event</th>
                <th>What happened</th>
                <th>Chain</th>
              </tr>
            </thead>
            <tbody>
              {audit.isLoading ? (
                <SkeletonRows columns={6} rows={8} label="Loading audit events" />
              ) : audit.error && !audit.data ? (
                <tr>
                  <td colSpan={6} className="wrap p-2">
                    <ErrorState error={audit.error} retry={() => void audit.refetch()} />
                  </td>
                </tr>
              ) : !rows?.length ? (
                <tr>
                  <td colSpan={6} className="wrap">
                    <EmptyState
                      title="No events match"
                      hint="Clear a filter to widen the search."
                      action={
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                          Clear filters
                        </button>
                      }
                    />
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const open = expanded.has(row.id);
                  const summary = auditSummary(row, ctx);
                  return (
                    <Fragment key={row.id}>
                      <tr data-clickable="true" data-selected={open ? 'true' : 'false'} tabIndex={0} onClick={() => toggle(row.id)} onKeyDown={(e) => {
                        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          toggle(row.id);
                        }
                      }} aria-expanded={open}>
                        <td className="text-ink-3">{open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}</td>
                        <td title={`#${row.id} · ${fmtTs(row.ts)}`}>
                          <span className="block text-[12px] leading-tight text-ink">{fmtRelative(row.ts)}</span>
                          <span className="block font-mono text-[11px] leading-tight text-ink-3">{fmtTs(row.ts)}</span>
                        </td>
                        <td>
                          <ActorCell row={row} />
                        </td>
                        <td title={row.event_type}>
                          <span className="inline-flex min-w-0 items-center gap-1.5">
                            <span aria-hidden className={cn('inline-block h-2 w-2 shrink-0 rounded-full', { red: 'bg-red', amber: 'bg-amber', green: 'bg-green', teal: 'bg-teal', neutral: 'bg-input', slate: 'bg-slate' }[eventTone(row)])} />
                            <span className="truncate font-medium text-ink">{eventLabel(row.event_type)}</span>
                          </span>
                        </td>
                        <td className="wrap py-1 text-[12.5px] leading-snug text-ink" title={summary}>
                          <span className="line-clamp-2">{summary || <span className="text-ink-3">—</span>}</span>
                        </td>
                        <td title={row.row_hash ? `row_hash ${row.row_hash}${row.prev_hash ? `\nprev_hash ${row.prev_hash}` : ''}` : 'no row hash'}>
                          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-2">
                            <Link2 size={11} className="shrink-0 text-ink-3" aria-hidden />
                            {row.row_hash ? shortHash(row.row_hash, 8) : '—'}
                          </span>
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-canvas">
                          <td colSpan={6} className="wrap h-auto p-0">
                            <AuditDetail row={row} onCorrelation={(id) => setParam('correlation_id', id)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">
          Click a row for its evidence, before → after, hashes and raw payload. “Same action” shows every row written by the same request or CLI command.
        </p>
      </div>
    </div>
  );
}
