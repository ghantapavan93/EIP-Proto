import type { EdgeOut, ImpactCounts, RuleOut, RuleVersionOut } from '../api/types';
import { governs } from '../lib/ruleVersions';

/** Port of backend/backstop/core/staleness.py, used only by the mock server. */

export const OVER = 'over_restrictive';
export const UNDER = 'under_restrictive';
export const REVERIFY = 'reverify';

const TABLE: Record<string, [string, string, string]> = {
  REMOVES_REQUIREMENT: [OVER, REVERIFY, 'the requirement this artifact enforces was removed'],
  LOOSENS: [OVER, REVERIFY, 'the rule was loosened; the artifact still applies the stricter clause'],
  ADDS_REQUIREMENT: [UNDER, UNDER, 'a new requirement applies that this artifact does not encode'],
  TIGHTENS: [UNDER, UNDER, 'the rule was tightened; the artifact still encodes the weaker clause'],
  MODIFIES: [
    REVERIFY,
    REVERIFY,
    'the basis of the rule changed; both over- and under-restrictive encodings are possible',
  ],
  CLARIFIES: [
    REVERIFY,
    REVERIFY,
    "wording was clarified; confirm the artifact's text matches the current clause",
  ],
  RESTORES_PRIOR: [
    REVERIFY,
    REVERIFY,
    'a court restored the prior text; confirm the artifact does not encode the vacated version',
  ],
};

export interface StaleVerdict {
  edge: EdgeOut;
  bound_version: number;
  in_force_version: number;
  direction: string;
  reason: string;
  disputed: boolean;
}

export function versionInForce(rule: RuleOut, asOf: string): RuleVersionOut | null {
  const sorted = [...rule.versions].sort((a, b) => a.version - b.version);
  for (const ver of sorted) {
    // proposed, vacated and stayed versions never govern (backend: impact.version_views)
    if (!governs(ver)) continue;
    if (ver.effective_from <= asOf && (ver.effective_to === null || asOf <= ver.effective_to)) {
      return ver;
    }
  }
  return null;
}

function directionForPath(path: RuleVersionOut[], polarity: string): [string, string] {
  if (!path.length) return [REVERIFY, 'no change classification on path'];
  if (polarity === 'INFORMS') return [REVERIFY, 'informational artifact references a superseded clause'];
  const directions: Array<[string, string]> = path.map((v) => {
    const [enforceDir, permitDir, reason] = TABLE[v.change_classification] ?? [
      REVERIFY,
      REVERIFY,
      'unclassified change',
    ];
    return [polarity === 'ENFORCES' ? enforceDir : permitDir, reason];
  });
  const definite = new Set(directions.map(([d]) => d).filter((d) => d === OVER || d === UNDER));
  if (definite.size === 1) {
    const d = [...definite][0];
    const reason = directions.find(([dd]) => dd === d)?.[1] ?? '';
    return [d, reason];
  }
  if (definite.size > 1) return [REVERIFY, 'successive changes pull in opposite directions'];
  return directions[directions.length - 1];
}

export function evaluate(rule: RuleOut, edges: EdgeOut[], asOf: string): StaleVerdict[] {
  const current = versionInForce(rule, asOf);
  if (!current) return [];
  const byId = new Map(rule.versions.map((v) => [v.id, v]));
  const verdicts: StaleVerdict[] = [];
  for (const edge of edges) {
    if (edge.status !== 'confirmed') continue;
    const bound = byId.get(edge.rule_version_id);
    if (!bound || bound.id === current.id) continue;
    const path = [...rule.versions]
      .sort((a, b) => a.version - b.version)
      .filter((v) => governs(v) && bound.version < v.version && v.version <= current.version);
    const [direction, reason] = directionForPath(path, edge.polarity);
    verdicts.push({
      edge,
      bound_version: bound.version,
      in_force_version: current.version,
      direction,
      reason: `bound to v${bound.version}; v${current.version} in force as of ${asOf}: ${reason}`,
      disputed: path.some((v) => v.disputed),
    });
  }
  return verdicts;
}

/** `total` counts edges (encodings); `artifacts` counts distinct artifacts. */
export function summarize(verdicts: StaleVerdict[]): ImpactCounts {
  const counts: ImpactCounts = {
    over_restrictive: 0,
    under_restrictive: 0,
    reverify: 0,
    disputed: 0,
    total: verdicts.length,
    artifacts: new Set(verdicts.map((v) => v.edge.asset_code)).size,
  };
  for (const v of verdicts) {
    counts[v.direction] = (counts[v.direction] ?? 0) + 1;
    if (v.disputed) counts.disputed += 1;
  }
  return counts;
}
