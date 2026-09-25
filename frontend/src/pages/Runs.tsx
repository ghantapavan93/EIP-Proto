import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { GitCompareArrows, Play } from 'lucide-react';
import { canEdit, useContracts, useCreateRun, useMeta, useModels, useRole, useRuns, useWorkflows } from '../api/hooks';
import type { ContractSummary, RunOut, RunRequest } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section, Field } from '../components/layout/Page';
import { GatedButton } from '../components/access/GatedButton';
import { DataTable } from '../components/ui/DataTable';
import { GateChip } from '../components/runs/GateChip';
import { AdapterChip } from '../components/runs/AdapterChip';
import { ModelId } from '../components/runs/ModelId';
import { Chip } from '../components/ui/Chip';
import { Drawer } from '../components/ui/Drawer';
import { ErrorState } from '../components/ui/ErrorState';
import { useToast } from '../components/ui/useToast';
import { durationBetween, fmtDuration, fmtTs, shortHash, todayIso } from '../lib/format';
import { ADAPTERS, adaptersForModel, defaultAdapterForModel, RUN_CORPORA, RUN_CORPUS_LABELS, TRIGGERS, triggerTone, type Adapter } from '../lib/vocab';
import { JudgeChip } from '../components/runs/RunFacts';
import { costLabel, holdoutPair, runStats } from '../lib/runStats';
import { CorpusChip, HOLDOUT_TOOLTIP } from '../components/runs/CorpusChip';
import { cn } from '../lib/cn';

/** "57/3" style cell: passed / (failed+flagged+errored), colored by the worst outcome present. */
export function ContractCell({ summary }: { summary: ContractSummary | undefined }) {
  if (!summary) return <span className="text-ink-3">—</span>;
  const bad = summary.failed + summary.flagged + summary.errored;
  const worst = summary.failed + summary.errored > 0 ? (summary.severity === 'BLOCK' ? 'text-red' : 'text-amber-ink') : summary.flagged > 0 ? 'text-amber-ink' : 'text-green-ink';
  return (
    <span
      className={cn('font-mono text-[12px] tabular-nums', bad > 0 ? `${worst} font-semibold` : 'text-ink-2')}
      title={`${summary.code}: ${summary.passed} pass · ${summary.failed} fail · ${summary.flagged} flag · ${summary.errored} error`}
    >
      {summary.passed}/{bad}
    </span>
  );
}

/** "SCHEMA-01" with a break opportunity after each hyphen (browsers won't break "-0" on their own). */
function ContractCode({ code }: { code: string }) {
  const parts = code.split('-');
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              -<wbr />
            </>
          )}
        </span>
      ))}
    </>
  );
}

