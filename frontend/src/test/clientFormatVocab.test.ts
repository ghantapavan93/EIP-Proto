import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, openText } from '../api/client';
import { clearCredentials, setCredentials } from '../api/auth';
import type { ReviewTaskOut, RunOut, ScanOut } from '../api/types';
import { durationBetween, fmtDateTime, fmtTs, parsePageParam, parseTs, todayIso } from '../lib/format';
import {
  adaptersForModel,
  AUDIT_ENTITY_TYPES,
  AUDIT_EVENT_TYPES,
  defaultAdapterForModel,
  edgeStatusTone,
  providerStatusLabel,
} from '../lib/vocab';
import { gateStripKey, judgeModelId, latestPerConfiguration } from '../lib/runStats';
import { filterTasksByRun, taskRunId, TERMINAL_REVIEW_STATES } from '../lib/review';
import { defaultScanKey, resolveScanKey, scanToast } from '../lib/scan';
import { cellWraps } from '../lib/table';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('api client headers', () => {
  beforeEach(() => {
    clearCredentials();
    vi.restoreAllMocks();
  });
  afterEach(() => clearCredentials());

  it('marks every JSON request as XHR so a 401 never pops the browser Basic dialog', async () => {
    setCredentials({ username: 'analyst', password: 'analyst' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse({})));
    await api.get('/meta');
    await api.post('/scans', { idempotency_key: 'k' });
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    }
  });

  it('sends the XHR header even when signed out (login probe)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 401));
    await api.get('/meta', { noAuthRedirect: true }).catch(() => undefined);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('openText (Evals "Markdown report")', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCredentials({ username: 'analyst', password: 'analyst' });
  });
  afterEach(() => clearCredentials());

  it('opens the tab synchronously, before the fetch resolves, then points it at the report', async () => {
    const fakeWin = { closed: false, close: vi.fn(), location: { href: '' }, document: { title: '', body: { textContent: '' } } };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);
    let resolveFetch: (r: Response) => void = () => undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((res) => (resolveFetch = res)));
    const createUrl = vi.fn(() => 'blob:report');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });

    const pending = openText('/evals/matchers.md');
    // Still inside the click's call stack: the window must already be open.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');

    resolveFetch(new Response('# Matchers', { status: 200 }));
    await pending;
    expect(fakeWin.location.href).toBe('blob:report');
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the placeholder tab and rethrows when the fetch fails', async () => {
    const fakeWin = { closed: false, close: vi.fn(), location: { href: '' }, document: { title: '', body: { textContent: '' } } };
    vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ detail: 'boom' }, 500));
    await expect(openText('/evals/matchers.md')).rejects.toThrow('boom');
    expect(fakeWin.close).toHaveBeenCalled();
  });
});

