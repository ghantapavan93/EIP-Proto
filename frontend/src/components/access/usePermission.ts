import { useMe } from '../../api/hooks';
import type { MeOut, MePermission } from '../../api/types';
import { permissionFor, type RoleAction } from '../../lib/roles';

/** The signed-in identity from GET /me; undefined until it answers. */
export function useIdentity(): { me: MeOut | undefined; isLoading: boolean } {
  const me = useMe();
  return { me: me.data, isLoading: me.isLoading };
}

/**
 * Whether the signed-in role may take `action`, and the sentence to show when
 * it may not. `known` is false until /me has answered, so a control can wait
 * instead of flashing "refused" at an engineer.
 */
export function usePermission(action: RoleAction): MePermission & { known: boolean } {
  const me = useMe();
  return { ...permissionFor(me.data, action), known: Boolean(me.data) };
}
