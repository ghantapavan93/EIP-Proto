import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import type { SandboxArtifactOut, SandboxMatch, SandboxTranscriptOut } from '../api/types';
import {
  findingsMarkdown,
  locateSpanRange,
  locateSpan,
  matchTone,
  pieces,
  placeMatches,
  redactionLine,
  refusalCopy,
  routeOf,
  transcriptSpans,
  verdictLabel,
  worstTone,
} from '../lib/sandbox';
import { actionLabel, fallbackMe, permissionFor } from '../lib/roles';
import { flipDate, readGuideHidden, writeGuideHidden } from '../lib/guide';
import { isSeededExample, whoCanApprove } from '../lib/testCases';
import { isSubmitChord } from '../lib/palette';

function match(partial: Partial<SandboxMatch>): SandboxMatch {
  return {
    rule_code: 'soa-48h-wait',
    rule_title: 'Scope of Appointment — 48-hour waiting period',
    citation: '42 CFR 422.2264(c)(3)',
    bound_version: 1,
    bound_status: 'in_force',
    in_force_version: 2,
    polarity: 'ENFORCES',
    span: '',
    offset: 0,
    matcher: 'soa-48h-explicit',
    confidence: 1,
    edge_status: 'confirmed',
    verdict: 'stale',
    direction: 'over_restrictive',
    reason: 'bound to v1; v2 in force',
    applies_from: '2026-10-01',
    regulation_effective: null,
    disputed: false,
    ...partial,
  };
}

describe('sandbox: placing findings in the pasted text', () => {
  it('uses the server offset when it is exact', () => {
    const text = 'Intro. Wait 48 hours after the SOA. Done.';
    const span = 'Wait 48 hours after the SOA.';
    expect(locateSpan(text, span, text.indexOf(span))).toBe(7);
  });

  it('recovers when redaction earlier in the text shifted the offset', () => {
    // the server matched "[MEDICARE_NUMBER] …" (17 chars) where the paste had an 11-char MBI
    const pasted = 'MBI 1EG4TE5MK73. Wait 48 hours after the SOA.';
    const span = 'Wait 48 hours after the SOA.';
    const redactedOffset = 'MBI [MEDICARE_NUMBER]. '.length;
    expect(locateSpan(pasted, span, redactedOffset)).toBe(pasted.indexOf(span));
  });

  it('places a span that straddles a redaction, with its length in the pasted text', () => {
    const pasted = 'Intro. Call 1EG4-TE5-MK73 within 48 hours.';
    expect(locateSpanRange(pasted, 'Call [REDACTED-MEDICARE_NUMBER] within 48 hours.', 0)).toEqual({ at: 7, length: 'Call 1EG4-TE5-MK73 within 48 hours.'.length });
    expect(locateSpan(pasted, 'Call [SSN] within 48 hours.', 0)).toBe(7);
    // regex metacharacters in the quote are literal
    expect(locateSpan('Pay $12.40 (per month) now.', 'Pay $12.40 (per month) now.', 3)).toBe(0);
    expect(locateSpan('nothing like it', 'Call [REDACTED-SSN] now.', 0)).toBe(-1);
  });

  it('orders findings most urgent first and splits overlapping spans into shared pieces', () => {
    const text = 'Keep recordings for 10 years. Wait 48 hours after the SOA.';
    const a = match({ span: 'Keep recordings for 10 years.', offset: 0, direction: 'over_restrictive', rule_code: 'call-recording-retention' });
    const b = match({ span: 'Wait 48 hours after the SOA.', offset: 30, direction: 'under_restrictive' });
    const c = match({ span: '48 hours', offset: 35, verdict: 'current', direction: null });
    const placed = placeMatches(text, [a, b, c]);
    expect(placed.map((p) => p.index)).toEqual([1, 0, 2]);
    const ps = pieces(text, placed);
    const covered48 = ps.find((p) => text.slice(p.start, p.end) === '48 hours');
    expect(covered48?.covering.sort()).toEqual([1, 2]);
    expect(worstTone(covered48!.covering.map((i) => matchTone([a, b, c][i])))).toBe('under');
    expect(ps.map((p) => text.slice(p.start, p.end)).join('')).toBe(text);
  });

  it('labels verdicts in plain words', () => {
    expect(verdictLabel(match({}))).toBe('Stale · over-restrictive');
    expect(verdictLabel(match({ verdict: 'current', direction: null }))).toBe('Current');
    expect(verdictLabel(match({ verdict: 'ahead', direction: null }))).toBe('Ahead of its date');
    expect(matchTone(match({ direction: 'reverify' }))).toBe('reverify');
    expect(matchTone(match({ verdict: 'no_version_in_force', direction: null }))).toBe('neutral');
  });
});

