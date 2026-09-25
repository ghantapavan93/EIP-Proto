import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { CompareOut } from '../../api/types';
import { cn } from '../../lib/cn';

type Direction = 'failing' | 'passing';

interface MatrixCell {
  dir: Direction;
  a: string;
  b: string;
}

/**
 * Contract × call heat strip, derived only from the compare response: rows
 * are the contracts in per_contract (plus any that appear in a delta list),
 * columns are the calls that moved in either direction. A cell is red when it
 * is in newly_failing, green when in newly_passing; every other cell is
 * neutral — "not in either delta list", which covers unchanged cells and
 * cells only one run scored. Coloured cells open that call in run B.
 */
export function ChangeMatrix({ compare, runB }: { compare: CompareOut; runB: string }) {
  const { contracts, calls, cells, rowTotals } = useMemo(() => {
    const cells = new Map<string, MatrixCell>();
    const callSet = new Set<string>();
    const contractSet = new Set<string>(compare.per_contract.map((p) => p.contract_code));
    const rowTotals = new Map<string, { failing: number; passing: number }>();
    const add = (list: CompareOut['newly_failing'], dir: Direction) => {
      for (const c of list) {
        callSet.add(c.transcript_code);
        contractSet.add(c.contract_code);
        cells.set(`${c.contract_code}|${c.transcript_code}`, { dir, a: c.a, b: c.b });
        const t = rowTotals.get(c.contract_code) ?? { failing: 0, passing: 0 };
        t[dir] += 1;
        rowTotals.set(c.contract_code, t);
      }
    };
    add(compare.newly_failing, 'failing');
    add(compare.newly_passing, 'passing');
    return {
      contracts: [...contractSet].sort(),
      calls: [...callSet].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })),
      cells,
      rowTotals,
    };
  }, [compare]);

  if (!calls.length) return null;

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto px-4 pb-3 pt-3">
        <table className="border-separate border-spacing-[2px] text-[11px]" aria-describedby="change-matrix-legend">
          <caption className="sr-only">
            Changed cells by contract and call: {compare.newly_failing.length} newly failing, {compare.newly_passing.length} newly passing
          </caption>
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                Contract
              </th>
              {calls.map((code) => (
                <th key={code} scope="col" className="h-10 w-3.5 p-0 align-bottom font-mono text-[9.5px] font-medium text-ink-3">
                  <span className="inline-block rotate-180 whitespace-nowrap leading-none [writing-mode:vertical-rl]">{code}</span>
                </th>
              ))}
              <th scope="col" className="sr-only">
                Changed in this contract
              </th>
            </tr>
          </thead>
          <tbody>
            {contracts.map((contract) => {
              const t = rowTotals.get(contract);
              return (
                <tr key={contract}>
                  <th scope="row" className="whitespace-nowrap pr-2 text-left font-mono text-[11px] font-semibold text-ink">
                    {contract}
                  </th>
                  {calls.map((call) => {
                    const cell = cells.get(`${contract}|${call}`);
                    const base = 'block h-3.5 w-3.5 rounded-[2px]';
                    if (!cell) return <td key={call} className="p-0"><span className={cn(base, 'bg-band')} title={`${call} · ${contract}: not in either delta list`} /></td>;
                    const label = `${call} · ${contract}: ${cell.a} → ${cell.b} (newly ${cell.dir}) — open ${call} in run B`;
                    return (
                      <td key={call} className="p-0">
                        <Link
                          to={`/runs/${runB}/transcripts/${encodeURIComponent(call)}`}
                          className={cn(base, 'outline-offset-1 transition-[box-shadow] hover:shadow-[0_0_0_2px_var(--color-ink)] hover:no-underline', cell.dir === 'failing' ? 'bg-red' : 'bg-green-ink')}
                          title={label}
                          aria-label={label}
                        />
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap pl-2 font-mono text-[11px] tabular-nums">
                    {t?.failing ? <span className="font-semibold text-red" title="newly failing in this contract">{t.failing} failing</span> : null}
                    {t?.failing && t?.passing ? <span className="text-ink-3"> · </span> : null}
                    {t?.passing ? <span className="font-semibold text-green-ink" title="newly passing in this contract">+{t.passing} passing</span> : null}
                    {!t && <span className="text-ink-3">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div id="change-matrix-legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline bg-canvas px-4 py-2 text-[11px] text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-red" /> newly failing (passed in A)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-green-ink" /> newly passing (failed or flagged in A)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] border border-hairline bg-band" /> not in either delta list
        </span>
        <span className="ml-auto text-ink-3">
          {calls.length} {calls.length === 1 ? 'call' : 'calls'} moved · click a cell to open that call in run B
        </span>
      </div>
    </div>
  );
}
