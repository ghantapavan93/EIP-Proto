/**
 * Fetch wrapper. Adds the Basic auth header, surfaces JSON errors with their
 * HTTP status, and — when VITE_MOCK=1 — routes every call to the in-memory
 * mock server instead of the network.
 */

import { authHeader, clearCredentials, type Credentials } from './auth';
import { ApiError, isApiError } from './errors';

export { ApiError, isApiError, errorMessage, errorStatus } from './errors';

export const API_BASE = '/api';
export const MOCK_MODE = import.meta.env.VITE_MOCK === '1';

/**
 * Sent on every request. It marks the call as an XHR so the backend omits
 * `WWW-Authenticate: Basic` on a 401 — otherwise the browser pops its native
 * login dialog over the app's own sign-in page.
 */
export const XHR_HEADER: Readonly<Record<string, string>> = { 'X-Requested-With': 'XMLHttpRequest' };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  /** Override the stored credentials (used by the login probe). */
  credentials?: Credentials | null;
  /** Do not redirect to /login on 401 (used by the login probe). */
  noAuthRedirect?: boolean;
  signal?: AbortSignal;
}

export type QueryValue = string | number | boolean | null | undefined;

/** Build "?a=1&b=2" from a params object, skipping empty values. */
export function toQuery(params: object | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params) as Array<[string, unknown]>) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/** Extract a human-readable message from a FastAPI error body. */
export function messageFromBody(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const detail = (body as Record<string, unknown>).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      // Pydantic validation errors: [{loc, msg, type}]
      const parts = detail
        .map((d) => {
          if (typeof d === 'object' && d !== null) {
            const rec = d as Record<string, unknown>;
            const loc = Array.isArray(rec.loc) ? rec.loc.join('.') : '';
            const msg = typeof rec.msg === 'string' ? rec.msg : '';
            return loc ? `${loc}: ${msg}` : msg;
          }
          return '';
        })
        .filter(Boolean);
      if (parts.length) return parts.join('; ');
    }
    if (typeof detail === 'object' && detail !== null) {
      const msg = (detail as Record<string, unknown>).message;
      if (typeof msg === 'string') return msg;
    }
    const message = (body as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  // A proxy error page (nginx 413/502/504) is HTML — never show raw markup in a toast.
  if (typeof body === 'string' && body.trim() && !/^\s*</.test(body)) return body.trim().slice(0, 500);
  return fallback;
}

/** Fallback text when the body carries no usable message; names the common proxy failures plainly. */
function statusFallback(status: number, statusText: string): string {
  const known: Record<number, string> = {
    413: 'Upload too large for the server (limit 20 MB) — split the file',
    429: 'Too many requests — wait a moment and retry',
    502: 'API unreachable (bad gateway) — the backend may be restarting',
    503: 'API unavailable — the backend may be restarting',
    504: 'The API took too long to answer (gateway timeout) — try fewer transcripts',
  };
  return known[status] ?? `${status} ${statusText}`.trim();
}

let redirecting = false;

