import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, ApiError, messageFromBody } from '../api/client';
import { clearCredentials, setCredentials } from '../api/auth';
import {
  keys,
  useApproveTestCase,
  useCheckSources,
  useIngestTranscripts,
  useCreateRun,
  useProposeVersion,
  useReloadRules,
  useRunScan,
} from '../api/hooks';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function htmlResponse(status: number, statusText: string): Response {
  return new Response(
    `<html><head><title>${status} ${statusText}</title></head><body><center><h1>${status}</h1></center><hr><center>nginx</center></body></html>`,
    {
      status,
      statusText,
      headers: { 'Content-Type': 'text/html' },
    },
  );
}

describe('error messages are readable text', () => {
  beforeEach(() => {
    setCredentials({ username: 'engineer', password: 'engineer' });
    vi.restoreAllMocks();
  });
  afterEach(() => clearCredentials());

  it('flattens a FastAPI 422 validation array into "loc: msg" text', () => {
    const msg = messageFromBody(
      {
        detail: [
          { loc: ['body', 'limit'], msg: 'Input should be greater than 0', type: 'greater_than' },
          { loc: ['body', 'model_id'], msg: 'Field required' },
        ],
      },
      'fallback',
    );
    expect(msg).toBe('body.limit: Input should be greater than 0; body.model_id: Field required');
    expect(msg).not.toContain('[object Object]');
  });

  it.each([
    [413, 'Request Entity Too Large', /too large/i],
    [504, 'Gateway Time-out', /took too long/i],
    [502, 'Bad Gateway', /unreachable/i],
    [429, 'Too Many Requests', /too many requests/i],
  ])('an nginx %i HTML page becomes a plain sentence, not markup', async (status, text, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse(status, text));
    const err = await api.post('/runs', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    expect((err as ApiError).message).toMatch(expected);
    expect((err as ApiError).message).not.toContain('<');
  });

  it('keeps a string 409 detail verbatim', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ detail: 'illegal transition OPEN → CLOSED' }, 409));
    const err = (await api.post('/review/x/transition', {}).catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe('illegal transition OPEN → CLOSED');
  });

  it('reports a network failure as a status-0 ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const err = (await api.post('/scans', {}).catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.message).toBe('Network error: Failed to fetch');
  });
});

describe('mutations refresh the status rail and the screens that depend on them', () => {
  let qc: QueryClient;
  let invalidated: unknown[][];

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    setCredentials({ username: 'engineer', password: 'engineer' });
    vi.restoreAllMocks();
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    invalidated = [];
    const original = qc.invalidateQueries.bind(qc);
    vi.spyOn(qc, 'invalidateQueries').mockImplementation((filters, opts) => {
      invalidated.push([...((filters?.queryKey as unknown[]) ?? [])]);
      return original(filters, opts);
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}));
  });
  afterEach(() => clearCredentials());

  const has = (key: readonly unknown[]) => invalidated.some((k) => JSON.stringify(k) === JSON.stringify(key));

  it('Run scan → artifacts, review, status rail', async () => {
    const { result } = renderHook(() => useRunScan(), { wrapper });
    act(() => result.current.mutate({ idempotency_key: 'k', live: false }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(has(keys.assets())).toBe(true);
    expect(has(keys.review())).toBe(true);
    expect(has(keys.status())).toBe(true);
  });

  it('Adopt rule corpus → rules, audit, readiness, status rail', async () => {
    const { result } = renderHook(() => useReloadRules(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(has(keys.rules())).toBe(true);
    expect(has(keys.audit())).toBe(true);
    expect(has(keys.readiness())).toBe(true);
    expect(has(keys.status())).toBe(true);
  });

  it('Start run → runs, model board, contract metrics, review, status rail', async () => {
    const { result } = renderHook(() => useCreateRun(), { wrapper });
    act(() => result.current.mutate({ prompt_version: 2, model_id: 'sim-large', rule_date: '2026-10-01' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(has(keys.runs())).toBe(true);
    expect(has(keys.models())).toBe(true);
    expect(has(keys.contracts())).toBe(true);
    expect(has(keys.review())).toBe(true);
    expect(has(keys.status())).toBe(true);
  });

  it('family keys cover every query under them', () => {
    const covers = (family: readonly unknown[], key: readonly unknown[]) =>
      JSON.stringify(key.slice(0, family.length)) === JSON.stringify(family);
    expect(covers(keys.rules(), keys.impact('soa-48h-wait', '2026-10-01'))).toBe(true);
    expect(covers(keys.rules(), keys.impactWhatIf('soa-48h-wait', '2026-10-01', 3))).toBe(true);
    expect(covers(keys.models(), keys.modelBoard({}))).toBe(true);
    expect(covers(keys.review(), keys.reviewTask('t-1'))).toBe(true);
    expect(covers(keys.audit(), keys.auditPage({ limit: 50 }))).toBe(true);
    expect(covers(keys.readiness(), keys.readinessAt('2026-10-01'))).toBe(true);
    expect(covers(keys.transcripts(), keys.transcriptPage(100, 0))).toBe(true);
  });

  it('Approve test case → test cases, review, status rail', async () => {
    const { result } = renderHook(() => useApproveTestCase(), { wrapper });
    act(() => result.current.mutate('tc-1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(has(keys.testCases())).toBe(true);
    expect(has(keys.review())).toBe(true);
    expect(has(keys.status())).toBe(true);
  });

  it('Propose rule version → rules, review, status rail', async () => {
    const { result } = renderHook(() => useProposeVersion('soa-48h-wait'), { wrapper });
    act(() => result.current.mutate({} as never));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(has(keys.rules())).toBe(true);
    expect(has(keys.review())).toBe(true);
    expect(has(keys.status())).toBe(true);
  });

  it('Check sources → status rail', async () => {
    const { result } = renderHook(() => useCheckSources(), { wrapper });
    act(() => result.current.mutate({}));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(has(keys.status())).toBe(true);
  });

  it('Ingest transcripts → transcript list and status counts', async () => {
    const { result } = renderHook(() => useIngestTranscripts(), { wrapper });
    act(() =>
      result.current.mutate({
        file: new File(['call_id,transcript\n1,hi\n'], 'x.csv', { type: 'text/csv' }),
        format: 'attention-snowflake',
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(has(keys.transcripts())).toBe(true);
    expect(has(keys.status())).toBe(true);
  });
});
