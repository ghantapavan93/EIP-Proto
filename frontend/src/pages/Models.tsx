import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRight, Cpu, KeyRound, Laptop, ShieldCheck } from 'lucide-react';
import { useModelBoard } from '../api/hooks';
import type { ModelBoardRow, ProviderBoardInfo, RunOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section } from '../components/layout/Page';
import { DataTable } from '../components/ui/DataTable';
import { Chip } from '../components/ui/Chip';
import { GateChip } from '../components/runs/GateChip';
import { AdapterChip } from '../components/runs/AdapterChip';
import { JudgeChip } from '../components/runs/RunFacts';
import { EmptyState } from '../components/ui/EmptyState';
import { fmtDuration, fmtNumber, fmtTs } from '../lib/format';
import { isDevelopmentRun, runStats } from '../lib/runStats';
import { providerStatusLabel, type Tone } from '../lib/vocab';
import { cn } from '../lib/cn';

/**
 * Models — the vendor-swap board.
 *
 * One row per registered model: where it runs (local GPU, hosted free tier,
 * paid, or a declared simulation), what has been recorded for it, and what
 * its latest run for the board's prompt + rule date measured. Two rows can be
 * selected and sent to Runs → Compare, which is the MODEL trigger in one click.
 */

const PROVIDER_ORDER = ['ollama', 'groq', 'gemini', 'openrouter', 'anthropic', 'simulated'];

const PROVIDER_LABEL: Record<string, string> = {
  ollama: 'Ollama · local',
  groq: 'Groq',
  gemini: 'Google AI Studio',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  simulated: 'Simulated',
};

const KEY_URL: Record<string, string> = {
  GROQ_API_KEY: 'console.groq.com',
  GEMINI_API_KEY: 'aistudio.google.com',
  OPENROUTER_API_KEY: 'openrouter.ai',
  ANTHROPIC_API_KEY: 'console.anthropic.com',
};

function tierTone(tier: string): Tone {
  switch (tier) {
    case 'local':
      return 'teal';
    case 'free-tier':
      return 'green';
    case 'paid':
      return 'slate';
    default:
      return 'neutral';
  }
}

function tierLabel(tier: string): string {
  return tier === 'free-tier' ? 'free tier' : tier;
}

function availabilityTone(state: string): Tone {
  switch (state) {
    case 'ready':
      return 'green';
    case 'needs-key':
    case 'not-pulled':
      return 'amber';
    case 'offline':
      return 'red';
    default:
      return 'neutral';
  }
}

function availabilityLabel(state: string): string {
  switch (state) {
    case 'ready':
      return 'ready';
    case 'needs-key':
      return 'needs key';
    case 'not-pulled':
      return 'not pulled';
    case 'offline':
      return 'offline';
    case 'simulated':
      return 'declared';
    default:
      return state;
  }
}

/** Contract cells that did not pass, as "CODE n" chips — the model's defect fingerprint at a glance. */
function DefectFingerprint({ run }: { run: RunOut }) {
  const s = runStats(run);
  const failing = run.contracts
    .map((c) => ({ code: c.code, n: c.failed + c.flagged, errors: c.errored, kind: c.kind }))
    .filter((c) => c.n > 0 || c.errors > 0);
  if (failing.length === 0) {
    return (
      <span className="text-[12px] text-green-ink" title="every contract cell passed">
        all {s.transcripts ?? run.contracts[0]?.passed ?? ''} × {run.contracts.length} cells pass
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {failing.map((c) => (
        <Chip
          key={c.code}
          mono
          tone={c.errors > 0 && c.n === 0 ? 'neutral' : c.kind === 'JUDGED' ? 'amber' : 'red'}
          title={`${c.code}: ${c.n} failed/flagged · ${c.errors} error`}
        >
          {c.code.replace(/^[CJ]-/, '')} {c.errors > 0 && c.n === 0 ? `${c.errors}⚠` : c.n}
        </Chip>
      ))}
    </span>
  );
}

function ProviderCard({ name, info }: { name: string; info: ProviderBoardInfo }) {
  const Icon = name === 'ollama' ? Laptop : name === 'simulated' ? ShieldCheck : KeyRound;
  const ready = info.available;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 border border-hairline bg-white p-3', ready && name !== 'simulated' && 'border-t-2 border-t-teal')}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-navy">
          <Icon size={14} aria-hidden />
          {PROVIDER_LABEL[name] ?? name}
        </span>
        <Chip tone={ready ? 'green' : 'amber'} wrap className="text-right">
          {providerStatusLabel(name, ready)}
        </Chip>
      </div>
      <p className="text-[12px] leading-snug text-ink-2">{info.notes}</p>
      {name === 'ollama' && info.local_models && (
        <p className="font-mono text-[11px] text-ink-2">
          {info.local_models.length > 0 ? `pulled: ${info.local_models.join(', ')}` : 'no models pulled'}
        </p>
      )}
      {!ready && info.key_env && (
        <p className="font-mono text-[11px] text-ink-2">
          {info.key_env} ← {KEY_URL[info.key_env] ?? 'provider console'}
        </p>
      )}
      {ready && info.rpm !== undefined && info.rpm > 0 && (
        <p className="font-mono text-[11px] text-ink-2">
          paced to {info.rpm} RPM{info.rpd ? ` · ${info.rpd} RPD` : ''}
        </p>
      )}
    </div>
  );
}

