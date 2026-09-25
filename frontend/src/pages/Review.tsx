import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, X } from 'lucide-react';
import { useContracts, useReviewTask, useReviewTasks, useRule, useRunResults, useRuns, useTestCases, useTransition } from '../api/hooks';
import type { ContractOut, JsonObject, ReviewTaskOut, RuleVersionOut, RunOut, TestCaseOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section, Field } from '../components/layout/Page';
import { DataTable } from '../components/ui/DataTable';
import { Chip } from '../components/ui/Chip';
import { DirectionChip } from '../components/rules/DirectionChip';
import { GateChip } from '../components/runs/GateChip';
import { EvidenceExport } from '../components/evidence/EvidenceExport';
import { SourceBadge } from '../components/artifacts/SourceBadge';
import { Drawer } from '../components/ui/Drawer';
import { KeyValue } from '../components/ui/KeyValue';
import { paramsToRows } from '../lib/keyvalue';
import { JsonView } from '../components/ui/JsonView';
import { EvidenceBlock } from '../components/evidence/EvidenceBlock';
import { ErrorState } from '../components/ui/ErrorState';
import { LoadingState } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import { SkeletonRows } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/useToast';
import { fmtDate, fmtNumber, fmtTs, shortHash } from '../lib/format';
import { artifactTypeLabel, kindLabel, kindTone, REASON_CODES, REASON_REQUIRED_STATES, REVIEW_KINDS, REVIEW_STATES, roleLabel, stateTone } from '../lib/vocab';
import { isObject, str, strList } from '../lib/evidence';
import { cn } from '../lib/cn';
import { countByLane, filterTasksByRun, groupActionable, taskLane, TERMINAL_REVIEW_STATES, type FlaggedGroup } from '../lib/review';
import { shortModel } from '../lib/audit';

function versionAsJson(v: RuleVersionOut | undefined | null): JsonObject | null {
  return v ? (Object.fromEntries(Object.entries(v)) as JsonObject) : null;
}

function Subject({ t }: { t: ReviewTaskOut }) {
  if (t.kind === 'FLAGGED_RESULT') {
    const aggregate = t.payload.aggregate === true;
    return (
      <span className="font-mono text-[12px]">
        <span className="font-semibold text-navy">{t.contract_code ?? '—'}</span>
        <span className="text-ink-3"> × </span>
        {aggregate ? `${strList(t.payload.flagged_transcripts).length} transcripts` : t.transcript_code ?? '—'}
        {t.run_id && <span className="ml-1 text-ink-3">· run {t.run_id.slice(0, 8)}</span>}
      </span>
    );
  }
  if (t.kind === 'RULE_SOURCE_CHANGED') {
    return (
      <span className="text-[12px]">
        <span className="font-mono font-semibold text-navy">{t.rule_code ?? str(t.payload.rule)}</span>
        <span className="text-ink-3"> ← </span>
        <span className="font-mono text-ink-2">{typeof t.payload.source_url === 'string' ? t.payload.source_url.replace(/^https?:\/\/(www\.)?/, '') : 'source'}</span>
      </span>
    );
  }
  return (
    <span className="text-[12px]">
      <span className="font-mono font-semibold text-navy">
        {t.rule_code ?? '—'}
        {t.rule_version !== null ? `@v${t.rule_version}` : ''}
      </span>
      <span className="text-ink-3"> → </span>
      <span>{t.asset_name ?? t.asset_code ?? '—'}</span>
    </span>
  );
}

/** Rule diff for stale assets: payload gives bound/in-force version numbers; the rule's versions give the text. */
function RuleDiff({ task }: { task: ReviewTaskOut }) {
  const rule = useRule(task.rule_code ?? undefined);
  const boundVersion = typeof task.payload.bound_version === 'number' ? task.payload.bound_version : (task.rule_version ?? 1) - 1;
  const inForceVersion = typeof task.payload.in_force_version === 'number' ? task.payload.in_force_version : task.rule_version;
  const from = versionAsJson(rule.data?.versions.find((v) => v.version === boundVersion));
  const to = versionAsJson(rule.data?.versions.find((v) => v.version === inForceVersion));
  if (rule.isLoading) return <LoadingState rows={2} />;
  if (rule.error && !rule.data) return <ErrorState error={rule.error} title="Could not load the rule" />;
  if (!from && !to) return null;
  const col = (label: string, v: JsonObject | null, tone: 'neutral' | 'teal') => (
    <div className={cn('border px-3 py-2', tone === 'teal' ? 'border-teal' : 'border-hairline')}>
      <div className="flex items-center gap-2">
        <span className="eyebrow">{label}</span>
        {v && <span className="font-mono text-[12px] font-semibold text-navy">v{str(v.version)}</span>}
        {v && typeof v.change_classification === 'string' && <Chip tone="slate">{v.change_classification.replace('_', ' ')}</Chip>}
        {v?.disputed === true && (
          <Chip tone="amber">
            <AlertTriangle size={11} aria-hidden /> disputed
          </Chip>
        )}
      </div>
      {v ? (
        <>
          {typeof v.summary === 'string' && <div className="mt-1 text-[12px] font-medium text-slate">{v.summary}</div>}
          {typeof v.clause_text === 'string' && <blockquote className="quote mt-1 text-[12px]">{v.clause_text}</blockquote>}
          {isObject(v.params) && <KeyValue className="mt-1" rows={paramsToRows(v.params)} />}
        </>
      ) : (
        <div className="text-[12px] text-ink-3">—</div>
      )}
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      {col('Bound to', from, 'neutral')}
      {col(`In force${typeof task.payload.as_of === 'string' ? ` as of ${task.payload.as_of}` : ''}`, to, 'teal')}
    </div>
  );
}

