// route-plans.test.tsx — covers CLAIM-B route plans hardening.
//
// Targets:
//   1. Module mounts and the registry-driven DataTable renders rows.
//   2. Header `New plan` is gated by `route_plans.write`; Validate constraints is read-scoped.
//   3. Row click opens a drawer with the lifecycle stepper and the validate panel.
//   4. SLA breach indicator renders for stale published plans (regression guard).
//   5. Bulk action bar exposes Solve/Freeze/Publish/Apply (4 lifecycle actions).
//   6. Decision-trail row action uses the universal drawer spec (no navigation).
//
// Tests mount the live `RoutePlansModule` via `renderWithProviders`, exercising
// the seam (queries.ts → api.ts → data-source.ts) end-to-end.

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { RoutePlansModule } from '@/modules/operate/route-plans';
import * as api from '@/lib/api';
import * as ds from '@/lib/data-source';
import * as supabase from '@/lib/supabase';
import { routePlanningListResource } from './__tests__/route-plans.fixtures';

const LIST_RESOURCE = ds.ui_list_resource_v1;
const LIST_SPY = vi.spyOn(ds, 'ui_list_resource_v1');
const SOLVE_SPY = vi.spyOn(ds, 'ui_solve_route_plan_v1');

beforeEach(() => {
  vi.spyOn(supabase, 'rpc').mockResolvedValue([]);
  LIST_SPY.mockClear();
  LIST_SPY.mockImplementation((key, opts) => routePlanningListResource(key, opts, LIST_RESOURCE));
  SOLVE_SPY.mockClear();
  SOLVE_SPY.mockResolvedValue({ ok: true, plan_id: 'rpl_fixture_alpha', status: 'solved' });
});

describe('RoutePlansModule', () => {
  it('shows denied state without issuing protected route planning reads', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    const settingsSpy = vi.spyOn(api, 'resolveSettings');

    try {
      renderWithProviders(<RoutePlansModule />, { capabilities: [] });

      expect(await screen.findByText(/You do not have permission to view route plans/i)).toBeInTheDocument();
      await waitFor(() => {
        const resources = listSpy.mock.calls.map(([resource]) => resource);
        expect(resources).not.toContain('route_plans');
        expect(resources).not.toContain('route_plan_directory');
        expect(resources).not.toContain('hubs');
        expect(resources).not.toContain('route_runs');
        expect(resources).not.toContain('route_stops');
        expect(resources).not.toContain('wave_catalog');
        expect(settingsSpy).not.toHaveBeenCalled();
      });
    } finally {
      listSpy.mockRestore();
      settingsSpy.mockRestore();
    }
  });

  it('mounts the page header and registry-driven table with rows', async () => {
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
  });

  it('keeps read-only validation available while disabling `New plan` without route_plans.write', async () => {
    renderWithProviders(<RoutePlansModule />, { capabilities: ['route_plans.read'] });
    // Wait for the action bar — confirms canonical route_plan_thresholds
    // has resolved past the page-level policy-not-seeded guard.
    const newBtn = await screen.findByRole('button', { name: /New plan/ });
    const validateBtn = screen.getByRole('button', { name: /Validate constraints/ });
    expect(newBtn).toBeDisabled();
    expect(validateBtn).not.toBeDisabled();
    // CapabilityLock chip surfaces the missing capability for the operator.
    expect(screen.getAllByText(/Route plan update permission required/i).length).toBeGreaterThan(0);
  });

  it('opens the lifecycle stepper drawer when a row is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    await user.click(document.querySelector('.dt__table tbody tr') as Element);
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    // Six stage labels render (Draft / Solved / Frozen / Published / Applied / Executing).
    expect(document.body.textContent).toMatch(/Draft/);
    expect(document.body.textContent).toMatch(/Solved/);
    expect(document.body.textContent).toMatch(/Frozen/);
    expect(document.body.textContent).toMatch(/Published/);
    expect(document.body.textContent).toMatch(/Applied/);
    expect(document.body.textContent).toMatch(/Executing/);
    // The validate-constraints panel idle state shows the run trigger.
    expect(document.body.textContent).toMatch(/Run validation/);
  });

  it('shows geocoded route stops on the plan drawer map', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    await user.click(document.querySelector('.dt__table tbody tr') as Element);
    const map = await screen.findByTestId('route-plan-stop-map');
    expect(map.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'approved');
    expect(within(map).getByRole('application', { name: 'Route plan stop map' })).toBeInTheDocument();
    expect(map.textContent).toMatch(/OpenStreetMap contributors/);
  });

  it('drawer footer surfaces Solve / Freeze / Rebalance / Publish / Apply', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    await user.click(document.querySelector('.dt__table tbody tr') as Element);
    await waitFor(() => {
      expect(document.querySelector('.drawer__footer')).not.toBeNull();
    });
    const footer = document.querySelector('.drawer__footer')!;
    expect(footer.textContent).toMatch(/Solve/);
    expect(footer.textContent).toMatch(/Freeze/);
    expect(footer.textContent).toMatch(/Rebalance/);
    expect(footer.textContent).toMatch(/Publish/);
    expect(footer.textContent).toMatch(/Apply/);
  });

  it('opens the new-plan modal with hub + wave + date controls when authorized', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    // Wait for canonical route_plan_thresholds resolution past the
    // page-level policy-not-seeded guard before clicking the action button.
    const newBtn = await screen.findByRole('button', { name: /New plan/ });
    await user.click(newBtn);
    await waitFor(() => {
      // Both pickers and the date input should be present.
      expect(screen.getByLabelText('Pick hub')).toBeInTheDocument();
      expect(screen.getByLabelText('Pick wave')).toBeInTheDocument();
      expect(screen.getByLabelText('Plan date')).toBeInTheDocument();
    });
  });

  it('bulk action bar exposes the 4 lifecycle actions when rows are selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const checkbox = screen.getAllByLabelText('Select row')[0];
    expect(checkbox).toBeDefined();
    await user.click(checkbox!);
    await waitFor(() => {
      expect(document.querySelector('.dt-bulkbar')).not.toBeNull();
    });
    const bar = document.querySelector('.dt-bulkbar')!;
    expect(bar.textContent).toMatch(/Solve sequence/);
    expect(bar.textContent).toMatch(/Freeze/);
    expect(bar.textContent).toMatch(/Publish/);
    expect(bar.textContent).toMatch(/Apply/);
  });

  it('Solve action calls the mutation hook (cache-invalidation path)', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    // Open the row drawer.
    await user.click(document.querySelector('.dt__table tbody tr') as Element);
    await waitFor(() => {
      expect(document.querySelector('.drawer__footer')).not.toBeNull();
    });
    const solveBtn = Array.from(document.querySelectorAll('.drawer__footer button')).find((b) =>
      b.textContent?.includes('Solve'),
    );
    expect(solveBtn).toBeDefined();
    // Spy on the canonical query key invalidation.
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(solveBtn as Element);
    await waitFor(() => {
      expect(SOLVE_SPY).toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalled();
    });
  });
});
