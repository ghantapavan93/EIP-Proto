import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ReviewTaskOut, RuleVersionOut, StatusOut } from '../api/types';
import type * as ClientModule from '../api/client';

const downloadWithMeta = vi.fn();
vi.mock('../api/client', async (importOriginal) => {
  const real = await importOriginal<typeof ClientModule>();
  return { ...real, downloadWithMeta: (...args: unknown[]) => downloadWithMeta(...args) };
});

const { StatusRail, SystemPulse } = await import('../components/layout/StatusRail');
const { ComponentList } = await import('../components/layout/HealthPopover');
const { EvidenceExport } = await import('../components/evidence/EvidenceExport');
const { Timeline } = await import('../components/rules/Timeline');
const { ActorCell } = await import('../pages/Audit');
const { SkeletonRows } = await import('../components/ui/Skeleton');
const { ToastProvider } = await import('../components/ui/Toast');
const { TickNumber } = await import('../components/ui/TickNumber');

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const STATUS: StatusOut = {
  status: 'healthy',
  components: [
    { name: 'api', state: 'healthy', detail: 'backstop 0.1.0', required: true },
    { name: 'database', state: 'healthy', detail: 'PostgreSQL', required: true },
    { name: 'ollama', state: 'offline', detail: 'not reachable — recorded cassettes still replay', required: false },
  ],
  counts: { rules: 7, artifacts: 21, contracts: 8, golden_cases: 37, transcripts: 60 },
  last_run: { id: 'run-1', finished_at: new Date(Date.now() - 120_000).toISOString(), gate: 'RED', status: 'COMPLETE', model_id: 'ollama/qwen2.5:3b', prompt_version: 2, trigger: 'MODEL' },
  review: { actionable_open: 12, advisory_open: 3 },
  audit_chain: { verified: true, rows: 114 },
  user: { name: 'engineer', role: 'engineer' },
  environment_label: 'PROTOTYPE · SYNTHETIC DATA',
};

function flagged(id: string, run: string, contract: string): ReviewTaskOut {
  return {
    id, kind: 'FLAGGED_RESULT', state: 'open', rule_code: null, rule_version: null, asset_code: null, asset_name: null, asset_type: null,
    asset_is_synthetic: null, edge_id: null, evidence_span: null, run_result_id: null, run_id: run, contract_code: contract, transcript_code: 'T1',
    staleness_direction: null, reason: '', assignee_role: 'compliance', reason_code: null, note: '', decided_by: null, opened_at: '2026-09-23T07:00:00Z',
    closed_at: null, payload: {}, allowed_transitions: [], lane: 'actionable',
  };
}

afterEach(() => {
  downloadWithMeta.mockReset();
});

describe('StatusRail', () => {
  it('shows live counts, last run and the review breakdown from real state', () => {
    const tasks = [flagged('a', 'r1', 'C-TPMO-01'), flagged('b', 'r1', 'C-TPMO-01'), flagged('c', 'r2', 'C-SOA-01'), { ...flagged('d', 'r1', 'x'), kind: 'STALE_ASSET' }];
    wrap(
      <>
        <SystemPulse status={STATUS} />
        <StatusRail status={STATUS} openTasks={tasks} />
      </>,
    );
    // health word and last run live in the top bar's system-state group
    const pulse = screen.getByRole('group', { name: 'System state' });
    expect(within(pulse).getByRole('button', { name: /healthy/i })).toBeInTheDocument();
    expect(within(pulse).getByText('2m ago')).toBeInTheDocument();
    expect(within(pulse).getByRole('link', { name: /last run/i })).toHaveAttribute('href', '/runs/run-1');
    expect(within(pulse).getByText('RED')).toHaveAttribute('data-filled', 'false');
    // counts live in the compact rail beneath
    const rail = screen.getByRole('region', { name: 'System status' });
    expect(within(rail).getByRole('link', { name: /7\s*rules/i })).toHaveAttribute('href', '/rules');
    expect(within(rail).getByRole('link', { name: /37\s*golden cases/i })).toHaveAttribute('href', '/evals');
    const review = within(rail).getByRole('link', { name: /12\s*actionable/i });
    expect(review).toHaveTextContent('(2 groups · 1 task)');
    // amber only on the review chip; the count itself is neutral
    expect(within(review).getByText('review')).toHaveAttribute('data-tone', 'amber');
  });

  it('says so when /status fails instead of showing stale numbers', () => {
    wrap(<StatusRail status={undefined} error={new Error('503 down')} />);
    expect(screen.getByText(/status unavailable — 503 down/)).toBeInTheDocument();
  });
});

describe('health components', () => {
  it('lists every component and marks optional ones', () => {
    wrap(<ComponentList components={STATUS.components} />);
    expect(screen.getByText('Postgres')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByText('· optional')).toBeInTheDocument();
  });
});

