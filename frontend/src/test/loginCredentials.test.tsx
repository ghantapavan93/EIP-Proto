import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginPage } from '../pages/Login';

/**
 * A published instance (Cloudflare tunnel) runs issued accounts; the login page
 * must not advertise password == username accounts that the server rejects.
 */

function renderWithHealth(defaultCredentials: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ status: 'healthy', ready: true, default_credentials: defaultCredentials, components: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('login credentials hint', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists roles, not passwords, when the server uses issued accounts', async () => {
    renderWithHealth(false);
    expect(await screen.findByText(/Accounts are issued per person/)).toBeInTheDocument();
    expect(screen.queryByText('Demo credentials')).not.toBeInTheDocument();
    expect(screen.queryByText(/analyst \/ analyst/)).not.toBeInTheDocument();
  });

  it('shows the demo accounts while the server still runs them', async () => {
    renderWithHealth(true);
    expect(await screen.findByText('Demo credentials')).toBeInTheDocument();
    expect(screen.getByText(/engineer \/ engineer/)).toBeInTheDocument();
  });
});
