import type { TranscriptOut } from '../api/types';

/**
 * Synthetic call-transcript corpus (60 calls) plus two labeled INGESTED
 * samples. Every synthetic transcript is generated from a scenario with
 * deterministic attributes so the mock harness can judge contracts against
 * ground truth. Nothing here is a real call.
 */

export const CORPUS_SIZE = 60;
export const CORPUS_HASH = 'e4a1c9d7b2f06358a7c1e9d4b6f2a0c8d3e5f7a9b1c2d4e6f8a0b2c4d6e8f0a1';
export const INGESTED_CORPUS_HASH = '7d2e9f0a1b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6';

export type SoaException = 'walk_in' | 'last_four_days' | null;

export interface Scenario {
  index: number;
  code: string;
  product_line: 'MA' | 'PDP' | 'MEDIGAP';
  agent: string;
  customer: string;
  carrier: string;
  county: string;
  /** seconds into the call when the TPMO disclaimer was delivered; null = never */
  disclaimerAt: number | null;
  /** seconds into the call when benefits discussion began */
  benefitsAt: number;
  /** hours between SOA documentation and the appointment */
  soaHours: number;
  soaException: SoaException;
  /** disclaimer wording: v1 mentions SHIP, v2 does not */
  disclaimerWording: 1 | 2;
  premium: string;
  deductible: string;
  moop: string;
  superlative: boolean;
  recordingNoticeAt: number | null;
  mbiReadBack: boolean;
  duration: number;
}

const AGENTS = ['Dana', 'Marcus', 'Priya', 'Luis', 'Tamara', 'Evan', 'Nadia', 'Chris'];
const CUSTOMERS = ['Mr. Alvarez', 'Mrs. Whitfield', 'Mr. Okafor', 'Ms. Brennan', 'Mr. Castellano', 'Mrs. Dubois', 'Mr. Lindqvist', 'Ms. Patel', 'Mrs. Hargrove', 'Mr. Nakamura'];
const CARRIERS = ['Humana', 'UnitedHealthcare', 'Aetna', 'Wellcare', 'Cigna', 'Devoted Health'];
const COUNTIES = ['Hillsborough', 'Pinellas', 'Pasco', 'Polk', 'Manatee', 'Lee'];
const PREMIUMS = ['0', '12.40', '19.90', '24.50', '31.20', '38.70', '45'];
const DEDUCTIBLES = ['0', '250', '405', '530'];
const MOOPS = ['4700', '5500', '6000', '6600', '8300'];

