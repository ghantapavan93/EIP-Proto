import { ApiError } from '../api/errors';
import type {
  EdgeOut,
  JsonObject,
  RedactionCounts,
  RuleOut,
  SandboxArtifactOut,
  SandboxContractResult,
  SandboxMatch,
  SandboxSamplesOut,
  SandboxTranscriptOut,
  SpanOut,
} from '../api/types';
import { fixtureHash } from './assets';
import { evaluate, versionInForce } from './staleness';

/**
 * Mock of the sandbox endpoints: the same deterministic idea as
 * backend/backstop/scanner/matchers.py (regexes with context windows, the
 * enclosing sentence as evidence), redaction before matching, and nothing
 * kept. Coverage is deliberately smaller than the real matcher set.
 */

export const ARTIFACT_MAX = 20_000;
export const TRANSCRIPT_MAX = 30_000;

/** Test/demo switch: the local model is offline unless a test turns it on. */
export const sandboxModel = { online: false, latencyMs: 900 };

// ------------------------------------------------------------------ redaction

const REDACTIONS: Array<[keyof RedactionCounts & string, RegExp, string]> = [
  ['medicare_number', /\b[1-9][A-Za-z][A-Za-z0-9]\d-?[A-Za-z][A-Za-z0-9]\d-?[A-Za-z]{2}\d{2}\b/g, '[REDACTED-MEDICARE_NUMBER]'],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]'],
  ['dob', /\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:19|20)\d{2}\b/g, '[REDACTED-DOB]'],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED-EMAIL]'],
  // US numbers: (813) 555-0142, 813-555-0142, 813.555.0142. The SSN shape (3-2-4) was taken above.
  ['phone', /(?:\(\d{3}\)\s?|\b\d{3}[-. ])\d{3}[-. ]\d{4}\b/g, '[REDACTED-PHONE]'],
  ['address', /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Way|Place|Pl)\b\.?/g, '[REDACTED-ADDRESS]'],
];

export function redact(text: string): { text: string; counts: RedactionCounts } {
  const counts: RedactionCounts = { medicare_number: 0, ssn: 0, dob: 0, phone: 0, email: 0, address: 0 };
  let out = text;
  for (const [key, re, token] of REDACTIONS) {
    out = out.replace(re, () => {
      counts[key] = (counts[key] ?? 0) + 1;
      return token;
    });
  }
  return { text: out, counts };
}

async function sha256(text: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return fixtureHash(text);
  }
}

// ------------------------------------------------------------------ matchers

interface MockMatcher {
  name: string;
  rule: string;
  version: number;
  pattern: RegExp;
  all?: RegExp[];
  none?: RegExp[];
  status?: 'confirmed' | 'proposed';
  confidence?: number;
  polarity?: string;
}

const SOA = /scope of appointment|\bSOA\b|appointment/i;
const DISCLAIMER = /disclaimer|we do not offer every plan/i;
const RECORDING = /\brecord(ed|ing|ings)?\b|\bcalls?\b/i;

