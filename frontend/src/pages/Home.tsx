import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, BookOpen, ChevronDown, Cpu, FileCode2, ListChecks, ScanText } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { useCompare, useContracts, useImpact, useMeta, useReviewTasks, useRules, useRuns, useStatus } from '../api/hooks';
import type { CompareOut, RunOut, StatusOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { Section } from '../components/layout/Page';
import { GateChip } from '../components/runs/GateChip';
import { AdapterChip } from '../components/runs/AdapterChip';
import { ModelId } from '../components/runs/ModelId';
import { Chip } from '../components/ui/Chip';
import { JudgeChip, RunFacts } from '../components/runs/RunFacts';
import { baselineFor, blockingFailures, costLabel, judgeModelId, latestByTrigger, latestPerConfiguration, runStats, sumOutcomes } from '../lib/runStats';
import { CorpusChip } from '../components/runs/CorpusChip';
import { OutcomeBar } from '../components/charts/OutcomeBar';
import { groupActionable, taskLane } from '../lib/review';
import { DataTable } from '../components/ui/DataTable';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { fmtDate, fmtNumber, fmtTs, todayIso } from '../lib/format';
import { kindLabel, triggerTone } from '../lib/vocab';
import { cn } from '../lib/cn';
import { WhereWeAre } from '../components/overview/WhereWeAre';
import { readGuideHidden, writeGuideHidden } from '../lib/guide';
import { governingVersions, latestGoverning } from '../lib/ruleVersions';
import { ReadinessCard } from '../components/overview/ReadinessCard';

/** The card and guide entrance plays once per page load, never on a return visit or a refetch. */
let entrancePlayed = false;

function topContracts(cells: CompareOut['newly_failing']): string {
  const counts = new Map<string, number>();
  for (const c of cells) counts.set(c.contract_code, (counts.get(c.contract_code) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, n]) => `${n} ${code}`)
    .join(' · ');
}

/** "Scope of Appointment — 48-hour waiting period …" → head + tail, so the card title stays short. */
function splitTitle(title: string): { head: string; tail: string | null } {
  const i = title.indexOf(' — ');
  return i > 0 ? { head: title.slice(0, i), tail: title.slice(i + 3) } : { head: title, tail: null };
}

/** "Qwen2.5 7B — local (Ollama, RTX 3060)" → "Qwen2.5 7B". */
function shortModelLabel(label: string): string {
  return label.split(/ — | \(/)[0].trim() || label;
}

/** "qa-handoff v2 (CY2027 clauses)" → "CY2027 clauses"; otherwise the label itself. */
function promptTitle(label: string): string {
  const m = /\(([^)]+)\)\s*$/.exec(label);
  return m ? m[1] : label;
}

/** The current-state half of a card: what is true now, whatever changed. */
export interface CurrentState {
  run: RunOut | undefined;
  /** FAIL + ERROR on BLOCK-severity contracts in that run */
  blocking: number;
  blockingContracts: string[];
}

type MetricTone = 'red' | 'green' | 'amber' | 'ink' | 'muted';
const METRIC_TONE: Record<MetricTone, string> = {
  red: 'text-red',
  green: 'text-green-ink',
  amber: 'text-amber-ink',
  ink: 'text-ink',
  muted: 'text-ink-3',
};

/** One big number with its label: "22 newly failing". */
function Metric({ value, label, tone = 'ink', size = 'lg' }: { value: ReactNode; label: ReactNode; tone?: MetricTone; size?: 'lg' | 'md' }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={cn('stat', size === 'lg' ? 'text-[24px]' : 'text-[17px]', METRIC_TONE[tone])}>{value}</span>
      <span className="text-[13px] text-ink-2">{label}</span>
    </span>
  );
}

function MetricRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">{children}</div>;
}

function BlockLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <span className="eyebrow text-[10px]">{children}</span>
      {right && <span className="font-mono text-[11px] text-ink-3 tabular-nums">{right}</span>}
    </div>
  );
}

