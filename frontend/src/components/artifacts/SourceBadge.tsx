import { ExternalLink } from 'lucide-react';
import { Chip } from '../ui/Chip';
import { hostname } from '../../lib/format';

export interface SourceBadgeProps {
  isSynthetic: boolean;
  /** artifact type; web_page → REAL PAGE, workflow_prompt → REPO PROMPT */
  type?: string | null;
  url?: string | null;
  className?: string;
  /** Put the hostname on its own line under the chip (narrow table columns). */
  stacked?: boolean;
}

/**
 * Provenance, never ambiguous: REAL PAGE (with hostname + external link) for
 * real web pages, REPO PROMPT for workflow prompts (real code in this repo,
 * neither a page nor synthetic), SYNTHETIC for labeled internals.
 */
export function SourceBadge({ isSynthetic, type, url, className, stacked = false }: SourceBadgeProps) {
  if (isSynthetic) {
    return (
      <Chip tone="neutral" className={className} title="Labeled synthetic artifact">
        Synthetic
      </Chip>
    );
  }
  if (type === 'workflow_prompt') {
    return (
      <Chip tone="slate" className={className} title="Real prompt text, versioned in this repository">
        Repo prompt
      </Chip>
    );
  }
  if (type && type !== 'web_page') {
    return (
      <Chip tone="teal" className={className} title="Real artifact">
        Real
      </Chip>
    );
  }
  const host = hostname(url);
  const chip = (
    <Chip tone="teal" className={className} title={url ?? 'Real public page'}>
      Real page
      {host && !stacked && <span className="font-medium normal-case tracking-normal">· {host}</span>}
      {url && <ExternalLink size={11} aria-hidden />}
    </Chip>
  );
  if (!url) return chip;
  if (stacked) {
    return (
      <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex flex-col items-start gap-0.5 py-1 no-underline hover:no-underline" onClick={(e) => e.stopPropagation()} aria-label={`Open ${host} in a new tab`}>
        {chip}
        {host && <span className="text-[11px] leading-tight text-ink-2 [overflow-wrap:anywhere]">{host}</span>}
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex no-underline hover:no-underline" onClick={(e) => e.stopPropagation()} aria-label={`Open ${host} in a new tab`}>
      {chip}
    </a>
  );
}

/** SYNTHETIC or INGESTED · REDACTED for transcripts (synthetic=false ⇒ ingested from a real export). */
export function TranscriptBadge({ synthetic, labels, className }: { synthetic: boolean; labels?: Record<string, unknown> | null; className?: string }) {
  if (synthetic) {
    return (
      <Chip tone="neutral" className={className} title="Synthetic transcript with ground-truth labels">
        Synthetic
      </Chip>
    );
  }
  const redacted = labels && typeof labels.redacted === 'object' && labels.redacted !== null ? (labels.redacted as Record<string, unknown>) : null;
  const counts = redacted
    ? Object.entries(redacted)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `${k.replace(/_/g, ' ')} ×${String(v)}`)
        .join(', ')
    : '';
  return (
    <Chip tone="teal" className={className} title={`Ingested${typeof labels?.format === 'string' ? ` via ${labels.format}` : ''}; PII redacted at ingest${counts ? `: ${counts}` : ''}; no ground truth`}>
      Ingested · redacted
    </Chip>
  );
}
