/**
 * Table skeleton: flat bars in the real column grid, shown only while the
 * first response is in flight (never as decoration). Screen readers get one
 * "Loading" status instead of N empty cells.
 */

const WIDTHS = ['72%', '48%', '86%', '60%', '38%', '66%', '54%', '80%'];

export function SkeletonRows({ columns, rows = 6, label = 'Loading' }: { columns: number; rows?: number; label?: string }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden={r > 0 ? true : undefined} data-testid="skeleton-row">
          {Array.from({ length: columns }, (_, c) => (
            <td key={c}>
              {r === 0 && c === 0 && (
                <span role="status" className="sr-only">
                  {label}…
                </span>
              )}
              <span className="sk sk-shimmer" style={{ width: WIDTHS[(r + c) % WIDTHS.length] }} aria-hidden />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
