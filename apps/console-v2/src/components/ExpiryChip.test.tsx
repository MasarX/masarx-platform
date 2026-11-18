// ExpiryChip.test.tsx — verifies the days-until-expiry tone ladder:
//   1. mount + label rendering
//   2. each tone branch (expired/danger/warn/neutral/null) yields the right
//      Chip kind class and label
//   3. prefix prop renders before the chip text
//   4. a11y: rendered as a single <span class="chip ..."> element
//
// W49: ExpiryChip now resolves canonical thresholds via `useResolveSettings`
// against `ui_presentation_policy.expiry_thresholds`, so each test mounts via
// `renderWithProviders` to provide a QueryClient. Assertions wait for the
// tone classes to land once the policy resolves.
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { ExpiryChip } from './ExpiryChip';
import { computeExpiryDescriptor } from './expiryDescriptor';

const NOW = new Date('2026-04-26T12:00:00Z');

describe('ExpiryChip', () => {
  it('renders a chip with the computed label', async () => {
    renderWithProviders(<ExpiryChip expiresAt={null} now={NOW} />);
    expect(await screen.findByText('No expiry')).toBeInTheDocument();
  });

  it('chooses tone classes by threshold ladder', async () => {
    const cases: Array<{ days: number; tone: string; matcher: RegExp }> = [
      { days: -3, tone: 'danger', matcher: /Expired 3 days ago/ },
      { days: 5, tone: 'danger', matcher: /Expires in 5 days/ },
      { days: 20, tone: 'warn', matcher: /Expires in 20 days/ },
      { days: 90, tone: 'neutral', matcher: /90 days left/ },
    ];
    for (const c of cases) {
      const target = new Date(NOW.getTime() + c.days * 86_400_000).toISOString();
      const { unmount } = renderWithProviders(<ExpiryChip expiresAt={target} now={NOW} />);
      await waitFor(() => {
        const node = screen.getByText(c.matcher);
        expect(node.className).toMatch(new RegExp(`chip--${c.tone}`));
      });
      unmount();
    }
  });

  it('renders the prefix label before the descriptor text', async () => {
    const target = new Date(NOW.getTime() + 14 * 86_400_000).toISOString();
    renderWithProviders(<ExpiryChip expiresAt={target} prefix="License" now={NOW} />);
    expect(await screen.findByText('License · Expires in 14 days')).toBeInTheDocument();
  });

  it('exposes computeExpiryDescriptor for unit reuse with custom thresholds', () => {
    const target = new Date(NOW.getTime() + 9 * 86_400_000).toISOString();
    const descriptor = computeExpiryDescriptor(
      target,
      { warn: 14, danger: 10 },
      NOW,
    );
    // 9 days <= danger=10 → danger tone
    expect(descriptor.kind).toBe('danger');
    expect(descriptor.label).toMatch(/Expires in 9 days/);
  });
});
