import { useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  CalendarClock,
  Cpu,
  FileCheck2,
  FileText,
  FlaskConical,
  GitBranch,
  Inbox,
  ScanText,
  ScrollText,
  ShieldCheck,
  Target,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { MOBILE_NAV_ID } from './shellContext';

interface NavItem {
  to: string;
  label: string;
  icon: typeof GitBranch;
  end?: boolean;
}

const GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Monitor',
    items: [
      { to: '/', label: 'Change triggers', icon: GitBranch, end: true },
      { to: '/readiness', label: 'Readiness', icon: CalendarClock },
      { to: '/runs', label: 'Runs', icon: Activity },
      { to: '/review', label: 'Review', icon: Inbox },
    ],
  },
  {
    label: 'Sandbox',
    items: [{ to: '/try', label: 'Try your data', icon: ScanText }],
  },
  {
    label: 'Knowledge',
    items: [
      { to: '/rules', label: 'Rules', icon: BookOpen },
      { to: '/artifacts', label: 'Artifacts', icon: FileText },
      { to: '/contracts', label: 'Contracts', icon: FileCheck2 },
    ],
  },
  {
    label: 'Validate',
    items: [
      { to: '/evals', label: 'Evals', icon: Target },
      { to: '/models', label: 'Models', icon: Cpu },
      { to: '/test-cases', label: 'Test cases', icon: FlaskConical },
    ],
  },
  {
    label: 'System',
    items: [{ to: '/audit', label: 'Audit', icon: ScrollText }],
  },
];

function RailBody({ openReviewCount, onNavigate }: { openReviewCount?: number; onNavigate?: () => void }) {
  return (
    <div className="mt-3 flex-1 space-y-4 overflow-y-auto px-3 pb-4">
      {GROUPS.map((group) => (
        <div key={group.label}>
          <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-on-navy-faint">{group.label}</div>
          <ul className="space-y-px">
            {group.items.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'flex h-8 items-center gap-2.5 rounded-[6px] px-2.5 text-[13px] font-medium text-on-navy-muted hover:bg-on-navy/8 hover:text-on-navy hover:no-underline',
                      isActive && 'bg-on-navy/10 text-on-navy shadow-[inset_2px_0_0_0_var(--color-teal)]',
                    )
                  }
                >
                  <Icon size={15} aria-hidden className="shrink-0 opacity-90" />
                  <span className="flex-1">{label}</span>
                  {to === '/review' && openReviewCount !== undefined && openReviewCount > 0 && (
                    <span
                      className="min-w-[22px] rounded-[4px] bg-on-navy/12 px-1.5 text-center font-mono text-[11px] font-semibold leading-[18px] text-on-navy"
                      title={`${openReviewCount} actionable review items`}
                    >
                      {openReviewCount}
                    </span>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Mark() {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-on-navy/10 text-on-navy">
        <ShieldCheck size={16} />
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-bold uppercase leading-tight tracking-[0.14em]">Backstop</div>
        <div className="text-[11px] leading-tight text-on-navy-faint">Prototype for EIP</div>
      </div>
    </div>
  );
}

/**
 * 232px navy rail with the app mark and lucide-iconed nav. From `lg` up it is
 * a fixed column; below `lg` it is hidden and opens as an overlay drawer from
 * the top bar's menu button (`mobileOpen`). The drawer closes on navigation,
 * Esc or a backdrop click.
 */
export function NavRail({
  openReviewCount,
  mobileOpen = false,
  onMobileClose,
}: {
  openReviewCount?: number;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onMobileClose);
  useEffect(() => {
    onCloseRef.current = onMobileClose;
  }, [onMobileClose]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
    };
  }, [mobileOpen]);

  return (
    <>
      <nav className="hidden h-full w-rail shrink-0 flex-col bg-navy text-on-navy lg:flex" aria-label="Primary">
        <div className="border-b border-on-navy/10 px-5 py-4">
          <Mark />
        </div>
        <RailBody openReviewCount={openReviewCount} />
      </nav>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="presentation">
          <div className="absolute inset-0 bg-slate/40" onClick={onMobileClose} aria-hidden data-testid="nav-backdrop" />
          <nav id={MOBILE_NAV_ID} className="relative flex h-full w-rail max-w-[85vw] flex-col bg-navy text-on-navy" aria-label="Primary">
            <div className="flex items-center justify-between gap-2 border-b border-on-navy/10 py-4 pl-5 pr-2">
              <div>
                <Mark />
              </div>
              <button
                ref={closeRef}
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-on-navy-muted hover:bg-on-navy/10 hover:text-on-navy"
                onClick={onMobileClose}
                aria-label="Close navigation"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <RailBody openReviewCount={openReviewCount} onNavigate={onMobileClose} />
          </nav>
        </div>
      )}
    </>
  );
}
