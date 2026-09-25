import { useId, useState, type FormEvent } from 'react';
import { ScanSearch } from 'lucide-react';
import { useRunScan } from '../../api/hooks';
import type { ScanOut } from '../../api/types';
import { useToast } from '../ui/useToast';
import { defaultScanKey, resolveScanKey, scanToast } from '../../lib/scan';

/**
 * "Run scan" (POST /scans). Used on the Artifacts list and on each artifact's
 * detail page; callers gate it to engineer/admin. With `withKeyInput` it also
 * shows an optional idempotency-key field — blank means one manual scan per
 * day (`YYYY-MM-DD-manual`), so a repeated click is deduplicated, not re-run.
 */
export function RunScanControl({ onScanned, withKeyInput = false }: { onScanned?: (scan: ScanOut) => void; withKeyInput?: boolean }) {
  const runScan = useRunScan();
  const { toast } = useToast();
  const [key, setKey] = useState('');
  const inputId = useId();

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    runScan.mutate(
      { idempotency_key: resolveScanKey(key), live: false },
      {
        onSuccess: (scan) => {
          onScanned?.(scan);
          toast(scanToast(scan));
        },
        onError: (err) => toast({ title: 'Scan refused', detail: err.message, tone: 'red' }),
      },
    );
  };

  const button = (
    <button type={withKeyInput ? 'submit' : 'button'} className="btn btn-outline" onClick={withKeyInput ? undefined : () => submit()} disabled={runScan.isPending}>
      <ScanSearch size={13} aria-hidden /> {runScan.isPending ? 'Scanning…' : 'Run scan'}
    </button>
  );

  if (!withKeyInput) return button;

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2" aria-label="Run scan">
      <label htmlFor={inputId} className="sr-only">
        Idempotency key (optional)
      </label>
      <input
        id={inputId}
        className="input h-8 w-[200px] font-mono text-[12px]"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={`key: ${defaultScanKey()}`}
        title="Idempotency key (optional). Reusing a key returns the earlier scan instead of scanning again; blank = one manual scan per day."
        autoComplete="off"
        spellCheck={false}
      />
      {button}
    </form>
  );
}
