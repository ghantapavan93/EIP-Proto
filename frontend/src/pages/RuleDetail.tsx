import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ExternalLink, Landmark, Plus } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { useAsset, useContracts, useImpact, useMeta, useRule, useRuns } from '../api/hooks';
import type { ContractOut, ImpactPromptVersion, RuleVersionOut, StaleItemOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section } from '../components/layout/Page';
import { Chip } from '../components/ui/Chip';
import { DirectionChip } from '../components/rules/DirectionChip';
import { SourceBadge } from '../components/artifacts/SourceBadge';
import { EvidenceQuote } from '../components/evidence/EvidenceQuote';
import { Timeline, VersionTrack } from '../components/rules/Timeline';
import { FanDiagram, type FanNode } from '../components/charts/FanDiagram';
import { DateAsOfControl } from '../components/rules/DateAsOfControl';
import { OpenStaleTasksButton } from '../components/rules/OpenStaleTasksButton';
import { ProposeVersionDrawer } from '../components/rules/ProposeVersionDrawer';
import { SourceWatch } from '../components/rules/SourceWatch';
import { WhatIfImpact } from '../components/rules/WhatIfImpact';
import { DataTable } from '../components/ui/DataTable';
import { Drawer } from '../components/ui/Drawer';
import { GatedButton } from '../components/access/GatedButton';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { EvidenceExport } from '../components/evidence/EvidenceExport';
import { GateChip } from '../components/runs/GateChip';
import { TickNumber } from '../components/ui/TickNumber';
import { CAUSALITY_STEPS, useCausalitySequence } from '../lib/motion';
import { fmtDate, shortHash, todayIso } from '../lib/format';
import {
  artifactTypeLabel,
  directionLabel,
  polarityTone,
  roleLabel,
  severityTone,
  stateLabel,
  stateTone,
} from '../lib/vocab';
import { aroundChange, governingVersions, nextChangeWithin, nextContractYearStart } from '../lib/ruleVersions';
import { RuleStatusNotes } from '../components/rules/RuleVersionBadges';
import { cn } from '../lib/cn';

/** One stale-artifact row; pulls the artifact text lazily so the evidence span shows its sentence. */
function StaleRow({ item, ruleCode, seq }: { item: StaleItemOut; ruleCode: string; seq: number }) {
  const asset = useAsset(item.edge.asset_code);
  const e = item.edge;
  return (
    <li className={cn('border-b border-hairline px-3 py-3 last:border-b-0', seq > 0 && 'cz-row')} data-seq={seq}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone="neutral">{artifactTypeLabel(e.asset_type)}</Chip>
        <SourceBadge isSynthetic={e.asset_is_synthetic} type={e.asset_type} url={e.asset_url} />
        <Link to={`/artifacts/${encodeURIComponent(e.asset_code)}`} className="text-[13px] font-semibold text-navy">
          {e.asset_name}
        </Link>
        <span className="text-xs text-ink-2" title={e.owner_role}>
          · {roleLabel(e.owner_role)}
        </span>
        <Chip tone={polarityTone(e.polarity)} className="ml-auto">
          {e.polarity}
        </Chip>
        {item.disputed && (
          <Chip tone="amber">
            <AlertTriangle size={11} aria-hidden /> open question
          </Chip>
        )}
      </div>
      <EvidenceQuote
        span={e.evidence_span}
        context={asset.data?.content_text ?? null}
        offset={e.span_offset}
        className="mt-2"
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
        <span className="font-mono">
          bound{' '}
          <span className="font-semibold text-slate">
            {ruleCode}@v{item.bound_version}
          </span>{' '}
          → in force <span className="font-semibold text-slate">v{item.in_force_version}</span>
        </span>
        <span className="text-ink-3">·</span>
        <span>{item.reason}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        <span className="text-ink-2">Review task:</span>
        {item.task_id ? (
          <>
            <Chip tone={stateTone(item.task_state)}>{item.task_state ? stateLabel(item.task_state) : 'open'}</Chip>
            <Link to={`/review?task=${encodeURIComponent(item.task_id)}`}>Open task →</Link>
          </>
        ) : (
          <Chip tone="neutral">none yet</Chip>
        )}
        <span className="ml-auto font-mono text-[11px] text-ink-3">
          {e.detection}
          {e.confidence !== null ? ` · ${e.confidence.toFixed(2)}` : ''} · {e.matcher}
        </span>
      </div>
    </li>
  );
}

