/** Error type thrown by the API client (and the mock server) for non-2xx responses. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly path: string;

  constructor(status: number, message: string, path: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.path = path;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Best-effort message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (isApiError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function errorStatus(err: unknown): number | null {
  return isApiError(err) ? err.status : null;
}
