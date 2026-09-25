import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { CircleSlash, History, Pencil, Play, ScanText, Square } from 'lucide-react';
import { useRuns, useSandboxSamples, useSandboxTranscript } from '../../api/hooks';
import type { JsonObject, SandboxProductLine, SandboxTranscriptOut } from '../../api/types';
import { cn } from '../../lib/cn';
import { isSubmitChord, modKeyLabel } from '../../lib/palette';
import { usePrefersReducedMotion } from '../../lib/motion';
import { splitTranscript } from '../../lib/transcript';
import { outcomeTone, severityTone } from '../../lib/vocab';
import { TRANSCRIPT_LIMIT, extractionOf, refusalCopy, routeOf, transcriptSpans } from '../../lib/sandbox';
import { paramValue } from '../../lib/keyvalue';
import { Chip } from '../ui/Chip';
import { HighlightedText } from '../ui/HighlightedText';
import { KeyValue } from '../ui/KeyValue';
import { ModelId } from '../runs/ModelId';
import { PrivacyLine, RedactionTally, RefusalNote } from './SandboxNotes';
import { useElapsedSeconds, useLiveBusy } from './useSandboxTimers';

const PRODUCT_LINES: SandboxProductLine[] = ['MA', 'PDP', 'MEDIGAP', 'LIFE'];

const STAGES = ['Redact identifiers', 'Extract with the local model', 'Score the 7 contracts', 'Route: PASS / FLAG / BLOCK'];

/** The fields worth reading first; everything else stays in the raw output. */
const EXTRACTION_KEYS = [
  'product_line',
  'carrier',
  'disclaimer_delivered',
  'disclaimer_seconds',
  'benefits_started_seconds',
  'disclaimer_compliant',
  'disclaimer_basis',
  'soa_collected',
  'appointment_scheduled',
  'soa_wait_compliant',
  'superlatives',
  'numeric_claims',
  'pii_detected',
];

