// service-offerings.test.tsx — CLAIM-CATALOG-OFFERINGS (Wave 2, Phase B) +
// CLAIM-CUSTOMERS-CATALOG-WIRING (Phase C3) mutation wiring.
//
// Coverage anchors (mirrors public.service_levels + public.service_offerings):
//   1. Mount + KPI strip + card grid render with seed data.
//   2. Card tier badge tone matches priority_rank from service_levels.metadata
//      (express → "good", same_day → "warn", white_glove → "danger").
//   3. Capability gate on header New / bulk Toggle / bulk Archive when
//      `service_offerings.write` is missing — buttons disabled + lock chip.
//   4. Drawer tabs render (Profile · Pricing · SLA terms · Coverage · Subs)
//      and tab-switch updates the active tab visual contract.
//   5. New offering composer fires service_offering_create_v1 with canonical args (Phase C3).
//   6. Edit price drawer button fires service_offering_update_v1 with metadata (Phase C3).
//   7. Bulk archive iterates service_offering_archive_v1 across active offerings (Phase C3).
//   8. Bulk toggle iterates service_offering_toggle_v1 across all offerings (Phase C3).
//
// Backend SSOT references:
//   • public.service_levels      — supabase/migrations/202601212700_branch_capacity_catalog.sql:68
//   • public.service_offerings   — supabase/migrations/202601212700_branch_capacity_catalog.sql:98
//   • Phase B6 RPCs              — supabase/migrations/20260428020{1..4}_service_offering_*_v1.sql
//   • RBAC write policy          — supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql
//                                  (canonical: agreements.write; surface
//                                  alias: service_offerings.write)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ServiceOfferingsModule, serviceOfferingDisplay } from '@/modules/catalog/service-offerings';
import * as apiMod from '@/lib/api';
import * as toastStore from '@/components/toastStore';

beforeEach(() => {
  window.history.pushState(null, '', '/catalog/service-offerings');
});