const MATCHERS: MockMatcher[] = [
  { name: 'soa-48h-explicit', rule: 'soa-48h-wait', version: 1, pattern: /\b48[- ]?hours?\b|\bforty[- ]eight hours\b/gi, all: [SOA] },
  { name: 'soa-two-days-semantic', rule: 'soa-48h-wait', version: 1, pattern: /\btwo (business |working )?days\b/gi, all: [SOA], status: 'proposed', confidence: 0.7 },
  { name: 'soa-no-waiting-period', rule: 'soa-48h-wait', version: 2, pattern: /\bno (minimum )?waiting period\b/gi, all: [SOA] },
  { name: 'disclaimer-first-minute', rule: 'tpmo-disclaimer-timing', version: 1, pattern: /(within|in) the first (minute|60 seconds|sixty seconds)|one-minute mark|first 60 seconds/gi, all: [DISCLAIMER] },
  { name: 'disclaimer-before-benefits', rule: 'tpmo-disclaimer-timing', version: 2, pattern: /(prior to|before) (the )?(discussion of |discussing )?(any )?(plan )?benefits?/gi, all: [DISCLAIMER] },
  { name: 'disclaimer-text-ship', rule: 'tpmo-disclaimer-text', version: 1, pattern: /State Health Insurance (Assistance )?Program|\(SHIP\)/gi, all: [/1-800-MEDICARE|medicare\.gov/i] },
  { name: 'disclaimer-text-current', rule: 'tpmo-disclaimer-text', version: 2, pattern: /Please contact Medicare\.gov or 1-800-MEDICARE to get information on all of your options/gi },
  { name: 'retention-10-years-recording', rule: 'call-recording-retention', version: 1, pattern: /\b(10|ten)[- ]years?\b/gi, all: [RECORDING], none: [/scope of appointment forms?|SOA forms?/i] },
  { name: 'retention-6-years-recording', rule: 'call-recording-retention', version: 2, pattern: /\b(6|six)[- ]years?\b/gi, all: [RECORDING] },
  { name: 'superlatives-substantiation', rule: 'superlatives', version: 1, pattern: /superlatives?|"best"|\bthe best plan\b/gi, all: [/substantiat|data|prohibit|unless|not use|cannot/i], none: [/superlatives are permitted/i] },
  { name: 'superlatives-permitted', rule: 'superlatives', version: 2, pattern: /superlatives are permitted/gi },
  { name: 'soa-educational-events-prohibited', rule: 'soa-educational-events', version: 1, pattern: /educational events?/gi, all: [SOA, /do not|may not|cannot|not collect|prohibit/i] },
  { name: 'educational-events-12-hour-gap', rule: 'soa-educational-events', version: 1, pattern: /\b12[- ]hours?\b|\btwelve hours\b/gi, all: [/educational events?/i] },
  { name: 'recording-notice', rule: 'eip-recording-notice', version: 1, pattern: /\bcall (is|may be) recorded\b/gi },
];

const ENFORCE = /\b(must|required|require|shall|need to|at least|score 0|do not|does not|may not|cannot|prohibit|prohibited|no later than|within the first|minimum of|retain|retained|flag)\b/i;
const PERMIT = /\b(permitted|allowed|may|can be completed|is permitted)\b/i;

function polarityOf(sentence: string): string {
  if (ENFORCE.test(sentence)) return 'ENFORCES';
  if (PERMIT.test(sentence)) return 'PERMITS';
  return 'INFORMS';
}

/** The sentence (or line) around [start, end), trimmed; a verbatim substring of text. */
export function enclosingSentence(text: string, start: number, end: number): { span: string; offset: number } {
  // a sentence ends at . ! ? followed by whitespace (so "Medicare.gov" stays whole), or at a newline
  const endsAt = (i: number) => text[i] === '\n' || (/[.!?]/.test(text[i]) && (i + 1 >= text.length || /\s/.test(text[i + 1])));
  let lo = start;
  while (lo > 0 && !endsAt(lo - 1)) lo -= 1;
  let hi = end;
  while (hi < text.length && !endsAt(hi)) hi += 1;
  if (hi < text.length && text[hi] !== '\n') hi += 1;
  while (lo < hi && /\s/.test(text[lo])) lo += 1;
  while (hi > lo && /\s/.test(text[hi - 1])) hi -= 1;
  return { span: text.slice(lo, hi), offset: lo };
}

interface RawMatch {
  matcher: MockMatcher;
  span: string;
  offset: number;
}

