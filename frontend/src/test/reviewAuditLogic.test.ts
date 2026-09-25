import { describe, expect, it } from 'vitest';
import type { AuditOut, ReviewTaskOut, RunOut } from '../api/types';
import { actionableUnits, countByLane, groupActionable, taskLane } from '../lib/review';
import { blockingFailures } from '../lib/runStats';
import { actorName, auditEntityLink, auditSummary, auditTransition, eventLabel, eventTone, isSystemActor, shortModel } from '../lib/audit';
import { bundleHashLabel, fmtRelative } from '../lib/format';
import { shouldReplayCausality } from '../lib/motion';
import { authorityLabel, rankSources } from '../lib/ruleVersions';
import { componentLabel, componentTone, stateWord } from '../lib/health';
import { evidencePath } from '../api/hooks';

function task(over: Partial<ReviewTaskOut>): ReviewTaskOut {
  return {
    id: 't',
    kind: 'FLAGGED_RESULT',
    state: 'open',
    rule_code: null,
    rule_version: null,
    asset_code: null,
    asset_name: null,
    asset_type: null,
    asset_is_synthetic: null,
    edge_id: null,
    evidence_span: null,
    run_result_id: null,
    run_id: 'run-a',
    contract_code: 'C-TPMO-01',
    transcript_code: 'T001',
    staleness_direction: null,
    reason: '',
    assignee_role: 'compliance',
    reason_code: null,
    note: '',
    decided_by: null,
    opened_at: '2026-09-23T07:00:00Z',
    closed_at: null,
    payload: {},
    allowed_transitions: [],
    ...over,
  };
}

function run(over: Partial<RunOut>): RunOut {
  return {
    id: 'run-a',
    run_key: 'qa-handoff:x',
    workflow_code: 'qa-handoff',
    prompt_version: 2,
    prompt_label: 'v2',
    prompt_hash: 'h',
    model_id: 'ollama/qwen2.5:3b-instruct',
    model_label: 'Qwen 3B',
    adapter: 'cassette',
    corpus_hash: 'c',
    contract_set_hash: 's',
    rule_date: '2026-10-01',
    trigger: 'MODEL',
    status: 'COMPLETE',
    gate: 'RED',
    started_at: '2026-09-23T07:00:00Z',
    finished_at: '2026-09-23T07:01:00Z',
    stats: {
      contracts: {
        'C-TPMO-01': { PASS: 50, FAIL: 4, FLAG: 0, ERROR: 2 },
        'C-SUP-01': { PASS: 55, FAIL: 3, FLAG: 2, ERROR: 0 },
        'J-COACH-01': { PASS: 58, FAIL: 0, FLAG: 2, ERROR: 0 },
      },
    },
    requested_by: 'engineer',
    deduplicated: false,
    contracts: [],
    ...over,
  };
}

function row(over: Partial<AuditOut>): AuditOut {
  return { id: 1, ts: '2026-09-23T07:00:00Z', actor: 'engineer', actor_role: 'engineer', event_type: 'x', entity_type: 'run', entity_id: 'run-a', payload: {}, ...over };
}

const SEVERITY = new Map([
  ['C-TPMO-01', 'BLOCK'],
  ['C-SUP-01', 'FLAG'],
  ['J-COACH-01', 'FLAG'],
]);