describe('ServiceOfferingsModule', () => {
  it('resolves missing offering display metadata without exposing raw internal IDs', () => {
    const display = serviceOfferingDisplay(
      {
        id: 'sof_internal_only',
        service_level_id: 'sl_internal',
        branch_id: 'br_internal',
        effective_from: '2026-05-04T00:00:00Z',
        priority: 10,
        is_active: true,
        metadata: {},
      } as never,
      { key: 'express', name: 'Express' } as never,
      { name: 'Riyadh Hub', city: 'Riyadh' } as never,
    );

    expect(display.name).toBe('Express · Riyadh Hub');
    expect(display.slug).toBe('Express · Riyadh');
    expect(display.name).not.toContain('sof_internal_only');
    expect(display.slug).not.toContain('sof_internal_only');
  });

  it('renders the page header + KPI strip + card grid', async () => {
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read', 'service_offerings.write'],
    });
    expect(
      await screen.findByRole('heading', { name: /Service offerings/ }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Catalog access.*catalog update/),
    ).toBeInTheDocument();
    // KPI strip
    const kpi = await screen.findByTestId('offerings-kpi-strip');
    expect(within(kpi).getByText(/Total offerings/)).toBeInTheDocument();
    expect(within(kpi).getByText(/Active$/)).toBeInTheDocument();
    expect(within(kpi).getByText(/Archived$/)).toBeInTheDocument();
    expect(within(kpi).getByText(/Price range/)).toBeInTheDocument();
    // Card grid lands and contains the seeded "Air-Bridge Express" card.
    const grid = await screen.findByTestId('offerings-grid');
    expect(within(grid).getByTestId('offering-card-sof_exp_airbridge')).toBeInTheDocument();
  });

  it('card tier badge tone reflects service_levels.metadata.tone (W50 canonical SSOT)', async () => {
    // W50 closure — chip tone resolves strictly from
    // `service_levels.metadata.tone` (seed: catalog-offerings.js; backend
    // mirror: 202605020900_w51_service_levels_metadata_tone.sql).
    // Replaces the prior inline `priority_rank` magic-number ladder.
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read'],
    });
    // Express card (metadata.tone='good')
    const expressCard = await screen.findByTestId('offering-card-sof_exp_airbridge');
    const expressTier = within(expressCard).getByText('Express');
    expect(expressTier.className).toMatch(/chip--good/);

    // Same-day card (metadata.tone='warn')
    const sameDayCard = await screen.findByTestId('offering-card-sof_sd_ruh');
    const sameDayTier = within(sameDayCard).getByText('Same day');
    expect(sameDayTier.className).toMatch(/chip--warn/);

    // White-glove card (metadata.tone='danger')
    const wgCard = await screen.findByTestId('offering-card-sof_wg_ruh');
    const wgTier = within(wgCard).getByText('White glove');
    expect(wgTier.className).toMatch(/chip--danger/);
  });

  it('keeps linked service-level labels visible when optional tone metadata is absent', async () => {
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      (async (resource: string, opts?: unknown) => {
        if (resource === 'service_level_directory') {
          return {
            rows: [{
              id: 'sl_a2z_priority',
              key: 'a2z_priority',
              name: 'A2Z Priority',
              is_active: true,
              metadata: { priority_rank: 45, sla_minutes: 120 },
            }],
            total: 1,
            page: 0,
            page_size: 100,
          };
        }
        if (resource === 'service_offering_directory') {
          return {
            rows: [{
              id: 'sof_a2z_priority',
              service_level_id: 'sl_a2z_priority',
              branch_id: 'br_a2z',
              effective_from: '2026-06-15T00:00:00Z',
              priority: 10,
              is_active: true,
              metadata: {
                display: { name: 'A2Z Priority Offering', slug: 'a2z-priority', status: 'active' },
                base_price: 45,
                currency: 'SAR',
                max_weight_kg: 10,
              },
            }],
            total: 1,
            page: 0,
            page_size: 100,
          };
        }
        if (resource === 'branches') {
          return {
            rows: [{ id: 'br_a2z', name: 'A2Z Riyadh Branch', city: 'Riyadh' }],
            total: 1,
            page: 0,
            page_size: 100,
          };
        }
        if (resource === 'zones' || resource === 'subscriptions') {
          return { rows: [], total: 0, page: 0, page_size: 100 };
        }
        return realList(resource, opts as never);
      }) as typeof apiMod.ui_list_resource_v1,
    );

    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read'],
    });

    const card = await screen.findByTestId('offering-card-sof_a2z_priority');
    expect(within(card).getByText('A2Z Priority')).toBeInTheDocument();
    expect(within(card).queryByText('A2Z Priority (missing)')).not.toBeInTheDocument();
    listSpy.mockRestore();
  });

  it('recovers from empty New offering selectors by provisioning first tenant product context', async () => {
    const user = userEvent.setup();
    const serviceLevels: Array<Record<string, unknown>> = [];
    const branches: Array<Record<string, unknown>> = [];
    const zones: Array<Record<string, unknown>> = [];
    const offerings: Array<Record<string, unknown>> = [];
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      (async (resource: string, opts?: unknown) => {
        if (resource === 'service_level_directory') {
          return { rows: serviceLevels, total: serviceLevels.length, page: 0, page_size: 100 };
        }
        if (resource === 'service_offering_directory') {
          return { rows: offerings, total: offerings.length, page: 0, page_size: 100 };
        }
        if (resource === 'branches') {
          return { rows: branches, total: branches.length, page: 0, page_size: 100 };
        }
        if (resource === 'zones') {
          return { rows: zones, total: zones.length, page: 0, page_size: 100 };
        }
        if (resource === 'subscriptions') {
          return { rows: [], total: 0, page: 0, page_size: 100 };
        }
        return realList(resource, opts as never);
      }) as typeof apiMod.ui_list_resource_v1,
    );
    const createLevelSpy = vi.spyOn(apiMod, 'service_level_create_v1').mockImplementation(async (args) => {
      serviceLevels.push({
        id: 'sl_first_tenant',
        organization_id: args.organization_id,
        key: args.key,
        name: args.name,
        description: args.description,
        is_active: true,
        metadata: args.metadata,
      });
      return { ok: true, service_level_id: 'sl_first_tenant' } as never;
    });
    const createBranchSpy = vi.spyOn(apiMod, 'branch_create_v1').mockImplementation(async (args) => {
      branches.push({
        id: 'br_first_tenant',
        organization_id: args.organization_id,
        name: args.name,
        branch_type: args.branch_type,
        city: (args.address as { city?: string } | undefined)?.city,
        metadata: args.metadata,
      });
      return { ok: true, branch_id: 'br_first_tenant' } as never;
    });
    const createZoneSpy = vi.spyOn(apiMod, 'zone_create_v1').mockImplementation(async (args) => {
      zones.push({
        id: 'zone_first_tenant',
        organization_id: args.organization_id,
        name: args.name,
        slug: 'first-tenant-zone',
        is_active: true,
      });
      return { ok: true, zone_id: 'zone_first_tenant', initial_district_count: 0 } as never;
    });
    const assignSpy = vi.spyOn(apiMod, 'branch_zone_assign_v1').mockResolvedValue({
      ok: true,
      branch_zone_id: 'bz_first_tenant',
      branch_id: 'br_first_tenant',
      zone_id: 'zone_first_tenant',
    } as never);
    const createOfferingSpy = vi.spyOn(apiMod, 'service_offering_create_v1').mockImplementation(async (args) => {
      offerings.push({
        id: 'sof_first_tenant',
        service_level_id: args.service_level_id,
        branch_id: args.branch_id,
        zone_id: args.zone_id,
        effective_from: '2026-06-15T00:00:00Z',
        priority: args.priority ?? 0,
        is_active: true,
        metadata: args.metadata,
      });
      return { ok: true, service_offering_id: 'sof_first_tenant' } as never;
    });

    try {
      renderWithProviders(<ServiceOfferingsModule />, {
        identity: {
          capabilities: [
            'service_offerings.read',
            'service_offerings.write',
            'agreements.write',
            'branches.write',
            'zones.write',
          ],
          scope: { tenant: { id: 'org_first_tenant', label: 'First Tenant', rank: 2 } },
        },
      });

      expect(await screen.findByText('No service offerings configured for this tenant yet.')).toBeInTheDocument();
      await user.click(await screen.findByRole('button', { name: 'New offering' }));
      expect(await screen.findByTestId('product-context-setup-body')).toBeInTheDocument();

      await user.type(await screen.findByLabelText('Service level name'), 'Tenant Standard');
      await user.type(await screen.findByLabelText('SLA minutes'), '1440');
      await user.type(await screen.findByLabelText('Branch name'), 'Tenant Riyadh Branch');
      const branchTypeInput = await screen.findByLabelText('Branch type');
      if (branchTypeInput instanceof HTMLSelectElement) {
        await user.selectOptions(branchTypeInput, branchTypeInput.options[1]?.value ?? '');
      } else {
        await user.type(branchTypeInput, 'tenant_dispatch');
      }
      const branchStatusInput = await screen.findByLabelText('Branch status');
      if (branchStatusInput instanceof HTMLSelectElement) {
        await user.selectOptions(branchStatusInput, branchStatusInput.options[1]?.value ?? '');
      } else {
        await user.type(branchStatusInput, 'tenant_active');
      }
      const timezoneInput = await screen.findByLabelText('Branch timezone');
      await user.clear(timezoneInput);
      await user.type(timezoneInput, 'Asia/Riyadh');
      await user.type(await screen.findByLabelText('Branch city'), 'Riyadh');
      await user.type(await screen.findByLabelText('Daily capacity'), '250');
      await user.click(await screen.findByLabelText('Coverage zone'));
      await user.type(await screen.findByLabelText('Zone name'), 'Tenant Riyadh Zone');
      await user.type(await screen.findByLabelText('Offering name'), 'Tenant Next Day');
      await user.type(await screen.findByLabelText('Base price'), '35');
      const currencyInput = await screen.findByLabelText('Currency');
      await user.clear(currencyInput);
      await user.type(currencyInput, 'SAR');
      await user.click(await screen.findByRole('button', { name: 'Provision setup' }));

      await waitFor(() => expect(createLevelSpy).toHaveBeenCalledWith(
        expect.objectContaining({ organization_id: 'org_first_tenant', name: 'Tenant Standard' }),
      ));
      expect(createBranchSpy).toHaveBeenCalledWith(expect.objectContaining({
        organization_id: 'org_first_tenant',
        name: 'Tenant Riyadh Branch',
        timezone: 'Asia/Riyadh',
      }));
      expect(createZoneSpy).toHaveBeenCalledWith(expect.objectContaining({
        organization_id: 'org_first_tenant',
        name: 'Tenant Riyadh Zone',
      }));
      expect(assignSpy).toHaveBeenCalledWith({
        branch_id: 'br_first_tenant',
        zone_id: 'zone_first_tenant',
        priority: 0,
      });
      expect(createOfferingSpy).toHaveBeenCalledWith(expect.objectContaining({
        service_level_id: 'sl_first_tenant',
        branch_id: 'br_first_tenant',
        zone_id: 'zone_first_tenant',
      }));
      await waitFor(() => {
        expect(document.querySelector('.drawer')?.textContent ?? '').toContain('Tenant Next Day');
      });
      expect(document.querySelector('.drawer')?.textContent ?? '').toContain('Tenant Standard');
      expect(document.querySelector('.drawer')?.textContent ?? '').toContain('Tenant Riyadh Branch');
      expect(document.querySelector('.drawer')?.textContent ?? '').toContain('Tenant Riyadh Zone');
    } finally {
      listSpy.mockRestore();
      createLevelSpy.mockRestore();
      createBranchSpy.mockRestore();
      createZoneSpy.mockRestore();
      assignSpy.mockRestore();
      createOfferingSpy.mockRestore();
    }
  });

  it('disables New / Toggle / Archive + shows lock chip when catalog update access is missing', async () => {
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read'],
    });
    const newBtn = await screen.findByRole('button', { name: /New offering/ });
    const toggleBtn = await screen.findByRole('button', { name: /Toggle availability/ });
    const archiveBtn = await screen.findByRole('button', { name: /Archive/ });
    expect(newBtn).toBeDisabled();
    expect(toggleBtn).toBeDisabled();
    expect(archiveBtn).toBeDisabled();
    // CapabilityLock surfaces the canonical capability string.
    expect(screen.getAllByText('Service Offering Update permission required').length).toBeGreaterThan(0);
  });

  it('opens drawer with all 5 tabs and Edit price gates on capability', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read'], // explicit READ only
    });
    const card = await screen.findByTestId('offering-card-sof_exp_airbridge');
    await user.click(card);
    // Drawer tabs render.
    const tablist = await screen.findByTestId('offering-drawer-tabs');
    expect(within(tablist).getByTestId('offering-tab-profile')).toBeInTheDocument();
    expect(within(tablist).getByTestId('offering-tab-pricing')).toBeInTheDocument();
    expect(within(tablist).getByTestId('offering-tab-sla')).toBeInTheDocument();
    expect(within(tablist).getByTestId('offering-tab-coverage')).toBeInTheDocument();
    expect(within(tablist).getByTestId('offering-tab-subscriptions')).toBeInTheDocument();
    // Switch to Pricing — Edit price button must be disabled (READ only) and
    // the lock chip must surface.
    const drawer = document.querySelector('.drawer') as HTMLElement | null;
    expect(drawer?.textContent).not.toMatch(/key=|svl_/i);
    await user.click(within(tablist).getByTestId('offering-tab-pricing'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Edit price/ })).toBeDisabled();
    });
    expect(screen.getAllByText('Service Offering Update permission required').length).toBeGreaterThan(0);
    // Pricing breakpoints render row-driven from metadata.
    expect(screen.getByTestId('offering-pricing-bp-0')).toBeInTheDocument();
  });

  it('subscriptions tab surfaces the live count when subscriptions registry is wired', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read'],
    });
    const card = await screen.findByTestId('offering-card-sof_std_metro');
    await user.click(card);
    const tablist = await screen.findByTestId('offering-drawer-tabs');
    await user.click(within(tablist).getByTestId('offering-tab-subscriptions'));
    await waitFor(() => {
      expect(screen.getByTestId('offering-subscriptions-count')).toBeInTheDocument();
    });
  });

  it('subscriptions tab fails closed without preview metadata counts when registry is unavailable', async () => {
    const user = userEvent.setup();
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      ((resource: string, opts?: unknown) => {
        if (resource === 'subscriptions') {
          return Promise.reject(new Error('subscriptions registry unavailable'));
        }
        return originalList(resource, opts as never);
      }) as typeof apiMod.ui_list_resource_v1,
    );

    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read'],
    });
    const card = await screen.findByTestId('offering-card-sof_std_metro');
    await user.click(card);
    const tablist = await screen.findByTestId('offering-drawer-tabs');
    await user.click(within(tablist).getByTestId('offering-tab-subscriptions'));

    await waitFor(() => {
      expect(screen.getByText('Unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByText('PREVIEW')).toBeNull();
    expect(
      screen.getByText(/Live subscription count is not available for this environment/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId('offering-subscriptions-count')).not.toHaveTextContent(/\d/);

    listSpy.mockRestore();
  });

  it('coverage tab links to /network/zones', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read'],
    });
    const card = await screen.findByTestId('offering-card-sof_eco_kingdom');
    await user.click(card);
    const tablist = await screen.findByTestId('offering-drawer-tabs');
    await user.click(within(tablist).getByTestId('offering-tab-coverage'));
    await waitFor(() => {
      const link = screen.getByTestId('offering-coverage-zones-link');
      expect(link).toHaveAttribute('href', '/network/zones');
    });
  });

  it('opens the offering drawer from a row deep-link focus URL', async () => {
    window.history.pushState(null, '', '/catalog/service-offerings?focus=sof_exp_airbridge');

    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read'],
    });

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(within(drawer).getAllByText(/Air-Bridge Express/).length).toBeGreaterThan(0);
    expect(within(drawer).getByTestId('offering-drawer-tabs')).toBeInTheDocument();
    const focusedCard = await screen.findByTestId('offering-card-sof_exp_airbridge');
    expect(focusedCard).toHaveAttribute('aria-current', 'true');
  });

  it('uses frame-based scheduling for the offering focus deep-link drawer', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.resolve(__dirname, '../service-offerings.tsx');
    const src = fs.readFileSync(file, 'utf8');

    expect(src).toMatch(/requestAnimationFrame\(\(\) => \{/);
    expect(src).not.toMatch(/setTimeout\(\(\) => \{\s*openOfferingDrawer\(focusTarget\)/);
    expect(src).not.toMatch(/openOfferingDrawer\(focusTarget\);\s*openedFocusRef\.current = focusParam;\s*\}, 100\)/);
  });
});

