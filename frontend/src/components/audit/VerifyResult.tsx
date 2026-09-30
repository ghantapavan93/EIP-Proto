import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { AuditVerifyOut } from '../../api/types';
import { cn } from '../../lib/cn';
import { fmtNumber, shortHash } from '../../lib/format';

/**
 * The answer of GET /audit/verify, for a full-chain check (Audit) and for a
 * checkpoint receipt (Governance). A broken link names the first bad row; a
 * checkpoint that no longer matches says so with the server's reason.
 */
export function VerifyResult({ result, className }: { result: AuditVerifyOut; className?: string }) {
  if (result.ok) {
    return (
      <div
        role="status"
        className={cn(
          'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[8px] border border-green/40 bg-green/10 px-3.5 py-2 text-[13px] text-ink',
          className,
        )}
      >
        <ShieldCheck size={15} className="shrink-0 text-green-ink" aria-hidden />
        <span className="font-semibold text-green-ink">Chain verified</span>
        <span className="text-ink-2">
          · every row&apos;s hash recomputed from the row before it ·{' '}
          <span className="font-mono text-ink">{fmtNumber(result.checked)}</span> rows · tip{' '}
          <span className="font-mono text-ink" title={result.tip}>
            {shortHash(result.tip, 12)}
          </span>
          {result.checkpoint && <> · still contains this checkpoint</>}
        </span>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[8px] border border-red/30 bg-red/6 px-3.5 py-2 text-[13px] text-ink',
        className,
      )}
    >
      <ShieldAlert size={15} className="shrink-0 text-red" aria-hidden />
      {result.first_broken_id !== null ? (
        <>
          <span className="font-semibold text-red">Chain broken at row #{result.first_broken_id}</span>
          <span>
            · {result.reason} · <span className="font-mono">{fmtNumber(result.checked)}</span> rows verified before it
          </span>
        </>
      ) : (
        <>
          <span className="font-semibold text-red">Not verified</span>
          <span>· {result.reason ?? 'the chain does not match'}</span>
        </>
      )}
    </div>
  );
}
