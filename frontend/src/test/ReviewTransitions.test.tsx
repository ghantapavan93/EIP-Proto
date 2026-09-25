import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReviewTaskOut } from '../api/types';
import { ToastProvider } from '../components/ui/Toast';

// allowed_transitions arrives already filtered by the caller's role.
const task: ReviewTaskOut = {
  id: 'task-0100',
  kind: 'PROPOSED_EDGE',
  state: 'open',
  rule_code: 'tpmo-disclaimer-timing',
  rule_version: null,
  asset_code: null,
  asset_name: null,
  asset_type: null,
  asset_is_synthetic: null,
  edge_id: null,
  evidence_span: null,
  run_result_id: null,
  run_id: null,
  contract_code: null,
  transcript_code: null,
  staleness_direction: null,
  reason: 'Matcher proposed an edge.',
  assignee_role: 'QA Compliance Analyst',
  reason_code: null,
  note: '',
  decided_by: null,
  opened_at: '2026-09-19T15:33:02Z',
  closed_at: null,
  payload: {},
  allowed_transitions: [],
};

let current: ReviewTaskOut = task;

vi.mock('../api/hooks', () => ({
  useReviewTask: () => ({ data: current, isLoading: false, error: null, refetch: () => undefined }),
  useTransition: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
  useTestCases: () => ({ data: [] }),
  useExportEvidence: () => ({ mutate: vi.fn(), isPending: false }),
  useStatus: () => ({ data: undefined, isLoading: false }),
  useRule: () => ({ data: undefined, isLoading: false }),
  useRunResults: () => ({ data: [], isLoading: false, error: null }),
}));

import { TaskDrawer } from '../pages/Review';

function renderDrawer() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <MemoryRouter>
          <TaskDrawer taskId={current.id} onClose={() => undefined} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('TaskDrawer with role-filtered transitions', () => {
  it('says "not for your role" when an open task has no transitions for this user', () => {
    current = { ...task, state: 'open', allowed_transitions: [] };
    renderDrawer();
    expect(screen.getByText(/No transitions available for your role/)).toBeInTheDocument();
    expect(screen.queryByText(/is terminal/)).toBeNull();
  });

  it('says the state is terminal, not a role problem, for a closed task', () => {
    current = { ...task, state: 'dismissed', allowed_transitions: [] };
    renderDrawer();
    expect(screen.getByText(/is terminal — no further transitions/)).toBeInTheDocument();
    expect(screen.queryByText(/for your role/)).toBeNull();
  });

  it('renders exactly the transitions the server allowed', () => {
    current = { ...task, state: 'open', allowed_transitions: ['in_review'] };
    renderDrawer();
    expect(screen.getByRole('button', { name: '→ in review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '→ dismissed' })).toBeNull();
    expect(screen.queryByText(/No transitions available/)).toBeNull();
  });
});
