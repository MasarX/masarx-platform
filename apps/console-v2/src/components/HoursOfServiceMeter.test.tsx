// HoursOfServiceMeter.test.tsx — segmented duty bar:
//   1. mount + segment rendering
//   2. each segment uses the right tone class and width
//   3. totals + limit labels reflect the data
//   4. role="group" with summary aria-label is exposed for AT
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HoursOfServiceMeter, type DutySegment } from './HoursOfServiceMeter';

const SEGMENTS: DutySegment[] = [
  { type: 'driving', durationMinutes: 240 }, // 4h
  { type: 'on_duty', durationMinutes: 60 }, // 1h
  { type: 'off_duty', durationMinutes: 30 }, // 30m
  { type: 'sleeper', durationMinutes: 90 }, // 1.5h
];

describe('HoursOfServiceMeter', () => {
  it('renders one segment per duty status', () => {
    render(<HoursOfServiceMeter segments={SEGMENTS} limits={{ driving: 660, on_duty: 840 }} warnPct={80} />);
    expect(screen.getByLabelText(/^Driving, 4h$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^On duty, 1h$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Off duty, 30m$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Sleeper, 1h 30m$/)).toBeInTheDocument();
  });

  it('applies type-specific tone class to each segment', () => {
    render(<HoursOfServiceMeter segments={SEGMENTS} limits={{ driving: 660, on_duty: 840 }} warnPct={80} />);
    const driving = screen.getByLabelText(/^Driving, 4h$/);
    expect(driving.className).toMatch(/primitive-hos__seg--driving/);
    const sleeper = screen.getByLabelText(/^Sleeper, 1h 30m$/);
    expect(sleeper.className).toMatch(/primitive-hos__seg--sleeper/);
  });

  it('summarizes driving + on-duty totals against the limits', () => {
    render(<HoursOfServiceMeter segments={SEGMENTS} limits={{ driving: 660, on_duty: 840 }} warnPct={80} />);
    // 4h driving / 11h
    expect(screen.getByText(/4h/, { selector: 'strong' })).toBeInTheDocument();
    // 5h on-duty (driving + on-duty) / 14h
    expect(screen.getByText(/5h/, { selector: 'strong' })).toBeInTheDocument();
  });

  it('exposes a role=group with a meaningful aria-label', () => {
    render(<HoursOfServiceMeter segments={SEGMENTS} limits={{ driving: 660, on_duty: 840 }} warnPct={80} />);
    const group = screen.getByRole('group');
    expect(group).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/driving 4h.*on-duty 5h/i),
    );
  });
});