describe('format', () => {
  it('treats a timestamp without a zone designator as UTC', () => {
    expect(fmtTs('2026-09-21T13:41:30')).toBe('2026-09-21 13:41:30Z');
    expect(fmtTs('2026-09-21T13:41:30.123456')).toBe('2026-09-21 13:41:30Z');
    expect(fmtTs('2026-09-21 13:41:30')).toBe('2026-09-21 13:41:30Z');
    expect(parseTs('2026-09-21T13:41:30').toISOString()).toBe('2026-09-21T13:41:30.000Z');
  });

  it('keeps explicit zones as given', () => {
    expect(fmtTs('2026-09-21T13:41:30Z')).toBe('2026-09-21 13:41:30Z');
    expect(fmtTs('2026-09-21T13:41:30+00:00')).toBe('2026-09-21 13:41:30Z');
    expect(fmtTs('2026-09-21T15:41:30+02:00')).toBe('2026-09-21 13:41:30Z');
    expect(fmtTs('2026-09-21T08:41:30-0500')).toBe('2026-09-21 13:41:30Z');
  });

  it('applies the same UTC rule to durations and local datetimes', () => {
    expect(durationBetween('2026-09-21T13:41:30', '2026-09-21T13:41:31Z')).toBe(1000);
    expect(fmtDateTime('2026-09-21T13:41:30')).toBe(fmtDateTime('2026-09-21T13:41:30Z'));
    expect(fmtTs('not a date')).toBe('not a date');
    expect(fmtTs(null)).toBe('—');
  });

  it('todayIso uses the local calendar date, not UTC', () => {
    // 23:30 local on Sep 23 is Sep 24 in UTC for any zone west of UTC+0:30.
    expect(todayIso(new Date(2026, 8, 23, 23, 30))).toBe('2026-09-23');
    expect(todayIso(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
  });

  it('parsePageParam falls back to 0 for anything that is not a non-negative integer', () => {
    expect(parsePageParam('3')).toBe(3);
    expect(parsePageParam(null)).toBe(0);
    expect(parsePageParam('')).toBe(0);
    expect(parsePageParam('abc')).toBe(0);
    expect(parsePageParam('-2')).toBe(0);
    expect(parsePageParam('1.5')).toBe(0);
    expect(parsePageParam('NaN')).toBe(0);
    expect(parsePageParam('1e400')).toBe(0);
  });
});

describe('vocab', () => {
  it('lists the newer audit event and entity types in the Audit filters', () => {
    for (const t of ['export.generated', 'ingest.completed', 'rule.source_checked', 'rule.version_closed', 'edge.superseded', 'edge.restored']) {
      expect(AUDIT_EVENT_TYPES).toContain(t);
    }
    expect(AUDIT_ENTITY_TYPES).toContain('auth');
    expect(AUDIT_ENTITY_TYPES).toContain('transcripts');
  });

  it('derives the adapter from the model provider so Start never 422s on a mismatch', () => {
    expect(adaptersForModel({ provider: 'simulated' })).toEqual(['simulated']);
    expect(adaptersForModel({ provider: 'ollama' })).toEqual(['cassette', 'live']);
    expect(defaultAdapterForModel({ provider: 'simulated' })).toBe('simulated');
    expect(defaultAdapterForModel({ provider: 'groq' })).toBe('cassette');
    expect(defaultAdapterForModel({ provider: 'anthropic' })).toBe('cassette');
  });

  it('says an offline Ollama still replays cassettes instead of "needs key"', () => {
    expect(providerStatusLabel('ollama', false)).toBe('offline — cassettes still replay');
    expect(providerStatusLabel('ollama', true)).toBe('ready');
    expect(providerStatusLabel('groq', false)).toBe('needs key');
    expect(providerStatusLabel('anthropic', false)).toBe('optional');
  });

  it('shows superseded edges in neutral grey', () => {
    expect(edgeStatusTone('superseded')).toBe('neutral');
    expect(edgeStatusTone('confirmed')).toBe('green');
    expect(edgeStatusTone('proposed')).toBe('amber');
    expect(edgeStatusTone('rejected')).toBe('red');
  });
});

function run(partial: Partial<RunOut> & { id: string }): RunOut {
  return {
    workflow_code: 'qa-handoff',
    prompt_version: 2,
    model_id: 'ollama/qwen2.5:3b-instruct',
    adapter: 'cassette',
    rule_date: '2026-10-01',
    started_at: '2026-09-23T05:00:00Z',
    stats: {},
    ...partial,
  } as RunOut;
}

describe('home gate strip grouping', () => {
  it('keeps runs that differ only by judge model or adapter as separate rows', () => {
    const plain = run({ id: 'a', started_at: '2026-09-23T05:00:00Z', stats: { judge_model_id: 'ollama/qwen2.5:3b-instruct' } });
    const judged = run({ id: 'b', started_at: '2026-09-23T05:01:00Z', stats: { judge_model_id: 'ollama/qwen2.5:7b-instruct' } });
    const live = run({ id: 'c', started_at: '2026-09-23T05:02:00Z', adapter: 'live', stats: { judge_model_id: 'ollama/qwen2.5:3b-instruct' } });
    const plainLater = run({ id: 'd', started_at: '2026-09-23T06:00:00Z', stats: { judge_model_id: 'ollama/qwen2.5:3b-instruct' } });
    const rows = latestPerConfiguration([plain, judged, live, plainLater]);
    expect(rows.map((r) => r.id)).toEqual(['d', 'c', 'b']);
    expect(gateStripKey(plain)).not.toBe(gateStripKey(judged));
  });

  it('reads the judge model from stats, the stability block, or falls back to the run model', () => {
    expect(judgeModelId(run({ id: 'x', stats: { judge_model_id: 'j1' } }))).toBe('j1');
    expect(judgeModelId(run({ id: 'x', stats: { judge_stability: { judge_model_id: 'j2' } } }))).toBe('j2');
    expect(judgeModelId(run({ id: 'x', model_id: 'sim-large', stats: {} }))).toBe('sim-large');
  });
});

describe('review run filter', () => {
  const t = (id: string, run_id: string | null, payload: Record<string, unknown> = {}) =>
    ({ id, run_id, payload }) as unknown as ReviewTaskOut;

  it('filters on run_id and falls back to payload.run_id', () => {
    const tasks = [t('1', 'run-a'), t('2', null, { run_id: 'run-a' }), t('3', 'run-b'), t('4', null)];
    expect(filterTasksByRun(tasks, 'run-a')?.map((x) => x.id)).toEqual(['1', '2']);
    expect(filterTasksByRun(tasks, '')?.length).toBe(4);
    expect(filterTasksByRun(undefined, 'run-a')).toBeUndefined();
    expect(taskRunId(t('5', null, { run_id: 42 }))).toBeNull();
  });

  it('knows which review states are terminal', () => {
    expect(TERMINAL_REVIEW_STATES.has('upheld')).toBe(true);
    expect(TERMINAL_REVIEW_STATES.has('in_review')).toBe(false);
  });
});

describe('scan toasts', () => {
  const scan = (partial: Partial<ScanOut>): ScanOut => ({
    id: 'd863e3e9-0000-0000-0000-000000000000',
    idempotency_key: '2026-09-23-manual',
    status: 'completed',
    started_at: '2026-09-23T06:03:19Z',
    finished_at: '2026-09-23T06:03:19Z',
    stats: { new_versions: 2, edges_new: 3, proposed_new: 1, edges_superseded: 1 },
    deduplicated: false,
    ...partial,
  });

  it('distinguishes a new scan from a deduplicated one', () => {
    const fresh = scanToast(scan({}));
    expect(fresh.title).toMatch(/^New scan d863e3e9… completed$/);
    expect(fresh.detail).toContain('2 new versions');
    expect(fresh.detail).toContain('1 superseded');
    expect(fresh.tone).toBe('green');

    const dup = scanToast(scan({ deduplicated: true }));
    expect(dup.title).toMatch(/^Deduplicated/);
    expect(dup.title).toContain('2026-09-23-manual');
    expect(dup.detail).toMatch(/no new versions, edges or review tasks/);
    expect(dup.tone).toBe('teal');
  });

  it('uses the typed key, or one manual key per local day', () => {
    const now = new Date(2026, 8, 23, 23, 30);
    expect(defaultScanKey(now)).toBe('2026-09-23-manual');
    expect(resolveScanKey('   ', now)).toBe('2026-09-23-manual');
    expect(resolveScanKey(' demo-1 ', now)).toBe('demo-1');
  });
});

describe('DataTable wrapping rules', () => {
  it('wraps text columns but keeps ids and numbers on one line', () => {
    expect(cellWraps(undefined, false)).toBe(true);
    expect(cellWraps({ mono: true }, false)).toBe(false);
    expect(cellWraps({ align: 'right' }, false)).toBe(false);
    expect(cellWraps({ nowrap: true }, false)).toBe(false);
    expect(cellWraps({ mono: true, wrap: true }, false)).toBe(true);
    expect(cellWraps(undefined, true)).toBe(false);
    expect(cellWraps({ wrap: true }, true)).toBe(true);
  });
});
