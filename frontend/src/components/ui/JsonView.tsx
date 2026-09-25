import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface JsonViewProps {
  value: unknown;
  /** collapse objects deeper than this level (0 = collapse all children) */
  collapsedBelow?: number;
  className?: string;
  /** keys to visually call out (e.g. rule-dependent judgments) */
  highlightKeys?: Set<string>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="text-ink-3">null</span>;
  if (typeof value === 'string') return <span className="text-teal-ink">&quot;{value}&quot;</span>;
  if (typeof value === 'number') return <span className="text-navy">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-amber-ink">{String(value)}</span>;
  return <span className="text-ink-2">{String(value)}</span>;
}

function Node({
  name,
  value,
  depth,
  collapsedBelow,
  highlightKeys,
  isLast,
}: {
  name: string | null;
  value: unknown;
  depth: number;
  collapsedBelow: number;
  highlightKeys?: Set<string>;
  isLast: boolean;
}) {
  const [open, setOpen] = useState(depth < collapsedBelow);
  const container = isObject(value) || Array.isArray(value);
  const highlighted = name !== null && highlightKeys?.has(name);
  const keyNode =
    name !== null ? (
      <span className={cn('text-slate', highlighted && 'bg-amber/15 px-0.5 font-semibold text-amber-ink')}>
        &quot;{name}&quot;
        <span className="text-ink-3">: </span>
      </span>
    ) : null;

  if (!container) {
    return (
      <div className="whitespace-pre" style={{ paddingLeft: depth * 14 }}>
        {keyNode}
        <Primitive value={value} />
        {!isLast && <span className="text-ink-3">,</span>}
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const [openB, closeB] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];

  return (
    <div>
      <div className="flex items-center whitespace-pre" style={{ paddingLeft: depth * 14 }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="-ml-4 mr-0.5 inline-flex h-4 w-4 items-center justify-center text-ink-3 hover:text-slate"
          aria-label={open ? 'collapse' : 'expand'}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        </button>
        {keyNode}
        <span className="text-ink-3">{openB}</span>
        {!open && (
          <span className="text-ink-3">
            {' '}
            {entries.length} {Array.isArray(value) ? 'items' : 'keys'} {closeB}
            {!isLast && ','}
          </span>
        )}
      </div>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <Node
              key={k}
              name={Array.isArray(value) ? null : k}
              value={v}
              depth={depth + 1}
              collapsedBelow={collapsedBelow}
              highlightKeys={highlightKeys}
              isLast={i === entries.length - 1}
            />
          ))}
          <div className="whitespace-pre" style={{ paddingLeft: depth * 14 }}>
            <span className="text-ink-3">
              {closeB}
              {!isLast && ','}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** Collapsible pretty JSON in the monospace stack. */
export function JsonView({ value, collapsedBelow = 3, className, highlightKeys }: JsonViewProps) {
  return (
    <div className={cn('overflow-auto bg-band px-3 py-2 pl-6 font-mono text-[12px] leading-[1.55] text-ink', className)}>
      <Node name={null} value={value} depth={0} collapsedBelow={collapsedBelow} highlightKeys={highlightKeys} isLast />
    </div>
  );
}
