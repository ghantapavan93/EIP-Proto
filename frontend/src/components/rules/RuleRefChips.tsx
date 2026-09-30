import { Link } from 'react-router-dom';
import type { RuleVersionRef } from '../../api/types';
import { Chip } from '../ui/Chip';

/**
 * Rule-version references ("soa-48h-wait@v2") as chips. `statuses` (keyed
 * "rule@version") annotates a reference whose edge is not confirmed;
 * `linked` makes each chip open its rule.
 */
export function RuleRefChips({
  refs,
  tone,
  statuses,
  linked = false,
}: {
  refs: RuleVersionRef[];
  tone: 'neutral' | 'green' | 'red' | 'amber';
  statuses?: Record<string, string>;
  linked?: boolean;
}) {
  if (!refs.length) return <span className="text-ink-3">none</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {refs.map((r) => {
        const status = statuses?.[`${r.rule}@${r.version}`];
        const chip = (
          <Chip tone={tone} mono title={status ? `edge status: ${status}` : undefined}>
            {r.rule}@v{r.version}
            {status && status !== 'confirmed' ? ` · ${status}` : ''}
          </Chip>
        );
        const key = `${r.rule}@${r.version}`;
        return linked ? (
          <Link key={key} to={`/rules/${encodeURIComponent(r.rule)}`} className="hover:no-underline">
            {chip}
          </Link>
        ) : (
          <span key={key}>{chip}</span>
        );
      })}
    </span>
  );
}
