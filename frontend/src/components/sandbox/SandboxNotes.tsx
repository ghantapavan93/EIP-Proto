import { AlertTriangle, Lock } from 'lucide-react';
import { errorStatus } from '../../api/errors';
import { cn } from '../../lib/cn';
import { REDACTION_KINDS, refusalCopy } from '../../lib/sandbox';
import type { RedactionCounts } from '../../api/types';

/** The privacy promise, placed next to the input. Literally true of the backend: redacted, not stored, only a hash is audited. */
export function PrivacyLine({ className, detail }: { className?: string; detail?: string }) {
  return (
    <p className={cn('flex items-start gap-1.5 text-[12px] leading-snug text-ink-2', className)}>
      <Lock size={12} className="mt-[3px] shrink-0 text-ink-3" aria-hidden />
      <span>
        Redacted before matching · nothing stored · only a SHA-256 of the text is logged
        {detail && <span className="text-ink-3"> · {detail}</span>}
      </span>
    </p>
  );
}

/**
 * What was redacted before anything was matched or sent to a model: every
 * identifier kind the server reports, zeros included, so the reader sees what
 * is covered and not only what was found. Kinds an older server does not
 * report are left out rather than shown as zero.
 */
export function RedactionTally({ counts, className }: { counts: RedactionCounts | undefined; className?: string }) {
  const kinds = REDACTION_KINDS.filter(([key]) => typeof counts?.[key] === 'number');
  if (!counts || !kinds.length) return null;
  const total = kinds.reduce((n, [key]) => n + (counts[key] ?? 0), 0);
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]', className)} aria-label="Redacted before matching">
      <span className="text-ink-2">{total ? 'Redacted before matching:' : 'Nothing needed redacting:'}</span>
      {kinds.map(([key, one, many]) => {
        const n = counts[key] ?? 0;
        return (
          <span key={key} className={cn('whitespace-nowrap', n ? 'font-semibold text-ink' : 'text-ink-3')} data-testid={`redacted-${key}`}>
            <span className="font-mono">{n}</span> {n === 1 ? one : many}
          </span>
        );
      })}
    </div>
  );
}

/** A refused check in plain words (too long, rate-limited, invalid, timed out), with the HTTP code for the technical reader. */
export function RefusalNote({ error, limit, retry, className }: { error: unknown; limit: number; retry?: () => void; className?: string }) {
  const copy = refusalCopy(error, limit);
  const status = errorStatus(error);
  return (
    <div role="alert" className={cn('flex items-start gap-2.5 rounded-[8px] border border-amber/40 bg-amber/8 px-3.5 py-2.5 text-[13px]', className)}>
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-ink" aria-hidden />
      <div className="min-w-0">
        <div className="font-semibold text-ink">
          {copy.title}
          {status !== null && status > 0 && <span className="ml-2 font-mono text-[11.5px] font-medium text-ink-2">HTTP {status}</span>}
        </div>
        <div className="mt-0.5 break-words text-ink-2">{copy.detail}</div>
        {retry && (
          <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
