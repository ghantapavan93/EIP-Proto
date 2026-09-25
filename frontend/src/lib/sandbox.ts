/**
 * Pure helpers for the "Try your data" sandbox: where each finding sits in
 * the text the person pasted, how to colour it, how to explain refusals, and
 * the Markdown copy. No React here, so every rule is unit-testable.
 */

import { isApiError } from '../api/errors';
import type { JsonObject, SandboxArtifactOut, SandboxMatch, SandboxTranscriptOut, SpanOut } from '../api/types';
import { directionLabel, type Tone } from './vocab';

export const ARTIFACT_LIMIT = 20_000;
export const TRANSCRIPT_LIMIT = 30_000;

export type HighlightTone = 'under' | 'over' | 'reverify' | 'current' | 'neutral';

/** Colour family for a finding: stale by direction; current green; anything else neutral. */
export function matchTone(m: Pick<SandboxMatch, 'verdict' | 'direction'>): HighlightTone {
  if (m.verdict === 'stale') {
    if (m.direction === 'under_restrictive') return 'under';
    if (m.direction === 'over_restrictive') return 'over';
    return 'reverify';
  }
  if (m.verdict === 'current') return 'current';
  return 'neutral';
}

const TONE_RANK: Record<HighlightTone, number> = { under: 0, over: 1, reverify: 2, neutral: 3, current: 4 };

/** Sort key: the most urgent first (under-restrictive, over-restrictive, re-verify, other, current). */
export function matchRank(m: Pick<SandboxMatch, 'verdict' | 'direction'>): number {
  return TONE_RANK[matchTone(m)];
}

/** The worst tone among several findings covering the same characters. */
export function worstTone(tones: HighlightTone[]): HighlightTone {
  return tones.reduce<HighlightTone>((worst, t) => (TONE_RANK[t] < TONE_RANK[worst] ? t : worst), 'current');
}

export const HIGHLIGHT_CLASS: Record<HighlightTone, string> = {
  under: 'hl-under',
  over: 'hl-over',
  reverify: 'hl-reverify',
  current: 'hl-current',
  neutral: 'hl-neutral',
};

export function verdictLabel(m: Pick<SandboxMatch, 'verdict' | 'direction'>): string {
  switch (m.verdict) {
    case 'stale':
      return `Stale · ${directionLabel(m.direction).toLowerCase()}`;
    case 'current':
      return 'Current';
    case 'ahead':
      return 'Ahead of its date';
    case 'no_version_in_force':
      return 'No version in force';
    default:
      return m.verdict;
  }
}

export function verdictTone(m: Pick<SandboxMatch, 'verdict' | 'direction'>): Tone {
  switch (matchTone(m)) {
    case 'under':
      return 'red';
    case 'over':
      return 'amber';
    case 'reverify':
      return 'slate';
    case 'current':
      return 'green';
    default:
      return 'teal';
  }
}

/** Redaction placeholders the server may leave inside a quoted span ("[REDACTED-MEDICARE_NUMBER]"). */
const REDACTION_TOKEN = /\[(?:REDACTED-[A-Z_]+|MEDICARE_NUMBER|SSN|DOB)\]/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where a quoted span sits in the text as pasted, and how long it is there.
 * The server matches the redacted text, so its offset is exact only when
 * nothing before the span was redacted: try the offset, then the nearest
 * verbatim occurrence, then — when the span itself carries a redaction
 * placeholder — the nearest occurrence with the placeholder standing in for
 * whatever was redacted. `at` is -1 when none of that finds it.
 */
