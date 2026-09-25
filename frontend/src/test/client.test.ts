import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, toQuery } from '../api/client';
import { basicAuthValue, clearCredentials, setCredentials } from '../api/auth';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('api client', () => {
  beforeEach(() => {
    clearCredentials();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    clearCredentials();
  });

  it('sends the stored credentials as an HTTP Basic Authorization header', async () => {
    setCredentials({ username: 'analyst', password: 'analyst' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ app: 'backstop' }));

    await api.get('/meta');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/meta');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa('analyst:analyst')}`);
    expect(basicAuthValue({ username: 'analyst', password: 'analyst' })).toBe('Basic YW5hbHlzdDphbmFseXN0');
  });

  it('sends no Authorization header when signed out', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    await api.get('/meta', { noAuthRedirect: true });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('surfaces JSON errors with their HTTP status and FastAPI detail', async () => {
    setCredentials({ username: 'engineer', password: 'engineer' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ detail: 'STALE_ASSET: republished -> in_review is not allowed' }, 409),
    );
    const err = await api.post('/review/task-0001/transition', { to: 'in_review' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe('STALE_ASSET: republished -> in_review is not allowed');
  });

  it('builds query strings and skips empty values', () => {
    expect(toQuery({ as_of: '2026-10-01', contract: '', outcome: undefined, limit: 25 })).toBe('?as_of=2026-10-01&limit=25');
    expect(toQuery(undefined)).toBe('');
  });
});