function NewRunDrawer({ open, onClose: close }: { open: boolean; onClose: () => void }) {
  const meta = useMeta();
  const workflows = useWorkflows();
  const models = useModels();
  const create = useCreateRun();
  // A refusal from the last attempt must not greet the user when the drawer reopens.
  const onClose = () => {
    if (!create.isPending) create.reset();
    close();
  };
  const navigate = useNavigate();
  const { toast } = useToast();
  const [form, setForm] = useState<RunRequest>({
    workflow: 'qa-handoff',
    prompt_version: 2,
    model_id: 'sim-large',
    adapter: 'simulated',
    rule_date: '2026-10-01',
    trigger: 'MANUAL',
    corpus: 'synthetic',
  });

  const workflow = workflows.data?.find((w) => w.code === form.workflow) ?? workflows.data?.[0];
  const adapters = meta.data?.adapters ?? { simulated: true };
  const selectedModel = models.data?.find((m) => m.model_id === form.model_id);
  const allowedAdapters = adaptersForModel(selectedModel);
  // If the model list arrives after the form was initialised, keep the adapter consistent with it.
  const adapter = form.adapter && allowedAdapters.includes(form.adapter as Adapter) ? form.adapter : defaultAdapterForModel(selectedModel);
  const isDevCorpus = (form.corpus ?? 'synthetic') === 'synthetic';

  const chooseModel = (modelId: string) => {
    const model = models.data?.find((m) => m.model_id === modelId);
    setForm({ ...form, model_id: modelId, adapter: defaultAdapterForModel(model) });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    create.mutate(
      { ...form, adapter, workflow: workflow?.code ?? form.workflow },
      {
        onSuccess: (run) => {
          if (run.deduplicated) {
            toast({ title: 'Identical inputs — returning the existing run', detail: `${run.id} · run key ${shortHash(run.run_key, 40)}`, tone: 'teal' });
          } else {
            toast({ title: `Run ${run.id} ${run.status.toLowerCase()} · gate ${run.gate}`, tone: run.gate === 'RED' ? 'red' : run.gate === 'AMBER' ? 'amber' : 'green' });
          }
          onClose();
          navigate(`/runs/${run.id}`);
        },
      },
    );
  };

  return (
    <Drawer open={open} onClose={onClose} title="New run" subtitle="Same inputs → same run. The run key covers workflow, prompt hash, model, adapter, corpus hash, contract set hash and rule date.">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Workflow" htmlFor="nr-workflow">
          <select id="nr-workflow" className="input" value={workflow?.code ?? ''} onChange={(e) => setForm({ ...form, workflow: e.target.value })}>
            {(workflows.data ?? []).map((w) => (
              <option key={w.code} value={w.code}>
                {w.code} — {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Prompt version" htmlFor="nr-prompt">
          <select id="nr-prompt" className="input" value={form.prompt_version} onChange={(e) => setForm({ ...form, prompt_version: Number(e.target.value) })}>
            {(workflow?.prompt_versions ?? []).map((p) => (
              <option key={p.id} value={p.version}>
                v{p.version} — {p.label} · {shortHash(p.prompt_hash, 10)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model" htmlFor="nr-model">
          <select id="nr-model" className="input" value={form.model_id} onChange={(e) => chooseModel(e.target.value)}>
            {(models.data ?? []).map((m) => (
              <option key={m.id} value={m.model_id}>
                {m.model_id} — {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Adapter" htmlFor="nr-adapter" hint="Follows the model: simulated models run simulated; real models replay their cassette by default, or go live on the model's provider (local Ollama, or a free-tier key). Options are disabled when they don't fit the model or /meta reports no configured provider.">
          <select id="nr-adapter" className="input" value={adapter} onChange={(e) => setForm({ ...form, adapter: e.target.value })}>
            {ADAPTERS.map((a) => {
              const fits = allowedAdapters.includes(a);
              return (
                <option key={a} value={a} disabled={!fits || adapters[a] === false}>
                  {a}
                  {!fits ? ' — not for this model' : adapters[a] === false ? ' — no provider configured' : ''}
                </option>
              );
            })}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Rule date" htmlFor="nr-date">
            <input id="nr-date" type="date" className="input font-mono" value={form.rule_date} onChange={(e) => setForm({ ...form, rule_date: e.target.value })} required />
          </Field>
          <Field label="Trigger" htmlFor="nr-trigger">
            <select id="nr-trigger" className="input" value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })}>
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field
          label="Corpus"
          htmlFor="nr-corpus"
          hint="Ingested transcripts have no ground truth; rule contracts report ERROR for them. The 60 held-out calls are replayed from the CLI only."
        >
          <select id="nr-corpus" className="input" value={form.corpus ?? 'synthetic'} onChange={(e) => setForm({ ...form, corpus: e.target.value as RunRequest['corpus'] })}>
            {RUN_CORPORA.map((c) => (
              <option key={c} value={c}>
                {RUN_CORPUS_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field
            label="Transcripts"
            htmlFor="nr-limit"
            hint={
              isDevCorpus
                ? 'blank = all 60 development calls; 3 makes a live run a 30-second moment'
                : 'blank = every ingested transcript; 3 makes a live run a 30-second moment'
            }
          >
            <input
              id="nr-limit"
              type="number"
              min={1}
              max={isDevCorpus ? 60 : undefined}
              className="input font-mono"
              value={form.limit ?? ''}
              placeholder={isDevCorpus ? '60' : 'all'}
              onChange={(e) => setForm({ ...form, limit: e.target.value ? Number(e.target.value) : null })}
            />
          </Field>
          <Field label="Judge model" htmlFor="nr-judge-model" hint="default: the run's model. Use a cheaper free-tier model to spare quota.">
            <select
              id="nr-judge-model"
              className="input"
              value={form.judge_model_id ?? ''}
              onChange={(e) => setForm({ ...form, judge_model_id: e.target.value || null })}
            >
              <option value="">same as run</option>
              {(models.data ?? [])
                .filter((m) => m.provider !== 'simulated')
                .map((m) => (
                  <option key={m.id} value={m.model_id}>
                    {m.model_id}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Judge N" htmlFor="nr-judge-n" hint="scores per note (contract default 5); lower on free tiers">
            <input
              id="nr-judge-n"
              type="number"
              min={1}
              max={9}
              className="input font-mono"
              value={form.judge_n ?? ''}
              placeholder="5"
              onChange={(e) => setForm({ ...form, judge_n: e.target.value ? Number(e.target.value) : null })}
            />
          </Field>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-ghost btn-sm font-mono normal-case" onClick={() => setForm({ ...form, rule_date: '2026-09-30' })}>
            2026-09-30
          </button>
          <button type="button" className="btn btn-ghost btn-sm font-mono normal-case" onClick={() => setForm({ ...form, rule_date: '2026-10-01' })}>
            2026-10-01
          </button>
          <button type="button" className="btn btn-ghost btn-sm font-mono normal-case" onClick={() => setForm({ ...form, rule_date: todayIso() })}>
            today
          </button>
        </div>
        {create.error ? <ErrorState error={create.error} title="Run refused" /> : null}
        {create.isPending && adapter === 'live' ? (
          <p role="status" className="text-[12px] text-ink-2">
            Live run in progress — each transcript is a real model call, so this can take a few minutes. Keep this drawer open; the run opens when it finishes.
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={create.isPending}>
            <Play size={13} aria-hidden /> {create.isPending ? 'Running…' : 'Start run'}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

export function RunsPage() {
  useTopBar([{ label: 'Runs' }]);
  const navigate = useNavigate();
  const role = useRole();
  const runs = useRuns();
  const contracts = useContracts();
  const [selected, setSelected] = useState<string[]>([]);
  // ?new=1 opens the New run drawer (command palette, deep links); closing clears it.
  const [params, setParams] = useSearchParams();
  const drawer = params.get('new') === '1' && canEdit(role);
  const setDrawer = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set('new', '1');
    else next.delete('new');
    setParams(next, { replace: true });
  };

  const contractCodes = useMemo(() => {
    const fromRegistry = contracts.data?.map((c) => c.code) ?? [];
    if (fromRegistry.length) return fromRegistry;
    const set = new Set<string>();
    for (const r of runs.data ?? []) for (const c of r.contracts) set.add(c.code);
    return [...set];
  }, [contracts.data, runs.data]);

  const holdout = useMemo(() => holdoutPair(runs.data), [runs.data]);
  const holdoutCompareHref = holdout
    ? `/runs/compare?a=${encodeURIComponent(holdout.before.id)}&b=${encodeURIComponent(holdout.after.id)}`
    : '';

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  };

  const columns = useMemo<ColumnDef<RunOut, unknown>[]>(
    () => [
      {
        id: 'select',
        header: () => <span className="sr-only">Select</span>,
        enableSorting: false,
        size: 32,
        cell: (c) => (
          <input
            type="checkbox"
            aria-label={`Select ${c.row.original.id} for comparison`}
            checked={selected.includes(c.row.original.id)}
            onChange={() => toggle(c.row.original.id)}
            onClick={(e) => e.stopPropagation()}
          />
        ),
      },
      {
        header: 'Run',
        accessorKey: 'started_at',
        cell: (c) => (
          <span
            className="font-mono text-[11px] font-semibold text-navy"
            title={`${c.row.original.id} · started ${fmtTs(c.row.original.started_at)} · ${fmtDuration(durationBetween(c.row.original.started_at, c.row.original.finished_at))} · by ${c.row.original.requested_by}`}
          >
            {c.row.original.id.slice(0, 8)}
          </span>
        ),
        size: 66,
      },
      { header: 'Gate', accessorKey: 'gate', cell: (c) => <GateChip gate={c.row.original.gate} />, size: 78 },
      {
        header: 'Prompt',
        accessorKey: 'prompt_version',
        cell: (c) => (
          <span className="font-mono text-[12px]" title={`${c.row.original.workflow_code} · ${c.row.original.prompt_label} · ${c.row.original.prompt_hash}`}>
            v{c.row.original.prompt_version}
          </span>
        ),
        size: 66,
      },
      {
        header: 'Model · adapter',
        accessorKey: 'model_id',
        // Stacked: model id (wrapping after its provider prefix) over the adapter chip.
        meta: { wrap: true },
        cell: (c) => (
          <span className="flex flex-col items-start gap-0.5 py-1" title={`${c.row.original.model_id} · ${c.row.original.model_label} · adapter ${c.row.original.adapter}`}>
            <span className="font-mono text-[11px] leading-tight [overflow-wrap:anywhere]">
              <ModelId id={c.row.original.model_id} />
            </span>
            <AdapterChip adapter={c.row.original.adapter} compact />
            <CorpusChip run={c.row.original} size="xs" />
          </span>
        ),
        size: 114,
      },
      { header: 'Rule date', accessorKey: 'rule_date', cell: (c) => <span className="font-mono text-[11px]">{c.row.original.rule_date}</span>, size: 78 },
      { header: 'Trigger', accessorKey: 'trigger', cell: (c) => <Chip tone={triggerTone(c.row.original.trigger)}>{c.row.original.trigger}</Chip>, size: 88 },
      ...contractCodes.map<ColumnDef<RunOut, unknown>>((code) => ({
        id: `c_${code}`,
        header: () => (
          // "C-SCHEMA-01" → "SCHEMA-" / "01" on two lines; the full code is in the tooltip.
          <span className="block whitespace-normal font-mono text-[9px] normal-case leading-tight tracking-normal" title={code}>
            <ContractCode code={code.replace(/^[CJ]-/, '')} />
          </span>
        ),
        accessorFn: (r) => {
          const s = r.contracts.find((x) => x.code === code);
          return s ? s.failed + s.flagged + s.errored : -1;
        },
        meta: { align: 'right' },
        cell: (c) => <ContractCell summary={c.row.original.contracts.find((x) => x.code === code)} />,
        size: 47,
      })),
      {
        id: 'facts',
        header: 'Cost · judge',
        meta: { wrap: true },
        accessorFn: (r) => runStats(r).cost?.usd ?? 0,
        cell: (c) => {
          const s = runStats(c.row.original);
          return (
            <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5 py-1" title={`${costLabel(s.cost)} · ${s.cost?.basis ?? ''} · ${fmtDuration(s.latency_ms_per_transcript ?? null)} per transcript`}>
              <span className="font-mono text-[11px]">{costLabel(s.cost).split(' · ')[0]}</span>
              <JudgeChip run={c.row.original} compact />
            </span>
          );
        },
        size: 86,
      },
    ],
    [contractCodes, selected],
  );

  return (
    <div>
      <PageHeader
        eyebrow="Replay harness"
        title="Runs"
        description="One row per run, one column per contract — runs replay the 60 development calls unless marked HELD-OUT or INGESTED; select two to compare."
        actions={
          <>
            <button type="button" className="btn btn-outline" disabled={selected.length !== 2} onClick={() => navigate(`/runs/compare?a=${selected[0]}&b=${selected[1]}`)}>
              <GitCompareArrows size={13} aria-hidden /> Compare{selected.length ? ` (${selected.length}/2)` : ''}
            </button>
            <GatedButton action="start_runs" className="btn" onClick={() => setDrawer(true)}>
              <Play size={13} aria-hidden /> New run
            </GatedButton>
          </>
        }
      />
      <Section>
        {holdout && (
          <p className="mb-3 rounded-[8px] border border-hairline bg-surface px-4 py-2.5 text-[13px] text-ink" role="note" title={HOLDOUT_TOOLTIP}>
            <strong className="font-semibold text-ink">Held-out check:</strong> prompt v{holdout.after.prompt_version} vs v
            {holdout.before.prompt_version} on 60 unseen calls →{' '}
            <Link to={holdoutCompareHref} className="font-semibold">
              Compare
            </Link>
          </p>
        )}
        <DataTable
          columns={columns}
          data={runs.data}
          isLoading={runs.isLoading}
          error={runs.error}
          retry={() => void runs.refetch()}
          getRowId={(r) => r.id}
          selectedIds={new Set(selected)}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          initialSort={[{ id: 'started_at', desc: true }]}
          emptyTitle="No runs"
          emptyHint="Engineers and admins start runs; each replays the 60 development calls against every contract."
          caption="Runs matrix"
          fixedLayout
          className="lg:overflow-x-hidden"
        />
        <div className="mt-2 text-[11px] text-ink-3">
          Cells read passed/failing per contract. Red = BLOCK-severity failures or errors; amber = FLAG-severity flags. Hover a run id for its start time, duration and requester. Pick two rows and press Compare.
        </div>
      </Section>
      <NewRunDrawer open={drawer} onClose={() => setDrawer(false)} />
    </div>
  );
}
