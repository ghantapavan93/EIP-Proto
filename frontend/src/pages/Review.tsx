import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useContracts, useReviewTasks, useRuns } from '../api/hooks';
import type { ContractOut, ReviewTaskOut, RunOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section, Field } from '../components/layout/Page';
import { DataTable } from '../components/ui/DataTable';
import { Chip } from '../components/ui/Chip';
import { DirectionChip } from '../components/rules/DirectionChip';
import { GateChip } from '../components/runs/GateChip';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { SkeletonRows } from '../components/ui/Skeleton';
import { TaskDrawer, TaskSubject } from '../components/review/TaskDrawer';
import { fmtDate, fmtNumber, fmtTs, shortHash } from '../lib/format';
import { kindLabel, kindTone, REVIEW_KINDS, REVIEW_STATES, roleLabel, stateLabel, stateTone } from '../lib/vocab';
import { str, strList } from '../lib/evidence';
import { cn } from '../lib/cn';
import {
  countByLane,
  filterTasksByRun,
  groupActionable,
  taskLane,
  TERMINAL_REVIEW_STATES,
  type FlaggedGroup,
} from '../lib/review';
import { shortModel } from '../lib/audit';

type LaneView = 'actionable' | 'advisory' | 'all';

function laneParam(value: string | null): LaneView {
  return value === 'advisory' || value === 'all' ? value : 'actionable';
}

function ownerOf(contract: ContractOut | undefined, tasks: ReviewTaskOut[]): string {
  return contract?.owner_role ?? tasks[0]?.assignee_role ?? '—';
}

