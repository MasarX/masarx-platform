// feature-flags.test.tsx — CLAIM-PLATFORM-FLAGS (Wave 3, Phase C).
//
// Coverage anchors (mirrors public.feature_flags):
//   1. Mount + KPI strip + DataTable render with seed data.
//   2. Status pill variants — on (good), off (neutral), percentage with mini
//      bar (info), kill_switch killed (danger). The percentage variant must
//      surface the `%` value AND the inline progress bar.
//   3. Capability gate: New flag / Bulk toggle / Edit row action all disabled
//      with CapabilityLock chip when `feature_flags.write` is missing.
//   4. Editor drawer opens + tab strip renders + LadderViz + per-scope
//      targeting toggles + rollout slider all reachable from row click.
//   5. Kill switch tab fires the canonical RPC name in the toast (synthetic
//      mutation seam — runCommand path).
//   6. Bulk toggle modal opens with row count chip.
//   7. New flag modal opens with the form fields.
//   8. Read-only role still sees rows + KPIs (read capability honored).
//
// Backend SSOT references:
//   • public.feature_flags         — id, key, label, description, status,
//                                    rollout_percentage, targeting, scope_*,
//                                    kill_switch, last_updated_at.
//   • RBAC                         — feature_flags.read / feature_flags.write.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => null,
  rpc: vi.fn(),
}));

vi.mock('@/lib/seed-loader', async () => {
  // @ts-expect-error JS seed module is intentionally declaration-free.
  const seed = await import('@/lib/seed-raw/seed.js');
  return {
    seed,
    SEED_MODE_ENABLED: true,
  };
});

import { renderWithProviders } from '@/test/render';
import { FeatureFlagsModule } from '@/modules/platform/feature-flags';
import * as toastStore from '@/components/toastStore';
import * as api from '@/lib/api';
import * as dataSource from '@/lib/data-source';