/** Evidence for a flagged result, fetched from the run's results (single) or listed as links (aggregate). */
function FlaggedEvidence({ task }: { task: ReviewTaskOut }) {
  const aggregate = task.payload.aggregate === true;
  const results = useRunResults(task.run_id ?? undefined, { transcript: task.transcript_code ?? undefined, contract: task.contract_code ?? undefined }, !aggregate && Boolean(task.run_id));
  if (aggregate) {
    const codes = strList(task.payload.flagged_transcripts);
    return (
      <div>
        <div className="eyebrow mb-1">Flagged transcripts ({codes.length}) — advisory, judged</div>
        <div className="flex flex-wrap gap-1">
          {codes.map((code) => (
            <Link key={code} to={`/runs/${task.run_id}/transcripts/${encodeURIComponent(code)}`} className="hover:no-underline">
              <Chip tone="amber" mono>
                {code}
              </Chip>
            </Link>
          ))}
        </div>
        <KeyValue className="mt-2" rows={[{ key: 'Contract', value: str(task.payload.contract ?? task.contract_code) }, { key: 'Severity', value: str(task.payload.severity) }, { key: 'Run', value: task.run_id ?? '—' }]} />
      </div>
    );
  }
  if (!task.run_id) return null;
  return (
    <div>
      <div className="eyebrow mb-1">Evidence — GET /runs/{task.run_id.slice(0, 8)}…/results</div>
      {results.isLoading && <LoadingState rows={2} />}
      {results.error && !results.data ? <ErrorState error={results.error} title="Could not load the result" /> : null}
      {results.data && results.data.length === 0 && <EmptyState title="Result not found in the run" className="py-3" />}
      {results.data?.map((r) => (
        <EvidenceBlock key={r.id} result={r} transcriptLink={`/runs/${task.run_id}/transcripts/${encodeURIComponent(r.transcript_code)}`} />
      ))}
    </div>
  );
}

function TestCaseCard({ tc }: { tc: TestCaseOut }) {
  return (
    <div className="border border-teal bg-teal/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Test case created</span>
        <span className="font-mono text-[12px] font-semibold text-navy">{tc.id}</span>
        <Chip tone={tc.status === 'APPROVED' ? 'green' : 'amber'}>{tc.status.replace('_', ' ')}</Chip>
      </div>
      <KeyValue
        className="mt-2"
        rows={[
          { key: 'Contract × transcript', value: `${tc.contract_code} × ${tc.transcript_code ?? '—'}` },
          { key: 'Reason code', value: tc.reason_code },
          { key: 'Created by', value: tc.created_by },
          { key: 'Approver', value: tc.approver ?? 'pending approval by a different user' },
          { key: 'Expires', value: `${fmtDate(tc.expires_at)} (12 months)` },
        ]}
      />
      <div className="mt-2 text-[12px] text-ink-2">
        The override becomes a pinned expectation only after someone other than {tc.created_by} approves it. <Link to="/test-cases">Test cases →</Link>
      </div>
    </div>
  );
}

