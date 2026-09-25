import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useRun, useRunTranscript } from '../api/hooks';
import type { JsonObject } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader } from '../components/layout/Page';
import { HighlightedText } from '../components/ui/HighlightedText';
import { JsonView } from '../components/ui/JsonView';
import { KeyValue } from '../components/ui/KeyValue';
import { Chip } from '../components/ui/Chip';
import { GateChip } from '../components/runs/GateChip';
import { EvidenceBlock } from '../components/evidence/EvidenceBlock';
import { RunFacts } from '../components/runs/RunFacts';
import { TranscriptBadge } from '../components/artifacts/SourceBadge';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { isObject, RULE_DEPENDENT_KEYS, str, strList } from '../lib/evidence';
import { splitTranscript } from '../lib/transcript';
import { cn } from '../lib/cn';

/**
 * How a real model's answer was obtained: tokens, mode (tool | json), the attempts it
 * took, and whether it is a replay. Simulated outputs have none of this.
 */
function usageLine(usage: Record<string, unknown> | null | undefined): string {
  if (!usage || typeof usage !== 'object') return '';
  const parts: string[] = [];
  const tin = usage.input_tokens;
  const tout = usage.output_tokens;
  if (typeof tin === 'number' && typeof tout === 'number') parts.push(`${tin.toLocaleString()} / ${tout.toLocaleString()} tokens`);
  if (typeof usage.mode === 'string') parts.push(`mode ${usage.mode}`);
  if (Array.isArray(usage.attempts) && usage.attempts.length > 1) parts.push(`attempts ${usage.attempts.join(' → ')}`);
  if (usage.cassette === true) parts.push(typeof usage.recorded_at === 'string' ? `replayed (recorded ${usage.recorded_at})` : 'replayed');
  return parts.join(' · ');
}

type Tab = 'extraction' | 'composition' | 'contracts' | 'judge';

function JudgmentCard({ label, ok, basis, detail }: { label: string; ok: boolean | null; basis?: string; detail?: string }) {
  return (
    <div className={cn('border px-3 py-2', ok === false ? 'border-amber' : 'border-hairline')}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] font-semibold text-navy">{label}</span>
        <Chip tone={ok === false ? 'amber' : ok === true ? 'green' : 'neutral'}>{ok === false ? 'violation' : ok === true ? 'compliant' : 'n/a'}</Chip>
      </div>
      {basis && (
        <div className="mt-1 text-[12px] text-ink-2">
          basis <span className="font-mono text-ink">{basis}</span>
        </div>
      )}
      {detail && <div className="mt-0.5 text-[12px] text-ink-2">{detail}</div>}
    </div>
  );
}

/** The rule-dependent judgments in the extraction object, by their real keys. */
function RuleDependentJudgments({ extraction }: { extraction: JsonObject }) {
  const present = RULE_DEPENDENT_KEYS.filter((k) => k in extraction);
  if (!present.length) return <EmptyState title="No rule-dependent judgments in this extraction" className="py-3" />;
  const superlatives = Array.isArray(extraction.superlatives) ? extraction.superlatives : [];
  const flagged = superlatives.filter((s) => isObject(s) && s.flagged === true);
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      {'disclaimer_compliant' in extraction && (
        <JudgmentCard
          label="disclaimer_compliant"
          ok={typeof extraction.disclaimer_compliant === 'boolean' ? extraction.disclaimer_compliant : null}
          basis={typeof extraction.disclaimer_basis === 'string' ? extraction.disclaimer_basis : undefined}
          detail={`delivered ${str(extraction.disclaimer_delivered)} · at ${str(extraction.disclaimer_seconds)}s · benefits at ${str(extraction.benefits_started_seconds)}s`}
        />
      )}
      {'soa_wait_compliant' in extraction && (
        <JudgmentCard
          label="soa_wait_compliant"
          ok={typeof extraction.soa_wait_compliant === 'boolean' ? extraction.soa_wait_compliant : null}
          basis={`appointment ${str(extraction.appointment_hours_after_soa)}h after SOA · exception ${str(extraction.soa_exception)}`}
          detail={`SOA collected ${str(extraction.soa_collected)} · appointment scheduled ${str(extraction.appointment_scheduled)}`}
        />
      )}
      {'superlatives' in extraction && (
        <JudgmentCard
          label="superlatives"
          ok={superlatives.length === 0 ? true : flagged.length === 0 ? true : false}
          basis={superlatives.length ? `${superlatives.length} found · ${flagged.length} flagged` : 'none on the call'}
          detail={superlatives.length ? superlatives.map((s) => (isObject(s) ? `"${str(s.text)}"${s.flagged === true ? ' (flagged)' : ''}` : str(s))).join(' · ') : undefined}
        />
      )}
    </div>
  );
}

