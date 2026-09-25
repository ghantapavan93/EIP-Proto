import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { clearCredentials, setCredentials } from '../api/auth';
import { queryClient } from '../api/queryClient';
import { RUN_IDS } from '../mocks/server';
import type { CompareStatisticsOut, ConfusionOut, RuleVersionOut, TrendPointOut } from '../api/types';

/**
 * Depth round 2 screens against the mock API: "is this difference real?",
 * contract accuracy, readiness, the unusual rule statuses, the proposal
 * drawer's what-if, and the sandbox's contact-detail redactions.
 */

vi.stubEnv('VITE_MOCK', '1');
const { App } = await import('../App');
const { SignificancePanel } = await import('../components/runs/SignificancePanel');
const { ConfusionMatrix } = await import('../components/charts/ConfusionMatrix');
const { TrendChart } = await import('../components/charts/TrendChart');
const { Timeline, VersionTrack } = await import('../components/rules/Timeline');
const { RedactionTally } = await import('../components/sandbox/SandboxNotes');

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function openApp(path: string) {
  queryClient.clear();
  window.history.pushState({}, '', path);
  return render(<App />);
}

const rate = (k: number, n: number, lo: number, hi: number) => ({ k, n, rate: n ? k / n : null, ci_low: lo, ci_high: hi });

const STATS: CompareStatisticsOut = {
  mode: 'paired',
  alpha: 0.05,
  failure_definition: 'A cell fails when its outcome is FAIL or ERROR on a BLOCK contract.',
  cautions: ['Both runs are on the development calls; confirm on the held-out corpus.'],
  overall: {
    contract_code: 'ALL-BLOCK', severity: 'BLOCK', failure_outcomes: ['FAIL', 'ERROR'], n_shared: 60,
    paired: { both_pass: 38, a_only_fail: 17, b_only_fail: 2, both_fail: 3 },
    a: rate(20, 60, 0.22, 0.46), b: rate(5, 60, 0.04, 0.18), discordant: 19, test: 'McNemar exact (two-sided binomial on discordant pairs, p=0.5)',
    p_value: 0.00073, p_holm: null, significant: true, direction: 'better', verdict: 'B is significantly better on the release-blocking contracts (p=0.00073)', cautions: [],
  },
  per_contract: [
    {
      contract_code: 'C-FACT-01', severity: 'BLOCK', failure_outcomes: ['FAIL', 'ERROR'], n_shared: 60,
      paired: { both_pass: 57, a_only_fail: 0, b_only_fail: 3, both_fail: 0 }, a: rate(0, 60, 0, 0.06), b: rate(3, 60, 0.017, 0.137),
      discordant: 3, test: 'McNemar exact', p_value: 0.25, p_holm: 1, significant: false, direction: 'none', verdict: 'No significant difference (p=0.25, n=3 discordant pairs)',
      cautions: ['Only 3 call(s) changed outcome: too few changed calls to conclude.'],
    },
    {
      contract_code: 'C-TPMO-01', severity: 'BLOCK', failure_outcomes: ['FAIL', 'ERROR'], n_shared: 60,
      paired: { both_pass: 45, a_only_fail: 14, b_only_fail: 0, both_fail: 1 }, a: rate(15, 60, 0.15, 0.37), b: rate(1, 60, 0.003, 0.089),
      discordant: 14, test: 'McNemar exact', p_value: 0.00012, p_holm: 0.0011, significant: true, direction: 'better', verdict: 'B is significantly better on this contract (p=0.00012)', cautions: [],
    },
  ],
};

describe('SignificancePanel', () => {
  it('leads with ALL-BLOCK, speaks plainly, prints p and Holm in mono, and shows cautions', () => {
    wrap(<SignificancePanel stats={STATS} />);
    expect(screen.getByRole('heading', { name: 'Is this difference real?' })).toBeInTheDocument();
    const overall = screen.getByTestId('significance-overall');
    expect(within(overall).getByText('ALL-BLOCK')).toBeInTheDocument();
    expect(within(overall).getByText('B fails less often — unlikely to be chance')).toBeInTheDocument();
    // the paired 2×2: the 17 newly passing and 2 newly failing calls carry the evidence
    expect(within(overall).getByTitle('Newly passing: failed in A, passes in B')).toHaveTextContent('17');
    expect(within(overall).getByTitle('Newly failing: passed in A, fails in B')).toHaveTextContent('2');
    const fact = screen.getByTestId('significance-C-FACT-01');
    expect(within(fact).getByText('B fails more often, but the gap could be noise')).toBeInTheDocument();
    expect(within(fact).getByText('no significant difference')).toHaveAttribute('data-tone', 'neutral');
    expect(within(fact).getByText(/too few changed calls/)).toBeInTheDocument();
    const tpmo = screen.getByTestId('significance-C-TPMO-01');
    expect(within(tpmo).getByText('better')).toHaveAttribute('data-tone', 'green');
    expect(within(tpmo).getByText('p 0.00012')).toHaveClass('font-semibold');
    expect(within(tpmo).getByText('Holm 0.001')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'C-TPMO-01' })).toHaveAttribute('href', '/contracts/C-TPMO-01');
    expect(screen.getByText(/confirm on the held-out corpus/)).toBeInTheDocument();
    expect(screen.getByText(/A cell fails when its outcome is FAIL or ERROR on a BLOCK contract/)).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /Run B failure rate: 8\.3% \(95% CI/ }).length).toBeGreaterThan(0);
  });
});