export function TaskDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const task = useReviewTask(taskId ?? undefined);
  const transition = useTransition(taskId ?? '');
  const testCases = useTestCases();
  const { toast } = useToast();
  const [to, setTo] = useState<string>('');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [forceOther, setForceOther] = useState('');

  useEffect(() => {
    setTo('');
    setReasonCode('');
    setNote('');
    setForceOther('');
    transition.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const t = task.data;
  const target = forceOther || to;
  const needsReason = REASON_REQUIRED_STATES.has(target);
  // The overridden transition writes payload.test_case_id; fall back to matching review_task_id.
  const createdTestCase = useMemo(() => {
    if (!t) return null;
    const byId = typeof t.payload.test_case_id === 'string' ? testCases.data?.find((tc) => tc.id === t.payload.test_case_id) : undefined;
    return byId ?? testCases.data?.find((tc) => tc.review_task_id === t.id) ?? null;
  }, [t, testCases.data]);
  const pendingTestCaseId = t && typeof t.payload.test_case_id === 'string' && !createdTestCase ? t.payload.test_case_id : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    transition.mutate(
      { to: target, reason_code: reasonCode || null, note },
      {
        onSuccess: (updated) => {
          const tcId = typeof updated.payload.test_case_id === 'string' ? updated.payload.test_case_id : null;
          toast({ title: `${updated.id.slice(0, 8)} → ${updated.state}`, detail: tcId ? `test case ${tcId} created — pending approval by a different user` : (updated.reason_code ?? undefined), tone: updated.state === 'overridden' ? 'teal' : 'green' });
          setTo('');
          setForceOther('');
          setReasonCode('');
          setNote('');
        },
      },
    );
  };

  return (
    <Drawer
      open={taskId !== null}
      onClose={onClose}
      title={t ? `${kindLabel(t.kind)} · ${t.id.slice(0, 8)}` : 'Review task'}
      subtitle={
        t ? (
          <span className="inline-flex items-center gap-2">
            <Chip tone={stateTone(t.state)}>{t.state.replace('_', ' ')}</Chip> assigned to <span title={t.assignee_role}>{roleLabel(t.assignee_role)}</span> · opened {fmtTs(t.opened_at)}
          </span>
        ) : null
      }
      width={640}
    >
      {task.isLoading && <LoadingState rows={4} />}
      {task.error && !task.data ? <ErrorState error={task.error} retry={() => void task.refetch()} /> : null}
      {t && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-3">
            {taskLane(t) === 'advisory' ? (
              <Chip tone="neutral" title="An aggregate observation from a run — visible, not a work item">
                advisory · not a ticket
              </Chip>
            ) : (
              <Chip tone="amber" title="A human decides this task">
                actionable
              </Chip>
            )}
            <EvidenceExport
              scope="tasks"
              id={t.id}
              size="sm"
              preview={[
                { label: 'Task', value: `${t.id.slice(0, 8)} · ${kindLabel(t.kind)}`, mono: true },
                ...(t.rule_code ? [{ label: 'Rule', value: `${t.rule_code.toUpperCase()}${t.rule_version !== null ? ` · v${t.rule_version}` : ''}`, mono: true }] : []),
                ...(t.asset_name || t.asset_code ? [{ label: 'Artifact', value: `${t.asset_name ?? t.asset_code}${t.asset_type ? ` · ${artifactTypeLabel(t.asset_type)}` : ''}` }] : []),
                ...(t.contract_code ? [{ label: 'Contract', value: `${t.contract_code}${t.transcript_code ? ` × ${t.transcript_code}` : ''}`, mono: true }] : []),
                ...(t.run_id ? [{ label: 'Run', value: t.run_id.slice(0, 8), mono: true }] : []),
                ...(t.staleness_direction ? [{ label: 'Direction', value: <DirectionChip direction={t.staleness_direction} /> }] : []),
                { label: 'Decision', value: `${t.state.replace('_', ' ')}${t.reason_code ? ` · ${t.reason_code}` : ''}${t.decided_by ? ` · by ${t.decided_by}` : ''}` },
              ]}
            />
          </div>
          <div>
            <div className="eyebrow mb-1">Subject</div>
            <div className="flex flex-wrap items-center gap-2">
              <Subject t={t} />
              {t.asset_type && <Chip tone="neutral">{artifactTypeLabel(t.asset_type)}</Chip>}
              {t.asset_is_synthetic !== null && <SourceBadge isSynthetic={t.asset_is_synthetic} type={t.asset_type} />}
              {t.staleness_direction && <DirectionChip direction={t.staleness_direction} />}
            </div>
            <p className="mt-2 text-[13px] text-ink">{t.reason}</p>
            <div className="mt-1 flex flex-wrap gap-3 text-[12px]">
              {t.rule_code && <Link to={`/rules/${encodeURIComponent(t.rule_code)}${typeof t.payload.as_of === 'string' ? `?as_of=${t.payload.as_of}` : ''}`}>Rule →</Link>}
              {t.asset_code && <Link to={`/artifacts/${encodeURIComponent(t.asset_code)}`}>Artifact →</Link>}
              {t.run_id && <Link to={`/runs/${t.run_id}`}>Run →</Link>}
              {t.run_id && t.transcript_code && t.payload.aggregate !== true && <Link to={`/runs/${t.run_id}/transcripts/${encodeURIComponent(t.transcript_code)}`}>Transcript in run →</Link>}
            </div>
          </div>

          {t.evidence_span && (
            <div>
              <div className="eyebrow mb-1">Evidence span</div>
              <blockquote className="quote">
                <mark className="mark-span bg-transparent">{t.evidence_span}</mark>
              </blockquote>
              {t.kind === 'PROPOSED_EDGE' && (
                <KeyValue
                  className="mt-2"
                  rows={[
                    { key: 'Proposed for', value: `${str(t.payload.rule ?? t.rule_code)}${t.payload.version !== undefined ? `@v${str(t.payload.version)}` : t.rule_version !== null ? `@v${t.rule_version}` : ''}` },
                    { key: 'Detection', value: typeof t.payload.matcher === 'string' ? `matcher ${t.payload.matcher}` : str(t.payload.detection ?? 'llm') },
                  ]}
                />
              )}
            </div>
          )}

          {t.kind === 'STALE_ASSET' && (
            <div>
              <div className="eyebrow mb-1">Rule diff — bound version vs in force</div>
              <RuleDiff task={t} />
              {t.payload.disputed === true && (
                <div className="mt-2 border border-amber bg-amber/5 px-3 py-2 text-[12px] text-ink">
                  <span className="font-semibold text-amber-ink">Disputed reading on the path.</span> Verify with counsel before republishing; NEEDS_COUNSEL is a valid reason code.
                </div>
              )}
            </div>
          )}

          {t.kind === 'RULE_SOURCE_CHANGED' && (
            <div>
              <div className="eyebrow mb-1">Source change</div>
              <KeyValue
                rows={[
                  { key: 'Rule', value: <Link to={`/rules/${encodeURIComponent(str(t.payload.rule ?? t.rule_code))}`}>{str(t.payload.rule ?? t.rule_code)}</Link> },
                  {
                    key: 'Source',
                    value: typeof t.payload.source_url === 'string' ? (
                      <a href={t.payload.source_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all">
                        {t.payload.source_url} <ExternalLink size={11} className="shrink-0" aria-hidden />
                      </a>
                    ) : '—',
                  },
                  { key: 'Previous hash', value: <span title={str(t.payload.previous_hash)}>{str(t.payload.previous_hash)}</span> },
                  { key: 'New hash', value: <span className="text-amber-ink" title={str(t.payload.new_hash)}>{str(t.payload.new_hash)}</span> },
                ]}
              />
              {typeof t.payload.excerpt === 'string' && <blockquote className="quote mt-2 text-[12px]">{t.payload.excerpt}</blockquote>}
              <div className="mt-2 border border-hairline bg-band px-3 py-2 text-[12px] text-ink-2">
                <span className="font-semibold text-slate">Verified</span> = a new rule version was added in rules/*.yaml; <span className="font-semibold text-slate">Dismissed</span> = no material change.
              </div>
            </div>
          )}

          {t.kind === 'FLAGGED_RESULT' && <FlaggedEvidence task={t} />}

          {(t.note || t.reason_code || t.decided_by) && (
            <div>
              <div className="eyebrow mb-1">Decision so far</div>
              <KeyValue rows={[{ key: 'Reason code', value: t.reason_code ?? '—' }, { key: 'Note', value: t.note || '—', mono: false }, { key: 'Decided by', value: t.decided_by ?? '—' }, { key: 'Closed', value: fmtTs(t.closed_at) }]} />
            </div>
          )}

          {createdTestCase && <TestCaseCard tc={createdTestCase} />}
          {pendingTestCaseId && (
            <div className="border border-teal bg-teal/5 p-3 text-[12px]">
              <span className="eyebrow">Test case created</span> <span className="font-mono">{pendingTestCaseId}</span> — pending approval by a different user, expires in 12 months. <Link to="/test-cases">Test cases →</Link>
            </div>
          )}

          <form onSubmit={submit} className="border-t border-hairline pt-3">
            <div className="eyebrow mb-1">Transition</div>
            {t.allowed_transitions.length ? (
              <div className="flex flex-wrap gap-1.5">
                {t.allowed_transitions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={cn('btn btn-sm', to === s && !forceOther ? '' : 'btn-outline')}
                    aria-pressed={to === s && !forceOther}
                    onClick={() => {
                      setTo(s);
                      setForceOther('');
                    }}
                  >
                    → {s.replace('_', ' ')}
                  </button>
                ))}
              </div>
            ) : (
              // allowed_transitions is already filtered by the caller's role server-side,
              // so an empty list on a non-terminal state means "not for your role".
              <div className="text-[12px] text-ink-2">
                {TERMINAL_REVIEW_STATES.has(t.state) ? (
                  <>
                    <span className="font-mono">{t.state}</span> is terminal — no further transitions.
                  </>
                ) : (
                  <>
                    No transitions available for your role from state <span className="font-mono">{t.state}</span>.
                    {t.state === 'verified' && t.kind === 'STALE_ASSET' && <> Engineers and admins mark an artifact republished once the fix is live.</>}
                  </>
                )}
              </div>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-ink-3">Try a transition the state machine should refuse</summary>
              <select
                className="input mt-1 h-7 w-[220px] text-[12px]"
                value={forceOther}
                onChange={(e) => {
                  setForceOther(e.target.value);
                  setTo('');
                }}
                aria-label="Other transition"
              >
                <option value="">— none —</option>
                {REVIEW_STATES.filter((s) => !t.allowed_transitions.includes(s) && s !== t.state).map((s) => (
                  <option key={s} value={s}>
                    {s} (not allowed — expect 409/403)
                  </option>
                ))}
              </select>
            </details>
            {target && (
              <div className="mt-3 space-y-2">
                <Field label={`Reason code${needsReason ? ' (required)' : ''}`} htmlFor="rv-reason">
                  <select id="rv-reason" className="input" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} required={needsReason}>
                    <option value="">—</option>
                    {REASON_CODES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Note" htmlFor="rv-note">
                  <textarea id="rv-note" className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What a reviewer six months from now needs to know." />
                </Field>
              </div>
            )}
            {transition.error ? <ErrorState error={transition.error} title="Transition refused" className="mt-2" /> : null}
            <div className="mt-3 flex justify-end gap-2">
              <button type="submit" className="btn" disabled={!target || transition.isPending || (needsReason && !reasonCode)}>
                {transition.isPending ? 'Posting…' : target ? `Apply → ${target.replace('_', ' ')}` : 'Pick a transition'}
              </button>
            </div>
          </form>
          <details>
            <summary className="cursor-pointer text-[11px] text-ink-3">Raw payload</summary>
            <JsonView value={t.payload} collapsedBelow={1} className="mt-1" />
          </details>
        </div>
      )}
    </Drawer>
  );
}

type LaneView = 'actionable' | 'advisory' | 'all';

function laneParam(value: string | null): LaneView {
  return value === 'advisory' || value === 'all' ? value : 'actionable';
}

function ownerOf(contract: ContractOut | undefined, tasks: ReviewTaskOut[]): string {
  return contract?.owner_role ?? tasks[0]?.assignee_role ?? '—';
}

/** Per-call flagged results from one contract in one run, collapsed to a single decision header. */
function FlaggedGroupBlock({
  group,
  contract,
  run,
  selectedId,
  onOpen,
  defaultOpen,
}: {
  group: FlaggedGroup<ReviewTaskOut>;
  contract: ContractOut | undefined;
  run: RunOut | undefined;
  selectedId: string | null;
  onOpen: (id: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const n = group.tasks.length;
  const states = new Map<string, number>();
  for (const t of group.tasks) states.set(t.state, (states.get(t.state) ?? 0) + 1);
  const panelId = `grp-${group.key.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  return (
    <div className="border border-hairline bg-surface">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-band"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={14} className="shrink-0 text-ink-3" aria-hidden /> : <ChevronRight size={14} className="shrink-0 text-ink-3" aria-hidden />}
        <span className="min-w-0 text-[13px]">
          <span className="font-mono font-semibold text-navy">{group.contractCode}</span>
          {contract && <span className="text-slate"> · {contract.title}</span>}
          <span className="text-ink-2"> — </span>
          <span className="font-mono font-semibold tabular-nums text-ink">{n}</span>
          <span className="text-ink-2"> {n === 1 ? 'call' : 'calls'}</span>
        </span>
        <span className="font-mono text-[11px] text-ink-2">
          {run ? (
            <>
              run v{run.prompt_version} · {shortModel(run.model_id)} · {fmtDate(run.rule_date)}
            </>
          ) : group.runId ? (
            <>run {shortHash(group.runId, 8)}</>
          ) : (
            'no run'
          )}
        </span>
        <span className="text-[11px] text-ink-2" title={ownerOf(contract, group.tasks)}>
          owner {roleLabel(ownerOf(contract, group.tasks))}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {[...states.entries()].map(([st, count]) => (
            <Chip key={st} tone={stateTone(st)} size="xs">
              {count} {st.replace('_', ' ')}
            </Chip>
          ))}
          {contract && <Chip tone={contract.severity === 'BLOCK' ? 'red' : 'amber'} size="xs">{contract.severity}</Chip>}
          {run && <GateChip gate={run.gate} />}
        </span>
      </button>
      {open && (
        <div id={panelId} className="border-t border-hairline">
          <table className="dt dt-compact">
            <caption className="sr-only">
              {group.contractCode} flagged calls
            </caption>
            <thead>
              <tr>
                <th>Task</th>
                <th>Transcript</th>
                <th>State</th>
                <th>Opened</th>
                <th>Reason code</th>
              </tr>
            </thead>
            <tbody>
              {group.tasks.map((t) => (
                <tr
                  key={t.id}
                  data-clickable="true"
                  data-selected={selectedId === t.id ? 'true' : 'false'}
                  tabIndex={0}
                  onClick={() => onOpen(t.id)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      onOpen(t.id);
                    }
                  }}
                >
                  <td className="font-mono text-[12px]" title={t.id}>
                    {shortHash(t.id, 8)}
                  </td>
                  <td className="font-mono text-[12px] font-semibold text-navy">{t.transcript_code ?? '—'}</td>
                  <td>
                    <Chip tone={stateTone(t.state)}>{t.state.replace('_', ' ')}</Chip>
                  </td>
                  <td className="font-mono text-[12px]">{fmtTs(t.opened_at)}</td>
                  <td className="font-mono text-[12px]">{t.reason_code ?? <span className="text-ink-3">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Advisory lane: aggregate observations from runs — read, not worked. */
function AdvisoryList({ tasks, runsById, contractsByCode, onOpen }: { tasks: ReviewTaskOut[]; runsById: Map<string, RunOut>; contractsByCode: Map<string, ContractOut>; onOpen: (id: string) => void }) {
  if (!tasks.length) {
    return <EmptyState title="No advisory observations" hint="FLAG-severity and judged contracts report here as one aggregate per run and contract." />;
  }
  return (
    <ul className="divide-y divide-hairline border border-hairline bg-surface">
      {tasks.map((t) => {
        const transcripts = strList(t.payload.flagged_transcripts);
        const run = t.run_id ? runsById.get(t.run_id) : undefined;
        const contract = t.contract_code ? contractsByCode.get(t.contract_code) : undefined;
        return (
          <li key={t.id}>
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-band lg:grid lg:grid-cols-[auto_minmax(0,1fr)_160px_210px_auto]"
              onClick={() => onOpen(t.id)}
            >
              <Chip tone="neutral" size="xs">
                advisory · not a ticket
              </Chip>
              <span className="min-w-0 truncate text-[13px]">
                <span className="font-mono font-semibold text-slate">{t.contract_code ?? str(t.payload.contract)}</span>
                {contract && <span className="text-ink-2"> · {contract.title}</span>}
              </span>
              <span className="text-[12px] text-ink-2">
                flagged on <span className="font-mono font-semibold tabular-nums text-amber-ink">{fmtNumber(transcripts.length)}</span> {transcripts.length === 1 ? 'transcript' : 'transcripts'}
              </span>
              <span className="font-mono text-[11px] text-ink-3">
                {run ? `run v${run.prompt_version} · ${shortModel(run.model_id)}` : t.run_id ? `run ${shortHash(t.run_id, 8)}` : ''}
              </span>
              <span className="ml-auto flex items-center justify-end gap-1.5">
                <Chip tone="amber" size="xs">
                  {str(t.payload.severity ?? contract?.severity)}
                </Chip>
                <span className="font-mono text-[11px] text-ink-3">{fmtTs(t.opened_at)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ReviewPage() {
  useTopBar([{ label: 'Review' }]);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') ?? '';
  const state = params.get('state') ?? '';
  const taskId = params.get('task');
  const runFilter = params.get('run') ?? '';
  const lane = laneParam(params.get('lane'));
  const tasks = useReviewTasks({ kind: kind || undefined, state: state || undefined });
  const runs = useRuns();
  const contracts = useContracts();
  // GET /review has no run filter; narrow client-side on run_id / payload.run_id.
  const runTasks = useMemo(() => filterTasksByRun(tasks.data, runFilter), [tasks.data, runFilter]);
  // Lane badges count work still open (not closed), the same number Home and Readiness show;
  // decided tasks remain listed under the state filter but are not outstanding work.
  const laneCounts = useMemo(() => countByLane(runTasks?.filter((t) => !TERMINAL_REVIEW_STATES.has(t.state))), [runTasks]);
  const visibleTasks = useMemo(() => (lane === 'all' ? runTasks : runTasks?.filter((t) => taskLane(t) === lane)), [runTasks, lane]);
  const layout = useMemo(() => groupActionable(lane === 'actionable' ? visibleTasks : []), [visibleTasks, lane]);
  const runsById = useMemo(() => new Map((runs.data ?? []).map((r) => [r.id, r])), [runs.data]);
  const contractsByCode = useMemo(() => new Map((contracts.data ?? []).map((c) => [c.code, c])), [contracts.data]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const openTask = (id: string) => setParam('task', id);

  const columns = useMemo<ColumnDef<ReviewTaskOut, unknown>[]>(
    () => [
      {
        id: 'subject',
        header: 'Subject',
        accessorFn: (t) => `${t.rule_code ?? ''} ${t.asset_name ?? ''} ${t.contract_code ?? ''} ${t.transcript_code ?? ''}`,
        size: 440,
        meta: { wrap: true },
        cell: (c) => (
          <span className="cell-primary [overflow-wrap:anywhere]">
            <Subject t={c.row.original} />
            <span className="cell-sub font-mono text-[11px]" title={`${c.row.original.id} · opened ${fmtTs(c.row.original.opened_at)}`}>
              #{shortHash(c.row.original.id, 8)}
            </span>
          </span>
        ),
      },
      { header: 'Kind', accessorKey: 'kind', cell: (c) => <Chip tone={kindTone(c.row.original.kind)}>{kindLabel(c.row.original.kind)}</Chip> },
      { header: 'Direction', accessorKey: 'staleness_direction', cell: (c) => <DirectionChip direction={c.row.original.staleness_direction} /> },
      { header: 'Assignee', accessorKey: 'assignee_role', meta: { nowrap: true }, cell: (c) => <span title={c.row.original.assignee_role}>{roleLabel(c.row.original.assignee_role)}</span> },
      { header: 'Opened', accessorKey: 'opened_at', size: 120, meta: { mono: true }, cell: (c) => <span className="text-ink-2">{fmtDate(c.row.original.opened_at)}</span> },
      {
        header: 'State',
        accessorKey: 'state',
        size: 150,
        // The decision's reason code sits under the state it explains (most open tasks have none).
        cell: (c) =>
          taskLane(c.row.original) === 'advisory' ? (
            <Chip tone="neutral" title="Advisory observation — not a ticket">advisory</Chip>
          ) : (
            <span className="cell-primary">
              <Chip tone={stateTone(c.row.original.state)}>{c.row.original.state.replace('_', ' ')}</Chip>
              {c.row.original.reason_code ? (
                <span className="cell-sub font-mono text-[11px]">{c.row.original.reason_code}</span>
              ) : null}
            </span>
          ),
      },
    ],
    [],
  );

  const laneTabs: Array<[LaneView, string, number | null]> = [
    ['actionable', 'Actionable', runTasks ? laneCounts.actionable : null],
    ['advisory', 'Advisory', runTasks ? laneCounts.advisory : null],
    ['all', 'All', runTasks ? runTasks.length : null],
  ];
  const emptyHint = runFilter
    ? 'Only flagged-result tasks carry a run. Clear the run filter to see the whole queue.'
    : 'Tasks open when a scan finds a stale artifact, proposes an edge or sees a rule source change, and when a run fails a blocking contract.';

  return (
    <div>
      <PageHeader
        eyebrow="Review queue"
        title="Review"
        description={
          <>
            A human decides blocking failures, stale encodings, proposed edges and source changes; FLAG-severity and judged contracts stay advisory — visible, not tickets.
            <span className="mt-1 block text-[12px] text-ink-3">Illegal transitions are refused (409) and audit-logged; overriding a flagged call creates a test case a different user must approve.</span>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-hairline px-4 pb-3 sm:px-6">
        <div role="tablist" aria-label="Lane" className="inline-flex overflow-hidden rounded-[6px] border border-input bg-surface">
          {laneTabs.map(([key, label, count]) => (
            <button
              key={key}
              role="tab"
              type="button"
              aria-selected={lane === key}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 border-r border-input px-3 text-[12px] font-semibold uppercase tracking-[0.5px] last:border-r-0',
                lane === key ? 'bg-teal-ink text-on-navy' : 'bg-surface text-slate hover:bg-band',
              )}
              onClick={() => setParam('lane', key === 'actionable' ? '' : key)}
            >
              {label}
              <span className={cn('font-mono text-[12px] tabular-nums', lane === key ? 'text-on-navy' : 'text-ink-2')}>{count ?? '…'}</span>
            </button>
          ))}
        </div>
        <Field label="Kind" htmlFor="rv-kind">
          <select id="rv-kind" className="input h-8 w-[190px] text-[12px]" value={kind} onChange={(e) => setParam('kind', e.target.value)}>
            <option value="">all kinds</option>
            {REVIEW_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State" htmlFor="rv-state">
          <select id="rv-state" className="input h-8 w-[150px] text-[12px]" value={state} onChange={(e) => setParam('state', e.target.value)}>
            <option value="">all</option>
            {REVIEW_STATES.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </Field>
        {runFilter && (
          <div>
            <span className="label">Run</span>
            <span className="inline-flex h-8 items-center gap-1 border border-input bg-band pl-2 pr-1 font-mono text-[12px] text-slate">
              <Link to={`/runs/${encodeURIComponent(runFilter)}`} title={`Run ${runFilter}`}>
                {shortHash(runFilter, 8)}
              </Link>
              <button type="button" className="inline-flex h-5 w-5 items-center justify-center text-ink-2 hover:text-slate" aria-label="Clear run filter" onClick={() => setParam('run', '')}>
                <X size={12} aria-hidden />
              </button>
            </span>
          </div>
        )}
      </div>
      {lane === 'actionable' ? (
        <>
          {(tasks.isLoading || layout.individual.length > 0 || kind !== 'FLAGGED_RESULT') && (
            <Section title={tasks.isLoading ? 'Artifacts and sources' : `Artifacts and sources — ${layout.individual.length}`}>
              <DataTable
                columns={columns}
                data={layout.individual}
                isLoading={tasks.isLoading}
                error={tasks.error}
                retry={() => void tasks.refetch()}
                getRowId={(t) => t.id}
                selectedIds={taskId ? new Set([taskId]) : undefined}
                onRowClick={(t) => openTask(t.id)}
                initialSort={[{ id: 'opened_at', desc: true }]}
                emptyTitle="No stale encodings, proposed edges or source changes"
                emptyHint={emptyHint}
                caption="Actionable review tasks about artifacts and sources"
                skeletonRows={4}
              />
            </Section>
          )}
          {!tasks.isLoading && !tasks.error && (layout.groups.length > 0 || kind === 'FLAGGED_RESULT') && (
            <Section
              band
              title={`Blocking failures by run and contract — ${layout.groups.length} ${layout.groups.length === 1 ? 'group' : 'groups'} · ${layout.groups.reduce((n, g) => n + g.tasks.length, 0)} calls`}
            >
              {layout.groups.length ? (
                <div className="space-y-1.5">
                  {layout.groups.map((g) => (
                    <FlaggedGroupBlock
                      key={g.key}
                      group={g}
                      contract={contractsByCode.get(g.contractCode)}
                      run={g.runId ? runsById.get(g.runId) : undefined}
                      selectedId={taskId}
                      onOpen={openTask}
                      defaultOpen={layout.groups.length === 1 || g.tasks.some((t) => t.id === taskId)}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState title="No blocking failures open" hint={emptyHint} />
              )}
              <p className="mt-2 text-[11px] text-ink-3">Expand a group to decide per call; overriding a call creates a test case that a different user must approve.</p>
            </Section>
          )}
        </>
      ) : lane === 'advisory' ? (
        <Section title="Advisory observations — aggregate per run and contract">
          {tasks.isLoading ? (
            <table className="dt">
              <tbody>
                <SkeletonRows columns={4} rows={4} />
              </tbody>
            </table>
          ) : tasks.error && !tasks.data ? (
            <ErrorState error={tasks.error} retry={() => void tasks.refetch()} />
          ) : (
            <AdvisoryList tasks={visibleTasks ?? []} runsById={runsById} contractsByCode={contractsByCode} onOpen={openTask} />
          )}
        </Section>
      ) : (
        <Section>
          <DataTable
            columns={columns}
            data={visibleTasks}
            isLoading={tasks.isLoading}
            error={tasks.error}
            retry={() => void tasks.refetch()}
            getRowId={(t) => t.id}
            selectedIds={taskId ? new Set([taskId]) : undefined}
            onRowClick={(t) => openTask(t.id)}
            initialSort={[{ id: 'opened_at', desc: true }]}
            rowClassName={(t) => (taskLane(t) === 'advisory' ? 'text-ink-2' : undefined)}
            emptyTitle={runFilter ? `No tasks from run ${shortHash(runFilter, 8)}` : 'No tasks match'}
            emptyHint={emptyHint}
            caption="Review queue — all lanes"
            maxHeight="calc(100vh - 300px)"
          />
        </Section>
      )}
      <TaskDrawer
        taskId={taskId}
        onClose={() =>
          navigate(
            {
              search: (() => {
                const n = new URLSearchParams(params);
                n.delete('task');
                return n.toString();
              })(),
            },
            { replace: true },
          )
        }
      />
    </div>
  );
}
