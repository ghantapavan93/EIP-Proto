import { useMe, useMeta, useStatus } from '../../api/hooks';
import { getCredentials } from '../../api/auth';
import type { MeOut, MePermission } from '../../api/types';
import { fallbackMe, permissionFor, type RoleAction } from '../../lib/roles';

/** The signed-in identity: GET /me when the server has it, else derived from /meta or /status. */
export function useIdentity(): { me: MeOut; fromServer: boolean; isLoading: boolean } {
  const me = useMe();
  const meta = useMeta();
  const status = useStatus();
  if (me.data) return { me: me.data, fromServer: true, isLoading: false };
  const name = status.data?.user.name ?? meta.data?.user ?? getCredentials()?.username ?? null;
  const role = status.data?.user.role ?? meta.data?.role ?? null;
  return { me: fallbackMe(name, role), fromServer: false, isLoading: me.isLoading && !role };
}

/**
 * Whether the signed-in role may take `action`, and the sentence to show when
 * it may not. `known` is false until /me or /meta has answered, so a control
 * can wait instead of flashing "refused" at an engineer.
 */
export function usePermission(action: RoleAction): MePermission & { known: boolean } {
  const me = useMe();
  const meta = useMeta();
  const role = meta.data?.role ?? null;
  return { ...permissionFor(me.data, role, action), known: Boolean(me.data) || role !== null };
}
