/**
 * Vocabulary the UI must use verbatim (docs/api-contract.md) and the
 * semantic-color mapping for each family. Colors are token names resolved by
 * Chip; no hex here.
 */

export type Tone = 'neutral' | 'teal' | 'green' | 'amber' | 'red' | 'slate';

export const CHANGE_CLASSIFICATIONS = [
  'INITIAL',
  'ADDS_REQUIREMENT',
  'REMOVES_REQUIREMENT',
  'TIGHTENS',
  'LOOSENS',
  'MODIFIES',
  'CLARIFIES',
  'RESTORES_PRIOR',
] as const;

/**
 * What a proposal may be classified as (the API's RuleVersionCreate): not
 * INITIAL, and not RESTORES_PRIOR, which only a court decision produces.
 */
export const PROPOSABLE_CLASSIFICATIONS = ['ADDS_REQUIREMENT', 'REMOVES_REQUIREMENT', 'TIGHTENS', 'LOOSENS', 'MODIFIES', 'CLARIFIES'] as const;

export const RULE_VERSION_STATUSES = ['in_force', 'eliminated', 'amended', 'proposed', 'vacated', 'stayed'] as const;

export const REVIEW_KINDS = ['STALE_ASSET', 'PROPOSED_EDGE', 'FLAGGED_RESULT', 'RULE_SOURCE_CHANGED'] as const;

export const REVIEW_STATES = [
  'open',
  'in_review',
  'verified',
  'republished',
  'dismissed',
  'upheld',
  'overridden',
] as const;

export const REASON_CODES = [
  'FALSE_POSITIVE_MATCHER',
  'FALSE_POSITIVE_JUDGE',
  'TRANSCRIPT_AMBIGUOUS',
  'RULE_EXCEPTION_APPLIES',
  'CORRECT_AS_FLAGGED',
  'ARTIFACT_ALREADY_UPDATED',
  'ARTIFACT_NOT_IN_SCOPE',
  'NEEDS_COUNSEL',
  'OTHER',
] as const;

/** Transitions that require a reason code (mirrors the backend state machine). */
export const REASON_REQUIRED_STATES = new Set(['dismissed', 'overridden', 'upheld']);

export const TRIGGERS = ['RULE', 'PROMPT', 'MODEL', 'MANUAL'] as const;
export const ADAPTERS = ['simulated', 'cassette', 'live'] as const;
export type Adapter = (typeof ADAPTERS)[number];

/**
 * Adapters a model can run on. The backend only has simulated profiles for
 * simulated-provider models, and a real model has no simulated profile — so
 * offering a mismatched pair just earns a 422 on Start.
 */
export function adaptersForModel(model: { provider: string } | undefined): readonly Adapter[] {
  if (!model) return ADAPTERS;
  return model.provider === 'simulated' ? ['simulated'] : ['cassette', 'live'];
}

/** Default adapter for a model: simulated for simulated models, otherwise replay the cassette. */
export function defaultAdapterForModel(model: { provider: string } | undefined): Adapter {
  return model?.provider === 'simulated' ? 'simulated' : 'cassette';
}

/**
 * Status chip for a provider card on the Models page. Ollama needs no key —
 * when it is down, recorded cassettes still replay, so say that instead of
 * "needs key".
 */
export function providerStatusLabel(name: string, ready: boolean): string {
  if (ready) return 'ready';
  if (name === 'ollama') return 'offline — cassettes still replay';
  if (name === 'anthropic') return 'optional';
  return 'needs key';
}

/** Mirrors backend core/audit.py EVENT_TYPES (a test keeps the two in step). */
export const AUDIT_EVENT_TYPES = [
  'rules.reloaded',
  'rule.version_created',
  'rule.version_closed',
  'rule.version_annotated',
  'rule.proposal_renumbered',
  'contract.version_created',
  'rule.source_checked',
  'scan.started',
  'scan.completed',
  'artifact.content_changed',
  'artifact.unchanged',
  'artifact.fetch_error',
  'edge.confirmed',
  'edge.proposed',
  'edge.rejected',
  'edge.superseded',
  'edge.restored',
  'staleness.evaluated',
  'task.opened',
  'task.transitioned',
  'task.transition_rejected',
  'run.started',
  'run.completed',
  'run.failed',
  'run.deduplicated',
  'run.egress_refused',
  'test_case.created',
  'test_case.approved',
  'ingest.completed',
  'export.generated',
  'evidence.exported',
  'auth.denied',
  'access.reviewed',
  'audit.checkpoint',
  'sandbox.artifact_checked',
  'sandbox.transcript_checked',
] as const;

export const AUDIT_ENTITY_TYPES = [
  'rules',
  'rule',
  'rule_version',
  'scan',
  'asset',
  'edge',
  'review_task',
  'run',
  'test_case',
  'transcripts',
  'auth',
  'contract',
  'sandbox',
] as const;

export const ARTIFACT_TYPE_LABELS: Record<string, string> = {
  web_page: 'Web page',
  scorecard_item: 'Scorecard item',
  script_section: 'Script section',
  coaching_prompt: 'Coaching prompt',
  email_template: 'Email template',
  training_slide: 'Training slide',
  ivr_script: 'IVR script',
  workflow_prompt: 'Workflow prompt',
  web_form: 'Web form',
  comp_schedule: 'Compensation schedule',
  dialer_policy: 'Dialer policy',
};

export function artifactTypeLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return ARTIFACT_TYPE_LABELS[type] ?? type.replace(/_/g, ' ');
}