export function RunTranscriptPage() {
  const { id = '', code = '' } = useParams();
  const run = useRun(id);
  const rt = useRunTranscript(id, code);
  const [tab, setTab] = useState<Tab>('extraction');

  useTopBar([{ label: 'Runs', to: '/runs' }, { label: id.slice(0, 8), to: `/runs/${id}` }, { label: code }], run.data?.rule_date ?? null);

  const lines = useMemo(() => (rt.data?.transcript.text ? splitTranscript(rt.data.transcript.text, rt.data.spans) : []), [rt.data]);

  if (rt.isLoading) return <LoadingState className="p-6" rows={6} />;
  if (rt.error && !rt.data) {
    return (
      <div className="p-6">
        <ErrorState error={rt.error} title={`Could not load ${code} for ${id.slice(0, 8)}`} retry={() => void rt.refetch()} />
      </div>
    );
  }
  if (!rt.data) return null;
  const d = rt.data;
  const extraction = isObject(d.output.extraction) ? d.output.extraction : null;
  const composition = isObject(d.output.composition) ? d.output.composition : null;
  const judged = d.results.filter((r) => Array.isArray(r.evidence.scores));
  const bad = d.results.filter((r) => r.outcome !== 'PASS').length;
  const unverified = d.spans.filter((s) => !s.verified);
  const notLocated = unverified.filter((s) => s.offset < 0);

  const TABS: Array<[Tab, string, number | null]> = [
    ['extraction', 'Extraction', null],
    ['composition', 'Composition', null],
    ['contracts', 'Contracts', bad],
    ['judge', 'Judge', judged.filter((r) => r.outcome !== 'PASS').length],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        eyebrow={`Transcript · ${d.transcript.product_line} · ${Math.round(d.transcript.duration_seconds / 60)} min`}
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            <span className="font-mono">{code}</span>
            <TranscriptBadge synthetic={d.transcript.synthetic} labels={d.transcript.labels} />
            <Chip tone={d.route === 'BLOCK' ? 'red' : d.route === 'FLAG' ? 'amber' : 'green'}>route {d.route}</Chip>
            {run.data && <GateChip gate={run.data.gate} />}
          </span>
        }
        description={
          <>
            <Link to={`/runs/${id}`} className="font-mono" title={id}>
              {id.slice(0, 8)}
            </Link>{' '}
            · prompt v{run.data?.prompt_version ?? '?'} · {run.data?.model_id ?? ''} · rule date <span className="font-mono">{run.data?.rule_date ?? ''}</span> · latency {d.latency_ms} ms
            {usageLine(d.usage) && <span className="font-mono text-[12px]"> · {usageLine(d.usage)}</span>}
            {d.error && <span className="ml-2 text-red">· {d.error}</span>}
            {run.data && <RunFacts run={run.data} className="mt-1" />}
          </>
        }
      />

      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 content-start overflow-y-auto border-t border-hairline xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-h-0 border-r border-hairline">
          <div className="flex items-center justify-between border-b border-hairline bg-band px-4 py-2">
            <span className="eyebrow">Transcript</span>
            <span className="flex items-center gap-2 text-[11px] text-ink-2">
              <span className="mark-span px-1">verified span</span>
              <span className="mark-span-unverified px-1">unverified</span>
              <span className="font-mono">
                {d.spans.length} cited · {unverified.length} not found
              </span>
            </span>
          </div>
          <div className="max-h-[50vh] overflow-y-auto px-4 py-3 font-mono text-[12.5px] leading-[1.7] xl:max-h-[calc(100vh-280px)]">
            {lines.map((ln, i) => (
              <div key={i} className="flex gap-2">
                {ln.prefix && <span className="shrink-0 select-none text-ink-3">{ln.prefix}</span>}
                <span className={cn(ln.speaker === 'AGENT' ? 'text-ink' : 'text-slate')}>
                  <HighlightedText text={ln.body} spans={ln.spans} />
                </span>
              </div>
            ))}
            {notLocated.length > 0 && (
              <div className="mt-3 border border-red px-3 py-2 text-[12px]">
                <div className="mb-1 font-sans font-semibold text-red">Cited by the model but not found in the transcript</div>
                <ul className="space-y-1">
                  {notLocated.map((s, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      <Chip tone="red" mono>
                        {s.label}
                      </Chip>
                      <span className="mark-span-unverified">{s.text}</span>
                      <span className="inline-flex h-4 items-center border border-red px-1 font-sans text-[10px] font-semibold uppercase tracking-[0.5px] text-red">not found in transcript</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <div className="min-h-0">
          <div role="tablist" aria-label="Workflow output" className="flex border-b border-hairline bg-band px-2">
            {TABS.map(([key, label, count]) => (
              <button key={key} role="tab" type="button" aria-selected={tab === key} className="tab" onClick={() => setTab(key)}>
                {label}
                {count !== null && count > 0 && <span className="ml-1 font-mono text-[11px] text-red">{count}</span>}
              </button>
            ))}
          </div>
          <div className="max-h-[calc(100vh-280px)] overflow-y-auto px-4 py-3" role="tabpanel">
            {tab === 'extraction' &&
              (extraction ? (
                <>
                  <div className="eyebrow mb-2">Rule-dependent judgments</div>
                  <div className="mb-3">
                    <RuleDependentJudgments extraction={extraction} />
                  </div>
                  {Array.isArray(extraction.numeric_claims) && extraction.numeric_claims.length > 0 && (
                    <>
                      <div className="eyebrow mb-1">Numeric claims</div>
                      <div className="mb-3 flex flex-wrap gap-1.5">
                        {extraction.numeric_claims.map((c, i) => (
                          <Chip key={i} tone="neutral" mono title={isObject(c) ? str(c.context) : undefined}>
                            {isObject(c) ? `${str(c.value)} · ${str(c.context)}` : str(c)}
                          </Chip>
                        ))}
                      </div>
                    </>
                  )}
                  {Array.isArray(extraction.pii_detected) && (
                    <div className="mb-3 text-[12px] text-ink-2">
                      PII detected: {strList(extraction.pii_detected).length ? strList(extraction.pii_detected).map((p) => <Chip key={p} tone="amber" className="ml-1">{p}</Chip>) : <span className="text-green-ink">none</span>}
                    </div>
                  )}
                  <div className="eyebrow mb-1">Extraction JSON</div>
                  <JsonView value={extraction} collapsedBelow={3} highlightKeys={new Set(RULE_DEPENDENT_KEYS)} />
                </>
              ) : (
                <EmptyState title="No extraction" hint={d.error ?? 'The workflow produced no extraction object.'} />
              ))}
            {tab === 'composition' &&
              (composition ? (
                <div className="space-y-3">
                  <div>
                    <div className="eyebrow mb-1">Summary</div>
                    <p className="text-[13px] leading-relaxed">{str(composition.summary)}</p>
                  </div>
                  <div>
                    <div className="eyebrow mb-1">Coaching note</div>
                    <blockquote className="quote">{str(composition.coaching_note)}</blockquote>
                  </div>
                  <div>
                    <div className="eyebrow mb-1">CRM record</div>
                    {isObject(composition.crm_record) ? <KeyValue rows={Object.entries(composition.crm_record).map(([k, v]) => ({ key: k, value: str(v), mono: true }))} /> : <JsonView value={composition.crm_record} />}
                  </div>
                </div>
              ) : (
                <EmptyState title="No composition" hint={d.error ?? 'The workflow produced no composition object.'} />
              ))}
            {tab === 'contracts' && (
              <div className="space-y-2">
                {[...d.results]
                  .sort((a, b) => (a.outcome === 'PASS' ? 1 : 0) - (b.outcome === 'PASS' ? 1 : 0))
                  .map((r) => (
                    <EvidenceBlock key={r.id} result={r} />
                  ))}
                {d.results.length === 0 && <EmptyState title="No contract results" />}
              </div>
            )}
            {tab === 'judge' && (
              <div className="space-y-3">
                {judged.length === 0 && <EmptyState title="No judged contracts on this transcript" />}
                {judged.map((r) => (
                  <EvidenceBlock key={r.id} result={r} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
