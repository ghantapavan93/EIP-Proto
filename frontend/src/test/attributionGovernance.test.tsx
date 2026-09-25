import { afterAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearCredentials, setCredentials } from '../api/auth';
import { queryClient } from '../api/queryClient';
import { mockRequest, RUN_IDS } from '../mocks/server';
import { ApiError } from '../api/errors';
import type { AccessReviewOut, AuditCheckpointOut, AuditVerifyOut, CompareOut, RunOut } from '../api/types';
import { attributeRuns } from '../lib/attribution';

/**
 * The two answers a technical reviewer asked for:
 * - "same prompt, different model — what changed?": every comparison says whether
 *   exactly one thing moved, and a confounded one links the clean comparisons;
 * - "what can each role actually do?": admins govern (access review, corpus
 *   adoption, audit checkpoints), and the refusals are enforced, not cosmetic.
 */

vi.stubEnv('VITE_MOCK', '1');
const { App } = await import('../App');

const analyst = { username: 'analyst', password: 'analyst' };
const engineer = { username: 'engineer', password: 'engineer' };
const admin = { username: 'admin', password: 'admin' };

function open(path: string, user: string) {
  setCredentials({ username: user, password: user });
  queryClient.clear();
  window.history.pushState({}, '', path);
  return render(<App />);
}

afterAll(() => clearCredentials());

function run(id: string, over: Partial<RunOut> = {}): RunOut {
  return {
    id,
    prompt_hash: 'p1',
    prompt_version: 1,
    model_id: 'sim-large',
    adapter: 'simulated',
    rule_date: '2026-09-30',
    corpus_hash: 'c1',
    contract_set_hash: 'k1k1k1k1k1',
    status: 'COMPLETE',
    stats: {},
    ...over,
  } as RunOut;
}

describe('attribution (lib, same rules as the backend)', () => {
  it('calls a single change isolated and lists what was held constant', () => {
    const out = attributeRuns(run('a'), run('b', { model_id: 'sim-small' }));
    expect(out.verdict).toBe('isolated');
    expect(out.changed.map((c) => c.factor)).toEqual(['model']);
    expect(out.held_constant).toContain('prompt');
    expect(out.summary).toMatch(/^Only the model changed/);
  });

  it('decomposes a confounded jump into existing one-change steps', () => {
    const a = run('a');
    const s1 = run('s1', { rule_date: '2026-10-01' });
    const s2 = run('s2', { rule_date: '2026-10-01', prompt_hash: 'p2', prompt_version: 2 });
    const b = run('b', { rule_date: '2026-10-01', prompt_hash: 'p2', prompt_version: 2, model_id: 'sim-small' });
    const out = attributeRuns(a, b, [s2, s1]);
    expect(out.verdict).toBe('confounded');
    expect(Object.fromEntries(out.isolating_pairs.map((p) => [p.factor, [p.a_run_id, p.b_run_id]]))).toEqual({
      prompt: ['s1', 's2'],
      model: ['s2', 'b'],
      rule_date: ['a', 's1'],
    });
  });

  it('does not count overrides that follow from a different set of calls as a second change', () => {
    const out = attributeRuns(run('a'), run('b', { corpus_hash: 'c2', stats: { test_cases: { in_scope: 1 } } }));
    expect(out.verdict).toBe('isolated');
    expect(out.changed.map((c) => c.factor)).toEqual(['corpus']);
  });
});

describe('attribution (mock API and Compare screen)', () => {
  it('marks the demo chain: each step isolated, the whole jump confounded with links to every step', async () => {
    const step = (await mockRequest('GET', `/runs/compare?a=${RUN_IDS.ruleFlip}&b=${RUN_IDS.promptV2}`, undefined, analyst)) as CompareOut;
    expect(step.attribution?.verdict).toBe('isolated');
    const jump = (await mockRequest('GET', `/runs/compare?a=${RUN_IDS.baseline}&b=${RUN_IDS.modelSwap}`, undefined, analyst)) as CompareOut;
    expect(jump.attribution?.verdict).toBe('confounded');
    expect(new Set(jump.attribution?.isolating_pairs.map((p) => p.factor))).toEqual(new Set(['prompt', 'model', 'rule_date']));
  });

  it('shows the verdict and the clean comparisons on /runs/compare', async () => {
    open(`/runs/compare?a=${RUN_IDS.baseline}&b=${RUN_IDS.modelSwap}`, 'analyst');
    const panel = await screen.findByRole('region', { name: 'Attribution' }, { timeout: 8000 });
    expect(within(panel).getByText('Confounded')).toBeInTheDocument();
    const links = within(within(panel).getByRole('list', { name: 'Isolating comparisons' })).getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links.every((l) => l.getAttribute('href')?.startsWith('/runs/compare?a='))).toBe(true);
  }, 15000);
});

describe('governance (admin)', () => {
  it('refuses every governance endpoint to analysts and engineers, and logs the refusal', async () => {
    for (const who of [analyst, engineer]) {
      for (const [method, path] of [['GET', '/admin/access'], ['POST', '/admin/audit-checkpoints'], ['POST', '/rules/reload']] as const) {
        const err = await mockRequest(method, path, undefined, who).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(403);
      }
    }
    const review = (await mockRequest('GET', '/admin/access', undefined, admin)) as AccessReviewOut;
    expect(review.recent_denied.some((d) => d.actor === 'engineer' && d.kind === 'insufficient_role')).toBe(true);
    expect(review.accounts.every((a) => !('password' in a))).toBe(true);
    expect(review.matrix.find((m) => m.action === 'reload_rules')?.roles).toEqual(['admin']);
  });

  it('issues a checkpoint receipt that verifies, and rejects a forged one', async () => {
    const cp = (await mockRequest('POST', '/admin/audit-checkpoints', undefined, admin)) as AuditCheckpointOut;
    const good = (await mockRequest('GET', `/audit/verify?through_id=${cp.through_id}&tip=${cp.tip}`, undefined, analyst)) as AuditVerifyOut;
    expect(good.ok).toBe(true);
    expect(good.checkpoint?.matches).toBe(true);
    const forged = (await mockRequest('GET', `/audit/verify?through_id=${cp.through_id}&tip=${'0'.repeat(64)}`, undefined, analyst)) as AuditVerifyOut;
    expect(forged.ok).toBe(false);
    expect(forged.reason).toMatch(/rewritten/);
  });

  it('shows an engineer what admin adds, and why the panel is closed to them', async () => {
    open('/governance', 'engineer');
    expect(await screen.findByRole('heading', { name: /Who may do what/ }, { timeout: 8000 })).toBeInTheDocument();
    expect(await screen.findByText(/Admins only\./, {}, { timeout: 8000 })).toBeInTheDocument();
    const matrix = screen.getByRole('table', { name: 'Actions each role may take' });
    expect(within(matrix).getByRole('rowheader', { name: /Review access/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Take checkpoint/ })).toHaveAttribute('aria-disabled', 'true'));
  }, 15000);

  it('lets an admin review access and take a checkpoint', async () => {
    open('/governance', 'admin');
    expect(await screen.findByRole('table', { name: 'Accounts and roles' }, { timeout: 8000 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Take checkpoint/ }));
    expect(await screen.findByText(/Receipt — keep this outside the system/, {}, { timeout: 8000 })).toBeInTheDocument();
  }, 15000);
});
