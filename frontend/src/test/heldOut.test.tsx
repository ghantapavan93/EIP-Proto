import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { RunOut } from '../api/types';
import { baselineFor, gateStripKey, holdoutPair, isDevelopmentRun, latestByTrigger, latestPerConfiguration, runCorpus } from '../lib/runStats';
import { safeNext } from '../lib/redirect';
import { CorpusChip, HOLDOUT_TOOLTIP } from '../components/runs/CorpusChip';
import { CallSetNotice } from '../pages/RunCompare';
import { RunsPage } from '../pages/Runs';
import { ArtifactsPage } from '../pages/Artifacts';
import { ShellProvider } from '../components/layout/ShellProvider';
import { ToastProvider } from '../components/ui/Toast';
import { clearCredentials, setCredentials } from '../api/auth';

/**
 * The held-out corpus (H001–H060) exists to check whether a prompt fix
 * generalises. It must never be mistaken for the development corpus: not on
 * the change-trigger cards, not in the New run form, and always labelled.
 */

function run(over: Partial<RunOut>): RunOut {
  return {
    id: 'run',
    run_key: 'k',
    workflow_code: 'qa-handoff',
    prompt_version: 2,
    prompt_label: 'v2',
    prompt_hash: 'p2',
    model_id: 'ollama/qwen2.5:7b-instruct',
    model_label: 'Qwen2.5 7B',
    adapter: 'cassette',
    corpus_hash: 'c-dev',
    contract_set_hash: 's',
    rule_date: '2026-10-01',
    trigger: 'MANUAL',
    status: 'COMPLETE',
    gate: 'RED',
    started_at: '2026-09-23T07:00:00Z',
    finished_at: '2026-09-23T07:05:00Z',
    stats: {},
    requested_by: 'system:runner',
    deduplicated: false,
    contracts: [],
    ...over,
  };
}

describe('run corpus', () => {
  it('treats a missing corpus as the development corpus and reads stats.corpus as a fallback', () => {
    expect(runCorpus(run({}))).toBe('synthetic');
    expect(runCorpus(run({ stats: { corpus: 'holdout' } }))).toBe('holdout');
    expect(runCorpus(run({ corpus: 'ingested', stats: { corpus: 'holdout' } }))).toBe('ingested');
    expect(isDevelopmentRun(run({}))).toBe(true);
    expect(isDevelopmentRun(run({ corpus: 'holdout' }))).toBe(false);
    expect(isDevelopmentRun(run({ corpus: 'all' }))).toBe(false);
  });

  it('keeps a held-out replay from hiding the development run of the same configuration', () => {
    const dev = run({ id: 'dev', started_at: '2026-09-23T07:00:00Z' });
    const held = run({ id: 'held', corpus: 'holdout', started_at: '2026-09-23T08:00:00Z' });
    expect(gateStripKey(dev)).not.toBe(gateStripKey(held));
    expect(latestPerConfiguration([dev, held]).map((r) => r.id)).toEqual(['held', 'dev']);
  });
});

describe('change-trigger card selection', () => {
  const devV2 = run({ id: 'dev-v2', prompt_hash: 'p2', trigger: 'MANUAL', started_at: '2026-09-23T06:00:00Z' });
  const devV3 = run({ id: 'dev-v3', prompt_version: 3, prompt_hash: 'p3', trigger: 'PROMPT', started_at: '2026-09-23T07:00:00Z' });
  const heldV2 = run({ id: 'held-v2', corpus: 'holdout', trigger: 'MANUAL', started_at: '2026-09-23T07:30:00Z' });
  const heldV3 = run({ id: 'held-v3', corpus: 'holdout', prompt_version: 3, prompt_hash: 'p3', trigger: 'PROMPT', started_at: '2026-09-23T08:00:00Z' });
  const ingestedRule = run({ id: 'ing-rule', corpus: 'ingested', trigger: 'RULE', started_at: '2026-09-23T09:00:00Z' });

  it('never picks a held-out or ingested run as B', () => {
    const runs = [devV2, devV3, heldV2, heldV3, ingestedRule];
    expect(latestByTrigger(runs, 'PROMPT')?.id).toBe('dev-v3');
    expect(latestByTrigger(runs, 'RULE')).toBeUndefined();
  });

  it('never picks a held-out run as A, even as the fallback baseline', () => {
    const runs = [devV2, devV3, heldV2, heldV3];
    expect(baselineFor(runs, devV3, 'prompt')?.id).toBe('dev-v2');
    // no matching development baseline: the fallback is still a development run, or nothing
    expect(baselineFor([heldV2, devV3], devV3, 'prompt')).toBeUndefined();
    expect(baselineFor(runs, heldV3, 'prompt')).toBeUndefined();
  });
});

