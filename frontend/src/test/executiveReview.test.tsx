import { afterAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { clearCredentials, setCredentials } from '../api/auth';
import { queryClient } from '../api/queryClient';
import type { CompareStatisticsOut, ContractComparisonOut, RateOut, RuleVersionOut, TrendPointOut } from '../api/types';
import { SignificancePanel } from '../components/runs/SignificancePanel';
import { TrendChart } from '../components/charts/TrendChart';
import { nextChangeWithin } from '../lib/ruleVersions';

/**
 * What a senior reader notices on a first unassisted pass: a development-set win shown
 * above the held-out reversal, a "superseded" label on a version that has not started,
 * a trend chart over one instant, a rule page that opens before the change it is about.
 */

vi.stubEnv('VITE_MOCK', '1');
const { App } = await import('../App');

afterAll(() => clearCredentials());

const rate = (k: number, n: number): RateOut => ({ k, n, rate: k / n, ci_low: 0, ci_high: 1 });

function row(code: string, direction: string): ContractComparisonOut {
  return {
    contract_code: code, severity: 'BLOCK', failure_outcomes: ['FAIL', 'ERROR'], n_shared: 60, paired: null,
    a: rate(21, 60), b: rate(7, 60), discordant: 20, test: 'McNemar exact', p_value: 0.003, significant: true,
    direction, verdict: `B is significantly ${direction} on the release-blocking contracts (p=0.003)`, cautions: [],
  } as ContractComparisonOut;
}

describe('held-out result on the compare page', () => {
  const stats: CompareStatisticsOut = {
    mode: 'paired', alpha: 0.05, failure_definition: 'x', overall: row('ALL-BLOCK', 'better'), per_contract: [row('C-TPMO-01', 'better')],
    cautions: ['Held-out check: On the 60 held-out calls, prompt v3 is significantly worse than v2 on the release-blocking contracts (p=1.9e-06).', 'One generation per call.'],
    held_out: {
      a_run_id: 'hold-v2', b_run_id: 'hold-v3', a_prompt_version: 2, b_prompt_version: 3, direction: 'worse', p_value: 1.9e-6,
      summary: 'On the 60 held-out calls, prompt v3 is significantly worse than v2 on the release-blocking contracts (p=1.9e-06).',
      contradicts_development: true,
    },
  };

  it('comes before the development verdict, says it reverses it, and links the held-out runs', () => {
    render(<MemoryRouter><SignificancePanel stats={stats} /></MemoryRouter>);
    const banner = screen.getByRole('note', { name: 'Held-out check' });
    expect(within(banner).getByText('The held-out calls reverse this result.')).toBeInTheDocument();
    expect(within(banner).getByRole('link', { name: /Open held-out comparison/ })).toHaveAttribute('href', '/runs/compare?a=hold-v2&b=hold-v3');
    const verdict = screen.getByText(/B is significantly better on the release-blocking contracts/);
    expect(banner.compareDocumentPosition(verdict) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // shown once, as the banner, not repeated among the cautions
    expect(screen.getAllByText(/prompt v3 is significantly worse than v2/)).toHaveLength(1);
  });
});

describe('trend chart caption', () => {
  const point = (id: string, at: string): TrendPointOut => ({
    run_id: id, started_at: at, model_id: 'm', prompt_version: 2, corpus: 'synthetic', rule_date: '2026-10-01', adapter: 'cassette', failure: rate(5, 60),
  });

  it('does not present runs replayed together as a trend over time', () => {
    render(<TrendChart points={[point('a', '2026-09-25T07:29:50Z'), point('b', '2026-09-25T07:29:52Z')]} />);
    expect(screen.getByText(/2 runs in run order.*replayed together, not a trend over time/)).toBeInTheDocument();
  });

  it('keeps the date range when runs are spread over time', () => {
    render(<TrendChart points={[point('a', '2026-09-20T07:00:00Z'), point('b', '2026-09-25T07:00:00Z')]} />);
    expect(screen.queryByText(/replayed together/)).toBeNull();
  });
});

describe('rule page dates and labels', () => {
  const v = (version: number, from: string | null, status = 'in_force'): RuleVersionOut => ({ version, effective_from: from, status } as RuleVersionOut);

  it('opens on the next change only when it is under 30 days away and enacted', () => {
    const versions = [v(1, '2023-09-30'), v(2, '2026-10-01'), v(3, '2027-01-01', 'proposed')];
    expect(nextChangeWithin(versions, '2026-09-25', 30)).toBe('2026-10-01');
    expect(nextChangeWithin(versions, '2026-08-01', 30)).toBeNull();
    expect(nextChangeWithin(versions, '2026-10-01', 30)).toBeNull(); // the change is today, not upcoming
    expect(nextChangeWithin([v(1, '2023-09-30'), v(2, '2026-10-05', 'vacated')], '2026-09-25', 30)).toBeNull();
  });

  it('calls a prompt that declares the next version "ahead", not "superseded"', async () => {
    setCredentials({ username: 'engineer', password: 'engineer' });
    queryClient.clear();
    window.history.pushState({}, '', '/rules/soa-48h-wait?as_of=2026-09-30');
    render(<App />);
    expect(await screen.findByText(/ahead · not yet in force/, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByText('declares superseded version')).toBeNull();
  }, 15000);
});
