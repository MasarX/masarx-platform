// ui-events.test.tsx — REAUDIT INSIGHTS §D2-B closure (W9-3).
//
// Module-level mount coverage for /insights/ui-events (UiEventsModule).
// Asserts surface mounts with the canonical "UI · events" PageHeader and
// renders without throwing when caller has narrow read scope.

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { UiEventsModule } from '../ui-events';

describe('UiEventsModule (REAUDIT INSIGHTS §D2-B)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('mounts and renders the canonical PageHeader (UI · events)', async () => {
    renderWithProviders(<UiEventsModule />, { capabilities: ['observability.read'] });
    await waitFor(() => {
      expect(screen.getByText('UI')).toBeTruthy();
      expect(screen.getByText('events')).toBeTruthy();
      expect(screen.queryByText(/You do not have permission/i)).toBeNull();
    });
    expect(screen.getByText('UI event stream')).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/ui_event_log|ui_log_event_v1/);
  });

  it('renders the observability-denied StateView when the caller has only narrow read scope', async () => {
    renderWithProviders(<UiEventsModule />, { capabilities: ['shipments.read'] });
    await waitFor(() => {
      expect(screen.getByText('UI')).toBeTruthy();
      expect(screen.getAllByText(/observability\.read/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/audit_log\.read/)).toBeNull();
    });
  });
});
