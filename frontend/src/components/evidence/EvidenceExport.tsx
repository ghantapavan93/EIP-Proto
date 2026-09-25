import { useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, Copy, Download, FileArchive, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useExportEvidence, useStatus, type EvidenceRequest, type EvidenceResult } from '../../api/hooks';
import type { EvidenceFormat } from '../../api/types';
import { useToast } from '../ui/useToast';
import { Drawer } from '../ui/Drawer';
import { cn } from '../../lib/cn';
import { bundleHashLabel, fmtNumber } from '../../lib/format';

/** One line of the bundle preview, built from data the page already has. */
export interface EvidencePreviewRow {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

const SCOPE_NOUN: Record<EvidenceRequest['scope'], string> = { tasks: 'Review task', runs: 'Run', rules: 'Rule' };

/** What the server puts in every bundle of this scope (backend core/evidence.py). */
const CONTENTS: Record<EvidenceRequest['scope'], string[]> = {
  rules: [
    'Rule version in force on the date, its clause text and ranked sources',
    'Blast radius: every stale encoding with the artifact version hash and the exact quoted span',
    'Review tasks on those encodings and the human decisions taken',
  ],
  runs: [
    'Prompt, model, adapter, corpus and contract-set identifiers (the run key)',
    'Every contract result with its evidence, per call',
    'Gate, judge canary and cost',
  ],
  tasks: [
    'Rule version and ranked sources, or the run result and contract',
    'Artifact version hash and the exact matched span',
    'The human decision, reason code and who made it',
  ],
};

/** One sentence a reviewer can repeat: what the bundle of this scope lets them show. */
const PROVES: Record<EvidenceRequest['scope'], string> = {
  rules: 'Which artifacts still encode a superseded version of this rule on the date, the exact text each one quotes, and what reviewers decided.',
  runs: 'Exactly which prompt, model and call set were tested, what every contract concluded on every call, and the gate that followed.',
  tasks: 'What was flagged, the exact span it rests on, and who decided it, with the reason code.',
};

/** Copy a full hash; the label flips to "Copied" for a moment (no live region, so the drawer keeps one status). */
function CopyHash({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[4px] border border-input bg-surface px-1.5 font-sans text-[11px] font-semibold text-teal-ink transition-colors hover:border-teal hover:bg-teal/5"
      title={`Copy full sha256 ${value}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * "Export evidence ↗" — opens a drawer that previews what the bundle holds
 * (from data already on the page), then downloads it as Markdown or JSON
 * (GET /api/evidence/...). The server hashes the bundle and audit-logs the
 * export; the toast and the drawer show the first 12 chars of X-Bundle-SHA256
 * so the file can be matched to its audit row later.
 */
export function EvidenceExport({
  scope,
  id,
  asOf,
  className,
  size = 'md',
  preview = [],
}: {
  scope: EvidenceRequest['scope'];
  id: string;
  asOf?: string;
  className?: string;
  size?: 'sm' | 'md';
  /** rows describing this bundle's subject, shown before download */
  preview?: EvidencePreviewRow[];
}) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<(EvidenceResult & { format: EvidenceFormat }) | null>(null);
  const exportEvidence = useExportEvidence();
  // /status is polled by the shell; the export invalidates it, so the chain line refreshes after a download.
  const status = useStatus({ enabled: open });
  const { toast } = useToast();

  const go = (format: EvidenceFormat) =>
    exportEvidence.mutate(
      { scope, id, format, asOf },
      {
        onSuccess: (result) => {
          setLast({ ...result, format });
          toast({
            title: `Evidence bundle exported · sha256 ${bundleHashLabel(result.sha256)}`,
            detail: `${result.filename} — logged to the audit chain as evidence.exported`,
            tone: 'green',
          });
        },
        onError: (err) => toast({ title: 'Evidence export failed', detail: err.message, tone: 'red' }),
      },
    );

  const chain = status.data?.audit_chain;

  return (
    <>
      <button
        type="button"
        className={cn('btn btn-outline', size === 'sm' && 'btn-sm', className)}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title="Preview and download the evidence bundle"
      >
        <FileArchive size={size === 'sm' ? 12 : 14} aria-hidden />
        Export evidence
        <ArrowUpRight size={size === 'sm' ? 12 : 14} aria-hidden />
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Evidence bundle"
        subtitle={
          <span className="font-mono">
            {SCOPE_NOUN[scope].toLowerCase()} {id}
            {scope === 'rules' && asOf ? ` · as of ${asOf}` : ''}
          </span>
        }
        width={480}
        footer={
          <div role="group" aria-label="Export evidence" className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className="btn btn-outline" disabled={exportEvidence.isPending} onClick={() => go('md')} title="Download the evidence bundle as Markdown">
              <Download size={14} aria-hidden /> Download Markdown
            </button>
            <button type="button" className="btn" disabled={exportEvidence.isPending} onClick={() => go('json')} title="Download the evidence bundle as JSON">
              <Download size={14} aria-hidden /> Download JSON
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <section className="border-l-2 border-teal pl-3">
            <div className="eyebrow mb-1">What this proves</div>
            <p className="text-[13px] leading-relaxed text-ink">{PROVES[scope]}</p>
          </section>

          <section>
            <div className="eyebrow mb-2">Receipt</div>
            <div className="rounded-[8px] border border-hairline bg-band font-mono text-[12px]">
              {preview.length > 0 && (
                <dl className="divide-y divide-dashed divide-input px-3">
                  {preview.map((row) => (
                    <div key={row.label} className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 py-2">
                      <dt className="text-ink-2">{row.label}</dt>
                      <dd className={cn('min-w-0 text-ink [overflow-wrap:anywhere]', !row.mono && 'font-sans text-[13px]')}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className={cn('space-y-2 px-3 py-2.5', preview.length > 0 && 'border-t border-input')}>
                {chain ? (
                  <div className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-3">
                    <span className="text-ink-2">Audit chain</span>
                    <span className={cn('inline-flex flex-wrap items-center gap-1.5 font-sans text-[13px]', chain.verified ? 'text-green-ink' : 'text-red')}>
                      {chain.verified ? <ShieldCheck size={14} aria-hidden /> : <ShieldAlert size={14} aria-hidden />}
                      <span className="font-semibold uppercase tracking-[0.04em]">{chain.verified ? '✓ verified' : 'broken'}</span>
                      <span className="text-ink-2">
                        · <span className="font-mono">{fmtNumber(chain.rows)}</span> rows
                      </span>
                    </span>
                  </div>
                ) : (
                  <div className="font-sans text-[13px] text-ink-3">{status.isLoading ? 'Checking the audit chain…' : 'Audit chain status unavailable'}</div>
                )}
                {last ? (
                  <div className="text-ink-2" role="status">
                    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-3">
                      <span>Last export</span>
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-ink">{last.format.toUpperCase()}</span>
                        <span>
                          bundle sha256{' '}
                          <span className="font-semibold text-ink" title={last.sha256 ?? undefined}>
                            {bundleHashLabel(last.sha256)}
                          </span>
                        </span>
                        {last.sha256 && <CopyHash value={last.sha256} />}
                      </span>
                    </div>
                    <div className="mt-1 truncate pl-[116px] text-[11px] text-ink-3" title={last.filename}>
                      {last.filename}
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3">
                    <span className="text-ink-2">Bundle sha256</span>
                    <span className="font-sans text-[13px] text-ink-2">Computed by the server on download and written to the audit chain as evidence.exported.</span>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section>
            <div className="eyebrow mb-2">The bundle contains</div>
            <ul className="space-y-1.5 text-[13px] text-ink">
              {[...CONTENTS[scope], 'Every related audit row with its chain hash, the chain verification result, and the bundle’s own SHA-256'].map((line) => (
                <li key={line} className="flex gap-2">
                  <Check size={14} className="mt-[3px] shrink-0 text-teal-ink" aria-hidden />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </Drawer>
    </>
  );
}