describe('review lanes and grouping', () => {
  it('uses the API lane, then the payload, then the aggregate rule', () => {
    expect(taskLane(task({ lane: 'advisory' }))).toBe('advisory');
    expect(taskLane(task({ payload: { lane: 'advisory' } }))).toBe('advisory');
    expect(taskLane(task({ payload: { aggregate: true } }))).toBe('advisory');
    expect(taskLane(task({ kind: 'STALE_ASSET', payload: { aggregate: true } }))).toBe('actionable');
    expect(taskLane(task({}))).toBe('actionable');
  });

  it('counts by lane', () => {
    expect(countByLane([task({}), task({ lane: 'advisory' }), task({ kind: 'PROPOSED_EDGE' })])).toEqual({ actionable: 2, advisory: 1 });
    expect(countByLane(undefined)).toEqual({ actionable: 0, advisory: 0 });
  });

  it('keeps artifact tasks individual and groups flagged results by run × contract, largest first', () => {
    const tasks = [
      task({ id: 'a1', contract_code: 'C-SOA-01' }),
      task({ id: 'a2', contract_code: 'C-TPMO-01' }),
      task({ id: 'a3', contract_code: 'C-TPMO-01' }),
      task({ id: 'b1', contract_code: 'C-TPMO-01', run_id: 'run-b' }),
      task({ id: 's1', kind: 'STALE_ASSET', contract_code: null, run_id: null }),
      task({ id: 'p1', kind: 'PROPOSED_EDGE', contract_code: null, run_id: null }),
    ];
    const layout = groupActionable(tasks);
    expect(layout.individual.map((t) => t.id).sort()).toEqual(['p1', 's1']);
    expect(layout.groups.map((g) => [g.runId, g.contractCode, g.tasks.length])).toEqual([
      ['run-a', 'C-TPMO-01', 2],
      ['run-a', 'C-SOA-01', 1],
      ['run-b', 'C-TPMO-01', 1],
    ]);
    expect(actionableUnits(tasks)).toBe(5);
  });

  it('falls back to payload.run_id when the task has no run column', () => {
    const layout = groupActionable([task({ id: 'x', run_id: null, payload: { run_id: 'run-z' } })]);
    expect(layout.groups[0].runId).toBe('run-z');
  });
});

describe('blocking failures', () => {
  it('counts FAIL + ERROR on BLOCK-severity contracts only', () => {
    expect(blockingFailures(run({}), SEVERITY)).toEqual({ failures: 6, contracts: ['C-TPMO-01'] });
  });

  it('falls back to the run summary severity when the contracts API has not loaded', () => {
    const r = run({ contracts: [{ code: 'C-TPMO-01', title: '', severity: 'BLOCK', kind: 'DETERMINISTIC', rule_code: null, passed: 0, failed: 0, flagged: 0, errored: 0 }] });
    expect(blockingFailures(r, new Map()).failures).toBe(6);
  });

  it('is zero for a missing run', () => {
    expect(blockingFailures(undefined, SEVERITY)).toEqual({ failures: 0, contracts: [] });
  });
});

describe('audit meaning', () => {
  it('humanizes event types and system actors', () => {
    expect(eventLabel('run.completed')).toBe('Run completed');
    expect(eventLabel('evidence.exported')).toBe('Evidence exported');
    expect(eventLabel('something.new_thing')).toBe('Something new thing');
    expect(actorName('system:rules-loader')).toBe('Rules loader');
    expect(actorName('engineer')).toBe('engineer');
    expect(isSystemActor({ actor: 'system:runner', actor_role: 'system' })).toBe(true);
    expect(isSystemActor({ actor: 'analyst', actor_role: 'analyst' })).toBe(false);
    expect(shortModel('ollama/qwen2.5:3b-instruct')).toBe('qwen2.5:3b-instruct');
  });

  it('summarizes a completed run with its identity and blocking failures', () => {
    const r = row({ event_type: 'run.completed', payload: { gate: 'RED', contracts: run({}).stats.contracts, review_tasks_opened: 7, advisory_items_opened: 2 } });
    const text = auditSummary(r, { runsById: new Map([['run-a', run({})]]), severityByCode: SEVERITY });
    expect(text).toBe('qa-handoff · v2 · qwen2.5:3b-instruct → RED · 6 blocking failures · 7 review tasks opened · 2 advisory');
    // without the run in cache, still counts from the payload
    expect(auditSummary(r, { severityByCode: SEVERITY })).toContain('RED · 6 blocking failures');
    expect(eventTone(r)).toBe('red');
  });

  it('summarizes decisions, exports and superseded encodings', () => {
    expect(auditSummary(row({ event_type: 'task.transitioned', payload: { from: 'open', to: 'overridden', reason_code: 'TRANSCRIPT_AMBIGUOUS', note: '' } }))).toBe(
      'open → overridden · TRANSCRIPT_AMBIGUOUS',
    );
    expect(auditSummary(row({ event_type: 'evidence.exported', payload: { format: 'json', bundle_sha256: 'a1b2c3d4e5f6a7b8c9', audit_rows: 3 } }))).toBe(
      'json bundle a1b2c3d4e5f6… · 3 audit rows included',
    );
    expect(auditSummary(row({ event_type: 'edge.superseded', entity_type: 'edge', payload: { asset: 'sc-12', span: 'The agent must wait 48 hours before the appointment.' } }))).toBe(
      'sc-12 · “The agent must wait 48 hours before the appointment.” no longer in the artifact',
    );
  });

  it('extracts before → after and an in-app link', () => {
    const r = row({ event_type: 'task.transitioned', entity_type: 'review_task', entity_id: 'task-1', payload: { from: 'open', to: 'upheld' } });
    expect(auditTransition(r)).toEqual({ from: 'open', to: 'upheld' });
    expect(auditTransition(row({ payload: { gate: 'RED' } }))).toBeNull();
    expect(auditEntityLink(r)?.to).toBe('/review?lane=all&task=task-1');
    expect(auditEntityLink(row({ entity_type: 'rule_version', payload: { rule: 'soa-48h-wait' } }))?.to).toBe('/rules/soa-48h-wait');
  });
});

