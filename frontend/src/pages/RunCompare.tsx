import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRight } from 'lucide-react';
import { useCompare, usePromptDiff, useRuns, useWorkflow } from '../api/hooks';
import type { CompareCell, PerContractDelta, RuleVersionRef, RunOut, WhatChanged } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section, Field } from '../components/layout/Page';
import { DiffChips } from '../components/runs/DiffChips';
import { DataTable } from '../components/ui/DataTable';
import { GateChip } from '../components/runs/GateChip';
import { AdapterChip } from '../components/runs/AdapterChip';
import { Chip } from '../components/ui/Chip';
import { KeyValue } from '../components/ui/KeyValue';
import { RunFacts } from '../components/runs/RunFacts';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { fmtTs, shortHash } from '../lib/format';
import { outcomeTone } from '../lib/vocab';
import { cn } from '../lib/cn';
import { runCorpus } from '../lib/runStats';
import { CorpusChip } from '../components/runs/CorpusChip';
import { ChangeMatrix } from '../components/charts/ChangeMatrix';
import { Eyebrow } from '../components/ui/Eyebrow';
import { SignificancePanel } from '../components/runs/SignificancePanel';
import { AttributionPanel } from '../components/runs/AttributionPanel';

function RunHeader({ run, side, changed }: { run: RunOut; side: 'A' | 'B'; changed: WhatChanged }) {
  const hl = (k: keyof WhatChanged) => (changed[k] === true ? 'rounded-[3px] bg-teal/12 font-semibold text-ink px-1 -mx-1' : '');
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-[4px] font-mono text-[11px] font-semibold', side === 'B' ? 'bg-teal-ink text-on-navy' : 'bg-band text-slate')} aria-label={`Run ${side}`}>
          {side}
        </span>
        <Link to={`/runs/${run.id}`} className="font-mono text-[13px] font-semibold" title={run.id}>
          {run.id.slice(0, 8)}
        </Link>
        <GateChip gate={run.gate} />
        <CorpusChip run={run} />
        <span className="ml-auto font-mono text-[11px] text-ink-2">{fmtTs(run.started_at)}</span>
      </div>
      <KeyValue
        className="mt-2"
        rows={[
          { key: 'Prompt', value: <span className={hl('prompt')}>{run.workflow_code} v{run.prompt_version} · {shortHash(run.prompt_hash, 16)}</span> },
          { key: 'Model', value: <span className={hl('model')}>{run.model_id}</span> },
          { key: 'Rule date', value: <span className={hl('rule_date')}>{run.rule_date}</span> },
          { key: 'Adapter', value: <span className={hl('adapter')}><AdapterChip adapter={run.adapter} /></span> },
          {
            key: 'Corpus',
            value: (
              <span className={hl('corpus')}>
                {runCorpus(run)} · {shortHash(run.corpus_hash, 16)}
              </span>
            ),
          },
          { key: 'Contract set', value: <span className={hl('contract_set')}>{shortHash(run.contract_set_hash, 16)}</span> },
          { key: 'Trigger', value: run.trigger },
        ]}
      />
      <RunFacts run={run} className="mt-2" showAdapter={false} />
    </div>
  );
}

/** " · HELD-OUT" / " · INGESTED" for the run picker; nothing for the development corpus. */
function corpusSuffix(run: RunOut): string {
  const corpus = runCorpus(run);
  if (corpus === 'synthetic') return '';
  return ` · ${corpus === 'holdout' ? 'HELD-OUT' : corpus.toUpperCase()}`;
}

/**
 * Cells only one run scored (different call sets) are left out of every count
 * on this page; say so, or a held-out vs development compare reads as a clean delta.
 */
export function CallSetNotice({ whatChanged }: { whatChanged: WhatChanged }) {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const onlyA = num(whatChanged.cells_only_in_a);
  const onlyB = num(whatChanged.cells_only_in_b);
  if (whatChanged.corpus !== true && onlyA === 0 && onlyB === 0) return null;
  return (
    <div role="note" className="mb-4 rounded-[8px] border border-amber/40 bg-amber/8 px-4 py-2.5 text-[13px] text-ink">
      <strong className="font-semibold text-amber-ink">Different call sets:</strong> {onlyA} {onlyA === 1 ? 'cell' : 'cells'} only
      in A, {onlyB} only in B were not compared. Every count below covers only the cells both runs scored.
    </div>
  );
}

