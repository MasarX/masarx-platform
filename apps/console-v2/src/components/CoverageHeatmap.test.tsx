// CoverageHeatmap.test.tsx — 7×24 SVG density grid:
//   1. mount + 168 cells render with axis labels
//   2. intensity flows into the cell aria-label as a percentage
//   3. onCellClick fires with the right (day, hour)
//   4. role=grid + role=gridcell semantics expose to AT
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoverageHeatmap } from './CoverageHeatmap';

describe('CoverageHeatmap', () => {
  it('renders 168 cells and standard axis labels', () => {
    render(<CoverageHeatmap cells={[]} />);
    expect(screen.getAllByRole('gridcell').length).toBe(168);
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('Sun')).toBeInTheDocument();
    expect(screen.getByText('00')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('renders intensity into aria-label saturation percentage', () => {
    render(
      <CoverageHeatmap
        cells={[
          { dayIndex: 1, hourIndex: 14, intensity: 0.67 },
          { dayIndex: 4, hourIndex: 9, intensity: 1 },
        ]}
      />,
    );
    expect(screen.getByLabelText('Tue 14:00 · 67% saturation')).toBeInTheDocument();
    expect(screen.getByLabelText('Fri 09:00 · 100% saturation')).toBeInTheDocument();
    // Default zero intensity for an unsupplied cell.
    expect(screen.getByLabelText('Wed 03:00 · 0% saturation')).toBeInTheDocument();
  });

  it('fires onCellClick with the right indices', async () => {
    const user = userEvent.setup();
    const onCellClick = vi.fn();
    render(<CoverageHeatmap cells={[]} onCellClick={onCellClick} />);
    await user.click(screen.getByLabelText('Thu 21:00 · 0% saturation'));
    expect(onCellClick).toHaveBeenCalledWith(3, 21);
  });

  it('exposes role=grid with row/column counts', () => {
    render(<CoverageHeatmap cells={[]} />);
    const grid = screen.getByRole('grid', { name: /Coverage by day and hour/i });
    expect(grid).toHaveAttribute('aria-rowcount', '7');
    expect(grid).toHaveAttribute('aria-colcount', '24');
  });
});