function Progress({ seconds, onCancel }: { seconds: number; onCancel: () => void }) {
  // a stage per ~12 s is a guide for the eye, not a measurement; the last stage holds
  const stage = Math.min(STAGES.length - 1, 1 + Math.floor(seconds / 12));
  return (
    <div className="card accent-card px-4 py-4" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="pulse-dot bg-teal-ink" />
          <span className="text-[14px] font-semibold text-ink">Running the call through the local model</span>
          <span className="font-mono text-[13px] tabular-nums text-teal-ink" data-testid="elapsed">
            {seconds} s
          </span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          <Square size={11} aria-hidden /> Cancel
        </button>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-2">A local 7B model usually takes 10–60 seconds per call. Nothing is stored while you wait.</p>
      <ol className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px]" aria-label="Stages">
        {STAGES.map((s, i) => (
          <li key={s} className={cn('inline-flex items-center gap-1.5', i < stage ? 'text-green-ink' : i === stage ? 'font-semibold text-ink' : 'text-ink-3')}>
            <span aria-hidden className={cn('inline-block h-1.5 w-1.5 rounded-full', i < stage ? 'bg-green-ink' : i === stage ? 'bg-teal-ink' : 'bg-input')} />
            {s}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 409: the model is simply not running. Calm, and it points at what still works. */
function OfflineCard({ detail, recordedHref, onUseArtifact }: { detail: string; recordedHref: string | null; onUseArtifact: () => void }) {
  return (
    <div className="card px-5 py-4" role="status">
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-band text-slate">
          <CircleSlash size={16} />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-ink">The live model is offline right now</div>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-2">
            This check sends the call to a model running on the presenter&apos;s own machine (Ollama), so no call text leaves it. That machine isn&apos;t answering at the moment. Nothing about the prototype depends on it: recorded runs from real models still replay, and the artifact check needs no model at all.
          </p>
          {detail && <p className="mt-1 font-mono text-[11.5px] text-ink-3">{detail}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {recordedHref && (
              <Link to={recordedHref} className="btn btn-outline btn-sm hover:no-underline">
                <History size={12} aria-hidden /> Open a recorded real-model call
              </Link>
            )}
            <button type="button" className="btn btn-sm" onClick={onUseArtifact}>
              <ScanText size={12} aria-hidden /> Use the artifact check instead
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function isRecord(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** NEEDS_LABEL rows carry the model's own answer: "disclaimer_compliant no · disclaimer_seconds 92". */
function modelSays(evidence: JsonObject | null | undefined): string | null {
  const says = evidence && isRecord(evidence.model_says) ? evidence.model_says : null;
  if (!says) return null;
  const parts = Object.entries(says)
    .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k} ${typeof v === 'boolean' ? (v ? 'yes' : 'no') : paramValue(v)}`);
  return parts.length ? parts.join(' · ') : null;
}

/** A graded row with no sentence: its evidence, flattened to one line. */
function evidenceLine(evidence: JsonObject | null | undefined): string | null {
  if (!evidence) return null;
  const parts = Object.entries(evidence).map(([k, v]) => `${k} ${paramValue(v)}`);
  return parts.length ? parts.join(' · ') : null;
}

function valueCell(v: unknown) {
  if (typeof v === 'boolean') return <Chip tone={v ? 'green' : 'neutral'}>{v ? 'yes' : 'no'}</Chip>;
  if (Array.isArray(v) && v.length === 0) return <span className="text-ink-3">none</span>;
  return paramValue(v);
}

function Result({ out, text }: { out: SandboxTranscriptOut; text: string }) {
  const spans = useMemo(() => transcriptSpans(out, text), [out, text]);
  const lines = useMemo(() => splitTranscript(text, spans), [text, spans]);
  const extraction = extractionOf(out);
  const route = routeOf(out);
  const needsLabel = out.contracts.filter((c) => c.outcome === 'NEEDS_LABEL');
  const unverified = spans.filter((s) => !s.verified);
  const rows = extraction
    ? EXTRACTION_KEYS.filter((k) => k in extraction).map((k) => ({ key: k, value: valueCell((extraction as JsonObject)[k]), mono: typeof (extraction as JsonObject)[k] !== 'boolean' }))
    : [];
  return (
    <section aria-label="Transcript result" className="space-y-3">
      <div className="card card-hero flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
        {route && (
          <span className="inline-flex items-center gap-2 text-[13px] text-ink-2">
            route <Chip filled tone={route === 'BLOCK' ? 'red' : route === 'FLAG' ? 'amber' : 'green'}>{route}</Chip>
          </span>
        )}
        <span className="text-[12.5px] text-ink-2">
          model <ModelId id={out.model_id} />
        </span>
        <span className="font-mono text-[12px] text-ink-2">{(out.latency_ms / 1000).toFixed(1)} s</span>
        <span className="font-mono text-[12px] text-ink-2">
          {spans.length} spans cited · {unverified.length} not found
        </span>
        <RedactionTally counts={out.redacted} className="basis-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="card min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-2">
            <span className="eyebrow">Your call</span>
            <span className="flex items-center gap-2 text-[11px] text-ink-2">
              <span className="mark-span px-1">verified span</span>
              <span className="mark-span-unverified px-1">not found</span>
            </span>
          </div>
          <div className="max-h-[56vh] overflow-y-auto px-4 py-3 font-mono text-[12.5px] leading-[1.7]">
            {lines.map((ln, i) => (
              <div key={i} className="flex gap-2">
                {ln.prefix && <span className="shrink-0 select-none text-ink-3">{ln.prefix}</span>}
                <span className={cn(ln.speaker === 'AGENT' ? 'text-ink' : 'text-slate')}>
                  <HighlightedText text={ln.body} spans={ln.spans} />
                </span>
              </div>
            ))}
            {unverified.filter((s) => s.offset < 0).map((s) => (
              <div key={s.label} className="mt-2 text-[12px]">
                <Chip tone="red" mono>
                  {s.label}
                </Chip>{' '}
                <span className="mark-span-unverified">{s.text}</span> — cited by the model, not found in the call
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0 space-y-3">
          <div className="card">
            <div className="border-b border-hairline px-4 py-2">
              <span className="eyebrow">Contracts</span>
            </div>
            <ul className="divide-y divide-hairline">
              {out.contracts.map((c) => (
                <li key={c.code} className="grid grid-cols-[84px_minmax(0,1fr)] gap-3 px-4 py-2">
                  <span className="pt-0.5">
                    <Chip tone={c.outcome === 'NEEDS_LABEL' ? 'slate' : outcomeTone(c.outcome)} size="xs">
                      {c.outcome === 'NEEDS_LABEL' ? 'needs label' : c.outcome}
                    </Chip>
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-[12px] font-semibold text-ink">{c.code}</span>
                      <span className="text-[12.5px] text-ink">{c.title}</span>
                      <Chip tone={severityTone(c.severity)} size="xs">
                        {c.severity}
                      </Chip>
                    </span>
                    {c.outcome === 'NEEDS_LABEL' ? (
                      modelSays(c.evidence) && (
                        <span className="mt-0.5 block font-mono text-[11.5px] leading-snug text-ink-2" title={c.why ?? undefined}>
                          model says {modelSays(c.evidence)}
                        </span>
                      )
                    ) : c.why ? (
                      <span className="mt-0.5 block text-[12px] leading-snug text-ink-2">{c.why}</span>
                    ) : (
                      evidenceLine(c.evidence) && (
                        <span className="mt-0.5 block truncate font-mono text-[11.5px] text-ink-3" title={evidenceLine(c.evidence) ?? undefined}>
                          {evidenceLine(c.evidence)}
                        </span>
                      )
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {needsLabel.length > 0 && (
              <div className="border-t border-hairline bg-band px-4 py-2.5 text-[12.5px] leading-relaxed text-ink-2" role="note">
                <span className="font-semibold text-ink">Why {needsLabel.length} say “needs label”:</span> rule verdicts compare the model against a labelled call. A pasted call has no label yet — that&apos;s the QA sample you&apos;d add. Grounding checks (spans, numbers, PII, schema) need no label and ran above.
              </div>
            )}
          </div>
          {rows.length > 0 && (
            <div className="card">
              <div className="border-b border-hairline px-4 py-2">
                <span className="eyebrow">What the model extracted</span>
              </div>
              <div className="px-4 py-2">
                <KeyValue rows={rows} />
              </div>
            </div>
          )}
        </div>
      </div>
      {out.note ? <p className="text-[12px] leading-relaxed text-ink-2">{out.note}</p> : <PrivacyLine />}
    </section>
  );
}

/**
 * Tab two of /try: one pasted call through the real workflow on a local
 * model. It can take a minute, so it shows elapsed time and can be
 * cancelled; with no model reachable (409) it says so calmly and points at
 * what still works.
 */
export function TranscriptCheck({ onUseArtifact }: { onUseArtifact: () => void }) {
  const samples = useSandboxSamples();
  const runs = useRuns();
  const run = useSandboxTranscript();
  const [text, setText] = useState('');
  const [productLine, setProductLine] = useState<SandboxProductLine>('MA');
  const [result, setResult] = useState<{ out: SandboxTranscriptOut; text: string } | null>(null);
  const [editing, setEditing] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const seconds = useElapsedSeconds(run.isPending);
  const areaId = useId();
  const plId = useId();
  const mod = modKeyLabel();
  useLiveBusy(run.isPending);
  useEffect(() => () => abortRef.current?.abort(), []);

  // A recorded real-model run to fall back on: the newest cassette/live run.
  const recordedHref = useMemo(() => {
    const real = [...(runs.data ?? [])].filter((r) => r.adapter === 'cassette' || r.adapter === 'live').sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
    return real ? `/runs/${real.id}` : null;
  }, [runs.data]);

  const start = (body?: { text: string }) => {
    const t = body?.text ?? text;
    if (!t.trim() || t.length > TRANSCRIPT_LIMIT || run.isPending) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    run.mutate(
      { text: t, product_line: productLine, signal: ctrl.signal },
      {
        onSuccess: (out) => {
          // a cancelled request may still resolve (the server cannot be stopped mid-call); ignore it
          if (!ctrl.signal.aborted) {
            setResult({ out, text: t });
            setEditing(false);
          }
        },
      },
    );
  };
  const cancel = () => {
    abortRef.current?.abort();
    run.reset();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (isSubmitChord(e)) {
      e.preventDefault();
      start();
    }
  };

  const refusal = run.error ? refusalCopy(run.error, TRANSCRIPT_LIMIT) : null;
  const tooLong = text.length > TRANSCRIPT_LIMIT;
  // the answer (offline card, refusal, progress) lands below a tall paste box: bring it into view
  const outcomeRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const hasOutcome = run.isPending || Boolean(run.error);
  useEffect(() => {
    if (hasOutcome) outcomeRef.current?.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [hasOutcome, reduced]);

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          start();
        }}
        onKeyDown={onKeyDown}
        aria-label="Call transcript check"
        className="space-y-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium text-ink-2">Try a sample:</span>
          {samples.data?.transcripts.map((s) => (
            <button
              key={s.label}
              type="button"
              title={s.label}
              className="inline-block h-7 max-w-full truncate rounded-full border border-hairline bg-surface px-3 text-[12px] leading-[26px] font-medium text-slate transition-colors hover:border-teal hover:text-teal-ink sm:max-w-[340px]"
              onClick={() => {
                setText(s.text);
                setEditing(true);
              }}
            >
              {s.label}
            </button>
          ))}
          {samples.error && <span className="text-[12px] text-ink-3">samples unavailable — paste your own call</span>}
        </div>
        {(editing || !result) && (
          <div>
            <label htmlFor={areaId} className="sr-only">
              Call transcript
            </label>
            <textarea
              id={areaId}
              className={cn('input min-h-[220px] font-mono text-[12.5px] leading-[1.65]', tooLong && 'border-red')}
              placeholder={'[00:04] AGENT: Thanks for calling…\n[00:19] CUSTOMER: …\n\nOne "[mm:ss] SPEAKER:" line per turn works best.'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
            />
            <div className={cn('mt-1 text-right font-mono text-[11px]', tooLong ? 'text-red' : 'text-ink-3')}>
              {text.length.toLocaleString('en-US')} / {TRANSCRIPT_LIMIT.toLocaleString('en-US')}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="w-[180px]">
            <label htmlFor={plId} className="label">
              Product line
            </label>
            <select id={plId} className="input" value={productLine} onChange={(e) => setProductLine(e.target.value as SandboxProductLine)}>
              {PRODUCT_LINES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <p className="max-w-md text-[12px] leading-snug text-ink-2">Runs the real workflow once — extract → 7 contracts → route — on a local model. 10–60 seconds.</p>
          {!editing && result && (
            <button type="button" className="btn btn-ghost ml-auto" onClick={() => setEditing(true)}>
              <Pencil size={13} aria-hidden /> Edit call
            </button>
          )}
          <button type="submit" className={cn('btn', (editing || !result) && 'ml-auto')} disabled={!text.trim() || tooLong || run.isPending} aria-keyshortcuts="Control+Enter Meta+Enter">
            <Play size={13} aria-hidden /> Run on local model
            <kbd className="kbd ml-1 hidden sm:inline-flex">{mod} ↵</kbd>
          </button>
        </div>
        <PrivacyLine />
      </form>

      <div ref={outcomeRef} className="scroll-mb-6">
        {run.isPending && <Progress seconds={seconds} onCancel={cancel} />}
        {refusal && !run.isPending &&
          (refusal.offline ? (
            <OfflineCard detail={refusal.detail} recordedHref={recordedHref} onUseArtifact={onUseArtifact} />
          ) : (
            <RefusalNote error={run.error} limit={TRANSCRIPT_LIMIT} retry={() => start()} />
          ))}
      </div>
      <div aria-live="polite" className="sr-only">
        {result && !run.isPending ? `Transcript checked: route ${routeOf(result.out) ?? 'unknown'}, ${result.out.contracts.length} contracts scored.` : ''}
      </div>
      {result && !run.isPending && !refusal && <Result out={result.out} text={result.text} />}
    </div>
  );
}
