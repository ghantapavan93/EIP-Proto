/**
 * Readiness vocabulary: milestone kinds in words, countdown phrasing, and the
 * owner-queue ordering (oldest open item first — the queue most likely to
 * miss the date).
 */

import type { ReadinessMilestone, ReadinessOwner } from '../api/types';
import type { Tone } from './vocab';

const KIND_LABELS: Record<string, string> = {
  rule_applies: 'rule applies',
  vote: 'vote',
  deferral_ends: 'deferral ends',
  marketing_start: 'marketing opens',
  aep_start: 'AEP opens',
  aep_end: 'AEP closes',
  oep_start: 'OEP opens',
};

/** "rule_applies" → "rule applies"; unknown kinds are humanized, never dropped. */
export function milestoneKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/[_-]/g, ' ');
}

/** Calendar dates (marketing, AEP, OEP) are the frame everything is measured against. */
export function isCalendarKind(kind: string): boolean {
  return kind === 'marketing_start' || kind.startsWith('aep') || kind.startsWith('oep');
}

/**
 * Chip tone per kind. The Medicare calendar is teal (system dates); a rule
 * applying is slate; a deferral landing is amber (a requirement arrives); a
 * vote stays neutral — it is not law.
 */
export function milestoneTone(kind: string): Tone {
  if (isCalendarKind(kind)) return 'teal';
  if (kind === 'rule_applies') return 'slate';
  if (kind === 'deferral_ends') return 'amber';
  return 'neutral';
}

/** The horizon bands are disjoint: "30" is the next 30 days, "60" days 31–60, "90" days 61–90. */
export const HORIZON_BANDS: ReadonlyArray<readonly [string, string]> = [
  ['30', 'Next 30 days'],
  ['60', '31–60 days'],
  ['90', '61–90 days'],
];

/** "today" · "tomorrow" · "in 6 days" · "2 days ago". */
export function countdownLabel(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/**
 * Task age for the owner table. Ages are measured when the page is served, so
 * a queue seeded minutes ago reads "<1 day", not a bare zero.
 */
export function daysLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return '—';
  if (days < 1) return '<1 day';
  const d = Math.round(days * 10) / 10;
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

/** Oldest open item first; ties go to the longer queue. Roles with nothing open sink. */
export function sortOwners(owners: ReadinessOwner[]): ReadinessOwner[] {
  return [...owners].sort((a, b) => (b.oldest_days ?? -1) - (a.oldest_days ?? -1) || b.open - a.open || a.role.localeCompare(b.role));
}

/** Upcoming milestones (days ≥ 0) in date order; past ones are kept only when asked. */
export function upcoming(milestones: ReadinessMilestone[], includePast = false): ReadinessMilestone[] {
  return [...milestones].filter((m) => includePast || m.days_from_as_of >= 0).sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

/**
 * Items per day needed to clear the actionable queue by the target date.
 * Null when the date has passed or nothing is open.
 */
export function requiredPace(open: number, daysLeft: number): number | null {
  if (open <= 0 || daysLeft <= 0) return null;
  return Math.ceil((open / daysLeft) * 10) / 10;
}
