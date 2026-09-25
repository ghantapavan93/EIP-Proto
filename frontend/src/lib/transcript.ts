import type { SpanOut } from '../api/types';
import type { HighlightSpan } from './spans';

export interface Line {
  prefix: string;
  speaker: string;
  body: string;
  spans: HighlightSpan[];
}

const MARKER = /\[(\d{1,2}:)?\d{1,2}:\d{2}\]\s*([A-Z_]+):\s?/g;

/**
 * Split the transcript at every "[mm:ss] SPEAKER:" / "[hh:mm:ss] SPEAKER:" marker —
 * newline-separated (synthetic corpus) or inline (ingested exports) — and clip
 * the cited spans to each line so offsets stay exact.
 */
export function splitTranscript(text: string, spans: SpanOut[]): Line[] {
  const markers: Array<{ start: number; end: number; speaker: string }> = [];
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(text)) !== null) markers.push({ start: m.index, end: m.index + m[0].length, speaker: m[2] });
  if (!markers.length) {
    return text.split('\n').map((line) => ({ prefix: '', speaker: '', body: line, spans: [] })).map((l, i, arr) => {
      const bodyStart = arr.slice(0, i).reduce((acc, x) => acc + x.body.length + 1, 0);
      return { ...l, spans: clip(spans, bodyStart, bodyStart + l.body.length) };
    });
  }
  const lines: Line[] = [];
  if (markers[0].start > 0) {
    const lead = text.slice(0, markers[0].start).trim();
    if (lead) lines.push({ prefix: '', speaker: '', body: lead, spans: clip(spans, 0, markers[0].start) });
  }
  markers.forEach((mk, i) => {
    const bodyStart = mk.end;
    const bodyEnd = i + 1 < markers.length ? markers[i + 1].start : text.length;
    const body = text.slice(bodyStart, bodyEnd).replace(/\s+$/, '');
    lines.push({ prefix: text.slice(mk.start, mk.end).trim(), speaker: mk.speaker, body, spans: clip(spans, bodyStart, bodyStart + body.length) });
  });
  return lines;
}

function clip(spans: SpanOut[], bodyStart: number, bodyEnd: number): HighlightSpan[] {
  const out: HighlightSpan[] = [];
  for (const s of spans) {
    if (s.offset < 0) continue;
    const sStart = Math.max(s.offset, bodyStart);
    const sEnd = Math.min(s.offset + s.length, bodyEnd);
    if (sEnd > sStart) out.push({ offset: sStart - bodyStart, length: sEnd - sStart, label: s.label, verified: s.verified, title: `${s.label} · ${s.verified ? 'verified' : 'NOT FOUND'}` });
  }
  return out;
}