/** Per-call flagged results from one contract in one run, collapsed to a single decision header. */
function FlaggedGroupBlock({
  group,
  contract,
  run,
  selectedId,
  onOpen,
  defaultOpen,
}: {
  group: FlaggedGroup<ReviewTaskOut>;
  contract: ContractOut | undefined;
  run: RunOut | undefined;
  selectedId: string | null;
  onOpen: (id: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const n = group.tasks.length;
  const states = new Map<string, number>();
  for (const t of group.tasks) states.set(t.state, (states.get(t.state) ?? 0) + 1);
  const panelId = `grp-${group.key.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  return (
    <div className="border border-hairline bg-surface">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-band"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-ink-3" aria-hidden />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-ink-3" aria-hidden />
        )}
        <span className="min-w-0 text-[13px]">
          <span className="font-mono font-semibold text-navy">{group.contractCode}</span>
          {contract && <span className="text-slate"> · {contract.title}</span>}
          <span className="text-ink-2"> — </span>
          <span className="font-mono font-semibold tabular-nums text-ink">{n}</span>
          <span className="text-ink-2"> {n === 1 ? 'call' : 'calls'}</span>
        </span>
        <span className="font-mono text-[11px] text-ink-2">
          {run ? (
            <>
              run v{run.prompt_version} · {shortModel(run.model_id)} · {fmtDate(run.rule_date)}
            </>
          ) : group.runId ? (
            <>run {shortHash(group.runId, 8)}</>
          ) : (
            'no run'
          )}
        </span>
        <span className="text-[11px] text-ink-2" title={ownerOf(contract, group.tasks)}>
          owner {roleLabel(ownerOf(contract, group.tasks))}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {[...states.entries()].map(([st, count]) => (
            <Chip key={st} tone={stateTone(st)} size="xs">
              {count} {stateLabel(st)}
            </Chip>
          ))}
          {contract && (
            <Chip tone={contract.severity === 'BLOCK' ? 'red' : 'amber'} size="xs">
              {contract.severity}
            </Chip>
          )}
          {run && <GateChip gate={run.gate} />}
        </span>
      </button>
      {open && (
        <div id={panelId} className="border-t border-hairline">
          <table className="dt dt-compact">
            <caption className="sr-only">{group.contractCode} flagged calls</caption>
            <thead>
              <tr>
                <th>Task</th>
                <th>Transcript</th>
                <th>State</th>
                <th>Opened</th>
                <th>Reason code</th>
              </tr>
            </thead>
            <tbody>
              {group.tasks.map((t) => (
                <tr
                  key={t.id}
                  data-clickable="true"
                  data-selected={selectedId === t.id ? 'true' : 'false'}
                  tabIndex={0}
                  onClick={() => onOpen(t.id)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      onOpen(t.id);
                    }
                  }}
                >
                  <td className="font-mono text-[12px]" title={t.id}>
                    {shortHash(t.id, 8)}
                  </td>
                  <td className="font-mono text-[12px] font-semibold text-navy">{t.transcript_code ?? '—'}</td>
                  <td>
                    <Chip tone={stateTone(t.state)}>{stateLabel(t.state)}</Chip>
                  </td>
                  <td className="font-mono text-[12px]">{fmtTs(t.opened_at)}</td>
                  <td className="font-mono text-[12px]">{t.reason_code ?? <span className="text-ink-3">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Advisory lane: aggregate observations from runs — read, not worked. */
function AdvisoryList({
  tasks,
  runsById,
  contractsByCode,
  onOpen,
}: {
  tasks: ReviewTaskOut[];
  runsById: Map<string, RunOut>;
  contractsByCode: Map<string, ContractOut>;
  onOpen: (id: string) => void;
}) {
  if (!tasks.length) {
    return (
      <EmptyState
        title="No advisory observations"
        hint="FLAG-severity and judged contracts report here as one aggregate per run and contract."
      />
    );
  }
  return (
    <ul className="divide-y divide-hairline border border-hairline bg-surface">
      {tasks.map((t) => {
        const transcripts = strList(t.payload.flagged_transcripts);
        const run = t.run_id ? runsById.get(t.run_id) : undefined;
        const contract = t.contract_code ? contractsByCode.get(t.contract_code) : undefined;
        return (
          <li key={t.id}>
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-band lg:grid lg:grid-cols-[auto_minmax(0,1fr)_160px_210px_auto]"
              onClick={() => onOpen(t.id)}
            >
              <Chip tone="neutral" size="xs">
                advisory · not a ticket
              </Chip>
              <span className="min-w-0 truncate text-[13px]">
                <span className="font-mono font-semibold text-slate">{t.contract_code ?? str(t.payload.contract)}</span>
                {contract && <span className="text-ink-2"> · {contract.title}</span>}
              </span>
              <span className="text-[12px] text-ink-2">
                flagged on{' '}
                <span className="font-mono font-semibold tabular-nums text-amber-ink">
                  {fmtNumber(transcripts.length)}
                </span>{' '}
                {transcripts.length === 1 ? 'transcript' : 'transcripts'}
              </span>
              <span className="font-mono text-[11px] text-ink-3">
                {run
                  ? `run v${run.prompt_version} · ${shortModel(run.model_id)}`
                  : t.run_id
                    ? `run ${shortHash(t.run_id, 8)}`
                    : ''}
              </span>
              <span className="ml-auto flex items-center justify-end gap-1.5">
                <Chip tone="amber" size="xs">
                  {str(t.payload.severity ?? contract?.severity)}
                </Chip>
                <span className="font-mono text-[11px] text-ink-3">{fmtTs(t.opened_at)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ReviewPage() {
  useTopBar([{ label: 'Review' }]);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') ?? '';
  const state = params.get('state') ?? '';
  const taskId = params.get('task');
  const runFilter = params.get('run') ?? '';
  const lane = laneParam(params.get('lane'));
  const tasks = useReviewTasks({ kind: kind || undefined, state: state || undefined });
  const runs = useRuns();
  const contracts = useContracts();
  // GET /review has no run filter; narrow client-side on run_id / payload.run_id.
  const runTasks = useMemo(() => filterTasksByRun(tasks.data, runFilter), [tasks.data, runFilter]);
  // Lane badges count work still open (not closed), the same number Home and Readiness show;
  // decided tasks remain listed under the state filter but are not outstanding work.
  const laneCounts = useMemo(
    () => countByLane(runTasks?.filter((t) => !TERMINAL_REVIEW_STATES.has(t.state))),
    [runTasks],
  );
  const visibleTasks = useMemo(
    () => (lane === 'all' ? runTasks : runTasks?.filter((t) => taskLane(t) === lane)),
    [runTasks, lane],
  );
  const layout = useMemo(() => groupActionable(lane === 'actionable' ? visibleTasks : []), [visibleTasks, lane]);
  const runsById = useMemo(() => new Map((runs.data ?? []).map((r) => [r.id, r])), [runs.data]);
  const contractsByCode = useMemo(() => new Map((contracts.data ?? []).map((c) => [c.code, c])), [contracts.data]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const openTask = (id: string) => setParam('task', id);

  const columns = useMemo<ColumnDef<ReviewTaskOut, unknown>[]>(
    () => [
      {
        id: 'subject',
        header: 'Subject',
        accessorFn: (t) =>
          `${t.rule_code ?? ''} ${t.asset_name ?? ''} ${t.contract_code ?? ''} ${t.transcript_code ?? ''}`,
        size: 440,
        meta: { wrap: true },
        cell: (c) => (
          <span className="cell-primary [overflow-wrap:anywhere]">
            <TaskSubject t={c.row.original} />
            <span
              className="cell-sub font-mono text-[11px]"
              title={`${c.row.original.id} · opened ${fmtTs(c.row.original.opened_at)}`}
            >
              #{shortHash(c.row.original.id, 8)}
            </span>
          </span>
        ),
      },
      {
        header: 'Kind',
        accessorKey: 'kind',
        cell: (c) => <Chip tone={kindTone(c.row.original.kind)}>{kindLabel(c.row.original.kind)}</Chip>,
      },
      {
        header: 'Direction',
        accessorKey: 'staleness_direction',
        cell: (c) => <DirectionChip direction={c.row.original.staleness_direction} />,
      },
      {
        header: 'Assignee',
        accessorKey: 'assignee_role',
        meta: { nowrap: true },
        cell: (c) => <span title={c.row.original.assignee_role}>{roleLabel(c.row.original.assignee_role)}</span>,
      },
      {
        header: 'Opened',
        accessorKey: 'opened_at',
        size: 120,
        meta: { mono: true },
        cell: (c) => <span className="text-ink-2">{fmtDate(c.row.original.opened_at)}</span>,
      },
      {
        header: 'State',
        accessorKey: 'state',
        size: 150,
        // The decision's reason code sits under the state it explains (most open tasks have none).
        cell: (c) =>
          taskLane(c.row.original) === 'advisory' ? (
            <Chip tone="neutral" title="Advisory observation — not a ticket">
              advisory
            </Chip>
          ) : (
            <span className="cell-primary">
              <Chip tone={stateTone(c.row.original.state)}>{stateLabel(c.row.original.state)}</Chip>
              {c.row.original.reason_code ? (
                <span className="cell-sub font-mono text-[11px]">{c.row.original.reason_code}</span>
              ) : null}
            </span>
          ),
      },
    ],
    [],
  );

  const laneTabs: Array<[LaneView, string, number | null]> = [
    ['actionable', 'Actionable', runTasks ? laneCounts.actionable : null],
    ['advisory', 'Advisory', runTasks ? laneCounts.advisory : null],
    ['all', 'All', runTasks ? runTasks.length : null],
  ];
  const emptyHint = runFilter
    ? 'Only flagged-result tasks carry a run. Clear the run filter to see the whole queue.'
    : 'Tasks open when a scan finds a stale artifact, proposes an edge or sees a rule source change, and when a run fails a blocking contract.';

  return (
    <div>
      <PageHeader
        eyebrow="Review queue"
        title="Review"
        description={
          <>
            A human decides blocking failures, stale encodings, proposed edges and source changes; FLAG-severity and
            judged contracts stay advisory — visible, not tickets.
            <span className="mt-1 block text-[12px] text-ink-3">
              Illegal transitions are refused (409) and audit-logged; overriding a flagged call creates a test case a
              different user must approve.
            </span>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-hairline px-4 pb-3 sm:px-6">
        <div
          role="tablist"
          aria-label="Lane"
          className="inline-flex overflow-hidden rounded-[6px] border border-input bg-surface"
        >
          {laneTabs.map(([key, label, count]) => (
            <button
              key={key}
              role="tab"
              type="button"
              aria-selected={lane === key}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 border-r border-input px-3 text-[12px] font-semibold uppercase tracking-[0.5px] last:border-r-0',
                lane === key ? 'bg-teal-ink text-on-navy' : 'bg-surface text-slate hover:bg-band',
              )}
              onClick={() => setParam('lane', key === 'actionable' ? '' : key)}
            >
              {label}
              <span className={cn('font-mono text-[12px] tabular-nums', lane === key ? 'text-on-navy' : 'text-ink-2')}>
                {count ?? '…'}
              </span>
            </button>
          ))}
        </div>
        <Field label="Kind" htmlFor="rv-kind">
          <select
            id="rv-kind"
            className="input h-8 w-[190px] text-[12px]"
            value={kind}
            onChange={(e) => setParam('kind', e.target.value)}
          >
            <option value="">all kinds</option>
            {REVIEW_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State" htmlFor="rv-state">
          <select
            id="rv-state"
            className="input h-8 w-[150px] text-[12px]"
            value={state}
            onChange={(e) => setParam('state', e.target.value)}
          >
            <option value="">all</option>
            {REVIEW_STATES.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </Field>
        {runFilter && (
          <div>
            <span className="label">Run</span>
            <span className="inline-flex h-8 items-center gap-1 border border-input bg-band pl-2 pr-1 font-mono text-[12px] text-slate">
              <Link to={`/runs/${encodeURIComponent(runFilter)}`} title={`Run ${runFilter}`}>
                {shortHash(runFilter, 8)}
              </Link>
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center text-ink-2 hover:text-slate"
                aria-label="Clear run filter"
                onClick={() => setParam('run', '')}
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          </div>
        )}
      </div>
      {lane === 'actionable' ? (
        <>
          {(tasks.isLoading || layout.individual.length > 0 || kind !== 'FLAGGED_RESULT') && (
            <Section
              title={tasks.isLoading ? 'Artifacts and sources' : `Artifacts and sources — ${layout.individual.length}`}
            >
              <DataTable
                columns={columns}
                data={layout.individual}
                isLoading={tasks.isLoading}
                error={tasks.error}
                retry={() => void tasks.refetch()}
                getRowId={(t) => t.id}
                selectedIds={taskId ? new Set([taskId]) : undefined}
                onRowClick={(t) => openTask(t.id)}
                initialSort={[{ id: 'opened_at', desc: true }]}
                emptyTitle="No stale encodings, proposed edges or source changes"
                emptyHint={emptyHint}
                caption="Actionable review tasks about artifacts and sources"
                skeletonRows={4}
              />
            </Section>
          )}
          {!tasks.isLoading && !tasks.error && (layout.groups.length > 0 || kind === 'FLAGGED_RESULT') && (
            <Section
              band
              title={`Blocking failures by run and contract — ${layout.groups.length} ${layout.groups.length === 1 ? 'group' : 'groups'} · ${layout.groups.reduce((n, g) => n + g.tasks.length, 0)} calls`}
            >
              {layout.groups.length ? (
                <div className="space-y-1.5">
                  {layout.groups.map((g) => (
                    <FlaggedGroupBlock
                      key={g.key}
                      group={g}
                      contract={contractsByCode.get(g.contractCode)}
                      run={g.runId ? runsById.get(g.runId) : undefined}
                      selectedId={taskId}
                      onOpen={openTask}
                      defaultOpen={layout.groups.length === 1 || g.tasks.some((t) => t.id === taskId)}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState title="No blocking failures open" hint={emptyHint} />
              )}
              <p className="mt-2 text-[11px] text-ink-3">
                Expand a group to decide per call; overriding a call creates a test case that a different user must
                approve.
              </p>
            </Section>
          )}
        </>
      ) : lane === 'advisory' ? (
        <Section title="Advisory observations — aggregate per run and contract">
          {tasks.isLoading ? (
            <table className="dt">
              <tbody>
                <SkeletonRows columns={4} rows={4} />
              </tbody>
            </table>
          ) : tasks.error && !tasks.data ? (
            <ErrorState error={tasks.error} retry={() => void tasks.refetch()} />
          ) : (
            <AdvisoryList
              tasks={visibleTasks ?? []}
              runsById={runsById}
              contractsByCode={contractsByCode}
              onOpen={openTask}
            />
          )}
        </Section>
      ) : (
        <Section>
          <DataTable
            columns={columns}
            data={visibleTasks}
            isLoading={tasks.isLoading}
            error={tasks.error}
            retry={() => void tasks.refetch()}
            getRowId={(t) => t.id}
            selectedIds={taskId ? new Set([taskId]) : undefined}
            onRowClick={(t) => openTask(t.id)}
            initialSort={[{ id: 'opened_at', desc: true }]}
            rowClassName={(t) => (taskLane(t) === 'advisory' ? 'text-ink-2' : undefined)}
            emptyTitle={runFilter ? `No tasks from run ${shortHash(runFilter, 8)}` : 'No tasks match'}
            emptyHint={emptyHint}
            caption="Review queue — all lanes"
            maxHeight="calc(100vh - 300px)"
          />
        </Section>
      )}
      <TaskDrawer
        taskId={taskId}
        onClose={() =>
          navigate(
            {
              search: (() => {
                const n = new URLSearchParams(params);
                n.delete('task');
                return n.toString();
              })(),
            },
            { replace: true },
          )
        }
      />
    </div>
  );
}
