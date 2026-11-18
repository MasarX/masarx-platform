// traces.test.tsx — REAUDIT INSIGHTS §D2-B closure (W9-3).
//
// Module-level mount coverage for /insights/traces (TracesModule).
// Asserts surface mounts with the canonical "Activity history" PageHeader
// and renders without throwing when caller has narrow read scope.

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { TracesModule } from '../traces';

describe('TracesModule (REAUDIT INSIGHTS §D2-B)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('mounts and renders the canonical PageHeader (Activity · history)', async () => {
    renderWithProviders(<TracesModule />, { capabilities: ['observability.read'] });
    await waitFor(() => {
      // PageHeader uses titleAccent="Activity" + titlePlain="history".
      expect(screen.getByText('Activity')).toBeTruthy();
      expect(screen.getByText('history')).toBeTruthy();
      expect(screen.queryByText(/You do not have permission/i)).toBeNull();
    });
    // The activity page reaches lookup once mounted; we don't assert on data
    // presence because the seed correlation reference may differ.
    expect(screen.getByTestId('insights-traces-page')).toBeTruthy();
    expect(screen.getByPlaceholderText('Activity reference')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Find activity' })).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(
      /ui_get_trace_v1\(correlation_id\)|Correlation ID \(try cor_9821\)|Copy ID|Fetch trace/,
    );
  });

  it('renders the observability-denied StateView when the caller has only narrow read scope', async () => {
    renderWithProviders(<TracesModule />, { capabilities: ['shipments.read'] });
    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeTruthy();
      expect(screen.getByText(/activity history access/i)).toBeTruthy();
      expect(screen.queryByText(/audit_log\.read/)).toBeNull();
    });
  });
});
