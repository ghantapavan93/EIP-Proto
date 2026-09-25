import { useCallback, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { getCredentials } from '../../api/auth';
import { useMeta, useReviewTasks, useStatus } from '../../api/hooks';
import { NavRail } from './NavRail';
import { TopBar } from './TopBar';
import { EnvBanner } from './EnvBanner';
import { ShellProvider } from './ShellProvider';
import { ErrorState } from '../ui/ErrorState';
import { StatusRail } from './StatusRail';
import { CommandPalette } from './CommandPalette';

const FOOTER =
  'Prototype built for a conversation with EIP. Not affiliated with or endorsed by Elite Insurance Partners or any government agency. All call transcripts and internal artifacts are synthetic; public pages are real and attributed.';

/** Mirrors document.visibilityState onto <html data-tab-hidden> so live pulses pause in a background tab. */
function useTabVisibilityFlag() {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      if (document.visibilityState === 'hidden') root.setAttribute('data-tab-hidden', '');
      else root.removeAttribute('data-tab-hidden');
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      root.removeAttribute('data-tab-hidden');
    };
  }, []);
}

function Shell() {
  useTabVisibilityFlag();
  const location = useLocation();
  const meta = useMeta();
  const status = useStatus();
  const openTasks = useReviewTasks({ state: 'open' });
  // The nav badge counts work a human must decide — advisory observations are not tickets.
  const openCount = status.data?.review.actionable_open;
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const openNav = useCallback(() => setNavOpen(true), []);

  return (
    <div className="flex h-full min-h-screen w-full bg-canvas">
      <NavRail openReviewCount={openCount} mobileOpen={navOpen} onMobileClose={closeNav} />
      <div className="flex min-w-0 flex-1 flex-col">
        <EnvBanner label={meta.data?.environment_label ?? 'PROTOTYPE · SYNTHETIC DATA'} notice={meta.data?.synthetic_notice} />
        <TopBar
          user={status.data?.user.name ?? meta.data?.user ?? getCredentials()?.username ?? null}
          role={status.data?.user.role ?? meta.data?.role ?? null}
          status={status.data}
          onOpenNav={openNav}
          navOpen={navOpen}
        />
        <StatusRail status={status.data} openTasks={openTasks.data} error={status.error} />
        <main className="min-w-0 flex-1 overflow-y-auto">
          {/* Only a /meta that never loaded blanks the screen; a failed background refetch keeps the cached data. */}
          {meta.isError && !meta.data ? (
            <div className="p-4">
              <ErrorState error={meta.error} title="Could not load /meta" retry={() => void meta.refetch()} />
            </div>
          ) : (
            // Keyed on the path: a new screen fades up 4px; query-string changes (filters, tabs) do not replay it.
            <div key={location.pathname} className="route-enter">
              <Outlet />
            </div>
          )}
          <footer className="mt-6 border-t border-hairline px-4 py-3 text-[11px] leading-snug text-footer sm:px-6">{FOOTER}</footer>
        </main>
        <CommandPalette />
      </div>
    </div>
  );
}

/** Auth gate + chrome. Redirects to /login when no credentials are stored. */
export function AppShell() {
  const location = useLocation();
  if (!getCredentials()) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return (
    <ShellProvider>
      <Shell />
    </ShellProvider>
  );
}
