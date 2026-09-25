import { useMemo, useState, type ReactNode } from 'react';
import { ShellContext, type TopBarState } from './shellContext';

export function ShellProvider({ children }: { children: ReactNode }) {
  const [topBar, setTopBar] = useState<TopBarState>({ crumbs: [] });
  const api = useMemo(() => ({ topBar, setTopBar }), [topBar]);
  return <ShellContext.Provider value={api}>{children}</ShellContext.Provider>;
}
