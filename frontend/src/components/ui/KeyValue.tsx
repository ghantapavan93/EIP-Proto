import { cn } from '../../lib/cn';
import type { KeyValueRow } from '../../lib/keyvalue';

export type { KeyValueRow } from '../../lib/keyvalue';

/** Two-column key/value table; values default to mono. */
export function KeyValue({
  rows,
  className,
  dense = true,
}: {
  rows: KeyValueRow[];
  className?: string;
  dense?: boolean;
}) {
  return (
    <table className={cn('w-full border-collapse text-[13px]', className)}>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-b border-hairline last:border-b-0">
            <th
              scope="row"
              className={cn(
                'w-[38%] pr-3 text-left align-top font-medium text-ink-2 [overflow-wrap:anywhere]',
                dense ? 'py-1' : 'py-1.5',
              )}
            >
              {row.key}
            </th>
            <td className={cn('align-top text-ink [overflow-wrap:anywhere]', dense ? 'py-1' : 'py-1.5', row.mono !== false && 'font-mono text-[12px]')}>
              {row.value === null || row.value === undefined || row.value === '' ? (
                <span className="text-ink-3">—</span>
              ) : (
                row.value
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
