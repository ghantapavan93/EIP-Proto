import type { ContractOut, ModelBoardOut, ModelBoardRow, ModelOut, PromptVersionOut, RuleVersionRef, RunOut, WorkflowOut } from '../api/types';
import { findAsset } from './assets';

export const CONTRACTS: ContractOut[] = [
  {
    id: 'contract-c-tpmo-01',
    code: 'C-TPMO-01',
    title: 'TPMO disclaimer judged under the in-force timing basis',
    description:
      "The workflow's TPMO-compliance judgment must equal the deterministic ground truth for the rule version in force on the run's rule date: timer (60s) before 2026-10-01, ordering (before any benefits discussion) from 2026-10-01.",
    kind: 'DETERMINISTIC',
    severity: 'BLOCK',
    owner_role: 'QA Compliance Analyst',
    check: 'tpmo_timing_matches_rule',
    rule_code: 'tpmo-disclaimer-timing',
    version: 2,
    spec: { field: 'extraction.tpmo_disclaimer.compliant', basis_from_rule_params: true },
    judge_model_id: null,
    n_runs: null,
  },
  {
    id: 'contract-c-soa-01',
    code: 'C-SOA-01',
    title: 'SOA timing judged under the in-force waiting period',
    description:
      'An appointment-timing violation may be flagged only when the hours between SOA documentation and the appointment are below the in-force minimum (48 before 2026-10-01; 0 from 2026-10-01). SOA presence is always required.',
    kind: 'DETERMINISTIC',
    severity: 'BLOCK',
    owner_role: 'QA Compliance Analyst',
    check: 'soa_timing_matches_rule',
    rule_code: 'soa-48h-wait',
    version: 2,
    spec: { field: 'extraction.soa.compliant', param: 'min_hours_between_soa_and_appointment' },
    judge_model_id: null,
    n_runs: null,
  },
  {
    id: 'contract-c-fact-01',
    code: 'C-FACT-01',
    title: 'Numeric claims must appear in the transcript',
    description:
      'Every number in the summary and CRM record (premiums, copays, counts, dates) must be present verbatim in the transcript text.',
    kind: 'DETERMINISTIC',
    severity: 'BLOCK',
    owner_role: 'AI Enablement',
    check: 'numeric_claims_grounded',
    rule_code: null,
    version: 1,
    spec: { fields: ['composition.summary', 'composition.crm_record'] },
    judge_model_id: null,
    n_runs: null,
  },
  {
    id: 'contract-c-span-01',
    code: 'C-SPAN-01',
    title: 'Cited spans are verbatim',
    description:
      'Each evidence span the workflow cites must be found verbatim (whitespace-normalized) in the transcript at the stated offset.',
    kind: 'DETERMINISTIC',
    severity: 'BLOCK',
    owner_role: 'AI Enablement',
    check: 'spans_verbatim',
    rule_code: null,
    version: 1,
    spec: { normalize_whitespace: true },
    judge_model_id: null,
    n_runs: null,
  },
  {
    id: 'contract-c-pii-01',
    code: 'C-PII-01',
    title: 'No Medicare number or SSN in the CRM record',
    description: 'The CRM record and coaching note must not contain an MBI or SSN pattern.',
    kind: 'DETERMINISTIC',
    severity: 'BLOCK',
    owner_role: 'QA Compliance Analyst',
    check: 'no_pii_in_output',
    rule_code: null,
    version: 1,
    spec: { patterns: ['MBI', 'SSN'] },
    judge_model_id: null,
    n_runs: null,
  },
  {
    id: 'contract-c-sup-01',
    code: 'C-SUP-01',
    title: 'Superlative flags follow the in-force substantiation rule',
    description:
      'Superlatives without substantiation are flagged before 2026-10-01; from 2026-10-01 only materially misleading statements may be flagged. Disagreement is advisory (FLAG).',
    kind: 'DETERMINISTIC',
    severity: 'FLAG',
    owner_role: 'Sales Supervisor',
    check: 'superlative_policy_matches_rule',
    rule_code: 'superlatives',
    version: 2,
    spec: { field: 'extraction.superlatives', param: 'substantiation_required' },
    judge_model_id: null,
    n_runs: null,
  },
  {
    id: 'contract-c-schema-01',
    code: 'C-SCHEMA-01',
    title: 'Output validates against the qa-handoff schema',
    description: 'The workflow output must be valid JSON matching qa-handoff.schema.json (extraction, composition, route).',
    kind: 'DETERMINISTIC',
    severity: 'BLOCK',
    owner_role: 'AI Enablement',
    check: 'output_schema_valid',
    rule_code: null,
    version: 1,
    spec: { schema: 'qa-handoff.schema.json' },
    judge_model_id: null,
    n_runs: null,
  },
  {
    id: 'contract-j-coach-01',
    code: 'J-COACH-01',
    title: 'Coaching note is specific, actionable and grounded',
    description:
      'The run’s own model, acting as judge, scores the coaching note 1–5 on specificity, actionability and grounding, five times; a mean below 3.0 raises a FLAG. Six canary notes with author-set bands check the judge’s calibration. Advisory — a judge cannot block.',
    kind: 'JUDGED',
    severity: 'FLAG',
    owner_role: 'Training Supervisor',
    check: 'judge_coaching_note',
    rule_code: null,
    version: 1,
    spec: { rubric: 'coaching-note-v1', threshold: 3.0, n: 5 },
    judge_model_id: 'same-as-run',
    n_runs: 5,
  },
];

