import type {
  EdgeOut,
  ReadinessHorizonItem,
  ReadinessMilestone,
  ReadinessOut,
  ReadinessOwner,
  ReadinessProposed,
  ReadinessVacated,
  ReviewTaskOut,
  RuleOut,
} from '../api/types';
import { governs } from '../lib/ruleVersions';
import { evaluate } from './staleness';

/**
 * Port of backend api/readiness.py for the mock: milestones for the next
 * year (the Medicare calendar, rule versions that start to apply, votes on
 * proposals, deferred provisions landing), the disjoint 30/60/90-day horizon,
 * open work per owner (ages measured now, not at as_of), the burn-down to the
 * next marketing season, and the versions Backstop deliberately does not
 * enforce (vacated, stayed) or does not treat as law (proposed).
 */

const DAY_MS = 86_400_000;
const MILESTONE_HORIZON_DAYS = 365;
const BANDS: Array<[string, number, number]> = [
  ['30', 0, 30],
  ['60', 31, 60],
  ['90', 61, 90],
];
const KIND_ORDER: Record<string, number> = { marketing_start: 0, aep_start: 1, aep_end: 2, oep_start: 3, rule_applies: 4, vote: 5, deferral_ends: 6 };
const SET_ASIDE = new Set(['vacated', 'stayed']);
const OPEN_STATES = new Set(['open', 'in_review', 'verified']);

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** month/day on or after as_of, as YYYY-MM-DD */
function nextOnOrAfter(asOf: string, month: number, day: number): string {
  const year = Number(asOf.slice(0, 4));
  const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return candidate >= asOf ? candidate : `${year + 1}-${candidate.slice(5)}`;
}

