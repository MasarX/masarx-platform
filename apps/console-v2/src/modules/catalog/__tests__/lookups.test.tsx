// lookups.test.tsx — Behavior tests for the Lookups catalog module.
//
// Coverage anchors (mirrors public.lookup_definitions + public.lookup_values):
//   1. Capability pill uses canonical `lookups.read · lookups.write`.
//   2. is_mutable=false definitions render system-managed chip + CapabilityLock and disable edit
//      affordances (canonical row-driven enforcement, not hardcoded category names).
//   3. New definition modal accepts owner_role + approval_policy + is_mutable inputs.
//   4. New value modal validates snake_case format on `value` (matches lookup_values.value contract).
//   5. New definition fires lookup_definition_create_v1 with canonical args (Phase C3).
//   6. New value fires lookup_value_create_v1 with category + value + label (Phase C3).
//   7. Cell edit on label fires lookup_value_update_v1 with metadata patch (Phase C3).
//   8. Archive row action fires lookup_value_archive_v1 (Phase C3).
//   9. Promote draft row action fires lookup_value_promote_v1 (Phase C3).
//  10. New value create waits for lookup_values backend readback before closing the modal.
//  11. Promote/archive value actions refresh from lookup_values backend readback in-place.
//  12. Inline value edits wait for lookup_values backend readback; value is immutable.
//  13. (W14-5) Registry-seam consumer surfaces additive-merged categories
//      contributed by per-feature seed files via `Object.assign(lookups, …)`
//      (e.g. `service_offering_status` from `catalog-offerings.js`,
//      `vehicle_status` from `fleet-vehicles.js`, `marketplace_*` from
//      `network-marketplace.js`). Regression guard for the W13-4 revert that
//      uncovered the default `ui_list_resource_v1` page-size clip.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { LookupsModule } from '@/modules/catalog/lookups';
import * as toastStore from '@/components/toastStore';
import * as apiMod from '@/lib/api';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('LookupsModule', () => {
  it('renders the Reference data page header with operator-safe capability copy', async () => {
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read', 'lookups.write'] });
    expect(await screen.findByRole('heading', { name: /Reference data/i })).toBeInTheDocument();
    expect(screen.getByText(/Reference access · reference update/)).toBeInTheDocument();
    expect(screen.queryByText(/Lookups & enums/i)).not.toBeInTheDocument();
  });

  it('uses reference-data copy in the denied state', async () => {
    renderWithProviders(<LookupsModule />, { capabilities: [] });

    expect(await screen.findByText(/view reference data/i)).toBeInTheDocument();
    expect(screen.queryByText(/view lookups/i)).not.toBeInTheDocument();
  });

  it('shows owner_role + approval_policy + system-managed chips for system categories', async () => {
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read'] });

    // First definition is sorted alphabetically; client_status is system-managed and present in the seed.
    const button = await screen.findByRole('button', { name: /Select client_status/ });
    await userEvent.setup().click(button);

    await waitFor(() => {
      // Owner chip
      expect(screen.getByText(/owner · operations/)).toBeInTheDocument();
      // Approval chip
      expect(screen.getByText(/approval · tier_1/)).toBeInTheDocument();
      // System-managed chip
      expect(screen.getByText('system-managed')).toBeInTheDocument();
      // CapabilityLock chip is rendered with the canonical capability string.
      // Multiple instances may exist (button labels + lock chip) — assert at least one renders.
      expect(screen.getAllByText(/Lookup update permission required/i).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('blocks New value when current category is system-managed', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');

    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read', 'lookups.write'] });

    // Pick a system-managed category.
    const sysCat = await screen.findByRole('button', { name: /Select client_status/ });
    await user.click(sysCat);

    const newVal = screen.getByRole('button', { name: /New value/ });
    await user.click(newVal);

    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/system-managed.*cannot accept new values/i),
      'warn',
    );
  });

  it('opens New definition modal with owner_role + approval_policy + is_mutable inputs', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read', 'lookups.write'] });

    const newDef = await screen.findByRole('button', { name: /New definition/ });
    await user.click(newDef);

    expect(await screen.findByLabelText(/Owner role/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Approval policy/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Tenant-extensible/)).toBeInTheDocument();
  });
});

// ---- Phase C3 mutation wiring (CLAIM-CUSTOMERS-CATALOG-WIRING) ----
describe('LookupsModule · mutation wiring (Phase C3)', () => {
  // Cast to a loose unknown so the spy's mock.calls type widens — the narrow
  // signature emitted by `vi.spyOn` against the typed api facades collides
  // with the loose `MockInstance<(this: unknown, ...args: unknown[]) => unknown>`
  // type. We assert against recorded call args directly below.
  type LooseSpy = ReturnType<typeof vi.spyOn> & {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
  };
  let createDefSpy: LooseSpy;
  let createValSpy: LooseSpy;
  let updateValSpy: LooseSpy;
  let archiveValSpy: LooseSpy;
  let promoteValSpy: LooseSpy;
  beforeEach(() => {
    createDefSpy = vi.spyOn(apiMod, 'lookup_definition_create_v1') as unknown as LooseSpy;
    createValSpy = vi.spyOn(apiMod, 'lookup_value_create_v1') as unknown as LooseSpy;
    updateValSpy = vi.spyOn(apiMod, 'lookup_value_update_v1') as unknown as LooseSpy;
    archiveValSpy = vi.spyOn(apiMod, 'lookup_value_archive_v1') as unknown as LooseSpy;
    promoteValSpy = vi.spyOn(apiMod, 'lookup_value_promote_v1') as unknown as LooseSpy;
  });
  afterEach(() => {
    createDefSpy.mockRestore();
    createValSpy.mockRestore();
    updateValSpy.mockRestore();
    archiveValSpy.mockRestore();
    promoteValSpy.mockRestore();
  });

  it('New definition Create fires lookup_definition_create_v1 with canonical args', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read', 'lookups.write'] });

    const newDef = await screen.findByRole('button', { name: /New definition/ });
    await user.click(newDef);

    const categoryInput = await screen.findByPlaceholderText(/dispute_resolution/);
    await user.type(categoryInput, 'phase_c3_test_category');
    const create = await screen.findByRole('button', { name: 'Create' });
    await user.click(create);

    await waitFor(() => {
      expect(createDefSpy).toHaveBeenCalled();
    });
    const args = createDefSpy.mock.calls[0]?.[0] as {
      category?: string;
      owner_role?: string;
      approval_policy?: string;
      is_mutable?: boolean;
    } | undefined;
    expect(args?.category).toBe('phase_c3_test_category');
    expect(args?.owner_role).toBeTruthy();
    expect(args?.approval_policy).toBeTruthy();
    expect(typeof args?.is_mutable).toBe('boolean');
  });

  it('New value Add fires lookup_value_create_v1 with canonical args', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read', 'lookups.write'] });

    // Pick a tenant-extensible category — service_offering_status is seeded mutable.
    // (Pick the first definition in the rail that isn't system-managed.)
    const definitionButton = await screen.findByRole('button', { name: /Select service_offering_status/ });
    await user.click(definitionButton);

    const newVal = await screen.findByRole('button', { name: /New value/ });
    await user.click(newVal);

    const valueInput = await screen.findByPlaceholderText(/snake_case/);
    await user.type(valueInput, 'piloting');
    const labelInput = await screen.findByPlaceholderText(/Display label/);
    await user.type(labelInput, 'Piloting');
    const addBtn = await screen.findByRole('button', { name: /Add value/ });
    await user.click(addBtn);

    await waitFor(() => {
      expect(createValSpy).toHaveBeenCalled();
    });
    const args = createValSpy.mock.calls[0]?.[0] as {
      category?: string;
      value?: string;
      label?: string;
      status?: string;
      lookup_definition_id?: string;
      metadata?: { tone?: string };
    } | undefined;
    expect(args?.category).toBe('service_offering_status');
    expect(args?.value).toBe('piloting');
    expect(args?.label).toBe('Piloting');
    expect(args?.status).toBe('draft');
    // W35a — `lookup_value_create_v1` requires NOT NULL `lookup_definition_id`
    // (canonical RPC: supabase/migrations/202604280208_lookup_value_create_v1.sql:21,39-42).
    // Asserting the payload prevents arg-shape drift; the FE resolves the id from the
    // active definition row (UUID in live mode, `lkd_<category>` in seed projection
    // mode — see data-source.ts:748). Closes REAUDIT3 P1-CAT-W34-1.
    expect(typeof args?.lookup_definition_id).toBe('string');
    expect(args?.lookup_definition_id).toBe('lkd_service_offering_status');
  });

  it('New value create shows lookup_values backend readback without reload', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    let includeCreatedValue = false;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource !== 'lookup_values' || !includeCreatedValue) return result;
      return {
        ...result,
        rows: [
          ...result.rows,
          {
            id: 'lkv_service_offering_status_readback_pilot',
            lookup_definition_id: 'lkd_service_offering_status',
            category: 'service_offering_status',
            value: 'readback_pilot',
            label: 'Readback Pilot',
            sort_order: 990,
            is_default: false,
            status: 'draft',
            effective_from: null,
            effective_until: null,
            metadata: { tone: 'info' },
          },
        ],
        total: result.total + 1,
      };
    });
    createValSpy.mockImplementation(async () => {
      includeCreatedValue = true;
      return {
        ok: true,
        lookup_value_id: 'lkv_service_offering_status_readback_pilot',
        correlation_id: 'cor_lookup_value_readback',
        settings_resolution_id: 'srlv_lookup_value_readback',
      };
    });

    window.history.pushState(null, '', '/catalog/lookups');
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read', 'lookups.write'] });

    await user.click(await screen.findByRole('button', { name: /Select service_offering_status/ }));
    await user.click(await screen.findByRole('button', { name: /New value/ }));
    await user.type(await screen.findByPlaceholderText(/snake_case/), 'readback_pilot');
    await user.type(await screen.findByPlaceholderText(/Display label/), 'Readback Pilot');
    await user.click(await screen.findByRole('button', { name: /Add value/ }));

    await waitFor(() => {
      expect(createValSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog', { name: /Add value/i })).not.toBeInTheDocument();
      expect(screen.getByText('readback_pilot')).toBeInTheDocument();
      expect(screen.getByText('Readback Pilot')).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe('/catalog/lookups');
  });

  it('Promote draft refreshes the visible value row from lookup_values backend readback without reload', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    let status = 'draft';
    let effectiveFrom: string | null = null;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource === 'lookup_definitions') {
        return {
          ...result,
          rows: [
            ...result.rows,
            {
              id: 'lkd_readback_value_actions',
              category: 'readback_value_actions',
              owner_role: 'operations',
              approval_policy: 'tier_1',
              is_mutable: true,
              description: 'Readback value action test category',
            },
          ],
          total: result.total + 1,
        };
      }
      if (resource === 'lookup_values') {
        return {
          ...result,
          rows: [
            ...result.rows,
            {
              id: 'lkv_readback_value_actions_promote_readback',
              lookup_definition_id: 'lkd_readback_value_actions',
              category: 'readback_value_actions',
              value: 'promote_readback',
              label: 'Promote Readback',
              sort_order: 1,
              is_default: false,
              status,
              effective_from: effectiveFrom,
              effective_until: null,
              metadata: { tone: 'neutral' },
            },
          ],
          total: result.total + 1,
        };
      }
      return result;
    });
    promoteValSpy.mockImplementation(async () => {
      status = 'active';
      effectiveFrom = '2026-05-19T00:00:00.000Z';
      return {
        ok: true,
        lookup_value_id: 'lkv_readback_value_actions_promote_readback',
        status: 'active',
        correlation_id: 'cor_lookup_promote_readback',
        settings_resolution_id: 'srlv_lookup_promote_readback',
      };
    });

    window.history.pushState(null, '', '/catalog/lookups');
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read', 'lookups.write'] });

    await user.click(await screen.findByRole('button', { name: /Select readback_value_actions/ }));
    const row = (await screen.findByText('promote_readback')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('Draft');
    await user.click(within(row).getByRole('button', { name: /Row actions/ }));
    await user.click(await screen.findByRole('option', { name: /Promote draft/ }));

    await waitFor(() => {
      const refreshedRow = screen.getByText('promote_readback').closest('tr') as HTMLElement;
      expect(refreshedRow).toHaveTextContent('Active');
      expect(refreshedRow).toHaveTextContent('2026-05-19T00:00:00.000Z');
    });
    expect(promoteValSpy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/catalog/lookups');
  });

  it('Archive value refreshes the visible value row from lookup_values backend readback without reload', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    let status = 'active';
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource === 'lookup_definitions') {
        return {
          ...result,
          rows: [
            ...result.rows,
            {
              id: 'lkd_archive_value_actions',
              category: 'archive_value_actions',
              owner_role: 'operations',
              approval_policy: 'tier_1',
              is_mutable: true,
              description: 'Archive value action test category',
            },
          ],
          total: result.total + 1,
        };
      }
      if (resource === 'lookup_values') {
        return {
          ...result,
          rows: [
            ...result.rows,
            {
              id: 'lkv_archive_value_actions_archive_readback',
              lookup_definition_id: 'lkd_archive_value_actions',
              category: 'archive_value_actions',
              value: 'archive_readback',
              label: 'Archive Readback',
              sort_order: 1,
              is_default: false,
              status,
              effective_from: '2026-05-01T00:00:00.000Z',
              effective_until: null,
              metadata: { tone: 'neutral' },
            },
          ],
          total: result.total + 1,
        };
      }
      return result;
    });
    archiveValSpy.mockImplementation(async () => {
      status = 'archived';
      return {
        ok: true,
        lookup_value_id: 'lkv_archive_value_actions_archive_readback',
        status: 'archived',
        correlation_id: 'cor_lookup_archive_readback',
        settings_resolution_id: 'srlv_lookup_archive_readback',
      };
    });

    window.history.pushState(null, '', '/catalog/lookups');
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read', 'lookups.write'] });

    await user.click(await screen.findByRole('button', { name: /Select archive_value_actions/ }));
    const row = (await screen.findByText('archive_readback')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('Active');
    await user.click(within(row).getByRole('button', { name: /Row actions/ }));
    await user.click(await screen.findByRole('option', { name: /^Archive/ }));

    await waitFor(() => {
      const refreshedRow = screen.getByText('archive_readback').closest('tr') as HTMLElement;
      expect(refreshedRow).toHaveTextContent('Archived');
    });
    expect(archiveValSpy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/catalog/lookups');
  });

  it('Label inline edit refreshes the visible lookup value row from lookup_values backend readback without reload', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    let label = 'Label Readback Original';
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource === 'lookup_definitions') {
        return {
          ...result,
          rows: [
            ...result.rows,
            {
              id: 'lkd_inline_value_actions',
              category: 'inline_value_actions',
              owner_role: 'operations',
              approval_policy: 'tier_1',
              is_mutable: true,
              description: 'Inline value action test category',
            },
          ],
          total: result.total + 1,
        };
      }
      if (resource === 'lookup_values') {
        return {
          ...result,
          rows: [
            ...result.rows,
            {
              id: 'lkv_inline_value_actions_label_readback',
              lookup_definition_id: 'lkd_inline_value_actions',
              category: 'inline_value_actions',
              value: 'label_readback',
              label,
              sort_order: 1,
              is_default: false,
              status: 'active',
              effective_from: '2026-05-01T00:00:00.000Z',
              effective_until: null,
              metadata: { tone: 'neutral' },
            },
          ],
          total: result.total + 1,
        };
      }
      return result;
    });
    updateValSpy.mockImplementation(async (args: unknown) => {
      const payload = args as { label?: string };
      label = payload.label ?? label;
      return {
        ok: true,
        lookup_value_id: 'lkv_inline_value_actions_label_readback',
        revision: 2,
        correlation_id: 'cor_lookup_update_readback',
        settings_resolution_id: 'srlv_lookup_update_readback',
      };
    });

    window.history.pushState(null, '', '/catalog/lookups');
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read', 'lookups.write'] });

    await user.click(await screen.findByRole('button', { name: /Select inline_value_actions/ }));
    const row = (await screen.findByText('label_readback')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('Label Readback Original');
    await user.dblClick(within(row).getByText('Label Readback Original'));
    const input = row.querySelector('input.dt-inline-input') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'Label Readback Updated{Enter}');

    await waitFor(() => {
      expect(updateValSpy).toHaveBeenCalledTimes(1);
      const refreshedRow = screen.getByText('label_readback').closest('tr') as HTMLElement;
      expect(refreshedRow).toHaveTextContent('Label Readback Updated');
    });
    const args = updateValSpy.mock.calls[0]?.[0] as { lookup_value_id?: string; label?: string } | undefined;
    expect(args?.lookup_value_id).toBe('lkv_inline_value_actions_label_readback');
    expect(args?.label).toBe('Label Readback Updated');
    expect(window.location.pathname).toBe('/catalog/lookups');
  });

  it('Value column is immutable and does not open inline edit or call update RPC', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource === 'lookup_definitions') {
        return {
          ...result,
          rows: [
            ...result.rows,
            {
              id: 'lkd_immutable_value_actions',
              category: 'immutable_value_actions',
              owner_role: 'operations',
              approval_policy: 'tier_1',
              is_mutable: true,
              description: 'Immutable value action test category',
            },
          ],
          total: result.total + 1,
        };
      }
      if (resource === 'lookup_values') {
        return {
          ...result,
          rows: [
            ...result.rows,
            {
              id: 'lkv_immutable_value_actions_immutable_value',
              lookup_definition_id: 'lkd_immutable_value_actions',
              category: 'immutable_value_actions',
              value: 'immutable_value',
              label: 'Immutable Value',
              sort_order: 1,
              is_default: false,
              status: 'active',
              effective_from: '2026-05-01T00:00:00.000Z',
              effective_until: null,
              metadata: { tone: 'neutral' },
            },
          ],
          total: result.total + 1,
        };
      }
      return result;
    });

    window.history.pushState(null, '', '/catalog/lookups');
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read', 'lookups.write'] });

    await user.click(await screen.findByRole('button', { name: /Select immutable_value_actions/ }));
    const row = (await screen.findByText('immutable_value')).closest('tr') as HTMLElement;
    await user.dblClick(within(row).getByText('immutable_value'));

    expect(row.querySelector('input.dt-inline-input')).toBeNull();
    expect(updateValSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/catalog/lookups');
  });
});

