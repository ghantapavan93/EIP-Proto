/** Span helpers shared by HighlightedText and EvidenceQuote. */

export interface HighlightSpan {
  offset: number;
  length: number;
  label: string;
  verified: boolean;
  /** optional extra tooltip text (e.g. rule + version + polarity) */
  title?: string;
}

export interface Segment {
  start: number;
  end: number;
  covering: HighlightSpan[];
}

/**
 * Split [0, text.length) at every span boundary so overlapping spans become
 * disjoint segments, each carrying the spans that cover it.
 */
export function segmentText(text: string, spans: HighlightSpan[]): Segment[] {
  const valid = spans.filter(
    (s) => s.offset >= 0 && s.length > 0 && s.offset < text.length,
  );
  const cuts = new Set<number>([0, text.length]);
  for (const s of valid) {
    cuts.add(Math.max(0, s.offset));
    cuts.add(Math.min(text.length, s.offset + s.length));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const covering = valid.filter((s) => s.offset <= start && s.offset + s.length >= end);
    segments.push({ start, end, covering });
  }
  return segments;
}


/** Find the sentence boundaries around [start, end) in text. */
export function surroundingSentence(text: string, start: number, end: number): { before: string; after: string } {
  const boundary = /[.!?]\s|\n/g;
  let sentStart = 0;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text)) !== null) {
    const idx = m.index + m[0].length;
    if (idx <= start) sentStart = idx;
    else break;
  }
  boundary.lastIndex = end;
  const next = boundary.exec(text);
  const sentEnd = next ? next.index + 1 : text.length;
  return { before: text.slice(sentStart, start), after: text.slice(end, sentEnd) };
}