describe('held-out pair for the Runs callout', () => {
  const v2 = run({ id: 'h2', corpus: 'holdout', prompt_version: 2 });
  const v3 = run({ id: 'h3', corpus: 'holdout', prompt_version: 3 });

  it('pairs the qwen2.5 7B held-out runs at prompt v2 and v3', () => {
    const pair = holdoutPair([run({ id: 'dev', prompt_version: 3 }), v2, v3, run({ id: 'other', corpus: 'holdout', prompt_version: 3, model_id: 'ollama/qwen2.5:3b-instruct' })]);
    expect(pair?.before.id).toBe('h2');
    expect(pair?.after.id).toBe('h3');
  });

  it('shows nothing unless both exist', () => {
    expect(holdoutPair([v2])).toBeNull();
    expect(holdoutPair([v2, run({ id: 'dev3', prompt_version: 3 })])).toBeNull();
    expect(holdoutPair(undefined)).toBeNull();
  });
});

describe('CorpusChip', () => {
  it('labels held-out runs with the call range and explains why', () => {
    render(<CorpusChip run={run({ corpus: 'holdout' })} />);
    const chip = screen.getByText('HELD-OUT · H001–H060');
    expect(chip).toHaveAttribute('title', HOLDOUT_TOOLTIP);
    expect(chip).toHaveAttribute('data-tone', 'slate');
  });

  it('labels ingested runs and says nothing for the development corpus', () => {
    const { container, rerender } = render(<CorpusChip run={run({ corpus: 'ingested' })} />);
    expect(screen.getByText('INGESTED')).toBeInTheDocument();
    rerender(<CorpusChip run={run({})} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Compare: different call sets', () => {
  it('says how many cells were left out of the comparison', () => {
    render(<CallSetNotice whatChanged={{ corpus: true, cells_only_in_a: 480, cells_only_in_b: 16 }} />);
    expect(screen.getByRole('note')).toHaveTextContent('Different call sets: 480 cells only in A, 16 only in B were not compared.');
  });

  it('warns on a corpus change even when the server sends no cell counts', () => {
    render(<CallSetNotice whatChanged={{ corpus: true }} />);
    expect(screen.getByRole('note')).toHaveTextContent('0 cells only in A, 0 only in B');
  });

  it('stays silent when both runs scored the same cells', () => {
    const { container } = render(<CallSetNotice whatChanged={{ corpus: false, cells_only_in_a: 0, cells_only_in_b: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('login next param', () => {
  it('accepts plain same-origin paths', () => {
    expect(safeNext('/runs/compare?a=1&b=2')).toBe('/runs/compare?a=1&b=2');
    expect(safeNext('/')).toBe('/');
  });

  it('rejects protocol-relative, backslash and absolute targets', () => {
    for (const bad of ['//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com', 'evil.com', '/\t/evil.com', '/\n/evil.com', '', null, undefined]) {
      expect(safeNext(bad)).toBe('/');
    }
  });

  it('never loops back to the login page', () => {
    expect(safeNext('/login?next=%2Fruns')).toBe('/');
  });
});

// ------------------------------------------------------------- pages against a stubbed API

function stubApi(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    if (!(path in routes)) return new Response(JSON.stringify({ detail: `unrouted ${path}` }), { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const META = {
  app: 'backstop',
  version: 'test',
  environment_label: 'TEST',
  adapters: { simulated: true, cassette: true },
  default_adapter: 'simulated',
  synthetic_notice: '',
  today: '2026-09-23',
  user: 'engineer',
  role: 'engineer',
};

function renderPage(page: ReactNode, path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <ShellProvider>{page}</ShellProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Runs page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearCredentials();
  });

  it('links the held-out v2 → v3 comparison and labels held-out rows', async () => {
    const heldV2 = run({ id: 'aaaaaaaa-held-v2', corpus: 'holdout', prompt_version: 2 });
    const heldV3 = run({ id: 'bbbbbbbb-held-v3', corpus: 'holdout', prompt_version: 3, started_at: '2026-09-23T08:00:00Z' });
    stubApi({ '/runs': [run({ id: 'cccccccc-dev' }), heldV2, heldV3], '/contracts': [], '/meta': META });
    renderPage(<RunsPage />, '/runs');
    const callout = await screen.findByText('Held-out check:');
    const note = callout.closest('p') as HTMLElement;
    expect(note).toHaveTextContent('Held-out check: prompt v3 vs v2 on 60 unseen calls → Compare');
    expect(within(note).getByRole('link', { name: 'Compare' })).toHaveAttribute('href', '/runs/compare?a=aaaaaaaa-held-v2&b=bbbbbbbb-held-v3');
    expect(await screen.findAllByText('HELD-OUT · H001–H060')).toHaveLength(2);
  });

  it('shows no callout without both held-out runs', async () => {
    stubApi({ '/runs': [run({ id: 'cccccccc-dev' }), run({ id: 'aaaaaaaa-held-v2', corpus: 'holdout' })], '/contracts': [], '/meta': META });
    renderPage(<RunsPage />, '/runs');
    expect(await screen.findByText('HELD-OUT · H001–H060')).toBeInTheDocument();
    expect(screen.queryByText('Held-out check:')).toBeNull();
  });

  it('offers only the development and ingested corpora in the New run form', async () => {
    setCredentials({ username: 'engineer', password: 'engineer' });
    stubApi({ '/runs': [], '/contracts': [], '/meta': META, '/workflows': [], '/models': [] });
    renderPage(<RunsPage />, '/runs?new=1');
    const select = (await screen.findByLabelText('Corpus')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['synthetic', 'ingested']);
    expect(screen.getByText(/blank = all 60 development calls/)).toBeInTheDocument();
  });
});

describe('Artifacts transcript corpus', () => {
  afterEach(() => vi.unstubAllGlobals());

  const transcript = { id: 't1', code: 'T001', product_line: 'MA', synthetic: true, duration_seconds: 600, labels: {}, text: null };

  it('counts only the calls the API returns and notes the held-out calls kept out of view', async () => {
    stubApi({ '/assets': [], '/transcripts': [transcript], '/meta': META, '/health/deep': { holdout_transcripts: 60, components: [] } });
    renderPage(<ArtifactsPage />, '/artifacts');
    expect(await screen.findByText('+ 60 held-out calls kept out of view (used only to check prompt overfitting)')).toBeInTheDocument();
    expect(screen.getByText(/^1 transcripts · 0 ingested/)).toBeInTheDocument();
  });

  it('skips the note when health does not report held-out calls', async () => {
    stubApi({ '/assets': [], '/transcripts': [transcript], '/meta': META, '/health/deep': { components: [] } });
    renderPage(<ArtifactsPage />, '/artifacts');
    expect(await screen.findByText(/^1 transcripts · 0 ingested/)).toBeInTheDocument();
    expect(screen.queryByText(/held-out calls kept out of view/)).toBeNull();
  });
});