// ---- W14-5 additive-merge regression guard ----
// W13-4 reverted because `Object.assign(seed.lookups, ...)` extensions
// contributed by per-feature seed files (catalog-offerings.js, fleet-vehicles.js,
// network-marketplace.js, platform-flags.js, …) were not threaded through the
// `useResourceList<LookupValueRegistryRow>('lookup_values')` consumer path.
//
// The fix: `_lookupValuesCatalog()` / `_lookupDefinitionsCatalog()` in
// `lib/data-source.ts` re-project the live `seed.lookups` map at every adapter
// call (RESOURCE_DATA is a function, not a frozen object) so additive
// extensions land in the registry projection without a structural shim.
//
// This regression guard asserts that the catalog rail (built from the registry
// consumer) lists categories ONLY contributed by per-feature seed files. If
// the additive-merge invariant breaks (e.g. RESOURCE_DATA is memoized too
// early, or the seed.lookups read is captured before per-feature merges
// land), these assertions fail.
describe('LookupsModule · W14-5 additive-merge invariant', () => {
  it('surfaces categories contributed by per-feature seed files via Object.assign(seed.lookups, …)', async () => {
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read'] });

    // service_offering_status — added by catalog-offerings.js
    expect(
      await screen.findByRole('button', { name: /Select service_offering_status/ }),
    ).toBeInTheDocument();

    // vehicle_status — added by fleet-vehicles.js
    expect(
      await screen.findByRole('button', { name: /Select vehicle_status/ }),
    ).toBeInTheDocument();

    // marketplace_offer_status — added by network-marketplace.js
    expect(
      await screen.findByRole('button', { name: /Select marketplace_offer_status/ }),
    ).toBeInTheDocument();
  });

  it('keeps base lookups.js categories visible alongside additive extensions', async () => {
    renderWithProviders(<LookupsModule />, { capabilities: ['lookups.read'] });

    // shipment_status comes from the base lookups.js export
    expect(
      await screen.findByRole('button', { name: /Select shipment_status/ }),
    ).toBeInTheDocument();
    // service_offering_status comes from the additive merge — both must coexist
    expect(
      await screen.findByRole('button', { name: /Select service_offering_status/ }),
    ).toBeInTheDocument();
  });
});
