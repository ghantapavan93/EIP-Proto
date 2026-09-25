import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReviewTaskOut } from '../api/types';
import { ToastProvider } from '../components/ui/Toast';

const task: ReviewTaskOut = {
  id: 'task-0042',
  kind: 'FLAGGED_RESULT',
  state: 'in_review',
  rule_code: 'tpmo-disclaimer-timing',
  rule_version: null,
  asset_code: null,
  asset_name: null,
  asset_type: null,
  asset_is_synthetic: null,
  edge_id: null,
  evidence_span: null,
  run_result_id: 'run-0002-r010',
  run_id: 'run-0002',
  contract_code: 'C-TPMO-01',
  transcript_code: 'T-007',
  staleness_direction: null,
  reason: 'Prompt judged on timer 60s but ordering is in force.',
  assignee_role: 'QA Compliance Analyst',
  reason_code: null,
  note: '',
  decided_by: null,
  opened_at: '2026-09-19T15:33:02Z',
  closed_at: null,
  payload: { run_id: 'run-0002', contract: 'C-TPMO-01', severity: 'BLOCK', transcript_id: 'transcript-T-007' },
  allowed_transitions: ['upheld', 'overridden'],
};

const result = {
  id: 'run-0002-r010',
  transcript_code: 'T-007',
  contract_code: 'C-TPMO-01',
  severity: 'BLOCK',
  outcome: 'FAIL',
  evidence: { expected: true, got: false, truth_basis: 'ordering: delivered at 45s, benefits at 30s', model_basis: 'timer: delivered at 45s, window 60s', rule_logic: { basis: 'ordering', window_seconds: 0 }, direction: 'under_restrictive (missed violation)' },
  latency_ms: 4,
};

vi.mock('../api/hooks', () => ({
  useReviewTask: () => ({ data: task, isLoading: false, error: null, refetch: () => undefined }),
  useTransition: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
  useTestCases: () => ({ data: [] }),
  useExportEvidence: () => ({ mutate: vi.fn(), isPending: false }),
  useStatus: () => ({ data: undefined, isLoading: false }),
  useRule: () => ({ data: undefined, isLoading: false }),
  useRunResults: () => ({ data: [result], isLoading: false, error: null }),
}));

import { TaskDrawer } from '../pages/Review';

function renderDrawer() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <TaskDrawer taskId="task-0042" onClose={() => undefined} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('TaskDrawer transitions', () => {
  it('renders one button per allowed transition and nothing for disallowed states', () => {
    renderDrawer();
    expect(screen.getByRole('button', { name: '→ upheld' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '→ overridden' })).toBeInTheDocument();
    // in_review → verified / republished / dismissed are not legal for FLAGGED_RESULT
    expect(screen.queryByRole('button', { name: '→ verified' })).toBeNull();
    expect(screen.queryByRole('button', { name: '→ republished' })).toBeNull();
    expect(screen.queryByRole('button', { name: '→ dismissed' })).toBeNull();
  });

  it('fetches the flagged result from the run and shows expected vs got with both bases', () => {
    renderDrawer();
    // expected true → "compliant", got false → "violation"
    expect(screen.getByText('compliant')).toBeInTheDocument();
    expect(screen.getByText('violation')).toBeInTheDocument();
    expect(screen.getByText('ordering: delivered at 45s, benefits at 30s')).toBeInTheDocument();
    expect(screen.getByText('timer: delivered at 45s, window 60s')).toBeInTheDocument();
    expect(screen.getAllByText('C-TPMO-01').length).toBeGreaterThan(0);
    expect(screen.getByRole('dialog')).toHaveAccessibleName(/task-004/);
  });
});