function DeltaBar({ a, b, max }: { a: number; b: number; max: number }) {
  const w = (n: number) => `${max > 0 ? Math.round((n / max) * 100) : 0}%`;
  return (
    <div className="flex w-[220px] flex-col gap-0.5" aria-hidden>
      <div className="flex items-center gap-1">
        <span className="w-3 font-mono text-[10px] text-ink-3">A</span>
        <div className="h-2 flex-1 bg-band"><div className="h-2 bg-ink-3" style={{ width: w(a) }} /></div>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-3 font-mono text-[10px] text-ink-3">B</span>
        <div className="h-2 flex-1 bg-band"><div className={cn('h-2', b > a ? 'bg-red' : b < a ? 'bg-green' : 'bg-ink-3')} style={{ width: w(b) }} /></div>
      </div>
    </div>
  );
}

/** Non-PASS cells, with the ERROR share when the server breaks it out ("12 · 3 err"). */
function FailCount({ fail, errors }: { fail: number; errors?: number }) {
  return (
    <span title={errors ? `${errors} of ${fail} are ERROR (no usable output)` : undefined}>
      {fail}
      {errors ? <span className="ml-1 text-[11px] text-ink-3">· {errors} err</span> : null}
    </span>
  );
}

function RefChips({ refs, tone }: { refs: RuleVersionRef[]; tone: 'red' | 'green' | 'neutral' }) {
  if (!refs.length) return <span className="text-ink-3">none</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {refs.map((r) => (
        <Link key={`${r.rule}@${r.version}`} to={`/rules/${encodeURIComponent(r.rule)}`} className="hover:no-underline">
          <Chip tone={tone} mono>
            {r.rule}@v{r.version}
          </Chip>
        </Link>
      ))}
    </span>
  );
}

/** Unified diff of the two prompt versions plus the declared rule dependencies that moved. */
function PromptDiffPanel({ a, b }: { a: RunOut; b: RunOut }) {
  const workflow = useWorkflow(a.workflow_code);
  const idFor = (run: RunOut) => workflow.data?.prompt_versions.find((p) => p.version === run.prompt_version)?.id ?? null;
  const aId = idFor(a);
  const bId = idFor(b);
  const diff = usePromptDiff(aId, bId);
  if (workflow.isLoading || diff.isLoading) return <LoadingState rows={4} />;
  if (workflow.error) return <ErrorState error={workflow.error} title="Could not map prompt versions to ids" />;
  if (diff.error) return <ErrorState error={diff.error} title="Prompt diff failed" />;
  if (!diff.data) return <EmptyState title="No prompt diff" hint="The two runs use prompt versions this workflow does not list." className="py-4" />;
  const d = diff.data;
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-band px-3 py-1.5 text-[12px]">
          <span className="font-mono">
            v{d.a.version} <span className="text-ink-3">{shortHash(d.a.prompt_hash, 16)}</span>
          </span>
          <ArrowRight size={12} className="text-ink-3" aria-hidden />
          <span className="font-mono">
            v{d.b.version} <span className="text-ink-3">{shortHash(d.b.prompt_hash, 16)}</span>
          </span>
          <span className="ml-auto text-ink-2">{d.b.label}</span>
        </div>
        <pre className="max-h-[420px] overflow-auto px-0 py-1 font-mono text-[12px] leading-[1.5]">
          {d.unified_diff.map((line, i) => {
            const kind = line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
            return (
              <div
                key={i}
                className={cn(
                  'whitespace-pre-wrap px-3',
                  kind === 'add' && 'bg-green/12 text-ink',
                  kind === 'del' && 'bg-red/10 text-ink',
                  kind === 'meta' && 'font-semibold text-slate',
                  kind === 'hunk' && 'text-teal-ink',
                  kind === 'ctx' && 'text-ink-2',
                )}
              >
                {line}
              </div>
            );
          })}
        </pre>
      </div>
      <div className="card p-3">
        <div className="eyebrow mb-1">Declared rule dependencies</div>
        <KeyValue
          rows={[
            { key: 'Removed', value: <RefChips refs={d.rule_dependencies.removed} tone="red" />, mono: false },
            { key: 'Added', value: <RefChips refs={d.rule_dependencies.added} tone="green" />, mono: false },
            { key: 'Unchanged', value: <RefChips refs={d.rule_dependencies.unchanged} tone="neutral" />, mono: false },
          ]}
        />
        <p className="mt-2 text-[12px] text-ink-2">Each prompt version declares the rule versions it encodes; the blast-radius screen flags a prompt that declares a superseded version.</p>
      </div>
    </div>
  );
}

