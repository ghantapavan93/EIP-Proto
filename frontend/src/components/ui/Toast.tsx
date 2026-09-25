import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { Tone } from '../../lib/vocab';
import { ToastContext, type ToastInput } from './toastContext';

interface ToastItem extends ToastInput {
  id: number;
}

const TONE_BORDER: Record<Tone, string> = {
  neutral: 'border-l-slate',
  teal: 'border-l-teal',
  green: 'border-l-green',
  amber: 'border-l-amber',
  red: 'border-l-red',
  slate: 'border-l-slate',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev, { ...input, id }]);
      const duration = input.duration ?? 6000;
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto flex items-start gap-2 border border-hairline border-l-[3px] bg-surface px-3 py-2 text-[13px]',
              TONE_BORDER[t.tone ?? 'neutral'],
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-slate">{t.title}</div>
              {t.detail && <div className="mt-0.5 text-xs text-ink-2">{t.detail}</div>}
            </div>
            <button type="button" className="text-ink-3 hover:text-slate" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X size={14} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
