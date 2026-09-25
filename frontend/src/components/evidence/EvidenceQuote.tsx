import { cn } from '../../lib/cn';
import { surroundingSentence } from '../../lib/spans';

export interface EvidenceQuoteProps {
  /** the exact evidence span */
  span: string;
  /** the full artifact / transcript text, used to find the surrounding sentence */
  context?: string | null;
  /** offset of the span in `context`; falls back to indexOf */
  offset?: number;
  className?: string;
  unverified?: boolean;
}

/** The evidence span highlighted inside its surrounding sentence. */
export function EvidenceQuote({ span, context, offset, className, unverified = false }: EvidenceQuoteProps) {
  let before = '';
  let after = '';
  if (context) {
    const start = offset !== undefined && offset >= 0 && context.slice(offset, offset + span.length) === span
      ? offset
      : context.indexOf(span);
    if (start >= 0) {
      const s = surroundingSentence(context, start, start + span.length);
      before = s.before;
      after = s.after;
    }
  }
  return (
    <blockquote className={cn('quote', className)}>
      {before && <span className="text-ink-2">{before}</span>}
      <mark className={cn('bg-transparent text-ink', unverified ? 'mark-span-unverified' : 'mark-span')}>{span}</mark>
      {after && <span className="text-ink-2">{after}</span>}
    </blockquote>
  );
}