export const CONTRACT_SET_HASH = '9c1f2a7e5d04b3c8a6e1f0d2b4c7a9e3f5d1c0b8a7e6d5c4b3a2f1e0d9c8b7a6';

export const MODELS: ModelOut[] = [
  {
    id: 'model-sim-large',
    provider: 'simulated',
    model_id: 'sim-large',
    label: 'Simulated · large (deterministic)',
    pinned: true,
    notes: 'Deterministic simulator that follows the prompt faithfully. Used for the rule-flip and prompt-change acts.',
  },
  {
    id: 'model-sim-small',
    provider: 'simulated',
    model_id: 'sim-small',
    label: 'Simulated · small (drifts on numbers)',
    pinned: true,
    notes: 'Deterministic simulator that occasionally rounds premiums to $0 and truncates cited spans. Stands in for a vendor model swap.',
  },
  {
    id: 'model-claude-haiku',
    provider: 'anthropic',
    model_id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5 (live / cassette)',
    pinned: true,
    notes: 'Live adapter needs ANTHROPIC_API_KEY; the cassette adapter replays recorded responses.',
  },
  {
    id: 'model-claude-sonnet',
    provider: 'anthropic',
    model_id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5 (live / cassette)',
    pinned: true,
    notes: 'Live adapter needs ANTHROPIC_API_KEY; the cassette adapter replays recorded responses.',
  },
  {
    id: 'model-ollama-qwen7b',
    provider: 'ollama',
    model_id: 'ollama/qwen2.5:7b-instruct',
    label: 'Qwen2.5 7B — local (Ollama, RTX 3060)',
    pinned: true,
    notes: "Runs on this laptop's GPU. The honest baseline for 'no API spend'.",
  },
  {
    id: 'model-ollama-qwen3b',
    provider: 'ollama',
    model_id: 'ollama/qwen2.5:3b-instruct',
    label: 'Qwen2.5 3B — local (Ollama)',
    pinned: true,
    notes: 'Small local model; expect grounding defects — measured, not simulated.',
  },
  {
    id: 'model-groq-llama70b',
    provider: 'groq',
    model_id: 'groq/llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B — Groq free tier',
    pinned: true,
    notes: '≈100K tokens/day free: enough for one 20-transcript run + judge per day.',
  },
  {
    id: 'model-gemini-flash',
    provider: 'gemini',
    model_id: 'gemini/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash — AI Studio free tier',
    pinned: true,
    notes: '≈250 requests/day free; use --limit 30 and judge N=3.',
  },
];

/** Provider readiness as the mock reports it: a local Ollama with two pulled models, no hosted keys. */
export const PROVIDERS: ModelBoardOut['providers'] = {
  ollama: {
    available: true,
    key_env: null,
    notes: 'Local models on this machine. $0, offline, nothing leaves the laptop. Quality depends on the model you pull.',
    rpm: 0,
    rpd: null,
    local_models: ['qwen2.5:7b-instruct', 'qwen2.5:3b-instruct'],
  },
  groq: { available: false, key_env: 'GROQ_API_KEY', notes: 'Free tier (console.groq.com). Llama 3.3 70B ≈ 30 RPM / 1K RPD / 100K tokens per day. Very fast.', rpm: 28, rpd: 1000 },
  gemini: { available: false, key_env: 'GEMINI_API_KEY', notes: 'Google AI Studio free tier (aistudio.google.com). Gemini 2.5 Flash ≈ 10 RPM / 250 RPD.', rpm: 9, rpd: 250 },
  openrouter: { available: false, key_env: 'OPENROUTER_API_KEY', notes: "Free ':free' models (openrouter.ai). ≈ 20 RPM and 50 requests/day without credits — samples only.", rpm: 18, rpd: 50 },
  anthropic: { available: false, key_env: 'ANTHROPIC_API_KEY', notes: 'Paid API. Optional; nothing in the demo needs it.' },
  simulated: { available: true, key_env: null, notes: 'Deterministic stand-ins with declared defect profiles. Not models.' },
};

