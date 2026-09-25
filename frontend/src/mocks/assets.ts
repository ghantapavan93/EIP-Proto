import type { AssetDetailOut, AssetVersionOut, EdgeOut } from '../api/types';

/**
 * Artifact inventory. Real public pages are attributed by URL and carry a
 * frozen snapshot excerpt (fetch_mode "snapshot"); everything internal is
 * labeled SYNTHETIC. Edge span offsets are computed against content_text so
 * the highlighter is always consistent with the evidence span.
 */

const SNAP_1 = '2026-09-19T21:14:07Z';
const SNAP_2 = '2026-09-21T13:40:52Z';

function hash(seed: string): string {
  // deterministic 64-hex-ish digest for fixtures (not cryptographic)
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 8; i++) {
    h1 = Math.imul(h1 ^ (h1 >>> 13), 0x5bd1e995) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 15), 0x27d4eb2f) >>> 0;
    out += (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

interface AssetSeed {
  code: string;
  type: string;
  name: string;
  url: string | null;
  source_system: string;
  owner_role: string;
  is_synthetic: boolean;
  content_text: string;
  /** earlier versions (hash only) to make the versions list interesting */
  history?: number;
}

interface EdgeSeed {
  id: string;
  asset: string;
  rule: string;
  version: number;
  polarity: 'ENFORCES' | 'PERMITS' | 'INFORMS';
  span: string;
  detection: 'deterministic' | 'llm' | 'manual';
  matcher: string;
  confidence: number | null;
  status: 'proposed' | 'confirmed' | 'rejected';
  confirmed_by: string | null;
}

const ASSET_SEEDS: AssetSeed[] = [
  // ------------------------------------------------------------ real pages
  {
    code: 'web-medicarefaq-soa',
    type: 'web_page',
    name: 'medicarefaq.com/faqs/scope-of-appointment/',
    url: 'https://www.medicarefaq.com/faqs/scope-of-appointment/',
    source_system: 'vercel',
    owner_role: 'AI Enablement',
    is_synthetic: false,
    history: 2,
    content_text:
      'What is a Scope of Appointment? A Scope of Appointment (SOA) is a form that documents which Medicare products a beneficiary agrees to discuss with a licensed agent before a personal marketing appointment. CMS requires the form so that the conversation stays inside the products you asked about. When do I need to sign it? Your agent must collect the SOA before the appointment; the standard expectation is 48 hours in advance, although walk-ins and beneficiaries within the last four days of an election period can be seen the same day. What products does it cover? Medicare Advantage (MA), Part D (PDP), and, where your agent is appointed, Medicare Supplement (Medigap) plans. The SOA does not obligate you to enroll in anything.',
  },
  {
    code: 'web-medicarefaq-recording',
    type: 'web_page',
    name: 'medicarefaq.com/faqs/why-are-medicare-calls-recorded/',
    url: 'https://www.medicarefaq.com/faqs/why-are-medicare-calls-recorded/',
    source_system: 'vercel',
    owner_role: 'AI Enablement',
    is_synthetic: false,
    history: 1,
    content_text:
      'Why is my Medicare call being recorded? CMS requires third-party marketing organizations to record all marketing and sales calls with Medicare beneficiaries in their entirety, including calls that happen over web-based technology. How long are recordings kept? Under the current rule, recordings are kept for 10 years so that CMS and the carriers can audit what was said. Can I opt out? You can decline to continue the call, but an agent cannot enroll you in a Medicare Advantage or Part D plan on an unrecorded sales call.',
  },
  {
    code: 'web-medicarefaq-best-plans',
    type: 'web_page',
    name: 'medicarefaq.com/medicare-advantage/best-plans/',
    url: 'https://www.medicarefaq.com/medicare-advantage/best-plans/',
    source_system: 'vercel',
    owner_role: 'AI Enablement',
    is_synthetic: false,
    content_text:
      'Which Medicare Advantage plan is best? There is no single best plan for everyone, and CMS rules do not allow us to call any plan the best unless we can back that up with current or prior-year data. Instead, compare plans on the things that matter to you: the provider network, drug formulary, maximum out-of-pocket, and star rating. A licensed agent can pull every plan available in your ZIP code and walk through the trade-offs.',
  },
  {
    code: 'web-eip-tpmo-footer',
    type: 'web_page',
    name: 'elitemedicarepartners.com — footer TPMO disclaimer',
    url: 'https://www.elitemedicarepartners.com/',
    source_system: 'wordpress',
    owner_role: 'AI Enablement',
    is_synthetic: false,
    history: 1,
    content_text:
      'We do not offer every plan available in your area. Currently we represent 12 organizations which offer 48 products in your area. Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program (SHIP) to get information on all of your options. Elite Insurance Partners LLC is a licensed and certified representative of Medicare Advantage HMO, PPO and PFFS organizations and stand-alone prescription drug plans with a Medicare contract. Enrollment depends on contract renewal.',
  },
  {
    code: 'web-eip-privacy',
    type: 'web_page',
    name: 'elitemedicarepartners.com/privacy — call recording notice',
    url: 'https://www.elitemedicarepartners.com/privacy-policy/',
    source_system: 'wordpress',
    owner_role: 'AI Enablement',
    is_synthetic: false,
    content_text:
      'Call recording. All inbound and outbound marketing and sales calls are recorded and retained for a minimum of ten years in accordance with CMS requirements for third-party marketing organizations. By continuing a call you consent to the recording. Recordings are stored in encrypted form and are made available to carriers and CMS on request.',
  },
  {
    code: 'web-medicarefaq-events',
    type: 'web_page',
    name: 'medicarefaq.com/faqs/medicare-educational-events/',
    url: 'https://www.medicarefaq.com/faqs/medicare-educational-events/',
    source_system: 'vercel',
    owner_role: 'AI Enablement',
    is_synthetic: false,
    content_text:
      'What happens at a Medicare educational event? Educational events explain how Medicare works without steering you toward a specific plan. Agents cannot collect a Scope of Appointment form at an educational event, and a marketing event cannot start within 12 hours of an educational event held at the same location. If you want to talk about a specific plan, ask for a separate appointment.',
  },
  // ------------------------------------------------------------ synthetic
  {
    code: 'sc-12',
    type: 'scorecard_item',
    name: 'Attention scorecard item SC-12 — appointment ≥48h after SOA',
    url: null,
    source_system: 'attention (synthetic)',
    owner_role: 'QA Compliance Analyst',
    is_synthetic: true,
    history: 1,
    content_text:
      'SC-12 · Scope of Appointment timing · weight 4. Score YES when the agent confirms the appointment scheduled at least 48 hours after SOA documented, or when a valid exception (walk-in, last four days of an election period) is stated on the call. Score NO when the appointment occurs sooner than 48 hours without an exception. Auto-coach text: "Remind the beneficiary that we need the Scope of Appointment on file two full days before we meet."',
  },
  {
    code: 'sc-03',
    type: 'scorecard_item',
    name: 'Attention scorecard item SC-03 — TPMO disclaimer within first minute',
    url: null,
    source_system: 'attention (synthetic)',
    owner_role: 'QA Compliance Analyst',
    is_synthetic: true,
    content_text:
      'SC-03 · TPMO disclaimer · weight 5. Score YES when the full TPMO disclaimer is delivered within the first 60 seconds of the call. Score NO when the disclaimer is late, partial, or missing. Auto-coach text: "Lead with the disclaimer — it has to land inside the first minute."',
  },
  {
    code: 'sc-21',
    type: 'scorecard_item',
    name: 'Attention scorecard item SC-21 — superlatives without substantiation',
    url: null,
    source_system: 'attention (synthetic)',
    owner_role: 'QA Compliance Analyst',
    is_synthetic: true,
    content_text:
      'SC-21 · Marketing language · weight 2. Score NO when the agent uses a superlative ("best", "top", "most") without citing supporting data from the current or prior contract year. Score YES otherwise. Auto-coach text: "Describe the benefit, not the ranking."',
  },
  {
    code: 'script-intro-03',
    type: 'script_section',
    name: 'Agent script INTRO-03',
    url: null,
    source_system: 'lms (synthetic)',
    owner_role: 'Training Supervisor',
    is_synthetic: true,
    history: 2,
    content_text:
      'INTRO-03 · Opening. "Thank you for calling Elite Insurance Partners, this is [agent], a Licensed Agent. This call is recorded for quality and compliance." Deliver the TPMO disclaimer within the first minute, before you ask any qualifying questions: "We do not offer every plan available in your area. Currently we represent 12 organizations which offer 48 products in your area. Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program to get information on all of your options." Then confirm the beneficiary\'s name and ZIP code.',
  },
  {
    code: 'script-close-07',
    type: 'script_section',
    name: 'Agent script CLOSE-07 — SOA reminder',
    url: null,
    source_system: 'lms (synthetic)',
    owner_role: 'Training Supervisor',
    is_synthetic: true,
    content_text:
      'CLOSE-07 · Scheduling the appointment. "I\'ll send the Scope of Appointment now. Because of CMS rules we\'ll need to wait 48 hours before we can meet to go over specific plans, so let\'s look at [day after tomorrow]." If the beneficiary is within the last four days of an election period, use CLOSE-07b instead.',
  },
  {
    code: 'sfmc-appt-confirm-04',
    type: 'email_template',
    name: 'SFMC template APPT-CONFIRM-04',
    url: null,
    source_system: 'sfmc (synthetic)',
    owner_role: 'Sales Supervisor',
    is_synthetic: true,
    history: 1,
    content_text:
      'Subject: Your Medicare appointment with %%agent_name%% is confirmed. Hi %%first_name%%, thanks for completing your Scope of Appointment. Your appointment is set for no sooner than 48 hours after we received your Scope of Appointment, on %%appt_date%% at %%appt_time%%. Your Licensed Agent will only discuss the products you selected on the form. Need to reschedule? Reply to this email or call %%agent_phone%%.',
  },
  {
    code: 'slide-11',
    type: 'training_slide',
    name: 'Training slide 11 — recordings retained 10 years',
    url: null,
    source_system: 'lms (synthetic)',
    owner_role: 'Training Supervisor',
    is_synthetic: true,
    content_text:
      'Slide 11 · Call recording. Every marketing and sales call is recorded end to end — including the audio of video calls. Recordings are retained for 10 years and can be pulled by any carrier or by CMS. Never pause the recording. Never take a sales call on a personal phone.',
  },
  {
    code: 'slide-08',
    type: 'training_slide',
    name: 'Training slide 8 — SOA timeline',
    url: null,
    source_system: 'lms (synthetic)',
    owner_role: 'Training Supervisor',
    is_synthetic: true,
    content_text:
      'Slide 8 · The SOA timeline. Day 0: beneficiary signs the Scope of Appointment (e-sign, recorded verbal, or paper). Day 2: earliest personal marketing appointment — the 48-hour clock starts when the SOA is documented, not when it is requested. Exceptions: walk-ins; last four days of an election period.',
  },
  {
    code: 'ivr-inbound-01',
    type: 'ivr_script',
    name: 'IVR script INBOUND-01 — recording notice',
    url: null,
    source_system: 'telephony (synthetic)',
    owner_role: 'Sales Supervisor',
    is_synthetic: true,
    content_text:
      'INBOUND-01. "Thank you for calling Elite Insurance Partners. This call may be recorded and retained for ten years for quality and compliance purposes. To speak with a Licensed Agent about Medicare Advantage or Part D, press 1. For Medicare Supplement, press 2."',
  },
  {
    code: 'coach-sup-02',
    type: 'coaching_prompt',
    name: 'Coaching prompt COACH-SUP-02 — superlative language',
    url: null,
    source_system: 'attention (synthetic)',
    owner_role: 'AI Enablement',
    is_synthetic: true,
    content_text:
      'COACH-SUP-02. You are writing a one-paragraph coaching note for a Licensed Agent. Coach the agent to avoid words like "best" or "top-rated" unless carrier data is cited on the call. Quote the exact sentence the agent used, then suggest a benefit-based rephrasing. Keep it to 80 words.',
  },
  {
    code: 'prompt-qa-handoff-v1',
    type: 'workflow_prompt',
    name: 'Workflow prompt qa-handoff v1',
    url: null,
    source_system: 'backstop',
    owner_role: 'AI Enablement',
    is_synthetic: true,
    content_text:
      'You are the QA handoff assistant for Elite Insurance Partners. Read the call transcript and produce JSON with keys extraction, composition. Compliance judgments: Flag the call if the TPMO disclaimer was not delivered within the first 60 seconds. Flag any appointment scheduled less than 48 hours after the SOA was documented unless a walk-in or last-four-days exception is stated. Flag superlatives ("best", "top") that are not backed by cited data. Every numeric claim in the summary must quote the transcript span it came from. Never include a Medicare number or SSN in the CRM record.',
  },
  {
    code: 'prompt-qa-handoff-v2',
    type: 'workflow_prompt',
    name: 'Workflow prompt qa-handoff v2',
    url: null,
    source_system: 'backstop',
    owner_role: 'AI Enablement',
    is_synthetic: true,
    content_text:
      'You are the QA handoff assistant for Elite Insurance Partners. Read the call transcript and produce JSON with keys extraction, composition. Compliance judgments (CY2027, effective 2026-10-01): Flag the call if the TPMO disclaimer was delivered after the agent began discussing any benefits, or was not delivered at all. The SOA must be documented before the appointment; there is no minimum waiting period. Superlatives are permitted; flag only statements that are materially inaccurate or misleading. Every numeric claim in the summary must quote the transcript span it came from. Never include a Medicare number or SSN in the CRM record.',
  },
  {
    code: 'web-eip-home',
    type: 'web_page',
    name: 'elitemedicarepartners.com — home page hero',
    url: 'https://www.elitemedicarepartners.com/',
    source_system: 'wordpress',
    owner_role: 'AI Enablement',
    is_synthetic: false,
    content_text:
      'Medicare made simple. Compare Medicare Advantage, Part D and Medicare Supplement plans from the carriers we represent in all 50 states, with help from a Licensed Agent at no cost to you. We do not offer every plan available in your area. Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program to get information on all of your options.',
  },
];

const EDGE_SEEDS: EdgeSeed[] = [
  // soa-48h-wait v1 — REMOVES_REQUIREMENT on Oct 1 → ENFORCES: over_restrictive; PERMITS/INFORMS: reverify
  {
    id: 'edge-001',
    asset: 'web-medicarefaq-soa',
    rule: 'soa-48h-wait',
    version: 1,
    polarity: 'ENFORCES',
    span: 'the standard expectation is 48 hours in advance',
    detection: 'deterministic',
    matcher: 'regex:48[- ]hours?',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-002',
    asset: 'web-medicarefaq-soa',
    rule: 'soa-48h-wait',
    version: 1,
    polarity: 'PERMITS',
    span: 'walk-ins and beneficiaries within the last four days of an election period can be seen the same day',
    detection: 'llm',
    matcher: 'llm:exception-clause',
    confidence: 0.91,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-003',
    asset: 'sc-12',
    rule: 'soa-48h-wait',
    version: 1,
    polarity: 'ENFORCES',
    span: 'appointment scheduled at least 48 hours after SOA documented',
    detection: 'deterministic',
    matcher: 'regex:48[- ]hours?',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-004',
    asset: 'sfmc-appt-confirm-04',
    rule: 'soa-48h-wait',
    version: 1,
    polarity: 'ENFORCES',
    span: 'no sooner than 48 hours after we received your Scope of Appointment',
    detection: 'deterministic',
    matcher: 'regex:48[- ]hours?',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'engineer',
  },
  {
    id: 'edge-005',
    asset: 'script-close-07',
    rule: 'soa-48h-wait',
    version: 1,
    polarity: 'ENFORCES',
    span: "we'll need to wait 48 hours before we can meet",
    detection: 'deterministic',
    matcher: 'regex:48[- ]hours?',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-006',
    asset: 'prompt-qa-handoff-v1',
    rule: 'soa-48h-wait',
    version: 1,
    polarity: 'ENFORCES',
    span: 'Flag any appointment scheduled less than 48 hours after the SOA was documented',
    detection: 'deterministic',
    matcher: 'regex:48[- ]hours?',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'engineer',
  },
  {
    id: 'edge-007',
    asset: 'slide-08',
    rule: 'soa-48h-wait',
    version: 1,
    polarity: 'INFORMS',
    span: 'the 48-hour clock starts when the SOA is documented',
    detection: 'deterministic',
    matcher: 'regex:48[- ]hours?',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  // soa-48h-wait v2 — healthy edge
  {
    id: 'edge-008',
    asset: 'prompt-qa-handoff-v2',
    rule: 'soa-48h-wait',
    version: 2,
    polarity: 'ENFORCES',
    span: 'The SOA must be documented before the appointment; there is no minimum waiting period.',
    detection: 'manual',
    matcher: 'manual',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'engineer',
  },
  // tpmo-disclaimer-timing v1 — MODIFIES → reverify
  {
    id: 'edge-010',
    asset: 'sc-03',
    rule: 'tpmo-disclaimer-timing',
    version: 1,
    polarity: 'ENFORCES',
    span: 'delivered within the first 60 seconds of the call',
    detection: 'deterministic',
    matcher: 'regex:first (60 seconds|minute)',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-011',
    asset: 'script-intro-03',
    rule: 'tpmo-disclaimer-timing',
    version: 1,
    polarity: 'ENFORCES',
    span: 'within the first minute',
    detection: 'deterministic',
    matcher: 'regex:first (60 seconds|minute)',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-012',
    asset: 'prompt-qa-handoff-v1',
    rule: 'tpmo-disclaimer-timing',
    version: 1,
    polarity: 'ENFORCES',
    span: 'Flag the call if the TPMO disclaimer was not delivered within the first 60 seconds.',
    detection: 'deterministic',
    matcher: 'regex:first (60 seconds|minute)',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'engineer',
  },
  {
    id: 'edge-013',
    asset: 'prompt-qa-handoff-v2',
    rule: 'tpmo-disclaimer-timing',
    version: 2,
    polarity: 'ENFORCES',
    span: 'Flag the call if the TPMO disclaimer was delivered after the agent began discussing any benefits',
    detection: 'manual',
    matcher: 'manual',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'engineer',
  },
  // call-recording-retention v1 — LOOSENS (disputed v2) → over_restrictive, disputed
  {
    id: 'edge-020',
    asset: 'web-medicarefaq-recording',
    rule: 'call-recording-retention',
    version: 1,
    polarity: 'ENFORCES',
    span: 'recordings are kept for 10 years',
    detection: 'deterministic',
    matcher: 'regex:(10|ten) years',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-021',
    asset: 'web-eip-privacy',
    rule: 'call-recording-retention',
    version: 1,
    polarity: 'ENFORCES',
    span: 'retained for a minimum of ten years',
    detection: 'deterministic',
    matcher: 'regex:(10|ten) years',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-022',
    asset: 'slide-11',
    rule: 'call-recording-retention',
    version: 1,
    polarity: 'ENFORCES',
    span: 'Recordings are retained for 10 years',
    detection: 'deterministic',
    matcher: 'regex:(10|ten) years',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-023',
    asset: 'ivr-inbound-01',
    rule: 'call-recording-retention',
    version: 1,
    polarity: 'ENFORCES',
    span: 'retained for ten years',
    detection: 'deterministic',
    matcher: 'regex:(10|ten) years',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'engineer',
  },
  // superlatives v1 — LOOSENS → over_restrictive
  {
    id: 'edge-030',
    asset: 'web-medicarefaq-best-plans',
    rule: 'superlatives',
    version: 1,
    polarity: 'ENFORCES',
    span: 'CMS rules do not allow us to call any plan the best unless we can back that up with current or prior-year data',
    detection: 'llm',
    matcher: 'llm:superlative-policy',
    confidence: 0.87,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-031',
    asset: 'sc-21',
    rule: 'superlatives',
    version: 1,
    polarity: 'ENFORCES',
    span: 'without citing supporting data from the current or prior contract year',
    detection: 'deterministic',
    matcher: 'regex:supporting data',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-032',
    asset: 'coach-sup-02',
    rule: 'superlatives',
    version: 1,
    polarity: 'ENFORCES',
    span: 'avoid words like "best" or "top-rated" unless carrier data is cited',
    detection: 'llm',
    matcher: 'llm:superlative-policy',
    confidence: 0.79,
    status: 'confirmed',
    confirmed_by: 'engineer',
  },
  {
    id: 'edge-033',
    asset: 'prompt-qa-handoff-v1',
    rule: 'superlatives',
    version: 1,
    polarity: 'ENFORCES',
    span: 'Flag superlatives ("best", "top") that are not backed by cited data.',
    detection: 'deterministic',
    matcher: 'regex:superlative',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'engineer',
  },
  {
    id: 'edge-034',
    asset: 'prompt-qa-handoff-v2',
    rule: 'superlatives',
    version: 2,
    polarity: 'PERMITS',
    span: 'Superlatives are permitted; flag only statements that are materially inaccurate or misleading.',
    detection: 'manual',
    matcher: 'manual',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'engineer',
  },
  // tpmo-disclaimer-text v1 — CLARIFIES → reverify
  {
    id: 'edge-040',
    asset: 'web-eip-tpmo-footer',
    rule: 'tpmo-disclaimer-text',
    version: 1,
    polarity: 'ENFORCES',
    span: 'or your local State Health Insurance Program (SHIP)',
    detection: 'deterministic',
    matcher: 'regex:State Health Insurance Program',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-041',
    asset: 'script-intro-03',
    rule: 'tpmo-disclaimer-text',
    version: 1,
    polarity: 'ENFORCES',
    span: 'or your local State Health Insurance Program to get information on all of your options',
    detection: 'deterministic',
    matcher: 'regex:State Health Insurance Program',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-042',
    asset: 'web-eip-home',
    rule: 'tpmo-disclaimer-text',
    version: 1,
    polarity: 'ENFORCES',
    span: 'Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program',
    detection: 'llm',
    matcher: 'llm:disclaimer-wording',
    confidence: 0.83,
    status: 'proposed',
    confirmed_by: null,
  },
  // soa-educational-events v1 — REMOVES_REQUIREMENT → over_restrictive
  {
    id: 'edge-050',
    asset: 'web-medicarefaq-events',
    rule: 'soa-educational-events',
    version: 1,
    polarity: 'ENFORCES',
    span: 'Agents cannot collect a Scope of Appointment form at an educational event',
    detection: 'llm',
    matcher: 'llm:educational-event-policy',
    confidence: 0.9,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  // eip-recording-notice v1 — ADDS_REQUIREMENT → under_restrictive
  {
    id: 'edge-060',
    asset: 'script-intro-03',
    rule: 'eip-recording-notice',
    version: 1,
    polarity: 'ENFORCES',
    span: 'This call is recorded for quality and compliance.',
    detection: 'deterministic',
    matcher: 'regex:call is recorded',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
  {
    id: 'edge-061',
    asset: 'ivr-inbound-01',
    rule: 'eip-recording-notice',
    version: 1,
    polarity: 'ENFORCES',
    span: 'This call may be recorded and retained for ten years for quality and compliance purposes.',
    detection: 'deterministic',
    matcher: 'regex:call may be recorded',
    confidence: null,
    status: 'confirmed',
    confirmed_by: 'analyst',
  },
];

function buildVersions(seed: AssetSeed): AssetVersionOut[] {
  const versions: AssetVersionOut[] = [];
  const history = seed.history ?? 0;
  for (let i = history; i >= 1; i--) {
    versions.push({
      id: `av-${seed.code}-${i}`,
      content_hash: hash(`${seed.code}:v${i}`),
      fetched_at: i === history ? SNAP_1 : `2026-09-1${i}T09:00:00Z`,
      fetch_mode: 'snapshot',
      length: seed.content_text.length - 40 * i,
    });
  }
  versions.push({
    id: `av-${seed.code}-latest`,
    content_hash: hash(`${seed.code}:latest`),
    fetched_at: SNAP_2,
    fetch_mode: seed.is_synthetic ? 'seed' : 'snapshot',
    length: seed.content_text.length,
  });
  return versions;
}

export const ASSETS: AssetDetailOut[] = ASSET_SEEDS.map((seed) => {
  const versions = buildVersions(seed);
  const latest = versions[versions.length - 1];
  return {
    id: `asset-${seed.code}`,
    code: seed.code,
    type: seed.type,
    name: seed.name,
    url: seed.url,
    source_system: seed.source_system,
    owner_role: seed.owner_role,
    is_synthetic: seed.is_synthetic,
    latest_hash: latest.content_hash,
    latest_fetched_at: latest.fetched_at,
    edge_count: 0,
    versions,
    content_text: seed.content_text,
    edges: [],
  };
});

const assetByCode = new Map(ASSETS.map((a) => [a.code, a]));

export const EDGES: EdgeOut[] = EDGE_SEEDS.map((e) => {
  const asset = assetByCode.get(e.asset);
  if (!asset) throw new Error(`mock edge ${e.id}: unknown asset ${e.asset}`);
  const offset = asset.content_text.indexOf(e.span);
  if (offset < 0) throw new Error(`mock edge ${e.id}: span not found in ${e.asset}`);
  return {
    id: e.id,
    rule_version_id: `rv-${e.rule}-${e.version}`,
    rule_version: e.version,
    rule_code: e.rule,
    asset_id: asset.id,
    asset_code: asset.code,
    asset_name: asset.name,
    asset_type: asset.type,
    asset_url: asset.url,
    asset_is_synthetic: asset.is_synthetic,
    owner_role: asset.owner_role,
    polarity: e.polarity,
    evidence_span: e.span,
    span_offset: offset,
    detection: e.detection,
    matcher: e.matcher,
    confidence: e.confidence,
    status: e.status,
    confirmed_by: e.confirmed_by,
    created_at: e.status === 'proposed' ? SNAP_2 : SNAP_1,
  };
});

for (const asset of ASSETS) {
  asset.edges = EDGES.filter((e) => e.asset_code === asset.code);
  asset.edge_count = asset.edges.length;
}

export function findAsset(code: string): AssetDetailOut | undefined {
  return assetByCode.get(code);
}

export { hash as fixtureHash };
