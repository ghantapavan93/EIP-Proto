import { useContext, useEffect } from 'react';
import { ShellContext, type Crumb, type ShellApi } from './shellContext';

export function useShell(): ShellApi {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used inside <ShellProvider>');
  return ctx;
}

/** Pages declare their breadcrumb (and optional as-of date) for the top bar. */
export function useTopBar(crumbs: Crumb[], asOf?: string | null): void {
  const { setTopBar } = useShell();
  const key = JSON.stringify(crumbs) + (asOf ?? '');
  useEffect(() => {
    setTopBar({ crumbs, asOf });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setTopBar]);
}