/** Edge status → chip tone. `superseded` (artifact edited, quoted span gone) is neutral grey: history, not an error. */
export function edgeStatusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'confirmed':
      return 'green';
    case 'proposed':
      return 'amber';
    case 'rejected':
      return 'red';
    default:
      return 'neutral';
  }
}

export function gateTone(gate: string | null | undefined): Tone {
  switch (gate) {
    case 'GREEN':
      return 'green';
    case 'AMBER':
      return 'amber';
    case 'RED':
      return 'red';
    default:
      return 'neutral';
  }
}

export function outcomeTone(outcome: string | null | undefined): Tone {
  switch (outcome) {
    case 'PASS':
      return 'green';
    case 'FLAG':
      return 'amber';
    case 'FAIL':
    case 'ERROR':
      return 'red';
    default:
      return 'neutral';
  }
}

export function directionTone(direction: string | null | undefined): Tone {
  switch (direction) {
    case 'under_restrictive':
      return 'red';
    case 'over_restrictive':
      return 'amber';
    case 'reverify':
      return 'slate';
    default:
      return 'neutral';
  }
}

export function directionLabel(direction: string | null | undefined): string {
  switch (direction) {
    case 'under_restrictive':
      return 'Under-restrictive';
    case 'over_restrictive':
      return 'Over-restrictive';
    case 'reverify':
      return 'Re-verify';
    default:
      return direction ?? '—';
  }
}

export function severityTone(severity: string | null | undefined): Tone {
  return severity === 'BLOCK' ? 'red' : severity === 'FLAG' ? 'amber' : 'neutral';
}

export function changeTone(classification: string | null | undefined): Tone {
  switch (classification) {
    case 'ADDS_REQUIREMENT':
    case 'TIGHTENS':
      return 'red';
    case 'REMOVES_REQUIREMENT':
    case 'LOOSENS':
      return 'amber';
    case 'MODIFIES':
    case 'CLARIFIES':
    case 'RESTORES_PRIOR':
      return 'slate';
    default:
      return 'neutral';
  }
}

export function stateTone(state: string | null | undefined): Tone {
  switch (state) {
    case 'open':
      return 'teal';
    case 'in_review':
      return 'amber';
    case 'verified':
    case 'republished':
    case 'upheld':
      return 'green';
    case 'overridden':
      return 'slate';
    default:
      return 'neutral';
  }
}

export function ruleStatusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'in_force':
      return 'green';
    case 'eliminated':
      return 'red';
    case 'amended':
    case 'stayed':
      return 'amber';
    case 'proposed':
      return 'teal';
    case 'vacated':
      return 'slate';
    default:
      return 'neutral';
  }
}

export function triggerTone(trigger: string | null | undefined): Tone {
  switch (trigger) {
    case 'RULE':
      return 'amber';
    case 'PROMPT':
      return 'teal';
    case 'MODEL':
      return 'slate';
    default:
      return 'neutral';
  }
}

export function adapterLabel(adapter: string | null | undefined): string {
  switch (adapter) {
    case 'live':
    case 'anthropic':
      return 'LIVE';
    case 'cassette':
      return 'cassette';
    case 'simulated':
      return 'simulated';
    default:
      return adapter ?? '—';
  }
}

export function adapterTone(adapter: string | null | undefined): Tone {
  return adapter === 'live' || adapter === 'anthropic' ? 'teal' : adapter === 'cassette' ? 'slate' : 'neutral';
}

export function polarityTone(polarity: string | null | undefined): Tone {
  return polarity === 'ENFORCES' ? 'slate' : polarity === 'PERMITS' ? 'teal' : 'neutral';
}

export function kindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case 'STALE_ASSET':
      return 'Stale asset';
    case 'PROPOSED_EDGE':
      return 'Proposed edge';
    case 'FLAGGED_RESULT':
      return 'Flagged result';
    case 'RULE_SOURCE_CHANGED':
      return 'Rule source changed';
    default:
      return kind ?? '—';
  }
}

export function kindTone(kind: string | null | undefined): Tone {
  switch (kind) {
    case 'FLAGGED_RESULT':
      return 'red';
    case 'PROPOSED_EDGE':
      return 'teal';
    case 'STALE_ASSET':
      return 'amber';
    case 'RULE_SOURCE_CHANGED':
      return 'slate';
    default:
      return 'neutral';
  }
}

/** Role slugs from the API → the labels the EIP floor uses. Unknown slugs are humanized. */
const ROLE_LABELS: Record<string, string> = {
  compliance: 'QA Compliance Analyst',
  'qa-compliance': 'QA Compliance Analyst', // legacy slug on older rows
  'sales-innovation': 'Sales Innovation',
  'sales-supervisor': 'Sales Supervisor',
  training: 'Training Supervisor',
  'ai-enablement': 'AI Enablement',
  marketing: 'Marketing',
  operations: 'Operations',
  engineering: 'Engineering',
  'licensed-agent': 'Licensed Agent',
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—';
  if (ROLE_LABELS[role]) return ROLE_LABELS[role];
  const s = role.replace(/[-_]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Corpora a run can be started on from the UI. The held-out calls (H001–H060)
 * are replayed from the CLI only, and "all" would mix them in, so neither is offered.
 */
export const RUN_CORPORA = ['synthetic', 'ingested'] as const;

export const RUN_CORPUS_LABELS: Record<(typeof RUN_CORPORA)[number], string> = {
  synthetic: 'synthetic — 60 development calls (T001–T060)',
  ingested: 'ingested — redacted real transcripts',
};
