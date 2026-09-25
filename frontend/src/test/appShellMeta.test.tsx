import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '../components/layout/AppShell';
import { ToastProvider } from '../components/ui/Toast';
import { clearCredentials, setCredentials } from '../api/auth';
import { keys } from '../api/hooks';
import type { MetaOut } from '../api/types';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '../components/ui/DataTable';

/**
 * A failed background refetch of /meta (or /status) must not blank screens
 * that already have data; only a /meta that never loaded shows the error.
 */

const META: MetaOut = {
  app: 'backstop',
  version: 'test',
  environment_label: 'TEST ENV',
  adapters: { simulated: true },
  default_adapter: 'simulated',
  synthetic_notice: '',
  today: '2026-09-23',
  user: 'engineer',
  role: 'engineer',
};

function failEverything() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ detail: 'upstream unavailable' }), { status: 503 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderShell(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<div>screen content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('AppShell /meta errors', () => {
  beforeEach(() => setCredentials({ username: 'engineer', password: 'engineer' }));
  afterEach(() => {
    vi.unstubAllGlobals();
    clearCredentials();
  });

  it('keeps the screen when a /meta refetch fails but cached data exists', async () => {
    const fetchMock = failEverything();
    const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    qc.setQueryData(keys.meta(), META);
    renderShell(qc);
    expect(screen.getByText('screen content')).toBeInTheDocument();

    await act(async () => {
      await qc.refetchQueries({ queryKey: keys.meta() });
    });
    expect(qc.getQueryState(keys.meta())?.status).toBe('error');
    // /meta is retried once before it is reported failed
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/meta'))).toHaveLength(2);
    expect(screen.getByText('screen content')).toBeInTheDocument();
    expect(screen.queryByText('Could not load /meta')).toBeNull();
    expect(screen.getByText('TEST ENV')).toBeInTheDocument();
  });

  it('shows the full-screen error when /meta never loaded', async () => {
    failEverything();
    const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    renderShell(qc);
    expect(await screen.findByText('Could not load /meta')).toBeInTheDocument();
    expect(screen.queryByText('screen content')).toBeNull();
  });
});

describe('DataTable with a failed refetch', () => {
  const columns: ColumnDef<{ id: string }, unknown>[] = [{ header: 'Id', accessorKey: 'id' }];

  it('keeps the rows it already has', () => {
    render(<DataTable columns={columns} data={[{ id: 'row-1' }]} error={new Error('refetch failed')} getRowId={(r) => r.id} />);
    expect(screen.getByText('row-1')).toBeInTheDocument();
    expect(screen.queryByText(/refetch failed/)).toBeNull();
  });

  it('shows the error when there is nothing to show', () => {
    render(<DataTable columns={columns} data={undefined} error={new Error('first load failed')} />);
    expect(screen.getByText(/first load failed/)).toBeInTheDocument();
  });
});
