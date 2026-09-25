import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Chip } from '../ui/Chip';
import { DirectionChip } from '../rules/DirectionChip';

export interface FanNode {
  id: string;
  label: string;
  sublabel?: string;
  /** under_restrictive | over_restrictive | reverify | healthy */
  direction: 'under_restrictive' | 'over_restrictive' | 'reverify' | 'healthy';
  /** artifact type, e.g. "Scorecard item" */
  typeLabel?: string;
  synthetic?: boolean;
  href?: string;
}

export interface FanDiagramProps {
  ruleCode: string;
  ruleLabel?: string;
  nodes: FanNode[];
  className?: string;
  onNodeClick?: (node: FanNode) => void;
}

/** Branch color by direction: red under-restrictive, amber over-restrictive, slate re-verify, green healthy. */
const BRANCH: Record<FanNode['direction'], string> = {
  under_restrictive: 'border-red',
  over_restrictive: 'border-amber',
  reverify: 'border-slate',
  healthy: 'border-green',
};

/** Group order and the one-line reading of each direction. */
const GROUPS: Array<{ direction: FanNode['direction']; reading: string }> = [
  { direction: 'under_restrictive', reading: 'encodes a weaker clause or misses a new requirement' },
  { direction: 'over_restrictive', reading: 'still enforces what the rule no longer requires' },
  { direction: 'reverify', reading: 'basis or wording changed — a human must read it' },
  { direction: 'healthy', reading: 'bound to the version in force' },
];

/**
 * One tree row with its connector: a vertical trunk from the row above (and
 * on to the next row unless `last`) and a horizontal branch into the row,
 * colored by direction. Plain CSS borders so labels wrap instead of
 * overlapping and the tree still reads as an indented list on a phone.
 */
function Branch({ last, color, anchor, children, className }: { last: boolean; color: string; anchor: 'center' | 'head'; children: ReactNode; className?: string }) {
  // "center": the branch meets the middle of the row; "head": it meets a 34px
  // header row at the top of the item (a group whose children hang below it).
  const joint = anchor === 'center' ? 'calc(50% + 4px)' : '25px';
  return (
    <li className={cn('relative pl-5 pt-2 sm:pl-6', className)}>
      <span aria-hidden className="absolute left-0 top-0 border-l-2 border-hairline" style={{ height: joint }} />
      {!last && <span aria-hidden className="absolute bottom-0 left-0 border-l-2 border-hairline" style={{ top: joint }} />}
      <span aria-hidden className={cn('absolute left-0 w-5 border-t-2 sm:w-6', color)} style={{ top: `calc(${joint} - 1px)` }} />
      {children}
    </li>
  );
}

/**
 * Blast-radius dependency view: the rule version at the root, one branch per
 * direction (under-restrictive → over-restrictive → re-verify → current) with
 * its artifact count, and under each the linked artifacts (type, name,
 * provenance). Groups with no artifacts are left out.
 */
export function FanDiagram({ ruleCode, ruleLabel, nodes, className, onNodeClick }: FanDiagramProps) {
  const groups = GROUPS.map((g) => ({ ...g, nodes: nodes.filter((n) => n.direction === g.direction) })).filter((g) => g.nodes.length > 0);
  return (
    <figure className={cn('m-0', className)} aria-label={`${ruleCode}: ${nodes.length} linked artifacts`}>
      <div className="inline-flex max-w-full items-center gap-2.5 rounded-[8px] bg-navy px-3 py-2 text-on-navy">
        <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.02em]">{ruleCode}</span>
        <span className="h-3.5 w-px bg-on-navy/25" aria-hidden />
        <span className="truncate text-[12px] text-on-navy-muted">{ruleLabel ?? 'rule'}</span>
      </div>
      <ul className="ml-[18px]">
        {groups.map((g, gi) => (
          <Branch key={g.direction} last={gi === groups.length - 1} color={BRANCH[g.direction]} anchor="head">
            <div className="flex min-h-[34px] flex-wrap items-center gap-x-2 gap-y-1">
              {g.direction === 'healthy' ? (
                <Chip tone="green" title="Bound to the version in force">
                  current
                </Chip>
              ) : (
                <DirectionChip direction={g.direction} />
              )}
              <span className="font-mono text-[12px] font-semibold tabular-nums text-ink">
                {g.nodes.length} {g.nodes.length === 1 ? 'artifact' : 'artifacts'}
              </span>
              <span className="text-[12px] text-ink-2">· {g.reading}</span>
            </div>
            <ul className="ml-[14px]">
              {g.nodes.map((n, i) => {
                const body = (
                  <>
                    <span className="min-w-0 flex-1">
                      {n.typeLabel && <span className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-2">{n.typeLabel}</span>}
                      <span className="block text-[13px] font-medium leading-snug text-ink">{n.label}</span>
                      {n.sublabel && <span className="block font-mono text-[11px] text-ink-3 sm:hidden">{n.sublabel}</span>}
                    </span>
                    {n.sublabel && <span className="hidden shrink-0 font-mono text-[11px] text-ink-3 sm:inline">{n.sublabel}</span>}
                    {onNodeClick && <ChevronRight size={14} className="shrink-0 text-ink-3" aria-hidden />}
                  </>
                );
                const rowCls = 'flex w-full items-center gap-3 rounded-[6px] border border-hairline bg-surface px-3 py-2 text-left';
                return (
                  <Branch key={n.id} last={i === g.nodes.length - 1} color={BRANCH[n.direction]} anchor="center">
                    {onNodeClick ? (
                      <button
                        type="button"
                        className={cn(rowCls, 'cursor-pointer transition-colors hover:border-teal hover:bg-teal/5')}
                        onClick={() => onNodeClick(n)}
                        title={n.href ? `Open ${n.label}` : n.label}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className={rowCls}>{body}</div>
                    )}
                  </Branch>
                );
              })}
            </ul>
          </Branch>
        ))}
      </ul>
    </figure>
  );
}
