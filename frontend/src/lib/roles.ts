/**
 * Who can do what, as the UI shows it. GET /me is the only source of the
 * decision (backend core/permissions.py, which a backend test checks against
 * every require_role); this module only names the action ids the UI gates on
 * and words a refused control.
 */

import type { MeOut, MePermission } from '../api/types';

/** Action ids from GET /me permissions[].action that UI controls are gated on. */
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
  | 'approve_test_cases'
  | 'review_access'
  | 'checkpoint_audit';

/**
 * The sentence a refused control shows on hover and focus. The server's `why`
 * ("Not allowed: only engineer or admin may do this.") is written for the
 * identity popover; next to a button a shorter sentence reads better.
 */
const REFUSALS: Partial<Record<RoleAction, string>> = {
  republish: 'Engineers and admins mark artifacts republished',
  approve_test_cases: 'Engineers and admins approve test cases — never their own',
  start_runs: 'Engineers and admins can start runs',
  start_scans: 'Engineers and admins can run scans',
  check_rule_sources: 'Engineers and admins can re-check sources',
  propose_rule_versions: 'Engineers and admins can propose rule versions',
  reload_rules: 'Only an admin adopts the rule corpus; engineers propose versions',
  review_access: 'Only an admin reviews access',
  checkpoint_audit: 'Only an admin takes audit checkpoints; anyone can verify one',
  ingest_transcripts: 'Engineers and admins can ingest transcripts',
  open_stale_tasks: 'Engineers and admins open stale-artifact tasks',
};

export const ROLE_LABELS: Record<string, string> = { analyst: 'Analyst', engineer: 'Engineer', admin: 'Admin' };

/** Short role name for chips ("Analyst"), whatever the long label is. */
export function roleTitle(role: string | null | undefined): string {
  if (!role) return '—';
  return ROLE_LABELS[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

/** A readable label for an action id: the server's label, else the id humanised. */
export function actionLabel(me: Pick<MeOut, 'permissions'> | null | undefined, id: string): string {
  const fromServer = me?.permissions.find((p) => p.action === id)?.label;
  if (fromServer) return fromServer;
  const words = id.replace(/[_.-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The permission for one action from GET /me. An action /me does not list is
 * refused: a control is never enabled on a guess. A refused action carries the
 * short refusal sentence when there is one, else the server's own reason.
 */
export function permissionFor(me: Pick<MeOut, 'permissions'> | null | undefined, action: RoleAction): MePermission {
  const found = me?.permissions.find((p) => p.action === action);
  const refusal = REFUSALS[action];
  if (!found)
    return { action, label: actionLabel(me, action), allowed: false, why: refusal ?? 'Not available to your role.' };
  return found.allowed ? found : { ...found, why: refusal ?? found.why };
}
