import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { evidenceForLocation, filterPalette, type PaletteItem } from '../lib/palette';

const mutate = vi.fn();
vi.mock('../api/hooks', () => ({
  canEdit: (role: string | null) => role === 'engineer' || role === 'admin',
  useRole: () => 'engineer',
  useExportEvidence: () => ({ mutate, isPending: false }),
  useRules: () => ({ data: [{ code: 'soa-48h-wait', title: 'Scope of Appointment — 48-hour wait', citation: '42 CFR 422.2264(c)(3)' }], isLoading: false }),
  useAssets: () => ({ data: [{ code: 'sc-12', name: 'Attention scorecard item SC-12', type: 'scorecard_item' }], isLoading: false }),
  useRuns: () => ({
    data: [{ id: '7d5698c9-0441', workflow_code: 'qa-handoff', prompt_version: 3, model_id: 'ollama/qwen2.5:7b-instruct', gate: 'RED', started_at: '2026-09-23T07:28:00Z', trigger: 'PROMPT', rule_date: '2026-10-01' }],
    isLoading: false,
  }),
}));

const { CommandPalette } = await import('../components/layout/CommandPalette');
const { ToastProvider } = await import('../components/ui/Toast');

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <button type="button">before</button>
                <CommandPalette />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

async function openPalette() {
  act(() => {
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  });
  const input = screen.getByRole('combobox');
  await waitFor(() => expect(input).toHaveFocus());
  return input;
}

describe('palette model', () => {
  it('knows which pages can export evidence', () => {
    expect(evidenceForLocation('/runs/abc', '')).toEqual({ scope: 'runs', id: 'abc' });
    expect(evidenceForLocation('/runs/compare', '?a=1')).toBeNull();
    expect(evidenceForLocation('/rules/soa-48h-wait', '?as_of=2026-10-01')).toEqual({ scope: 'rules', id: 'soa-48h-wait', asOf: '2026-10-01' });
    expect(evidenceForLocation('/review', '?task=t-1')).toEqual({ scope: 'tasks', id: 't-1' });
    expect(evidenceForLocation('/review', '')).toBeNull();
  });

  it('filters by every word, keeps group order and caps list groups', () => {
    const items: PaletteItem[] = [
      { id: 'a', group: 'Actions', label: 'Open review queue' },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, group: 'Runs' as const, label: `qa-handoff run ${i}`, hint: `id${i}` })),
      { id: 'x', group: 'Rules', label: 'Scope of Appointment', hint: 'soa-48h-wait' },
    ];
    expect(filterPalette(items, '').map((i) => i.group)).toEqual(['Actions', 'Rules', ...Array(6).fill('Runs')]);
    expect(filterPalette(items, 'soa wait').map((i) => i.id)).toEqual(['x']);
  });
});

describe('CommandPalette', () => {
  it('opens on Ctrl+K, finds a rule by code and navigates on Enter', async () => {
    renderAt('/');
    const input = await openPalette();
    expect(input).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toHaveAttribute('aria-modal', 'true');
    fireEvent.change(input, { target: { value: 'soa-48h' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('where')).toHaveTextContent('/rules/soa-48h-wait');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves the active option with the arrows, traps Tab and closes on Esc', async () => {
    renderAt('/');
    const input = await openPalette();
    const first = screen.getAllByRole('option')[0];
    expect(first).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers New run and evidence export for the current run', async () => {
    renderAt('/runs/7d5698c9-0441');
    const input = await openPalette();
    expect(screen.getByRole('option', { name: /New run/ })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'export evidence' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mutate).toHaveBeenCalledWith({ scope: 'runs', id: '7d5698c9-0441', format: 'json' }, expect.any(Object));
  });
});
