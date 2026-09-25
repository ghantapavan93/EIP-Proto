import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EvidenceBlock } from '../components/evidence/EvidenceBlock';
import { evidenceFamily, evidenceSummary } from '../lib/evidence';
import { splitTranscript } from '../lib/transcript';
import { versionStatusAsOf } from '../lib/ruleVersions';
import { paramsToRows } from '../lib/keyvalue';
import { runStats, costLabel } from '../lib/runStats';

describe('evidence families (live API shapes)', () => {
  it('classifies each contract family by its keys', () => {
    expect(evidenceFamily('C-TPMO-01', { expected: true, got: false, truth_basis: 'ordering: …', model_basis: 'timer: …', rule_logic: {} })).toBe('rule');
    expect(evidenceFamily('C-SPAN-01', { not_in_transcript: { benefits_span: '…' }, checked: 3 })).toBe('span');
    expect(evidenceFamily('C-FACT-01', { invented_figures: ['$4710'], summary_figures: ['$4710'], transcript_figures: ['$140'] })).toBe('fact');
    expect(evidenceFamily('C-PII-01', { pii_in_output: { medicare_number: ['1XX9-XX5-XX56'] } })).toBe('pii');
    expect(evidenceFamily('C-SCHEMA-01', { error: 'truncated', raw_keys: ['extraction'] })).toBe('schema');
    expect(evidenceFamily('C-SUP-01', { expected_flags: [], got_flags: ['the best plan'], substantiation_required: false })).toBe('superlative');
    expect(evidenceFamily('J-COACH-01', { scores: [1, 2], n: 5, mean: 1.5, variance: 0.1, threshold: 3, judge: { judge_model: 'sim-small' }, advisory: true })).toBe('judge');
    expect(evidenceFamily('C-TPMO-01', { error: 'no ground truth', model_says: true })).toBe('no-truth');
  });

  it('summarizes evidence in one line', () => {
    expect(evidenceSummary('C-FACT-01', { invented_figures: ['$4710'], summary_figures: ['$4710'], transcript_figures: ['$140', '$30'] })).toBe('invented $4710 · transcript has $140, $30');
    expect(evidenceSummary('C-SPAN-01', { checked: 3 })).toBe('3 spans verbatim');
    expect(evidenceSummary('C-TPMO-01', { expected: true, got: false, truth_basis: 'ordering: a', model_basis: 'timer: b', direction: 'over_restrictive (false flag)' })).toBe(
      'expected compliant · got violation · over_restrictive (false flag) · truth: ordering: a · model: timer: b',
    );
  });

  it('renders C-SPAN-01 not-found spans in red with the label and C-FACT-01 invented figures as red chips', () => {
    render(
      <MemoryRouter>
        <EvidenceBlock result={{ contract_code: 'C-SPAN-01', severity: 'BLOCK', outcome: 'FAIL', latency_ms: 1, evidence: { not_in_transcript: { benefits_span: 'The Cigna plan has a $45 premium per month.' }, checked: 3 } }} />
        <EvidenceBlock result={{ contract_code: 'C-FACT-01', severity: 'BLOCK', outcome: 'FAIL', latency_ms: 1, evidence: { invented_figures: ['$4710'], summary_figures: ['$4710'], transcript_figures: ['$140', '$30', '$4700'] } }} />
      </MemoryRouter>,
    );
    const label = screen.getByText('benefits_span');
    expect(label).toHaveAttribute('data-tone', 'red');
    expect(screen.getByText('The Cigna plan has a $45 premium per month.').className).toContain('mark-span-unverified');
    expect(screen.getByText('not found in transcript')).toBeInTheDocument();
    const invented = screen.getAllByText('$4710');
    expect(invented.some((el) => el.getAttribute('data-tone') === 'red')).toBe(true);
    expect(screen.getByText('$4700')).toHaveAttribute('data-tone', 'green');
  });
});

describe('transcript splitting', () => {
  it('splits newline-separated [mm:ss] lines and inline [hh:mm:ss] exports, keeping span offsets', () => {
    const synthetic = '[00:00] AGENT: Hello there.\n[00:06] CUSTOMER: Hi.';
    const a = splitTranscript(synthetic, [{ label: 'x', text: 'Hello', offset: 15, length: 5, verified: true }]);
    expect(a.map((l) => l.speaker)).toEqual(['AGENT', 'CUSTOMER']);
    expect(a[0].body).toBe('Hello there.');
    expect(a[0].spans[0]).toMatchObject({ offset: 0, length: 5 });

    const ingested = '[00:00:00] AGENT: Thanks for calling. [00:00:06] CUSTOMER: Hi, plans please. [00:00:12] AGENT: Sure.';
    const b = splitTranscript(ingested, [{ label: 'y', text: 'plans', offset: ingested.indexOf('plans'), length: 5, verified: true }]);
    expect(b).toHaveLength(3);
    expect(b[1].body).toBe('Hi, plans please.');
    expect(b[1].spans[0]).toMatchObject({ offset: 4, length: 5 });
    expect(b[0].spans).toHaveLength(0);
  });
});

describe('rule version status and params', () => {
  const v1 = { id: 'a', version: 1, status: 'in_force', clause_text: '', summary: '', effective_from: '2023-09-30', effective_to: '2026-09-30', change_classification: 'INITIAL', params: { window_seconds: 60, exceptions: ['walk_in', 'last_four_days'], _fingerprint: 'abc' }, disputed: false, dispute_note: '', source_url: '', git_commit: '', created_at: '' };
  const v2 = { ...v1, id: 'b', version: 2, effective_from: '2026-10-01', effective_to: null };
  it('reads SUPERSEDED for a window that ended before as_of and IN FORCE only for the containing window', () => {
    expect(versionStatusAsOf(v1, '2026-10-01', 2)).toBe('superseded');
    expect(versionStatusAsOf(v2, '2026-10-01', 2)).toBe('in_force_as_of');
    expect(versionStatusAsOf(v2, '2026-09-30', 1)).toBe('future');
    expect(versionStatusAsOf(v1, '2026-09-30', 1)).toBe('in_force_as_of');
  });
  it('hides _-prefixed params and joins arrays', () => {
    const rows = paramsToRows(v1.params);
    expect(rows.map((r) => r.key)).toEqual(['window_seconds', 'exceptions']);
    expect(rows[1].value).toBe('walk_in, last_four_days');
  });
});

describe('run stats narrowing', () => {
  it('reads cost and judge stability from the live stats shape', () => {
    const s = runStats({ stats: { cost: { usd: 0, basis: 'simulated adapter — no model calls', per_call_usd: 0, projection: { calls_per_day: 3000, usd_per_day: 0, usd_per_aep: 0 } }, judge_stability: { notes: [{ id: 'c', band: [1, 2.6], scores: [1, 2], mean: 1.5, variance: 0.25, in_band: true }], n_per_note: 5, out_of_band: 0, mean_variance: 0.1, stable: true, note: 'n' }, latency_ms_per_transcript: 1126 } });
    expect(costLabel(s.cost)).toBe('$0.00 · simulated');
    expect(s.judge_stability?.stable).toBe(true);
    expect(s.judge_stability?.notes[0].band).toEqual([1, 2.6]);
    expect(s.latency_ms_per_transcript).toBe(1126);
    expect(runStats({ stats: {} }).cost).toBeUndefined();
  });
});