function StaleGroup({
  title,
  direction,
  items,
  ruleCode,
  hint,
  seq,
}: {
  title: string;
  direction: 'over_restrictive' | 'under_restrictive' | 'reverify';
  items: StaleItemOut[];
  ruleCode: string;
  hint: string;
  seq: number;
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2 border-b border-hairline bg-band px-3 py-2">
        <div className="flex items-center gap-2">
          <DirectionChip direction={direction} />
          <span className="text-[13px] font-semibold text-slate">{title}</span>
        </div>
        <span className="font-mono text-[12px] text-ink-2">{items.length}</span>
      </div>
      {items.length ? (
        <ul>
          {items.map((it) => (
            <StaleRow key={`${it.edge.id}-${seq}`} item={it} ruleCode={ruleCode} seq={seq} />
          ))}
        </ul>
      ) : (
        <EmptyState title={`No ${directionLabel(direction).toLowerCase()} artifacts`} hint={hint} className="py-5" />
      )}
    </div>
  );
}

/**
 * A prompt that declares a different version from the one in force is either behind
 * (declares a superseded version) or ahead (declares one that has not taken effect yet).
 */
function DeclaredChip({
  stale,
  declared,
  inForce,
}: {
  stale: boolean;
  declared: number | null;
  inForce: number | null;
}) {
  if (!stale) return <Chip tone="green">current</Chip>;
  if (declared !== null && inForce !== null && declared > inForce) {
    return (
      <Chip tone="teal" title={`Declares v${declared}; v${inForce} is in force on this date`}>
        ahead · not yet in force
      </Chip>
    );
  }
  return <Chip tone="amber">declares superseded version</Chip>;
}