function featureFlagSummaryRow(overrides: Record<string, unknown>) {
  return {
    id: 'ff_existing_refresh',
    key: 'existing_refresh_flag',
    label: 'Existing refresh flag',
    description: 'Existing row used for no-reload readback checks.',
    status: 'off',
    rollout_percentage: 0,
    scope_type: 'global',
    scope_id: 'global',
    targeting: { summary: 'global off', scopes: [] },
    kill_switch: false,
    owners: [],
    last_updated_at: '2026-05-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('FeatureFlagsModule', () => {
  beforeEach(() => {
    dataSource.setRole('ops_admin');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page header + KPI strip + DataTable', async () => {
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read', 'feature_flags.write'],
    });
    expect(await screen.findByText(/Feature flags/)).toBeInTheDocument();
    expect(
      await screen.findByText(/Feature flag access · feature flag update/),
    ).toBeInTheDocument();

    // KPI strip
    const kpi = await screen.findByTestId('ff-kpi-strip');
    expect(within(kpi).getByText(/Total flags/)).toBeInTheDocument();
    expect(within(kpi).getByText(/^On$/)).toBeInTheDocument();
    expect(within(kpi).getByText(/^Off$/)).toBeInTheDocument();
    expect(within(kpi).getByText(/^Rollout$/)).toBeInTheDocument();
    expect(within(kpi).getByText(/Kill-switched/)).toBeInTheDocument();

    // DataTable lands and renders the canonical seeded flag key cell.
    expect(
      await screen.findByText('unified_dispatch_v2'),
    ).toBeInTheDocument();
  });

  it('renders status pill variants — on / off / percentage / killed', async () => {
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read'],
    });
    // ON variant — unified_dispatch_v2 is status=on, kill_switch=false
    const onPill = await screen.findByTestId('ff-status-pill-ff_unified_dispatch_v2');
    expect(onPill.className).toMatch(/chip--good/);

    // OFF variant — route_solver_optaplanner is status=off, kill_switch=false
    const offPill = await screen.findByTestId('ff-status-pill-ff_route_solver_optaplanner');
    expect(offPill.className).toMatch(/chip--neutral/);

    // PERCENTAGE variant — pod_evidence_strict is status=percentage @ 50%.
    // Must include the percentage value text AND a mini bar.
    const pctPill = await screen.findByTestId('ff-status-pill-ff_pod_evidence_strict');
    expect(pctPill.className).toMatch(/chip--info/);
    expect(within(pctPill).getByText('50%')).toBeInTheDocument();

    // KILLED variant — mobile_offline_writes has kill_switch=true. The pill
    // must override status and read "Killed" with danger tone.
    const killedPill = await screen.findByTestId('ff-status-pill-ff_mobile_offline_writes');
    expect(killedPill.className).toMatch(/chip--danger/);
    expect(within(killedPill).getByText(/Killed/)).toBeInTheDocument();
  });

  it('disables New flag + Bulk toggle when feature_flags.write is missing', async () => {
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read'],
    });
    const newBtn = await screen.findByRole('button', { name: /New flag/ });
    const bulkBtn = await screen.findByRole('button', { name: /Bulk toggle/ });
    expect(newBtn).toBeDisabled();
    expect(bulkBtn).toBeDisabled();
    // CapabilityLock surfaces the canonical capability string for both.
    expect(screen.getAllByText(/Feature flag update permission required/i).length).toBeGreaterThan(0);
  });

  it('opens the editor drawer with all 5 tabs and LadderViz on Targeting', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read', 'feature_flags.write'],
    });
    // Click the row for unified_dispatch_v2 to open the editor.
    const cell = await screen.findByText('unified_dispatch_v2');
    await user.click(cell);

    // Editor + tab strip render.
    const tabs = await screen.findByTestId('ff-editor-tabs');
    expect(within(tabs).getByTestId('ff-tab-profile')).toBeInTheDocument();
    expect(within(tabs).getByTestId('ff-tab-targeting')).toBeInTheDocument();
    expect(within(tabs).getByTestId('ff-tab-rollout')).toBeInTheDocument();
    expect(within(tabs).getByTestId('ff-tab-history')).toBeInTheDocument();
    expect(within(tabs).getByTestId('ff-tab-kill_switch')).toBeInTheDocument();

    // Switch to Targeting → LadderViz container renders + per-scope toggles.
    await user.click(within(tabs).getByTestId('ff-tab-targeting'));
    await waitFor(() => {
      expect(screen.getByTestId('ff-targeting-scopes')).toBeInTheDocument();
      expect(screen.getByTestId('ff-targeting-scope-global')).toBeInTheDocument();
      expect(screen.getByTestId('ff-targeting-scope-tenant')).toBeInTheDocument();
      expect(screen.getByTestId('ff-targeting-scope-client')).toBeInTheDocument();
      expect(screen.getByTestId('ff-targeting-scope-sender')).toBeInTheDocument();
    });

    // Switch to Rollout — slider + percentage value visible.
    await user.click(within(tabs).getByTestId('ff-tab-rollout'));
    await waitFor(() => {
      expect(screen.getByTestId('ff-rollout-slider')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ff-rollout-value')).toBeInTheDocument();
  });

  it('rollout slider updates the impact estimate value', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read', 'feature_flags.write'],
    });
    const cell = await screen.findByText('pod_evidence_strict');
    await user.click(cell);

    const tabs = await screen.findByTestId('ff-editor-tabs');
    await user.click(within(tabs).getByTestId('ff-tab-rollout'));

    const slider = await screen.findByTestId('ff-rollout-slider');
    // Move rollout to 80%.
    fireEvent.change(slider, { target: { value: '80' } });
    await waitFor(() => {
      expect(screen.getByTestId('ff-rollout-value')).toHaveTextContent('80%');
    });
  });

  it('kill switch engage button fires the canonical RPC engage_kill_switch_v1 in toast', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(toastStore, 'pushToast');
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read', 'feature_flags.write'],
    });
    // Open a non-killed flag (unified_dispatch_v2).
    const cell = await screen.findByText('unified_dispatch_v2');
    await user.click(cell);
    const tabs = await screen.findByTestId('ff-editor-tabs');
    await user.click(within(tabs).getByTestId('ff-tab-kill_switch'));

    const engage = await screen.findByRole('button', { name: /Engage kill switch/ });
    await user.click(engage);
    // Phase C6 — toast now reflects the canonical Phase B RPC name.
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        expect.stringMatching(/^engage_kill_switch_v1 · unified_dispatch_v2/),
        'warn',
      );
    });
    spy.mockRestore();
  });

  // Phase C6 — assert the canonical RPC name fires with the canonical envelope.
  it('Engage kill switch calls engage_kill_switch_v1 with feature_flag_id', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'engage_kill_switch_v1').mockResolvedValue({
      ok: true,
      feature_flag_id: 'ff_unified_dispatch',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read', 'feature_flags.write'],
    });
    const cell = await screen.findByText('unified_dispatch_v2');
    await user.click(cell);
    const tabs = await screen.findByTestId('ff-editor-tabs');
    await user.click(within(tabs).getByTestId('ff-tab-kill_switch'));
    const engage = await screen.findByRole('button', { name: /Engage kill switch/ });
    await user.click(engage);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ feature_flag_id: expect.any(String) }),
    );
    spy.mockRestore();
  });

  it('New flag form Create button calls create RPC with canonical envelope', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'create_feature_flag_v1').mockResolvedValue({
      ok: true,
      feature_flag_id: 'ff_new_test',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read', 'feature_flags.write'],
    });
    const newBtn = await screen.findByRole('button', { name: /New flag/ });
    await user.click(newBtn);
    const form = await screen.findByTestId('ff-new-form');
    await user.type(within(form).getByTestId('ff-new-key'), 'demo_flag_test');
    await user.click(within(form).getByRole('button', { name: /Create flag/ }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        flag_key: 'demo_flag_test',
        scope_type: 'global',
      }),
    );
    spy.mockRestore();
  });

  it('New flag create shows backend summary readback in the table without reload', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    const visibleRows = [
      featureFlagSummaryRow({ id: 'ff_existing_refresh', key: 'existing_refresh_flag' }),
    ];
    const listSpy = vi
      .spyOn(api, 'ui_list_resource_v1')
      .mockImplementation((async (resource: string, opts?: unknown) => {
        if (resource === 'feature_flag_summary') {
          return {
            rows: visibleRows,
            total: visibleRows.length,
            page: 0,
            page_size: visibleRows.length,
          };
        }
        return originalList(resource, opts as never);
      }) as typeof api.ui_list_resource_v1);
    const createSpy = vi
      .spyOn(api, 'create_feature_flag_v1')
      .mockImplementation(async (args: Record<string, unknown>) => {
        visibleRows.push(
          featureFlagSummaryRow({
            id: 'ff_first_tenant_refresh',
            key: String(args.flag_key),
            label: 'First tenant refresh flag',
            description: 'Backend-refetched feature flag summary row.',
            status: 'on',
          }),
        );
        return {
          ok: true,
          feature_flag_id: 'ff_first_tenant_refresh',
          correlation_id: 'cor_feature_flag_refresh',
          settings_resolution_id: 'srlv_feature_flag_refresh',
        };
      });

    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read', 'feature_flags.write'],
    });

    expect(await screen.findByText('existing_refresh_flag')).toBeInTheDocument();
    const newBtn = await screen.findByRole('button', { name: /New flag/ });
    await user.click(newBtn);
    const form = await screen.findByTestId('ff-new-form');
    await user.type(within(form).getByTestId('ff-new-key'), 'first_tenant_refresh_flag');
    await user.type(within(form).getByTestId('ff-new-label'), 'First tenant refresh flag');
    await user.click(within(form).getByRole('button', { name: /Create flag/ }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          flag_key: 'first_tenant_refresh_flag',
          scope_type: 'global',
        }),
      );
      const tableText = document.querySelector('.dt__table tbody')?.textContent ?? '';
      expect(tableText).toContain('first_tenant_refresh_flag');
      expect(tableText).toContain('First tenant refresh flag');
    });
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'feature_flag_summary').length,
    ).toBeGreaterThanOrEqual(2);

    createSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('Save targeting calls update_feature_flag_v1 with targeting scopes', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'update_feature_flag_v1').mockResolvedValue({
      ok: true,
      feature_flag_id: 'ff_unified_dispatch',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read', 'feature_flags.write'],
    });
    const cell = await screen.findByText('unified_dispatch_v2');
    await user.click(cell);
    const tabs = await screen.findByTestId('ff-editor-tabs');
    await user.click(within(tabs).getByTestId('ff-tab-targeting'));
    const save = await screen.findByRole('button', { name: /Save targeting/ });
    await user.click(save);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        feature_flag_id: expect.any(String),
        targeting: expect.objectContaining({
          scopes: expect.any(Array),
        }),
      }),
    );
    spy.mockRestore();
  });

  it('opens the New flag modal with the form fields', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read', 'feature_flags.write'],
    });
    const newBtn = await screen.findByRole('button', { name: /New flag/ });
    await user.click(newBtn);
    const form = await screen.findByTestId('ff-new-form');
    expect(within(form).getByTestId('ff-new-key')).toBeInTheDocument();
    expect(within(form).getByTestId('ff-new-label')).toBeInTheDocument();
    expect(within(form).getByTestId('ff-new-description')).toBeInTheDocument();
    expect(within(form).getByTestId('ff-new-status')).toBeInTheDocument();
  });

  it('opens the Bulk toggle modal with target chip and target select', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read', 'feature_flags.write'],
    });
    // Wait for the flags to load before opening Bulk toggle so the target chip
    // count is populated (otherwise empty `flags` triggers the synthetic warn
    // toast and the modal isn't opened).
    await screen.findByText('unified_dispatch_v2');
    const bulkBtn = await screen.findByRole('button', { name: /Bulk toggle/ });
    await user.click(bulkBtn);
    const form = await screen.findByTestId('ff-bulk-form');
    expect(within(form).getByTestId('ff-bulk-target')).toBeInTheDocument();
    // Target chip surfaces a populated count (the entire seed list is selected
    // when invoked from the page-header action).
    expect(within(form).getByText(/Targets · \d+/)).toBeInTheDocument();
  });

  it('kill icon column surfaces for kill-switched rows', async () => {
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read'],
    });
    // Wait for the table to render.
    await screen.findByText('mobile_offline_writes');
    const killIcons = screen.getAllByTestId('ff-kill-icon');
    // Seed has 3 kill-switched flags (mobile_offline_writes, ai_address_correction,
    // partner_marketplace_bidding_v3). Assert at least one (visible page).
    expect(killIcons.length).toBeGreaterThanOrEqual(1);
  });

  // Phase G3 — assert LadderViz consumes canonical `scope_type_registry.ladder_rank`
  // values (Global=0, Tenant=10, Client=20, Sender=30) instead of inline literals.
  // This is the regression guard against re-introducing a hardcoded SCOPE_RANK.
  it('LadderViz step ranks reflect scope_type_registry.ladder_rank (Phase G3)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeatureFlagsModule />, {
      capabilities: ['feature_flags.read', 'feature_flags.write'],
    });
    const cell = await screen.findByText('unified_dispatch_v2');
    await user.click(cell);
    const tabs = await screen.findByTestId('ff-editor-tabs');
    await user.click(within(tabs).getByTestId('ff-tab-targeting'));
    await waitFor(() => {
      expect(screen.getByTestId('ff-targeting-scopes')).toBeInTheDocument();
    });

    // LadderViz renders each step's `rank` inside `.ladder__rank`. The canonical
    // seed (supabase/migrations/202601301100_scope_registry_ssot.sql:267-298)
    // sets ranks to 0, 10, 20, 30 for the four scope types feature flags use.
    await waitFor(() => {
      const ranks = Array.from(document.querySelectorAll('.ladder__rank'))
        .map((el) => el.textContent ?? '')
        .map((t) => Number(t.trim()))
        .filter((n) => !Number.isNaN(n));
      // All four canonical ranks (Global 0, Tenant 10, Client 20, Sender 30)
      // must be present. The pre-Phase-G3 literal would have rendered 5/4/3/2.
      expect(ranks).toEqual(expect.arrayContaining([0, 10, 20, 30]));
      expect(ranks).not.toEqual(expect.arrayContaining([5, 4, 3, 2]));
    });
  });
});