function CurrentStateBlock({ state, empty }: { state: CurrentState; empty: string }) {
  const { run, blocking } = state;
  if (!run) return <div className="text-[12px] leading-snug text-ink-3">{empty}</div>;
  const outcomes = sumOutcomes(runStats(run).contracts);
  return (
    <>
      <MetricRow>
        <Metric value={blocking} tone={blocking ? 'red' : 'green'} label={`blocking ${blocking === 1 ? 'failure' : 'failures'} ${blocking ? 'remain' : '— none remain'}`} />
      </MetricRow>
      {outcomes && <OutcomeBar counts={outcomes} className="mt-2" caption="contract results" />}
    </>
  );
}

function TriggerCard({
  eyebrow,
  icon,
  title,
  subtitle,
  subline,
  delta,
  state,
  stateEmpty,
  to,
  actionLabel,
  loading,
  error,
  meta,
}: {
  eyebrow: string;
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  subline?: ReactNode;
  delta: ReactNode;
  state: CurrentState;
  stateEmpty: string;
  to: string | null;
  actionLabel: string;
  loading: boolean;
  error?: unknown;
  meta?: ReactNode;
}) {
  // Provenance (citation, run id, cost, canary) stays one click away so the
  // three cards and the strip below them fit the first viewport.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const stateTotal = state.run ? (sumOutcomes(runStats(state.run).contracts)?.total ?? null) : null;
  const detailsId = useId();
  return (
    <article
      className="card card-hero flex min-w-0 flex-col transition-colors hover:border-input lg:row-span-4 lg:grid lg:grid-rows-subgrid lg:gap-0"
      aria-label={eyebrow}
    >
      <header className="px-4 pb-3 pt-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-band text-slate">
              {icon}
            </span>
            <span className="eyebrow truncate">{eyebrow}</span>
          </div>
          {!loading && !error && (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-2">
              gate {state.run ? <GateChip gate={state.run.gate} /> : <Chip tone="neutral">not run</Chip>}
            </span>
          )}
        </div>
        {loading ? (
          <LoadingState rows={2} className="px-0 pb-0 pt-3" />
        ) : error ? null : (
          <>
            <h2 className="mt-2.5 line-clamp-2 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 line-clamp-1 text-[12.5px] leading-snug text-ink-2">{subtitle}</p>}
            {subline && <div className="mt-1.5 font-mono text-[11.5px] leading-snug text-slate [overflow-wrap:anywhere]">{subline}</div>}
          </>
        )}
      </header>
      {error ? (
        <div className="px-4 pb-4 lg:row-span-2">
          <ErrorState error={error} />
        </div>
      ) : loading ? (
        <div className="lg:row-span-2" />
      ) : (
        <>
          <div className="border-t border-hairline px-4 py-2.5">
            <BlockLabel>Delta · what this change did</BlockLabel>
            {delta}
          </div>
          <div className="border-y border-hairline px-4 py-2.5">
            <BlockLabel right={stateTotal !== null ? `${fmtNumber(stateTotal)} results` : undefined}>Current state · latest run</BlockLabel>
            <CurrentStateBlock state={state} empty={stateEmpty} />
          </div>
        </>
      )}
      <div className="flex flex-1 flex-col px-4 py-3">
        {!loading && (to || meta) && (
          <div className="flex items-center justify-between gap-3">
            {to ? (
              <Link to={to} className="btn btn-sm hover:no-underline">
                {actionLabel} <ArrowRight size={13} aria-hidden />
              </Link>
            ) : (
              <span />
            )}
            {meta && (
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-band hover:text-ink"
                aria-expanded={detailsOpen}
                aria-controls={detailsId}
                onClick={() => setDetailsOpen((v) => !v)}
              >
                Details
                <ChevronDown size={13} aria-hidden className={cn('transition-transform motion-reduce:transition-none', detailsOpen && 'rotate-180')} />
              </button>
            )}
          </div>
        )}
        {meta && !loading && (
          <div id={detailsId} hidden={!detailsOpen} className="mt-3 space-y-1 border-t border-hairline pt-2.5 font-mono text-[11px] leading-relaxed text-ink-3">
            {meta}
          </div>
        )}
      </div>
    </article>
  );
}

