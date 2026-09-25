import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

/**
 * Right-side drawer. Esc closes, backdrop click closes, the panel takes
 * focus on open so keyboard users land inside it. No focus trap (by design).
 */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 560 }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Callers usually pass an inline onClose; hold it in a ref so a parent
  // re-render neither re-binds the Esc listener nor steals focus back into
  // the panel from whatever the user is typing in.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Focus the panel once per open, not on every render.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A drawer opened from inside another (evidence export in a review task)
      // sits later in the document; Esc closes only the topmost one.
      const panels = document.querySelectorAll('[data-drawer-panel]');
      if (panels.length && panels[panels.length - 1] !== panelRef.current) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="presentation">
      <div className="fade-in absolute inset-0 bg-slate/40" onClick={onClose} aria-hidden data-testid="drawer-backdrop" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Drawer'}
        tabIndex={-1}
        data-drawer-panel=""
        className={cn('drawer-in relative flex h-full max-w-full flex-col border-l border-hairline bg-surface shadow-[-8px_0_24px_rgba(16,24,40,0.08)] outline-none')}
        style={{ width }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-semibold text-ink">{title}</h2>
            {subtitle && <div className="mt-1 text-xs text-ink-2">{subtitle}</div>}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            <X size={14} aria-hidden />
            Esc
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-hairline bg-canvas px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
