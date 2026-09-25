import { useCallback, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCopy, Pencil, ScanText } from 'lucide-react';
import { useRules, useSandboxArtifact, useSandboxSamples } from '../../api/hooks';
import type { RuleOut, SandboxArtifactOut, SandboxMatch } from '../../api/types';
import { cn } from '../../lib/cn';
import { fmtDate, shortHash } from '../../lib/format';
import { isSubmitChord, modKeyLabel } from '../../lib/palette';
import { usePrefersReducedMotion } from '../../lib/motion';
import {
  ARTIFACT_LIMIT,
  HIGHLIGHT_CLASS,
  findingsMarkdown,
  matchTone,
  pieces,
  placeMatches,
  redactionLine,
  verdictLabel,
  verdictTone,
  worstTone,
  type PlacedMatch,
} from '../../lib/sandbox';
import { Chip } from '../ui/Chip';
import { DirectionChip } from '../rules/DirectionChip';
import { DateAsOfControl } from '../rules/DateAsOfControl';
import { useToast } from '../ui/useToast';
import { useLiveBusy } from './useSandboxTimers';
import { PrivacyLine, RedactionTally, RefusalNote } from './SandboxNotes';
import { latestGoverning } from '../../lib/ruleVersions';

const QUICK_DATES = ['2026-09-30', '2026-10-01'];

/** The finding card's left edge carries its verdict colour (the chip says it in words). */
const EDGE: Record<ReturnType<typeof matchTone>, string> = {
  under: 'border-l-red hover:border-l-red',
  over: 'border-l-amber hover:border-l-amber',
  reverify: 'border-l-slate hover:border-l-slate',
  current: 'border-l-green-ink hover:border-l-green-ink',
  neutral: 'border-l-teal-ink hover:border-l-teal-ink',
};

/** "Scope of Appointment — 48-hour waiting period …" → "Scope of Appointment". */
function headOf(title: string): string {
  const i = title.indexOf(' — ');
  return i > 0 ? title.slice(0, i) : title;
}