export function RunComparePage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const a = params.get('a');
  const b = params.get('b');
  const runs = useRuns();
  const cmp = useCompare(a, b);

  useTopBar([{ label: 'Runs', to: '/runs' }, { label: `Compare ${a?.slice(0, 8) ?? '?'} → ${b?.slice(0, 8) ?? '?'}` }]);

  const cellColumns = useMemo<ColumnDef<CompareCell, unknown>[]>(
    () => [
      { header: 'Transcript', accessorKey: 'transcript_code', meta: { mono: true }, cell: (c) => <span className="font-semibold text-navy">{c.row.original.transcript_code}</span>, size: 100 },
      { header: 'Contract', accessorKey: 'contract_code', meta: { mono: true }, size: 110 },
      {
        id: 'ab',
        header: 'A → B',
        accessorFn: (r) => `${r.a}>${r.b}`,
        cell: (c) => (
          <span className="inline-flex items-center gap-1.5">
            <Chip tone={outcomeTone(c.row.original.a)}>{c.row.original.a}</Chip>
            <ArrowRight size={12} className="text-ink-3" aria-hidden />
            <Chip tone={outcomeTone(c.row.original.b)}>{c.row.original.b}</Chip>
          </span>
        ),
      },
      {
        id: 'open',
        header: 'Evidence',
        enableSorting: false,
        cell: (c) => (
          <span className="inline-flex gap-2 text-[12px]">
            <Link to={`/runs/${a}/transcripts/${encodeURIComponent(c.row.original.transcript_code)}`} onClick={(e) => e.stopPropagation()}>in A</Link>
            <Link to={`/runs/${b}/transcripts/${encodeURIComponent(c.row.original.transcript_code)}`} onClick={(e) => e.stopPropagation()}>in B</Link>
          </span>
        ),
      },
    ],
    [a, b],
  );

  const maxBad = useMemo(() => Math.max(1, ...(cmp.data?.per_contract ?? []).flatMap((p) => [p.a_fail, p.b_fail])), [cmp.data]);

  const perContractColumns = useMemo<ColumnDef<PerContractDelta, unknown>[]>(
    () => [
      { header: 'Contract', accessorKey: 'contract_code', meta: { mono: true }, cell: (c) => <span className="font-semibold text-navy">{c.row.original.contract_code}</span> },
      { header: 'A failing', accessorKey: 'a_fail', meta: { align: 'right', mono: true }, cell: (c) => <FailCount fail={c.row.original.a_fail} errors={c.row.original.a_error} /> },
      { header: 'B failing', accessorKey: 'b_fail', meta: { align: 'right', mono: true }, cell: (c) => <FailCount fail={c.row.original.b_fail} errors={c.row.original.b_error} /> },
      {
        id: 'delta',
        header: 'Δ',
        accessorFn: (p) => p.b_fail - p.a_fail,
        meta: { align: 'right', mono: true },
        cell: (c) => {
          const d = c.row.original.b_fail - c.row.original.a_fail;
          return <span className={cn('font-semibold', d > 0 ? 'text-red' : d < 0 ? 'text-green-ink' : 'text-ink-3')}>{d > 0 ? `+${d}` : d}</span>;
        },
        size: 60,
      },
      { id: 'bars', header: 'Failing cells A vs B', enableSorting: false, cell: (c) => <DeltaBar a={c.row.original.a_fail} b={c.row.original.b_fail} max={maxBad} /> },
      { header: 'Newly failing', accessorKey: 'newly_failing', meta: { align: 'right', mono: true }, cell: (c) => <span className={c.row.original.newly_failing ? 'font-semibold text-red' : 'text-ink-3'}>{c.row.original.newly_failing}</span> },
      { header: 'Newly passing', accessorKey: 'newly_passing', meta: { align: 'right', mono: true }, cell: (c) => <span className={c.row.original.newly_passing ? 'font-semibold text-green-ink' : 'text-ink-3'}>{c.row.original.newly_passing}</span> },
    ],
    [maxBad],
  );

  const pickB = (
    <Section>
      <div className="card max-w-xl p-4">
        <div className="eyebrow mb-2">Pick the second run</div>
        <Field label={`Compare ${a?.slice(0, 8) ?? '?'} with`} htmlFor="cmp-b">
          <select
            id="cmp-b"
            className="input"
            value={b ?? ''}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              next.set('b', e.target.value);
              setParams(next);
            }}
          >
            <option value="">— choose a run —</option>
            {(runs.data ?? [])
              .filter((r) => r.id !== a)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id.slice(0, 8)} · v{r.prompt_version} · {r.model_id} · {r.adapter} · {r.rule_date} · {r.gate}
                  {corpusSuffix(r)}
                </option>
              ))}
          </select>
        </Field>
      </div>
    </Section>
  );

  const d = cmp.data;
  const stats: Array<[string, number, string]> = d
    ? [
        ['Newly failing', d.newly_failing.length, d.newly_failing.length ? 'text-red' : 'text-ink-3'],
        ['Newly passing', d.newly_passing.length, d.newly_passing.length ? 'text-green-ink' : 'text-ink-3'],
        ['Still failing', d.unchanged_failing, 'text-ink'],
        ['Still passing', d.unchanged_passing, 'text-ink'],
      ]
    : [];

  return (
    <div>
      <PageHeader
        eyebrow="Compare runs"
        title={
          d ? (
            <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="font-mono" title={d.a.id}>
                {d.a.id.slice(0, 8)}
              </span>
              <ArrowRight size={20} className="text-ink-3" aria-label="to" />
              <span className="font-mono" title={d.b.id}>
                {d.b.id.slice(0, 8)}
              </span>
              <span className="text-ink-2">· what changed</span>
            </span>
          ) : (
            'What changed, what broke'
          )
        }
        description={
          d ? (
            <DiffChips whatChanged={d.what_changed} className="mt-1" />
          ) : (
            'Two runs, cell by cell. Newly failing cells are the point: the APIs were green and the prompt may be unchanged, yet the output is wrong under the rule in force.'
          )
        }
      />
      {(!a || !b) && pickB}
      {a && b && cmp.isLoading && <LoadingState className="p-6" rows={5} />}
      {a && b && cmp.error && !cmp.data && (
        <div className="p-6">
          <ErrorState error={cmp.error} title="Comparison failed" retry={() => void cmp.refetch()} />
        </div>
      )}
      {d && (
        <>
          <Section className="pt-0">
            {d.attribution && <AttributionPanel attribution={d.attribution} />}
            <CallSetNotice whatChanged={d.what_changed} />
            {d.statistics && <SignificancePanel stats={d.statistics} />}
            <div className="card grid grid-cols-2 gap-px overflow-hidden bg-hairline md:grid-cols-4">
              {stats.map(([label, value, color]) => (
                <div key={label} className="bg-surface px-4 py-3">
                  <div className="eyebrow">{label}</div>
                  <div className={cn('stat mt-1 text-[26px]', color)}>{value}</div>
                </div>
              ))}
            </div>
            {d.newly_failing.length + d.newly_passing.length > 0 && (
              <div className="mt-4">
                <Eyebrow as="h2" className="mb-2">
                  Change map — contract × call
                </Eyebrow>
                <ChangeMatrix compare={d} runB={d.b.id} />
              </div>
            )}
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <RunHeader run={d.a} side="A" changed={d.what_changed} />
              <RunHeader run={d.b} side="B" changed={d.what_changed} />
            </div>
          </Section>

          <Section
            title="Newly failing — passed in A, fails / flags / errors in B"
            right={<span className={cn('stat text-[13px]', d.newly_failing.length ? 'text-red' : 'text-ink-3')}>{d.newly_failing.length}</span>}
          >
            {d.newly_failing.length ? (
              <DataTable
                columns={cellColumns}
                data={d.newly_failing}
                getRowId={(c) => `${c.transcript_code}|${c.contract_code}`}
                onRowClick={(c) => navigate(`/runs/${b}/transcripts/${encodeURIComponent(c.transcript_code)}`)}
                initialSort={[{ id: 'contract_code', desc: false }]}
                maxHeight="48vh"
                caption="Newly failing cells"
              />
            ) : (
              <div className="card">
                <EmptyState title="Nothing newly failing" hint="Every cell that passed in A still passes in B." className="py-5" />
              </div>
            )}
          </Section>

          <Section
            title="Newly passing — failed / flagged in A, passes in B"
            right={<span className={cn('stat text-[13px]', d.newly_passing.length ? 'text-green-ink' : 'text-ink-3')}>{d.newly_passing.length}</span>}
          >
            <DataTable
              columns={cellColumns}
              data={d.newly_passing}
              getRowId={(c) => `${c.transcript_code}|${c.contract_code}`}
              onRowClick={(c) => navigate(`/runs/${b}/transcripts/${encodeURIComponent(c.transcript_code)}`)}
              initialSort={[{ id: 'contract_code', desc: false }]}
              maxHeight="40vh"
              emptyTitle="Nothing newly passing"
              caption="Newly passing cells"
            />
          </Section>

          <Section title="Per-contract delta">
            <DataTable columns={perContractColumns} data={d.per_contract} getRowId={(p) => p.contract_code} emptyTitle="No per-contract data" initialSort={[{ id: 'delta', desc: true }]} />
            {d.failure_definition && (
              <p className="mt-2 text-[11.5px] leading-snug text-ink-3">
                <span className="font-semibold text-ink-2">Counting.</span> {d.failure_definition}
              </p>
            )}
          </Section>

          {d.what_changed.prompt === true && (
            <Section title={`Prompt diff — v${d.a.prompt_version} → v${d.b.prompt_version}`}>
              <PromptDiffPanel a={d.a} b={d.b} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}
