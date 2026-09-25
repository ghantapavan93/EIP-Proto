/**
 * Command palette model: plain navigation over already-known lists (rules,
 * artifacts, runs) plus a few fixed actions. Matching is a case-insensitive
 * substring over code / id / label — no ranking model, no AI.
 */

import type { EvidenceScope } from '../api/types';

/** window event the top bar dispatches to open the palette */
export const OPEN_PALETTE_EVENT = 'backstop:open-palette';

export type PaletteGroup = 'Actions' | 'Rules' | 'Artifacts' | 'Runs';

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  /** mono secondary text: code, id, date */
  hint?: string;
  /** extra searchable text */
  keywords?: string;
  /** navigate here… */
  to?: string;
  /** …or export evidence for the current page */
  evidence?: { scope: EvidenceScope; id: string; asOf?: string };
}

/** Evidence scope for the page at `pathname` + `search`, if it has one. */
export function evidenceForLocation(pathname: string, search: string): PaletteItem['evidence'] | null {
  const params = new URLSearchParams(search);
  const run = /^\/runs\/([^/]+)$/.exec(pathname);
  if (run && run[1] !== 'compare') return { scope: 'runs', id: decodeURIComponent(run[1]) };
  const rule = /^\/rules\/([^/]+)$/.exec(pathname);
  if (rule) return { scope: 'rules', id: decodeURIComponent(rule[1]), asOf: params.get('as_of') ?? undefined };
  const task = params.get('task');
  if (pathname === '/review' && task) return { scope: 'tasks', id: task };
  return null;
}

export function matchesQuery(item: PaletteItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  return q.split(/\s+/).every((part) => hay.includes(part));
}

/** Filter, keep group order, cap each list group so the palette stays short. */
export function filterPalette(items: PaletteItem[], query: string, perGroup = 6): PaletteItem[] {
  const order: PaletteGroup[] = ['Actions', 'Rules', 'Artifacts', 'Runs'];
  const out: PaletteItem[] = [];
  for (const group of order) {
    const hits = items.filter((i) => i.group === group && matchesQuery(i, query));
    out.push(...(group === 'Actions' ? hits : hits.slice(0, perGroup)));
  }
  return out;
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere — for keyboard hints such as "Ctrl ↵". */
export function modKeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad/i.test(platform) ? '⌘' : 'Ctrl';
}

/** Ctrl+Enter (⌘+Enter on a Mac): the "run it" chord in the sandbox. */
export function isSubmitChord(e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.key === 'Enter' && (e.ctrlKey || e.metaKey);
}
