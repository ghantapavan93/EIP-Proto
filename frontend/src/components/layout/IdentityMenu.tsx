import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Minus, Users } from 'lucide-react';
import type { MeOut, RoleInfo } from '../../api/types';
import { ROLES, actionLabel, roleTitle } from '../../lib/roles';
import { cn } from '../../lib/cn';
import { Drawer } from '../ui/Drawer';
import { Chip } from '../ui/Chip';
import { useIdentity } from '../access/usePermission';

function initials(name: string | null): string {
  if (!name || name === '—') return '?';
  return name.slice(0, 2).toUpperCase();
}

/** "You can / You can't", one line each, with the server's reason under a refusal. */
function PermissionList({ me }: { me: MeOut }) {
  const can = me.permissions.filter((p) => p.allowed);
  const refused = me.permissions.filter((p) => !p.allowed);
  // Most refusals share one reason ("only engineer or admin may do this"): say it once as a
  // heading; a refusal with its own condition (two-person rule, verified first) keeps it inline.
  const editorsOnly = refused.filter((p) => /only engineer or admin may do this\.?$/i.test(p.why) || /^engineers and admins can /i.test(p.why));
  const cannot = refused.filter((p) => !editorsOnly.includes(p));
  return (
    <div className="space-y-3">
      <div>
        <div className="eyebrow mb-1 text-[10px]">You can</div>
        <ul className="space-y-1" aria-label="You can">
          {can.map((p) => (
            <li key={p.action} className="flex gap-2 text-[12.5px] leading-snug text-ink">
              <Check size={14} className="mt-px shrink-0 text-green-ink" aria-hidden />
              <span>{p.label}</span>
            </li>
          ))}
        </ul>
      </div>
      {refused.length > 0 && (
        <div>
          <div className="eyebrow mb-1 text-[10px]">You can&apos;t</div>
          {editorsOnly.length > 0 && <div className="mb-1 text-[11.5px] text-ink-3">Engineers and admins can:</div>}
          <ul className="space-y-1" aria-label="You can't">
            {editorsOnly.map((p) => (
              <li key={p.action} className="flex gap-2 text-[12.5px] leading-snug" title={p.why}>
                <Minus size={14} className="mt-px shrink-0 text-ink-3" aria-hidden />
                <span className="text-ink-2">{p.label}</span>
              </li>
            ))}
            {cannot.map((p) => (
              <li key={p.action} className="flex gap-2 text-[12.5px] leading-snug">
                <Minus size={14} className="mt-px shrink-0 text-ink-3" aria-hidden />
                <span className="min-w-0">
                  <span className="text-ink-2">{p.label}</span>
                  {p.why && <span className="block text-[11.5px] text-ink-3">{p.why}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The role explainer: what each role can do, and why a decision needs a second person. */
export function RolesDrawer({ open, onClose, roles, current, me }: { open: boolean; onClose: () => void; roles?: RoleInfo[]; current?: string | null; me?: MeOut }) {
  const list = roles?.length ? roles : ROLES;
  // Each role lists only what it adds to the one before it (the roles are cumulative).
  const added = list.map((r, i) => {
    const prev = i > 0 ? new Set(list[i - 1].can) : null;
    return { prevLabel: i > 0 ? roleTitle(list[i - 1].role).toLowerCase() : null, items: prev ? r.can.filter((c) => !prev.has(c)) : r.can };
  });
  return (
    <Drawer open={open} onClose={onClose} title="How roles work" subtitle="Three roles, one audit trail. The server enforces every rule below; the screens only explain it." width={520}>
      <div className="space-y-3">
        {list.map((r, i) => (
          <section key={r.role} className={cn('card px-4 py-3', current === r.role && 'border-teal')} aria-label={r.label}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[14px] font-semibold text-ink">{r.label}</h3>
              {current === r.role && <Chip tone="teal">you</Chip>}
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{r.description}</p>
            {added[i].prevLabel && (
              <div className="mt-2 text-[11.5px] font-medium text-ink-3">
                {added[i].items.length ? `Everything an ${added[i].prevLabel} can, plus:` : `The same actions as an ${added[i].prevLabel}.`}
              </div>
            )}
            <ul className="mt-1.5 space-y-1">
              {added[i].items.map((c) => (
                <li key={c} className="flex gap-2 text-[12.5px] leading-snug text-ink">
                  <Check size={14} className="mt-px shrink-0 text-green-ink" aria-hidden />
                  {actionLabel(me, c)}
                </li>
              ))}
            </ul>
          </section>
        ))}
        <section className="rounded-[8px] border border-hairline bg-band px-4 py-3" aria-label="Separation of duties">
          <h3 className="text-[13px] font-semibold text-ink">Decisions need a different approver</h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-ink-2">
            <li>When a reviewer overrides a flagged call, Backstop pins that decision as a test case. It only takes effect after a different engineer or admin approves it. Nobody can approve their own.</li>
            <li>Approved exceptions expire after 365 days, so a one-off decision cannot quietly become policy.</li>
            <li>Every transition, refusal and export is written to the hash-chained audit log with the person&apos;s name and role.</li>
          </ul>
        </section>
      </div>
    </Drawer>
  );
}

/**
 * The single identity chip in the top bar. Opens a 300px popover: who you
 * are, what your role can and can't do (from GET /me), and a link to the
 * role explainer. Esc or an outside click closes it and focus returns to
 * the chip.
 */
export function IdentityMenu() {
  const { me } = useIdentity();
  const [open, setOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      window.clearTimeout(t);
    };
  }, [open]);

  const short = roleTitle(me.role);
  const label = me.role_label || short;
  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex h-8 items-center gap-2 rounded-[6px] px-1.5 text-[12px] text-ink-2 transition-colors hover:bg-band"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Signed in as ${me.name}, ${short}. What your role can do`}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden className="hidden h-7 w-7 items-center justify-center rounded-full bg-navy text-[11px] font-semibold text-on-navy sm:inline-flex">
          {initials(me.name)}
        </span>
        <span className="hidden font-medium text-ink sm:inline" data-testid="topbar-user">
          {me.name}
        </span>
        <Chip tone="slate" title={`${label} (role: ${me.role})`}>
          {short}
        </Chip>
        <ChevronDown size={12} aria-hidden className={cn('hidden text-ink-3 transition-transform motion-reduce:transition-none sm:block', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Your role and access"
          tabIndex={-1}
          className="pop-in absolute right-0 top-full z-40 mt-1.5 w-[300px] max-w-[calc(100vw-24px)] rounded-[8px] border border-hairline bg-surface p-4 text-left shadow-[0_8px_24px_-8px_rgba(16,24,40,0.25)] outline-none max-sm:fixed max-sm:inset-x-3 max-sm:top-14 max-sm:w-auto"
        >
          <div className="text-[12px] text-ink-2">
            Signed in as <span className="font-mono font-semibold text-ink">{me.name}</span> · <span className="font-semibold text-ink">{label}</span>
          </div>
          {me.role_description && <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{me.role_description}</p>}
          <div className="mt-3 border-t border-hairline pt-3">
            <PermissionList me={me} />
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-hairline pt-3">
            <span className="text-[11.5px] leading-snug text-ink-3">Every action is logged with your name and role.</span>
            <button
              type="button"
              className="btn btn-outline btn-sm shrink-0"
              onClick={() => {
                setOpen(false);
                setRolesOpen(true);
              }}
            >
              <Users size={12} aria-hidden /> How roles work
            </button>
          </div>
        </div>
      )}
      <RolesDrawer
        open={rolesOpen}
        onClose={() => {
          setRolesOpen(false);
          triggerRef.current?.focus();
        }}
        roles={me.roles}
        current={me.role}
        me={me}
      />
    </div>
  );
}