export function ModelsPage() {
  useTopBar([{ label: 'Models' }]);
  const board = useModelBoard(2, '2026-10-01');
  const navigate = useNavigate();
  const [picked, setPicked] = useState<string[]>([]);

  // The board compares models on the development calls only. The server already filters;
  // this guard keeps an older server's held-out or ingested run off the board too.
  const rows = useMemo(
    () =>
      board.data?.rows.map((r) =>
        r.latest_run && !isDevelopmentRun(r.latest_run) ? { ...r, latest_run: null, matched: false, measured: false } : r,
      ),
    [board.data],
  );
  const measured = rows?.filter((r) => r.measured && r.matched).length ?? 0;
  const readyLocal = rows?.filter((r) => r.tier === 'local' && r.availability === 'ready').length ?? 0;
  const keyless = rows?.filter((r) => r.availability === 'needs-key').length ?? 0;

  const toggle = (row: ModelBoardRow) => {
    const id = row.latest_run?.id;
    if (!id) return;
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur.slice(-1), id]));
  };

  const columns = useMemo<ColumnDef<ModelBoardRow, unknown>[]>(
    () => [
      {
        id: 'pick',
        header: 'A/B',
        size: 44,
        cell: (c) => {
          const run = c.row.original.latest_run;
          const idx = run ? picked.indexOf(run.id) : -1;
          return (
            <input
              type="checkbox"
              aria-label={`select ${c.row.original.model.model_id} for compare`}
              disabled={!run}
              checked={idx >= 0}
              onChange={() => toggle(c.row.original)}
              onClick={(e) => e.stopPropagation()}
              className="accent-teal-ink"
              title={run ? (idx >= 0 ? (idx === 0 ? 'A' : 'B') : 'select as A or B') : 'no run to compare'}
            />
          );
        },
      },
      {
        header: 'Model',
        accessorFn: (r) => r.model.model_id,
        meta: { wrap: true },
        cell: (c) => (
          <span className="block max-w-[320px] leading-snug">
            <span className="font-semibold text-navy">{c.row.original.model.label}</span>
            <span className="mt-0.5 block font-mono text-[11px] text-ink-2 [overflow-wrap:anywhere]">{c.row.original.model.model_id}</span>
          </span>
        ),
      },
      {
        header: 'Tier',
        accessorKey: 'tier',
        size: 92,
        cell: (c) => <Chip tone={tierTone(c.row.original.tier)}>{tierLabel(c.row.original.tier)}</Chip>,
      },
      {
        header: 'Availability',
        accessorKey: 'availability',
        meta: { wrap: true },
        cell: (c) => (
          <span className="block max-w-[260px] leading-snug">
            <Chip tone={availabilityTone(c.row.original.availability)}>{availabilityLabel(c.row.original.availability)}</Chip>
            <span className="mt-0.5 block text-[11px] text-ink-2 [overflow-wrap:anywhere]">{c.row.original.availability_detail}</span>
          </span>
        ),
      },
      {
        id: 'evidence',
        header: 'Evidence',
        accessorFn: (r) => (r.latest_run ? (r.measured ? 2 : 1) : 0),
        size: 100,
        cell: (c) => {
          const r = c.row.original;
          if (!r.latest_run) return <span className="text-ink-3">—</span>;
          return (
            <span className="inline-flex flex-col gap-0.5">
              <Chip tone={r.measured ? 'teal' : 'neutral'} title={r.measured ? 'output came from the real model' : 'declared defect profile'}>
                {r.measured ? 'measured' : 'declared'}
              </Chip>
              {!r.matched && <span className="text-[10px] text-amber-ink">other prompt/date</span>}
            </span>
          );
        },
      },
      {
        id: 'gate',
        header: 'Latest run',
        accessorFn: (r) => r.latest_run?.gate ?? '',
        size: 170,
        cell: (c) => {
          const run = c.row.original.latest_run;
          if (!run) return <span className="text-[12px] text-ink-3">not run yet</span>;
          return (
            <span className="inline-flex flex-wrap items-center gap-1">
              <GateChip gate={run.gate} />
              <AdapterChip adapter={run.adapter} />
              <Link to={`/runs/${run.id}`} className="font-mono text-[11px]" onClick={(e) => e.stopPropagation()} title={fmtTs(run.started_at)}>
                open
              </Link>
            </span>
          );
        },
      },
      {
        id: 'defects',
        header: 'Defect fingerprint',
        meta: { wrap: true },
        accessorFn: (r) => (r.latest_run ? r.latest_run.contracts.reduce((n, x) => n + x.failed + x.flagged, 0) : -1),
        cell: (c) => (c.row.original.latest_run ? <DefectFingerprint run={c.row.original.latest_run} /> : <span className="text-ink-3">—</span>),
      },
      {
        id: 'tokens',
        header: 'Tokens in / out',
        // may break after the "/" so the pair stacks in a narrow column
        meta: { align: 'right', mono: true, wrap: true },
        size: 130,
        accessorFn: (r) => runStats(r.latest_run).cost?.input_tokens ?? -1,
        cell: (c) => {
          const cost = runStats(c.row.original.latest_run).cost;
          if (!cost || cost.input_tokens === undefined) return <span className="text-ink-3">—</span>;
          return (
            <span title={cost.basis}>
              {fmtNumber(cost.input_tokens)} / {fmtNumber(cost.output_tokens ?? null)}
            </span>
          );
        },
      },
      {
        id: 'latency',
        header: 'Per transcript',
        meta: { align: 'right', mono: true },
        size: 110,
        accessorFn: (r) => runStats(r.latest_run).latency_ms_per_transcript ?? -1,
        cell: (c) => {
          const ms = runStats(c.row.original.latest_run).latency_ms_per_transcript;
          return ms === undefined ? <span className="text-ink-3">—</span> : fmtDuration(ms);
        },
      },
      {
        id: 'cost',
        header: 'Cost',
        meta: { wrap: true },
        size: 150,
        accessorFn: (r) => runStats(r.latest_run).cost?.usd ?? -1,
        cell: (c) => {
          const cost = runStats(c.row.original.latest_run).cost;
          if (!cost) return <span className="text-ink-3">—</span>;
          return (
            <span className="block max-w-[150px] leading-snug">
              <span className="font-mono">${cost.usd.toFixed(2)}</span>
              <span className="line-clamp-2 block text-[11px] text-ink-2" title={cost.basis}>
                {cost.basis.split(';')[0]}
              </span>
            </span>
          );
        },
      },
      {
        id: 'judge',
        header: 'Judge',
        size: 110,
        accessorFn: (r) => (runStats(r.latest_run).judge_stability?.stable ? 1 : 0),
        cell: (c) => (c.row.original.latest_run ? <JudgeChip run={c.row.original.latest_run} compact /> : <span className="text-ink-3">—</span>),
      },
      {
        id: 'cassettes',
        header: 'Cassettes',
        meta: { mono: true },
        size: 120,
        accessorFn: (r) => r.cassettes.reduce((n, s) => n + s.generate, 0),
        cell: (c) => {
          const sets = c.row.original.cassettes;
          if (sets.length === 0) return <span className="text-ink-3">—</span>;
          return (
            <span className="inline-flex flex-col gap-0.5 text-[11px]">
              {sets.map((s) => (
                <span key={s.prompt_hash} title={`prompt hash ${s.prompt_hash} · ${s.generate} outputs · ${s.judge} judge sets · ${s.canary} canary`}>
                  v{s.prompt_version ?? '?'} · {s.generate}/{s.judge}/{s.canary}
                </span>
              ))}
            </span>
          );
        },
      },
    ],
    [picked],
  );

  const providers = board.data?.providers ?? {};
  const providerNames = PROVIDER_ORDER.filter((n) => n in providers).concat(Object.keys(providers).filter((n) => !PROVIDER_ORDER.includes(n)));

  return (
    <div>
      <PageHeader
        eyebrow="Model registry · vendor swap"
        title="Models"
        description={
          <>
            One adapter speaks to every vendor; swapping the model is a run parameter, and the contracts do not move. Local models cost $0 and keep
            transcripts on the machine; hosted free tiers need a key; simulated profiles are <em>declared</em>, never measured.
            {rows && (
              <>
                {' '}
                <span className="font-mono text-[12px]">
                  {measured} measured · {readyLocal} local ready · {keyless} awaiting a key
                </span>
              </>
            )}
          </>
        }
        actions={
          <button
            type="button"
            className="btn inline-flex items-center gap-1.5"
            disabled={picked.length !== 2}
            onClick={() => navigate(`/runs/compare?a=${encodeURIComponent(picked[0])}&b=${encodeURIComponent(picked[1])}`)}
            title={picked.length === 2 ? 'Compare the two selected runs' : 'Select two rows with runs to compare'}
          >
            Compare A → B <ArrowRight size={14} aria-hidden />
          </button>
        }
      />

      <Section title="Providers" right="readiness is probed live: Ollama by /api/tags, hosted tiers by key">
        {board.isLoading && !board.data ? (
          <div className="text-[12px] text-ink-2">Probing providers…</div>
        ) : providerNames.length === 0 ? (
          <EmptyState title="No providers reported" className="py-4" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {providerNames.map((name) => (
              <ProviderCard key={name} name={name} info={providers[name]} />
            ))}
          </div>
        )}
      </Section>

      <Section
        title={`Scoreboard — prompt v${board.data?.prompt_version ?? 2} · rules as of ${board.data?.rule_date ?? '2026-10-01'} · 60 synthetic development calls (T001–T060) × 8 contracts`}
        right={
          <span className="inline-flex items-center gap-1">
            <Cpu size={12} aria-hidden /> tick two rows, then Compare
          </span>
        }
        band
      >
        <DataTable
          columns={columns}
          data={rows}
          isLoading={board.isLoading}
          error={board.error}
          retry={() => void board.refetch()}
          getRowId={(r) => r.model.model_id}
          onRowClick={toggle}
          selectedIds={new Set(rows?.filter((r) => r.latest_run && picked.includes(r.latest_run.id)).map((r) => r.model.model_id))}
          initialSort={[{ id: 'evidence', desc: true }]}
          emptyTitle="No models registered"
          caption="Model board"
          compact
        />
        <p className="mt-3 max-w-4xl text-[12px] leading-relaxed text-ink-2">
          <strong className="text-ink">How to read it.</strong> <em>Measured</em> rows replay a recorded cassette or ran live: token counts come from the
          provider, latency is wall-clock, and every contract cell is the real model's answer. <em>Declared</em> rows are the deterministic stand-ins used
          to script the rule-flip and prompt-change acts; their defects are configured, not observed. A model with no key still has a row so the swap is
          one environment variable away — <code className="font-mono">backstop record --model groq/llama-3.3-70b-versatile --limit 20</code> records it into
          cassettes the demo can replay offline.
        </p>
      </Section>
    </div>
  );
}