// ---- Phase C3 mutation wiring (CLAIM-CUSTOMERS-CATALOG-WIRING) ----
describe('ServiceOfferingsModule · mutation wiring (Phase C3)', () => {
  // Cast to a loose unknown so the spy's mock.calls type widens — the narrow
  // signature emitted by `vi.spyOn` against the typed api facades collides
  // with the loose `MockInstance<(this: unknown, ...args: unknown[]) => unknown>`
  // type. We assert against recorded call args directly below.
  type LooseSpy = ReturnType<typeof vi.spyOn> & {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
  };
  let createSpy: LooseSpy;
  let updateSpy: LooseSpy;
  let archiveSpy: LooseSpy;
  let toggleSpy: LooseSpy;
  beforeEach(() => {
    createSpy = vi.spyOn(apiMod, 'service_offering_create_v1') as unknown as LooseSpy;
    updateSpy = vi.spyOn(apiMod, 'service_offering_update_v1') as unknown as LooseSpy;
    archiveSpy = vi.spyOn(apiMod, 'service_offering_archive_v1') as unknown as LooseSpy;
    toggleSpy = vi.spyOn(apiMod, 'service_offering_toggle_v1') as unknown as LooseSpy;
  });
  afterEach(() => {
    createSpy.mockRestore();
    updateSpy.mockRestore();
    archiveSpy.mockRestore();
    toggleSpy.mockRestore();
  });

  function mockStaleOfferingDirectoryReadback(): () => void {
    const originalList = apiMod.ui_list_resource_v1;
    let stableRows: Record<string, unknown>[] | null = null;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      ((resource: string, opts?: unknown) => {
        if (resource !== 'service_offering_directory') {
          return originalList(resource, opts as never);
        }
        return originalList(resource, opts as never).then((result) => {
          stableRows ??= result.rows.map((row) => ({ ...(row as Record<string, unknown>) }));
          return { ...result, rows: stableRows };
        });
      }) as typeof apiMod.ui_list_resource_v1,
    );
    return () => listSpy.mockRestore();
  }

  it('New offering composer fires the canonical create action with canonical args', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read', 'service_offerings.write'],
    });
    // Wait for the offerings grid to mount (signals service_levels + branches loaded too).
    await screen.findByTestId('offerings-grid');
    const newBtn = await screen.findByRole('button', { name: /New offering/ });
    await user.click(newBtn);

    // Composer surfaces required fields.
    const serviceLevelSelect = await screen.findByLabelText('Service level');
    expect(serviceLevelSelect).not.toHaveTextContent(/svl_|same_day|service_level_id/i);
    const nameInput = await screen.findByPlaceholderText(/Same-Day Express/);
    await user.type(nameInput, 'Late-Night Express');
    const slugInput = await screen.findByPlaceholderText(/same-day-express/);
    await user.type(slugInput, 'late-night-express');
    const priceInput = await screen.findByPlaceholderText('e.g. 35');
    await user.type(priceInput, '120');

    const submit = await screen.findByRole('button', { name: 'Create' });
    await user.click(submit);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalled();
    });
    const args = createSpy.mock.calls[0]?.[0] as {
      service_level_id?: string;
      metadata?: { display?: { name?: string; slug?: string }; base_price?: number; currency?: string };
    } | undefined;
    expect(args?.service_level_id).toBeTruthy();
    expect(args?.metadata?.display?.name).toBe('Late-Night Express');
    expect(args?.metadata?.display?.slug).toBe('late-night-express');
    expect(args?.metadata?.base_price).toBe(120);
  });

  it('New offering create rejects stale backend readback instead of showing local-only success', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    createSpy.mockResolvedValue({
      ok: true,
      service_offering_id: 'sof_stale_readback',
      correlation_id: 'cor_stale_readback',
      settings_resolution_id: 'srlv_stale_readback',
    } as never);

    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read', 'service_offerings.write'],
    });
    await screen.findByTestId('offerings-grid');
    await user.click(await screen.findByRole('button', { name: /New offering/ }));

    await user.type(await screen.findByPlaceholderText(/Same-Day Express/), 'Stale Readback Offering');
    await user.type(await screen.findByPlaceholderText(/same-day-express/), 'stale-readback-offering');
    await user.type(await screen.findByPlaceholderText('e.g. 35'), '88');
    await user.click(await screen.findByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        'The updated service offering was not available yet.',
        'danger',
      );
    });
    expect(screen.getByRole('dialog', { name: 'New service offering' })).toBeInTheDocument();
    expect(document.querySelector('.drawer')).toBeNull();
    expect(toast.mock.calls.at(-1)).toEqual([
      'The updated service offering was not available yet.',
      'danger',
    ]);
    toast.mockRestore();
  });

  it('Edit price sends only the price and currency to the canonical update action', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read', 'service_offerings.write'],
    });
    const card = await screen.findByTestId('offering-card-sof_exp_airbridge');
    await user.click(card);
    const tablist = await screen.findByTestId('offering-drawer-tabs');
    await user.click(within(tablist).getByTestId('offering-tab-pricing'));
    const editBtn = await screen.findByRole('button', { name: /Edit price/ });
    await user.click(editBtn);

    // Edit-price modal surfaces a base price input pre-filled from metadata.
    const priceInput = await screen.findByLabelText(/Base price/);
    await user.clear(priceInput);
    await user.type(priceInput, '99');
    const saveBtn = await screen.findByRole('button', { name: 'Save' });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalled();
    });
    const args = updateSpy.mock.calls[0]?.[0] as {
      service_offering_id?: string;
      price?: { base_price?: number; currency?: string };
      metadata?: unknown;
    } | undefined;
    expect(args?.service_offering_id).toBe('sof_exp_airbridge');
    expect(args?.price?.base_price).toBe(99);
    expect(typeof args?.price?.currency).toBe('string');
    expect(args?.metadata).toBeUndefined();
  });

  it('Archive bulk action fires the canonical archive action once per active offering', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read', 'service_offerings.write'],
    });
    // Wait for the offerings grid so bulk action has rows to archive.
    await screen.findByTestId('offerings-grid');
    const archiveBtn = await screen.findByRole('button', { name: /Archive/ });
    await user.click(archiveBtn);

    await waitFor(
      () => {
        expect(archiveSpy).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );
    // Each call has the canonical { service_offering_id, reason } shape.
    const firstCall = archiveSpy.mock.calls[0]?.[0] as {
      service_offering_id?: string;
      reason?: string;
    } | undefined;
    expect(firstCall?.service_offering_id).toBeTruthy();
    expect(firstCall?.reason).toBe('bulk_archive');
  });

  it('Archive bulk action rejects stale backend readback instead of reporting archived success', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    const restoreStaleReadback = mockStaleOfferingDirectoryReadback();
    archiveSpy.mockResolvedValue({
      ok: true,
      service_offering_id: 'sof_exp_airbridge',
      correlation_id: 'cor_archive_stale_readback',
      settings_resolution_id: 'srlv_archive_stale_readback',
    } as never);

    try {
      renderWithProviders(<ServiceOfferingsModule />, {
        capabilities: ['service_offerings.read', 'service_offerings.write'],
      });
      await screen.findByTestId('offerings-grid');
      const archiveBtn = await screen.findByRole('button', { name: /Archive/ });
      await waitFor(() => {
        expect(archiveBtn).toBeEnabled();
      });
      await user.click(archiveBtn);

      await waitFor(() => {
        expect(archiveSpy).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(toast).toHaveBeenCalledWith(
          'The updated service offering was not available yet.',
          'danger',
        );
      });
      expect(toast.mock.calls.at(-1)).toEqual([
        'The updated service offering was not available yet.',
        'danger',
      ]);
    } finally {
      restoreStaleReadback();
      toast.mockRestore();
    }
  });

  it('Toggle availability bulk action fires the canonical availability action once per offering', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read', 'service_offerings.write'],
    });
    await screen.findByTestId('offerings-grid');
    const toggleBtn = await screen.findByRole('button', { name: /Toggle availability/ });
    await user.click(toggleBtn);

    await waitFor(
      () => {
        expect(toggleSpy).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );
    const firstCall = toggleSpy.mock.calls[0]?.[0] as {
      service_offering_id?: string;
      is_active?: boolean;
    } | undefined;
    expect(firstCall?.service_offering_id).toBeTruthy();
    expect(typeof firstCall?.is_active).toBe('boolean');
    await waitFor(() => {
      const grid = screen.getByTestId('offerings-grid');
      expect(within(grid).queryAllByText('Active')).toHaveLength(0);
      expect(within(grid).getAllByText('Archived').length).toBeGreaterThan(0);
    });
  });

  it('Toggle availability bulk action rejects stale backend readback instead of reporting toggled success', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    const restoreStaleReadback = mockStaleOfferingDirectoryReadback();
    toggleSpy.mockResolvedValue({
      ok: true,
      service_offering_id: 'sof_exp_airbridge',
      is_active: false,
      correlation_id: 'cor_toggle_stale_readback',
      settings_resolution_id: 'srlv_toggle_stale_readback',
    } as never);

    try {
      renderWithProviders(<ServiceOfferingsModule />, {
        capabilities: ['service_offerings.read', 'service_offerings.write'],
      });
      await screen.findByTestId('offerings-grid');
      await user.click(await screen.findByRole('button', { name: /Toggle availability/ }));

      await waitFor(() => {
        expect(toggleSpy).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(toast).toHaveBeenCalledWith(
          'The updated service offering was not available yet.',
          'danger',
        );
      });
      expect(toast.mock.calls.at(-1)).toEqual([
        'The updated service offering was not available yet.',
        'danger',
      ]);
    } finally {
      restoreStaleReadback();
      toast.mockRestore();
    }
  });
});

