import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { Check, FileCheck2, KeyRound, ShieldAlert, ShieldCheck, Stamp, Users } from 'lucide-react';
import {
  useAccessReview,
  useAuditCheckpoints,
  useReloadRules,
  useTakeCheckpoint,
  useVerifyCheckpoint,
} from '../api/hooks';
import type { AccessAccountOut, AuditCheckpointOut, AuditVerifyOut, DeniedAttemptOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section } from '../components/layout/Page';
import { GatedButton } from '../components/access/GatedButton';
import { useIdentity, usePermission } from '../components/access/usePermission';
import { Chip } from '../components/ui/Chip';
import { DataTable } from '../components/ui/DataTable';
import { ErrorState } from '../components/ui/ErrorState';
import { LoadingState } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import { fmtRelative, fmtTs, shortHash } from '../lib/format';
import { eventLabel } from '../lib/audit';
import { ACTIONS, roleTitle, type RoleAction } from '../lib/roles';
import { cn } from '../lib/cn';

const ROLE_COLUMNS = ['analyst', 'engineer', 'admin'] as const;
const ADMIN_ONLY: RoleAction[] = ['review_access', 'checkpoint_audit', 'reload_rules'];

/** Shown in place of an admin-only panel: what it is, and why this role cannot see it. */
function AdminOnly({ what, role }: { what: string; role: string }) {
  return (
    <div role="note" className="card flex items-start gap-2.5 px-4 py-3 text-[13px] text-ink-2">
      <ShieldAlert size={15} className="mt-[2px] shrink-0 text-amber-ink" aria-hidden />
      <p>
        <span className="font-semibold text-ink">Admins only.</span> {what} You are signed in as{' '}
        <strong className="font-semibold text-ink">{roleTitle(role).toLowerCase()}</strong>, so this page does not ask for
        it: the server would refuse the request for your role and record the attempt in the audit log.
      </p>
    </div>
  );
}

// ------------------------------------------------------------- separation of duties