export function locateSpanRange(text: string, span: string, offset: number): { at: number; length: number } {
  const none = { at: -1, length: 0 };
  if (!span) return none;
  if (offset >= 0 && text.slice(offset, offset + span.length) === span) return { at: offset, length: span.length };
  const nearest = (hits: Array<{ at: number; length: number }>) =>
    hits.reduce<{ at: number; length: number } | null>((best, h) => (best === null || Math.abs(h.at - offset) < Math.abs(best.at - offset) ? h : best), null);
  const verbatim: Array<{ at: number; length: number }> = [];
  for (let i = text.indexOf(span); i >= 0; i = text.indexOf(span, i + 1)) verbatim.push({ at: i, length: span.length });
  const v = nearest(verbatim);
  if (v) return v;
  if (!new RegExp(REDACTION_TOKEN.source).test(span)) return none;
  const pattern = span
    .split(REDACTION_TOKEN)
    .map(escapeRegExp)
    .join('[^\\n]{1,40}?');
  const re = new RegExp(pattern, 'g');
  const fuzzy: Array<{ at: number; length: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    fuzzy.push({ at: m.index, length: m[0].length });
    re.lastIndex = m.index + 1;
  }
  return nearest(fuzzy) ?? none;
}

/** Offset only (see locateSpanRange). */
export function locateSpan(text: string, span: string, offset: number): number {
  return locateSpanRange(text, span, offset).at;
}

export interface PlacedMatch {
  index: number;
  match: SandboxMatch;
  /** offset in the pasted text, or -1 when the span could not be placed */
  at: number;
  /** length in the pasted text (differs from the span when it straddles a redaction) */
  length: number;
}

/** Findings in display order (most urgent first, then by position), each placed in the pasted text. */
export function placeMatches(text: string, matches: SandboxMatch[]): PlacedMatch[] {
  return matches
    .map((match, index) => ({ index, match, ...locateSpanRange(text, match.span, match.offset) }))
    .sort((a, b) => matchRank(a.match) - matchRank(b.match) || (a.at < 0 ? 1 : 0) - (b.at < 0 ? 1 : 0) || a.at - b.at);
}

export interface TextPiece {
  start: number;
  end: number;
  /** indexes (into the server's matches[]) of the findings covering this piece */
  covering: number[];
}

