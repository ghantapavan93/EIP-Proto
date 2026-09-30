import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useReviewTask, useReviewTransition, useRule, useRunResults, useTestCases } from '../../api/hooks';
import type { ReviewTaskOut, RuleVersionOut, TestCaseOut } from '../../api/types';
import { Field } from '../layout/Page';
import { Chip } from '../ui/Chip';
import { Drawer } from '../ui/Drawer';
import { KeyValue } from '../ui/KeyValue';
import { JsonView } from '../ui/JsonView';
import { ErrorState } from '../ui/ErrorState';
import { LoadingState } from '../ui/LoadingState';
import { EmptyState } from '../ui/EmptyState';
import { useToast } from '../ui/useToast';
import { DirectionChip } from '../rules/DirectionChip';
import { EvidenceExport } from '../evidence/EvidenceExport';
import { EvidenceBlock } from '../evidence/EvidenceBlock';
import { SourceBadge } from '../artifacts/SourceBadge';
import { paramsToRows } from '../../lib/keyvalue';
import { fmtDate, fmtTs } from '../../lib/format';
import {
  artifactTypeLabel,
  kindLabel,
  REASON_CODES,
  REASON_REQUIRED_STATES,
  REVIEW_STATES,
  roleLabel,
  stateLabel,
  stateTone,
} from '../../lib/vocab';
import { str, strList } from '../../lib/evidence';
import { cn } from '../../lib/cn';
import { taskLane, TERMINAL_REVIEW_STATES } from '../../lib/review';