function handleUnauthorized(): void {
  clearCredentials();
  if (typeof window === 'undefined' || redirecting) return;
  if (window.location.pathname !== '/login') {
    redirecting = true;
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?next=${next}`);
  }
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  if (MOCK_MODE) {
    const { mockRequest } = await import('../mocks/server');
    const creds = opts.credentials === undefined ? undefined : opts.credentials;
    try {
      return (await mockRequest(method, path, body, creds)) as T;
    } catch (err) {
      if (isApiError(err) && err.status === 401 && !opts.noAuthRedirect) handleUnauthorized();
      throw err;
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...XHR_HEADER,
    ...(opts.credentials === undefined ? authHeader() : authHeader(opts.credentials)),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'network error';
    throw new ApiError(0, `Network error: ${msg}`, path);
  }

  const parsed = parseBody(await response.text());

  if (!response.ok) {
    if (response.status === 401 && !opts.noAuthRedirect) handleUnauthorized();
    throw new ApiError(
      response.status,
      messageFromBody(parsed, statusFallback(response.status, response.statusText)),
      path,
      parsed,
    );
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('POST', path, body ?? {}, opts),
};

// ------------------------------------------------------------- non-JSON helpers

/** Trigger a browser download of a blob (revokes the object URL afterwards). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface RawResponse {
  blob: Blob;
  filename: string | null;
  /** X-Bundle-SHA256 on evidence bundles; null elsewhere */
  sha256: string | null;
}

/** GET a non-JSON body with the auth header (exports, markdown reports, evidence bundles). */
export async function fetchRaw(path: string): Promise<RawResponse> {
  if (MOCK_MODE) {
    const { mockRequest } = await import('../mocks/server');
    const body = await mockRequest('GET', path, undefined);
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    const type = typeof body === 'string' ? 'text/plain' : 'application/json';
    const sha =
      typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).bundle_sha256 === 'string'
        ? ((body as Record<string, unknown>).bundle_sha256 as string)
        : null;
    return { blob: new Blob([text], { type }), filename: null, sha256: sha };
  }
  const response = await fetch(`${API_BASE}${path}`, { headers: { ...XHR_HEADER, ...authHeader() } });
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized();
    const parsed = parseBody(await response.text());
    throw new ApiError(response.status, messageFromBody(parsed, statusFallback(response.status, response.statusText)), path, parsed);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return { blob: await response.blob(), filename: match ? match[1] : null, sha256: response.headers.get('x-bundle-sha256') };
}

/** Download an authenticated resource to a file; returns the file name used. */
export async function download(path: string, fallbackName: string): Promise<string> {
  const { name } = await downloadWithMeta(path, fallbackName);
  return name;
}

/** Download an authenticated resource; returns the file name and the bundle hash header, when present. */
export async function downloadWithMeta(path: string, fallbackName: string): Promise<{ name: string; sha256: string | null }> {
  const { blob, filename, sha256 } = await fetchRaw(path);
  const name = filename ?? fallbackName;
  saveBlob(blob, name);
  return { name, sha256 };
}

/**
 * Fetch an authenticated text resource and show it in a new tab as plain text.
 *
 * Must be called directly from a click handler: the tab is opened
 * synchronously (before any await) so popup blockers treat it as
 * user-initiated, then its location is set once the fetch resolves. If the
 * fetch fails the placeholder tab is closed and the error is rethrown.
 */
export async function openText(path: string): Promise<void> {
  const win = window.open('', '_blank');
  if (win) {
    try {
      win.document.title = 'Loading…';
      win.document.body.textContent = 'Loading report…';
    } catch {
      /* cross-origin or locked-down window — ignore */
    }
  }
  let text: string;
  try {
    const { blob } = await fetchRaw(path);
    text = await blob.text();
  } catch (err) {
    win?.close();
    throw err;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  if (win && !win.closed) {
    win.location.href = url;
  } else {
    // The browser blocked the placeholder tab; fall back to a direct open.
    window.open(url, '_blank', 'noopener');
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Multipart upload (field name "file") with the auth header. */
export async function upload<T>(path: string, file: File, field = 'file'): Promise<T> {
  if (MOCK_MODE) {
    const { mockRequest } = await import('../mocks/server');
    return (await mockRequest('POST', path, { filename: file.name, size: file.size, field })) as T;
  }
  const form = new FormData();
  form.append(field, file, file.name);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { ...XHR_HEADER, ...authHeader() }, body: form });
  } catch (err) {
    throw new ApiError(0, `Network error: ${err instanceof Error ? err.message : 'upload failed'}`, path);
  }
  const parsed = parseBody(await response.text());
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized();
    throw new ApiError(response.status, messageFromBody(parsed, statusFallback(response.status, response.statusText)), path, parsed);
  }
  return parsed as T;
}
