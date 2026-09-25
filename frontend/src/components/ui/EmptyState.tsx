import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '../../lib/cn';

export function EmptyState({
  title = 'Nothing here',
  hint,
  className,
  action,
}: {
  title?: string;
  hint?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-1 px-3 py-8 text-center', className)}>
      <Inbox size={18} className="text-ink-3" aria-hidden />
      <div className="text-[13px] font-semibold text-slate">{title}</div>
      {hint && <div className="max-w-md text-xs text-ink-2">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
