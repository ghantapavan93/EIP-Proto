import { Fragment, useMemo, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { segmentText, type HighlightSpan } from '../../lib/spans';

export type { HighlightSpan } from '../../lib/spans';

export interface HighlightedTextProps {
  text: string;
  spans: HighlightSpan[];
  className?: string;
  /** show a "not found in transcript" tag after unverified spans */
  tagUnverified?: boolean;
  onSpanClick?: (span: HighlightSpan) => void;
}

/**
 * Renders `text` with every span highlighted: verified spans teal, unverified
 * red. Overlapping spans are supported — a segment covered by any unverified
 * span renders red, and its tooltip lists every covering label.
 */
export function HighlightedText({ text, spans, className, tagUnverified = true, onSpanClick }: HighlightedTextProps) {
  const segments = useMemo(() => segmentText(text, spans), [text, spans]);

  const nodes: ReactNode[] = segments.map((seg) => {
    const content = text.slice(seg.start, seg.end);
    if (!seg.covering.length) return <Fragment key={seg.start}>{content}</Fragment>;
    const unverified = seg.covering.some((s) => !s.verified);
    const labels = seg.covering.map((s) => s.title ?? s.label).join(' · ');
    const last = seg.covering[seg.covering.length - 1];
    const isSpanEnd = seg.covering.some((s) => s.offset + s.length === seg.end && !s.verified);
    return (
      <Fragment key={seg.start}>
        <mark
          data-testid="hl-span"
          data-labels={seg.covering.map((s) => s.label).join(',')}
          data-verified={unverified ? 'false' : 'true'}
          title={labels}
          className={cn('bg-transparent text-ink', unverified ? 'mark-span-unverified' : 'mark-span', onSpanClick && 'cursor-pointer')}
          onClick={onSpanClick ? () => onSpanClick(last) : undefined}
        >
          {content}
        </mark>
        {tagUnverified && isSpanEnd && (
          <span className="ml-1 inline-flex h-4 items-center rounded-[2px] border border-red px-1 align-middle text-[10px] font-semibold uppercase tracking-[0.5px] text-red">
            not found in transcript
          </span>
        )}
      </Fragment>
    );
  });

  return <span className={cn('whitespace-pre-wrap', className)}>{nodes}</span>;
}
