import type { TestCaseOut } from '../api/types';

/** A test case the demo seed created (payload/expected carries seeded_example: true, or a demo-seed:* author). */
export function isSeededExample(tc: Pick<TestCaseOut, 'expected' | 'created_by'>): boolean {
  return tc.expected.seeded_example === true || tc.created_by.startsWith('demo-seed:');
}

/** Who may approve a pending test case: an engineer or admin other than its author. */
export function whoCanApprove(tc: Pick<TestCaseOut, 'created_by' | 'status'>): string {
  if (tc.status !== 'PENDING_APPROVAL') return '';
  return `awaiting an engineer or admin other than ${tc.created_by}`;
}
