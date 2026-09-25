import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRight, CheckCheck, Flag, Repeat, UserCheck } from 'lucide-react';
import { useApproveTestCase, useRuns, useTestCases } from '../api/hooks';
import type { TestCaseOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section } from '../components/layout/Page';
import { DataTable } from '../components/ui/DataTable';
import { Chip } from '../components/ui/Chip';
import { ErrorState } from '../components/ui/ErrorState';
import { DisabledWithReason } from '../components/access/GatedButton';
import { useIdentity, usePermission } from '../components/access/usePermission';
import { useToast } from '../components/ui/useToast';
import { fmtDate, fmtTs, shortHash } from '../lib/format';
import { testCasesApplied } from '../lib/runStats';
import { isSeededExample, whoCanApprove } from '../lib/testCases';

function LoopStep({ n, icon, title, body, stat }: { n: number; icon: ReactNode; title: string; body: ReactNode; stat?: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-1 gap-3 px-4 py-3">
      <span aria-hidden className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-teal/40 bg-teal/10 text-teal-ink">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-ink">
          <span className="sr-only">Step {n}: </span>
          {title}
        </span>
        <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-2">{body}</span>
        {stat && <span className="mt-1.5 block font-mono text-[11.5px] text-slate">{stat}</span>}
      </span>
    </li>
  );
}

/** The override loop in three steps, with live counts where the server reports them. */
function OverrideLoop({ tcs, applied }: { tcs: TestCaseOut[] | undefined; applied: number | null }) {
  const approved = tcs?.filter((t) => t.status === 'APPROVED').length ?? 0;
  const pending = tcs?.filter((t) => t.status === 'PENDING_APPROVAL').length ?? 0;
  return (
    <ol aria-label="How an override becomes a test case" className="card flex flex-col divide-y divide-hairline md:flex-row md:divide-x md:divide-y-0">
      <LoopStep
        n={1}
        icon={<Flag size={14} />}
        title="A reviewer overrides a flag"
        body="A run flags a call. The reviewer disagrees and records why, with a reason code and a note."
        stat={tcs ? `${tcs.length} ${tcs.length === 1 ? 'override' : 'overrides'} pinned` : undefined}
      />
      <LoopStep
        n={2}
        icon={<UserCheck size={14} />}
        title="A different person approves"
        body="An engineer or admin who did not write the override approves it. Nobody approves their own."
        stat={tcs ? `${approved} approved · ${pending} awaiting approval` : undefined}
      />
      <LoopStep
        n={3}
        icon={<Repeat size={14} />}
        title="Every later run honours it"
        body={
          <>
            Runs under the same rule apply the approved expectation and count it in <span className="font-mono text-[12px]">test_cases.applied</span>. A rule change sets it aside, and it expires after 365 days, so an exception never quietly becomes policy.
          </>
        }
        // 0 on the latest run usually means no run has happened since the approval, not a broken loop.
        stat={applied ? `latest run applied ${applied}` : applied === 0 ? 'applies from the next run' : undefined}
      />
    </ol>
  );
}