describe('formatting, motion, provenance, health', () => {
  it('formats relative times for the status rail', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    expect(fmtRelative('2026-09-23T11:59:50Z', now)).toBe('just now');
    expect(fmtRelative('2026-09-23T11:58:00Z', now)).toBe('2m ago');
    expect(fmtRelative('2026-09-23T09:00:00Z', now)).toBe('3h ago');
    expect(fmtRelative('2026-09-19T12:00:00Z', now)).toBe('4d ago');
    expect(fmtRelative(null, now)).toBe('—');
  });

  it('shows the first 12 chars of a bundle hash', () => {
    expect(bundleHashLabel('cf679d980ed87fa60e5edcf637e348db')).toBe('cf679d980ed8');
    expect(bundleHashLabel(null)).toBe('no hash header');
  });

  it('replays causality on the first radius and on an in-force flip only', () => {
    expect(shouldReplayCausality(null, { inForce: 1 })).toBe(true);
    expect(shouldReplayCausality({ inForce: 1 }, { inForce: 2 })).toBe(true);
    expect(shouldReplayCausality({ inForce: 2 }, { inForce: 2 })).toBe(false);
    expect(shouldReplayCausality({ inForce: 2 }, { inForce: null })).toBe(true);
  });

  it('ranks sources primary → preamble → secondary, stable within a rank', () => {
    const ranked = rankSources([
      { authority: 'secondary', cite: 's', url: '', reading: '' },
      { authority: 'primary', cite: 'p1', url: '', reading: '' },
      { authority: 'preamble', cite: 'pre', url: '', reading: '' },
      { authority: 'primary', cite: 'p2', url: '', reading: '' },
    ]);
    expect(ranked.map((s) => s.cite)).toEqual(['p1', 'p2', 'pre', 's']);
    expect(authorityLabel('secondary')).toBe('Secondary interpretation');
  });

  it('labels components and keeps optional providers grey when offline', () => {
    expect(componentLabel({ name: 'database', detail: 'PostgreSQL' })).toBe('Postgres');
    expect(componentLabel({ name: 'database', detail: 'sqlite' })).toBe('Database');
    expect(componentTone({ state: 'offline', required: false })).toBe('neutral');
    expect(componentTone({ state: 'down', required: true })).toBe('red');
    expect(stateWord({ name: 'ollama', state: 'healthy', detail: '', required: false })).toBe('ready');
  });

  it('builds evidence bundle paths; as_of only for rules', () => {
    expect(evidencePath({ scope: 'runs', id: 'r 1', format: 'md', asOf: '2026-10-01' })).toBe('/evidence/runs/r%201?format=md');
    expect(evidencePath({ scope: 'rules', id: 'soa-48h-wait', format: 'json', asOf: '2026-10-01' })).toBe('/evidence/rules/soa-48h-wait?format=json&as_of=2026-10-01');
  });
});
