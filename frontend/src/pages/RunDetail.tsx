import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, ListChecks } from 'lucide-react';
import { useExportRun, useRun, useRunResults, useTranscripts } from '../api/hooks';
import type { ContractSummary, ExportFormat, JudgeCanaryNote, RunOut, RunResultOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section, Field } from '../components/layout/Page';
import { DataTable } from '../components/ui/DataTable';
import { GateChip } from '../components/runs/GateChip';
import { AdapterChip } from '../components/runs/AdapterChip';
import { Chip } from '../components/ui/Chip';
import { KeyValue } from '../components/ui/KeyValue';
import { JudgeChip, RunFacts } from '../components/runs/RunFacts';
import { TranscriptBadge } from '../components/artifacts/SourceBadge';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { EvidenceExport } from '../components/evidence/EvidenceExport';
import { useToast } from '../components/ui/useToast';
import { durationBetween, fmtDuration, fmtNumber, fmtTs, shortHash } from '../lib/format';
import { outcomeTone, severityTone, triggerTone } from '../lib/vocab';
import { evidenceSummary, str } from '../lib/evidence';
import { fmtUsd, outcomeTotals, runCorpus, runStats } from '../lib/runStats';
import { CorpusChip } from '../components/runs/CorpusChip';
import { cn } from '../lib/cn';

const OUTCOME_ORDER: Record<string, number> = { ERROR: 0, FAIL: 1, FLAG: 2, PASS: 3 };

