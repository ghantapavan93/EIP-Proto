/**
 * Attribution, client side: the same rules as backend/backstop/core/attribution.py,
 * used by mock mode so the backend-free console answers "can this difference be
 * pinned on one change?" exactly as the server does.
 */
import type { AttributionOut, FactorChangeOut, IsolatingPairOut, RunOut } from '../api/types';

export const FACTORS = ['prompt', 'model', 'rule_date', 'corpus', 'contract_set', 'judge', 'overrides'] as const;
export type Factor = (typeof FACTORS)[number];

export const FACTOR_LABELS: Record<Factor, string> = {
  prompt: 'prompt',
  model: 'model',
  rule_date: 'rule date',
  corpus: 'calls scored',
  contract_set: 'contract set',
  judge: 'judge',
  overrides: 'approved overrides',
};

/** Factors that reach only the judged (advisory) contracts. */
const JUDGED_ONLY: ReadonlySet<Factor> = new Set(['judge']);
/** Overrides in scope follow from the calls scored. */
const DERIVED_FROM: Partial<Record<Factor, Factor>> = { overrides: 'corpus' };

interface RunFactors {
  id: string;
  key: Record<Factor, string>;
  display: Record<Factor, string>;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function factorsOf(run: RunOut): RunFactors {
  const stats = (run.stats ?? {}) as Record<string, unknown>;
  const judgeId = typeof stats.judge_model_id === 'string' && stats.judge_model_id ? stats.judge_model_id : run.model_id;
  const judge = judgeId === run.model_id ? 'same model as the run' : judgeId;
  const testCases = (stats.test_cases ?? {}) as Record<string, unknown>;
  const overrides = String(num(testCases.in_scope));
  const corpusName = String(run.corpus ?? stats.corpus ?? 'synthetic');
  const calls = num(stats.transcripts);
  return {
    id: run.id,
    key: {
      prompt: run.prompt_hash,
      model: `${run.model_id}|${run.adapter}`,
      rule_date: run.rule_date,
      corpus: run.corpus_hash,
      contract_set: run.contract_set_hash,
      judge,
      overrides,
    },
    display: {
      prompt: `v${run.prompt_version}`,
      model: `${run.model_id} (${run.adapter})`,
      rule_date: run.rule_date,
      corpus: calls ? `${corpusName}, ${calls} calls` : corpusName,
      contract_set: run.contract_set_hash.slice(0, 8),
      judge,
      overrides: `${overrides} in scope`,
    },
  };
}

export function changedFactors(a: RunFactors, b: RunFactors): Factor[] {
  const changed = FACTORS.filter((f) => a.key[f] !== b.key[f]);
  return changed.filter((f) => {
    const parent = DERIVED_FROM[f];
    return !(parent && changed.includes(parent));
  });
}

function join(labels: string[]): string {
  if (labels.length <= 2) return labels.join(' and ');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** Existing pairs that move one factor alone, from A's value to B's; pairs touching A or B first. */
export function isolatingPairs(a: RunFactors, b: RunFactors, candidates: RunFactors[]): IsolatingPairOut[] {
  const pool = [a, b, ...candidates.filter((c) => c.id !== a.id && c.id !== b.id)];
  const out: IsolatingPairOut[] = [];
  for (const factor of changedFactors(a, b)) {
    let best: { anchored: number; order: number; c: string; d: string } | null = null;
    pool.forEach((c, i) => {
      if (c.key[factor] !== a.key[factor]) return;
      pool.forEach((d, j) => {
        if (d.key[factor] !== b.key[factor]) return;
        const moved = changedFactors(c, d);
        if (moved.length !== 1 || moved[0] !== factor) return;
        const anchored = [c.id, d.id].some((id) => id === a.id || id === b.id) ? 0 : 1;
        if (!best || anchored < best.anchored || (anchored === best.anchored && i + j < best.order)) {
          best = { anchored, order: i + j, c: c.id, d: d.id };
        }
      });
    });
    const found = best as { c: string; d: string } | null;
    if (found) out.push({ factor, label: FACTOR_LABELS[factor], a_run_id: found.c, b_run_id: found.d });
  }
  return out;
}

export function attributeRuns(runA: RunOut, runB: RunOut, others: RunOut[] = []): AttributionOut {
  const a = factorsOf(runA);
  const b = factorsOf(runB);
  const changed = changedFactors(a, b);
  const rows: FactorChangeOut[] = changed.map((f) => ({ factor: f, label: FACTOR_LABELS[f], a: a.display[f], b: b.display[f] }));
  const held = FACTORS.filter((f) => !changed.includes(f)).map((f) => FACTOR_LABELS[f]);
  const labels = changed.map((f) => FACTOR_LABELS[f]);

  if (changed.length === 0) {
    return {
      verdict: 'repeat', changed: rows, held_constant: held, scope_note: null, isolating_pairs: [],
      summary: 'No tracked input differs between A and B. A difference comes from run-to-run variation (which the significance test below weighs) or from something Backstop does not yet fingerprint: generation settings, a simulated defect profile, or model weights re-pulled under the same tag.',
    };
  }
  if (changed.length === 1) {
    const f = changed[0];
    return {
      verdict: 'isolated', changed: rows, held_constant: held, scope_note: null, isolating_pairs: [],
      summary: `Only the ${FACTOR_LABELS[f]} changed (${a.display[f]} → ${b.display[f]}). Every other tracked input was held constant, so the differences below are attributable to that change, subject to the significance test.`,
    };
  }
  const pairs = isolatingPairs(a, b, others.map(factorsOf));
  const found = pairs.map((p) => p.label);
  const missing = labels.filter((l) => !found.includes(l));
  let summary = `The ${join(labels)} changed together. The differences below are real, but they cannot be attributed to any one of these changes.`;
  if (found.length && !missing.length) summary += ' Existing runs isolate each change on its own; compare those instead.';
  else if (found.length) summary += ` Existing runs isolate the ${join(found)} change${found.length > 1 ? 's' : ''}; no pair isolates the ${join(missing)} change${missing.length > 1 ? 's' : ''} yet.`;
  else summary += ' No existing pair of runs isolates them; start runs that change one thing at a time.';
  const primary = changed.filter((f) => !JUDGED_ONLY.has(f));
  const scope_note =
    primary.length === 1
      ? `Deterministic, release-blocking contracts are still attributable to the ${FACTOR_LABELS[primary[0]]} change; only the judged (advisory) contracts mix in the ${join(changed.filter((f) => JUDGED_ONLY.has(f)).map((f) => FACTOR_LABELS[f]))} change.`
      : null;
  return { verdict: 'confounded', changed: rows, held_constant: held, summary, scope_note, isolating_pairs: pairs };
}