/** Product line, live system state from /status, all real counts. */
function Hero({ status, guideHidden, onShowGuide }: { status: StatusOut | undefined; guideHidden: boolean; onShowGuide: () => void }) {
  const healthy = status?.status === 'healthy';
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 pb-4 pt-5 sm:px-6">
      <div className="min-w-0 max-w-[620px]">
        <div className="eyebrow mb-1">Backstop · Change triggers</div>
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.015em] text-ink sm:text-[24px]">Change control for business-critical AI workflows</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">When a rule, a prompt or a model changes: what still holds, what broke, the evidence, and who owns the fix.</p>
        {guideHidden && (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[12.5px]">
            <Link to="/try" className="inline-flex items-center gap-1 font-semibold">
              <ScanText size={13} aria-hidden /> Try it with your own text
            </Link>
            <button type="button" className="inline-flex items-center gap-1 text-ink-2 hover:text-teal-ink" onClick={onShowGuide}>
              <ListChecks size={13} aria-hidden /> Show where we are
            </button>
          </div>
        )}
      </div>
      {status && (
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]" aria-label="System summary">
          <div className={cn('inline-flex items-center gap-2 rounded-[6px] border px-2.5 py-1.5', healthy ? 'border-teal/30 bg-teal/8' : 'border-hairline bg-surface')}>
            <dt className="sr-only">System</dt>
            <span aria-hidden className={cn('h-2 w-2 rounded-full', healthy ? 'bg-green' : status.status === 'degraded' ? 'bg-amber' : 'bg-red')} />
            <dd className={cn('text-[11px] font-semibold uppercase tracking-[0.08em]', healthy ? 'text-green-ink' : status.status === 'degraded' ? 'text-amber-ink' : 'text-red')}>{status.status}</dd>
          </div>
          <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
            {(
              [
                ['rules', status.counts.rules, '/rules'],
                ['artifacts', status.counts.artifacts, '/artifacts'],
                ['contracts', status.counts.contracts, '/contracts'],
                ['awaiting review', status.review.actionable_open, '/review'],
              ] as Array<[string, number, string]>
            ).map(([label, n, to]) => (
              <div key={label} className="flex items-baseline gap-1.5">
                <dt className="sr-only">{label}</dt>
                <dd>
                  <Link to={to} className="inline-flex items-baseline gap-1.5 whitespace-nowrap text-ink-2 hover:text-teal-ink hover:no-underline">
                    <span className={cn('stat text-[15px]', label === 'awaiting review' && n > 0 ? 'text-amber-ink' : 'text-ink')}>{fmtNumber(n)}</span>
                    {label}
                  </Link>
                </dd>
              </div>
            ))}
          </div>
        </dl>
      )}
    </div>
  );
}

const THESIS: Array<[string, string]> = [
  ['What changed', 'a rule, prompt or model'],
  ['What broke', 'contracts that now fail'],
  ['Evidence', 'quoted spans, hash-chained'],
  ['Owner', 'a named role decides'],
];

function ThesisStrip() {
  return (
    <ol aria-label="How Backstop works" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-[8px] border border-hairline bg-surface px-4 py-2 text-[12px]">
      {THESIS.map(([head, tail], i) => (
        <li key={head} className="inline-flex items-center gap-2">
          {i > 0 && <ArrowRight size={13} className="text-ink-3" aria-hidden />}
          <span className="font-semibold text-ink">{head}</span>
          <span className="hidden text-ink-2 md:inline">{tail}</span>
        </li>
      ))}
    </ol>
  );
}

