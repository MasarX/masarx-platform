// resolutions.test.tsx — REAUDIT INSIGHTS §D2-B closure (W9-3).
//
// Module-level mount coverage for /insights/resolutions
// (ResolutionsModule). Asserts surface mounts with the canonical
// "Settings · resolution log" PageHeader and renders without throwing
// when caller has narrow read scope.

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { ResolutionsModule } from '../resolutions';

describe('ResolutionsModule (REAUDIT INSIGHTS §D2-B)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('mounts and renders the canonical PageHeader (Settings · resolution log)', async () => {
    renderWithProviders(<ResolutionsModule />, { capabilities: ['observability.read'] });
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeTruthy();
      expect(screen.getByText('resolution log')).toBeTruthy();
      expect(screen.queryByText(/You do not have permission/i)).toBeNull();
    });
    expect(screen.getByText('Policy decision log')).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/settings_resolution_log/);
  });

  it('renders the observability-denied StateView when the caller has only narrow read scope', async () => {
    renderWithProviders(<ResolutionsModule />, { capabilities: ['shipments.read'] });
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeTruthy();
      expect(screen.getAllByText(/observability\.read/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/audit_log\.read/)).toBeNull();
    });
  });
});
