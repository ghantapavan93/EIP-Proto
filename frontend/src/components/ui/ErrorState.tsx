import { AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/cn';
import { errorMessage, errorStatus } from '../../api/errors';

export function ErrorState({
  error,
  title,
  className,
  retry,
}: {
  error: unknown;
  title?: string;
  className?: string;
  retry?: () => void;
}) {
  const status = errorStatus(error);
  return (
    <div
      role="alert"
      className={cn('flex items-start gap-2 border border-red px-3 py-2 text-[13px] text-ink', className)}
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red" aria-hidden />
      <div className="min-w-0">
        <div className="font-semibold text-red">
          {title ?? 'Request failed'}
          {status !== null && status > 0 && <span className="ml-2 font-mono text-[12px] font-medium">HTTP {status}</span>}
        </div>
        <div className="break-words text-ink-2">{errorMessage(error)}</div>
        {retry && (
          <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={retry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