function runMatchers(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  const seen = new Set<string>();
  for (const m of MATCHERS) {
    m.pattern.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = m.pattern.exec(text)) !== null) {
      const lo = Math.max(0, hit.index - 220);
      const hi = Math.min(text.length, hit.index + hit[0].length + 220);
      const ctx = text.slice(lo, hi);
      if (m.all?.some((p) => !p.test(ctx))) continue;
      if (m.none?.some((p) => p.test(ctx))) continue;
      const { span, offset } = enclosingSentence(text, hit.index, hit.index + hit[0].length);
      const key = `${m.rule}|${m.version}|${offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ matcher: m, span, offset });
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

function edgeFor(rule: RuleOut, version: number, raw: RawMatch): EdgeOut {
  return {
    id: `sandbox-${rule.code}-${raw.offset}`,
    rule_version_id: `rv-${rule.code}-${version}`,
    rule_version: version,
    rule_code: rule.code,
    asset_id: 'sandbox',
    asset_code: 'sandbox',
    asset_name: 'pasted text',
    asset_type: 'web_page',
    asset_url: null,
    asset_is_synthetic: false,
    owner_role: 'compliance',
    polarity: raw.matcher.polarity ?? polarityOf(raw.span),
    evidence_span: raw.span,
    span_offset: raw.offset,
    detection: 'deterministic',
    matcher: raw.matcher.name,
    confidence: raw.matcher.confidence ?? 1,
    // evaluated as confirmed so the direction table applies; reported as-is below
    status: 'confirmed',
    confirmed_by: null,
    created_at: new Date().toISOString(),
  };
}

export async function sandboxArtifact(body: JsonObject, rules: RuleOut[], today: string, path: string): Promise<SandboxArtifactOut> {
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) throw new ApiError(422, 'text: paste some text to check', path);
  if (text.length > ARTIFACT_MAX) throw new ApiError(413, `text is ${text.length} characters; the sandbox takes up to ${ARTIFACT_MAX}`, path);
  const asOf = typeof body.as_of === 'string' && body.as_of ? body.as_of : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new ApiError(422, 'as_of: expected YYYY-MM-DD', path);
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : null;

  const { text: clean, counts } = redact(text);
  const matches: SandboxMatch[] = [];
  for (const raw of runMatchers(clean)) {
    const rule = rules.find((r) => r.code === raw.matcher.rule);
    if (!rule) continue;
    const bound = rule.versions.find((v) => v.version === raw.matcher.version);
    const inForce = versionInForce(rule, asOf);
    let verdict: SandboxMatch['verdict'] = 'current';
    let direction: string | null = null;
    let reason = '';
    let disputed = false;
    if (!inForce) {
      verdict = 'no_version_in_force';
      reason = `no version of ${rule.code} is in force on ${asOf}`;
    } else if (inForce.version === raw.matcher.version) {
      verdict = 'current';
      reason = `encodes v${inForce.version}, the version in force on ${asOf}`;
    } else if (raw.matcher.version > inForce.version) {
      verdict = 'ahead';
      reason = `encodes v${raw.matcher.version}, which applies from ${bound?.effective_from ?? 'a later date'}; v${inForce.version} is still in force on ${asOf}`;
    } else {
      const [v] = evaluate(rule, [edgeFor(rule, raw.matcher.version, raw)], asOf);
      verdict = 'stale';
      direction = v?.direction ?? 'reverify';
      reason = v?.reason ?? `bound to v${raw.matcher.version}; v${inForce.version} in force`;
      disputed = v?.disputed ?? false;
    }
    matches.push({
      rule_code: rule.code,
      rule_title: rule.title,
      citation: rule.citation,
      bound_version: raw.matcher.version,
      bound_status: bound?.status ?? 'in_force',
      in_force_version: inForce?.version ?? null,
      polarity: raw.matcher.polarity ?? polarityOf(raw.span),
      span: raw.span,
      offset: raw.offset,
      matcher: raw.matcher.name,
      confidence: raw.matcher.confidence ?? 1,
      edge_status: raw.matcher.status ?? 'confirmed',
      verdict,
      direction,
      reason,
      applies_from: inForce?.effective_from ?? null,
      regulation_effective: inForce?.regulation_effective ?? null,
      disputed,
    });
  }
  const stale = matches.filter((m) => m.verdict === 'stale');
  return {
    as_of: asOf,
    label,
    text_sha256: await sha256(text),
    chars: text.length,
    redacted: counts,
    matches,
    summary: {
      matches: matches.length,
      stale: stale.length,
      current: matches.filter((m) => m.verdict === 'current').length,
      rules_touched: new Set(matches.map((m) => m.rule_code)).size,
      over_restrictive: stale.filter((m) => m.direction === 'over_restrictive').length,
      under_restrictive: stale.filter((m) => m.direction === 'under_restrictive').length,
      reverify: stale.filter((m) => m.direction === 'reverify').length,
    },
    persisted: false,
    note: 'Redacted before matching. Nothing stored; only a SHA-256 of the text is written to the audit log.',
  };
}

// ------------------------------------------------------------------ transcript (local model)

function sentenceMatching(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  if (!m) return null;
  return enclosingSentence(text, m.index, m.index + m[0].length).span;
}

function secondsAt(text: string, span: string | null): number | null {
  if (!span) return null;
  const at = text.indexOf(span);
  const before = text.slice(0, at);
  const stamps = [...before.matchAll(/\[(\d{1,2}):(\d{2})\]/g)];
  const last = stamps[stamps.length - 1];
  return last ? Number(last[1]) * 60 + Number(last[2]) : null;
}

export async function sandboxTranscript(body: JsonObject, path: string): Promise<SandboxTranscriptOut> {
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) throw new ApiError(422, 'text: paste a call transcript', path);
  if (text.length > TRANSCRIPT_MAX) throw new ApiError(413, `text is ${text.length} characters; the sandbox takes up to ${TRANSCRIPT_MAX}`, path);
  if (!sandboxModel.online) {
    throw new ApiError(409, 'No local model is reachable (Ollama is not running on this host). Recorded runs still replay.', path, {
      detail: 'No local model is reachable (Ollama is not running on this host). Recorded runs still replay.',
    });
  }
  await new Promise((r) => setTimeout(r, sandboxModel.latencyMs));
  const { text: clean, counts } = redact(text);
  const productLine = typeof body.product_line === 'string' && body.product_line ? body.product_line : 'MA';
  const disclaimerSpan = sentenceMatching(clean, /we do not offer every plan/i);
  const benefitsSpan = sentenceMatching(clean, /\bpremium|\bcopay|\bdental|\bbenefits?\b|\$\d/i);
  const soaSpan = sentenceMatching(clean, /scope of appointment/i);
  const superlative = /\b(the best|number one|top-rated)\b/i.exec(clean);
  const dSec = secondsAt(clean, disclaimerSpan);
  const bSec = secondsAt(clean, benefitsSpan);
  const disclaimerCompliant = Boolean(disclaimerSpan) && (bSec === null || (dSec ?? 0) <= bSec);
  const extraction: JsonObject = {
    product_line: productLine,
    carrier: /humana/i.test(clean) ? 'Humana' : /aetna/i.test(clean) ? 'Aetna' : null,
    disclaimer_delivered: Boolean(disclaimerSpan),
    disclaimer_seconds: dSec,
    disclaimer_span: disclaimerSpan,
    benefits_started_seconds: bSec,
    benefits_span: benefitsSpan,
    disclaimer_compliant: disclaimerCompliant,
    disclaimer_basis: 'ordering:before-benefits',
    soa_collected: Boolean(soaSpan),
    soa_span: soaSpan,
    appointment_scheduled: /appointment/i.test(clean),
    soa_wait_compliant: true,
    superlatives: superlative ? [{ text: superlative[0], substantiated: false, flagged: false }] : [],
    numeric_claims: [...clean.matchAll(/\$\d+(?:\.\d{2})?/g)].slice(0, 3).map((m) => ({ value: m[0], context: '' })),
    pii_detected: counts.medicare_number ? ['medicare_number'] : [],
  };
  const route = !disclaimerCompliant ? 'BLOCK' : counts.medicare_number ? 'FLAG' : 'PASS';
  const spans: SpanOut[] = (
    [
      ['disclaimer_span', disclaimerSpan],
      ['benefits_span', benefitsSpan],
      ['soa_span', soaSpan],
    ] as Array<[string, string | null]>
  )
    .filter((x): x is [string, string] => Boolean(x[1]))
    .map(([label, s]) => ({ label, text: s, offset: clean.indexOf(s), length: s.length, verified: clean.includes(s) }));
  const needsLabel = 'Rule verdicts compare the model against a labelled call. A pasted call has no label yet — that is the QA sample you would add.';
  const contracts: SandboxContractResult[] = [
    { code: 'C-SCHEMA-01', title: 'Output validates against the qa-handoff schema', severity: 'BLOCK', outcome: 'PASS', evidence: {}, why: 'The model returned every required field.' },
    { code: 'C-SPAN-01', title: 'Cited spans are verbatim', severity: 'BLOCK', outcome: spans.every((s) => s.verified) ? 'PASS' : 'FAIL', evidence: { spans: spans.length }, why: `${spans.length} cited spans, all found word-for-word in the call.` },
    { code: 'C-PII-01', title: 'No Medicare number or SSN in the CRM record', severity: 'BLOCK', outcome: 'PASS', evidence: {}, why: 'Identifiers were redacted before the model saw the call.' },
    { code: 'C-FACT-01', title: 'Numeric claims must appear in the transcript', severity: 'BLOCK', outcome: 'PASS', evidence: {}, why: 'Every dollar figure in the output appears in the call.' },
    {
      code: 'C-TPMO-01',
      title: 'TPMO disclaimer judged under the in-force timing basis',
      severity: 'BLOCK',
      outcome: 'NEEDS_LABEL',
      evidence: { model_says: { disclaimer_delivered: extraction.disclaimer_delivered, disclaimer_seconds: dSec, benefits_started_seconds: bSec, disclaimer_compliant: disclaimerCompliant } },
      why: needsLabel,
    },
    {
      code: 'C-SOA-01',
      title: 'SOA timing judged under the in-force waiting period',
      severity: 'BLOCK',
      outcome: 'NEEDS_LABEL',
      evidence: { model_says: { soa_collected: extraction.soa_collected, soa_wait_compliant: true } },
      why: needsLabel,
    },
    { code: 'C-SUP-01', title: 'Superlative flags follow the in-force substantiation rule', severity: 'FLAG', outcome: 'NEEDS_LABEL', evidence: { model_says: { superlatives: extraction.superlatives } }, why: needsLabel },
  ];
  return {
    model_id: typeof body.model_id === 'string' && body.model_id ? body.model_id : 'ollama/qwen2.5:7b-instruct',
    latency_ms: sandboxModel.latencyMs + 11_400,
    redacted: counts,
    output: {
      extraction,
      composition: {
        summary: `${productLine} call. ${disclaimerSpan ? 'Disclaimer delivered' : 'No disclaimer heard'}${bSec !== null ? `; benefits discussed from ${bSec}s` : ''}.`,
        coaching_note: disclaimerCompliant ? 'Disclaimer came before benefits — keep that order.' : 'Read the TPMO disclaimer before any plan benefits come up.',
        crm_record: { disposition: 'follow_up', product_line: productLine, carrier: extraction.carrier, next_step: 'appointment' },
      },
      route,
    },
    spans,
    route,
    contracts,
    persisted: false,
    note: 'Redacted before the model saw it. Nothing stored; only a SHA-256 of the text is written to the audit log.',
  };
}

// ------------------------------------------------------------------ samples

export const SAMPLES: SandboxSamplesOut = {
  artifacts: [
    {
      label: 'Call script · CY2024 wording',
      text: [
        'OPENING (agent reads verbatim)',
        'Agents must open with: "This call is recorded for quality and compliance." Recordings must be retained for 10 years.',
        'Deliver the TPMO disclaimer within the first minute of the call: "We do not offer every plan available in your area. Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program (SHIP) to get information on all of your options."',
        '',
        'SCHEDULING',
        'If the caller wants to meet, complete the Scope of Appointment first. The appointment must be at least 48 hours after the SOA is documented, unless the caller is a walk-in.',
        '',
        'BENEFITS',
        'Do not call any plan "the best" unless you can cite supporting data from the current or prior contract year.',
      ].join('\n'),
    },
    {
      label: 'QA scorecard · CY2027 wording',
      text: [
        'SC-04 Disclaimer: Score 0 if the TPMO disclaimer was delivered after the agent began discussing any benefits. Deliver it prior to the discussion of any benefits.',
        'SC-07 Scope of Appointment: The SOA must be documented before the appointment; there is no minimum waiting period.',
        'SC-09 Recording: Marketing and sales calls are recorded and retained for 6 years.',
      ].join('\n'),
    },
    {
      label: 'Welcome email · no rule language',
      text: 'Hi Maria,\n\nThanks for talking with us today. Your licensed agent, Dana, will follow up on Thursday with the plan brochures you asked for.\n\nWarmly,\nThe member services team',
    },
  ],
  transcripts: [
    {
      label: 'MA call · disclaimer after benefits',
      text: [
        '[00:04] AGENT: Thanks for calling, this is Dana, a licensed agent. This call is recorded.',
        '[00:19] CUSTOMER: Hi, I am turning 65 and I want to know about dental coverage.',
        '[00:41] AGENT: Sure. The Humana Gold Plus plan has a $0 premium and covers two cleanings a year.',
        '[01:32] AGENT: Before we go further: We do not offer every plan available in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options.',
        '[02:10] AGENT: Can I send you a Scope of Appointment so we can meet on Friday?',
        '[02:18] CUSTOMER: Yes, that works. Call me back on 813-555-0142.',
      ].join('\n'),
    },
    {
      label: 'PDP call · clean',
      text: [
        '[00:03] AGENT: Hi, this is Sam, a licensed agent with a third-party marketing organization. This call is recorded.',
        '[00:12] AGENT: We do not offer every plan available in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options.',
        '[00:35] CUSTOMER: I only need a drug plan.',
        '[00:48] AGENT: Understood. The Aetna SilverScript plan has a $12.40 monthly premium for your three prescriptions.',
      ].join('\n'),
    },
  ],
};