/** One line naming what a task is about, for the queue table and the drawer. */
export function TaskSubject({ t }: { t: ReviewTaskOut }) {
  if (t.kind === 'FLAGGED_RESULT') {
    const aggregate = t.payload.aggregate === true;
    return (
      <span className="font-mono text-[12px]">
        <span className="font-semibold text-navy">{t.contract_code ?? '—'}</span>
        <span className="text-ink-3"> × </span>
        {aggregate ? `${strList(t.payload.flagged_transcripts).length} transcripts` : (t.transcript_code ?? '—')}
        {t.run_id && <span className="ml-1 text-ink-3">· run {t.run_id.slice(0, 8)}</span>}
      </span>
    );
  }
  if (t.kind === 'RULE_SOURCE_CHANGED') {
    return (
      <span className="text-[12px]">
        <span className="font-mono font-semibold text-navy">{t.rule_code ?? str(t.payload.rule)}</span>
        <span className="text-ink-3"> ← </span>
        <span className="font-mono text-ink-2">
          {typeof t.payload.source_url === 'string'
            ? t.payload.source_url.replace(/^https?:\/\/(www\.)?/, '')
            : 'source'}
        </span>
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

function VersionColumn({
  label,
  version,
  number,
  tone,
}: {
  label: string;
  version: RuleVersionOut | null;
  number: number | null;
  tone: 'neutral' | 'teal';
}) {
  return (
    <div className={cn('border px-3 py-2', tone === 'teal' ? 'border-teal' : 'border-hairline')}>
      <div className="flex items-center gap-2">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-[12px] font-semibold text-navy">
          {number === null ? 'unknown' : `v${number}`}
        </span>
        {version && <Chip tone="slate">{stateLabel(version.change_classification)}</Chip>}
        {version?.disputed && (
          <Chip tone="amber">
            <AlertTriangle size={11} aria-hidden /> disputed
          </Chip>
        )}
      </div>
      {version ? (
        <>
          {version.summary && <div className="mt-1 text-[12px] font-medium text-slate">{version.summary}</div>}
          <blockquote className="quote mt-1 text-[12px]">{version.clause_text}</blockquote>
          <KeyValue className="mt-1" rows={paramsToRows(version.params)} />
        </>
      ) : (
        <div className="text-[12px] text-ink-3">
          {number === null ? 'The task does not record this version.' : `v${number} is not in the rule's history.`}
        </div>
      )}
    </div>
  );
}

/**
 * Rule diff for a stale artifact: payload.bound_version / in_force_version
 * name the two versions (the task's rule_version is the in-force one); the
 * rule's history gives their text. A version the task does not record is
 * shown as unknown, never guessed.
 */
function RuleDiff({ task }: { task: ReviewTaskOut }) {
  const rule = useRule(task.rule_code ?? undefined);
  const bound = typeof task.payload.bound_version === 'number' ? task.payload.bound_version : null;
  const inForce = typeof task.payload.in_force_version === 'number' ? task.payload.in_force_version : task.rule_version;
  if (rule.isLoading) return <LoadingState rows={2} />;
  if (rule.error && !rule.data) return <ErrorState error={rule.error} title="Could not load the rule" />;
  const find = (n: number | null) => (n === null ? null : (rule.data?.versions.find((v) => v.version === n) ?? null));
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      <VersionColumn label="Bound to" version={find(bound)} number={bound} tone="neutral" />
      <VersionColumn
        label={`In force${typeof task.payload.as_of === 'string' ? ` as of ${task.payload.as_of}` : ''}`}
        version={find(inForce)}
        number={inForce}
        tone="teal"
      />
    </div>
  );
}

/** Evidence for a flagged result, fetched from the run's results (single) or listed as links (aggregate). */
function FlaggedEvidence({ task }: { task: ReviewTaskOut }) {
  const aggregate = task.payload.aggregate === true;
  const results = useRunResults(
    task.run_id ?? undefined,
    { transcript: task.transcript_code ?? undefined, contract: task.contract_code ?? undefined },
    !aggregate && Boolean(task.run_id),
  );
  if (aggregate) {
    const codes = strList(task.payload.flagged_transcripts);
    return (
      <div>
        <div className="eyebrow mb-1">Flagged transcripts ({codes.length}) — advisory, judged</div>
        <div className="flex flex-wrap gap-1">
          {codes.map((code) => (
            <Link
              key={code}
              to={`/runs/${task.run_id}/transcripts/${encodeURIComponent(code)}`}
              className="hover:no-underline"
            >
              <Chip tone="amber" mono>
                {code}
              </Chip>
            </Link>
          ))}
        </div>
        <KeyValue
          className="mt-2"
          rows={[
            { key: 'Contract', value: str(task.payload.contract ?? task.contract_code) },
            { key: 'Severity', value: str(task.payload.severity) },
            { key: 'Run', value: task.run_id ?? '—' },
          ]}
        />
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
        <EvidenceBlock
          key={r.id}
          result={r}
          transcriptLink={`/runs/${task.run_id}/transcripts/${encodeURIComponent(r.transcript_code)}`}
        />
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
        <Chip tone={tc.status === 'APPROVED' ? 'green' : 'amber'}>{stateLabel(tc.status)}</Chip>
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
        The override becomes a pinned expectation only after someone other than {tc.created_by} approves it.{' '}
        <Link to="/test-cases">Test cases →</Link>
      </div>
    </div>
  );
}

/** The drawer's content for one task. Keyed by task id, so the transition form starts empty for every task. */
function TaskDrawerBody({ task: t }: { task: ReviewTaskOut }) {
  const transition = useReviewTransition(t.id);
  const testCases = useTestCases();
  const { toast } = useToast();
  const [to, setTo] = useState<string>('');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [forceOther, setForceOther] = useState('');

  const target = forceOther || to;
  const needsReason = REASON_REQUIRED_STATES.has(target);
  // The overridden transition writes payload.test_case_id; fall back to matching review_task_id.
  const createdTestCase = useMemo(() => {
    const byId =
      typeof t.payload.test_case_id === 'string'
        ? testCases.data?.find((tc) => tc.id === t.payload.test_case_id)
        : undefined;
    return byId ?? testCases.data?.find((tc) => tc.review_task_id === t.id) ?? null;
  }, [t, testCases.data]);
  const pendingTestCaseId =
    typeof t.payload.test_case_id === 'string' && !createdTestCase ? t.payload.test_case_id : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    transition.mutate(
      { to: target, reason_code: reasonCode || null, note },
      {
        onSuccess: (updated) => {
          const tcId = typeof updated.payload.test_case_id === 'string' ? updated.payload.test_case_id : null;
          toast({
            title: `${updated.id.slice(0, 8)} → ${updated.state}`,
            detail: tcId
              ? `test case ${tcId} created — pending approval by a different user`
              : (updated.reason_code ?? undefined),
            tone: updated.state === 'overridden' ? 'teal' : 'green',
          });
          setTo('');
          setForceOther('');
          setReasonCode('');
          setNote('');
        },
      },
    );
  };

  return (
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
            ...(t.rule_code
              ? [
                  {
                    label: 'Rule',
                    value: `${t.rule_code.toUpperCase()}${t.rule_version !== null ? ` · v${t.rule_version}` : ''}`,
                    mono: true,
                  },
                ]
              : []),
            ...(t.asset_name || t.asset_code
              ? [
                  {
                    label: 'Artifact',
                    value: `${t.asset_name ?? t.asset_code}${t.asset_type ? ` · ${artifactTypeLabel(t.asset_type)}` : ''}`,
                  },
                ]
              : []),
            ...(t.contract_code
              ? [
                  {
                    label: 'Contract',
                    value: `${t.contract_code}${t.transcript_code ? ` × ${t.transcript_code}` : ''}`,
                    mono: true,
                  },
                ]
              : []),
            ...(t.run_id ? [{ label: 'Run', value: t.run_id.slice(0, 8), mono: true }] : []),
            ...(t.staleness_direction
              ? [{ label: 'Direction', value: <DirectionChip direction={t.staleness_direction} /> }]
              : []),
            {
              label: 'Decision',
              value: `${stateLabel(t.state)}${t.reason_code ? ` · ${t.reason_code}` : ''}${t.decided_by ? ` · by ${t.decided_by}` : ''}`,
            },
          ]}
        />
      </div>
      <div>
        <div className="eyebrow mb-1">Subject</div>
        <div className="flex flex-wrap items-center gap-2">
          <TaskSubject t={t} />
          {t.asset_type && <Chip tone="neutral">{artifactTypeLabel(t.asset_type)}</Chip>}
          {t.asset_is_synthetic !== null && <SourceBadge isSynthetic={t.asset_is_synthetic} type={t.asset_type} />}
          {t.staleness_direction && <DirectionChip direction={t.staleness_direction} />}
        </div>
        <p className="mt-2 text-[13px] text-ink">{t.reason}</p>
        <div className="mt-1 flex flex-wrap gap-3 text-[12px]">
          {t.rule_code && (
            <Link
              to={`/rules/${encodeURIComponent(t.rule_code)}${typeof t.payload.as_of === 'string' ? `?as_of=${t.payload.as_of}` : ''}`}
            >
              Rule →
            </Link>
          )}
          {t.asset_code && <Link to={`/artifacts/${encodeURIComponent(t.asset_code)}`}>Artifact →</Link>}
          {t.run_id && <Link to={`/runs/${t.run_id}`}>Run →</Link>}
          {t.run_id && t.transcript_code && t.payload.aggregate !== true && (
            <Link to={`/runs/${t.run_id}/transcripts/${encodeURIComponent(t.transcript_code)}`}>
              Transcript in run →
            </Link>
          )}
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
                {
                  key: 'Proposed for',
                  value: `${str(t.payload.rule ?? t.rule_code)}${t.payload.version !== undefined ? `@v${str(t.payload.version)}` : t.rule_version !== null ? `@v${t.rule_version}` : ''}`,
                },
                {
                  key: 'Detection',
                  value:
                    typeof t.payload.matcher === 'string'
                      ? `matcher ${t.payload.matcher}`
                      : str(t.payload.detection ?? 'llm'),
                },
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
              <span className="font-semibold text-amber-ink">Disputed reading on the path.</span> Verify with counsel
              before republishing; NEEDS_COUNSEL is a valid reason code.
            </div>
          )}
        </div>
      )}

      {t.kind === 'RULE_SOURCE_CHANGED' && (
        <div>
          <div className="eyebrow mb-1">Source change</div>
          <KeyValue
            rows={[
              {
                key: 'Rule',
                value: (
                  <Link to={`/rules/${encodeURIComponent(str(t.payload.rule ?? t.rule_code))}`}>
                    {str(t.payload.rule ?? t.rule_code)}
                  </Link>
                ),
              },
              {
                key: 'Source',
                value:
                  typeof t.payload.source_url === 'string' ? (
                    <a
                      href={t.payload.source_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 break-all"
                    >
                      {t.payload.source_url} <ExternalLink size={11} className="shrink-0" aria-hidden />
                    </a>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'Previous hash',
                value: <span title={str(t.payload.previous_hash)}>{str(t.payload.previous_hash)}</span>,
              },
              {
                key: 'New hash',
                value: (
                  <span className="text-amber-ink" title={str(t.payload.new_hash)}>
                    {str(t.payload.new_hash)}
                  </span>
                ),
              },
            ]}
          />
          {typeof t.payload.excerpt === 'string' && (
            <blockquote className="quote mt-2 text-[12px]">{t.payload.excerpt}</blockquote>
          )}
          <div className="mt-2 border border-hairline bg-band px-3 py-2 text-[12px] text-ink-2">
            <span className="font-semibold text-slate">Verified</span> = a new rule version was added in rules/*.yaml;{' '}
            <span className="font-semibold text-slate">Dismissed</span> = no material change.
          </div>
        </div>
      )}

      {t.kind === 'FLAGGED_RESULT' && <FlaggedEvidence task={t} />}

      {(t.note || t.reason_code || t.decided_by) && (
        <div>
          <div className="eyebrow mb-1">Decision so far</div>
          <KeyValue
            rows={[
              { key: 'Reason code', value: t.reason_code ?? '—' },
              { key: 'Note', value: t.note || '—', mono: false },
              { key: 'Decided by', value: t.decided_by ?? '—' },
              { key: 'Closed', value: fmtTs(t.closed_at) },
            ]}
          />
        </div>
      )}

      {createdTestCase && <TestCaseCard tc={createdTestCase} />}
      {pendingTestCaseId && (
        <div className="border border-teal bg-teal/5 p-3 text-[12px]">
          <span className="eyebrow">Test case created</span> <span className="font-mono">{pendingTestCaseId}</span> —
          pending approval by a different user, expires in 12 months. <Link to="/test-cases">Test cases →</Link>
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
                → {stateLabel(s)}
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
                {t.state === 'verified' && t.kind === 'STALE_ASSET' && (
                  <> Engineers and admins mark an artifact republished once the fix is live.</>
                )}
              </>
            )}
          </div>
        )}
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-ink-3">
            Try a transition the state machine should refuse
          </summary>
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
              <select
                id="rv-reason"
                className="input"
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
                required={needsReason}
              >
                <option value="">—</option>
                {REASON_CODES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Note" htmlFor="rv-note">
              <textarea
                id="rv-note"
                className="input"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What a reviewer six months from now needs to know."
              />
            </Field>
          </div>
        )}
        {transition.error ? <ErrorState error={transition.error} title="Transition refused" className="mt-2" /> : null}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="submit"
            className="btn"
            disabled={!target || transition.isPending || (needsReason && !reasonCode)}
          >
            {transition.isPending ? 'Posting…' : target ? `Apply → ${stateLabel(target)}` : 'Pick a transition'}
          </button>
        </div>
      </form>
      <details>
        <summary className="cursor-pointer text-[11px] text-ink-3">Raw payload</summary>
        <JsonView value={t.payload} collapsedBelow={1} className="mt-1" />
      </details>
    </div>
  );
}

/** One review task in a drawer: its subject, evidence, decision so far, and the transitions the caller may make. */
export function TaskDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const task = useReviewTask(taskId ?? undefined);
  const t = task.data;
  return (
    <Drawer
      open={taskId !== null}
      onClose={onClose}
      title={t ? `${kindLabel(t.kind)} · ${t.id.slice(0, 8)}` : 'Review task'}
      subtitle={
        t ? (
          <span className="inline-flex items-center gap-2">
            <Chip tone={stateTone(t.state)}>{stateLabel(t.state)}</Chip> assigned to{' '}
            <span title={t.assignee_role}>{roleLabel(t.assignee_role)}</span> · opened {fmtTs(t.opened_at)}
          </span>
        ) : null
      }
      width={640}
    >
      {task.isLoading && <LoadingState rows={4} />}
      {task.error && !task.data ? <ErrorState error={task.error} retry={() => void task.refetch()} /> : null}
      {t && <TaskDrawerBody key={taskId} task={t} />}
    </Drawer>
  );
}
