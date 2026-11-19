import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { BasketsModule } from '@/modules/operate/baskets';
import * as api from '@/lib/api';
import * as ds from '@/lib/data-source';
import { clearToasts, getToasts } from '@/components/toastStore';

describe('BasketsModule', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/operate/baskets');
    clearToasts();
  });

  afterEach(() => {
    clearToasts();
    vi.restoreAllMocks();
  });

  it('renders the basket operations page and KPI strip from canonical basket resources', async () => {
    renderWithProviders(<BasketsModule />, { capabilities: ['all'] });

    expect(await screen.findByTestId('baskets-page')).toBeInTheDocument();
    const kpis = await screen.findByTestId('baskets-kpi-strip');
    expect(within(kpis).getByText(/^Total baskets$/i)).toBeInTheDocument();
    expect(within(kpis).getByText(/^Open$/i)).toBeInTheDocument();
    await waitFor(() => {
      const kpiValues = new Map(
        Array.from(kpis.querySelectorAll<HTMLElement>('.kpi')).map((node) => [
          node.querySelector('.kpi__label')?.textContent?.trim() ?? '',
          node.querySelector('.kpi__value')?.textContent?.trim() ?? '',
        ]),
      );
      expect(kpiValues.get('Total baskets')).toBe('5');
      expect(kpiValues.get('Open')).toBe('2');
      expect(kpiValues.get('Ready')).toBe('1');
      expect(kpiValues.get('Expired')).toBe('1');
    });
    expect(await screen.findByText(/Zone-Based Basket - Riyadh North - 3\/50/i)).toBeInTheDocument();
    expect(screen.getByText(/Hub Pickup Basket - Unzoned - 1\/100/i)).toBeInTheDocument();
    expect(screen.queryByText(/bsk_/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Jan 1, 1970/i)).not.toBeInTheDocument();
  });

  it('scopes basket roster, zone picker, and basket policy reads to the active tenant', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    const resolveSpy = vi.spyOn(api, 'resolveSettings');

    renderWithProviders(<BasketsModule />, {
      identity: {
        capabilities: ['all'],
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    expect(await screen.findByTestId('baskets-page')).toBeInTheDocument();
    await waitFor(() => {
      for (const resource of ['baskets', 'zones']) {
        expect(
          listSpy.mock.calls.some(([key, opts]) => {
            const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
            return key === resource && filter?.organization_id === 'org_rashed';
          }),
        ).toBe(true);
      }
      expect(resolveSpy).toHaveBeenCalledWith(
        'basket_policy',
        expect.objectContaining({ tenant: expect.objectContaining({ id: 'org_rashed' }) }),
      );
    });
  });

  it('denies the page when baskets.read is missing', async () => {
    renderWithProviders(<BasketsModule />, { capabilities: [] });

    expect(await screen.findByText(/Basket operations require basket access/i)).toBeInTheDocument();
  });

  it('opens basket details with item and transition history ledgers', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BasketsModule />, { capabilities: ['all'] });

    const basketCell = await screen.findByText(/Zone-Based Basket - Riyadh North - 3\/50/i);
    await user.click(basketCell.closest('tr')!);

    const drawer = await screen.findByTestId('baskets-drawer');
    expect(await within(drawer).findByText(/^Basket items$/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/^Transition history$/i)).toBeInTheDocument();
    expect(within(drawer).getAllByText(/^Shipment$/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Items are sorted by basket policy; shipment sorting remains workflow-controlled/i),
    ).toBeInTheDocument();
  });

  it('loads basket drawer relationships through basket-scoped backend reads', async () => {
    const user = userEvent.setup();
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1');
    const getSpy = vi.spyOn(ds, 'ui_get_resource_v1');
    renderWithProviders(<BasketsModule />, { capabilities: ['all'] });

    const basketCell = await screen.findByText(/Zone-Based Basket - Riyadh North - 3\/50/i);
    await user.click(basketCell.closest('tr')!);
    const drawer = await screen.findByTestId('baskets-drawer');
    expect(await within(drawer).findByText('SHP-9381200')).toBeInTheDocument();

    await waitFor(() => {
      expect(
        listSpy.mock.calls.some(
          ([key, opts]) =>
            key === 'basket_items' &&
            (opts as { filter?: { basket_id?: string } } | undefined)?.filter?.basket_id ===
              'bsk_ruh_north_001',
        ),
      ).toBe(true);
      expect(
        listSpy.mock.calls.some(
          ([key, opts]) =>
            key === 'basket_transitions' &&
            (opts as { filter?: { basket_id?: string } } | undefined)?.filter?.basket_id ===
              'bsk_ruh_north_001',
        ),
      ).toBe(true);
      expect(getSpy.mock.calls.some(([key, id]) => key === 'shipments' && id === 'shp_9381200')).toBe(true);
      expect(
        listSpy.mock.calls.some(
          ([key, opts]) => key === 'shipments' && !(opts as { filter?: unknown } | undefined)?.filter,
        ),
      ).toBe(false);
    });
  });

  it('opens the linked shipment in the current basket drawer context', async () => {
    const user = userEvent.setup();
    const realGetResource = ds.ui_get_resource_v1;
    const getSpy = vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (key: string, id: string) => {
      if (key === 'shipments' && id === 'shp_9381200') {
        return {
          id,
          tracking_number: 'SHP-9381200',
          client_reference_number: 'AMZ-9381200',
          service_type: 'standard_delivery',
          status: 'sorted',
        } as never;
      }
      return realGetResource(key, id);
    });

    renderWithProviders(<BasketsModule />, { capabilities: ['all'] });

    const basketCell = await screen.findByText(/Zone-Based Basket - Riyadh North - 3\/50/i);
    await user.click(basketCell.closest('tr')!);
    const shipmentCell = await screen.findByText('SHP-9381200');
    await user.click(shipmentCell.closest('tr')!);

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    expect(window.location.pathname).toBe('/operate/baskets');
    expect(window.location.search).toBe('');
    expect(getSpy).toHaveBeenCalledWith('shipments', 'shp_9381200');
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
  });

  it('reapplies basket policy for a linked shipment through the shipment resort workflow', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'ui_execute_shipment_resort_v1').mockResolvedValue({
      ok: true,
      basket_policy_applied: true,
    });

    const { queryClient } = renderWithProviders(<BasketsModule />, { capabilities: ['all'] });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const basketCell = await screen.findByText(/Zone-Based Basket - Riyadh North - 3\/50/i);
    await user.click(basketCell.closest('tr')!);
    const shipmentCell = await screen.findByText('SHP-9381200');
    const shipmentRow = shipmentCell.closest('tr')!;
    await user.click(within(shipmentRow).getByLabelText('Row actions'));
    await user.click(await screen.findByRole('option', { name: /^Reapply basket policy/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith('shp_9381200'));
    await waitFor(() => {
      const calls = invalidateSpy.mock.calls.map(([arg]) => JSON.stringify(arg));
      expect(calls.some((call) => call.includes('"shipments"'))).toBe(true);
      expect(calls.some((call) => call.includes('"baskets"'))).toBe(true);
      expect(calls.some((call) => call.includes('"basket_items"'))).toBe(true);
      expect(calls.some((call) => call.includes('"basket_transitions"'))).toBe(true);
    });
    await waitFor(() => {
      expect(getToasts().map((toast) => toast.message)).toContain('Basket policy reapplied to SHP-9381200');
    });
  });

  it('renders a controlled error state when the baskets read fails', async () => {
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string) => {
      if (key === 'baskets') throw new Error('basket backend unavailable');
      return { rows: [], total: 0, page: 0, page_size: 100 };
    });

    renderWithProviders(<BasketsModule />, { capabilities: ['all'] });

    expect(await screen.findByText('Baskets unavailable')).toBeInTheDocument();
    expect(screen.getByText(/This section could not load/i)).toBeInTheDocument();
    expect(screen.queryByText('basket backend unavailable')).not.toBeInTheDocument();
  });

  it('opens a focus basket through backend lookup when it is not in the loaded page', async () => {
    window.history.pushState(null, '', '/operate/baskets?focus=bsk_off_page');
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string) => {
      if (key === 'baskets') return { rows: [], total: 0, page: 0, page_size: 100 };
      return { rows: [], total: 0, page: 0, page_size: 100 };
    });
    const getSpy = vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (key: string, id: string) => {
      if (key === 'baskets' && id === 'bsk_off_page') {
        return {
          id,
          organization_id: 'org_rashed',
          zone_id: null,
          basket_type: 'zone_based',
          state: 'ready',
          current_count: 0,
          capacity_count: 50,
          expires_at: null,
          version: 7,
          updated_at: '2026-05-05T08:00:00Z',
        };
      }
      return null;
    });

    renderWithProviders(<BasketsModule />, { capabilities: ['all'] });

    const drawer = await screen.findByTestId('baskets-drawer');
    expect(within(drawer).getByText('Zone-Based Basket - Unzoned - 0/50')).toBeInTheDocument();
    expect(within(drawer).getByText(/^Ready$/i)).toBeInTheDocument();
    expect(within(drawer).queryByText('2026-05-05T08:00:00Z')).not.toBeInTheDocument();
    expect(getSpy).toHaveBeenCalledWith('baskets', 'bsk_off_page');
  });

  it('opens a focus basket when the basket is already on the loaded page', async () => {
    window.history.pushState(null, '', '/operate/baskets?focus=bsk_ruh_north_001');

    renderWithProviders(<BasketsModule />, { capabilities: ['all'] });

    const drawer = await screen.findByTestId('baskets-drawer');
    expect(await within(drawer).findByText('SHP-9381200')).toBeInTheDocument();
    expect(within(drawer).getByText(/Zone-Based Basket.*3\/50/i)).toBeInTheDocument();
  });

  it.each([
    ['basket_items', 'bsi_legacy_001'],
    ['basket_transitions', 'bst_legacy_001'],
  ])('opens the owning basket from a legacy %s focus link', async (resource, legacyId) => {
    window.history.pushState(
      null,
      '',
      `/operate/baskets?legacy_resource=${resource}&legacy_focus=${legacyId}`,
    );
    const realGetResource = api.ui_get_resource_v1;
    const getSpy = vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (key: string, id: string) => {
      if (key === resource && id === legacyId) {
        return {
          id,
          basket_id: 'bsk_ruh_north_001',
          shipment_id: 'shp_9381200',
          shipment_client_id: 'cl_exampleparcel_ksa',
          added_at: '2026-05-03T06:18:00Z',
          previous_state: 'forming',
          new_state: 'ready',
          changed_at: '2026-05-03T06:30:00Z',
        };
      }
      return realGetResource(key, id);
    });

    renderWithProviders(<BasketsModule />, { capabilities: ['all'] });

    const drawer = await screen.findByTestId('baskets-drawer');
    expect(within(drawer).getByText(/Riyadh North.*3\/50/i)).toBeInTheDocument();
    expect(getSpy).toHaveBeenCalledWith(resource, legacyId);
  });

  it('transitions basket state through ui_update_basket_state_v1', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'ui_update_basket_state_v1').mockResolvedValue({
      ok: true,
      basket_id: 'bsk_ruh_north_001',
      previous_state: 'forming',
      new_state: 'ready',
      state: 'ready',
      correlation_id: 'cor_basket',
    });

    const { queryClient } = renderWithProviders(<BasketsModule />, { capabilities: ['all'] });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const basketCell = await screen.findByText(/Zone-Based Basket - Riyadh North - 3\/50/i);
    await user.click(basketCell.closest('tr')!);
    await screen.findByTestId('baskets-drawer');

    await user.click(await screen.findByRole('button', { name: /^Transition state$/i }));
    await screen.findByTestId('basket-transition-modal');
    await user.selectOptions(screen.getByLabelText('Next state'), 'ready');
    await user.click(screen.getByRole('button', { name: /^Apply transition$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ basket_id: 'bsk_ruh_north_001', state: 'ready' }),
    );
    await waitFor(() => {
      const calls = invalidateSpy.mock.calls.map(([arg]) => JSON.stringify(arg));
      expect(calls.some((call) => call.includes('"baskets"'))).toBe(true);
      expect(calls.some((call) => call.includes('"basket_transitions"'))).toBe(true);
    });
    const messages = getToasts().map((toast) => toast.message);
    expect(messages).toContain('Basket moved to Ready');
    expect(messages.some((message) => message.includes('bsk_ruh_north_001'))).toBe(false);
  });

  it('edits basket profile fields through basket_update_v1 without direct basket item mutation', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'basket_update_v1').mockResolvedValue({
      ok: true,
      basket_id: 'bsk_ruh_north_001',
      changed: { capacity_count: 60 },
      correlation_id: 'cor_basket_update',
    });

    const { queryClient } = renderWithProviders(<BasketsModule />, { capabilities: ['all'] });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const basketCell = await screen.findByText(/Zone-Based Basket - Riyadh North - 3\/50/i);
    await user.click(basketCell.closest('tr')!);
    await screen.findByTestId('baskets-drawer');
    await user.click(await screen.findByRole('button', { name: /^Edit basket$/i }));

    const modal = await screen.findByTestId('basket-edit-modal');
    expect(within(modal).getByText(/shipment membership stays on the shipment resort workflow/i)).toBeInTheDocument();
    const capacity = within(modal).getByLabelText('Basket capacity');
    await user.clear(capacity);
    await user.type(capacity, '60');
    await user.click(within(modal).getByRole('button', { name: /^Save basket$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith({
      basket_id: 'bsk_ruh_north_001',
      patch: { capacity_count: 60 },
    });
    await waitFor(() => {
      const calls = invalidateSpy.mock.calls.map(([arg]) => JSON.stringify(arg));
      expect(calls.some((call) => call.includes('"baskets"'))).toBe(true);
      expect(calls.some((call) => call.includes('"basket_items"'))).toBe(true);
    });
    expect(getToasts().map((toast) => toast.message)).toContain('Basket updated');
  });

  it('creates a basket through basket_create_v1 and invalidates basket reads', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'basket_create_v1').mockResolvedValue({
      ok: true,
      basket_id: 'bsk_console_created',
      zone_id: 'zn_ruh_north',
      basket_type: 'zone_based',
      state: 'forming',
      capacity_count: 50,
      expires_at: '2026-05-03T13:00:00Z',
      correlation_id: 'cor_basket_create',
    });

    const { queryClient } = renderWithProviders(<BasketsModule />, { capabilities: ['all'] });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await screen.findByTestId('baskets-page');
    await user.click(await screen.findByRole('button', { name: /^New basket$/i }));
    const modal = await screen.findByTestId('basket-create-modal');
    await user.click(within(modal).getByRole('button', { name: /^Create basket$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        basket_type: 'zone_based',
        state: 'forming',
        capacity_count: 50,
        expires_in_minutes: 240,
      }),
    );
    await waitFor(() => {
      const calls = invalidateSpy.mock.calls.map(([arg]) => JSON.stringify(arg));
      expect(calls.some((call) => call.includes('"baskets"'))).toBe(true);
    });
  });

  it('keeps unlabeled zones operator-safe in basket create and edit selectors', async () => {
    const user = userEvent.setup();
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string, opts) => {
      if (key === 'zones') {
        return {
          rows: [{ id: 'zn_raw_only', organization_id: 'org_rashed', name: null, slug: null, is_active: true }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(key, opts);
    });

    renderWithProviders(<BasketsModule />, { capabilities: ['all'] });

    await screen.findByTestId('baskets-page');
    await user.click(await screen.findByRole('button', { name: /^New basket$/i }));
    const createModal = await screen.findByTestId('basket-create-modal');
    expect(within(createModal).queryByText('zn_raw_only')).not.toBeInTheDocument();
    expect(within(createModal).getByText('Unnamed zone')).toBeInTheDocument();

    await user.click(within(createModal).getByRole('button', { name: /^Cancel$/i }));
    const basketCell = await screen.findByText(/Zone-Based Basket - Unzoned - 3\/50/i);
    await user.click(basketCell.closest('tr')!);
    await screen.findByTestId('baskets-drawer');
    await user.click(await screen.findByRole('button', { name: /^Edit basket$/i }));
    const editModal = await screen.findByTestId('basket-edit-modal');
    expect(within(editModal).queryByText('zn_raw_only')).not.toBeInTheDocument();
    expect(within(editModal).getByText('Unnamed zone')).toBeInTheDocument();
  });

  it('requests basket_policy changes through the canonical settings-change hook', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'proposeSettingsChange').mockResolvedValue({
      diff: { from: 'current', to: { grouping: 'zone' } },
      blast_radius: 'tenant',
      approval_required: true,
      settings_resolution_id: 'srl_basket_policy',
      dry_run: true,
      justification: 'test',
    });

    renderWithProviders(<BasketsModule />, { capabilities: ['all'] });

    await screen.findByTestId('baskets-page');
    await user.click(await screen.findByRole('button', { name: /^Basket policy$/i }));

    const modal = await screen.findByTestId('basket-policy-modal');
    expect(within(modal).queryByLabelText(/Basket policy JSON/i)).not.toBeInTheDocument();
    const enabled = within(modal).getByLabelText(/Enable automatic basket sorting/i) as HTMLInputElement;
    if (!enabled.checked) await user.click(enabled);
    expect(within(modal).queryByPlaceholderText('zone_based')).not.toBeInTheDocument();
    expect(within(modal).queryByRole('option', { name: 'Zone-based sorting' })).not.toBeInTheDocument();
    expect(within(modal).queryByRole('option', { name: 'Manual review basket' })).not.toBeInTheDocument();
    expect(within(modal).getByRole('option', { name: 'Zone-Based Basket' })).toBeInTheDocument();
    expect(within(modal).getByLabelText('Shipment route key')).toBeInTheDocument();
    expect(within(modal).queryByText('routing.route_key')).not.toBeInTheDocument();
    await user.selectOptions(within(modal).getByLabelText('Basket type'), 'zone_based');
    const openStates = within(modal).getByLabelText('Open states');
    await user.clear(openStates);
    await user.type(openStates, 'forming, ready');
    const capacity = within(modal).getByLabelText('Capacity');
    await user.clear(capacity);
    await user.type(capacity, '75');
    await user.selectOptions(within(modal).getByLabelText('Service match'), 'service_level');
    await user.click(within(modal).getByRole('button', { name: /^Preview$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      'basket_policy',
      expect.objectContaining({ tenant: expect.objectContaining({ id: expect.any(String) }) }),
      expect.objectContaining({
        enabled: true,
        basket_type: 'zone_based',
        open_states: ['forming', 'ready'],
        capacity_count: 75,
        service_match_field: 'service_level',
      }),
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('allows basket policy requests with baskets.write and without broad settings.write', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'proposeSettingsChange').mockImplementation(async (_category, _scope, _value, opts) => ({
      diff: { from: 'current', to: { enabled: true } },
      blast_radius: 'tenant',
      approval_required: true,
      settings_resolution_id: opts?.dryRun ? 'srl_basket_policy_baskets_write' : 'sv_basket_policy_baskets_write',
      dry_run: Boolean(opts?.dryRun),
      justification: 'test',
    }));

    renderWithProviders(<BasketsModule />, {
      capabilities: ['baskets.read', 'baskets.write'],
    });

    await screen.findByTestId('baskets-page');
    const policyButton = await screen.findByRole('button', { name: /^Basket policy$/i });
    expect(policyButton).toBeEnabled();
    expect(within(policyButton).queryByText(/Settings Write permission required/i)).not.toBeInTheDocument();

    await user.click(policyButton);
    const modal = await screen.findByTestId('basket-policy-modal');
    const previewButton = within(modal).getByRole('button', { name: /^Preview$/i });
    const submitButton = within(modal).getByRole('button', { name: /^Submit policy$/i });

    expect(previewButton).toBeEnabled();
    expect(submitButton).toBeEnabled();
    expect(within(previewButton).queryByText(/Settings Write permission required/i)).not.toBeInTheDocument();
    expect(within(submitButton).queryByText(/Settings Write permission required/i)).not.toBeInTheDocument();

    await user.click(previewButton);

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        'basket_policy',
        expect.objectContaining({ tenant: expect.objectContaining({ id: expect.any(String) }) }),
        expect.any(Object),
        expect.objectContaining({ dryRun: true }),
      ),
    );
    expect(await within(modal).findByTestId('basket-policy-readback')).toHaveTextContent(
      'srl_basket_policy_baskets_write',
    );

    await user.click(submitButton);

    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith(
        'basket_policy',
        expect.objectContaining({ tenant: expect.objectContaining({ id: expect.any(String) }) }),
        expect.any(Object),
        expect.objectContaining({ dryRun: false }),
      ),
    );
    expect(await within(modal).findByTestId('basket-policy-readback')).toHaveTextContent(
      'srl_basket_policy_baskets_write',
    );
  });

  it('keeps basket policy requests disabled without baskets.write even with settings.write', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'proposeSettingsChange').mockResolvedValue({
      diff: { from: 'current', to: { enabled: true } },
      blast_radius: 'tenant',
      approval_required: true,
      settings_resolution_id: 'sv_basket_policy_denied',
      dry_run: false,
      justification: 'test',
    });

    renderWithProviders(<BasketsModule />, {
      capabilities: ['baskets.read', 'settings.write'],
    });

    await screen.findByTestId('baskets-page');
    const policyButton = (await screen.findByText(/^Basket policy$/i)).closest('button');

    expect(policyButton).toBeTruthy();
    expect(policyButton).toBeDisabled();
    expect(within(policyButton!).getByText(/Baskets Write permission required/i)).toBeInTheDocument();
    await user.click(policyButton!);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps basket transition disabled without baskets.write and does not call the canonical RPC', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'ui_update_basket_state_v1').mockResolvedValue({
      ok: true,
      basket_id: 'bsk_ruh_north_001',
      previous_state: 'forming',
      new_state: 'ready',
      state: 'ready',
      correlation_id: 'cor_basket',
    });

    renderWithProviders(<BasketsModule />, { capabilities: ['baskets.read'] });

    const basketCell = await screen.findByText(/Zone-Based Basket - Riyadh North - 3\/50/i);
    await user.click(basketCell.closest('tr')!);
    await screen.findByTestId('baskets-drawer');
    const transitionButton = await screen.findByRole('button', { name: /Transition state/i });

    expect(transitionButton).toBeDisabled();
    expect(
      within(transitionButton).getByText(/Baskets Write permission required/i),
    ).toBeInTheDocument();
    await user.click(transitionButton);
    expect(spy).not.toHaveBeenCalled();
  });
});
