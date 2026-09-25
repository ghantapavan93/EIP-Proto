import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { useContracts } from '../api/hooks';
import type { ContractOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section } from '../components/layout/Page';
import { DataTable } from '../components/ui/DataTable';
import { Chip } from '../components/ui/Chip';
import { severityTone } from '../lib/vocab';

export function ContractsPage() {
  useTopBar([{ label: 'Contracts' }]);
  const navigate = useNavigate();
  const contracts = useContracts();

  const columns = useMemo<ColumnDef<ContractOut, unknown>[]>(
    () => [
      {
        header: 'Code',
        accessorKey: 'code',
        meta: { mono: true },
        cell: (c) => (
          <Link to={`/contracts/${encodeURIComponent(c.row.original.code)}`} className="font-semibold" onClick={(e) => e.stopPropagation()}>
            {c.row.original.code}
          </Link>
        ),
        size: 110,
      },
      {
        header: 'Title',
        accessorKey: 'title',
        meta: { wrap: true },
        cell: (c) => (
          <span className="block max-w-[520px] leading-snug">
            <span>{c.row.original.title}</span>
            <span className="mt-0.5 block text-[12px] text-ink-2">{c.row.original.description}</span>
          </span>
        ),
      },
      { header: 'Severity', accessorKey: 'severity', cell: (c) => <Chip tone={severityTone(c.row.original.severity)}>{c.row.original.severity}</Chip>, size: 80 },
      { header: 'Kind', accessorKey: 'kind', cell: (c) => <Chip tone={c.row.original.kind === 'JUDGED' ? 'teal' : 'neutral'}>{c.row.original.kind}</Chip>, size: 110 },
      {
        header: 'Rule',
        accessorKey: 'rule_code',
        cell: (c) =>
          c.row.original.rule_code ? (
            <Link to={`/rules/${encodeURIComponent(c.row.original.rule_code)}`} className="font-mono">
              {c.row.original.rule_code}
            </Link>
          ) : (
            <span className="text-ink-3">—</span>
          ),
      },
      { header: 'Owner', accessorKey: 'owner_role' },
      { header: 'Check', accessorKey: 'check', meta: { mono: true } },
      { header: 'v', accessorKey: 'version', meta: { align: 'right', mono: true }, size: 40 },
      {
        id: 'judge',
        header: 'Judge / N',
        accessorFn: (c) => c.judge_model_id ?? '',
        cell: (c) =>
          c.row.original.kind === 'JUDGED' ? (
            <span className="font-mono text-[12px]">
              {c.row.original.judge_model_id ?? '—'} · N={c.row.original.n_runs ?? '—'}
            </span>
          ) : (
            <span className="text-ink-3">—</span>
          ),
      },
    ],
    [],
  );

  const block = contracts.data?.filter((c) => c.severity === 'BLOCK').length ?? 0;
  const flag = contracts.data?.filter((c) => c.severity === 'FLAG').length ?? 0;

  return (
    <div>
      <PageHeader
        eyebrow="Behavioral contracts"
        title="Contracts"
        description={`Deterministic checks derived from rules (BLOCK can gate a release) plus judged checks that are advisory only (FLAG). ${block} BLOCK · ${flag} FLAG. Open one for its accuracy against ground truth.`}
      />
      <Section>
        <DataTable
          columns={columns}
          data={contracts.data}
          isLoading={contracts.isLoading}
          error={contracts.error}
          retry={() => void contracts.refetch()}
          getRowId={(c) => c.code}
          onRowClick={(c) => navigate(`/contracts/${encodeURIComponent(c.code)}`)}
          initialSort={[{ id: 'severity', desc: false }]}
          emptyTitle="No contracts"
          caption="Contract registry"
        />
      </Section>
    </div>
  );
}
