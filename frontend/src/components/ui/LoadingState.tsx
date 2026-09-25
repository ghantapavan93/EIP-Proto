import { cn } from '../../lib/cn';

export function LoadingState({ label = 'Loading', className, rows = 3 }: { label?: string; className?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className={cn('px-3 py-4', className)}>
      <span className="sr-only">{label}…</span>
      <div className="space-y-2" aria-hidden>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="sk-shimmer h-3 rounded-[3px]" style={{ width: `${88 - i * 14}%` }} />
        ))}
      </div>
    </div>
  );
}
