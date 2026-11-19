// decisions.test.tsx — REAUDIT INSIGHTS §D2-B closure (W9-3).
//
// Module-level mount coverage for /insights/decisions (DecisionsModule).
// Asserts surface mounts with the canonical decision_log seam and applies
// the capability-denied StateView when the caller lacks `decisions.read`
// (or, where the registry uses an alternate gate, no insights capability
// at all). We avoid asserting on filter/drawer flow here — those are
// covered by behavior tests; this file's job is mount-correctness.

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { DecisionsModule } from '../decisions';

describe('DecisionsModule (REAUDIT INSIGHTS §D2-B)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('mounts and renders the canonical PageHeader (Decision · log)', async () => {
    renderWithProviders(<DecisionsModule />, { capabilities: ['observability.read'] });
    await waitFor(() => {
      // PageHeader uses titleAccent="Decision" + titlePlain="log".
      expect(screen.getByText('Decision')).toBeTruthy();
      expect(screen.getByText('log')).toBeTruthy();
      expect(screen.queryByText(/You do not have permission/i)).toBeNull();
    });
    expect(screen.getByText('Decision log')).toBeTruthy();
    expect(screen.getByTestId('decisions-stream-mode').textContent ?? '').toMatch(/Preview event stream|Live event stream/);
    expect(document.body.textContent ?? '').not.toMatch(
      /2AM debugging|2AM-debugging|decision_log ·|PREVIEW · synthetic|Start live tail|Pause live tail/,
    );
  });

  it('renders the observability-denied StateView when the caller has only narrow read scope', async () => {
    renderWithProviders(<DecisionsModule />, { capabilities: ['shipments.read'] });
    await waitFor(() => {
      expect(screen.getByText('Decision')).toBeTruthy();
      expect(screen.getAllByText(/observability\.read/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/audit_log\.read/)).toBeNull();
    });
  });
});
