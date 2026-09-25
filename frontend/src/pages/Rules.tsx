import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle } from 'lucide-react';
import { useRules } from '../api/hooks';
import type { RuleOut, RuleVersionOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section } from '../components/layout/Page';
import { DataTable } from '../components/ui/DataTable';
import { Chip } from '../components/ui/Chip';
import { fmtDate } from '../lib/format';
import { changeTone } from '../lib/vocab';
import { classificationLabel, latestGoverning } from '../lib/ruleVersions';
import { RuleStatusNotes } from '../components/rules/RuleVersionBadges';

function inForce(rule: RuleOut): RuleVersionOut | undefined {
  return rule.versions.find((v) => v.version === rule.in_force_version);
}

/** The newest version that governs: proposals, vacated and stayed versions are never "the next change". */
function latest(rule: RuleOut): RuleVersionOut | undefined {
  return latestGoverning(rule);
}

export function RulesPage() {
  useTopBar([{ label: 'Rules' }]);
  const navigate = useNavigate();
  const rules = useRules();

  const columns = useMemo<ColumnDef<RuleOut, unknown>[]>(
    () => [
      {
        id: 'rule',
        header: 'Rule',
        accessorKey: 'code',
        meta: { wrap: true },
        cell: (c) => {
          const r = c.row.original;
          const l = latest(r);
          return (
            <span className="cell-primary max-w-[560px]">
              <span className="font-mono text-[12px] font-semibold tracking-[0.02em] text-ink">{r.code.toUpperCase()}</span>
              <span className="mt-0.5 block text-[13px] leading-snug text-ink">{r.title}</span>
              <span className="cell-sub font-mono text-[11px]">
                {r.citation}
                {l ? ` · v${l.version} · ${fmtDate(l.effective_from)}` : ''}
              </span>
              <RuleStatusNotes rule={r} className="mt-1" />
            </span>
          );
        },
      },
      { header: 'Regulator', accessorKey: 'regulator', size: 90, cell: (c) => <span className="text-ink-2">{c.row.original.regulator}</span> },
      {
        header: 'In force',
        accessorKey: 'in_force_version',
        meta: { mono: true },
        cell: (c) => {
          const r = c.row.original;
          if (r.in_force_version === null) {
            const vacated = r.versions.some((v) => v.status === 'vacated');
            const pending = latest(r);
            return (
              <span className="cell-primary text-[12px] text-ink-3" title={vacated ? 'The only enacted text was vacated by a court' : undefined}>
                none
                <span className="cell-sub whitespace-nowrap font-mono text-[11px]">{vacated ? 'vacated — not enforced' : pending ? `from ${fmtDate(pending.effective_from)}` : 'no version'}</span>
              </span>
            );
          }
          return (
            <span className="cell-primary">
              <span className="font-semibold text-ink">v{r.in_force_version}</span>
              <span className="cell-sub whitespace-nowrap font-mono text-[11px]">since {fmtDate(inForce(r)?.effective_from)}</span>
            </span>
          );
        },
        size: 110,
      },
      {
        id: 'next_change',
        header: 'Next change',
        accessorFn: (r) => latest(r)?.change_classification ?? '',
        cell: (c) => {
          const l = latest(c.row.original);
          if (!l || l.version === c.row.original.in_force_version) return <span className="text-ink-3">—</span>;
          return (
            <span className="cell-primary">
              <Chip tone={changeTone(l.change_classification)} wrap>
                {classificationLabel(l.change_classification)}
              </Chip>
              <span className="cell-sub whitespace-nowrap font-mono text-[11px]">
                v{l.version} · applies {l.effective_from}
              </span>
            </span>
          );
        },
      },
      { header: 'Dependents', accessorKey: 'dependents', meta: { align: 'right', mono: true }, size: 90 },
      {
        id: 'disputed',
        header: 'Open question',
        accessorFn: (r) => r.versions.some((v) => v.disputed),
        cell: (c) =>
          c.row.original.versions.some((v) => v.disputed) ? (
            <Chip tone="amber" title="A version's reading is flagged for counsel review">
              <AlertTriangle size={11} aria-hidden /> counsel
            </Chip>
          ) : (
            <span className="text-ink-3">—</span>
          ),
        size: 100,
      },
      {
        id: 'contracts',
        header: 'Contracts',
        accessorFn: (r) => r.contracts.join(', '),
        cell: (c) => (
          <span className="flex flex-wrap gap-1">
            {c.row.original.contracts.length ? (
              c.row.original.contracts.map((code) => (
                <Chip key={code} mono tone="slate">
                  {code}
                </Chip>
              ))
            ) : (
              <span className="text-ink-3">—</span>
            )}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader
        eyebrow="Rule registry"
        title="Rules"
        description="Versioned, cited, effective-dated rules — nothing is updated in place; open one for its blast radius."
      />
      <Section>
        <DataTable
          columns={columns}
          data={rules.data}
          isLoading={rules.isLoading}
          error={rules.error}
          retry={() => void rules.refetch()}
          getRowId={(r) => r.code}
          onRowClick={(r) => navigate(`/rules/${encodeURIComponent(r.code)}`)}
          initialSort={[{ id: 'dependents', desc: true }]}
          emptyTitle="No rules loaded"
          emptyHint="POST /rules/reload loads rules/*.yaml."
          caption="Rule registry"
        />
      </Section>
    </div>
  );
}