/** Small deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

// Hand-placed "hero" cases so each contract has something to say.
const TIMER_PASS_ORDERING_FAIL = new Set([7, 19, 33]); // disclaimer at 45s, benefits at 30s
const TIMER_FAIL_ORDERING_PASS = new Set([12, 17, 48]); // disclaimer at 78s, benefits at 103s
const NO_DISCLAIMER = new Set([26]);
const SOA_INSIDE_48H = new Map<number, number>([
  [4, 20],
  [15, 6],
  [29, 30],
  [31, 2],
  [41, 12],
]);
const SOA_EXCEPTION = new Map<number, SoaException>([
  [9, 'walk_in'],
  [52, 'last_four_days'],
]);
const SUPERLATIVE = new Set([3, 22, 43]);
const MBI_READBACK = new Set([11, 51]);

export function scenarioFor(index: number): Scenario {
  const rand = prng(1000 + index * 7919);
  const code = `T${String(index).padStart(3, '0')}`;
  const product_line: Scenario['product_line'] = index % 9 === 0 ? 'MEDIGAP' : index % 4 === 0 ? 'PDP' : 'MA';

  let disclaimerAt: number | null = 25 + Math.floor(rand() * 25); // 25–49s, inside both bases
  let benefitsAt = 95 + Math.floor(rand() * 40); // 95–134s
  if (TIMER_PASS_ORDERING_FAIL.has(index)) {
    disclaimerAt = 45;
    benefitsAt = 30;
  } else if (TIMER_FAIL_ORDERING_PASS.has(index)) {
    disclaimerAt = 78;
    benefitsAt = 103;
  } else if (NO_DISCLAIMER.has(index)) {
    disclaimerAt = null;
  }

  const soaException = SOA_EXCEPTION.get(index) ?? null;
  const soaHours = SOA_INSIDE_48H.get(index) ?? (soaException ? 6 : 50 + Math.floor(rand() * 96));
  const duration = 150 + Math.floor(rand() * 120);

  return {
    index,
    code,
    product_line,
    agent: pick(rand, AGENTS),
    customer: pick(rand, CUSTOMERS),
    carrier: pick(rand, CARRIERS),
    county: pick(rand, COUNTIES),
    disclaimerAt,
    benefitsAt,
    soaHours,
    soaException,
    disclaimerWording: index % 3 === 0 ? 1 : 2,
    premium: pick(rand, PREMIUMS),
    deductible: pick(rand, DEDUCTIBLES),
    moop: pick(rand, MOOPS),
    superlative: SUPERLATIVE.has(index),
    recordingNoticeAt: index % 13 === 5 ? null : 10,
    mbiReadBack: MBI_READBACK.has(index),
    duration,
  };
}

/** "[mm:ss]" — the format the backend's synthetic corpus uses. */
export function ts(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`;
}

export const DISCLAIMER_V1 =
  'We do not offer every plan available in your area. Currently we represent 26 organizations which offer 3,740 products in your area. Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program to get information on all of your options.';
export const DISCLAIMER_V2 =
  'We do not offer every plan available in your area. Currently we represent 26 organizations which offer 3,740 products in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options.';

export interface TranscriptLines {
  text: string;
  sentences: {
    disclaimer: string | null;
    recordingNotice: string | null;
    benefits: string;
    soa: string;
    superlative: string | null;
  };
}

export function buildTranscript(sc: Scenario): TranscriptLines {
  const lines: Array<[number, string, string]> = [];
  const productWord = sc.product_line === 'MA' ? 'Medicare Advantage' : sc.product_line === 'PDP' ? 'Part D' : 'Medicare Supplement';

  lines.push([0, 'AGENT', `Thanks for calling Elite Insurance Partners, this is ${sc.agent}. Am I speaking with ${sc.customer}?`]);
  lines.push([6, 'CUSTOMER', `Yes, this is ${sc.customer.split(' ')[1]}.`]);

  const recordingNotice = sc.recordingNoticeAt === null ? null : 'Great. Before we start, this call is being recorded for quality and compliance.';
  if (recordingNotice && sc.recordingNoticeAt !== null) lines.push([sc.recordingNoticeAt, 'AGENT', recordingNotice]);
  lines.push([16, 'CUSTOMER', "That's fine."]);
  lines.push([19, 'AGENT', 'One quick request: can I get your ZIP code so I can pull up the plans in your area?']);
  lines.push([23, 'CUSTOMER', '33602.']);

  const disclaimer = sc.disclaimerAt === null ? null : sc.disclaimerWording === 1 ? DISCLAIMER_V1 : DISCLAIMER_V2;
  if (disclaimer && sc.disclaimerAt !== null) lines.push([sc.disclaimerAt, 'AGENT', disclaimer]);

  const benefits = `The ${sc.carrier} plan available in ${sc.county} County has a $${sc.premium} monthly premium, a $${sc.deductible} drug deductible and a $${sc.moop} maximum out-of-pocket.`;
  lines.push([sc.benefitsAt, 'AGENT', `Let's talk about what the ${productWord} plan covers. ${benefits}`]);
  lines.push([sc.benefitsAt + 14, 'CUSTOMER', 'Does it cover my cardiologist at Tampa General?']);
  lines.push([sc.benefitsAt + 20, 'AGENT', 'Tampa General is in network for that plan, and your cardiologist is listed as accepting new patients.']);

  const superlative = sc.superlative ? `Honestly, this is the best plan in ${sc.county} County for someone in your situation.` : null;
  if (superlative) lines.push([sc.benefitsAt + 30, 'AGENT', superlative]);

  let soa: string;
  if (sc.soaException === 'walk_in') {
    soa = `Since you walked in today, we can go over plans right away — I have your Scope of Appointment from ${sc.soaHours} hours ago and the walk-in exception applies.`;
  } else if (sc.soaException === 'last_four_days') {
    soa = `You signed the Scope of Appointment ${sc.soaHours} hours ago, and because we are inside the last four days of the election period we can meet today.`;
  } else {
    soa = `I have your Scope of Appointment on file — you signed it ${sc.soaHours} hours before this appointment, covering ${productWord}.`;
  }
  lines.push([sc.benefitsAt + 42, 'AGENT', soa]);
  lines.push([sc.benefitsAt + 55, 'CUSTOMER', 'That works. What happens next?']);

  if (sc.mbiReadBack) {
    lines.push([sc.benefitsAt + 62, 'AGENT', 'Let me read back your Medicare number, 1EG4-TE5-MK73, to make sure I have it right.']);
    lines.push([sc.benefitsAt + 70, 'CUSTOMER', 'That is correct.']);
  }

  lines.push([sc.benefitsAt + 78, 'AGENT', `I'll send the enrollment summary to your email and a copy to your ${sc.county} County address on file. Anything else I can help with today?`]);
  lines.push([sc.benefitsAt + 88, 'CUSTOMER', "No, that's everything. Thank you."]);
  lines.push([sc.duration - 5, 'AGENT', `Thank you for calling Elite Insurance Partners, ${sc.customer}. Have a great day.`]);

  lines.sort((a, b) => a[0] - b[0]);
  const text = lines.map(([t, who, what]) => `${ts(t)} ${who}: ${what}`).join('\n');
  return { text, sentences: { disclaimer, recordingNotice, benefits, soa, superlative } };
}

