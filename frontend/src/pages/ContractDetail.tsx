import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useContractMetrics, useContracts } from '../api/hooks';
import type { ContractMetricsQuery, RateOut, RunContractMetricsOut, RunCorpus, SliceOut, TrendPointOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { Field, PageHeader, Section } from '../components/layout/Page';
import { Chip } from '../components/ui/Chip';
import { KeyValue } from '../components/ui/KeyValue';
import { ConfusionMatrix } from '../components/charts/ConfusionMatrix';
import { RateRange } from '../components/charts/RateRange';
import { TrendChart } from '../components/charts/TrendChart';
import { CorpusChip } from '../components/runs/CorpusChip';
import { ModelId } from '../components/runs/ModelId';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { cn } from '../lib/cn';
import { fmtTs } from '../lib/format';
import { axisMax, fmtCi, fmtPct } from '../lib/significance';
import { roleLabel, severityTone } from '../lib/vocab';

const CORPORA: Array<[RunCorpus, string]> = [
  ['synthetic', 'Development calls'],
  ['holdout', 'Held-out calls'],
  ['ingested', 'Ingested (unlabelled)'],
];

const FAMILY_TEXT: Record<string, string> = {
  judgment: 'Judgment — the model says compliant or non-compliant; ground truth says the same. Scored per call.',
  flags: 'Flags — the model flags phrases; ground truth lists the phrases that must be flagged. Scored per phrase.',
  grounding: 'Grounding — pass or fail per call; reported as a failure rate.',
  judged: 'Judged — an advisory judge score; reported as a FLAG rate. Never gates a release.',
};

function runLabel(r: Pick<RunContractMetricsOut, 'model_id' | 'prompt_version' | 'rule_date' | 'adapter' | 'run_id'>): string {
  return `${r.model_id} · prompt v${r.prompt_version} · rule date ${r.rule_date} · ${r.adapter} · ${r.run_id.slice(0, 8)}`;
}

/** One rate with its interval: "Recall 67%  [CI 42–85%]  8/12" plus a bar on 0–100%. */
function MetricLine({ label, hint, rate, tone = 'slate' }: { label: string; hint: string; rate: RateOut | null | undefined; tone?: 'slate' | 'green' | 'red' | 'amber' }) {
  if (!rate) return null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-hairline py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-ink">{label}</div>
        <div className="text-[11.5px] leading-snug text-ink-2">{hint}</div>
      </div>
      <div className="text-right">
        <span className="stat text-[18px] text-ink">{fmtPct(rate.rate)}</span>
        <div className="font-mono text-[11px] text-ink-2">
          95% CI {fmtCi(rate)} · {rate.k}/{rate.n}
        </div>
      </div>
      <RateRange rate={rate} max={1} tone={tone} className="col-span-2 mt-1.5" label={label} />
    </div>
  );
}

