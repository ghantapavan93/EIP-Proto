/**
 * Date/number formatting via Intl — no date library. All timestamps from the
 * API are ISO 8601; dates are YYYY-MM-DD.
 */

const dateFmt = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  timeZone: 'UTC',
});
const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const numberFmt = new Intl.NumberFormat('en-US');

/** Matches a trailing zone designator: "Z", "+05:30", "-0400", "+05". */
const TZ_SUFFIX = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * Parse an API timestamp. A datetime string with no zone designator is
 * treated as UTC (the backend stores UTC; some serialisers drop the "Z").
 * Date-only strings ("2026-10-01") are left to the caller.
 */
export function parseTs(value: string): Date {
  const trimmed = value.trim();
  const naive = trimmed.includes('T') || /^\d{4}-\d{2}-\d{2} \d/.test(trimmed);
  const normalised = naive && !TZ_SUFFIX.test(trimmed) ? `${trimmed.replace(' ', 'T')}Z` : trimmed;
  return new Date(normalised);
}

/** "2026-10-01" → "Oct 01, 2026". Returns "—" for null/invalid. */
export function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? value : dateFmt.format(d);
}

/** ISO datetime → "Sep 21, 2026, 13:41" in the viewer's zone. */
export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = parseTs(value);
  return Number.isNaN(d.getTime()) ? value : dateTimeFmt.format(d);
}

/** ISO datetime → compact mono-friendly "2026-09-21 13:41:30Z" (UTC). */
export function fmtTs(value: string | null | undefined): string {
  if (!value) return '—';
  const d = parseTs(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

export function fmtNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : numberFmt.format(value);
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${String(rem).padStart(2, '0')}s`;
}

export function durationBetween(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (!start || !end) return null;
  const a = parseTs(start).getTime();
  const b = parseTs(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return b - a;
}

/** First n chars of a hash with an ellipsis: "9c1f2a7e5d04…". */
export function shortHash(hash: string | null | undefined, n = 12): string {
  if (!hash) return '—';
  return hash.length > n ? `${hash.slice(0, n)}…` : hash;
}

/** Today's date in the viewer's local zone as YYYY-MM-DD (not UTC). */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** A zero-based page index from a query param; anything non-numeric, negative or fractional → 0. */
export function parsePageParam(value: string | null | undefined): number {
  if (!value || !/^\d+$/.test(value.trim())) return 0;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : 0;
}

export function hostname(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** "over_restrictive" → "Over restrictive"; "STALE_ASSET" → "Stale asset". */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  const s = value.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "just now", "2m ago", "3h ago", "4d ago" — for status lines; absolute time belongs in a title. */
export function fmtRelative(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return '—';
  const d = parseTs(value);
  if (Number.isNaN(d.getTime())) return value;
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  if (s < 0) return 'just now';
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Evidence bundle hash for toasts: the first 12 hex chars of X-Bundle-SHA256. */
export function bundleHashLabel(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : 'no hash header';
}
