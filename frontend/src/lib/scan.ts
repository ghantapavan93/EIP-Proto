/**
 * Scan helpers shared by the Artifacts list and the artifact detail page.
 * POST /scans is idempotent on its key: a repeated key returns the earlier
 * scan with `deduplicated: true` and writes nothing new.
 */

import type { ScanOut } from '../api/types';
import type { Tone } from './vocab';
import { shortHash, todayIso } from './format';

/** The key used when the user leaves the field blank: one manual scan per day. */
export function defaultScanKey(now: Date = new Date()): string {
  return `${todayIso(now)}-manual`;
}

/** Trimmed user key, or the daily default. */
export function resolveScanKey(input: string | null | undefined, now: Date = new Date()): string {
  const key = (input ?? '').trim();
  return key || defaultScanKey(now);
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Toast copy that makes "new scan" and "deduplicated" impossible to confuse. */
export function scanToast(scan: ScanOut): { title: string; detail: string; tone: Tone } {
  const id = shortHash(scan.id, 8);
  if (scan.deduplicated) {
    return {
      title: `Deduplicated — key "${scan.idempotency_key}" already ran`,
      detail: `Returned existing scan ${id}; no new versions, edges or review tasks were written. Use a new idempotency key to scan again.`,
      tone: 'teal',
    };
  }
  const s = scan.stats;
  const parts = [
    `${count(s.new_versions)} new versions`,
    `${count(s.edges_new)} new edges`,
    `${count(s.proposed_new)} proposed`,
  ];
  const superseded = count(s.edges_superseded);
  if (superseded > 0) parts.push(`${superseded} superseded`);
  return {
    title: `New scan ${id} ${scan.status}`,
    detail: `key ${scan.idempotency_key} · ${parts.join(' · ')}`,
    tone: scan.status === 'failed' ? 'red' : 'green',
  };
}