/** Before the first check: what the sandbox looks for, so the right column is never empty. */
function WhatItChecks({ rules }: { rules: RuleOut[] | undefined }) {
  return (
    <div className="card px-4 py-3">
      <div className="eyebrow mb-1">What it looks for</div>
      <p className="text-[12.5px] leading-relaxed text-ink-2">
        Phrasing that encodes one of the {rules?.length ?? 13} versioned rules — a 48-hour wait, a first-minute disclaimer, a 10-year retention. Each hit is judged against the version in force on your date.
      </p>
      {rules && (
        <ul className="mt-2.5 divide-y divide-hairline border-t border-hairline">
          {rules.map((r) => {
            const latest = latestGoverning(r);
            return (
              <li key={r.code} className="flex items-baseline justify-between gap-3 py-1.5 text-[12.5px]">
                {/* The full title: short heads collide ("TPMO disclaimer" is two different rules). */}
                <Link to={`/rules/${encodeURIComponent(r.code)}`} className="min-w-0 leading-snug text-ink hover:text-teal-ink" title={r.code}>
                  {r.title}
                </Link>
                {latest && <span className="shrink-0 font-mono text-[11px] text-ink-3">v{latest.version} · {latest.effective_from}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Finding({
  placed,
  active,
  onSelect,
  onHover,
  asOf,
}: {
  placed: PlacedMatch;
  active: boolean;
  onSelect: () => void;
  onHover: (on: boolean) => void;
  asOf: string;
}) {
  const m: SandboxMatch = placed.match;
  const tone = matchTone(m);
  return (
    <li
      id={`finding-${placed.index}`}
      tabIndex={-1}
      className={cn(
        'card cursor-pointer border-l-[3px] px-3.5 py-3 outline-none hover:border-input',
        EDGE[tone],
        active && 'border-teal-ink shadow-[0_0_0_1px_var(--color-teal-ink)] hover:border-teal-ink',
      )}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      aria-current={active ? 'true' : undefined}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {m.verdict === 'stale' ? (
          <>
            <Chip tone="neutral">stale</Chip>
            <DirectionChip direction={m.direction ?? 'reverify'} />
          </>
        ) : (
          <Chip tone={verdictTone(m)}>{verdictLabel(m)}</Chip>
        )}
        {m.disputed && <Chip tone="amber">disputed</Chip>}
        {m.edge_status === 'proposed' && (
          <Chip tone="neutral" title={`matcher ${m.matcher} · confidence ${m.confidence ?? '—'}`}>
            needs a human read
          </Chip>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <Link
          to={`/rules/${encodeURIComponent(m.rule_code)}?as_of=${asOf}`}
          className="shrink-0 font-mono text-[12px] font-semibold"
          onClick={(e) => e.stopPropagation()}
        >
          {m.rule_code}
        </Link>
        <span className="min-w-0 truncate text-[12.5px] text-ink" title={m.rule_title}>
          {headOf(m.rule_title)}
        </span>
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-ink-3 [overflow-wrap:anywhere]">{m.citation}</div>
      <div className="mt-1.5 font-mono text-[11.5px] text-slate">
        encodes v{m.bound_version} → in force {m.in_force_version === null ? 'none' : `v${m.in_force_version}`}
      </div>
      {m.reason && <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{m.reason}</p>}
      {(m.applies_from || m.regulation_effective) && (
        <div className="mt-1.5 text-[11.5px] text-ink-3">
          {m.applies_from && <>applies from {fmtDate(m.applies_from)}</>}
          {m.regulation_effective && m.regulation_effective !== m.applies_from && <> · regulation effective {fmtDate(m.regulation_effective)}</>}
        </div>
      )}
      {placed.at < 0 && (
        <blockquote className="quote mt-2 text-[12px]" title="This span contains redacted text, so it cannot be painted onto what you pasted">
          {m.span}
        </blockquote>
      )}
    </li>
  );
}

function Summary({ result, onCopy }: { result: SandboxArtifactOut; onCopy: () => void }) {
  const s = result.summary;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="inline-flex items-baseline gap-1.5">
          <span className="stat text-[22px] text-ink">{s.matches}</span>
          <span className="text-[13px] text-ink-2">{s.matches === 1 ? 'match' : 'matches'}</span>
        </span>
        <span className="inline-flex items-baseline gap-1.5">
          <span className={cn('stat text-[22px]', s.stale ? 'text-amber-ink' : 'text-green-ink')}>{s.stale}</span>
          <span className="text-[13px] text-ink-2">stale</span>
        </span>
        <span className="inline-flex items-baseline gap-1.5">
          <span className="stat text-[22px] text-ink">{s.rules_touched}</span>
          <span className="text-[13px] text-ink-2">{s.rules_touched === 1 ? 'rule' : 'rules'} touched</span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {s.under_restrictive > 0 && <Chip tone="red">{s.under_restrictive} under-restrictive</Chip>}
          {s.over_restrictive > 0 && <Chip tone="amber">{s.over_restrictive} over-restrictive</Chip>}
          {s.reverify > 0 && <Chip tone="slate">{s.reverify} re-verify</Chip>}
          {s.current > 0 && <Chip tone="green">{s.current} current</Chip>}
          {(s.needs_review ?? 0) > 0 && (
            <Chip tone="slate" title="Proposed readings are not counted as stale until a human confirms them">
              {s.needs_review} needs a human read
            </Chip>
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="teal" mono title="Evaluation date">
          as of {result.as_of}
        </Chip>
        <span className="font-mono text-[11px] text-ink-3" title={`SHA-256 of the text as pasted: ${result.text_sha256}`}>
          sha256 {shortHash(result.text_sha256, 10)}
        </span>
        {s.matches > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCopy}>
            <ClipboardCopy size={12} aria-hidden /> Copy findings as Markdown
          </button>
        )}
      </div>
      <RedactionTally counts={result.redacted} className="basis-full" />
    </div>
  );
}

/**
 * The hero of /try: paste any script, page, email or prompt; Backstop's
 * deterministic matchers find text that encodes a versioned rule and say,
 * for the chosen date, whether that encoding is current or stale — and in
 * which direction. Nothing is stored.
 */
const STORY_DATE = '2026-10-01';

export function ArtifactCheck({ today }: { today: string }) {
  const samples = useSandboxSamples();
  const rules = useRules();
  const check = useSandboxArtifact();
  const { toast } = useToast();
  const reduced = usePrefersReducedMotion();
  const [text, setText] = useState('');
  // Default to the date the CY2027 marketing changes apply: checking "as of today"
  // (before Oct 1) would call a soon-to-be-stale line current and hide the point.
  const [asOf, setAsOf] = useState(STORY_DATE);
  const [label, setLabel] = useState('');
  const [result, setResult] = useState<{ out: SandboxArtifactOut; text: string; label: string } | null>(null);
  const [editing, setEditing] = useState(true);
  const [active, setActive] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [runSeq, setRunSeq] = useState(0);
  const textRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const textareaId = useId();
  const labelId = useId();
  const mod = modKeyLabel();
  useLiveBusy(check.isPending);

  void today; // kept in the signature for callers; the story date is the default

  const analyze = useCallback(
    (body?: { text: string; label: string }, asOfOverride?: string) => {
      const t = body?.text ?? text;
      const l = body?.label ?? label;
      if (!t.trim() || t.length > ARTIFACT_LIMIT || check.isPending) return;
      check.mutate(
        { text: t, as_of: asOfOverride ?? asOf, label: l.trim() || undefined },
        {
          onSuccess: (out) => {
            setResult({ out, text: t, label: l });
            setEditing(false);
            setActive(null);
            setHover(null);
            setRunSeq((n) => n + 1);
          },
        },
      );
    },
    [text, label, asOf, check],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    analyze();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (isSubmitChord(e)) {
      e.preventDefault();
      analyze();
    }
  };

  const placed = useMemo(() => (result ? placeMatches(result.text, result.out.matches) : []), [result]);
  const textPieces = useMemo(() => (result ? pieces(result.text, placed) : []), [result, placed]);
  const firstPieceOf = useMemo(() => {
    const m = new Map<number, number>();
    textPieces.forEach((p, i) => p.covering.forEach((c) => !m.has(c) && m.set(c, i)));
    return m;
  }, [textPieces]);
  const rankOf = useMemo(() => new Map(placed.map((p, i) => [p.index, i])), [placed]);
  const lit = hover ?? active;

  const selectFromText = (index: number) => {
    setActive(index);
    const card = document.getElementById(`finding-${index}`);
    card?.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    card?.focus({ preventScroll: true });
  };
  const selectFromList = (index: number) => {
    setActive(index);
    const mark = textRef.current?.querySelector<HTMLElement>(`[data-first-of~="${index}"]`);
    mark?.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(findingsMarkdown(result.out, result.label));
      toast({ title: 'Findings copied as Markdown', tone: 'green' });
    } catch {
      toast({ title: 'Could not copy', detail: 'The browser refused clipboard access.', tone: 'red' });
    }
  };

  const firstSample = samples.data?.artifacts[0];
  const tooLong = text.length > ARTIFACT_LIMIT;
  const showEditor = editing || !result;
  const out = result?.out;
  const announce = out
    ? out.summary.matches
      ? `Checked as of ${out.as_of}: ${out.summary.matches} ${out.summary.matches === 1 ? 'match' : 'matches'}, ${out.summary.stale} stale${out.summary.needs_review ? `, ${out.summary.needs_review} needing a human read` : ''}, ${out.summary.rules_touched} ${out.summary.rules_touched === 1 ? 'rule' : 'rules'} touched.`
      : `Checked as of ${out.as_of}: no rule-bearing language found.`
    : '';

  return (
    <div className="space-y-4">
      <form onSubmit={submit} onKeyDown={onKeyDown} aria-label="Artifact check" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium text-ink-2">Try a sample:</span>
          {samples.isLoading && <span className="sk sk-shimmer inline-block h-6 w-40" aria-hidden />}
          {samples.data?.artifacts.map((s) => (
            <button
              key={s.label}
              type="button"
              title={s.label}
              className="inline-block h-7 max-w-full truncate rounded-full border border-hairline bg-surface px-3 text-[12px] leading-[26px] font-medium text-slate transition-colors hover:border-teal hover:text-teal-ink sm:max-w-[340px]"
              onClick={() => {
                setText(s.text);
                setLabel(s.label);
                setEditing(true);
                analyze({ text: s.text, label: s.label });
              }}
            >
              {s.label}
            </button>
          ))}
          {samples.error && <span className="text-[12px] text-ink-3">samples unavailable — paste your own text</span>}
        </div>

        {showEditor ? (
          <div>
            <label htmlFor={textareaId} className="sr-only">
              Text to check
            </label>
            <textarea
              id={textareaId}
              ref={areaRef}
              className={cn('input min-h-[260px] font-mono text-[12.5px] leading-[1.65]', tooLong && 'border-red')}
              placeholder={'Paste a call script, QA scorecard item, email template, web page or prompt…\n\nExample: "Complete the Scope of Appointment at least 48 hours before the appointment."'}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                // Once the text is edited it is no longer the sample: drop the sample's title.
                if (samples.data?.artifacts.some((s) => s.label === label)) setLabel('');
              }}
              spellCheck={false}
              aria-describedby={`${textareaId}-count`}
            />
            <div id={`${textareaId}-count`} className={cn('mt-1 text-right font-mono text-[11px]', tooLong ? 'text-red' : 'text-ink-3')}>
              {text.length.toLocaleString('en-US')} / {ARTIFACT_LIMIT.toLocaleString('en-US')}
              {tooLong && ' — too long for one check'}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <DateAsOfControl
            value={asOf}
            onChange={(d) => {
              setAsOf(d);
              // A result on screen must never describe a different date than the picker shows.
              if (result) analyze({ text: result.text, label: result.label }, d);
            }}
            quick={QUICK_DATES}
            label="As of"
          />
          <p className="basis-full text-[11.5px] text-ink-3 sm:order-last">
            Oct 1, 2026 is when the CY2027 marketing changes apply — switch to Sep 30 to see the same text before the change.
          </p>
          <div className="w-[220px] max-w-full">
            <label htmlFor={labelId} className="label">
              Label <span className="font-normal normal-case tracking-normal text-ink-3">(optional)</span>
            </label>
            <input id={labelId} className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Q4 inbound script" maxLength={120} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            {!showEditor && (
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)}>
                <Pencil size={13} aria-hidden /> Edit text
              </button>
            )}
            <button type="submit" className="btn" disabled={!text.trim() || tooLong || check.isPending} aria-keyshortcuts="Control+Enter Meta+Enter">
              {check.isPending ? (
                <>
                  <span aria-hidden className="pulse-dot bg-on-navy" /> Analyzing…
                </>
              ) : (
                <>
                  <ScanText size={14} aria-hidden /> Analyze
                  <kbd className="kbd ml-1 hidden sm:inline-flex">{mod} ↵</kbd>
                </>
              )}
            </button>
          </div>
        </div>
        <PrivacyLine />
      </form>

      {check.error && !check.isPending && <RefusalNote error={check.error} limit={ARTIFACT_LIMIT} />}

      <div aria-live="polite" className="sr-only">
        {announce}
      </div>

      {!out ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="hidden rounded-[8px] border border-dashed border-input px-5 py-6 text-[13px] leading-relaxed text-ink-2 lg:block">
            <div className="font-semibold text-ink">What you will see</div>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>Your text, with every sentence a matcher recognised highlighted by verdict. Wording no matcher knows is not flagged.</li>
              <li>For each: which rule, which version it encodes, and whether that version is in force on your date.</li>
              <li>If it is stale, the direction: over-restrictive (stricter than the rule now is), under-restrictive (misses a new requirement) or re-verify.</li>
            </ol>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px]">
              <span className="inline-flex items-center gap-1.5">
                <span className="hl hl-under inline-block h-3 w-5" aria-hidden /> under-restrictive
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="hl hl-over inline-block h-3 w-5" aria-hidden /> over-restrictive
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="hl hl-reverify inline-block h-3 w-5" aria-hidden /> re-verify
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="hl hl-current inline-block h-3 w-5" aria-hidden /> current
              </span>
            </div>
          </div>
          <WhatItChecks rules={rules.data} />
        </div>
      ) : (
        <section aria-label="Results" className="space-y-3">
          <div className="card card-hero px-4 py-3">
            <Summary result={out} onCopy={() => void copy()} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="card min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-2">
                <span className="eyebrow">{result.label ? result.label : 'Your text'}</span>
                <span className="text-[11px] text-ink-3">{out.summary.matches ? 'Click a highlight to see its finding' : 'Nothing highlighted'}</span>
              </div>
              <div
                ref={textRef}
                key={runSeq}
                className="max-h-[62vh] overflow-y-auto whitespace-pre-wrap px-4 py-3 font-mono text-[12.5px] leading-[1.75] text-ink [overflow-wrap:anywhere]"
                data-testid="sandbox-text"
              >
                {textPieces.map((p, i) => {
                  const content = result.text.slice(p.start, p.end);
                  if (!p.covering.length) return <span key={p.start}>{content}</span>;
                  const byRank = [...p.covering].sort((a, b) => (rankOf.get(a) ?? 0) - (rankOf.get(b) ?? 0));
                  const tone = worstTone(p.covering.map((c) => matchTone(out.matches[c])));
                  const primary = byRank[0];
                  const firsts = p.covering.filter((c) => firstPieceOf.get(c) === i);
                  const names = byRank.map((c) => `${out.matches[c].rule_code}: ${verdictLabel(out.matches[c])}`).join('; ');
                  return (
                    <mark
                      key={p.start}
                      role="button"
                      tabIndex={0}
                      data-testid="sandbox-span"
                      data-tone={tone}
                      data-first-of={firsts.join(' ') || undefined}
                      data-active={lit !== null && p.covering.includes(lit) ? 'true' : undefined}
                      aria-label={`${content.slice(0, 60)} — ${names}`}
                      title={names}
                      className={cn('hl span-in', HIGHLIGHT_CLASS[tone])}
                      style={{ '--i': Math.min(rankOf.get(primary) ?? 0, 12) } as CSSProperties}
                      onClick={() => selectFromText(primary)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          selectFromText(primary);
                        }
                      }}
                      onMouseEnter={() => setHover(primary)}
                      onMouseLeave={() => setHover(null)}
                    >
                      {content}
                    </mark>
                  );
                })}
              </div>
            </div>

            <div className="min-w-0">
              {out.matches.length === 0 ? (
                <div className="card px-4 py-4">
                  <div className="text-[14px] font-semibold text-ink">No rule-bearing language found</div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                    Backstop only flags text that encodes one of the {rules.data?.length ?? 7} versioned rules. A clean result means none of them is spelled out here — not that the text is compliant.
                  </p>
                  {firstSample && (
                    <button
                      type="button"
                      className="btn btn-outline btn-sm mt-3"
                      onClick={() => {
                        setText(firstSample.text);
                        setLabel(firstSample.label);
                        analyze({ text: firstSample.text, label: firstSample.label });
                      }}
                    >
                      Try “{firstSample.label}”
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="eyebrow mb-2 flex items-center justify-between">
                    <span>Findings · most urgent first</span>
                    <span className="font-mono normal-case tracking-normal text-ink-3">{out.matches.length}</span>
                  </div>
                  <ol className="max-h-[62vh] space-y-2 overflow-y-auto pr-0.5" aria-label="Findings">
                    {placed.map((p) => (
                      <Finding
                        key={p.index}
                        placed={p}
                        asOf={out.as_of}
                        active={lit === p.index}
                        onSelect={() => selectFromList(p.index)}
                        onHover={(on) => setHover(on ? p.index : null)}
                      />
                    ))}
                  </ol>
                </>
              )}
            </div>
          </div>
          <PrivacyLine detail={`this check: sha256 ${shortHash(out.text_sha256, 10)}${redactionLine(out.redacted) ? ` · redacted ${redactionLine(out.redacted)}` : ' · nothing needed redacting'}`} />
        </section>
      )}
    </div>
  );
}
