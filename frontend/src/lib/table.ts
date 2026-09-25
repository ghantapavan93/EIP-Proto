/** Column rules for components/DataTable (kept out of the component file for fast refresh). */

/**
 * Per-column options read from `columnDef.meta`.
 * - align: 'right' → numeric cell (right-aligned, tabular, never wraps)
 * - mono → monospace id/hash/timestamp cell (never wraps)
 * - wrap → force wrapping on (or `false` to force it off)
 * - nowrap → keep a text column on one line (short labels, timestamps)
 */
export interface DataTableColumnMeta {
  align?: 'right';
  wrap?: boolean;
  nowrap?: boolean;
  mono?: boolean;
}

/**
 * Whether a body cell may wrap. In the default (auto) layout, text columns
 * wrap so the table fits its container instead of scrolling sideways; ids,
 * numbers and explicitly `nowrap` columns stay on one line. Fixed-layout
 * tables keep the old clip-with-ellipsis behaviour unless a column opts in.
 */
export function cellWraps(meta: DataTableColumnMeta | undefined, fixedLayout: boolean): boolean {
  if (meta?.wrap !== undefined) return meta.wrap;
  if (fixedLayout) return false;
  return !meta?.mono && meta?.align !== 'right' && !meta?.nowrap;
}