export function RuleDetailPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const meta = useMeta();
  const rule = useRule(code);
  const contracts = useContracts();
  const [params, setParams] = useSearchParams();
  const today = meta.data?.today || todayIso();
  // With no date in the URL, open on the rule's next change when it is under 30 days away:
  // evaluated at today, a rule about to change shows no stale artifacts yet.
  const upcoming = nextChangeWithin(rule.data?.versions, today, 30);
  const asOf = params.get('as_of') || upcoming || today;
  const openedOnUpcoming = !params.get('as_of') && upcoming !== null;
  const setAsOf = (value: string) => {
    const next = new URLSearchParams(params);
    next.set('as_of', value);
    setParams(next, { replace: true });
  };
  const [proposeOpen, setProposeOpen] = useState(false);
  const [whatIfVersion, setWhatIfVersion] = useState<RuleVersionOut | null>(null);
  const impact = useImpact(code, asOf);
  const runs = useRuns();
  // Replay the causality sequence on the first radius and whenever the in-force version flips.
  const settled = impact.data && !impact.isPlaceholderData ? impact.data : null;
  const seq = useCausalitySequence(settled ? { inForce: settled.in_force_version, asOf: settled.as_of } : null);
  // Gate of the latest completed run evaluated at exactly this rule date, if there is one.
  const gateRun = useMemo(
    () =>
      (runs.data ?? [])
        .filter((x) => x.rule_date === asOf && x.status === 'COMPLETE')
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0],
    [runs.data, asOf],
  );

  useTopBar([{ label: 'Rules', to: '/rules' }, { label: code }], asOf);

  const quick = useMemo(() => {
    const flips = (rule.data ? governingVersions(rule.data) : [])
      .filter((v) => v.change_classification !== 'INITIAL')
      .map((v) => v.effective_from)
      .sort();
    return aroundChange(flips[flips.length - 1] ?? null);
  }, [rule.data]);

  const groups = useMemo(() => {
    const stale = impact.data?.stale ?? [];
    return {
      over: stale.filter((s) => s.direction === 'over_restrictive'),
      under: stale.filter((s) => s.direction === 'under_restrictive'),
      reverify: stale.filter((s) => s.direction === 'reverify'),
    };
  }, [impact.data]);

  // One fan node per ARTIFACT (an artifact with two encodings is one node with "2 encodings").
  const fanNodes = useMemo<FanNode[]>(() => {
    const stale = impact.data?.stale ?? [];
    const healthy = impact.data?.current_edges ?? [];
    const rank: Record<string, number> = { under_restrictive: 0, over_restrictive: 1, reverify: 2, healthy: 3 };
    const byAsset = new Map<string, FanNode & { encodings: number }>();
    for (const it of stale) {
      const dir = (it.direction as FanNode['direction']) ?? 'reverify';
      const prev = byAsset.get(it.edge.asset_code);
      if (prev) {
        prev.encodings += 1;
        if ((rank[dir] ?? 9) < (rank[prev.direction] ?? 9)) prev.direction = dir;
      } else {
        byAsset.set(it.edge.asset_code, {
          id: it.edge.asset_code,
          label: it.edge.asset_name,
          typeLabel: artifactTypeLabel(it.edge.asset_type),
          direction: dir,
          synthetic: it.edge.asset_is_synthetic,
          href: `/artifacts/${encodeURIComponent(it.edge.asset_code)}`,
          encodings: 1,
        });
      }
    }
    for (const e of healthy) {
      const prev = byAsset.get(e.asset_code);
      if (prev) prev.encodings += 1;
      else
        byAsset.set(e.asset_code, {
          id: e.asset_code,
          label: e.asset_name,
          typeLabel: artifactTypeLabel(e.asset_type),
          direction: 'healthy',
          synthetic: e.asset_is_synthetic,
          href: `/artifacts/${encodeURIComponent(e.asset_code)}`,
          encodings: 1,
        });
    }
    return [...byAsset.values()]
      .sort((a, b) => (rank[a.direction] ?? 9) - (rank[b.direction] ?? 9) || a.label.localeCompare(b.label))
      .map(({ encodings, ...n }) => ({
        ...n,
        sublabel: `${n.synthetic ? 'synthetic' : 'real'}${encodings > 1 ? ` · ${encodings} encodings` : ''}`,
      }));
  }, [impact.data]);

  const contractRows = useMemo(
    () => (contracts.data ?? []).filter((c) => (impact.data?.contracts ?? rule.data?.contracts ?? []).includes(c.code)),
    [contracts.data, impact.data, rule.data],
  );

  const contractColumns = useMemo<ColumnDef<ContractOut, unknown>[]>(
    () => [
      {
        header: 'Code',
        accessorKey: 'code',
        meta: { mono: true },
        cell: (c) => <span className="font-semibold text-navy">{c.row.original.code}</span>,
      },
      { header: 'Title', accessorKey: 'title', meta: { wrap: true } },
      {
        header: 'Severity',
        accessorKey: 'severity',
        cell: (c) => <Chip tone={severityTone(c.row.original.severity)}>{c.row.original.severity}</Chip>,
      },
      { header: 'Kind', accessorKey: 'kind', cell: (c) => <Chip tone="neutral">{c.row.original.kind}</Chip> },
      { header: 'Check', accessorKey: 'check', meta: { mono: true } },
      {
        header: 'Owner',
        accessorKey: 'owner_role',
        cell: (c) => <span title={c.row.original.owner_role}>{roleLabel(c.row.original.owner_role)}</span>,
      },
    ],
    [],
  );

  const inForceForPrompts = impact.data?.in_force_version ?? null;
  const promptColumns = useMemo<ColumnDef<ImpactPromptVersion, unknown>[]>(
    () => [
      { header: 'Workflow', accessorKey: 'workflow', meta: { mono: true } },
      {
        header: 'Prompt',
        accessorKey: 'version',
        cell: (c) => <span className="font-mono">v{c.row.original.version}</span>,
        size: 70,
      },
      { header: 'Label', accessorKey: 'label', meta: { wrap: true } },
      {
        header: 'Declares',
        accessorKey: 'declared_version',
        cell: (c) => {
          const p = c.row.original;
          return (
            <span className="inline-flex items-center gap-1.5 font-mono">
              {code}@v{p.declared_version ?? '?'}
              <DeclaredChip stale={p.stale} declared={p.declared_version} inForce={inForceForPrompts} />
            </span>
          );
        },
      },
      {
        header: 'Prompt hash',
        accessorKey: 'prompt_hash',
        meta: { mono: true },
        cell: (c) => <span title={c.row.original.prompt_hash}>{shortHash(c.row.original.prompt_hash, 16)}</span>,
      },
    ],
    [code, inForceForPrompts],
  );

  if (rule.isLoading) return <LoadingState className="p-6" rows={5} />;
  if (rule.error && !rule.data) {
    return (
      <div className="p-6">
        <ErrorState error={rule.error} title={`Could not load rule ${code}`} retry={() => void rule.refetch()} />
      </div>
    );
  }
  if (!rule.data) return null;
  const r = rule.data;
  const counts = impact.data?.counts;
  const inForceAsOf = impact.data?.in_force_version ?? null;
  const openTaskCount = (impact.data?.stale ?? []).filter(
    (it) => it.task_id && (it.task_state === null || it.task_state === 'open' || it.task_state === 'in_review'),
  ).length;
  // Reading the impact opens no tasks; these stale artifacts are not in the review queue yet.
  const missingTasks = (impact.data?.stale ?? []).filter((it) => !it.task_id).length;
  const encodingsLabel = counts
    ? `${counts.artifacts} artifact${counts.artifacts === 1 ? '' : 's'} · ${counts.total} encoding${counts.total === 1 ? '' : 's'}`
    : '…';

  const inForceV = r.versions.find((v) => v.version === (inForceAsOf ?? r.in_force_version));
  const primarySource = inForceV?.sources?.[0]?.authority === 'primary' ? inForceV.sources[0] : null;
  const evidencePreview = [
    {
      label: 'Rule',
      value: `${r.code.toUpperCase()} · ${inForceAsOf === null ? 'no version in force' : `v${inForceAsOf} in force`}`,
      mono: true,
    },
    { label: 'As of', value: fmtDate(asOf), mono: true },
    { label: 'Citation', value: r.citation, mono: true },
    {
      label: 'Blast radius',
      value: counts
        ? `${encodingsLabel} stale · ${counts.over_restrictive} over · ${counts.under_restrictive} under · ${counts.reverify} re-verify`
        : '…',
    },
    ...(fanNodes.length
      ? [
          {
            label: 'Artifacts',
            value:
              fanNodes
                .filter((n) => n.direction !== 'healthy')
                .map((n) => n.label)
                .join(' · ') || 'none stale',
          },
        ]
      : []),
    { label: 'Review tasks', value: `${openTaskCount} open on these encodings` },
    ...(gateRun ? [{ label: 'Gate', value: <GateChip gate={gateRun.gate} />, mono: false }] : []),
  ];

  return (
    <div>
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <span className="font-mono text-[12px] font-semibold tracking-[0.04em] text-slate">
              {r.code.toUpperCase()}
            </span>
            <span aria-hidden className="text-input">
              ·
            </span>
            <span>Rule · {r.regulator}</span>
          </span>
        }
        title={r.title}
        description={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {r.source_url ? (
              <a
                href={r.source_url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 font-mono text-[12px]"
              >
                {r.citation} <ExternalLink size={11} aria-hidden />
              </a>
            ) : (
              <span className="font-mono text-[12px] text-slate">{r.citation}</span>
            )}
            {primarySource && (
              <Chip tone="slate" title={`In-force version rests on primary authority: ${primarySource.cite}`}>
                <Landmark size={11} aria-hidden /> Primary authority
              </Chip>
            )}
            <RuleStatusNotes rule={r} />
            <span className="inline-flex gap-1">
              {r.applies_to.map((a) => (
                <Chip key={a} tone="neutral">
                  {a}
                </Chip>
              ))}
            </span>
          </div>
        }
        actions={
          <>
            <div className="flex flex-col items-end gap-1">
              <DateAsOfControl value={asOf} onChange={setAsOf} quick={quick} />
              {openedOnUpcoming && (
                <span className="text-[11.5px] text-ink-2" role="note">
                  Showing the next change on this rule ({fmtDate(asOf)}).{' '}
                  <button
                    type="button"
                    className="font-semibold text-teal-ink hover:underline"
                    onClick={() => setAsOf(today)}
                  >
                    Show today
                  </button>
                </span>
              )}
            </div>
            <EvidenceExport scope="rules" id={r.code} asOf={asOf} className="self-end" preview={evidencePreview} />
            <span className="self-end">
              <GatedButton
                action="propose_rule_versions"
                className="btn btn-outline"
                onClick={() => setProposeOpen(true)}
              >
                <Plus size={13} aria-hidden /> Propose version
              </GatedButton>
            </span>
          </>
        }
      />

      <div className="px-4 pb-2 sm:px-6">
        <div className="card px-4 pb-3 pt-3 sm:px-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="eyebrow">Effective dates</span>
            <span className="text-[12px] text-ink-2">
              {r.versions.length} version{r.versions.length === 1 ? '' : 's'} · nothing is updated in place
            </span>
          </div>
          <VersionTrack versions={r.versions} inForceVersion={inForceAsOf} asOf={asOf} seq={seq} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-0 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 xl:order-1">
          <Section
            band
            title={`Blast radius as of ${fmtDate(asOf)}`}
            right={
              <span className="inline-flex items-center gap-2 normal-case tracking-normal">
                {impact.isFetching && <span className="text-[11px] font-medium text-ink-3">recomputing…</span>}
                <Chip
                  key={`v-${seq}`}
                  tone={inForceAsOf === null ? 'neutral' : 'teal'}
                  className={seq > 0 ? 'cz-version' : undefined}
                  title="Version in force on the evaluation date"
                >
                  in force {inForceAsOf === null ? 'none' : `v${inForceAsOf}`}
                </Chip>
                {gateRun && (
                  <span
                    key={`g-${seq}`}
                    className={cn(
                      'inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-ink-2',
                      seq > 0 && 'cz-gate',
                    )}
                    title={`Latest run at rule date ${asOf}: ${gateRun.id}`}
                  >
                    run gate <GateChip gate={gateRun.gate} />
                  </span>
                )}
              </span>
            }
          >
            {impact.error && !impact.data ? (
              <ErrorState error={impact.error} retry={() => void impact.refetch()} />
            ) : (
              <>
                <div className="card grid grid-cols-2 gap-px overflow-hidden bg-hairline sm:grid-cols-3">
                  <div className="bg-surface px-4 py-3">
                    <div className="eyebrow">Stale artifacts</div>
                    <div className="stat mt-1 text-[24px] text-ink">
                      {impact.isLoading ? (
                        '…'
                      ) : (
                        <TickNumber value={counts?.artifacts ?? 0} delayMs={CAUSALITY_STEPS.counts} />
                      )}
                    </div>
                    <div className="text-[11px] text-ink-2">
                      {impact.isLoading ? '' : `${counts?.total ?? 0} encodings`}
                    </div>
                  </div>
                  {(
                    [
                      ['Over-restrictive', counts?.over_restrictive ?? 0, 'text-amber-ink'],
                      ['Under-restrictive', counts?.under_restrictive ?? 0, 'text-red'],
                      ['Re-verify', counts?.reverify ?? 0, 'text-slate'],
                      ['Open question', counts?.disputed ?? 0, 'text-amber-ink'],
                    ] as Array<[string, number, string]>
                  ).map(([label, value, color]) => (
                    <div key={label} className="bg-surface px-4 py-3">
                      <div className="eyebrow">{label}</div>
                      <div className={cn('stat mt-1 text-[24px]', value ? color : 'text-ink-3')}>
                        {impact.isLoading ? '…' : <TickNumber value={value} delayMs={CAUSALITY_STEPS.counts} />}
                      </div>
                      <div className="text-[11px] text-ink-2">encodings</div>
                    </div>
                  ))}
                  <Link
                    to="/review?kind=STALE_ASSET"
                    className="relative block bg-surface px-4 py-3 transition-colors hover:bg-teal/5 hover:no-underline"
                  >
                    {/* keyed overlay replays the step marker without remounting the ticking count */}
                    {seq > 0 && (
                      <span key={`t-${seq}`} aria-hidden className="cz-tasks pointer-events-none absolute inset-0" />
                    )}
                    <div className="eyebrow">Review tasks</div>
                    <div className="stat mt-1 text-[24px] text-ink">
                      {impact.isLoading ? '…' : <TickNumber value={openTaskCount} delayMs={CAUSALITY_STEPS.tasks} />}
                    </div>
                    <div className="text-[11px] text-teal-ink">open on these encodings →</div>
                  </Link>
                </div>
                <div className="card mt-3 p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="eyebrow">Dependency view — rule version → artifacts</span>
                    <span className="font-mono text-[12px] text-ink-2">{encodingsLabel} stale</span>
                  </div>
                  {impact.isLoading ? (
                    <LoadingState rows={2} />
                  ) : fanNodes.length ? (
                    <FanDiagram
                      ruleCode={r.code}
                      ruleLabel={
                        inForceAsOf === null
                          ? `no version in force · ${fmtDate(asOf)}`
                          : `v${inForceAsOf} in force · ${fmtDate(asOf)}`
                      }
                      nodes={fanNodes}
                      onNodeClick={(n) => n.href && navigate(n.href)}
                    />
                  ) : (
                    <EmptyState
                      title="No artifacts linked"
                      hint="Confirm edges from a scan to populate the fan."
                      className="py-4"
                      action={
                        <Link
                          to="/review?kind=PROPOSED_EDGE&state=open"
                          className="btn btn-outline btn-sm hover:no-underline"
                        >
                          Review proposed edges
                        </Link>
                      }
                    />
                  )}
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-hairline pt-2.5 text-[11px] text-ink-2">
                    <span>
                      <span className="mr-1.5 inline-block h-0.5 w-3 bg-red align-middle" />
                      under-restrictive
                    </span>
                    <span>
                      <span className="mr-1.5 inline-block h-0.5 w-3 bg-amber align-middle" />
                      over-restrictive
                    </span>
                    <span>
                      <span className="mr-1.5 inline-block h-0.5 w-3 bg-slate align-middle" />
                      re-verify
                    </span>
                    <span>
                      <span className="mr-1.5 inline-block h-0.5 w-3 bg-green align-middle" />
                      current (bound to the version in force)
                    </span>
                  </div>
                </div>
              </>
            )}
          </Section>

          <Section
            title={`Stale encodings — ${encodingsLabel}`}
            right={
              impact.data && !impact.isPlaceholderData ? (
                <OpenStaleTasksButton code={r.code} asOf={asOf} missing={missingTasks} />
              ) : null
            }
          >
            {impact.isLoading ? (
              <LoadingState rows={4} />
            ) : (
              <div className="space-y-3">
                <StaleGroup
                  title="Over-restrictive — still enforces something the rule no longer requires"
                  direction="over_restrictive"
                  items={groups.over}
                  ruleCode={r.code}
                  hint="No confirmed encoding of this rule applies a stricter clause than the one in force."
                  seq={seq}
                />
                <StaleGroup
                  title="Under-restrictive — encodes a weaker clause or misses a new requirement"
                  direction="under_restrictive"
                  items={groups.under}
                  ruleCode={r.code}
                  hint="No confirmed encoding of this rule is missing a requirement in force. An artifact no matcher recognised is not evaluated."
                  seq={seq}
                />
                <StaleGroup
                  title="Re-verify — the basis or wording changed; a human must read it"
                  direction="reverify"
                  items={groups.reverify}
                  ruleCode={r.code}
                  hint="Nothing on this rule needs a human re-read as of this date."
                  seq={seq}
                />
              </div>
            )}
          </Section>

          <Section band title="Contracts on this rule">
            <DataTable
              columns={contractColumns}
              data={contractRows}
              isLoading={contracts.isLoading}
              error={contracts.error}
              getRowId={(c) => c.code}
              onRowClick={(c) => navigate(`/contracts/${encodeURIComponent(c.code)}`)}
              emptyTitle="No contracts read this rule"
              className="bg-surface"
            />
          </Section>

          <Section title="Prompt versions declaring this rule">
            <DataTable
              columns={promptColumns}
              data={impact.data?.prompt_versions ?? []}
              isLoading={impact.isLoading}
              error={impact.error}
              getRowId={(p) => p.id}
              emptyTitle="No prompt declares this rule"
              emptyHint="Prompt versions declare the rule versions they encode (encodes_rule_versions)."
            />
          </Section>
        </div>

        <aside className="min-w-0 px-4 py-4 sm:px-6 xl:order-2 xl:pl-0">
          <div className="card p-4">
            <div className="eyebrow mb-1">Versions</div>
            <p className="mb-4 text-[12px] leading-relaxed text-ink-2">{r.summary}</p>
            <Timeline versions={r.versions} inForceVersion={inForceAsOf} asOf={asOf} onWhatIf={setWhatIfVersion} />
          </div>
        </aside>
      </div>

      <SourceWatch code={r.code} />

      <Drawer
        open={whatIfVersion !== null}
        onClose={() => setWhatIfVersion(null)}
        title={whatIfVersion ? `What-if · v${whatIfVersion.version} (proposed)` : 'What-if'}
        subtitle={`${r.code} · hypothetical: nothing is written, no tasks are opened`}
      >
        {whatIfVersion && (
          <WhatIfImpact
            code={r.code}
            version={whatIfVersion.version}
            asOf={whatIfVersion.effective_from ?? asOf}
            undated={!whatIfVersion.effective_from}
            voteDate={whatIfVersion.vote_date ?? null}
          />
        )}
      </Drawer>

      <ProposeVersionDrawer
        code={r.code}
        open={proposeOpen}
        onClose={() => setProposeOpen(false)}
        nextVersion={Math.max(0, ...r.versions.map((v) => v.version)) + 1}
        defaultEffectiveFrom={nextContractYearStart(today)}
      />
    </div>
  );
}
