import type { JsonObject } from '../api/types';

/**
 * RunResultOut.evidence is `dict[str, Any]`; each contract family writes its
 * own keys (shapes observed on the live API). These helpers narrow them for
 * the purpose-built evidence blocks and for one-line table summaries.
 */

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

export function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [];
}

export function numList(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

export type EvidenceFamily = 'rule' | 'span' | 'fact' | 'pii' | 'schema' | 'superlative' | 'judge' | 'no-truth' | 'unknown';

/** Decide which purpose-built block renders this evidence, by keys first, contract code second. */
export function evidenceFamily(contractCode: string, ev: JsonObject): EvidenceFamily {
  if ('model_says' in ev || ('error' in ev && !('raw_keys' in ev) && !('fields' in ev) && contractCode !== 'C-SCHEMA-01')) return 'no-truth';
  if (Array.isArray(ev.scores) || contractCode.startsWith('J-')) return 'judge';
  if ('not_in_transcript' in ev || 'checked' in ev || contractCode === 'C-SPAN-01') return 'span';
  if ('invented_figures' in ev || 'summary_figures' in ev || contractCode === 'C-FACT-01') return 'fact';
  if ('pii_in_output' in ev || 'pii_types_reported' in ev || contractCode === 'C-PII-01') return 'pii';
  if ('fields' in ev || 'raw_keys' in ev || contractCode === 'C-SCHEMA-01') return 'schema';
  if ('expected_flags' in ev || 'got_flags' in ev || contractCode === 'C-SUP-01') return 'superlative';
  if ('truth_basis' in ev || 'rule_logic' in ev || 'expected' in ev) return 'rule';
  return 'unknown';
}

/** Compliance boolean → the word the floor uses. */
export function complianceWord(v: unknown): string {
  if (v === true) return 'compliant';
  if (v === false) return 'violation';
  return str(v);
}

export interface RuleExplanation {
  /** the deterministic comparison the contract made, e.g. "25s < 131s → disclaimer before benefits → compliant" */
  check: string;
  /** what went wrong, in one sentence, when the model disagreed with the rule */
  finding: string | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * "Why is this red?" for the rule contracts, recomputed from the stored evidence.
 * Returns null unless the recomputed verdict equals the stored ground truth, so the
 * explanation can never disagree with the contract that produced the result.
 */
export function explainRuleVerdict(ev: JsonObject, outcome: string): RuleExplanation | null {
  if (ev.not_applicable !== undefined || typeof ev.expected !== 'boolean') return null;
  const logic = isObject(ev.rule_logic) ? ev.rule_logic : {};
  let derived: boolean | null = null;
  let check = '';
  const disclaimer = num(ev.disclaimer_seconds);
  const benefits = num(ev.benefits_started_seconds);
  if (logic.basis === 'ordering' && disclaimer !== null && benefits !== null) {
    derived = disclaimer < benefits;
    check = derived
      ? `${disclaimer}s < ${benefits}s → disclaimer before benefits → compliant`
      : `${disclaimer}s ≥ ${benefits}s → benefits discussed first → violation`;
  } else if (logic.basis === 'timer' && disclaimer !== null && num(logic.window_seconds) !== null) {
    const window = num(logic.window_seconds) as number;
    derived = disclaimer <= window;
    check = derived ? `${disclaimer}s ≤ ${window}s window → compliant` : `${disclaimer}s > ${window}s window → violation`;
  } else if (num(logic.min_hours) !== null && ev.soa_exception == null && num(ev.appointment_hours_after_soa) !== null) {
    const min = num(logic.min_hours) as number;
    const hours = num(ev.appointment_hours_after_soa) as number;
    derived = hours >= min;
    check = min === 0 ? 'no waiting period in force → compliant' : derived ? `${hours}h ≥ ${min}h wait → compliant` : `${hours}h < ${min}h wait → violation`;
  }
  if (derived === null || derived !== ev.expected) return null;
  if (outcome === 'PASS' || typeof ev.got !== 'boolean' || ev.got === ev.expected) return { check, finding: null };
  const modelRead = num(ev.model_disclaimer_seconds);
  let finding = `The model answered ${complianceWord(ev.got)}; the rule in force gives ${complianceWord(ev.expected)}.`;
  if (disclaimer !== null && modelRead !== null) {
    finding =
      Math.abs(modelRead - disclaimer) <= 2
        ? `The model read the disclaimer at ${modelRead}s, which is correct, and still answered ${complianceWord(ev.got)}: its verdict contradicts the evidence it extracted.`
        : `The model misread the disclaimer time (${modelRead}s; the call has it at ${disclaimer}s), so its verdict rests on a wrong reading.`;
  }
  return { check, finding };
}

/** One line for tables. */
export function evidenceSummary(contractCode: string, ev: JsonObject): string {
  switch (evidenceFamily(contractCode, ev)) {
    case 'no-truth':
      return `no ground truth${typeof ev.error === 'string' ? ` — ${ev.error}` : ''}${ev.model_says !== undefined ? ` · model says ${str(ev.model_says)}` : ''}`;
    case 'judge': {
      const judge = isObject(ev.judge) ? ev.judge : {};
      return `mean ${str(ev.mean)} · variance ${str(ev.variance)} · threshold ${str(ev.threshold)} · judge ${str(judge.judge_model)}${judge.simulated === true ? ' (simulated)' : ''} · advisory`;
    }
    case 'span': {
      const missing = isObject(ev.not_in_transcript) ? Object.keys(ev.not_in_transcript) : [];
      return missing.length ? `${missing.length} span(s) not verbatim: ${missing.join(', ')} · ${str(ev.checked)} checked` : `${str(ev.checked)} spans verbatim`;
    }
    case 'fact': {
      const invented = strList(ev.invented_figures);
      const summary = strList(ev.summary_figures);
      return invented.length
        ? `invented ${invented.join(', ')} · transcript has ${strList(ev.transcript_figures).join(', ') || 'none'}`
        : `${summary.length} figure(s) grounded${summary.length ? `: ${summary.join(', ')}` : ''}`;
    }
    case 'pii': {
      if (isObject(ev.pii_in_output)) {
        const types = Object.keys(ev.pii_in_output);
        return types.length ? `PII in output: ${types.join(', ')}` : 'no PII in output';
      }
      const reported = strList(ev.pii_types_reported);
      return reported.length ? `reported: ${reported.join(', ')}` : 'no PII reported';
    }
    case 'schema':
      return typeof ev.error === 'string' ? `invalid: ${ev.error}${Array.isArray(ev.raw_keys) ? ` (keys: ${strList(ev.raw_keys).join(', ')})` : ''}` : `${str(ev.fields)} fields valid`;
    case 'superlative': {
      const exp = strList(ev.expected_flags);
      const got = strList(ev.got_flags);
      return `expected [${exp.join(', ')}] · got [${got.join(', ')}] · substantiation ${ev.substantiation_required === true ? 'required' : 'not required'}`;
    }
    case 'rule': {
      const dir = typeof ev.direction === 'string' ? ` · ${ev.direction}` : '';
      const truth = typeof ev.truth_basis === 'string' ? ` · truth: ${ev.truth_basis}` : '';
      const model = typeof ev.model_basis === 'string' ? ` · model: ${ev.model_basis}` : '';
      return `expected ${complianceWord(ev.expected)} · got ${complianceWord(ev.got)}${dir}${truth}${model}`;
    }
    default: {
      const keys = Object.keys(ev);
      return keys.length ? keys.map((k) => `${k}: ${str(ev[k])}`).join(' · ').slice(0, 160) : '—';
    }
  }
}

/** Keys in the extraction object that carry rule-dependent judgments (observed on the live API). */
export const RULE_DEPENDENT_KEYS = [
  'disclaimer_compliant',
  'disclaimer_basis',
  'soa_wait_compliant',
  'soa_exception',
  'superlatives',
] as const;