function Excluded({ run }: { run: RunContractMetricsOut }) {
  const c = run.confusion;
  const rows: Array<[string, number, string]> = [
    ['Not applicable', c?.not_applicable ?? 0, 'Medigap calls: these CMS rules do not govern them'],
    ['Unlabelled', c?.not_evaluated ?? run.excluded_not_evaluated, 'ingested calls with no ground truth — neither pass nor fail'],
    ['No usable output', c?.no_output ?? 0, 'ERROR: the model returned nothing to classify (counts as a failure in the failure rate)'],
  ];
  return (
    <ul className="mt-2 space-y-1 text-[12px]" aria-label="Excluded from the matrix">
      {rows.map(([label, n, why]) => (
        <li key={label} className="flex items-baseline gap-2">
          <span className={cn('stat w-8 shrink-0 text-right text-[13px]', n ? 'text-ink' : 'text-ink-3')}>{n}</span>
          <span className={n ? 'text-ink' : 'text-ink-3'}>
            <span className="font-medium">{label}</span> — {why}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AccuracyCard({ run, family, positive }: { run: RunContractMetricsOut; family: string; positive: string | null }) {
  const c = run.confusion;
  if (!c) {
    const f = run.failure;
    return (
      <div className="card grid grid-cols-1 gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="eyebrow mb-1">{family === 'judged' ? 'FLAG rate' : 'Failure rate'}</div>
          <div className="stat text-[30px] text-ink">{fmtPct(f.rate)}</div>
          <div className="font-mono text-[12px] text-ink-2">
            95% CI {fmtCi(f)} · {f.k} of {f.n} calls
          </div>
          <RateRange rate={f} max={1} tone={f.k ? 'red' : 'green'} className="mt-2" label="Failure rate" />
          <p className="mt-2 text-[12px] leading-snug text-ink-2">
            No confusion matrix: this contract has no violation ground truth to compare against. It is pass/fail per call.
          </p>
        </div>
        <div>
          <div className="eyebrow mb-1">Outcomes</div>
          <KeyValue rows={Object.entries(run.outcomes).map(([k, v]) => ({ key: k, value: String(v) }))} />
          {run.excluded_not_evaluated > 0 && <div className="mt-1 text-[12px] text-ink-2">{run.excluded_not_evaluated} unlabelled calls excluded.</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="card grid grid-cols-1 gap-x-6 gap-y-4 p-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="eyebrow mb-2">Confusion matrix · positive = violation</div>
        <ConfusionMatrix confusion={c} />
        <div className="eyebrow mt-3">Excluded from the matrix</div>
        <Excluded run={run} />
      </div>
      <div className="min-w-0">
        <div className="eyebrow mb-1">Rates, with 95% Wilson intervals</div>
        <MetricLine label="Recall" hint="of the real violations, how many it caught" rate={c.recall} tone={c.fn ? 'red' : 'green'} />
        <MetricLine label="Precision" hint="of what it called a violation, how much was one" rate={c.precision} tone={c.fp ? 'amber' : 'green'} />
        {c.false_flag_rate && <MetricLine label="False-alarm rate" hint="of the compliant calls, how many it flagged" rate={c.false_flag_rate} tone={c.fp ? 'amber' : 'green'} />}
        <div className="flex items-baseline justify-between border-b border-hairline py-2">
          <div>
            <div className="text-[13px] font-semibold text-ink">F1</div>
            <div className="text-[11.5px] text-ink-2">harmonic mean of precision and recall · no interval</div>
          </div>
          <span className="stat text-[18px] text-ink">{c.f1 === null ? 'n/a' : c.f1.toFixed(2)}</span>
        </div>
        {positive && <p className="mt-2 text-[11.5px] leading-snug text-ink-3">{positive}</p>}
      </div>
    </div>
  );
}

function SliceGroup({ title, slices, max }: { title: string; slices: SliceOut[]; max: number }) {
  if (!slices.length) return null;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-hairline bg-band px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-2">{title}</div>
      <ul>
        {slices.map((s) => (
          <li
            key={`${s.dimension}-${s.value}`}
            className={cn('grid grid-cols-[minmax(0,1fr)_minmax(110px,160px)] items-center gap-x-4 border-b border-hairline px-3 py-2 last:border-b-0', s.notable && 'bg-amber/6 shadow-[inset_3px_0_0_0_var(--color-amber)]')}
            data-notable={s.notable ? 'true' : 'false'}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[12.5px] font-semibold text-ink">{s.value}</span>
                <span className="text-[11px] text-ink-3">n={s.n}</span>
                {s.notable && (
                  <Chip tone="amber" size="xs">
                    <AlertTriangle size={10} aria-hidden /> fails here
                  </Chip>
                )}
              </div>
              <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{s.summary.replace(/^[^:]+:\s*/, '')}</div>
            </div>
            <div>
              <div className="text-right font-mono text-[12px] text-ink">
                {fmtPct(s.failure.rate)} <span className="text-[11px] text-ink-3">({fmtCi(s.failure)})</span>
              </div>
              <RateRange rate={s.failure} max={max} tone={s.notable ? 'amber' : 'slate'} className="mt-1" label={`${s.dimension} ${s.value} failure rate`} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TrendTable({ points }: { points: TrendPointOut[] }) {
  return (
    <div className="card mt-3 overflow-x-auto">
      <table className="dt" aria-label="Failure rate per run">
        <thead>
          <tr>
            <th>Run</th>
            <th>Model · prompt</th>
            <th>Corpus</th>
            <th>Rule date</th>
            <th className="text-right">Failure rate</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {[...points].reverse().map((p) => (
            <tr key={p.run_id} data-corpus={p.corpus}>
              <td>
                <Link to={`/runs/${p.run_id}`} className="font-mono text-[12px]">
                  {p.run_id.slice(0, 8)}
                </Link>
              </td>
              <td className="font-mono text-[12px]">
                <ModelId id={p.model_id} /> · v{p.prompt_version}
              </td>
              <td>{p.corpus === 'synthetic' ? <span className="text-[12px] text-ink-2">development</span> : <CorpusChip run={{ stats: {}, corpus: p.corpus }} size="xs" />}</td>
              <td className="font-mono text-[12px]">{p.rule_date}</td>
              <td className="text-right font-mono text-[12px]">
                {fmtPct(p.failure.rate)} <span className="text-ink-3">· {fmtCi(p.failure)} · {p.failure.k}/{p.failure.n}</span>
              </td>
              <td className="font-mono text-[12px] text-ink-2">{fmtTs(p.started_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ContractDetailPage() {
  const { code = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const corpus = (params.get('corpus') as RunCorpus | null) ?? 'synthetic';
  const runParam = params.get('run');
  const contracts = useContracts();
  const query: ContractMetricsQuery = corpus === 'synthetic' ? {} : { corpus };
  const metrics = useContractMetrics(code, query);
  useTopBar([{ label: 'Contracts', to: '/contracts' }, { label: code }]);

  const contract = contracts.data?.find((c) => c.code === code);
  const m = metrics.data;
  const run = useMemo(() => m?.runs.find((r) => r.run_id === runParam) ?? m?.runs[0], [m, runParam]);
  const sliceMax = useMemo(() => axisMax(run?.slices.map((s) => s.failure) ?? []), [run]);

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'corpus') next.delete('run');
    setParams(next, { replace: true });
  };

  if (contracts.isLoading || (metrics.isLoading && !m)) return <LoadingState className="p-6" rows={6} />;
  if (!contract && !m) {
    return (
      <div className="p-6">
        {metrics.error ? (
          <ErrorState error={metrics.error} title={`Could not load contract ${code}`} retry={() => void metrics.refetch()} />
        ) : (
          <EmptyState title="No such contract" hint={`${code} is not in the contract registry.`} />
        )}
      </div>
    );
  }
  const title = contract?.title ?? m?.title ?? code;
  const severity = contract?.severity ?? m?.severity ?? '';
  const kind = contract?.kind ?? m?.kind ?? '';
  const family = m?.metric_family ?? 'grounding';

  return (
    <div>
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <span className="font-mono text-[12px] font-semibold tracking-[0.04em] text-slate">{code}</span>
            <span aria-hidden className="text-input">·</span>
            <span>Behavioral contract</span>
          </span>
        }
        title={title}
        description={
          <div className="space-y-1.5">
            {contract?.description && <p className="m-0">{contract.description}</p>}
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone={severityTone(severity)} title={severity === 'BLOCK' ? 'A failure can gate a release' : 'Advisory: visible, never gates'}>
                {severity}
              </Chip>
              <Chip tone={kind === 'JUDGED' ? 'teal' : 'neutral'}>{kind}</Chip>
              {contract && <span className="text-[12px] text-ink-2">owner {roleLabel(contract.owner_role)}</span>}
              {contract?.rule_code && (
                <Link to={`/rules/${encodeURIComponent(contract.rule_code)}`} className="inline-flex items-center gap-1 font-mono text-[12px]">
                  rule {contract.rule_code} <ExternalLink size={11} aria-hidden />
                </Link>
              )}
              <span className="font-mono text-[12px] text-ink-3">
                check {contract?.check ?? m?.check}
                {contract ? ` · v${contract.version}` : ''}
              </span>
            </div>
          </div>
        }
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Calls" htmlFor="cd-corpus">
              <select id="cd-corpus" className="input w-auto" value={corpus} onChange={(e) => set('corpus', e.target.value === 'synthetic' ? null : e.target.value)}>
                {CORPORA.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Run (latest per model · prompt)" htmlFor="cd-run">
              <select id="cd-run" className="input w-auto max-w-[min(420px,90vw)]" value={run?.run_id ?? ''} onChange={(e) => set('run', e.target.value)} disabled={!m?.runs.length}>
                {(m?.runs ?? []).map((r) => (
                  <option key={r.run_id} value={r.run_id}>
                    {runLabel(r)}
                  </option>
                ))}
                {!m?.runs.length && <option value="">no completed run on these calls</option>}
              </select>
            </Field>
          </div>
        }
      />

      {metrics.error && !m && (
        <div className="px-4 sm:px-6">
          <ErrorState error={metrics.error} title="Accuracy unavailable" retry={() => void metrics.refetch()} />
        </div>
      )}

      {m && !run && (
        <Section>
          <div className="card">
            <EmptyState
              title="No completed run on these calls"
              hint={corpus === 'holdout' ? 'Held-out calls are replayed from the CLI; nothing has been scored on them yet.' : 'Start a run to measure this contract.'}
              action={
                <Link to="/runs" className="btn btn-outline btn-sm hover:no-underline">
                  Go to Runs
                </Link>
              }
            />
          </div>
        </Section>
      )}

      {m && run && (
        <>
          <Section
            title="How accurate is it?"
            right={
              <span className="inline-flex flex-wrap items-center gap-2 normal-case tracking-normal">
                <span className="font-mono">
                  <ModelId id={run.model_id} /> · v{run.prompt_version} · {run.rule_date}
                </span>
                <CorpusChip run={{ stats: {}, corpus: run.corpus }} size="xs" />
                <Link to={`/runs/${run.run_id}`} className="font-mono">
                  run {run.run_id.slice(0, 8)} →
                </Link>
              </span>
            }
          >
            <p className="mb-2 text-[12.5px] text-ink-2">{FAMILY_TEXT[family] ?? family}</p>
            <AccuracyCard run={run} family={family} positive={m.positive_definition} />
          </Section>

          <Section title="Findings">
            <ol className="card space-y-0 p-0" aria-label="Findings">
              {run.findings.map((f, i) => (
                <li key={f} className={cn('border-b border-hairline px-4 py-2 text-[13px] leading-snug last:border-b-0', i === 0 ? 'font-semibold text-ink' : 'text-ink')}>
                  {f}
                </li>
              ))}
            </ol>
          </Section>

          <Section title="Where it fails" right={<span>amber rows: every violation missed, or the interval sits above the overall rate</span>}>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <SliceGroup title="By scenario" slices={run.slices.filter((s) => s.dimension === 'scenario')} max={sliceMax} />
              <SliceGroup title="By product line" slices={run.slices.filter((s) => s.dimension === 'product_line')} max={sliceMax} />
            </div>
          </Section>
        </>
      )}

      {m && m.trend.length > 0 && (
        <Section title={`Failure rate across runs · ${m.trend.length} run${m.trend.length === 1 ? '' : 's'}`}>
          <div className="card p-4">
            <TrendChart points={m.trend} />
          </div>
          <TrendTable points={m.trend} />
        </Section>
      )}

      {m && (
        <Section>
          <p className="text-[11.5px] leading-snug text-ink-3">
            <span className="font-semibold text-ink-2">How failure is counted.</span> {m.failure_definition} <span className="font-mono">Selection: {m.selection}.</span>
          </p>
        </Section>
      )}
    </div>
  );
}
