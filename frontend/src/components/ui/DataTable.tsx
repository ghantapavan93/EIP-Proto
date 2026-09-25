import { useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import { cellWraps, type DataTableColumnMeta } from '../../lib/table';

export type { DataTableColumnMeta } from '../../lib/table';
import { EmptyState } from './EmptyState';
import { SkeletonRows } from './Skeleton';
import { ErrorState } from './ErrorState';

export interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[] | undefined;
  isLoading?: boolean;
  error?: unknown;
  retry?: () => void;
  onRowClick?: (row: T) => void;
  getRowId?: (row: T, index: number) => string;
  selectedIds?: Set<string>;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  /** one next step under the empty message, e.g. a link to where rows come from */
  emptyAction?: ReactNode;
  initialSort?: SortingState;
  className?: string;
  /** max height with sticky header scroll (e.g. "calc(100vh - 240px)") */
  maxHeight?: string;
  rowClassName?: (row: T) => string | undefined;
  caption?: string;
  /** table-layout: fixed with explicit column widths — never scrolls horizontally, cells clip instead */
  fixedLayout?: boolean;
  /** Tighter horizontal cell padding for wide tables with many columns. */
  compact?: boolean;
  /** Skeleton rows shown while the first page loads. */
  skeletonRows?: number;
}

/**
 * Dense TanStack table: sticky header, click-to-sort, keyboard-activatable
 * rows (Enter / Space), loading / empty / error states built in.
 */
export function DataTable<T>({
  columns,
  data,
  isLoading,
  error,
  retry,
  onRowClick,
  getRowId,
  selectedIds,
  emptyTitle = 'No rows',
  emptyHint,
  emptyAction,
  initialSort = [],
  className,
  maxHeight,
  rowClassName,
  caption,
  fixedLayout = false,
  compact = false,
  skeletonRows = 6,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSort);
  const table = useReactTable({
    data: data ?? [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId,
  });

  const handleKey = (e: KeyboardEvent<HTMLTableRowElement>, row: Row<T>) => {
    if (!onRowClick) return;
    // Only when the row itself has focus: Space on an inner checkbox or Enter
    // on an inner link/button must keep its own behaviour.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick(row.original);
    }
  };

  const colCount = columns.length;
  const rows = table.getRowModel().rows;

  return (
    <div className={cn('overflow-auto rounded-[8px] border border-hairline bg-surface shadow-[var(--shadow-card)]', className)} style={maxHeight ? { maxHeight } : undefined}>
      <table className={cn('dt', fixedLayout && 'dt-fixed', compact && 'dt-compact')}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sorted = header.column.getIsSorted();
                const align = (header.column.columnDef.meta as DataTableColumnMeta | undefined)?.align;
                return (
                  <th
                    key={header.id}
                    style={{ width: fixedLayout || header.getSize() !== 150 ? header.getSize() : undefined }}
                    className={cn(align === 'right' && 'text-right')}
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                  >
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        className={cn(
                          // flex-wrap: when a column is squeezed the sort icon drops under the label
                          // instead of setting the column's minimum width
                          'inline-flex flex-wrap items-center gap-[3px] text-left uppercase tracking-[0.5px] hover:text-slate',
                          align === 'right' && 'flex-row-reverse',
                        )}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === 'asc' ? (
                          <ArrowUp size={12} aria-hidden />
                        ) : sorted === 'desc' ? (
                          <ArrowDown size={12} aria-hidden />
                        ) : (
                          <ChevronsUpDown size={12} className="opacity-40" aria-hidden />
                        )}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {isLoading ? (
            <SkeletonRows columns={colCount} rows={skeletonRows} />
          ) : error && rows.length === 0 ? (
            // a failed background refetch keeps the rows already on screen
            <tr>
              <td colSpan={colCount} className="wrap p-2">
                <ErrorState error={error} retry={retry} />
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="wrap">
                <EmptyState title={emptyTitle} hint={emptyHint} action={emptyAction} />
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const selected = selectedIds?.has(row.id) ?? false;
              return (
                <tr
                  key={row.id}
                  data-clickable={onRowClick ? 'true' : 'false'}
                  data-selected={selected ? 'true' : 'false'}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onKeyDown={(e) => handleKey(e, row)}
                  className={rowClassName?.(row.original)}
                  aria-selected={selectedIds ? selected : undefined}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta as DataTableColumnMeta | undefined;
                    return (
                      <td
                        key={cell.id}
                        className={cn(
                          meta?.align === 'right' && 'num',
                          cellWraps(meta, fixedLayout) && 'wrap',
                          meta?.mono && 'font-mono text-[12px]',
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
