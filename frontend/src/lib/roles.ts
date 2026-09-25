/**
 * Who can do what. GET /me is the source of truth (backend
 * core/permissions.py, which a backend test checks against every
 * require_role); this table mirrors it for a server without /me and for the
 * moment before it answers. Action ids are the server's: analysts review and
 * decide, engineers and admins also change the system, and no one approves
 * their own override.
 */

import type { MeOut, MePermission, RoleInfo } from '../api/types';

export type RoleAction =
  | 'view'
  | 'use_sandbox'
  | 'pick_up_tasks'
  | 'decide_tasks'
  | 'export_evidence'
  | 'start_runs'
  | 'start_scans'
  | 'ingest_transcripts'
  | 'propose_rule_versions'
  | 'check_rule_sources'
  | 'reload_rules'
  | 'open_stale_tasks'
  | 'republish'
  | 'approve_test_cases';

interface ActionSpec {
  label: string;
  roles: string[];
  /** the sentence a refused control shows */
  refusal: string;
}

const EDITORS = ['engineer', 'admin'];
const EVERYONE = ['analyst', 'engineer', 'admin'];

/** In the server's order (core/permissions.py ACTIONS). */
export const ACTIONS: Record<RoleAction, ActionSpec> = {
  view: { label: 'View rules, artifacts, runs, the review queue and the audit log', roles: EVERYONE, refusal: '' },
  pick_up_tasks: { label: 'Pick up a review task (open → in review)', roles: EVERYONE, refusal: '' },
  decide_tasks: { label: 'Decide review tasks (verify, dismiss, uphold, override)', roles: EVERYONE, refusal: '' },
  republish: { label: 'Mark a verified stale artifact as republished', roles: EDITORS, refusal: 'Engineers and admins mark artifacts republished' },
  approve_test_cases: { label: 'Approve a test case (a different person from its creator)', roles: EDITORS, refusal: 'Engineers and admins approve test cases — never their own' },
  start_runs: { label: 'Start a harness run', roles: EDITORS, refusal: 'Engineers and admins can start runs' },
  start_scans: { label: 'Scan the artifact inventory', roles: EDITORS, refusal: 'Engineers and admins can run scans' },
  check_rule_sources: { label: "Check the regulators' source pages for changed text", roles: EDITORS, refusal: 'Engineers and admins can re-check sources' },
  propose_rule_versions: { label: 'Propose a new rule version (what-if)', roles: EDITORS, refusal: 'Engineers and admins can propose rule versions' },
  reload_rules: { label: 'Reload the rule corpus from git', roles: EDITORS, refusal: 'Engineers and admins can reload rules' },
  ingest_transcripts: { label: 'Ingest transcripts from an export file', roles: EDITORS, refusal: 'Engineers and admins can ingest transcripts' },
  open_stale_tasks: { label: "Open stale-artifact review tasks by reading a rule's impact", roles: EDITORS, refusal: 'Engineers and admins open stale-artifact tasks' },
  export_evidence: { label: 'Export evidence bundles and run results', roles: EVERYONE, refusal: '' },
  use_sandbox: { label: 'Check pasted text in the sandbox', roles: EVERYONE, refusal: '' },
};

const ORDER = Object.keys(ACTIONS) as RoleAction[];

export const ROLE_LABELS: Record<string, string> = { analyst: 'Analyst', engineer: 'Engineer', admin: 'Admin' };

const ROLE_INFO: Record<string, { label: string; description: string }> = {
  analyst: {
    label: 'QA Compliance Analyst',
    description: 'Reads everything and decides review tasks (verify, dismiss, uphold, override). Does not start runs or scans, change rules, republish artifacts or approve test cases.',
  },
  engineer: {
    label: 'AI Enablement Engineer',
    description: 'Everything an analyst can do, plus starting runs and scans, proposing rule versions, ingesting transcripts, republishing artifacts and approving test cases someone else created.',
  },
  admin: {
    label: 'Administrator',
    description: 'The same permissions as an engineer in this prototype. Accounts are a stand-in for SSO; there is no user management screen.',
  },
};

/** `can` holds action ids, as the server sends them; show them with actionLabel(). */
export const ROLES: RoleInfo[] = ['analyst', 'engineer', 'admin'].map((role) => ({
  role,
  label: ROLE_INFO[role].label,
  description: ROLE_INFO[role].description,
  can: ORDER.filter((a) => ACTIONS[a].roles.includes(role)),
}));

/** Short role name for chips ("Analyst"), whatever the long label is. */
export function roleTitle(role: string | null | undefined): string {
  if (!role) return '—';
  return ROLE_LABELS[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

/** A readable label for an action id: the server's label when /me sent one, else the table's, else the id humanised. */
export function actionLabel(me: Pick<MeOut, 'permissions'> | null | undefined, id: string): string {
  const fromServer = me?.permissions.find((p) => p.action === id)?.label;
  if (fromServer) return fromServer;
  const spec = (ACTIONS as Record<string, ActionSpec | undefined>)[id];
  if (spec) return spec.label;
  const words = id.replace(/[_.-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The identity a server without /me implies: permissions from the static table. */
export function fallbackMe(name: string | null, role: string | null): MeOut {
  const r = role ?? 'analyst';
  return {
    name: name ?? '—',
    role: r,
    role_label: ROLE_INFO[r]?.label ?? roleTitle(r),
    role_description: ROLE_INFO[r]?.description ?? '',
    permissions: ORDER.map((action) => {
      const spec = ACTIONS[action];
      const allowed = spec.roles.includes(r);
      return { action, label: spec.label, allowed, why: allowed ? `Allowed for ${roleTitle(r).toLowerCase()}.` : spec.refusal };
    }),
    roles: ROLES,
  };
}

/**
 * The permission for one action: the server's answer when /me names it, else
 * the static table. `why` on a refused action is the house-style sentence
 * ("Engineers and admins can start runs"); the identity popover shows the
 * server's own wording.
 */
export function permissionFor(me: MeOut | null | undefined, role: string | null | undefined, action: RoleAction): MePermission {
  const spec = ACTIONS[action];
  const found = me?.permissions.find((p) => p.action === action);
  if (found) return { ...found, why: found.allowed ? found.why : spec.refusal || found.why };
  const r = me?.role ?? role ?? null;
  const allowed = r !== null && spec.roles.includes(r);
  return { action, label: spec.label, allowed, why: allowed ? '' : spec.refusal };
}
