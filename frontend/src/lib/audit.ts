/**
 * Human meaning for audit rows: who acted (person or automation), what the
 * event means in words, and a one-line summary derived from the payload for
 * each event type. The raw event type and payload stay one click away.
 */

import type { AuditOut, JsonObject, RunOut } from '../api/types';
import { blockingFailures } from './runStats';
import { isObject } from './evidence';
import { hostname, shortHash } from './format';
import { kindLabel, type Tone } from './vocab';

/** Automated actors the backend writes as "system:<component>". */
export const SYSTEM_ACTORS = [
  'system:scanner',
  'system:runner',
  'system:rules-loader',
  'system:source-watch',
  'system:model-eval',
  'system:ingest',
] as const;

export function isSystemActor(row: Pick<AuditOut, 'actor' | 'actor_role'>): boolean {
  return row.actor_role === 'system' || row.actor === 'system' || row.actor.startsWith('system:');
}

/** "system:rules-loader" → "Rules loader"; people keep their username. */
export function actorName(actor: string): string {
  if (!actor.startsWith('system:')) return actor;
  const s = actor.slice('system:'.length).replace(/[-_]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const EVENT_LABELS: Record<string, string> = {
  'rules.reloaded': 'Rules reloaded',
  'rule.version_created': 'Rule version created',
  'rule.version_closed': 'Rule version closed',
  'rule.version_annotated': 'Rule version annotated',
  'rule.proposal_renumbered': 'Proposal renumbered',
  'contract.version_created': 'Contract version created',
  'rule.source_checked': 'Rule source checked',
  'scan.started': 'Scan started',
  'scan.completed': 'Scan completed',
  'artifact.content_changed': 'Artifact content changed',
  'artifact.unchanged': 'Artifact unchanged',
  'artifact.fetch_error': 'Artifact fetch failed',
  'edge.confirmed': 'Encoding confirmed',
  'edge.proposed': 'Encoding proposed',
  'edge.rejected': 'Encoding rejected',
  'edge.superseded': 'Encoding superseded',
  'edge.restored': 'Encoding restored',
  'staleness.evaluated': 'Staleness evaluated',
  'task.opened': 'Review task opened',
  'task.transitioned': 'Review decision',
  'task.transition_rejected': 'Transition refused',
  'run.started': 'Run started',
  'run.completed': 'Run completed',
  'run.failed': 'Run failed',
  'run.deduplicated': 'Run deduplicated',
  'run.egress_refused': 'Model call refused (egress)',
  'test_case.created': 'Test case created',
  'test_case.approved': 'Test case approved',
  'ingest.completed': 'Transcripts ingested',
  'export.generated': 'Run exported',
  'evidence.exported': 'Evidence exported',
  'auth.denied': 'Access denied',
  'access.reviewed': 'Access reviewed',
  'audit.checkpoint': 'Audit checkpoint taken',
  'sandbox.artifact_checked': 'Sandbox text checked',
  'sandbox.transcript_checked': 'Sandbox call checked',
};

/** "run.completed" → "Run completed"; unknown types are humanized generically. */
export function eventLabel(type: string): string {
  if (EVENT_LABELS[type]) return EVENT_LABELS[type];
  const s = type.replace(/[._]/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Semantic tone for an event: red = blocking failure / refusal, amber = needs
 * a human, green = deterministic pass, teal = system action, neutral = unknown.
 */
export function eventTone(row: Pick<AuditOut, 'event_type' | 'payload'>): Tone {
  const t = row.event_type;
  if (t === 'run.completed') {
    const gate = row.payload.gate;
    return gate === 'RED' ? 'red' : gate === 'AMBER' ? 'amber' : gate === 'GREEN' ? 'green' : 'neutral';
  }
  if (t === 'rule.source_checked') return row.payload.changed === true ? 'amber' : 'teal';
  if (t.endsWith('rejected') || t.endsWith('refused') || t === 'auth.denied' || t.endsWith('failed') || t.endsWith('fetch_error')) return 'red';
  if (t === 'task.opened' || t === 'edge.proposed' || t === 'artifact.content_changed') return 'amber';
  if (t === 'test_case.approved' || t === 'edge.confirmed' || t === 'audit.checkpoint') return 'green';
  if (t in EVENT_LABELS) return 'teal';
  return 'neutral';
}

function s(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function excerpt(text: string, max = 72): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function join(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' · ');
}

/** "ollama/qwen2.5:3b-instruct" → "qwen2.5:3b-instruct" — the provider prefix is noise in a one-liner. */
export function shortModel(id: string): string {
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

export interface AuditContext {
  runsById?: ReadonlyMap<string, RunOut>;
  severityByCode?: ReadonlyMap<string, string>;
}

function blockingFromPayload(payload: JsonObject, severityByCode: ReadonlyMap<string, string>): number | null {
  if (!isObject(payload.contracts) || severityByCode.size === 0) return null;
  let total = 0;
  for (const [code, counts] of Object.entries(payload.contracts)) {
    if (severityByCode.get(code) !== 'BLOCK' || !isObject(counts)) continue;
    total += (n(counts.FAIL) ?? 0) + (n(counts.ERROR) ?? 0);
  }
  return total;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line of meaning per event type; falls back to the payload's scalar fields. */
export function auditSummary(row: AuditOut, ctx: AuditContext = {}): string {
  const p = row.payload ?? {};
  const severity = ctx.severityByCode ?? new Map<string, string>();
  switch (row.event_type) {
    case 'run.completed': {
      const run = ctx.runsById?.get(row.entity_id);
      const blocking = run ? blockingFailures(run, severity).failures : blockingFromPayload(p, severity);
      const head = run ? join([run.workflow_code, `v${run.prompt_version}`, shortModel(run.model_id)]) : '';
      const gate = s(p.gate) || run?.gate || '';
      const opened = n(p.review_tasks_opened);
      const advisory = n(p.advisory_items_opened);
      return join([
        head ? `${head} → ${gate}` : gate,
        blocking !== null ? plural(blocking, 'blocking failure') : null,
        opened !== null ? `${plural(opened, 'review task')} opened` : null,
        advisory ? `${advisory} advisory` : null,
      ]);
    }
    case 'run.started': {
      const workflow = s(p.run_key).split(':')[0];
      return join([
        workflow,
        n(p.prompt_version) !== null ? `v${p.prompt_version as number}` : null,
        shortModel(s(p.model) || s(p.model_id)),
        s(p.adapter),
        s(p.rule_date) && `rule date ${s(p.rule_date)}`,
        s(p.trigger) && `trigger ${s(p.trigger)}`,
      ]);
    }
    case 'run.failed':
      return excerpt(s(p.error) || 'run failed', 110);
    case 'run.deduplicated':
      return join(['identical inputs — existing run reused', s(p.run_key) && excerpt(s(p.run_key), 60)]);
    case 'task.opened':
      return join([
        kindLabel(s(p.kind)),
        s(p.rule) || s(p.contract),
        s(p.asset) && `→ ${s(p.asset)}`,
        s(p.direction).replace(/_/g, '-'),
        p.aggregate === true ? 'advisory aggregate' : null,
      ]);
    case 'task.transitioned':
      return join([`${s(p.from) || '?'} → ${s(p.to) || '?'}`, s(p.reason_code), s(p.note) && `“${excerpt(s(p.note), 60)}”`, s(p.test_case_id) && 'test case created']);
    case 'task.transition_rejected':
      return join([`${s(p.from) || '?'} → ${s(p.to) || '?'} refused`, excerpt(s(p.reason) || s(p.error), 80)]);
    case 'evidence.exported':
      return join([`${s(p.format) || 'json'} bundle ${shortHash(s(p.bundle_sha256), 12)}`, n(p.audit_rows) !== null ? `${plural(n(p.audit_rows) ?? 0, 'audit row')} included` : null]);
    case 'export.generated':
      return join([s(p.format), n(p.rows) !== null ? plural(n(p.rows) ?? 0, 'row') : null]);
    case 'edge.superseded':
      return join([s(p.asset), s(p.span) && `“${excerpt(s(p.span), 70)}” no longer in the artifact`]);
    case 'edge.restored':
      return join([s(p.asset), s(p.rule) && `${s(p.rule)}${n(p.version) !== null ? `@v${p.version as number}` : ''}`, 'quoted span is back']);
    case 'edge.confirmed':
    case 'edge.proposed': {
      const version = n(p.version) !== null ? `@v${p.version as number}` : '';
      return join([s(p.asset) && s(p.rule) ? `${s(p.asset)} → ${s(p.rule)}${version}` : s(p.asset) || s(p.rule), s(p.polarity), s(p.matcher)]);
    }
    case 'edge.rejected':
      return join([s(p.via_task) && `via task ${s(p.via_task).slice(0, 8)}`, s(p.reason_code)]);
    case 'rule.version_created':
      return join([
        `${s(p.rule)} v${s(p.version)}`,
        s(p.status).replace(/_/g, ' '),
        s(p.effective_from) && `applies from ${s(p.effective_from)}`,
        s(p.change_classification).replace(/_/g, ' '),
      ]);
    case 'rule.version_closed':
      return join([`${s(p.rule)} v${s(p.version)}`, s(p.effective_to) && `closed ${s(p.effective_to)}`]);
    case 'rule.version_annotated': {
      const after = isObject(p.after) ? p.after : {};
      const deferrals = Array.isArray(after.deferrals) ? after.deferrals.length : 0;
      return join([
        `${s(p.rule)} v${s(p.version)}`,
        s(after.vote_date) ? `vote ${s(after.vote_date)}` : null,
        deferrals ? plural(deferrals, 'deferral') : null,
        'text unchanged',
        s(p.source),
      ]);
    }
    case 'rule.proposal_renumbered':
      return join([
        `${s(p.rule)} proposal v${s(p.from_version)} → v${s(p.to_version)}`,
        excerpt(s(p.reason), 60),
        p.yaml_matches_proposal === true ? 'enacted as proposed' : p.yaml_matches_proposal === false ? 'enacted text differs from the proposal' : null,
      ]);
    case 'contract.version_created': {
      const changed = Array.isArray(p.changed) ? p.changed.map(s).filter(Boolean) : [];
      return join([
        `${s(p.contract)} v${s(p.previous_version) || '?'} → v${s(p.version)}`,
        changed.length ? `changed ${changed.join(', ')}` : null,
        s(p.source),
      ]);
    }
    case 'run.egress_refused':
      return join([shortModel(s(p.model_id) || s(p.model)), excerpt(s(p.reason) || s(p.error) || 'model call blocked by the egress policy', 90)]);
    case 'sandbox.artifact_checked':
      return join([
        s(p.label),
        n(p.matches) !== null ? plural(n(p.matches) ?? 0, 'match', 'matches') : null,
        n(p.stale) !== null ? `${n(p.stale)} stale` : null,
        s(p.as_of) && `as of ${s(p.as_of)}`,
        s(p.text_sha256) && `sha256 ${shortHash(s(p.text_sha256), 10)} · text not stored`,
      ]);
    case 'sandbox.transcript_checked': {
      const outcomes = isObject(p.outcomes) ? Object.values(p.outcomes).map(s) : [];
      const failing = outcomes.filter((o) => o === 'FAIL' || o === 'ERROR').length;
      return join([
        shortModel(s(p.model_id)),
        s(p.error) ? `failed: ${s(p.error)}` : outcomes.length ? `${plural(outcomes.length, 'contract')} · ${failing} failing` : null,
        n(p.latency_ms) !== null ? `${n(p.latency_ms)} ms` : null,
        s(p.text_sha256) && `sha256 ${shortHash(s(p.text_sha256), 10)} · text not stored`,
      ]);
    }
    case 'rule.source_checked':
      return join([s(p.rule), p.changed === true ? 'source changed' : 'unchanged', hostname(s(p.source_url)), s(p.mode)]);
    case 'rules.reloaded':
      return join([
        n(p.rules_created) !== null ? `${plural(n(p.rules_created) ?? 0, 'rule')} created` : null,
        n(p.versions_created) !== null ? `${plural(n(p.versions_created) ?? 0, 'version')} created` : null,
        n(p.unchanged) !== null ? `${n(p.unchanged)} unchanged` : null,
      ]);
    case 'scan.started':
      return join([s(p.idempotency_key), p.live === true ? 'live fetch' : 'snapshot', s(p.as_of) && `as of ${s(p.as_of)}`]);
    case 'scan.completed': {
      const st = isObject(p.stats) ? p.stats : p;
      return join([
        n(st.artifacts) !== null ? plural(n(st.artifacts) ?? 0, 'artifact') : null,
        n(st.new_versions) !== null ? `${n(st.new_versions)} new versions` : null,
        n(st.edges_new) !== null ? `${n(st.edges_new)} new encodings` : null,
        n(st.proposed_new) ? `${n(st.proposed_new)} proposed` : null,
        n(st.edges_superseded) ? `${n(st.edges_superseded)} superseded` : null,
        n(st.fetch_errors) ? `${n(st.fetch_errors)} fetch errors` : null,
      ]);
    }
    case 'staleness.evaluated': {
      const counts = isObject(p.counts) ? p.counts : p;
      return join([
        s(p.rule) || row.entity_id,
        s(p.as_of) && `as of ${s(p.as_of)}`,
        n(p.in_force_version) !== null ? `v${p.in_force_version as number} in force` : null,
        n(counts.total) !== null ? `${n(counts.total)} stale encodings` : null,
        n(p.tasks_opened) !== null ? `${n(p.tasks_opened)} tasks opened` : null,
      ]);
    }
    case 'artifact.content_changed':
      return join([s(p.code), `hash ${shortHash(s(p.content_hash) || s(p.new_hash), 12)}`, s(p.mode)]);
    case 'artifact.unchanged':
      return s(p.code) || row.entity_id;
    case 'artifact.fetch_error':
      return join([s(p.code), excerpt(s(p.error), 80)]);
    case 'test_case.created':
      return join([`${s(p.contract)} × ${s(p.transcript) || '—'}`, s(p.reason_code), 'pending second approver']);
    case 'test_case.approved':
      return join([s(p.created_by) && `created by ${s(p.created_by)}`, 'approved by a different user']);
    case 'ingest.completed':
      return join([s(p.format), n(p.created) !== null ? `${n(p.created)} created` : null, n(p.skipped_existing) ? `${n(p.skipped_existing)} skipped` : null, s(p.batch_hash) && `batch ${shortHash(s(p.batch_hash), 10)}`]);
    case 'access.reviewed':
      return join([n(p.accounts) !== null ? `${n(p.accounts)} accounts` : null, n(p.default_credential_accounts) ? `${n(p.default_credential_accounts)} on default passwords` : null, n(p.denied_24h) !== null ? `${n(p.denied_24h)} denied in 24 h` : null]);
    case 'audit.checkpoint':
      return join([n(p.through_id) !== null ? `through row ${n(p.through_id)}` : null, s(p.tip) && `tip ${shortHash(s(p.tip), 12)}`, n(p.rows_verified) !== null ? `${n(p.rows_verified)} rows verified` : null]);
    case 'auth.denied':
      return Array.isArray(p.required)
        ? `role ${s(p.role)} lacks ${p.required.map(s).join(' / ')}`
        : join([s(p.reason), s(p.attempted) && `attempted ${s(p.attempted)}`, s(p.error)]);
    default:
      return join(
        Object.entries(p)
          .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          .slice(0, 4)
          .map(([k, v]) => `${k} ${excerpt(s(v), 40)}`),
      );
  }
}

/** Before → after, when the payload records a transition. */
export function auditTransition(row: AuditOut): { from: string; to: string } | null {
  const { from, to } = row.payload ?? {};
  return typeof from === 'string' && typeof to === 'string' ? { from, to } : null;
}

/** In-app link for the row's entity, when there is a screen for it. */
export function auditEntityLink(row: AuditOut): { to: string; label: string } | null {
  const p = row.payload ?? {};
  switch (row.entity_type) {
    case 'run':
      return { to: `/runs/${encodeURIComponent(row.entity_id)}`, label: `Run ${row.entity_id.slice(0, 8)}` };
    case 'review_task':
      return { to: `/review?lane=all&task=${encodeURIComponent(row.entity_id)}`, label: `Task ${row.entity_id.slice(0, 8)}` };
    case 'rule':
    case 'rule_version':
      return typeof p.rule === 'string' ? { to: `/rules/${encodeURIComponent(p.rule)}`, label: p.rule } : null;
    case 'asset':
      return typeof p.code === 'string' ? { to: `/artifacts/${encodeURIComponent(p.code)}`, label: p.code } : null;
    case 'edge':
      return typeof p.asset === 'string' ? { to: `/artifacts/${encodeURIComponent(p.asset)}`, label: p.asset } : null;
    case 'test_case':
      return { to: '/test-cases', label: 'Test cases' };
    case 'contract':
      return typeof p.contract === 'string' ? { to: `/contracts/${encodeURIComponent(p.contract)}`, label: p.contract } : null;
    default:
      return null;
  }
}
