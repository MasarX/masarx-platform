// domain-events.test.tsx — REAUDIT INSIGHTS §D2-B closure (W9-3).
//
// Module-level mount coverage for /insights/domain-events
// (DomainEventsModule). Asserts surface mounts with canonical
// "Domain · events" PageHeader and renders without throwing when caller
// has narrow read scope.

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { DomainEventsModule } from '../domain-events';

describe('DomainEventsModule (REAUDIT INSIGHTS §D2-B)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('mounts and renders the canonical PageHeader (Domain · events)', async () => {
    renderWithProviders(<DomainEventsModule />, { capabilities: ['observability.read'] });
    await waitFor(() => {
      expect(screen.getByText('Domain')).toBeTruthy();
      expect(screen.getByText('events')).toBeTruthy();
      expect(screen.queryByText(/You do not have permission/i)).toBeNull();
    });
    expect(screen.getByText('Domain event stream')).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/domain_events|Correlation/);
  });

  it('renders the observability-denied StateView when the caller has only narrow read scope', async () => {
    renderWithProviders(<DomainEventsModule />, { capabilities: ['shipments.read'] });
    await waitFor(() => {
      expect(screen.getByText('Domain')).toBeTruthy();
      expect(screen.getAllByText(/observability\.read/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/audit_log\.read/)).toBeNull();
    });
  });
});