export function modelBoard(runs: RunOut[], prompt: number, ruleDate: string): ModelBoardOut {
  const rows: ModelBoardRow[] = MODELS.map((model) => {
    const mine = runs.filter((r) => r.model_id === model.model_id && r.status === 'COMPLETE').sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
    const matched = mine.find((r) => r.prompt_version === prompt && r.rule_date === ruleDate);
    const latest = matched ?? mine[0] ?? null;
    const isSim = model.provider === 'simulated';
    const local = model.provider === 'ollama';
    const pulled = local && PROVIDERS.ollama.local_models?.includes(model.model_id.split('/', 2)[1]);
    const provider = PROVIDERS[model.provider];
    const availability = isSim ? 'simulated' : local ? (pulled ? 'ready' : 'not-pulled') : provider?.available ? 'ready' : 'needs-key';
    return {
      model,
      tier: isSim ? 'simulated' : model.provider === 'anthropic' ? 'paid' : local ? 'local' : 'free-tier',
      supports_tools: isSim ? null : true,
      availability,
      availability_detail: isSim
        ? 'declared defect profile, not a model'
        : availability === 'ready'
          ? local
            ? 'pulled on this machine · $0 · nothing leaves the laptop'
            : `${provider?.key_env} set`
          : availability === 'not-pulled'
            ? `Ollama is up; run 'ollama pull ${model.model_id.split('/', 2)[1]}'`
            : `free key → ${provider?.key_env ?? '?'}`,
      key_env: isSim || local ? null : (provider?.key_env ?? null),
      cassettes: model.model_id === 'ollama/qwen2.5:7b-instruct' ? [{ prompt_version: 2, prompt_hash: 'e0cc00b5c6409648', generate: 60, judge: 60, canary: 1 }] : [],
      latest_run: latest,
      matched: Boolean(matched),
      measured: Boolean(latest) && latest!.adapter !== 'simulated',
    };
  });
  return { prompt_version: prompt, rule_date: ruleDate, providers: PROVIDERS, rows };
}

function promptVersion(
  version: number,
  label: string,
  assetCode: string,
  notes: string,
  encodes: RuleVersionRef[],
  createdAt: string,
): PromptVersionOut {
  const asset = findAsset(assetCode);
  return {
    id: `pv-qa-handoff-${version}`,
    version,
    label,
    prompt_hash: asset?.latest_hash ?? '',
    author: version === 1 ? 'AI Enablement' : 'engineer',
    notes,
    encodes_rule_versions: encodes,
    created_at: createdAt,
    text: asset?.content_text ?? null,
  };
}

export const WORKFLOWS: WorkflowOut[] = [
  {
    id: 'workflow-qa-handoff',
    code: 'qa-handoff',
    name: 'QA handoff (extraction → composition)',
    description:
      'Reads a recorded sales-call transcript, extracts compliance-relevant facts, then composes a supervisor summary, a coaching note and a CRM record. Runs after every call; the QA Compliance Analyst reviews the flagged ones.',
    prompt_versions: [
      promptVersion(
        1,
        'qa-handoff v1 (CY2024 clauses)',
        'prompt-qa-handoff-v1',
        'Original production prompt. Encodes the 60-second TPMO timer, the 48-hour SOA wait and the superlative substantiation requirement.',
        [
          { rule: 'tpmo-disclaimer-timing', version: 1 },
          { rule: 'soa-48h-wait', version: 1 },
          { rule: 'superlatives', version: 1 },
        ],
        '2025-11-03T15:20:00Z',
      ),
      promptVersion(
        2,
        'qa-handoff v2 (CY2027 clauses)',
        'prompt-qa-handoff-v2',
        'Rewritten for the Oct 1, 2026 rule flip: ordering basis for the disclaimer, no SOA waiting period, superlatives permitted unless misleading.',
        [
          { rule: 'tpmo-disclaimer-timing', version: 2 },
          { rule: 'soa-48h-wait', version: 2 },
          { rule: 'superlatives', version: 2 },
        ],
        '2026-09-18T18:05:00Z',
      ),
    ],
  },
];

export function findContract(code: string): ContractOut | undefined {
  return CONTRACTS.find((c) => c.code === code);
}

export function findPromptVersion(workflow: string, version: number): PromptVersionOut | undefined {
  return WORKFLOWS.find((w) => w.code === workflow)?.prompt_versions.find((p) => p.version === version);
}

export function findModel(modelId: string): ModelOut | undefined {
  return MODELS.find((m) => m.model_id === modelId);
}
