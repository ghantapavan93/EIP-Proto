/**
 * HTTP Basic credentials, held in sessionStorage for the life of the tab.
 * Nothing here is a security boundary — the backend's Basic auth is a
 * deliberate stub for SSO. The client attaches the header to every request.
 */

const STORAGE_KEY = 'backstop.auth';

export interface Credentials {
  username: string;
  password: string;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function getCredentials(): Credentials | null {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).username === 'string' &&
      typeof (parsed as Record<string, unknown>).password === 'string'
    ) {
      return parsed as Credentials;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function setCredentials(creds: Credentials): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(creds));
}

export function clearCredentials(): void {
  storage()?.removeItem(STORAGE_KEY);
}

/** Base64 for the Basic scheme; handles non-ASCII by UTF-8 encoding first. */
export function basicAuthValue(creds: Credentials): string {
  const raw = `${creds.username}:${creds.password}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return `Basic ${btoa(binary)}`;
}

export function authHeader(creds: Credentials | null = getCredentials()): Record<string, string> {
  return creds ? { Authorization: basicAuthValue(creds) } : {};
}
