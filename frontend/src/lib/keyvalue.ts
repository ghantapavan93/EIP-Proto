import type { ReactNode } from 'react';

export interface KeyValueRow {
  key: string;
  value: ReactNode;
  /** render the value in the monospace stack (hashes, ids, timestamps) */
  mono?: boolean;
}

/** Render a JSON params object as key/value rows (nested values stringified). */
export function paramValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => paramValue(v)).join(', ');
  return JSON.stringify(value);
}

/** Keys starting with "_" are internal (fingerprints etc.) and hidden; arrays read as comma-joined text. */
export function paramsToRows(params: Record<string, unknown> | null | undefined): KeyValueRow[] {
  if (!params) return [];
  return Object.entries(params)
    .filter(([key]) => !key.startsWith('_'))
    .map(([key, value]) => ({
      key,
      value: paramValue(value),
      mono: true,
    }));
}
