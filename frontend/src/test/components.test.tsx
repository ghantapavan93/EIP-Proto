import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '../components/ui/DataTable';
import { Drawer } from '../components/ui/Drawer';
import { NavRail } from '../components/layout/NavRail';

interface Row {
  id: string;
  name: string;
}

const rows: Row[] = [{ id: 'r1', name: 'first' }];

function Table({ onRowClick, onCheck }: { onRowClick: (r: Row) => void; onCheck: () => void }) {
  const columns: ColumnDef<Row, unknown>[] = [
    {
      id: 'select',
      header: 'Select',
      cell: () => <input type="checkbox" aria-label="pick" onChange={onCheck} onClick={(e) => e.stopPropagation()} />,
    },
    { header: 'Name', accessorKey: 'name', cell: (c) => <a href="#inner">{c.row.original.name}</a> },
  ];
  return <DataTable columns={columns} data={rows} getRowId={(r) => r.id} onRowClick={onRowClick} />;
}

describe('DataTable row keyboard handling', () => {
  it('activates the row on Enter / Space only when the row itself has focus', () => {
    const onRowClick = vi.fn();
    render(<Table onRowClick={onRowClick} onCheck={() => undefined} />);
    const row = screen.getAllByRole('row')[1];
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it('leaves Space on an inner checkbox and Enter on an inner link alone', () => {
    const onRowClick = vi.fn();
    render(<Table onRowClick={onRowClick} onCheck={() => undefined} />);
    const checkbox = screen.getByRole('checkbox', { name: 'pick' });
    const spaceOnCheckbox = fireEvent.keyDown(checkbox, { key: ' ' });
    const link = screen.getByRole('link', { name: 'first' });
    const enterOnLink = fireEvent.keyDown(link, { key: 'Enter' });
    expect(onRowClick).not.toHaveBeenCalled();
    // not preventDefault-ed, so the browser still toggles the box / follows the link
    expect(spaceOnCheckbox).toBe(true);
    expect(enterOnLink).toBe(true);
  });
});

function DrawerHost({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  return (
    // a new inline onClose on every render — the case that used to steal focus
    <Drawer open title="Test drawer" onClose={() => onClose()}>
      <input aria-label="field" value={text} onChange={(e) => setText(e.target.value)} />
    </Drawer>
  );
}

describe('Drawer focus', () => {
  it('focuses the panel once on open and does not steal focus back on parent re-render', () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      render(<DrawerHost onClose={onClose} />);
      act(() => {
        vi.runAllTimers();
      });
      expect(screen.getByRole('dialog')).toHaveFocus();

      const input = screen.getByRole('textbox', { name: 'field' });
      input.focus();
      fireEvent.change(input, { target: { value: 'a' } });
      fireEvent.change(input, { target: { value: 'ab' } });
      act(() => {
        vi.runAllTimers();
      });
      expect(input).toHaveFocus();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('NavRail below lg', () => {
  it('renders the drawer only when open and closes it on navigation or Esc', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <NavRail openReviewCount={3} mobileOpen={false} onMobileClose={onClose} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Close navigation' })).toBeNull();

    rerender(
      <MemoryRouter>
        <NavRail openReviewCount={3} mobileOpen onMobileClose={onClose} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument();
    // desktop rail + drawer both list the nav
    expect(screen.getAllByRole('link', { name: /Runs/ })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('link', { name: /Runs/ })[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId('nav-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
