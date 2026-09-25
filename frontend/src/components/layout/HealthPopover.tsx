import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useHealthDeep } from '../../api/hooks';
import type { HealthComponent } from '../../api/types';
import { LoadingState } from '../ui/LoadingState';
import { ErrorState } from '../ui/ErrorState';
import { fmtTs, shortHash } from '../../lib/format';
import { cn } from '../../lib/cn';
import { componentLabel, componentTone, stateWord, statusTextClass } from '../../lib/health';

const DOT: Record<string, string> = { green: 'bg-green', neutral: 'bg-input', red: 'bg-red', amber: 'bg-amber' };

export function ComponentList({ components }: { components: HealthComponent[] }) {
  return (
    <ul className="divide-y divide-hairline border-y border-hairline" aria-label="Components">
      {components.map((c) => {
        const tone = componentTone(c);
        return (
          <li key={c.name} className="grid grid-cols-[92px_64px_minmax(0,1fr)] items-baseline gap-2 py-1.5">
            <span className="flex items-center gap-1.5 font-medium text-slate">
              <span aria-hidden className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', DOT[tone])} />
              {componentLabel(c)}
            </span>
            <span className={cn('text-[11px] font-semibold uppercase tracking-[0.5px]', tone === 'green' ? 'text-green-ink' : tone === 'red' ? 'text-red' : tone === 'amber' ? 'text-amber-ink' : 'text-ink-3')}>
              {stateWord(c)}
            </span>
            <span className="min-w-0 truncate text-ink-2" title={c.detail}>
              {c.detail}
              {!c.required && <span className="ml-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-ink-3">· optional</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The status word on the rail → popover with GET /health/deep (no auth):
 * one line per component, optional providers marked. Esc / outside click closes.
 */
export function HealthPopover({ status, fallback }: { status?: string | null; fallback?: HealthComponent[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const health = useHealthDeep(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const h = health.data;
  const shown = h?.status ?? status ?? null;
  const components = h?.components ?? fallback ?? [];
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-[6px] border px-2 text-[11px] font-semibold uppercase tracking-[0.06em]',
          // the single teal wash in the product: around the live system state
          shown === 'healthy' ? 'border-teal/30 bg-teal/8 hover:bg-teal/14' : 'border-hairline bg-surface hover:bg-band',
          statusTextClass(shown),
        )}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Component health — GET /api/health/deep"
      >
        {/* the one live pulse in the chrome: only while the system is actually healthy */}
        <span
          aria-hidden
          data-testid="health-dot"
          className={cn(
            shown === 'healthy' ? 'pulse-dot pulse-health bg-green-ink' : 'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
            shown === 'degraded' ? 'bg-amber' : shown === 'down' ? 'bg-red' : shown === 'healthy' ? null : 'bg-input',
          )}
        />
        {shown ?? 'checking'}
        <ChevronDown size={12} aria-hidden className="hidden sm:block" />
      </button>
      {open && (
        <div role="dialog" aria-label="System health" className="pop-in absolute right-0 top-full z-40 mt-1.5 w-[360px] max-w-[calc(100vw-24px)] max-sm:fixed max-sm:inset-x-3 max-sm:top-14 max-sm:w-auto rounded-[8px] border border-hairline bg-surface p-3 text-[12px] normal-case tracking-normal shadow-[0_8px_24px_rgba(16,24,40,0.12)]">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Components</span>
            <span className={cn('text-[11px] font-semibold uppercase tracking-[1px]', statusTextClass(shown))}>{shown ?? '—'}</span>
          </div>
          {health.isLoading && !components.length && <LoadingState rows={3} className="px-0 py-1" />}
          {health.error && !h ? <ErrorState error={health.error} title="Health check failed" /> : null}
          {components.length > 0 && <ComponentList components={components} />}
          {h && (
            <div className="mt-2 space-y-0.5 font-mono text-[11px] text-ink-2">
              <div>
                last scan {h.last_scan ? `${shortHash(h.last_scan.id, 8)} · ${h.last_scan.status} · ${fmtTs(h.last_scan.finished_at)}` : 'none'}
              </div>
              <div>
                backstop {h.version} · checked {fmtTs(h.time)}
              </div>
            </div>
          )}
          <p className="mt-2 text-[11px] leading-snug text-ink-3">Optional components never make the system unhealthy: without Ollama, recorded cassettes still replay.</p>
        </div>
      )}
    </div>
  );
}
