import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setCredentials, clearCredentials } from '../api/auth';
import { queryClient } from '../api/queryClient';
import { RUN_IDS } from '../mocks/server';

/**
 * Renders every screen against the in-memory mock API (VITE_MOCK=1) and waits
 * for a landmark string. Catches missing providers, bad hook wiring and
 * fixture/shape mismatches without a browser.
 */

vi.stubEnv('VITE_MOCK', '1');
const { App } = await import('../App');

const SCREENS: Array<[string, RegExp | string]> = [
  ['/', /5 over-restrictive · 0 under-restrictive · 2 re-verify/],
  ['/?status=rail', /golden cases/i],
  ['/rules', /Scope of Appointment — 48-hour waiting period/],
  ['/rules/soa-48h-wait?as_of=2026-10-01', /the standard expectation is 48 hours in advance/],
  ['/artifacts', /Attention scorecard item SC-12/],
  ['/artifacts/sc-12', /Edges — which rule versions/],
  ['/contracts', /Numeric claims must appear in the transcript/],
  ['/contracts/C-SOA-01', /violations caught/],
  ['/readiness', /Vacated — Backstop will not enforce/],
  ['/runs', /canary off band|off band/i],
  [`/runs/${RUN_IDS.ruleFlip}`, /Judge canary — six notes with known bands/],
  [`/runs/${RUN_IDS.ruleFlip}/transcripts/T017`, /C-TPMO-01/], // a failing call opens on its contracts
  [`/runs/${RUN_IDS.modelSwap}/transcripts/T018`, /not found in transcript/],
  [`/runs/compare?a=${RUN_IDS.ruleFlip}&b=${RUN_IDS.promptV2}`, /Prompt diff — v1 → v2/],
  [`/runs/compare?a=${RUN_IDS.promptV2}&b=${RUN_IDS.modelSwap}`, /Newly failing — passed in A/],
  ['/?card=model', /3 C-FACT-01/],
  ['/review', /Rule source changed/],
  ['/review?task=task-0001', /Rule diff — bound version vs in force/],
  ['/review?kind=RULE_SOURCE_CHANGED', /Rule source changed/],
  ['/review?lane=advisory', /advisory · not a ticket/],
  ['/review?lane=actionable', /Blocking failures by run and contract/],
  ['/evals', /Golden Matcher Suite · \d+ curated fixtures/],
  ['/models', /Qwen2.5 7B — local/],
  ['/test-cases', /A different person approves/],
  ['/try', /Try it with your own text/],
  ['/audit', /Verify chain/],
];

describe('smoke: every screen renders against the mock API', () => {
  beforeAll(() => setCredentials({ username: 'engineer', password: 'engineer' }));
  afterAll(() => clearCredentials());

  it.each(SCREENS)('%s', async (path, landmark) => {
    queryClient.clear();
    window.history.pushState({}, '', path);
    render(<App />);
    expect(await screen.findAllByText(landmark, {}, { timeout: 8000 })).not.toHaveLength(0);
    // the chrome is always there
    expect(screen.getAllByText('PROTOTYPE · SYNTHETIC DATA').length).toBeGreaterThan(0);
  }, 15000);

  it('redirects to /login when signed out', async () => {
    clearCredentials();
    queryClient.clear();
    window.history.pushState({}, '', '/rules');
    render(<App />);
    expect(await screen.findByText('Demo credentials')).toBeInTheDocument();
    setCredentials({ username: 'engineer', password: 'engineer' });
  });
});
