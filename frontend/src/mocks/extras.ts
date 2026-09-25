import type { HealthDeepOut, IngestFormatsOut, MatcherEvalOut, RuleSourceOut } from '../api/types';
import { EDGES } from './assets';
import { RULES } from './rules';

/** Fixtures for the surfaces added in the integration pass (sources, evals, ingest, health). */

const CHECKED = '2026-09-21T13:47:16Z';
const FIRST = '2026-09-19T21:10:02Z';

const EXCERPTS: Record<string, string> = {
  'crowell.com':
    'The rule codifies the Inflation Reduction Act (IRA)-mandated restructured Part D benefit and Manufacturer Discount Program (MDP) framework, imposing civil money penalties for noncompliant manufacturers. The new rule eliminates or relaxes several marketing and enrollment safeguards, including the 48-hour Scope of Appointment (SOA) waiting period and the 12-hour educational-to-marketing event prohibition; most changes take effect October 1, 2026.',
  'law.cornell.edu':
    '(41) Third-party marketing organizations must (i) verbally convey the following disclaimer prior to the discussion of any benefits: "We do not offer every plan available in your area. Currently we represent [insert number of organizations] organizations which offer [insert number of plans] products in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options."',
  'federalregister.gov':
    'Medicare Program; Contract Year 2027 Policy and Technical Changes to the Medicare Advantage Program, Medicare Prescription Drug Benefit Program, and Programs of All-Inclusive Care for the Elderly. Final rule. Effective date: October 1, 2026, except as otherwise noted.',
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function hashFor(url: string, salt: string): string {
  let h = 0x9e3779b9;
  for (const ch of url + salt) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  let out = '';
  for (let i = 0; i < 8; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

/** Two checks per rule source (first seen + nightly), newest first. */
export function ruleSources(code: string): RuleSourceOut[] {
  const rule = RULES.find((r) => r.code === code);
  if (!rule) return [];
  const urls = [...new Set([rule.source_url, ...rule.versions.map((v) => v.source_url)].filter(Boolean))];
  const out: RuleSourceOut[] = [];
  for (const url of urls) {
    const hash = hashFor(url, 'v1');
    const excerpt = EXCERPTS[hostOf(url)] ?? `Snapshot of ${hostOf(url)} — text excerpt around the cited clause.`;
    out.push({ id: `src-${hashFor(url, 'n').slice(0, 8)}`, source_url: url, content_hash: hash, excerpt, fetch_mode: 'snapshot', error: null, changed: false, checked_at: CHECKED });
    out.push({ id: `src-${hashFor(url, 'f').slice(0, 8)}`, source_url: url, content_hash: hash, excerpt, fetch_mode: 'snapshot', error: null, changed: false, checked_at: FIRST });
  }
  return out.sort((a, b) => (a.checked_at < b.checked_at ? 1 : -1));
}

export function ingestFormats(): IngestFormatsOut {
  return {
    'attention-snowflake': {
      description: 'Assumed shape of the Attention → Snowflake call export. CONFIRM column names against the real export.',
      columns: {
        call_id: 'unique call identifier (becomes the transcript code, prefixed A-)',
        started_at: 'ISO timestamp',
        agent_name: 'agent display name',
        product_line: "MA | PDP | MEDIGAP | LIFE (mapped from the scorecard's call type if absent)",
        duration_seconds: 'integer',
        transcript: "diarized text; lines like '[00:00:12] AGENT: ...' or 'AGENT: ...'",
      },
      redaction: 'Medicare numbers, SSNs and DOB patterns are replaced with [REDACTED-*] before storage.',
    },
    generic: {
      description: 'Minimal CSV: code, product_line, transcript.',
      columns: { code: 'unique', product_line: 'MA | PDP | MEDIGAP | LIFE', transcript: 'text' },
      redaction: 'same as attention-snowflake',
    },
  };
}

interface GoldenCase {
  id: string;
  text: string;
  expected: Array<[string, number]>;
  detected: Array<[string, number]>;
  known_limitation?: boolean;
}

const GOLDEN: GoldenCase[] = [
  { id: 'soa-01', text: 'A Scope of Appointment must be documented at least 48 hours before any personal marketing appointment.', expected: [['soa-48h-wait', 1]], detected: [['soa-48h-wait', 1]] },
  { id: 'soa-02', text: 'The standard expectation is 48 hours in advance, although walk-ins can be seen the same day.', expected: [['soa-48h-wait', 1]], detected: [['soa-48h-wait', 1]] },
  { id: 'soa-03', text: "We'll need to wait 48 hours before we can meet to go over specific plans.", expected: [['soa-48h-wait', 1]], detected: [['soa-48h-wait', 1]] },
  { id: 'soa-04-v2', text: 'There is no waiting period between the Scope of Appointment and the appointment; the SOA is still required.', expected: [['soa-48h-wait', 2]], detected: [['soa-48h-wait', 2]] },
  { id: 'soa-05-neg', text: 'Our office is open 48 hours a week and appointments are available on weekends.', expected: [], detected: [] },
  { id: 'soa-06-neg', text: 'Please allow 48 hours for the enrollment confirmation email to arrive.', expected: [], detected: [] },
  { id: 'soa-09-near-miss', text: 'Forty-eight hours after the storm, the office reopened for appointments with existing clients.', expected: [['soa-48h-wait', 1]], detected: [['soa-48h-wait', 1]], known_limitation: true },
  { id: 'tpmo-01', text: 'Deliver the TPMO disclaimer within the first minute of the call.', expected: [['tpmo-disclaimer-timing', 1]], detected: [['tpmo-disclaimer-timing', 1]] },
  { id: 'tpmo-02', text: 'Score YES when the full disclaimer is delivered within the first 60 seconds.', expected: [['tpmo-disclaimer-timing', 1]], detected: [['tpmo-disclaimer-timing', 1]] },
  { id: 'tpmo-03-v2', text: 'The disclaimer must be conveyed prior to the discussion of any benefits.', expected: [['tpmo-disclaimer-timing', 2]], detected: [['tpmo-disclaimer-timing', 2]] },
  { id: 'tpmo-04-neg', text: 'The first minute of the webinar covers how Medicare enrollment periods work.', expected: [], detected: [] },
  { id: 'tpmo-05', text: 'Flag the call if the TPMO disclaimer was not delivered within the first 60 seconds.', expected: [['tpmo-disclaimer-timing', 1]], detected: [['tpmo-disclaimer-timing', 1]] },
  { id: 'text-01', text: 'Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program (SHIP) to get information on all of your options.', expected: [['tpmo-disclaimer-text', 1]], detected: [['tpmo-disclaimer-text', 1]] },
  { id: 'text-02-v2', text: 'Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options.', expected: [['tpmo-disclaimer-text', 2]], detected: [['tpmo-disclaimer-text', 2]] },
  { id: 'text-03-neg', text: 'Your State Health Insurance Program can help with Medicaid questions.', expected: [], detected: [] },
  { id: 'ret-01', text: 'Recordings are kept for 10 years so that CMS and the carriers can audit what was said.', expected: [['call-recording-retention', 1]], detected: [['call-recording-retention', 1]] },
  { id: 'ret-02', text: 'All calls are recorded and retained for a minimum of ten years.', expected: [['call-recording-retention', 1]], detected: [['call-recording-retention', 1]] },
  { id: 'ret-03-v2', text: 'Recordings must be retained for a minimum period of 6 years; years 4-6 may be a complete transcript.', expected: [['call-recording-retention', 2]], detected: [['call-recording-retention', 2]] },
  { id: 'ret-04-neg', text: 'The company celebrated ten years in business this spring.', expected: [], detected: [] },
  { id: 'ret-05-near-miss', text: 'Keep your Medicare paperwork for ten years in case of an audit.', expected: [], detected: [], known_limitation: true },
  { id: 'sup-01', text: 'Do not call any plan the best unless we can back that up with current or prior-year data.', expected: [['superlatives', 1]], detected: [['superlatives', 1]] },
  { id: 'sup-02', text: 'Score NO when the agent uses a superlative without citing supporting data from the current or prior contract year.', expected: [['superlatives', 1]], detected: [['superlatives', 1]] },
  { id: 'sup-03-neg', text: 'Our best-selling coffee mug is back in stock at the front desk.', expected: [], detected: [] },
  { id: 'edu-01', text: 'Agents cannot collect a Scope of Appointment form at an educational event.', expected: [['soa-educational-events', 1]], detected: [['soa-educational-events', 1]] },
  { id: 'edu-02-v2', text: 'SOA collection at educational events is permitted; the 12-hour gap is eliminated.', expected: [['soa-educational-events', 2]], detected: [['soa-educational-events', 2]] },
  { id: 'edu-03-neg', text: 'The educational event starts at noon; lunch is provided.', expected: [], detected: [] },
  { id: 'notice-01', text: 'This call is recorded for quality and compliance.', expected: [['eip-recording-notice', 1]], detected: [['eip-recording-notice', 1]] },
  { id: 'notice-02-v2', text: 'State that the call is recorded before collecting any personal information and name the retention period.', expected: [['eip-recording-notice', 2]], detected: [['eip-recording-notice', 2]] },
  { id: 'notice-03-neg', text: 'The training session was recorded and is available on the LMS.', expected: [], detected: [] },
  { id: 'mixed-01', text: 'Deliver the disclaimer within the first minute, then confirm the SOA was signed at least 48 hours ago.', expected: [['tpmo-disclaimer-timing', 1], ['soa-48h-wait', 1]], detected: [['tpmo-disclaimer-timing', 1], ['soa-48h-wait', 1]] },
];

function counts(cases: GoldenCase[]) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const c of cases) {
    const exp = new Set(c.expected.map(([r, v]) => `${r}@${v}`));
    const det = new Set(c.detected.map(([r, v]) => `${r}@${v}`));
    for (const d of det) if (exp.has(d)) tp += 1; else fp += 1;
    for (const e of exp) if (!det.has(e)) fn += 1;
  }
  const precision = tp + fp ? Number((tp / (tp + fp)).toFixed(3)) : 1;
  const recall = tp + fn ? Number((tp / (tp + fn)).toFixed(3)) : 1;
  return { tp, fp, fn, precision, recall };
}

export function matcherEvals(): MatcherEvalOut {
  const rules = [...new Set(GOLDEN.flatMap((c) => [...c.expected, ...c.detected].map(([r]) => r)))].sort();
  const per_rule = Object.fromEntries(
    rules.map((rule) => [
      rule,
      counts(
        GOLDEN.map((c) => ({
          ...c,
          expected: c.expected.filter(([r]) => r === rule),
          detected: c.detected.filter(([r]) => r === rule),
        })),
      ),
    ]),
  );
  return {
    summary: {
      ...counts(GOLDEN),
      cases: GOLDEN.length,
      known_limitations: GOLDEN.filter((c) => c.known_limitation).length,
      suite: 'Golden Matcher Suite',
      metric_scope: 'fixture',
      disclaimer:
        'Hand-authored regression fixtures. Not an estimate of production accuracy: the cases were written by the same person who wrote the matchers, so they catch regressions, not unknown unknowns.',
      positives: GOLDEN.filter((c) => c.expected.length > 0).length,
      negatives: GOLDEN.filter((c) => c.expected.length === 0).length,
    },
    per_rule,
    cases: GOLDEN.map((c) => {
      const exp = new Set(c.expected.map(([r, v]) => `${r}@${v}`));
      const det = new Set(c.detected.map(([r, v]) => `${r}@${v}`));
      return {
        id: c.id,
        text: c.text,
        expected: c.expected,
        detected: c.detected,
        detected_status: Object.fromEntries(c.detected.map(([r, v]) => [`${r}@${v}`, c.id.includes('near-miss') ? 'proposed' : 'confirmed'])),
        false_positive: c.detected.filter(([r, v]) => !exp.has(`${r}@${v}`)),
        false_negative: c.expected.filter(([r, v]) => !det.has(`${r}@${v}`)),
        known_limitation: c.known_limitation === true,
      };
    }),
  };
}

export function matcherEvalsMarkdown(): string {
  const ev = matcherEvals();
  const lines = [
    '# Matcher evaluation report',
    '',
    `Golden set: \`matcher_golden.yaml\` · ${ev.summary.cases} cases · generated by \`backstop eval-matchers\` (mock).`,
    '',
    'Precision-first by design: a false positive costs a reviewer one click; a false negative is covered by the LLM proposer and by the next human who reads the artifact.',
    '',
    `| metric | value |`,
    `|---|---|`,
    `| true positives | ${ev.summary.tp} |`,
    `| false positives | ${ev.summary.fp} |`,
    `| false negatives | ${ev.summary.fn} |`,
    `| precision | ${ev.summary.precision} |`,
    `| recall | ${ev.summary.recall} |`,
    `| known limitations | ${ev.summary.known_limitations} |`,
    '',
    '## Per rule',
    '',
    '| rule | tp | fp | fn | precision | recall |',
    '|---|---|---|---|---|---|',
    ...Object.entries(ev.per_rule).map(([r, c]) => `| ${r} | ${c.tp} | ${c.fp} | ${c.fn} | ${c.precision} | ${c.recall} |`),
  ];
  return lines.join('\n');
}

export function healthDeep(transcripts: number, lastScan: { id: string; status: string; finished_at: string | null } | null): HealthDeepOut {
  return {
    version: '0.1.0-mock',
    time: new Date().toISOString(),
    database: 'ok',
    rules: RULES.length,
    contracts: 8,
    transcripts,
    // the mock carries no held-out calls; the backend reports 60
    holdout_transcripts: 0,
    artifact_versions: EDGES.length,
    last_scan: lastScan,
    adapters: { simulated: true, cassette: true, anthropic: false },
    ready: true,
    status: 'healthy',
    artifacts: EDGES.length,
    components: [
      { name: 'api', state: 'healthy', detail: 'backstop 0.1.0-mock', required: true },
      { name: 'database', state: 'healthy', detail: 'in-memory mock', required: true },
      { name: 'rules', state: 'healthy', detail: `${RULES.length} loaded`, required: true },
      { name: 'artifacts', state: 'healthy', detail: `${EDGES.length} registered`, required: true },
      { name: 'runner', state: 'healthy', detail: '8 contracts · 8 checks registered', required: true },
      { name: 'ollama', state: 'offline', detail: 'not reachable — recorded cassettes still replay', required: false },
    ],
  };
}