describe('ConfusionMatrix and TrendChart', () => {
  const confusion: ConfusionOut = {
    unit: 'flagged phrase', positive: 'p', tp: 4, fp: 1, fn: 2, tn: null, not_applicable: 0, not_evaluated: 0, no_output: 0,
    precision: rate(4, 5, 0.38, 0.96), recall: rate(4, 6, 0.3, 0.9), miss_rate: rate(2, 6, 0.1, 0.7), f1: 0.73,
  };

  it('uses plain labels and says when true negatives cannot be counted', () => {
    wrap(<ConfusionMatrix confusion={confusion} />);
    expect(within(screen.getByTestId('cm-tp')).getByText('violations caught')).toBeInTheDocument();
    expect(within(screen.getByTestId('cm-fn')).getByText('violations missed')).toBeInTheDocument();
    expect(within(screen.getByTestId('cm-fp')).getByText('false alarms')).toBeInTheDocument();
    expect(within(screen.getByTestId('cm-tn')).getByText(/not countable per flagged phrase/)).toBeInTheDocument();
  });

  it('marks held-out runs with a hollow point and names each point for screen readers', () => {
    const p = (id: string, corpus: string, k: number): TrendPointOut => ({
      run_id: id, started_at: '2026-09-20T10:00:00Z', model_id: 'm', prompt_version: 2, corpus, rule_date: '2026-10-01', adapter: 'cassette', failure: rate(k, 60, 0.01, 0.2),
    });
    wrap(<TrendChart points={[p('a', 'synthetic', 5), p('b', 'holdout', 9)]} />);
    const points = screen.getAllByRole('button');
    expect(points).toHaveLength(2);
    expect(points[1]).toHaveAttribute('data-corpus', 'holdout');
    expect(points[1]).toHaveAccessibleName(/held-out/);
    expect(screen.getByText('held-out run')).toBeInTheDocument();
  });
});

describe('rule version statuses', () => {
  const v = (over: Partial<RuleVersionOut>): RuleVersionOut => ({
    id: `v${over.version}`, version: 1, status: 'in_force', clause_text: 'text', summary: '', effective_from: '2025-04-11', effective_to: null,
    change_classification: 'INITIAL', params: {}, disputed: false, dispute_note: '', source_url: '', git_commit: '', created_at: '', ...over,
  });
  const revocation = [
    v({ version: 1, deferrals: [{ provision: 'revoke-all', deferred_to: '2027-01-31', source: 'FCC order' }] }),
    v({ version: 2, status: 'proposed', effective_from: null, change_classification: 'REMOVES_REQUIREMENT', vote_date: '2026-09-30' }),
  ];

  it('puts an undated proposal beside the track as "awaiting vote" and a deferral on it', () => {
    wrap(<VersionTrack versions={revocation} inForceVersion={1} asOf="2026-09-25" />);
    expect(within(screen.getByTestId('track-undated')).getByText('awaiting vote Sep 30, 2026')).toBeInTheDocument();
    expect(screen.getAllByText('revoke-all lands').length).toBeGreaterThan(0);
  });

  it('strikes a vacated version, reads stayed amber, and boxes a proposal with its vote', () => {
    const { container } = wrap(
      <Timeline
        versions={[...revocation, v({ version: 3, status: 'vacated', effective_from: '2024-10-01' }), v({ version: 4, status: 'stayed', effective_from: '2026-11-01', change_classification: 'RESTORES_PRIOR' })]}
        inForceVersion={1}
        asOf="2026-09-25"
      />,
    );
    expect(screen.getByText('Court vacated — Backstop will not enforce this version.')).toBeInTheDocument();
    expect(container.querySelector('[data-status="vacated"] .line-through')).toHaveTextContent('v3');
    expect(screen.getByText('stayed').closest('[data-tone]')).toHaveAttribute('data-tone', 'amber');
    expect(screen.getByText('RESTORES PRIOR')).toBeInTheDocument();
    expect(screen.getByText('Not law yet — vote on Sep 30, 2026.')).toBeInTheDocument();
    expect(screen.getAllByText('revoke-all deferred to Jan 31, 2027').length).toBeGreaterThan(0);
  });
});

