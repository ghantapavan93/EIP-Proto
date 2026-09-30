/**
 * TypeScript port of backend/backstop/core/permissions.py, used only by the
 * mock API (backend-free mode, `npm run dev:mock`) to answer GET /me and the
 * admin access review. The UI never reads this table: it asks /me.
 *
 * Keep it in step with the backend: same action ids, labels, roles and rule
 * text, and the same "why" sentences.
 */

import type { AccessActionOut, MeOut, MePermission, RoleInfo } from '../api/types';

export const ROLE_ORDER = ['analyst', 'engineer', 'admin'] as const;

const OPERATORS = ['engineer', 'admin'];
const ADMINS = ['admin'];
const EVERYONE = [...ROLE_ORDER];

const ROLE_INFO: Record<string, { label: string; description: string }> = {
  analyst: {
    label: 'QA Compliance Analyst',
    description:
      'Reads everything and decides review tasks (verify, dismiss, uphold, override). Does not start runs or scans, change rules, republish artifacts or approve test cases.',
  },
  engineer: {
    label: 'AI Enablement Engineer',
    description:
      'Everything an analyst can do, plus starting runs and scans, proposing rule versions, ingesting transcripts, republishing artifacts and approving test cases someone else created.',
  },
  admin: {
    label: 'Administrator',
    description:
      'Governs the platform: everything an engineer can do, plus the access review (who can do what, default passwords, denied attempts), adopting the rule corpus into the running system, and taking audit checkpoints kept outside the database. Accounts come from BACKSTOP_USERS, a stand-in for SSO.',
  },
};

/** In the backend's order. `rule` is the extra condition in words ("" when the role is the whole rule). */
export const ACTIONS: AccessActionOut[] = [
  {
    action: 'view',
    label: 'View rules, artifacts, runs, the review queue and the audit log',
    roles: EVERYONE,
    rule: '',
  },
  {
    action: 'pick_up_tasks',
    label: 'Pick up a review task (open → in review)',
    roles: EVERYONE,
    rule: 'the review state machine lets anyone start a review',
  },
  {
    action: 'decide_tasks',
    label: 'Decide review tasks (verify, dismiss, uphold, override)',
    roles: EVERYONE,
    rule: 'dismiss, uphold and override need a reason code',
  },
  {
    action: 'republish',
    label: 'Mark a verified stale artifact as republished',
    roles: OPERATORS,
    rule: 'the task must be verified first',
  },
  {
    action: 'approve_test_cases',
    label: 'Approve a test case (a different person from its creator)',
    roles: OPERATORS,
    rule: 'never one you created yourself: two-person rule',
  },
  { action: 'start_runs', label: 'Start a harness run', roles: OPERATORS, rule: '' },
  { action: 'start_scans', label: 'Scan the artifact inventory', roles: OPERATORS, rule: '' },
  {
    action: 'check_rule_sources',
    label: "Check the regulators' source pages for changed text",
    roles: OPERATORS,
    rule: '',
  },
  { action: 'propose_rule_versions', label: 'Propose a new rule version (what-if)', roles: OPERATORS, rule: '' },
  {
    action: 'reload_rules',
    label: 'Adopt the rule corpus from git into the running system',
    roles: ADMINS,
    rule: 'it changes what every later run is checked against: engineers propose versions, an admin adopts',
  },
  {
    action: 'review_access',
    label: 'Review access: accounts, roles, default passwords, denied attempts',
    roles: ADMINS,
    rule: 'every review is itself audit-logged',
  },
  {
    action: 'checkpoint_audit',
    label: 'Take an audit checkpoint to keep outside the database',
    roles: ADMINS,
    rule: 'refused while the chain is broken; anyone can later verify a checkpoint',
  },
  { action: 'ingest_transcripts', label: 'Ingest transcripts from an export file', roles: OPERATORS, rule: '' },
  {
    action: 'open_stale_tasks',
    label: "Open stale-artifact review tasks from a rule's impact",
    roles: OPERATORS,
    rule: 'reading the impact never opens tasks, for any role',
  },
  {
    action: 'export_evidence',
    label: 'Export evidence bundles and run results',
    roles: EVERYONE,
    rule: 'every export is audit-logged',
  },
  {
    action: 'use_sandbox',
    label: 'Check pasted text in the sandbox',
    roles: EVERYONE,
    rule: 'rate-limited per user; nothing pasted is stored',
  },
];

export function roleLabelFor(role: string): string {
  return ROLE_INFO[role]?.label ?? role;
}

function names(roles: string[]): string {
  const ordered = ROLE_ORDER.filter((r) => roles.includes(r));
  return ordered.length === ROLE_ORDER.length ? 'any signed-in role' : ordered.join(' or ');
}

function permissionsFor(role: string): MePermission[] {
  return ACTIONS.map((a) => {
    const allowed = a.roles.includes(role);
    const who = names(a.roles);
    const why = allowed
      ? `Allowed for ${who}${a.rule ? `; ${a.rule}` : ''}.`
      : `Not allowed: only ${who} may do this${a.rule ? ` (${a.rule})` : ''}.`;
    return { action: a.action, label: a.label, allowed, why };
  });
}

export function rolesOverview(): RoleInfo[] {
  return ROLE_ORDER.map((role) => ({
    role,
    label: ROLE_INFO[role].label,
    description: ROLE_INFO[role].description,
    can: ACTIONS.filter((a) => a.roles.includes(role)).map((a) => a.action),
  }));
}

/** GET /me for a signed-in demo account. */
export function meFor(name: string, role: string): MeOut {
  return {
    name,
    role,
    role_label: ROLE_INFO[role]?.label ?? role,
    role_description: ROLE_INFO[role]?.description ?? '',
    permissions: permissionsFor(role),
    roles: rolesOverview(),
  };
}