/** One canary note: band as a thin range bar on a 1–5 axis, mean as a marker, in/out of band. */
function CanaryRow({ note }: { note: JudgeCanaryNote }) {
  const pct = (v: number) => `${Math.max(0, Math.min(100, ((v - 1) / 4) * 100))}%`;
  const [lo, hi] = note.band;
  return (
    <tr className="border-b border-hairline last:border-b-0">
      <td className="py-1.5 pr-3 font-mono text-[12px] text-ink">{note.id}</td>
      <td className="w-[46%] py-1.5 pr-3">
        <div className="relative h-3 bg-band" aria-label={`band ${lo}–${hi}, mean ${note.mean}`}>
          <div className={cn('absolute top-0 h-3 opacity-40', note.in_band ? 'bg-green' : 'bg-amber')} style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})` }} />
          <div className={cn('absolute top-[-2px] h-[16px] w-[2px]', note.in_band ? 'bg-navy' : 'bg-red')} style={{ left: pct(note.mean) }} title={`mean ${note.mean}`} />
        </div>
        <div className="mt-0.5 flex justify-between font-mono text-[10px] text-ink-3">
          <span>1</span>
          <span>
            band {lo}–{hi}
          </span>
          <span>5</span>
        </div>
      </td>
      <td className="py-1.5 pr-3 text-right font-mono text-[12px]">{note.mean.toFixed(2)}</td>
      <td className="py-1.5 pr-3 text-right font-mono text-[12px]">{note.variance.toFixed(3)}</td>
      <td className="py-1.5 pr-3 font-mono text-[11px] text-ink-2">{note.scores.map((s) => s.toFixed(2)).join(' ')}</td>
      <td className="py-1.5">
        <Chip tone={note.in_band ? 'green' : 'red'}>{note.in_band ? 'in band' : 'out of band'}</Chip>
      </td>
    </tr>
  );
}

function ExportMenu({ run }: { run: RunOut }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const exportRun = useExportRun();
  const { toast } = useToast();
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const go = (format: ExportFormat) => {
    setOpen(false);
    exportRun.mutate(
      { id: run.id, format },
      {
        onSuccess: (name) => toast({ title: `Exported ${name}`, detail: `GET /runs/${run.id.slice(0, 8)}…/export?format=${format}`, tone: 'green' }),
        onError: (err) => toast({ title: 'Export failed', detail: err.message, tone: 'red' }),
      },
    );
  };
  const items: Array<[ExportFormat, string]> = [
    ['braintrust', 'Braintrust JSON'],
    ['langsmith', 'LangSmith JSON'],
    ['csv', 'CSV'],
  ];
  return (
    <div ref={ref} className="relative">
      <button type="button" className="btn btn-outline" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} disabled={exportRun.isPending}>
        <Download size={13} aria-hidden /> {exportRun.isPending ? 'Exporting…' : 'Export'}
      </button>
      {open && (
        <ul role="menu" className="absolute right-0 top-full z-30 mt-1 w-[200px] border border-hairline bg-surface py-1">
          {items.map(([format, label]) => (
            <li key={format} role="none">
              <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-band" onClick={() => go(format)}>
                {label}
                <span className="ml-1 font-mono text-[11px] text-ink-3">format={format}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RunDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const run = useRun(id);
  const [contract, setContract] = useState('');
  const [outcome, setOutcome] = useState('');
  const results = useRunResults(id, { contract: contract || undefined, outcome: outcome || undefined });
  const transcripts = useTranscripts(500, 0);

  useTopBar([{ label: 'Runs', to: '/runs' }, { label: id.slice(0, 8) }], run.data?.rule_date ?? null);

  const ingestedCodes = useMemo(() => new Set((transcripts.data ?? []).filter((t) => !t.synthetic).map((t) => t.code)), [transcripts.data]);
  const labelsByCode = useMemo(() => new Map((transcripts.data ?? []).map((t) => [t.code, t.labels])), [transcripts.data]);

  const summaryColumns = useMemo<ColumnDef<ContractSummary, unknown>[]>(
    () => [
      { header: 'Contract', accessorKey: 'code', meta: { mono: true }, cell: (c) => <button type="button" className="font-semibold text-navy hover:text-teal-ink" onClick={() => setContract(c.row.original.code)}>{c.row.original.code}</button> },
      { header: 'Title', accessorKey: 'title', meta: { wrap: true } },
      { header: 'Severity', accessorKey: 'severity', cell: (c) => <Chip tone={severityTone(c.row.original.severity)}>{c.row.original.severity}</Chip> },
      { header: 'Kind', accessorKey: 'kind', cell: (c) => <Chip tone="neutral">{c.row.original.kind}</Chip> },
      { header: 'Rule', accessorKey: 'rule_code', cell: (c) => (c.row.original.rule_code ? <Link to={`/rules/${encodeURIComponent(c.row.original.rule_code)}`} className="font-mono">{c.row.original.rule_code}</Link> : <span className="text-ink-3">—</span>) },
      { header: 'Pass', accessorKey: 'passed', meta: { align: 'right', mono: true }, cell: (c) => <span className="text-green-ink">{c.row.original.passed}</span> },
      { header: 'Fail', accessorKey: 'failed', meta: { align: 'right', mono: true }, cell: (c) => <span className={c.row.original.failed ? 'font-semibold text-red' : 'text-ink-3'}>{c.row.original.failed}</span> },
      { header: 'Flag', accessorKey: 'flagged', meta: { align: 'right', mono: true }, cell: (c) => <span className={c.row.original.flagged ? 'font-semibold text-amber-ink' : 'text-ink-3'}>{c.row.original.flagged}</span> },
      { header: 'Error', accessorKey: 'errored', meta: { align: 'right', mono: true }, cell: (c) => <span className={c.row.original.errored ? 'font-semibold text-red' : 'text-ink-3'}>{c.row.original.errored}</span> },
    ],
    [],
  );

  const resultColumns = useMemo<ColumnDef<RunResultOut, unknown>[]>(
    () => [
      {
        header: 'Transcript',
        accessorKey: 'transcript_code',
        meta: { mono: true },
        cell: (c) => (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-semibold text-navy">{c.row.original.transcript_code}</span>
            {ingestedCodes.has(c.row.original.transcript_code) && <TranscriptBadge synthetic={false} labels={labelsByCode.get(c.row.original.transcript_code)} />}
          </span>
        ),
        size: 120,
      },
      { header: 'Contract', accessorKey: 'contract_code', meta: { mono: true }, size: 110 },
      { header: 'Severity', accessorKey: 'severity', cell: (c) => <Chip tone={severityTone(c.row.original.severity)}>{c.row.original.severity}</Chip>, size: 80 },
      {
        header: 'Outcome',
        accessorKey: 'outcome',
        sortingFn: (a, b) => (OUTCOME_ORDER[a.original.outcome] ?? 9) - (OUTCOME_ORDER[b.original.outcome] ?? 9),
        cell: (c) => <Chip tone={outcomeTone(c.row.original.outcome)}>{c.row.original.outcome}</Chip>,
        size: 80,
      },
      { id: 'evidence', header: 'Evidence', accessorFn: (r) => evidenceSummary(r.contract_code, r.evidence), meta: { wrap: true }, cell: (c) => <span className="block max-w-[620px] text-[12px] leading-snug text-ink">{evidenceSummary(c.row.original.contract_code, c.row.original.evidence)}</span> },
      { header: 'Latency', accessorKey: 'latency_ms', meta: { align: 'right', mono: true }, cell: (c) => `${c.row.original.latency_ms} ms`, size: 80 },
    ],
    [ingestedCodes, labelsByCode],
  );

  if (run.isLoading) return <LoadingState className="p-6" rows={5} />;
  if (run.error && !run.data) {
    return (
      <div className="p-6">
        <ErrorState error={run.error} title={`Could not load run ${id}`} retry={() => void run.refetch()} />
      </div>
    );
  }
  if (!run.data) return null;
  const r = run.data;
  const s = runStats(r);
  const totals = outcomeTotals(r);
  const logicKeys = [...new Set([...Object.keys(s.logic_in_force ?? {}), ...Object.keys(s.logic_declared_by_prompt ?? {})])];
  const logicMismatch = logicKeys.filter((k) => str(s.logic_in_force?.[k]) !== str(s.logic_declared_by_prompt?.[k]));

  return (
    <div>
      <PageHeader
        eyebrow="Run"
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            <span className="font-mono" title={r.id}>
              {r.id.slice(0, 8)}
            </span>
            <GateChip gate={r.gate} />
            <Chip tone={triggerTone(r.trigger)}>{r.trigger}</Chip>
            <Chip tone={r.status === 'COMPLETE' ? 'green' : r.status === 'FAILED' ? 'red' : 'amber'}>{r.status}</Chip>
            <JudgeChip run={r} />
            <CorpusChip run={r} />
          </span>
        }
        description={
          <>
            {r.workflow_code} · {r.prompt_label} · {r.model_label} · requested by {r.requested_by}
            {r.deduplicated ? ' · deduplicated' : ''}
            <RunFacts run={r} className="mt-1" />
          </>
        }
        actions={
          <>
            <EvidenceExport
              scope="runs"
              id={r.id}
              preview={[
                { label: 'Run', value: `${r.id.slice(0, 8)} · ${r.status.toLowerCase()} · ${r.trigger.toLowerCase()} trigger`, mono: true },
                { label: 'Gate', value: <GateChip gate={r.gate} /> },
                { label: 'Prompt', value: `${r.workflow_code} v${r.prompt_version} · ${shortHash(r.prompt_hash, 12)}`, mono: true },
                { label: 'Model', value: `${r.model_id} · ${r.adapter}`, mono: true },
                { label: 'Rule date', value: r.rule_date, mono: true },
                { label: 'Results', value: `${totals.PASS} pass · ${totals.FAIL} fail · ${totals.FLAG} flag · ${totals.ERROR} error`, mono: true },
              ]}
            />
            <ExportMenu run={r} />
            <Link to={`/review?run=${encodeURIComponent(r.id)}`} className="btn btn-outline">
              <ListChecks size={13} aria-hidden /> Review tasks from this run
            </Link>
            <Link to={`/runs/compare?a=${r.id}&b=`} className="btn btn-outline">
              Compare with…
            </Link>
          </>
        }
      />

      <Section band>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="card p-3">
            <div className="eyebrow mb-1">Run keys — everything that could change the outcome</div>
            <KeyValue
              rows={[
                { key: 'Run id', value: r.id },
                { key: 'Run key', value: r.run_key },
                { key: 'Prompt', value: `${r.workflow_code} v${r.prompt_version} · ${r.prompt_label}` },
                { key: 'Prompt hash', value: r.prompt_hash },
                { key: 'Model', value: `${r.model_id} · ${r.model_label}` },
                { key: 'Adapter', value: <AdapterChip adapter={r.adapter} /> },
                { key: 'Corpus', value: runCorpus(r) },
                { key: 'Corpus hash', value: r.corpus_hash },
                { key: 'Contract set hash', value: r.contract_set_hash },
                { key: 'Rule date', value: r.rule_date },
              ]}
            />
          </div>
          <div className="card p-3">
            <div className="eyebrow mb-1">Timing and totals</div>
            <KeyValue
              rows={[
                { key: 'Started', value: fmtTs(r.started_at) },
                { key: 'Finished', value: fmtTs(r.finished_at) },
                { key: 'Duration', value: fmtDuration(durationBetween(r.started_at, r.finished_at)) },
                { key: 'Transcripts', value: fmtNumber(s.transcripts ?? null) },
                { key: 'Latency', value: `${fmtDuration(s.latency_ms_total ?? null)} total · ${fmtDuration(s.latency_ms_per_transcript ?? null)} per transcript` },
                { key: 'Adapter errors', value: <span className={s.adapter_errors ? 'text-red' : ''}>{fmtNumber(s.adapter_errors ?? null)}</span> },
                {
                  key: 'Review tasks opened',
                  value: s.review_tasks_opened ? (
                    <Link to={`/review?run=${encodeURIComponent(r.id)}`}>{fmtNumber(s.review_tasks_opened)} actionable →</Link>
                  ) : (
                    fmtNumber(s.review_tasks_opened ?? null)
                  ),
                },
                ...(s.test_cases?.applied !== undefined
                  ? [
                      {
                        key: 'Test cases applied',
                        value: (
                          <Link to="/test-cases" title="Approved override test cases this run honoured: applied = the verdict differed and the approved expectation was used">
                            {fmtNumber(s.test_cases.applied)} applied
                            {typeof s.test_cases.in_scope === 'number' ? ` · ${fmtNumber(s.test_cases.in_scope)} in scope` : ''} →
                          </Link>
                        ),
                      },
                    ]
                  : []),
                ...(s.advisory_items_opened !== undefined
                  ? [
                      {
                        key: 'Advisory items opened',
                        value: s.advisory_items_opened ? (
                          <Link to={`/review?lane=advisory&run=${encodeURIComponent(r.id)}`}>{fmtNumber(s.advisory_items_opened)} advisory · not tickets →</Link>
                        ) : (
                          '0'
                        ),
                      },
                    ]
                  : []),
                { key: 'Cells', value: fmtNumber(totals.cells) },
                { key: 'Passed / failed / flagged / errored', value: (
                  <span>
                    <span className="text-green-ink">{totals.PASS}</span> / <span className={totals.FAIL ? 'text-red' : ''}>{totals.FAIL}</span> / <span className={totals.FLAG ? 'text-amber-ink' : ''}>{totals.FLAG}</span> / <span className={totals.ERROR ? 'text-red' : ''}>{totals.ERROR}</span>
                  </span>
                ) },
              ]}
            />
          </div>
        </div>
        {logicKeys.length > 0 && (
          <div className={cn('card mt-4 p-3', logicMismatch.length ? 'border-red' : '')}>
            <div className="mb-1 flex items-center gap-2">
              <span className="eyebrow">Rule logic — in force on {r.rule_date} vs declared by prompt v{r.prompt_version}</span>
              {logicMismatch.length ? <Chip tone="red">{logicMismatch.length} mismatch{logicMismatch.length === 1 ? '' : 'es'}</Chip> : <Chip tone="green">aligned</Chip>}
            </div>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[1px] text-ink-3">
                  <th className="py-1 font-semibold">knob</th>
                  <th className="py-1 font-semibold">in force</th>
                  <th className="py-1 font-semibold">prompt declares</th>
                </tr>
              </thead>
              <tbody>
                {logicKeys.map((k) => {
                  const mismatch = logicMismatch.includes(k);
                  return (
                    <tr key={k} className="border-t border-hairline">
                      <td className="py-1 font-mono text-slate">{k}</td>
                      <td className="py-1 font-mono">{str(s.logic_in_force?.[k])}</td>
                      <td className={cn('py-1 font-mono', mismatch && 'font-semibold text-red')}>{str(s.logic_declared_by_prompt?.[k])}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Judge canary — six notes with known bands, scored N times each">
        {s.judge_stability ? (
          <div className="card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <JudgeChip run={r} />
              <span className="text-[12px] text-ink-2">
                {s.judge_stability.out_of_band} of {s.judge_stability.notes.length} notes out of band · mean variance{' '}
                <span className="font-mono text-ink">{s.judge_stability.mean_variance}</span> · N={s.judge_stability.n_per_note} per note
              </span>
            </div>
            <table className="mt-2 w-full">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[1px] text-ink-3">
                  <th className="py-1 font-semibold">note</th>
                  <th className="py-1 font-semibold">band and mean (1–5)</th>
                  <th className="py-1 text-right font-semibold">mean</th>
                  <th className="py-1 text-right font-semibold">variance</th>
                  <th className="py-1 font-semibold">scores</th>
                  <th className="py-1 font-semibold">verdict</th>
                </tr>
              </thead>
              <tbody>
                {s.judge_stability.notes.map((n) => (
                  <CanaryRow key={n.id} note={n} />
                ))}
              </tbody>
            </table>
            {s.judge_stability.note && <p className="mt-2 text-[12px] text-ink-2">{s.judge_stability.note}</p>}
          </div>
        ) : (
          <EmptyState title="No judge stability data on this run" hint="stats.judge_stability is written when a JUDGED contract runs." className="py-4" />
        )}
      </Section>

      <Section band title="Cost">
        {s.cost ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="card p-3">
              <KeyValue
                rows={[
                  { key: 'This run', value: fmtUsd(s.cost.usd) },
                  { key: 'Per call', value: fmtUsd(s.cost.per_call_usd, true) },
                  { key: 'Basis', value: s.cost.basis, mono: false },
                  ...(s.cost.input_tokens !== undefined ? [{ key: 'Tokens in / out', value: `${fmtNumber(s.cost.input_tokens)} / ${fmtNumber(s.cost.output_tokens ?? null)}` }] : []),
                ]}
              />
            </div>
            <div className="card p-3">
              <div className="eyebrow mb-1">Projection</div>
              {s.cost.projection ? (
                <>
                  <KeyValue
                    rows={[
                      { key: 'Calls per day (assumed)', value: fmtNumber(s.cost.projection.calls_per_day) },
                      { key: 'USD per day', value: fmtUsd(s.cost.projection.usd_per_day) },
                      { key: 'USD per AEP', value: fmtUsd(s.cost.projection.usd_per_aep) },
                    ]}
                  />
                  <p className="mt-2 text-[12px] text-ink-2">{s.cost.projection.note ?? 'Volume is an assumption, not a measurement — replace calls per day with the floor’s real counts before quoting a number.'}</p>
                </>
              ) : (
                <span className="text-[12px] text-ink-3">no projection on this run</span>
              )}
            </div>
          </div>
        ) : (
          <EmptyState title="No cost data on this run" className="py-4" />
        )}
      </Section>

      <Section title="Per-contract summary">
        <DataTable columns={summaryColumns} data={r.contracts} getRowId={(c) => c.code} emptyTitle="No contract summaries" initialSort={[{ id: 'failed', desc: true }]} />
      </Section>

      <Section
        band
        title="Results — transcript × contract"
        right={
          <div className="flex items-end gap-2">
            <Field label="Contract" htmlFor="rf-contract">
              <select id="rf-contract" className="input h-7 w-[150px] text-[12px]" value={contract} onChange={(e) => setContract(e.target.value)}>
                <option value="">all</option>
                {r.contracts.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Outcome" htmlFor="rf-outcome">
              <select id="rf-outcome" className="input h-7 w-[110px] text-[12px]" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                <option value="">all</option>
                {['FAIL', 'FLAG', 'ERROR', 'PASS'].map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        }
      >
        <DataTable
          columns={resultColumns}
          data={results.data}
          isLoading={results.isLoading}
          error={results.error}
          retry={() => void results.refetch()}
          getRowId={(x) => x.id}
          onRowClick={(x) => navigate(`/runs/${r.id}/transcripts/${encodeURIComponent(x.transcript_code)}`)}
          initialSort={[{ id: 'outcome', desc: false }]}
          maxHeight="60vh"
          emptyTitle="No results match"
          className="bg-surface"
          caption="Run results"
        />
        <div className="mt-2 text-[11px] text-ink-3">Click a row to open the transcript with its extraction, composition, contract evidence and judge scores.</div>
      </Section>
    </div>
  );
}
