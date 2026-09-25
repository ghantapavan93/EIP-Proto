import { Fragment } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, LogOut, Menu, Search } from 'lucide-react';
import { OPEN_PALETTE_EVENT } from '../../lib/palette';
import { useQueryClient } from '@tanstack/react-query';
import { clearCredentials } from '../../api/auth';
import type { StatusOut } from '../../api/types';
import { useShell } from './useShell';
import { Chip } from '../ui/Chip';
import { IdentityMenu } from './IdentityMenu';
import { SystemPulse } from './StatusRail';
import { MOBILE_NAV_ID } from './shellContext';

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. */
function paletteShortcut(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K';
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad/i.test(platform) ? '⌘K' : 'Ctrl K';
}

export function TopBar({
  user,
  role,
  status,
  onOpenNav,
  navOpen = false,
}: {
  user: string | null;
  role: string | null;
  /** GET /api/status, for the health word and the last run */
  status?: StatusOut;
  /** Opens the navigation drawer (shown below `lg`, where the rail is hidden). */
  onOpenNav?: () => void;
  navOpen?: boolean;
}) {
  const { topBar } = useShell();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const shortcut = paletteShortcut();

  const signOut = () => {
    clearCredentials();
    qc.clear();
    navigate('/login', { replace: true });
  };

  // No overflow-hidden on the bar: the Health popover hangs below it. The
  // breadcrumb is the only part that shrinks, so the actions stay reachable.
  return (
    <header className="flex h-topbar min-w-0 items-center gap-2 border-b border-hairline bg-surface px-3 sm:gap-3 sm:px-6">
      {onOpenNav && (
        <button
          type="button"
          className="btn btn-ghost btn-sm shrink-0 px-1.5 lg:hidden"
          onClick={onOpenNav}
          aria-label="Open navigation"
          aria-controls={MOBILE_NAV_ID}
          aria-expanded={navOpen}
        >
          <Menu size={16} aria-hidden />
        </button>
      )}
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[13px]">
        <Link to="/" className="hidden shrink-0 font-semibold text-ink hover:no-underline sm:inline">
          Backstop
        </Link>
        {topBar.crumbs.map((c, i) => (
          <Fragment key={`${c.label}-${i}`}>
            <ChevronRight size={14} className={i === 0 ? 'hidden shrink-0 text-ink-3 sm:block' : 'shrink-0 text-ink-3'} aria-hidden />
            {c.to ? (
              <Link to={c.to} className="shrink-0 text-ink-2 hover:text-teal-ink">
                {c.label}
              </Link>
            ) : (
              <span className="truncate font-medium text-ink" aria-current="page">
                {c.label}
              </span>
            )}
          </Fragment>
        ))}
      </nav>
      {topBar.asOf && (
        <span className="hidden shrink-0 sm:inline">
          <Chip tone="teal" mono title="Evaluation date">
            as of {topBar.asOf}
          </Chip>
        </span>
      )}
      <SystemPulse status={status} />
      <button
        type="button"
        className="btn btn-ghost btn-sm hidden shrink-0 gap-2 text-ink-2 md:inline-flex"
        onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
        title={`Go to a rule, artifact or run (${shortcut})`}
        aria-label={`Go to a rule, artifact or run (${shortcut})`}
      >
        {/* the word gives way before the breadcrumb does; the key hint stays */}
        <Search size={13} aria-hidden /> <span className="hidden 2xl:inline">Go to…</span>
        <kbd className="kbd">{shortcut}</kbd>
      </button>
      <IdentityMenu />
      <button
        type="button"
        className="btn btn-ghost btn-sm shrink-0 px-2"
        onClick={signOut}
        aria-label="Sign out"
        title={user ? `Sign out ${user}${role ? ` (${role})` : ''}` : 'Sign out'}
      >
        <LogOut size={13} aria-hidden />
        <span className="hidden 2xl:inline">Sign out</span>
      </button>
    </header>
  );
}