describe('EvidenceExport', () => {
  it('previews the bundle in a drawer, downloads it and shows the first 12 chars of its sha256', async () => {
    downloadWithMeta.mockResolvedValue({ name: 'backstop-evidence-run-abc.json', sha256: 'a1b2c3d4e5f6a7b8c9d0' });
    wrap(<EvidenceExport scope="runs" id="run-1" preview={[{ label: 'Run', value: 'run-1 · gate RED', mono: true }]} />);
    // the button opens a preview drawer first; nothing downloads until a format is chosen
    fireEvent.click(screen.getByRole('button', { name: /Export evidence/ }));
    const drawer = screen.getByRole('dialog', { name: 'Evidence bundle' });
    expect(within(drawer).getByText('run-1 · gate RED')).toBeInTheDocument();
    expect(downloadWithMeta).not.toHaveBeenCalled();
    fireEvent.click(within(drawer).getByRole('button', { name: /Download JSON/ }));
    expect(await screen.findByText('Evidence bundle exported · sha256 a1b2c3d4e5f6')).toBeInTheDocument();
    expect(downloadWithMeta).toHaveBeenCalledWith('/evidence/runs/run-1?format=json', expect.stringContaining('.json'));
    // the drawer keeps the short bundle hash so the file can be matched to its audit row
    expect(within(drawer).getByRole('status')).toHaveTextContent('bundle sha256 a1b2c3d4e5f6');
  });

  it('passes as_of for rule bundles and reports failures', async () => {
    downloadWithMeta.mockRejectedValue(new Error('404 rule not found'));
    wrap(<EvidenceExport scope="rules" id="soa-48h-wait" asOf="2026-10-01" />);
    fireEvent.click(screen.getByRole('button', { name: /Export evidence/ }));
    fireEvent.click(screen.getByRole('button', { name: /Download Markdown/ }));
    expect(await screen.findByText('Evidence export failed')).toBeInTheDocument();
    expect(downloadWithMeta).toHaveBeenCalledWith('/evidence/rules/soa-48h-wait?format=md&as_of=2026-10-01', expect.any(String));
  });
});

describe('Timeline provenance', () => {
  const v: RuleVersionOut = {
    id: 'v2', version: 2, status: 'in_force', clause_text: 'Retention 6 years.', summary: 'Six years', effective_from: '2026-10-01', effective_to: null,
    regulation_effective: '2026-06-01', change_classification: 'LOOSENS', params: {}, disputed: true, dispute_note: 'Whether enrollment calls fall under 422.504(d).',
    source_url: '', git_commit: '', created_at: '2026-09-01T00:00:00Z',
    sources: [
      { authority: 'secondary', cite: 'Law firm alert', url: 'https://example.com/a', reading: 'Commentary.' },
      { authority: 'primary', cite: '42 CFR 422.2274(g)(2)(ii)', url: 'https://www.ecfr.gov/x', reading: 'Six years.' },
    ],
  };

  it('labels applies-from and regulation-effective, ranks sources and frames disputes as an open question', () => {
    wrap(<Timeline versions={[v]} inForceVersion={2} asOf="2026-10-01" />);
    expect(screen.getByText('Applies from')).toBeInTheDocument();
    expect(screen.getByText('Regulation effective')).toBeInTheDocument();
    expect(screen.getByText('Jun 01, 2026')).toBeInTheDocument();
    const labels = screen.getAllByText(/Primary authority|Secondary interpretation/).map((n) => n.textContent);
    expect(labels).toEqual(['Primary authority', 'Secondary interpretation']);
    expect(screen.getByRole('link', { name: /42 CFR 422\.2274/ })).toHaveAttribute('href', 'https://www.ecfr.gov/x');
    expect(screen.getByText(/Open question · counsel review/)).toBeInTheDocument();
    expect(screen.getByText(v.dispute_note)).toBeInTheDocument();
  });
});

describe('audit actor chip and skeletons', () => {
  it('styles automation as system and people by role', () => {
    const { rerender } = wrap(<ActorCell row={{ actor: 'system:scanner', actor_role: 'system' }} />);
    expect(screen.getByText('Scanner')).toBeInTheDocument();
    expect(screen.getByText('system')).toHaveAttribute('data-tone', 'teal');
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ActorCell row={{ actor: 'analyst', actor_role: 'analyst' }} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('analyst', { selector: '[data-tone]' })).toHaveAttribute('data-tone', 'slate');
  });

  it('renders one status and N skeleton rows across the real column count', () => {
    render(
      <table>
        <tbody>
          <SkeletonRows columns={4} rows={3} />
        </tbody>
      </table>,
    );
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(3);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getAllByTestId('skeleton-row')[0].querySelectorAll('td')).toHaveLength(4);
  });
});

describe('TickNumber under reduced motion', () => {
  it('shows the new value at once', () => {
    const mm = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('matchMedia', mm);
    const { rerender } = render(<TickNumber value={0} delayMs={120} />);
    rerender(<TickNumber value={7} delayMs={120} />);
    expect(screen.getByText('7')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