function clip(text: string, limit: number): string {
  const t = text.split(/\s+/).join(' ').trim();
  return t.length <= limit ? t : `${t.slice(0, limit - 1).trimEnd()}…`;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A STALE_ASSET task in state verified can still move (to republished), so it is open work. */
function isOpen(t: ReviewTaskOut): boolean {
  if (t.kind !== 'STALE_ASSET' && t.state === 'verified') return false;
  return OPEN_STATES.has(t.state);
}

export function readiness(
  rules: RuleOut[],
  edges: EdgeOut[],
  tasks: ReviewTaskOut[],
  asOf: string,
  laneOf: (t: ReviewTaskOut) => string,
  now: Date = new Date(),
): ReadinessOut {
  const horizonEnd = addDays(asOf, MILESTONE_HORIZON_DAYS);
  const within = (d: string) => asOf <= d && d <= horizonEnd;
  const staleOn = (rule: RuleOut, date: string) => evaluate(rule, edges.filter((e) => e.rule_code === rule.code), date);
  const openTasks = tasks.filter(isOpen);

  const marketing = nextOnOrAfter(asOf, 10, 1);
  const aepStart = nextOnOrAfter(asOf, 10, 15);
  const aepEnd = nextOnOrAfter(asOf, 12, 7);
  const oepStart = nextOnOrAfter(asOf, 1, 1);
  const milestones: Array<Omit<ReadinessMilestone, 'days_from_as_of'>> = [
    { date: marketing, kind: 'marketing_start', label: `CY${Number(marketing.slice(0, 4)) + 1} marketing may begin (42 CFR 422.2263(a))`, rule_code: null, version: null, status: null },
    { date: aepStart, kind: 'aep_start', label: `AEP opens for CY${Number(aepStart.slice(0, 4)) + 1} coverage`, rule_code: null, version: null, status: null },
    { date: aepEnd, kind: 'aep_end', label: `AEP closes (CY${Number(aepEnd.slice(0, 4)) + 1} coverage)`, rule_code: null, version: null, status: null },
    { date: oepStart, kind: 'oep_start', label: `MA Open Enrollment Period opens (CY${oepStart.slice(0, 4)})`, rule_code: null, version: null, status: null },
  ];
  const horizon: Record<string, ReadinessHorizonItem[]> = { '30': [], '60': [], '90': [] };
  const vacated: ReadinessVacated[] = [];
  const proposed: ReadinessProposed[] = [];

  for (const rule of rules) {
    for (const v of rule.versions) {
      if (SET_ASIDE.has(v.status)) {
        const top = v.sources?.[0];
        vacated.push({ rule_code: rule.code, version: v.version, status: v.status, why: clip(v.summary || v.clause_text, 400), source: top?.cite || v.source_url || rule.citation, source_url: top?.url || v.source_url || '' });
        continue;
      }
      if (v.status === 'proposed') {
        proposed.push({ rule_code: rule.code, version: v.version, vote_date: v.vote_date ?? null, why: clip(v.summary || v.clause_text, 400), effective_from: v.effective_from, origin: v.git_commit.startsWith('ui:') || v.git_commit === 'uncommitted' ? 'api' : 'yaml' });
        if (v.vote_date && within(v.vote_date)) {
          milestones.push({ date: v.vote_date, kind: 'vote', rule_code: rule.code, version: v.version, status: v.status, label: `${rule.regulator} vote on ${rule.code} v${v.version} (proposed)` });
        }
        continue;
      }
      if (!governs(v)) continue;
      for (const d of v.deferrals ?? []) {
        if (within(d.deferred_to)) {
          milestones.push({ date: d.deferred_to, kind: 'deferral_ends', rule_code: rule.code, version: v.version, status: v.status, label: `${rule.code} v${v.version}: deferral ends — ${clip(d.provision, 90)}` });
        }
      }
      if (!within(v.effective_from)) continue;
      milestones.push({
        date: v.effective_from,
        kind: 'rule_applies',
        rule_code: rule.code,
        version: v.version,
        status: v.status,
        label: `${rule.code} v${v.version} applies (${v.change_classification.toLowerCase().replace(/_/g, ' ')})`,
      });
      const offset = daysBetween(asOf, v.effective_from);
      const band = BANDS.find(([, lo, hi]) => lo <= offset && offset <= hi)?.[0];
      if (!band) continue;
      const verdicts = staleOn(rule, v.effective_from);
      horizon[band].push({
        rule_code: rule.code,
        rule_title: rule.title,
        version: v.version,
        applies_from: v.effective_from,
        change_classification: v.change_classification,
        stale_encodings_on_that_date: verdicts.length,
        artifacts_on_that_date: new Set(verdicts.map((x) => x.edge.asset_code)).size,
        open_tasks: openTasks.filter((t) => t.rule_code === rule.code && t.rule_version === v.version).length,
      });
    }
  }
  milestones.sort((a, b) => a.date.localeCompare(b.date) || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || (a.rule_code ?? '').localeCompare(b.rule_code ?? '') || (a.version ?? 0) - (b.version ?? 0));
  for (const items of Object.values(horizon)) {
    items.sort((a, b) => a.applies_from.localeCompare(b.applies_from) || b.stale_encodings_on_that_date - a.stale_encodings_on_that_date || a.rule_code.localeCompare(b.rule_code));
  }

  const byRole = new Map<string, ReviewTaskOut[]>();
  for (const t of openTasks) byRole.set(t.assignee_role || 'unassigned', [...(byRole.get(t.assignee_role || 'unassigned') ?? []), t]);
  const owners: ReadinessOwner[] = [...byRole.entries()]
    .map(([role, list]) => {
      const ages = list.map((t) => Math.max(0, (now.getTime() - Date.parse(t.opened_at)) / DAY_MS));
      const byKind: Record<string, number> = {};
      for (const t of [...list].sort((a, b) => a.kind.localeCompare(b.kind))) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
      const round = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
      return {
        role,
        open: list.length,
        actionable: list.filter((t) => laneOf(t) === 'actionable').length,
        oldest_days: round(ages.length ? Math.max(...ages) : null),
        median_age_days: round(median(ages)),
        by_kind: byKind,
      };
    })
    .sort((a, b) => b.actionable - a.actionable || b.open - a.open || a.role.localeCompare(b.role));

  return {
    as_of: asOf,
    generated_at: now.toISOString(),
    milestones: milestones.map((m) => ({ ...m, days_from_as_of: daysBetween(asOf, m.date) })),
    horizon,
    owners,
    burn_down: {
      target: marketing,
      label: `CY${Number(marketing.slice(0, 4)) + 1} marketing changes apply`,
      open_actionable_now: owners.reduce((n, o) => n + o.actionable, 0),
      stale_encodings_on_target: rules.reduce((n, r) => n + staleOn(r, marketing).length, 0),
      days_left: daysBetween(asOf, marketing),
      aep: { date: aepStart, days_left: daysBetween(asOf, aepStart) },
      note: 'Open counts are live. There is no history table, so there is no trend line; stale encodings on the target date are evaluated in memory and open no tasks.',
    },
    vacated: vacated.sort((a, b) => a.rule_code.localeCompare(b.rule_code) || a.version - b.version),
    proposed: proposed.sort((a, b) => (a.vote_date ?? '9999').localeCompare(b.vote_date ?? '9999') || a.rule_code.localeCompare(b.rule_code) || a.version - b.version),
  };
}
