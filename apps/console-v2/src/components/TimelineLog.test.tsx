// TimelineLog.test.tsx — vertical event timeline:
//   1. mount + each event renders a row
//   2. group buckets (Today/Yesterday/This week/Earlier) appear by date
//   3. clicking a row with detail toggles aria-expanded + reveals region
//   4. role=region on the expanded detail is exposed for AT
//
// W49: TimelineLog now resolves canonical bucket labels/order via
// `useResolveSettings` against `ui_presentation_policy.timeline_buckets`, so
// each test mounts via `renderWithProviders` to provide a QueryClient.
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { TimelineLog, type TimelineEvent } from './TimelineLog';

const NOW = new Date('2026-04-26T15:00:00Z');

const EVENTS: TimelineEvent[] = [
  {
    id: 'e1',
    at: '2026-04-26T13:00:00Z', // today
    type: 'invoice.sent',
    actor: 'Mona',
    summary: 'Invoice INV-1024 emailed to customer',
    detail: <p>Detail body for e1</p>,
    tone: 'good',
  },
  {
    id: 'e2',
    at: '2026-04-25T17:30:00Z', // yesterday
    type: 'message.received',
    summary: 'Customer replied to thread',
    tone: 'neutral',
  },
  {
    id: 'e3',
    at: '2026-04-22T10:00:00Z', // this week
    type: 'shipment.exception',
    actor: 'System',
    summary: 'Address mismatch flagged',
    tone: 'warn',
  },
  {
    id: 'e4',
    at: '2026-04-12T08:00:00Z', // earlier
    type: 'driver.assigned',
    summary: 'Driver assigned',
    tone: 'neutral',
  },
];

describe('TimelineLog', () => {
  it('renders one row per event with summary text', async () => {
    renderWithProviders(<TimelineLog events={EVENTS} now={NOW} />);
    await waitFor(() => {
      expect(screen.getByText(/Invoice INV-1024 emailed to customer/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Customer replied to thread/)).toBeInTheDocument();
    expect(screen.getByText(/Address mismatch flagged/)).toBeInTheDocument();
    expect(screen.getByText(/Driver assigned/)).toBeInTheDocument();
  });

  it('groups events into Today/Yesterday/This week/Earlier buckets', async () => {
    renderWithProviders(<TimelineLog events={EVENTS} now={NOW} />);
    await waitFor(() => {
      expect(screen.getByText('Today')).toBeInTheDocument();
    });
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('This week')).toBeInTheDocument();
    expect(screen.getByText('Earlier')).toBeInTheDocument();
  });

  it('toggles expanded state on click and reveals the detail region', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TimelineLog events={EVENTS} now={NOW} />);
    const row = await screen.findByRole('button', { expanded: false, name: /Invoice INV-1024/ });
    await user.click(row);
    expect(screen.getByRole('region', { name: /invoice.sent details/i })).toBeInTheDocument();
    expect(screen.getByText('Detail body for e1')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { expanded: true, name: /Invoice INV-1024/ }),
    ).toBeInTheDocument();
  });

  it('respects initiallyExpanded for default-open events', async () => {
    renderWithProviders(<TimelineLog events={EVENTS} now={NOW} initiallyExpanded={['e1']} />);
    expect(
      await screen.findByRole('region', { name: /invoice.sent details/i }),
    ).toBeInTheDocument();
  });
});