/** Cut the text at every placed span boundary; overlapping findings share a piece. */
export function pieces(text: string, placed: PlacedMatch[]): TextPiece[] {
  const spans = placed.filter((p) => p.at >= 0).map((p) => ({ index: p.index, start: p.at, end: p.at + p.length }));
  const cuts = new Set<number>([0, text.length]);
  for (const s of spans) {
    cuts.add(s.start);
    cuts.add(Math.min(text.length, s.end));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: TextPiece[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    out.push({ start, end, covering: spans.filter((s) => s.start <= start && s.end >= end).map((s) => s.index) });
  }
  return out;
}

export interface RefusalCopy {
  title: string;
  detail: string;
  /** the model is simply not running: show the calm offline card, not an error */
  offline?: boolean;
}

/** Plain-language copy for a sandbox refusal (413 too long, 422 invalid, 429 slow down, 409 offline, 504 timeout). */
export function refusalCopy(err: unknown, limit: number): RefusalCopy {
  const status = isApiError(err) ? err.status : null;
  const message = err instanceof Error ? err.message : String(err);
  switch (status) {
    case 413:
      return { title: 'That is longer than the sandbox takes', detail: `Paste up to ${limit.toLocaleString('en-US')} characters — one script section, email or page at a time.` };
    case 422:
      return { title: 'The server could not read that request', detail: message };
    case 429:
      return { title: 'Too many checks in a minute', detail: 'The sandbox is rate-limited so one visitor cannot hog it. Wait a few seconds and try again.' };
    case 409:
      return { title: 'The live model is offline', detail: message, offline: true };
    case 504:
      return { title: 'The model took too long', detail: 'A local model gets about 75 seconds per call. Try a shorter transcript, or try again once the machine is less busy.' };
    case 0:
      return { title: 'Could not reach the server', detail: message };
    default:
      return { title: 'The check failed', detail: message };
  }
}

/** Every identifier the sandbox redacts, in display order: [key, singular, plural]. Older servers send only the first three. */
export const REDACTION_KINDS: ReadonlyArray<readonly [string, string, string]> = [
  ['medicare_number', 'Medicare number', 'Medicare numbers'],
  ['ssn', 'SSN', 'SSNs'],
  ['dob', 'date of birth', 'dates of birth'],
  ['phone', 'phone number', 'phone numbers'],
  ['email', 'email address', 'email addresses'],
  ['address', 'street address', 'street addresses'],
];

/** "1 Medicare number · 2 phone numbers" — only the non-zero counts; empty string when nothing was redacted. */
export function redactionLine(r: SandboxArtifactOut['redacted'] | undefined): string {
  if (!r) return '';
  const parts: string[] = [];
  for (const [key, one, many] of REDACTION_KINDS) {
    const n = r[key];
    if (typeof n === 'number' && n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  }
  return parts.join(' · ');
}

/** Findings as Markdown, for pasting into a ticket or an email. */
export function findingsMarkdown(result: SandboxArtifactOut, label?: string): string {
  const s = result.summary;
  const lines = [
    `# Backstop sandbox check${label || result.label ? ` — ${label || result.label}` : ''}`,
    '',
    `As of ${result.as_of} · ${s.matches} ${s.matches === 1 ? 'match' : 'matches'} · ${s.stale} stale · ${s.rules_touched} ${s.rules_touched === 1 ? 'rule' : 'rules'} touched`,
    `Text SHA-256 \`${result.text_sha256}\` · ${result.chars} characters · nothing stored`,
    '',
  ];
  if (!result.matches.length) {
    lines.push('No rule-bearing language found.');
    return lines.join('\n');
  }
  for (const m of [...result.matches].sort((a, b) => matchRank(a) - matchRank(b))) {
    lines.push(`## ${m.rule_code} — ${verdictLabel(m)}`);
    lines.push(`- Rule: ${m.rule_title}`);
    lines.push(`- Citation: ${m.citation}`);
    lines.push(`- Encodes v${m.bound_version}; in force: ${m.in_force_version === null ? 'none' : `v${m.in_force_version}`}`);
    if (m.reason) lines.push(`- Why: ${m.reason}`);
    if (m.applies_from) lines.push(`- Applies from ${m.applies_from}${m.regulation_effective && m.regulation_effective !== m.applies_from ? ` (regulation effective ${m.regulation_effective})` : ''}`);
    if (m.disputed) lines.push('- Disputed reading on the path — verify with counsel');
    lines.push(`- Text: > ${m.span}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ------------------------------------------------------------- transcript

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The extraction block of a sandbox transcript output, when the model returned one. */
export function extractionOf(out: SandboxTranscriptOut): JsonObject | null {
  return isObject(out.output.extraction) ? out.output.extraction : null;
}

/** The deterministic route: top-level when the server sends it, else inside the output. */
export function routeOf(out: SandboxTranscriptOut): string | null {
  if (typeof out.route === 'string') return out.route;
  return typeof out.output.route === 'string' ? out.output.route : null;
}

/**
 * Spans the model cited, located in the pasted text. Uses the server's spans
 * when present; otherwise reads every `*_span` field of the extraction. A
 * span not found word-for-word is unverified (offset -1).
 */
export function transcriptSpans(out: SandboxTranscriptOut, text: string): SpanOut[] {
  const fromServer = out.spans;
  const raw: Array<{ label: string; text: string }> = fromServer?.length
    ? fromServer.map((s) => ({ label: s.label, text: s.text }))
    : Object.entries(extractionOf(out) ?? {})
        .filter(([k, v]) => k.endsWith('_span') && typeof v === 'string' && v.trim() !== '')
        .map(([k, v]) => ({ label: k, text: v as string }));
  return raw.map(({ label, text: span }) => {
    const { at, length } = locateSpanRange(text, span, 0);
    return { label, text: span, offset: at, length: at >= 0 ? length : span.length, verified: at >= 0 };
  });
}
