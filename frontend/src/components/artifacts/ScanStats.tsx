import { Link } from 'react-router-dom';
import type { ScanOut } from '../../api/types';
import { Chip } from '../ui/Chip';
import { JsonView } from '../ui/JsonView';
import { cn } from '../../lib/cn';
import { fmtNumber, fmtTs, shortHash } from '../../lib/format';

/** Result card for one POST /scans: counts, per-rule staleness, LLM proposer stats. */
export function ScanStats({ scan }: { scan: ScanOut }) {
  const s = scan.stats;
  const n = (v: unknown) => (typeof v === 'number' ? fmtNumber(v) : v === undefined ? '—' : String(v));
  const staleness = s.staleness && typeof s.staleness === 'object' ? Object.entries(s.staleness) : [];
  return (
    <div className="card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Scan</span>
        <span className="font-mono text-[12px]" title={scan.id}>{shortHash(scan.id, 8)}</span>
        <Chip tone={scan.status === 'completed' ? 'green' : scan.status === 'failed' ? 'red' : 'amber'}>{scan.status}</Chip>
        {scan.deduplicated && <Chip tone="teal">deduplicated</Chip>}
        {typeof s.mode === 'string' && <Chip tone="neutral">{s.mode}</Chip>}
        {typeof s.as_of === 'string' && <Chip tone="teal" mono>as of {s.as_of}</Chip>}
        <span className="ml-auto font-mono text-[11px] text-ink-2">
          key {scan.idempotency_key} · {fmtTs(scan.started_at)} → {fmtTs(scan.finished_at)}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
        {[
          ['Artifacts', s.artifacts],
          ['Unchanged', s.unchanged],
          ['New versions', s.new_versions],
          ['Fetch errors', s.fetch_errors],
          ['Edges new', s.edges_new],
          ['Edges existing', s.edges_existing],
          ['Edges superseded', s.edges_superseded],
          ['Proposed new', s.proposed_new],
        ].map(([label, value]) => (
          <div key={String(label)} className="border border-hairline px-2 py-1.5">
            <div className="eyebrow">{label}</div>
            <div className={cn('font-mono text-[18px] font-semibold', label === 'Fetch errors' && typeof value === 'number' && value > 0 ? 'text-red' : 'text-navy')}>{n(value)}</div>
          </div>
        ))}
      </div>
      {staleness.length > 0 && (
        <div className="mt-3">
          <div className="eyebrow mb-1">Staleness as of {typeof s.as_of === 'string' ? s.as_of : 'scan date'} — per rule</div>
          <table className="dt">
            <thead>
              <tr>
                <th>Rule</th>
                <th className="text-right">Artifacts</th>
                <th className="text-right">Encodings</th>
                <th className="text-right">Over</th>
                <th className="text-right">Under</th>
                <th className="text-right">Re-verify</th>
                <th className="text-right">Disputed</th>
              </tr>
            </thead>
            <tbody>
              {staleness.map(([rule, c]) => (
                <tr key={rule}>
                  <td><Link to={`/rules/${encodeURIComponent(rule)}?as_of=${typeof s.as_of === 'string' ? s.as_of : ''}`} className="font-mono">{rule}</Link></td>
                  <td className="num font-mono">{c.artifacts}</td>
                  <td className="num font-mono">{c.total}</td>
                  <td className={cn('num font-mono', c.over_restrictive ? 'text-amber-ink' : 'text-ink-3')}>{c.over_restrictive}</td>
                  <td className={cn('num font-mono', c.under_restrictive ? 'text-red' : 'text-ink-3')}>{c.under_restrictive}</td>
                  <td className={cn('num font-mono', c.reverify ? 'text-slate' : 'text-ink-3')}>{c.reverify}</td>
                  <td className={cn('num font-mono', c.disputed ? 'text-amber-ink' : 'text-ink-3')}>{c.disputed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s.llm !== undefined && s.llm !== null && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.5px] text-ink-2">LLM proposer stats</summary>
          <JsonView value={s.llm} className="mt-1" />
        </details>
      )}
    </div>
  );
}
