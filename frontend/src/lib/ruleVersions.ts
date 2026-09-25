import type { RuleDeferral, RuleOut, RuleSourceRef, RuleVersionOut } from '../api/types';
import { fmtDate } from './format';
import type { Tone } from './vocab';

/**
 * Statuses that never govern on their own: a proposal is not law, a vacated
 * version was set aside by a court, a stayed one is paused. None of them can
 * be "in force", and none is the "next change" a team prepares for.
 */
export const NOT_GOVERNING = new Set(['proposed', 'vacated', 'stayed']);

/** True when the version can be in force on some date: enacted, not vacated or stayed, with a start date. */
export function governs<T extends Pick<RuleVersionOut, 'status' | 'effective_from'>>(v: T): v is T & { effective_from: string } {
  return !NOT_GOVERNING.has(v.status) && typeof v.effective_from === 'string' && v.effective_from.length > 0;
}

/** Governing versions, oldest first. */
export function governingVersions(rule: Pick<RuleOut, 'versions'>): Array<RuleVersionOut & { effective_from: string }> {
  return rule.versions.filter((v) => governs(v)).sort((a, b) => a.version - b.version);
}

/** The newest version that governs (or will): what the Rules list calls the next change. */
export function latestGoverning(rule: Pick<RuleOut, 'versions'>): (RuleVersionOut & { effective_from: string }) | undefined {
  const all = governingVersions(rule);
  return all[all.length - 1];
}

export type VersionStatusAsOf = 'in_force_as_of' | 'superseded' | 'future' | 'vacated' | 'stayed' | 'proposed' | 'raw';

/**
 * Status as of the evaluation date: the version whose window contains as_of
 * gets the green badge; a version whose window ended before as_of reads
 * SUPERSEDED instead of its raw status; a future version reads "takes effect".
 * Vacated, stayed and proposed versions keep their own status whatever the
 * date — none of them is ever in force.
 */
export function versionStatusAsOf(v: RuleVersionOut, asOf: string | undefined, inForceVersion: number | null): VersionStatusAsOf {
  if (v.status === 'vacated' || v.status === 'stayed' || v.status === 'proposed') return v.status;
  if (v.version === inForceVersion) return 'in_force_as_of';
  if (asOf && v.effective_to !== null && v.effective_to < asOf) return 'superseded';
  if (asOf && v.effective_from && v.effective_from > asOf) return 'future';
  return 'raw';
}

export interface StatusPresentation {
  label: string;
  tone: Tone;
  /** one plain sentence under the chip; empty when the chip says it all */
  note: string;
  /** vacated: the version label is struck through */
  strike: boolean;
  /** proposed: drawn with a dashed outline (not law) */
  dashed: boolean;
}

/** How a version's status reads everywhere: vacated slate + struck, stayed amber, proposed dashed. */
export function statusPresentation(v: Pick<RuleVersionOut, 'status' | 'vote_date' | 'effective_from'>): StatusPresentation {
  switch (v.status) {
    case 'vacated':
      return { label: 'vacated', tone: 'slate', note: 'Court vacated — Backstop will not enforce this version.', strike: true, dashed: false };
    case 'stayed':
      return { label: 'stayed', tone: 'amber', note: 'Stayed — enforcement is paused; Backstop does not enforce it while the stay holds.', strike: false, dashed: false };
    case 'proposed':
      return {
        label: 'proposed',
        tone: 'teal',
        note: v.vote_date ? `Not law yet — vote on ${fmtDate(v.vote_date)}.` : 'Not law — a what-if until it is enacted.',
        strike: false,
        dashed: true,
      };
    case 'in_force':
      return { label: 'in force', tone: 'green', note: '', strike: false, dashed: false };
    case 'eliminated':
      return { label: 'eliminated', tone: 'red', note: '', strike: false, dashed: false };
    case 'amended':
      return { label: 'amended', tone: 'amber', note: '', strike: false, dashed: false };
    default:
      return { label: v.status.replace(/_/g, ' '), tone: 'neutral', note: '', strike: false, dashed: false };
  }
}

/** "Oct 01, 2026", or for a proposal with no date yet "awaiting vote Sep 30, 2026". */
export function appliesLabel(v: Pick<RuleVersionOut, 'effective_from' | 'vote_date'>): string {
  if (v.effective_from) return fmtDate(v.effective_from);
  if (v.vote_date) return `awaiting vote ${fmtDate(v.vote_date)}`;
  return 'no date yet';
}

/**
 * The provision's name, not its full text: "Revoke-all: a revocation made in
 * response to …" → "Revoke-all". Text without a short lead-in is clipped.
 */
export function provisionName(provision: string): string {
  const text = provision.split(/\s+/).join(' ').trim();
  const colon = text.indexOf(':');
  if (colon > 0 && colon <= 40) return text.slice(0, colon);
  return text.length <= 60 ? text : `${text.slice(0, 59).trimEnd()}…`;
}

/** "Revoke-all deferred to Jan 31, 2027" (the full provision text belongs in a title). */
export function deferralLine(d: RuleDeferral): string {
  return `${provisionName(d.provision)} deferred to ${fmtDate(d.deferred_to)}`;
}

/** "RESTORES_PRIOR" → "restores prior" (every underscore, not only the first). */
export function classificationLabel(c: string | null | undefined): string {
  return (c ?? '—').replace(/_/g, ' ');
}

const AUTHORITY_RANK: Record<string, number> = { primary: 0, preamble: 1, secondary: 2 };
const AUTHORITY_LABEL: Record<string, string> = {
  primary: 'Primary authority',
  preamble: 'Preamble',
  secondary: 'Secondary interpretation',
};

/** Sources ranked primary → preamble → secondary; stable within a rank. */
export function rankSources(sources: RuleSourceRef[] | undefined): RuleSourceRef[] {
  return [...(sources ?? [])]
    .map((src, i) => ({ src, i }))
    .sort((a, b) => (AUTHORITY_RANK[a.src.authority] ?? 9) - (AUTHORITY_RANK[b.src.authority] ?? 9) || a.i - b.i)
    .map(({ src }) => src);
}

export function authorityLabel(authority: string): string {
  return AUTHORITY_LABEL[authority] ?? authority;
}

/**
 * The earliest enacted version taking effect after `today` and within `days` (YYYY-MM-DD),
 * or null. A rule page with no date opens there: today's state of a rule about to change
 * shows nothing stale and hides the point.
 */
export function nextChangeWithin(versions: RuleVersionOut[] | undefined, today: string, days: number): string | null {
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + days);
  const horizon = limit.toISOString().slice(0, 10);
  const dates = (versions ?? [])
    .filter(governs)
    .map((v) => v.effective_from)
    .filter((d) => d > today && d <= horizon)
    .sort();
  return dates[0] ?? null;
}
