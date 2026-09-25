/**
 * Client-side helpers for the review queue. GET /review filters by state and
 * kind only, so the run filter is applied here.
 */

import type { ReviewTaskOut } from '../api/types';

/** Terminal review states — no transition leaves them, whatever the role. */
export const TERMINAL_REVIEW_STATES: ReadonlySet<string> = new Set(['republished', 'dismissed', 'upheld', 'overridden']);

/** The run a task came from: the top-level column, else payload.run_id. */
export function taskRunId(task: Pick<ReviewTaskOut, 'run_id' | 'payload'>): string | null {
  if (task.run_id) return task.run_id;
  const fromPayload = task.payload?.run_id;
  return typeof fromPayload === 'string' && fromPayload ? fromPayload : null;
}

/** Keep only tasks raised by `runId`; an empty/absent runId keeps everything. */
export function filterTasksByRun<T extends Pick<ReviewTaskOut, 'run_id' | 'payload'>>(tasks: T[] | undefined, runId: string | null | undefined): T[] | undefined {
  if (!tasks || !runId) return tasks;
  return tasks.filter((t) => taskRunId(t) === runId);
}

// ---------------------------------------------------------------- lanes

export type Lane = 'actionable' | 'advisory';

/**
 * The lane a task belongs to. The API sets `lane`; older payloads (and the
 * mock) fall back to the backend rule: an aggregate FLAGGED_RESULT is
 * advisory, everything else needs a human.
 */
export function taskLane(task: Pick<ReviewTaskOut, 'lane' | 'kind' | 'payload'>): Lane {
  if (task.lane === 'advisory' || task.lane === 'actionable') return task.lane;
  const fromPayload = task.payload?.lane;
  if (fromPayload === 'advisory' || fromPayload === 'actionable') return fromPayload;
  return task.kind === 'FLAGGED_RESULT' && task.payload?.aggregate === true ? 'advisory' : 'actionable';
}

export function countByLane(tasks: ReadonlyArray<Pick<ReviewTaskOut, 'lane' | 'kind' | 'payload'>> | undefined): Record<Lane, number> {
  const out: Record<Lane, number> = { actionable: 0, advisory: 0 };
  for (const t of tasks ?? []) out[taskLane(t)] += 1;
  return out;
}

// ---------------------------------------------------------------- grouping

/** A block of per-call FLAGGED_RESULT tasks raised by one contract in one run. */
export interface FlaggedGroup<T> {
  key: string;
  runId: string | null;
  contractCode: string;
  tasks: T[];
}

export interface ActionableLayout<T> {
  /** STALE_ASSET / PROPOSED_EDGE / RULE_SOURCE_CHANGED — about real artifacts, listed first */
  individual: T[];
  /** FLAGGED_RESULT tasks grouped by (run, contract), largest first */
  groups: Array<FlaggedGroup<T>>;
}

type Groupable = Pick<ReviewTaskOut, 'kind' | 'run_id' | 'payload' | 'contract_code' | 'opened_at'>;

/**
 * Lay the actionable lane out for a human: artifact-level tasks individually,
 * per-call flagged results grouped by (run_id, contract_code) so 131 BLOCK
 * failures from nine runs read as a handful of decisions, not 131 rows.
 */
export function groupActionable<T extends Groupable>(tasks: T[] | undefined): ActionableLayout<T> {
  const individual: T[] = [];
  const groups = new Map<string, FlaggedGroup<T>>();
  for (const t of tasks ?? []) {
    if (t.kind !== 'FLAGGED_RESULT') {
      individual.push(t);
      continue;
    }
    const runId = taskRunId(t);
    const contract = t.contract_code ?? (typeof t.payload?.contract === 'string' ? t.payload.contract : '—');
    const key = `${runId ?? 'no-run'}|${contract}`;
    const g = groups.get(key) ?? { key, runId, contractCode: contract, tasks: [] };
    g.tasks.push(t);
    groups.set(key, g);
  }
  return {
    individual: individual.sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1)),
    groups: [...groups.values()].sort((a, b) => b.tasks.length - a.tasks.length || a.contractCode.localeCompare(b.contractCode)),
  };
}

/** Decision units in the actionable lane: each individual task plus each flagged group. */
export function actionableUnits(tasks: Groupable[] | undefined): number {
  const { individual, groups } = groupActionable(tasks);
  return individual.length + groups.length;
}
