import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { FileText } from 'lucide-react';
import { useMatcherEvals } from '../api/hooks';
import { openText } from '../api/client';
import type { MatcherEvalCase, MatcherEvalCounts } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section } from '../components/layout/Page';
import { DataTable } from '../components/ui/DataTable';
import { Chip } from '../components/ui/Chip';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { useToast } from '../components/ui/useToast';
import { cn } from '../lib/cn';

type Filter = 'all' | 'fp_fn' | 'known';

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function refKey([rule, version]: [string, number]): string {
  return `${rule}@v${version}`;
}

function RefChips({ refs, tone, statuses }: { refs: Array<[string, number]>; tone: 'neutral' | 'green' | 'red' | 'amber'; statuses?: Record<string, string> }) {
  if (!refs.length) return <span className="text-ink-3">none</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {refs.map((r) => {
        const status = statuses?.[`${r[0]}@${r[1]}`];
        return (
          <Chip key={refKey(r)} tone={tone} mono title={status ? `edge status: ${status}` : undefined}>
            {refKey(r)}
            {status && status !== 'confirmed' ? ` · ${status}` : ''}
          </Chip>
        );
      })}
    </span>
  );
}

export function EvalsPage() {
  useTopBar([{ label: 'Evals' }]);
  const evals = useMatcherEvals();
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>('all');

  const perRuleRows = useMemo(() => Object.entries(evals.data?.per_rule ?? {}).map(([rule, c]) => ({ rule, ...c })), [evals.data]);
  type RuleRow = MatcherEvalCounts & { rule: string };

  const perRuleColumns = useMemo<ColumnDef<RuleRow, unknown>[]>(
    () => [
      { header: 'Rule', accessorKey: 'rule', meta: { mono: true }, cell: (c) => <Link to={`/rules/${encodeURIComponent(c.row.original.rule)}`} className="font-semibold">{c.row.original.rule}</Link> },
      { header: 'TP', accessorKey: 'tp', meta: { align: 'right', mono: true }, size: 60 },
      { header: 'FP', accessorKey: 'fp', meta: { align: 'right', mono: true }, cell: (c) => <span className={c.row.original.fp ? 'font-semibold text-red' : 'text-ink-3'}>{c.row.original.fp}</span>, size: 60 },
      { header: 'FN', accessorKey: 'fn', meta: { align: 'right', mono: true }, cell: (c) => <span className={c.row.original.fn ? 'font-semibold text-amber-ink' : 'text-ink-3'}>{c.row.original.fn}</span>, size: 60 },
      { header: 'Precision', accessorKey: 'precision', meta: { align: 'right', mono: true }, cell: (c) => <span className={cn('font-semibold', c.row.original.precision < 1 ? 'text-red' : 'text-ink')}>{pct(c.row.original.precision)}</span>, size: 100 },
      { header: 'Recall', accessorKey: 'recall', meta: { align: 'right', mono: true }, cell: (c) => <span className={cn('font-semibold', c.row.original.recall < 1 ? 'text-amber-ink' : 'text-ink')}>{pct(c.row.original.recall)}</span>, size: 100 },
    ],
    [],
  );

  const cases = useMemo(() => {
    const all = evals.data?.cases ?? [];
    if (filter === 'fp_fn') return all.filter((c) => c.false_positive.length || c.false_negative.length);
    if (filter === 'known') return all.filter((c) => c.known_limitation);
    return all;
  }, [evals.data, filter]);

  const caseColumns = useMemo<ColumnDef<MatcherEvalCase, unknown>[]>(
    () => [
      { header: 'Case', accessorKey: 'id', meta: { mono: true }, cell: (c) => <span className="font-semibold text-navy">{c.row.original.id}</span>, size: 150 },
      { header: 'Text', accessorKey: 'text', meta: { wrap: true }, cell: (c) => <span className="block max-w-[520px] text-[12.5px] leading-snug">{c.row.original.text}</span> },
      { id: 'expected', header: 'Expected', accessorFn: (r) => r.expected.map(refKey).join(','), meta: { wrap: true }, cell: (c) => <RefChips refs={c.row.original.expected} tone="neutral" /> },
      { id: 'detected', header: 'Detected', accessorFn: (r) => r.detected.map(refKey).join(','), meta: { wrap: true }, cell: (c) => <RefChips refs={c.row.original.detected} tone={c.row.original.false_positive.length ? 'red' : 'green'} statuses={c.row.original.detected_status} /> },
      {
        id: 'verdict',
        header: 'Verdict',
        accessorFn: (r) => (r.false_positive.length ? 'FP' : r.false_negative.length ? 'FN' : r.known_limitation ? 'known limitation' : 'ok'),
        cell: (c) => {
          const r = c.row.original;
          return (
            <span className="inline-flex flex-wrap gap-1">
              {r.false_positive.length > 0 && <Chip tone="red">false positive</Chip>}
              {r.false_negative.length > 0 && <Chip tone="amber">false negative</Chip>}
              {r.known_limitation && <Chip tone="slate">known limitation</Chip>}
              {!r.false_positive.length && !r.false_negative.length && !r.known_limitation && <Chip tone="green">ok</Chip>}
            </span>
          );
        },
      },
    ],
    [],
  );

  const s = evals.data?.summary;
  const suite = s?.suite ?? 'Golden Matcher Suite';

  return (
    <div>
      <PageHeader
        eyebrow="Matcher evaluation · regression fixtures"
        title={s ? `${suite} · ${s.cases} curated fixtures` : suite}
        description="The deterministic matchers that bind artifacts to rule versions, scored against hand-curated fixtures. Precision-first by design: a false positive costs a reviewer one click; a false negative is covered by the LLM proposer and the next human read."
        actions={
          <button
            type="button"
            className="btn btn-outline"
            onClick={() =>
              openText('/evals/matchers.md').catch((err: unknown) => toast({ title: 'Could not open the report', detail: err instanceof Error ? err.message : String(err), tone: 'red' }))
            }
          >
            <FileText size={13} aria-hidden /> Markdown report
          </button>
        }
      />
      {evals.isLoading && <LoadingState className="p-6" rows={4} />}
      {evals.error && !evals.data ? (
        <div className="p-6">
          <ErrorState error={evals.error} title="Could not load /evals/matchers" retry={() => void evals.refetch()} />
        </div>
      ) : null}
      {s && (
        <>
          <Section band>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
              {(
                [
                  ['Fixtures', String(s.cases), 'text-navy', false, s.positives !== undefined ? `${s.positives} positive · ${s.negatives ?? 0} negative` : null],
                  ['Fixture precision', pct(s.precision), s.precision < 1 ? 'text-red' : 'text-navy', true, 'on these fixtures'],
                  ['Fixture recall', pct(s.recall), s.recall < 1 ? 'text-amber-ink' : 'text-navy', true, 'on these fixtures'],
                  ['True positives', String(s.tp), 'text-green-ink', false, s.positives !== undefined && s.tp !== s.positives ? `expected edges found; some positive fixtures expect two` : 'expected edges found'],
                  ['False positives', String(s.fp), s.fp ? 'text-red' : 'text-ink-3', false, null],
                  ['False negatives', String(s.fn), s.fn ? 'text-amber-ink' : 'text-ink-3', false, null],
                  ['Known limitations', String(s.known_limitations), 'text-slate', false, null],
                  ['Metric scope', s.metric_scope ?? 'fixture', 'text-slate', false, 'not production'],
                ] as Array<[string, string, string, boolean, string | null]>
              ).map(([label, value, color, bold, sub]) => (
                <div key={label} className="card px-3 py-2">
                  <div className="eyebrow">{label}</div>
                  <div className={cn('font-mono text-[22px] tabular-nums', bold ? 'font-bold' : 'font-semibold', color)}>{value}</div>
                  {sub && <div className="text-[11px] text-ink-2">{sub}</div>}
                </div>
              ))}
            </div>
            <p role="note" className="mt-3 max-w-4xl border-l-2 border-input bg-surface px-3 py-2 text-[12.5px] leading-snug text-ink">
              <span className="mr-1 text-[11px] font-semibold uppercase tracking-[1px] text-ink-2">Scope</span>
              {s.disclaimer ?? 'Hand-authored regression fixtures. Not an estimate of production accuracy.'}
            </p>
          </Section>
          <Section title="Per rule">
            <DataTable columns={perRuleColumns} data={perRuleRows} getRowId={(r) => r.rule} emptyTitle="No per-rule data" initialSort={[{ id: 'rule', desc: false }]} />
          </Section>
          <Section
            band
            title={`Fixtures (${cases.length})`}
            right={
              <div role="tablist" aria-label="Case filter" className="flex">
                {([
                  ['all', 'All'],
                  ['fp_fn', 'FP / FN only'],
                  ['known', 'Known limitations'],
                ] as Array<[Filter, string]>).map(([key, label]) => (
                  <button key={key} role="tab" type="button" aria-selected={filter === key} className="tab" onClick={() => setFilter(key)}>
                    {label}
                  </button>
                ))}
              </div>
            }
          >
            <DataTable
              columns={caseColumns}
              data={cases}
              getRowId={(c) => c.id}
              emptyTitle={filter === 'fp_fn' ? 'No false positives or negatives' : 'No cases'}
              rowClassName={(c) => (c.false_positive.length || c.false_negative.length ? 'bg-red/5' : c.known_limitation ? 'bg-band' : undefined)}
              className="bg-surface"
              maxHeight="70vh"
              caption="Golden cases"
            />
          </Section>
        </>
      )}
    </div>
  );
}