// ---- Phase D2 close-out (W9-5): service_levels Manage levels UX ----
//
// Coverage anchors (mirrors public.service_levels write contract):
//   1. Manage levels button is present + capability-gated.
//   2. Modal mounts and lists existing service_levels rows.
//   3. New level composer fires service_level_create_v1 with canonical args.
//   4. Edit form fires service_level_update_v1 with the patched metadata.
describe('ServiceOfferingsModule · Manage levels (W9-5)', () => {
  type LooseSpy = ReturnType<typeof vi.spyOn> & {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
  };
  let createLevelSpy: LooseSpy;
  let updateLevelSpy: LooseSpy;
  beforeEach(() => {
    createLevelSpy = vi.spyOn(apiMod, 'service_level_create_v1') as unknown as LooseSpy;
    updateLevelSpy = vi.spyOn(apiMod, 'service_level_update_v1') as unknown as LooseSpy;
  });
  afterEach(() => {
    createLevelSpy.mockRestore();
    updateLevelSpy.mockRestore();
  });

  it('Manage levels header action is disabled when service level management access is missing', async () => {
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read'],
    });
    const manageBtn = await screen.findByRole('button', { name: /Manage levels/ });
    expect(manageBtn).toBeDisabled();
    // Capability lock surfaces the canonical capability string for this affordance.
    expect(screen.getAllByText('Service Level Management permission required').length).toBeGreaterThan(0);
  });

  it('Manage levels modal mounts and lists existing service_levels rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read', 'agreements.write'],
    });
    await screen.findByTestId('offerings-grid');
    const manageBtn = await screen.findByRole('button', { name: /Manage levels/ });
    await user.click(manageBtn);

    // Modal body lands and lists at least one seeded service level row.
    expect(await screen.findByTestId('manage-levels-body')).toBeInTheDocument();
    const rows = await screen.findAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.getByTestId('manage-levels-body')).not.toHaveTextContent(/svl_|same_day|white_glove|immutable/i);
    expect(screen.getByRole('button', { name: /New level/ })).toBeEnabled();
  });

  it('New level composer fires the canonical service-level create action with canonical args', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceOfferingsModule />, {
      identity: {
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: '00000000-0000-0000-0000-000000000000',
        },
        scope: {
          tenant: {
            id: 'org_context_tenant',
            label: 'Context Tenant',
            rank: 2,
          },
        },
        capabilities: ['service_offerings.read', 'agreements.write'],
      },
    });
    await screen.findByTestId('offerings-grid');
    const manageBtn = await screen.findByRole('button', { name: /Manage levels/ });
    await user.click(manageBtn);
    const newLevelBtn = await screen.findByRole('button', { name: /New level/ });
    await user.click(newLevelBtn);

    // Composer surfaces operator fields; the backend key is generated from the name.
    const nameInput = await screen.findByLabelText('Name');
    await user.type(nameInput, 'Premium Plus');
    const rankInput = await screen.findByLabelText(/Priority rank/);
    await user.type(rankInput, '60');

    const submit = await screen.findByRole('button', { name: 'Create' });
    await user.click(submit);

    await waitFor(() => {
      expect(createLevelSpy).toHaveBeenCalled();
    });
    const args = createLevelSpy.mock.calls[0]?.[0] as
      | { key?: string; name?: string; organization_id?: string; metadata?: { priority_rank?: number } }
      | undefined;
    expect(args?.key).toBe('premium_plus');
    expect(args?.name).toBe('Premium Plus');
    expect(args?.organization_id).toBe('org_context_tenant');
    expect(args?.metadata?.priority_rank).toBe(60);
  });

  it('Edit level form fires the canonical service-level update action with patched metadata', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceOfferingsModule />, {
      capabilities: ['service_offerings.read', 'agreements.write'],
    });
    await screen.findByTestId('offerings-grid');
    const manageBtn = await screen.findByRole('button', { name: /Manage levels/ });
    await user.click(manageBtn);

    // Click the first row's Edit button. The modal should switch to the
    // edit form (level-specific title).
    const rows = await screen.findAllByTestId(/^manage-level-row-/);
    expect(rows.length).toBeGreaterThan(0);
    const firstRowEditBtn = within(rows[0]!).getByRole('button', { name: /Edit/ });
    await user.click(firstRowEditBtn);

    expect(document.body.textContent ?? '').not.toMatch(/svl_|same_day|white_glove|immutable/i);
    const nameInput = await screen.findByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated Name');

    const saveBtn = await screen.findByRole('button', { name: 'Save' });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(updateLevelSpy).toHaveBeenCalled();
    });
    const args = updateLevelSpy.mock.calls[0]?.[0] as
      | { service_level_id?: string; name?: string; is_active?: boolean }
      | undefined;
    expect(args?.service_level_id).toBeTruthy();
    expect(args?.name).toBe('Updated Name');
    expect(typeof args?.is_active).toBe('boolean');
  });
});
