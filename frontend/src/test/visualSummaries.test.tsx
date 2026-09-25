import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CompareOut, RunOut } from '../api/types';
import { OutcomeBar } from '../components/charts/OutcomeBar';
import { ChangeMatrix } from '../components/charts/ChangeMatrix';
import { sumOutcomes } from '../lib/runStats';

describe('outcome bar', () => {
  it('sums stats.contracts and states every count in its accessible name', () => {
    const totals = sumOutcomes({
      'C-SOA-01': { PASS: 50, FAIL: 5, FLAG: 0, ERROR: 0 },
      'J-COACH-01': { PASS: 40, FAIL: 0, FLAG: 3, ERROR: 2 },
    });
    expect(totals).toEqual({ PASS: 90, FAIL: 5, FLAG: 3, ERROR: 2, total: 100 });
    render(<OutcomeBar counts={totals!} />);
    expect(screen.getByRole('img')).toHaveAccessibleName('90 pass · 5 fail · 3 flag · 2 error of 100 contract results');
  });

  it('draws nothing when a run carries no per-contract stats', () => {
    expect(sumOutcomes(undefined)).toBeNull();
    expect(sumOutcomes({})).toBeNull();
  });
});

describe('change matrix', () => {
  const run = (id: string) => ({ id }) as RunOut;
  const compare = {
    a: run('run-a'),
    b: run('run-b'),
    what_changed: {},
    newly_failing: [
      { transcript_code: 'T004', contract_code: 'C-SOA-01', a: 'PASS', b: 'FAIL' },
      { transcript_code: 'T010', contract_code: 'C-SUP-01', a: 'PASS', b: 'FLAG' },
    ],
    newly_passing: [{ transcript_code: 'T004', contract_code: 'C-SUP-01', a: 'FAIL', b: 'PASS' }],
    unchanged_failing: 0,
    unchanged_passing: 10,
    per_contract: [
      { contract_code: 'C-SOA-01', a_fail: 0, b_fail: 1, newly_failing: 1, newly_passing: 0 },
      { contract_code: 'C-SUP-01', a_fail: 1, b_fail: 1, newly_failing: 1, newly_passing: 1 },
      { contract_code: 'C-PII-01', a_fail: 0, b_fail: 0, newly_failing: 0, newly_passing: 0 },
    ],
  } as CompareOut;

  it('colours only cells in the delta lists and links each to the call in run B', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ChangeMatrix compare={compare} runB="run-b" />
      </MemoryRouter>,
    );
    // 3 contracts × 2 moved calls; only the 3 delta cells are links
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(screen.getByRole('link', { name: /T004 · C-SOA-01: PASS → FAIL \(newly failing\)/ })).toHaveAttribute('href', '/runs/run-b/transcripts/T004');
    expect(screen.getByRole('link', { name: /T004 · C-SUP-01: FAIL → PASS \(newly passing\)/ })).toHaveAttribute('href', '/runs/run-b/transcripts/T004');
    expect(screen.getByRole('rowheader', { name: 'C-PII-01' })).toBeInTheDocument();
  });

  it('renders nothing when no cell moved', () => {
    const { container } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ChangeMatrix compare={{ ...compare, newly_failing: [], newly_passing: [] }} runB="run-b" />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