export function HomePage() {
  useTopBar([{ label: 'Change triggers' }]);
  const navigate = useNavigate();
  const meta = useMeta();
  const [guideHidden, setGuideHidden] = useState(readGuideHidden);
  const [animate] = useState(() => !entrancePlayed);
  useEffect(() => {
    entrancePlayed = true;
  }, []);
  const hideGuide = (hidden: boolean) => {
    writeGuideHidden(hidden);
    setGuideHidden(hidden);
  };
  const status = useStatus();
  const rules = useRules();
  const runs = useRuns();
  const openTasks = useReviewTasks({ state: 'open' });
  const contracts = useContracts();
  const today = meta.data?.today ?? todayIso();
  const severityByCode = useMemo(() => new Map((contracts.data ?? []).map((c) => [c.code, c.severity])), [contracts.data]);
  const currentOf = (run: RunOut | undefined): CurrentState => {
    const b = blockingFailures(run, severityByCode);
    return { run, blocking: b.failures, blockingContracts: b.contracts };
  };

  // --- RULE CHANGED: the nearest upcoming flip (or the most recent past one), heaviest first
  const featured = useMemo(() => {
    if (!rules.data?.length) return undefined;
    // Only versions that govern: a proposal is not law, a vacated or stayed version is not enforced.
    const withLatest = rules.data.flatMap((r) => {
      const latest = latestGoverning(r);
      return latest ? [{ rule: r, latest }] : [];
    });
    if (!withLatest.length) return undefined;
    const upcoming = withLatest
      .filter((x) => x.latest.effective_from > today)
      .sort((a, b) => a.latest.effective_from.localeCompare(b.latest.effective_from) || b.rule.dependents - a.rule.dependents);
    if (upcoming.length) return upcoming[0];
    return withLatest.sort((a, b) => b.latest.effective_from.localeCompare(a.latest.effective_from) || b.rule.dependents - a.rule.dependents)[0];
  }, [rules.data, today]);
  const impact = useImpact(featured?.rule.code, featured?.latest.effective_from ?? '');
  const ruleRun = latestByTrigger(runs.data, 'RULE');

  // --- PROMPT CHANGED / MODEL CHANGED: latest run of each trigger vs its baseline
  const promptRun = latestByTrigger(runs.data, 'PROMPT');
  const promptBase = baselineFor(runs.data, promptRun, 'prompt');
  const promptCmp = useCompare(promptBase?.id ?? null, promptRun?.id ?? null);

  const modelRun = latestByTrigger(runs.data, 'MODEL');
  const modelBase = baselineFor(runs.data, modelRun, 'model');
  const modelCmp = useCompare(modelBase?.id ?? null, modelRun?.id ?? null);

  // --- gate strip: latest run per (prompt, model, adapter, judge model, rule date)
  const gateRows = useMemo(() => latestPerConfiguration(runs.data), [runs.data]);

  const gateColumns = useMemo<ColumnDef<RunOut, unknown>[]>(
    () => [
      { header: 'Gate', accessorKey: 'gate', cell: (c) => <GateChip gate={c.row.original.gate} />, size: 80 },
      {
        id: 'configuration',
        header: 'Configuration',
        accessorFn: (r) => `${r.workflow_code} v${r.prompt_version} ${r.model_id}`,
        meta: { wrap: true },
        cell: (c) => {
          const r = c.row.original;
          const judge = judgeModelId(r);
          return (
            <span className="cell-primary [overflow-wrap:anywhere]">
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[12px] font-semibold text-ink">
                  {r.workflow_code} v{r.prompt_version}
                </span>
                <CorpusChip run={r} size="xs" />
              </span>
              <span className="cell-sub font-mono text-[11px]">
                <ModelId id={r.model_id} />
                {judge !== r.model_id && (
                  <span title={`judged by ${judge}`}>
                    {' '}
                    · judge <ModelId id={judge} />
                  </span>
                )}
              </span>
            </span>
          );
        },
      },
      { header: 'Adapter', accessorKey: 'adapter', cell: (c) => <AdapterChip adapter={c.row.original.adapter} /> },
      { header: 'Rule date', accessorKey: 'rule_date', meta: { mono: true } },
      {
        header: 'Trigger',
        accessorKey: 'trigger',
        cell: (c) => <Chip tone={triggerTone(c.row.original.trigger)}>{c.row.original.trigger}</Chip>,
      },
      { id: 'cost', header: 'Cost', accessorFn: (r) => runStats(r).cost?.usd ?? 0, meta: { mono: true, align: 'right', wrap: true }, cell: (c) => <span title={runStats(c.row.original).cost?.basis}>{costLabel(runStats(c.row.original).cost)}</span> },
      { id: 'judge', header: 'Judge', accessorFn: (r) => (runStats(r).judge_stability?.stable ? 1 : 0), cell: (c) => <JudgeChip run={c.row.original} /> },
      { header: 'Started', accessorKey: 'started_at', cell: (c) => <span className="text-ink-2">{fmtTs(c.row.original.started_at)}</span>, meta: { mono: true, wrap: true } },
    ],
    [],
  );

  const openByKind = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of openTasks.data ?? []) if (taskLane(t) === 'actionable') m.set(t.kind, (m.get(t.kind) ?? 0) + 1);
    return m;
  }, [openTasks.data]);
  const openGroups = useMemo(() => groupActionable((openTasks.data ?? []).filter((t) => taskLane(t) === 'actionable')).groups.length, [openTasks.data]);
  const openAdvisory = useMemo(() => (openTasks.data ?? []).filter((t) => taskLane(t) === 'advisory').length, [openTasks.data]);

  // ---------------------------------------------------------------- RULE card
  const counts = impact.data?.counts;
  const ruleState = currentOf(ruleRun);
  const ruleTitle = featured ? splitTitle(featured.rule.title) : null;
  const previousVersion = featured ? governingVersions(featured.rule).filter((v) => v.version < featured.latest.version).pop() : undefined;
  const ruleDelta = featured ? (
    <>
      <MetricRow>
        <Metric value={counts?.artifacts ?? 0} tone={counts?.artifacts ? 'amber' : 'green'} label={`affected ${counts?.artifacts === 1 ? 'artifact' : 'artifacts'}`} />
        <Metric size="md" value={counts?.total ?? 0} tone="ink" label={`stale ${counts?.total === 1 ? 'encoding' : 'encodings'}`} />
      </MetricRow>
      <div className="mt-1.5 text-[12px] leading-snug text-ink-2">
        {counts?.over_restrictive ?? 0} over-restrictive · {counts?.under_restrictive ?? 0} under-restrictive · {counts?.reverify ?? 0} re-verify
        {counts?.disputed ? ` · ${counts.disputed} open question${counts.disputed === 1 ? '' : 's'}` : ''}
      </div>
    </>
  ) : (
    <div className="text-[13px] text-ink-3">No rules loaded</div>
  );

  // ---------------------------------------------------------------- PROMPT card
  const promptState = currentOf(promptRun);
  const promptDelta =
    promptCmp.data && promptBase && promptRun ? (
      <>
        <MetricRow>
          <Metric value={`+${promptCmp.data.newly_passing.length}`} tone={promptCmp.data.newly_passing.length ? 'green' : 'muted'} label="newly passing" />
          <Metric size="md" value={promptCmp.data.newly_failing.length} tone={promptCmp.data.newly_failing.length ? 'red' : 'muted'} label="newly failing" />
        </MetricRow>
      </>
    ) : (
      <div className="text-[13px] leading-snug text-ink-3">{promptRun ? `${promptRun.prompt_label} — no baseline to compare` : 'No prompt-triggered run yet'}</div>
    );

  // ---------------------------------------------------------------- MODEL card
  const modelState = currentOf(modelRun);
  const modelDelta =
    modelCmp.data && modelBase && modelRun ? (
      <>
        <MetricRow>
          <Metric value={modelCmp.data.newly_failing.length} tone={modelCmp.data.newly_failing.length ? 'red' : 'muted'} label="newly failing" />
          <Metric size="md" value={`+${modelCmp.data.newly_passing.length}`} tone={modelCmp.data.newly_passing.length ? 'green' : 'muted'} label="newly passing" />
        </MetricRow>
      </>
    ) : (
      <div className="text-[13px] leading-snug text-ink-3">{modelRun ? `${modelRun.model_label} — no baseline to compare` : 'No model-triggered run yet'}</div>
    );

  const runLine = (run: RunOut) => (
    <div>
      <Link to={`/runs/${run.id}`} className="font-mono" title={`${run.id} · run key ${run.run_key}`}>
        run {run.id.slice(0, 8)}
      </Link>{' '}
      · prompt v{run.prompt_version} · rule date {run.rule_date}
    </div>
  );
  const blockingLine = (s: CurrentState) => (s.blockingContracts.length > 0 ? <div className="text-ink-3">blocking on {s.blockingContracts.join(' · ')}</div> : null);

  return (
    <div>
      <Hero status={status.data} guideHidden={guideHidden} onShowGuide={() => hideGuide(false)} />

      {!guideHidden && (
        <Section className="pb-0 pt-0">
          <WhereWeAre today={today} onDismiss={() => hideGuide(true)} animate={animate} />
        </Section>
      )}

      <Section className={guideHidden ? 'pt-0' : 'pt-3'}>
        <div className={cn('grid grid-cols-1 gap-x-4 gap-y-3 lg:grid-cols-3 lg:gap-y-0', animate && 'stagger')}>
          <TriggerCard
            eyebrow="Rule changed"
            icon={<BookOpen size={14} />}
            title={ruleTitle?.head ?? 'No rules loaded'}
            subtitle={ruleTitle?.tail}
            subline={
              featured && (
                <>
                  {featured.rule.code.toUpperCase()} {previousVersion ? `v${previousVersion.version} → ` : ''}v{featured.latest.version} · applies {fmtDate(featured.latest.effective_from)}
                </>
              )
            }
            delta={ruleDelta}
            state={ruleState}
            stateEmpty="No rule-triggered run yet — start one at the new rule date."
            to={featured ? `/rules/${encodeURIComponent(featured.rule.code)}?as_of=${featured.latest.effective_from}` : null}
            actionLabel="View blast radius"
            loading={rules.isLoading || runs.isLoading || (Boolean(featured) && impact.isLoading)}
            error={rules.error ?? impact.error}
            meta={
              featured && (
                <>
                  <div>
                    {featured.rule.regulator} · {featured.rule.citation} · {featured.latest.change_classification.replace('_', ' ').toLowerCase()}
                  </div>
                  {ruleRun && (
                    <>
                      {runLine(ruleRun)}
                      <RunFacts run={ruleRun} className="font-sans" />
                    </>
                  )}
                  {blockingLine(ruleState)}
                </>
              )
            }
          />
          <TriggerCard
            eyebrow="Prompt changed"
            icon={<FileCode2 size={14} />}
            title={promptRun ? promptTitle(promptRun.prompt_label) : 'No prompt change yet'}
            subtitle={promptRun ? `${promptRun.workflow_code} prompt` : undefined}
            subline={
              promptRun && (
                <>
                  {promptRun.workflow_code} {promptBase ? `v${promptBase.prompt_version} → ` : ''}v{promptRun.prompt_version} · rule date {promptRun.rule_date}
                </>
              )
            }
            delta={promptDelta}
            state={promptState}
            stateEmpty="No prompt-triggered run yet."
            to={promptBase && promptRun ? `/runs/compare?a=${promptBase.id}&b=${promptRun.id}` : promptRun ? `/runs/${promptRun.id}` : null}
            actionLabel={promptBase ? 'Compare runs' : 'Open run'}
            loading={runs.isLoading || (Boolean(promptRun) && promptCmp.isLoading)}
            error={runs.error ?? promptCmp.error}
            meta={
              promptRun && (
                <>
                  <div>
                    model {promptRun.model_id} · {promptCmp.data?.unchanged_failing ?? '—'} still failing · {promptCmp.data?.unchanged_passing ?? '—'} still passing
                  </div>
                  {runLine(promptRun)}
                  <RunFacts run={promptRun} className="font-sans" />
                  {blockingLine(promptState)}
                </>
              )
            }
          />
          <TriggerCard
            eyebrow="Model changed"
            icon={<Cpu size={14} />}
            title={modelRun ? (modelBase ? `${shortModelLabel(modelBase.model_label)} → ${shortModelLabel(modelRun.model_label)}` : shortModelLabel(modelRun.model_label)) : 'No model change yet'}
            subtitle={modelRun ? `prompt v${modelRun.prompt_version} unchanged · rule date ${modelRun.rule_date}` : undefined}
            subline={
              modelRun && (
                <>
                  {modelBase ? (
                    <>
                      <ModelId id={modelBase.model_id} /> →{' '}
                    </>
                  ) : null}
                  <ModelId id={modelRun.model_id} />
                </>
              )
            }
            delta={modelDelta}
            state={modelState}
            stateEmpty="No model-triggered run yet."
            to={modelBase && modelRun ? `/runs/compare?a=${modelBase.id}&b=${modelRun.id}` : modelRun ? `/runs/${modelRun.id}` : null}
            actionLabel={modelBase ? 'Compare runs' : 'Open run'}
            loading={runs.isLoading || (Boolean(modelRun) && modelCmp.isLoading)}
            error={runs.error ?? modelCmp.error}
            meta={
              modelRun && (
                <>
                  {modelCmp.data && modelCmp.data.newly_failing.length > 0 && (
                    <>
                      <div>APIs green, prompt unchanged, output wrong</div>
                      <div>newly failing: {topContracts(modelCmp.data.newly_failing)}</div>
                    </>
                  )}
                  {runLine(modelRun)}
                  <RunFacts run={modelRun} className="font-sans" />
                  {blockingLine(modelState)}
                </>
              )
            }
          />
        </div>
        {guideHidden && (
          <div className="mt-3">
            <ThesisStrip />
          </div>
        )}
        <ReadinessCard asOf={today} className="mt-3" />
      </Section>

      <Section band title="Gate status — latest run per configuration" right={<Link to="/runs">All runs →</Link>}>
        <DataTable
          columns={gateColumns}
          data={gateRows}
          isLoading={runs.isLoading}
          error={runs.error}
          retry={() => void runs.refetch()}
          getRowId={(r) => r.id}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          emptyTitle="No runs yet"
          emptyHint="Start one from the Runs page (engineer/admin)."
          emptyAction={
            <Link to="/runs" className="btn btn-outline btn-sm hover:no-underline">
              Go to Runs
            </Link>
          }
          caption="Gate status — latest run per (prompt, model, adapter, judge, rule date, corpus)"
        />
      </Section>

      <Section title={`Open review — actionable${openTasks.data ? ` · ${openGroups} blocking-failure ${openGroups === 1 ? 'group' : 'groups'} · ${openAdvisory} advisory` : ''}`} right={<Link to="/review">Review queue →</Link>}>
        {openTasks.isLoading ? (
          <LoadingState rows={1} />
        ) : openTasks.error && !openTasks.data ? (
          <ErrorState error={openTasks.error} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {['STALE_ASSET', 'PROPOSED_EDGE', 'FLAGGED_RESULT'].map((kind) => (
              <Link
                key={kind}
                to={`/review?kind=${kind}&state=open`}
                className="card flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:border-teal hover:no-underline"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink">{kindLabel(kind)}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-ink-3">{kind}</div>
                </div>
                <div className={cn('stat text-[24px]', (openByKind.get(kind) ?? 0) > 0 ? 'text-ink' : 'text-ink-3')}>{openByKind.get(kind) ?? 0}</div>
              </Link>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
