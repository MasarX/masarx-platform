// CapacityGauge.test.tsx — circular gauge:
//   1. mount + percent rendering
//   2. tone classes flip by saturation thresholds
//   3. progressbar a11y attributes are emitted with the right values
//   4. label prop renders below the gauge
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapacityGauge } from './CapacityGauge';

describe('CapacityGauge', () => {
  it('renders the percent text and the textual label', () => {
    render(<CapacityGauge used={50} total={200} label="hub utilization" />);
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('hub utilization')).toBeInTheDocument();
  });

  it('flips tone class across the threshold ladder', () => {
    const { rerender } = render(<CapacityGauge used={10} total={100} />);
    expect(screen.getByText('10%').getAttribute('class')).toMatch(/--good/);
    rerender(<CapacityGauge used={75} total={100} />);
    expect(screen.getByText('75%').getAttribute('class')).toMatch(/--warn/);
    rerender(<CapacityGauge used={95} total={100} />);
    expect(screen.getByText('95%').getAttribute('class')).toMatch(/--danger/);
  });

  it('exposes progressbar a11y attributes with computed value', () => {
    render(<CapacityGauge used={42} total={140} label="Today's load" />);
    const bar = screen.getByRole('progressbar', { name: "Today's load" });
    expect(bar).toHaveAttribute('aria-valuenow', '30');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuetext', '42 of 140 used (30%)');
  });

  it('clamps and does not divide by zero when total <= 0', () => {
    render(<CapacityGauge used={5} total={0} label="Zero total" />);
    const bar = screen.getByRole('progressbar', { name: 'Zero total' });
    // ratio clamped to 1 when total is invalid → 100%
    expect(bar).toHaveAttribute('aria-valuenow', '100');
  });
});