export function transcriptOut(sc: Scenario, withText: boolean): TranscriptOut {
  const built = buildTranscript(sc);
  return {
    id: `transcript-${sc.code}`,
    code: sc.code,
    product_line: sc.product_line,
    synthetic: true,
    duration_seconds: sc.duration,
    labels: {
      scenario: sc.superlative ? 'C' : sc.soaHours < 48 ? 'B' : 'A',
      product_line: sc.product_line,
      carrier: sc.carrier,
      agent: sc.agent,
      customer: sc.customer,
      county: sc.county,
      disclaimer_delivered: sc.disclaimerAt !== null,
      disclaimer_seconds: sc.disclaimerAt,
      disclaimer_text: built.sentences.disclaimer,
      benefits_started_seconds: sc.benefitsAt,
      benefits_text: built.sentences.benefits,
      soa_collected: true,
      appointment_scheduled: true,
      appointment_hours_after_soa: sc.soaHours,
      soa_exception: sc.soaException,
      superlatives: sc.superlative ? [`the best plan in ${sc.county} County`] : [],
      numeric_claims: [
        { value: `$${sc.premium}`, context: 'monthly premium' },
        { value: `$${sc.deductible}`, context: 'drug deductible' },
        { value: `$${sc.moop}`, context: 'maximum out-of-pocket' },
      ],
      pii: sc.mbiReadBack ? ['medicare_number'] : [],
      duration_seconds: sc.duration,
    },
    text: withText ? built.text : null,
  };
}

export const SCENARIOS: Scenario[] = Array.from({ length: CORPUS_SIZE }, (_, i) => scenarioFor(i + 1));

export function findScenario(code: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.code === code);
}

// ------------------------------------------------------------- ingested samples

/** Ingested (Attention → Snowflake export) transcripts: real-shaped, redacted, no ground truth. */
export interface IngestedSample {
  code: string;
  product_line: 'MA' | 'PDP' | 'MEDIGAP';
  agent: string;
  started_at: string;
  duration: number;
  redacted: { medicare_number: number; ssn: number; dob: number };
  text: string;
}

export const INGESTED: IngestedSample[] = [
  {
    code: 'A-SAMPLE-0001',
    product_line: 'MA',
    agent: 'Dana',
    started_at: '2026-10-02T14:03:11Z',
    duration: 171,
    redacted: { medicare_number: 1, ssn: 0, dob: 0 },
    text:
      "[00:00:00] AGENT: Thanks for calling Elite Insurance Partners, this is Dana. [00:00:06] CUSTOMER: Hi, I'm looking at plans for next year. [00:00:12] AGENT: Before we go further: We do not offer every plan available in your area. Currently we represent 26 organizations which offer 3,740 products in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options. [00:00:31] CUSTOMER: Okay. [00:00:34] AGENT: Can I confirm your Medicare number? [00:00:39] CUSTOMER: It's [REDACTED-MBI]. [00:00:46] AGENT: Thank you. The Humana plan in Hillsborough County has a $0 monthly premium and a $6600 maximum out-of-pocket. [00:01:20] CUSTOMER: What about my cardiologist? [00:01:26] AGENT: In network. I'll send the Scope of Appointment to your email now so we can go over specific plans. [00:02:40] CUSTOMER: Sounds good. [00:02:46] AGENT: Thank you for calling, have a great day.",
  },
  {
    code: 'A-SAMPLE-0002',
    product_line: 'MEDIGAP',
    agent: 'Marcus',
    started_at: '2026-10-02T15:41:57Z',
    duration: 96,
    redacted: { medicare_number: 0, ssn: 0, dob: 1 },
    text:
      "[00:00:00] AGENT: Elite Insurance Partners, this is Marcus. [00:00:04] CUSTOMER: I want to compare Medigap Plan G and Plan N. [00:00:10] AGENT: Happy to. Your date of birth for the quote? [00:00:14] CUSTOMER: [REDACTED-DOB]. [00:00:19] AGENT: Plan G in Pinellas County runs $158 a month with the Part B deductible; Plan N is $121 with small office copays. [00:00:58] CUSTOMER: Let me think about it. [00:01:30] AGENT: I'll email both quotes. Thank you for calling.",
  },
];

export function ingestedOut(sample: IngestedSample, withText: boolean): TranscriptOut {
  return {
    id: `transcript-${sample.code}`,
    code: sample.code,
    product_line: sample.product_line,
    synthetic: false,
    duration_seconds: sample.duration,
    labels: {
      ingested: true,
      format: 'attention-snowflake',
      agent: sample.agent,
      started_at: sample.started_at,
      ground_truth: null,
      redacted: sample.redacted,
    },
    text: withText ? sample.text : null,
  };
}
