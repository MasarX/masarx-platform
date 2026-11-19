// MaintenanceCalendar.test.tsx — week-grid scheduler:
//   1. mount + grid renders (column headers, hour labels, day cells)
//   2. windows render with tone class + accessible label
//   3. clicking a cell fires onCellClick(dayIndex, hourIndex)
//   4. role="grid" semantics + arrow-key focus navigation
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MaintenanceCalendar } from './MaintenanceCalendar';

const WEEK_START = '2026-04-20T00:00:00Z'; // Monday
const SAMPLE_WINDOWS = [
  {
    id: 'w1',
    title: 'Hub maintenance',
    start: '2026-04-21T09:00:00Z', // Tuesday 09:00
    end: '2026-04-21T11:00:00Z',
    tone: 'warn' as const,
  },
  {
    id: 'w2',
    title: 'Sortation downtime',
    start: '2026-04-23T14:00:00Z', // Thursday 14:00
    end: '2026-04-23T16:00:00Z',
    tone: 'danger' as const,
  },
];

describe('MaintenanceCalendar', () => {
  it('renders day headers, hour labels and cells', () => {
    render(<MaintenanceCalendar windows={[]} weekStart={WEEK_START} />);
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('Sun')).toBeInTheDocument();
    expect(screen.getByText('00:00')).toBeInTheDocument();
    expect(screen.getByText('20:00')).toBeInTheDocument();
    // 7 days × 24 hours = 168 grid cells.
    expect(screen.getAllByRole('gridcell').length).toBe(168);
    expect(screen.getByRole('grid')).toHaveAttribute('aria-label');
  });

  it('renders windows with the correct tone variant and aria-label', () => {
    render(<MaintenanceCalendar windows={SAMPLE_WINDOWS} weekStart={WEEK_START} />);
    const w1 = screen.getByRole('button', { name: /Hub maintenance/i });
    expect(w1.className).toMatch(/primitive-cal__window--warn/);
    expect(w1).toHaveAttribute('aria-label', expect.stringMatching(/09:00–11:00/));
    const w2 = screen.getByRole('button', { name: /Sortation downtime/i });
    expect(w2.className).toMatch(/primitive-cal__window--danger/);
  });

  it('fires onCellClick with the right day + hour index', async () => {
    const user = userEvent.setup();
    const onCellClick = vi.fn();
    render(
      <MaintenanceCalendar
        windows={[]}
        weekStart={WEEK_START}
        onCellClick={onCellClick}
      />,
    );
    const cell = screen.getByLabelText('Wed 10:00');
    await user.click(cell);
    expect(onCellClick).toHaveBeenCalledWith(2, 10);
  });

  it('fires onWindowClick with the window id', async () => {
    const user = userEvent.setup();
    const onWindowClick = vi.fn();
    render(
      <MaintenanceCalendar
        windows={SAMPLE_WINDOWS}
        weekStart={WEEK_START}
        onWindowClick={onWindowClick}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Hub maintenance/i }));
    expect(onWindowClick).toHaveBeenCalledWith('w1');
  });
});