describe('RedactionTally', () => {
  it('shows every reported kind, zeros included, and nothing for kinds an older server omits', () => {
    const { rerender } = wrap(<RedactionTally counts={{ medicare_number: 0, ssn: 0, dob: 0, phone: 1, email: 0, address: 0 }} />);
    expect(screen.getByTestId('redacted-phone')).toHaveTextContent('1 phone number');
    expect(screen.getByTestId('redacted-email')).toHaveTextContent('0 email addresses');
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <RedactionTally counts={{ medicare_number: 1, ssn: 0, dob: 0 }} />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('redacted-phone')).toBeNull();
    expect(screen.getByText('Redacted before matching:')).toBeInTheDocument();
  });
});

describe('screens against the mock API', () => {
  beforeAll(() => setCredentials({ username: 'engineer', password: 'engineer' }));
  afterAll(() => clearCredentials());

  it('run compare opens with "Is this difference real?" above the cell lists', async () => {
    openApp(`/runs/compare?a=${RUN_IDS.ruleFlip}&b=${RUN_IDS.promptV2}`);
    expect(await screen.findByRole('heading', { name: 'Is this difference real?' }, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByTestId('significance-overall')).toHaveTextContent('B fails less often — unlikely to be chance');
    expect(screen.getByText(/per_contract a_fail\/b_fail count every non-PASS outcome/)).toBeInTheDocument();
  }, 20000);

  it('contract detail shows the matrix, the slices and the trend, and links back from the registry', async () => {
    openApp('/contracts');
    const link = await screen.findByRole('link', { name: 'C-TPMO-01' }, { timeout: 8000 });
    fireEvent.click(link);
    expect(await screen.findByText('violations caught', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByText('false alarms')).toBeInTheDocument();
    expect(screen.getByText('Where it fails')).toBeInTheDocument();
    expect(screen.getByLabelText('Findings')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Failure rate per run' })).toBeInTheDocument();
    const runPicker = screen.getByLabelText('Run (latest per model · prompt)') as HTMLSelectElement;
    expect(runPicker.options.length).toBe(3);
  }, 20000);

  it('readiness counts down, lists what flips, ranks owners and names what is not enforced', async () => {
    openApp('/readiness?as_of=2026-09-25');
    expect(await screen.findByText('Vacated — Backstop will not enforce', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByText('Proposed — not law yet')).toBeInTheDocument();
    expect(screen.getByText('To AEP — Annual Enrollment opens')).toBeInTheDocument();
    expect(within(screen.getByTestId('proposed-panel')).getByText('vote on Sep 30, 2026')).toBeInTheDocument();
    expect(within(screen.getByTestId('vacated-panel')).getAllByText('court vacated').length).toBe(2);
    expect(screen.getByRole('table', { name: 'Owner queues, oldest first' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /agent-broker-compensation v3/ }).length).toBeGreaterThan(0);
    // bands are disjoint: nothing in the mock applies 61–90 days out
    fireEvent.click(screen.getByRole('tab', { name: /61–90 days/ }));
    expect(screen.getByRole('tab', { name: /61–90 days/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Nothing flips in this window')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Readiness' })).toHaveAttribute('href', '/readiness');
  }, 20000);

  it('the rules list shows vacated, proposed and deferred provisions distinctly', async () => {
    openApp('/rules');
    expect(await screen.findByText('Revoke-all deferred to Jan 31, 2027', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getAllByText('vacated').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('· vote Sep 30, 2026')).toBeInTheDocument();
  }, 20000);

  it('the propose drawer has no status picker, says proposals never take effect, and opens a labelled what-if', async () => {
    openApp('/rules/soa-48h-wait?as_of=2026-10-01');
    fireEvent.click(await screen.findByRole('button', { name: /Propose version/ }, { timeout: 8000 }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Proposals never take effect from the UI')).toBeInTheDocument();
    expect(within(drawer).queryByRole('combobox', { name: 'Status' })).toBeNull();
    fireEvent.change(within(drawer).getByLabelText(/Clause text/), { target: { value: 'SOA at least 24 hours before the appointment.' } });
    fireEvent.change(within(drawer).getByLabelText(/Params/), { target: { value: '{"min_hours_between_soa_and_appointment": 24}' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Record proposal' }));
    const toggle = await within(drawer).findByRole('button', { name: 'What-if impact' }, { timeout: 8000 });
    fireEvent.click(toggle);
    const whatIf = await within(drawer).findByTestId('what-if-impact', {}, { timeout: 8000 });
    expect(within(whatIf).getByText('Hypothetical', { selector: '[data-tone]' })).toHaveAttribute('data-filled', 'true');
    expect(await within(whatIf).findByText(/If v3 were enacted/)).toBeInTheDocument();
    expect(await within(whatIf).findByText(/nothing was written/)).toBeInTheDocument();
  }, 25000);
});