function DutiesMatrix() {
  const rows = (Object.keys(ACTIONS) as RoleAction[]).map((action) => ({ action, ...ACTIONS[action] }));
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[560px] text-[12.5px]">
        <caption className="sr-only">Actions each role may take</caption>
        <thead>
          <tr className="border-b border-hairline text-left">
            <th scope="col" className="px-3 py-2 font-semibold text-ink-2">Action</th>
            {ROLE_COLUMNS.map((r) => (
              <th key={r} scope="col" className="w-24 px-3 py-2 text-center font-semibold text-ink-2">
                {roleTitle(r)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const adminOnly = ADMIN_ONLY.includes(row.action);
            return (
              <tr key={row.action} className={cn('border-b border-hairline last:border-0', adminOnly && 'bg-teal/5')}>
                <th scope="row" className="px-3 py-1.5 text-left font-normal text-ink">
                  {row.label}
                  {adminOnly && (
                    <Chip tone="teal" size="xs" className="ml-2">
                      governance
                    </Chip>
                  )}
                </th>
                {ROLE_COLUMNS.map((r) => (
                  <td key={r} className="px-3 py-1.5 text-center">
                    {row.roles.includes(r) ? (
                      <Check size={14} className="inline text-green-ink" aria-label="allowed" />
                    ) : (
                      <span className="text-ink-3" aria-label="not allowed">
                        —
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------- access review

const accountColumns: ColumnDef<AccessAccountOut>[] = [
  { id: 'name', header: 'Account', accessorKey: 'name', cell: ({ row }) => <span className="font-mono">{row.original.name}</span> },
  {
    id: 'role',
    header: 'Role',
    accessorKey: 'role',
    cell: ({ row }) => <span title={row.original.role_label}>{roleTitle(row.original.role)}</span>,
  },
  {
    id: 'credentials',
    header: 'Password',
    accessorFn: (a) => (a.default_credentials ? 0 : 1),
    cell: ({ row }) =>
      row.original.default_credentials ? (
        <Chip tone="red" title="Password equals the username: acceptable on localhost only">
          default
        </Chip>
      ) : (
        <Chip tone="green">set</Chip>
      ),
  },
  {
    id: 'last',
    header: 'Last recorded action',
    accessorFn: (a) => a.last_recorded_action_at ?? '',
    cell: ({ row }) =>
      row.original.last_recorded_action_at ? (
        <span title={fmtTs(row.original.last_recorded_action_at)}>
          {eventLabel(row.original.last_recorded_action ?? '')} · {fmtRelative(row.original.last_recorded_action_at)}
        </span>
      ) : (
        <span className="text-ink-3">none recorded</span>
      ),
  },
  { id: 'actions', header: 'Actions (30 d)', accessorKey: 'actions_30d', cell: ({ getValue }) => <span className="stat">{String(getValue())}</span> },
  {
    id: 'denied',
    header: 'Denied (30 d)',
    accessorKey: 'denied_30d',
    cell: ({ row }) => <span className={cn('stat', row.original.denied_30d ? 'text-red' : 'text-ink-3')}>{row.original.denied_30d}</span>,
  },
];

function AccessReview() {
  const review = useAccessReview(true);
  if (review.isLoading) return <LoadingState className="p-4" rows={4} />;
  if (review.error || !review.data) return <ErrorState error={review.error} title="Access review failed" retry={() => void review.refetch()} />;
  const d = review.data;
  const kpis: Array<[string, number, string]> = [
    ['Accounts', d.accounts.length, 'text-ink'],
    ['On default passwords', d.default_credential_accounts, d.default_credential_accounts ? 'text-red' : 'text-green-ink'],
    ['Denied in 24 h', d.denied_24h, d.denied_24h ? 'text-amber-ink' : 'text-ink-3'],
  ];
  return (
    <div className="space-y-3">
      <div className="card grid grid-cols-3 gap-px overflow-hidden bg-hairline">
        {kpis.map(([label, value, color]) => (
          <div key={label} className="bg-surface px-4 py-3">
            <div className="eyebrow">{label}</div>
            <div className={cn('stat mt-1 text-[24px]', color)}>{value}</div>
          </div>
        ))}
      </div>
      <DataTable columns={accountColumns} data={d.accounts} getRowId={(a) => a.name} caption="Accounts and roles" emptyTitle="No accounts configured" />
      <p className="text-[12px] leading-snug text-ink-3">
        {d.identity_source} "Last recorded action" reads the audit log, which records changes and exports, not page views.
      </p>
      <div>
        <div className="eyebrow mb-1.5">Recent refusals</div>
        {d.recent_denied.length ? (
          <ul className="card divide-y divide-hairline" aria-label="Recent refusals">
            {d.recent_denied.slice(0, 8).map((r: DeniedAttemptOut, i) => (
              <li key={`${r.ts}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[12.5px]">
                <span className="w-36 shrink-0 text-ink-3" title={fmtTs(r.ts)}>
                  {fmtRelative(r.ts)}
                </span>
                <span className="font-mono text-ink">{r.actor}</span>
                <Chip tone={r.kind === 'bad_credentials' ? 'red' : 'amber'} size="xs">
                  {r.kind === 'bad_credentials' ? 'bad credentials' : 'insufficient role'}
                </Chip>
                <span className="text-ink-2">{r.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card">
            <EmptyState title="No refusals recorded" className="py-4" />
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- audit checkpoints

function VerifyResult({ result }: { result: AuditVerifyOut }) {
  const ok = result.ok;
  return (
    <div
      role="status"
      className={cn(
        'mt-2 flex items-start gap-2 rounded-[6px] border px-3 py-2 text-[12.5px]',
        ok ? 'border-green/40 bg-green/10 text-ink' : 'border-red/30 bg-red/8 text-ink',
      )}
    >
      {ok ? <ShieldCheck size={14} className="mt-[2px] shrink-0 text-green-ink" aria-hidden /> : <ShieldAlert size={14} className="mt-[2px] shrink-0 text-red" aria-hidden />}
      <span>
        {ok
          ? `Verified: the chain is intact across ${result.checked} rows and still contains this checkpoint.`
          : `Not verified: ${result.reason ?? 'the chain does not match'}.`}
      </span>
    </div>
  );
}

function CheckpointRow({ cp }: { cp: AuditCheckpointOut }) {
  const verify = useVerifyCheckpoint();
  return (
    <li className="px-3 py-2 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-ink-3" title={fmtTs(cp.taken_at)}>
          {fmtRelative(cp.taken_at)}
        </span>
        <span className="text-ink">
          by <span className="font-mono">{cp.taken_by}</span> · through row {cp.through_id} · {cp.rows_verified} rows verified
        </span>
        <span className="font-mono text-ink-2" title={cp.tip}>
          {shortHash(cp.tip, 16)}
        </span>
        <button type="button" className="btn btn-outline btn-sm ml-auto" onClick={() => verify.mutate({ through_id: cp.through_id, tip: cp.tip })} disabled={verify.isPending}>
          Verify now
        </button>
      </div>
      {verify.data && <VerifyResult result={verify.data} />}
      {verify.error && <p className="mt-1 text-red">{verify.error.message}</p>}
    </li>
  );
}

function VerifyReceipt() {
  const verify = useVerifyCheckpoint();
  const [throughId, setThroughId] = useState('');
  const [tip, setTip] = useState('');
  const valid = /^\d+$/.test(throughId) && /^[0-9a-f]{64}$/.test(tip.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) verify.mutate({ through_id: Number(throughId), tip: tip.trim() });
  };
  return (
    <form onSubmit={submit} className="card px-4 py-3" aria-label="Verify a checkpoint receipt">
      <div className="eyebrow mb-1">Verify a receipt</div>
      <p className="mb-2 text-[12.5px] text-ink-2">Anyone signed in can check a receipt kept outside this system: paste its row and hash.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12px] text-ink-2">
          Through row
          <input className="input w-28 font-mono" inputMode="numeric" value={throughId} onChange={(e) => setThroughId(e.target.value)} placeholder="1234" />
        </label>
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-[12px] text-ink-2">
          Tip hash (SHA-256)
          <input className="input font-mono" value={tip} onChange={(e) => setTip(e.target.value)} placeholder="64 hex characters" spellCheck={false} />
        </label>
        <button type="submit" className="btn btn-outline" disabled={!valid || verify.isPending}>
          Verify
        </button>
      </div>
      {verify.data && <VerifyResult result={verify.data} />}
      {verify.error && <p className="mt-2 text-[12.5px] text-red">{verify.error.message}</p>}
    </form>
  );
}

function Checkpoints({ isAdmin }: { isAdmin: boolean }) {
  const list = useAuditCheckpoints(isAdmin);
  const take = useTakeCheckpoint();
  return (
    <div className="space-y-3">
      <div className="card px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <GatedButton action="checkpoint_audit" className="btn" onClick={() => take.mutate()} disabled={take.isPending}>
            <Stamp size={13} aria-hidden /> Take checkpoint
          </GatedButton>
          <span className="text-[12.5px] text-ink-2">Verifies the whole chain first; refused while any row fails to link.</span>
        </div>
        {take.data && (
          <div role="status" className="mt-3 rounded-[6px] border border-green/40 bg-green/10 px-3 py-2 text-[12.5px] text-ink">
            <div className="font-semibold">Receipt — keep this outside the system (a ticket, an email, a signed PDF):</div>
            <div className="mt-1 font-mono text-[12px] break-all">
              through row {take.data.through_id} · {take.data.tip}
            </div>
          </div>
        )}
        {take.error && <p className="mt-2 text-[12.5px] text-red">{take.error.message}</p>}
      </div>
      {isAdmin &&
        (list.isLoading ? (
          <LoadingState className="p-4" rows={2} />
        ) : list.data?.length ? (
          <ul className="card divide-y divide-hairline" aria-label="Checkpoints taken">
            {list.data.map((cp) => (
              <CheckpointRow key={cp.id} cp={cp} />
            ))}
          </ul>
        ) : (
          <div className="card">
            <EmptyState title="No checkpoints yet" hint="Take one, then keep the receipt somewhere this system cannot write." className="py-4" />
          </div>
        ))}
      <VerifyReceipt />
    </div>
  );
}

// ------------------------------------------------------------- rule corpus adoption

function CorpusAdoption() {
  const reload = useReloadRules();
  return (
    <div className="card px-4 py-3">
      <p className="max-w-[80ch] text-[13px] leading-snug text-ink-2">
        The rule corpus lives in git as reviewed YAML. Engineers propose versions through the API; a proposal is never in
        force. Adopting the merged corpus changes what every later run is checked against, so it is an admin action. The
        loader refuses any edit to a published version: history is appended, never rewritten.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <GatedButton action="reload_rules" className="btn btn-outline" onClick={() => reload.mutate()} disabled={reload.isPending}>
          <FileCheck2 size={13} aria-hidden /> Adopt corpus from git
        </GatedButton>
        <Link to="/rules" className="text-[12.5px] text-teal-ink hover:underline">
          Open the rule registry
        </Link>
      </div>
      {reload.data && (
        <p role="status" className="mt-2 text-[12.5px] text-ink">
          Adopted {reload.data.files.length} files: {reload.data.rules_created} new rules, {reload.data.versions_created} new versions,{' '}
          {reload.data.unchanged} unchanged.
        </p>
      )}
      {reload.error && <p className="mt-2 text-[12.5px] text-red">{reload.error.message}</p>}
    </div>
  );
}

// ------------------------------------------------------------- page

export function GovernancePage() {
  useTopBar([{ label: 'Governance' }]);
  const { me } = useIdentity();
  const access = usePermission('review_access');
  const isAdmin = access.known && access.allowed;

  return (
    <div>
      <PageHeader
        eyebrow="Governance"
        title="Who may do what, and proof nothing was rewritten"
        description="Analysts decide review tasks. Engineers operate the harness: runs, scans, proposals. Admins govern it: who has access, which rule corpus is in force, and a record that the audit trail was not rewritten. Every refusal below is enforced by the server and logged, not just hidden in the interface."
      />

      <Section title="Separation of duties" right={<Users size={15} className="text-ink-3" aria-hidden />}>
        <DutiesMatrix />
        <p className="mt-2 text-[12px] text-ink-3">
          The same table drives the server's checks; a test fails if any guarded endpoint disagrees with it.
        </p>
      </Section>

      <Section title="Access review" right={<KeyRound size={15} className="text-ink-3" aria-hidden />}>
        {!access.known ? (
          <LoadingState className="p-4" rows={3} />
        ) : isAdmin ? (
          <AccessReview />
        ) : (
          <AdminOnly role={me.role} what="The access review lists every account, its role, whether it still uses a default password, and every refused request." />
        )}
      </Section>

      <Section title="Audit checkpoints" right={<Stamp size={15} className="text-ink-3" aria-hidden />}>
        <p className="mb-3 max-w-[80ch] text-[13px] leading-snug text-ink-2">
          Each audit row carries a hash of the row before it, so an edited or inserted row breaks the chain. Someone with
          database control could still rewrite every row and recompute the hashes. A checkpoint closes that gap: it records the
          chain's tip, and the receipt is kept outside this system. If history before it is ever rewritten, the receipt stops
          verifying.
        </p>
        <Checkpoints isAdmin={isAdmin} />
      </Section>

      <Section title="Rule corpus adoption">
        <CorpusAdoption />
      </Section>
    </div>
  );
}