export function TestCasesPage() {
  useTopBar([{ label: 'Test cases' }]);
  const { me } = useIdentity();
  const approvePermission = usePermission('approve_test_cases');
  const tcs = useTestCases();
  const runs = useRuns();
  const approve = useApproveTestCase();
  const { toast } = useToast();
  const user = me.name;
  const latestRun = useMemo(() => [...(runs.data ?? [])].sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0], [runs.data]);
  const applied = testCasesApplied(latestRun);
  const seededCount = tcs.data?.filter(isSeededExample).length ?? 0;

  const columns = useMemo<ColumnDef<TestCaseOut, unknown>[]>(
    () => [
      {
        header: 'Test case',
        accessorKey: 'id',
        size: 150,
        meta: { wrap: true },
        cell: (c) => {
          const tc = c.row.original;
          return (
            <span className="cell-primary">
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[12px] font-semibold text-navy" title={tc.id}>
                  tc-{shortHash(tc.id, 8)}
                </span>
                {isSeededExample(tc) && (
                  <Chip tone="teal" size="xs" title="Created by the demo seed so the loop is visible before anyone overrides a call">
                    seeded example
                  </Chip>
                )}
              </span>
              <span className="cell-sub whitespace-nowrap text-[11.5px]" title={`created ${fmtTs(tc.created_at)} from review task ${tc.review_task_id}`}>
                {fmtDate(tc.created_at)} · from{' '}
                <Link to={`/review?task=${encodeURIComponent(tc.review_task_id)}`} className="font-mono" onClick={(e) => e.stopPropagation()}>
                  task-{shortHash(tc.review_task_id, 8)}
                </Link>
              </span>
            </span>
          );
        },
      },
      {
        id: 'pins',
        header: 'Pins',
        accessorFn: (t) => `${t.contract_code} ${t.transcript_code ?? ''}`,
        meta: { wrap: true },
        cell: (c) => {
          const tc = c.row.original;
          const outcome = typeof tc.expected.outcome === 'string' ? tc.expected.outcome : 'PASS';
          return (
            <span className="cell-primary">
              <span className="whitespace-nowrap font-mono text-[12px] text-ink">
                {tc.contract_code} · {tc.transcript_code ?? '—'}
              </span>
              <span className="cell-sub whitespace-nowrap">
                expect <span className="font-mono">{outcome}</span>
              </span>
            </span>
          );
        },
      },
      {
        id: 'reason',
        header: 'Reason',
        accessorKey: 'reason_code',
        meta: { wrap: true },
        cell: (c) => {
          const tc = c.row.original;
          const note = typeof tc.expected.note === 'string' ? tc.expected.note : '';
          return (
            <span className="cell-primary max-w-[420px]">
              <span className="font-mono text-[12px] text-ink">{tc.reason_code}</span>
              {note && <span className="cell-sub line-clamp-2">{note}</span>}
            </span>
          );
        },
      },
      {
        id: 'people',
        header: 'Overridden → approved',
        size: 210,
        accessorFn: (t) => `${t.created_by} ${t.approver ?? ''}`,
        meta: { wrap: true },
        cell: (c) => {
          const tc = c.row.original;
          return (
            <span className="cell-primary">
              <span className="font-mono text-[12px] text-ink [overflow-wrap:anywhere]">{tc.created_by}</span>
              <span className="cell-sub max-w-[220px] [overflow-wrap:anywhere]">
                {tc.approver ? (
                  <>
                    <>
                      → <span className="font-mono">{tc.approver}</span>
                    </>
                  </>
                ) : (
                  whoCanApprove(tc)
                )}
              </span>
            </span>
          );
        },
      },
      {
        header: 'Status',
        accessorKey: 'status',
        meta: { wrap: true },
        cell: (c) => {
          const tc = c.row.original;
          return (
            <span className="cell-primary">
              <Chip tone={tc.status === 'APPROVED' ? 'green' : tc.status === 'EXPIRED' ? 'neutral' : 'amber'}>{tc.status.replace('_', ' ').toLowerCase()}</Chip>
              <span className="cell-sub whitespace-nowrap font-mono text-[11px]">expires {fmtDate(tc.expires_at)}</span>
            </span>
          );
        },
      },
      {
        id: 'approve',
        header: 'Approve',
        enableSorting: false,
        cell: (c) => {
          const tc = c.row.original;
          if (tc.status !== 'PENDING_APPROVAL') return <span className="text-ink-3">—</span>;
          const label = (
            <>
              <CheckCheck size={12} aria-hidden /> Approve
            </>
          );
          if (!approvePermission.allowed) {
            return (
              <DisabledWithReason className="btn btn-outline btn-sm" reason={approvePermission.why}>
                {label}
              </DisabledWithReason>
            );
          }
          if (tc.created_by === user) {
            return (
              <DisabledWithReason className="btn btn-outline btn-sm" reason="You wrote this override — a different person must approve it">
                {label}
              </DisabledWithReason>
            );
          }
          return (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={approve.isPending}
              title={`Approve as ${user}`}
              onClick={(e) => {
                e.stopPropagation();
                approve.mutate(tc.id, {
                  onSuccess: (t) => toast({ title: `tc-${shortHash(t.id, 8)} approved by ${t.approver}`, tone: 'green' }),
                  onError: (err) => toast({ title: 'Approval refused', detail: err.message, tone: 'red' }),
                });
              }}
            >
              {label}
            </button>
          );
        },
      },
    ],
    [approvePermission.allowed, approvePermission.why, user, approve, toast],
  );

  return (
    <div>
      <PageHeader
        eyebrow="Override memory"
        title="Test cases"
        description="When a reviewer overrides a flagged call, the decision is pinned as an expectation. A second person approves it, and later runs honour it while the rule it was decided under stays in force, for up to 365 days."
        actions={
          <Link to="/review?kind=FLAGGED_RESULT" className="btn btn-outline hover:no-underline">
            Flagged calls to review <ArrowRight size={13} aria-hidden />
          </Link>
        }
      />
      <Section className="pt-0">
        <OverrideLoop tcs={tcs.data} applied={applied} />
      </Section>
      <Section
        title={tcs.data ? `${tcs.data.length} pinned ${tcs.data.length === 1 ? 'expectation' : 'expectations'}` : 'Pinned expectations'}
        right={seededCount > 0 ? <span className="normal-case tracking-normal text-ink-3">{seededCount} seeded by the demo · same rules as real ones</span> : undefined}
      >
        {approve.error ? <ErrorState error={approve.error} title="Approval refused" className="mb-3" /> : null}
        <DataTable
          columns={columns}
          data={tcs.data}
          isLoading={tcs.isLoading}
          error={tcs.error}
          retry={() => void tcs.refetch()}
          getRowId={(t) => t.id}
          initialSort={[{ id: 'id', desc: false }]}
          emptyTitle="No test cases yet"
          emptyAction={
            <Link to="/review?kind=FLAGGED_RESULT" className="btn btn-outline btn-sm hover:no-underline">
              Open flagged results
            </Link>
          }
          emptyHint={
            <>
              Override a flagged result in the <Link to="/review?kind=FLAGGED_RESULT">review queue</Link> to create one.
            </>
          }
          caption="Test cases"
        />
      </Section>
    </div>
  );
}