describe('sandbox: refusals and copy', () => {
  it('explains 413 / 422 / 429 / 409 / 504 in plain words', () => {
    expect(refusalCopy(new ApiError(413, 'too big', '/sandbox/artifact'), 20000).title).toMatch(/longer than the sandbox takes/);
    expect(refusalCopy(new ApiError(413, 'too big', '/sandbox/artifact'), 20000).detail).toMatch(/20,000 characters/);
    expect(refusalCopy(new ApiError(422, 'as_of: expected YYYY-MM-DD', '/x'), 1).detail).toBe('as_of: expected YYYY-MM-DD');
    expect(refusalCopy(new ApiError(429, 'slow down', '/x'), 1).title).toMatch(/Too many checks/);
    const offline = refusalCopy(new ApiError(409, 'No local model is reachable', '/x'), 1);
    expect(offline.offline).toBe(true);
    expect(refusalCopy(new ApiError(504, 'timeout', '/x'), 1).detail).toMatch(/75 seconds/);
  });

  it('lists only the identifiers that were redacted', () => {
    expect(redactionLine({ medicare_number: 1, ssn: 0, dob: 2 })).toBe('1 Medicare number · 2 dates of birth');
    expect(redactionLine({ medicare_number: 0, ssn: 0, dob: 0 })).toBe('');
  });

  it('copies findings as Markdown with the hash, never the claim that anything was stored', () => {
    const out: SandboxArtifactOut = {
      as_of: '2026-10-01',
      label: 'Q4 script',
      text_sha256: 'a'.repeat(64),
      chars: 40,
      redacted: { medicare_number: 0, ssn: 0, dob: 0 },
      matches: [match({ span: 'Wait 48 hours after the SOA.' })],
      summary: { matches: 1, stale: 1, current: 0, rules_touched: 1, over_restrictive: 1, under_restrictive: 0, reverify: 0 },
      persisted: false,
      note: '',
    };
    const md = findingsMarkdown(out);
    expect(md).toContain('# Backstop sandbox check — Q4 script');
    expect(md).toContain('1 match · 1 stale · 1 rule touched');
    expect(md).toContain('## soa-48h-wait — Stale · over-restrictive');
    expect(md).toContain('Encodes v1; in force: v2');
    expect(md).toContain('nothing stored');
  });

  it('reads transcript spans from the extraction and marks the ones not found verbatim', () => {
    const out: SandboxTranscriptOut = {
      model_id: 'ollama/qwen2.5:7b-instruct',
      latency_ms: 12000,
      redacted: { medicare_number: 0, ssn: 0, dob: 0 },
      output: { extraction: { disclaimer_span: 'We do not offer every plan.', soa_span: 'a paraphrase the call never said', carrier: 'Humana' }, route: 'BLOCK' },
      contracts: [],
      persisted: false,
      note: '',
    };
    const text = '[00:10] AGENT: We do not offer every plan.';
    const spans = transcriptSpans(out, text);
    expect(spans.map((s) => [s.label, s.verified])).toEqual([
      ['disclaimer_span', true],
      ['soa_span', false],
    ]);
    expect(spans[0].offset).toBe(text.indexOf('We do not'));
    expect(routeOf(out)).toBe('BLOCK');
  });

  it('treats Ctrl+Enter and ⌘+Enter as the run chord, plain Enter as a newline', () => {
    expect(isSubmitChord({ key: 'Enter', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isSubmitChord({ key: 'Enter', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isSubmitChord({ key: 'Enter', ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe('roles, guide and test-case helpers', () => {
  it('derives an analyst identity with reasons for every refusal', () => {
    const me = fallbackMe('reviewer', 'analyst');
    expect(me.role_label).toBe('QA Compliance Analyst');
    const startRun = me.permissions.find((p) => p.action === 'start_runs');
    expect(startRun).toMatchObject({ allowed: false, why: 'Engineers and admins can start runs' });
    expect(me.permissions.find((p) => p.action === 'decide_tasks')?.allowed).toBe(true);
    expect(me.roles[0].can).toContain('use_sandbox');
    expect(actionLabel(me, 'start_runs')).toBe('Start a harness run');
    expect(actionLabel(null, 'some_new_action')).toBe('Some new action');
    expect(me.roles.map((r) => r.role)).toEqual(['analyst', 'engineer', 'admin']);
  });

  it("prefers the server's answer and keeps the house refusal sentence", () => {
    const me = { ...fallbackMe('eng', 'engineer'), permissions: [{ action: 'start_runs', label: 'Start a harness run', allowed: false, why: 'Not allowed: only engineer or admin may do this.' }] };
    expect(permissionFor(me, 'engineer', 'start_runs')).toMatchObject({ allowed: false, why: 'Engineers and admins can start runs' });
    expect(permissionFor(null, 'engineer', 'start_runs').allowed).toBe(true);
    expect(permissionFor(null, null, 'start_runs').allowed).toBe(false);
  });

  it('picks the upcoming flip date, else the latest one', () => {
    expect(flipDate(['2023-09-30', '2026-10-01', '2026-10-01'], '2026-09-24')).toBe('2026-10-01');
    expect(flipDate(['2023-09-30', '2026-10-01'], '2026-11-02')).toBe('2026-10-01');
    expect(flipDate([], '2026-09-24')).toBeNull();
  });

  it('remembers the hidden guide, and survives storage that throws', () => {
    writeGuideHidden(true);
    expect(readGuideHidden()).toBe(true);
    writeGuideHidden(false);
    expect(readGuideHidden()).toBe(false);
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      expect(readGuideHidden()).toBe(false);
      expect(() => writeGuideHidden(true)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('recognises seeded examples and says who may approve a pending one', () => {
    expect(isSeededExample({ expected: { seeded_example: true }, created_by: 'x' })).toBe(true);
    expect(isSeededExample({ expected: {}, created_by: 'demo-seed:qa-reviewer' })).toBe(true);
    expect(isSeededExample({ expected: {}, created_by: 'analyst' })).toBe(false);
    expect(whoCanApprove({ created_by: 'analyst', status: 'PENDING_APPROVAL' })).toBe('awaiting an engineer or admin other than analyst');
    expect(whoCanApprove({ created_by: 'analyst', status: 'APPROVED' })).toBe('');
  });
});
