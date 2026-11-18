// shipments-create.test.tsx — covers the Create-shipment composer wired
// (CLAIM-INGRESS-COMPLETE) to the canonical UI create RPC
// (`api.ui_create_shipment_v1`). The backend wrapper resolves scope and runs
// the approved workflow; the frontend never writes directly to shipment tables.
//
// Targets:
//   1. Capability gate: header `Create shipment` button is disabled when
//      `shipments.write` is missing and shows the canonical CapabilityLock.
//   2. Submit success: filling client_reference_number and clicking Create
//      fires `api.ui_create_shipment_v1` with the canonical payload shape,
//      then closes the modal and pushes a success toast.
//   3. Dry-run: clicking the Dry-run button forwards `dry_run = true`,
//      keeps the modal open, and surfaces backend readback in-place.
//   4. Validation: empty client_reference_number blocks submit (no RPC call).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ShipmentsModule } from '@/modules/operate/shipments';
import * as apiMod from '@/lib/api';
import { clearToasts, getToasts } from '@/components/toastStore';

describe('ShipmentsModule · Create-shipment composer', () => {
  // Cast to a loose unknown so the spy's mock.calls type widens — the narrow
  // signature emitted by `vi.spyOn` collides with the loose
  // `MockInstance<(this: unknown, ...args: unknown[]) => unknown>` type
  // when the module's export changes between minor versions. We assert against
  // recorded call args directly below.
  let createSpy: ReturnType<typeof vi.spyOn> & {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
  };
  let amendSpy: ReturnType<typeof vi.spyOn> & {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
  };
  let telemetrySpy: ReturnType<typeof vi.spyOn> & {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
  };
  beforeEach(() => {
    window.history.pushState(null, '', '/operate/shipments');
    clearToasts();
    createSpy = vi.spyOn(apiMod, 'ui_create_shipment_v1').mockResolvedValue({
      status: 'shipment_created',
      workflow_template_id: 'tpl_create_shipment',
      workflow_run_id: 'wfr_test',
      workflow_status: 'completed',
      correlation_id: 'cor_test',
      shipment_id: 'shp_test',
      tracking_number: 'SHP-TEST',
      recipient_id: 'rcp_test',
      label_job_id: 'lj_test',
      address_workflow_run_id: 'wfr_address',
      operation: 'inserted',
      dry_run: false,
    }) as unknown as typeof createSpy;
    amendSpy = vi.spyOn(apiMod, 'shipment_amend_cancel_v1').mockResolvedValue({
      ok: true,
      workflow_template: 'tpl_update_address',
      workflow_run_id: 'wfr_address',
      started_via: 'start_workflow_run',
      canonical_entrypoint: 'progress_workflow_run',
      dry_run: false,
      diff: null,
      settings_resolution_id: 'srlv_address',
    }) as unknown as typeof amendSpy;
    telemetrySpy = vi.spyOn(apiMod, 'ui_log_event_v1').mockResolvedValue({
      ok: true,
      event_id: 'evt_shipment_create_error',
    } as never) as unknown as typeof telemetrySpy;
  });
  afterEach(() => {
    createSpy.mockRestore();
    amendSpy.mockRestore();
    telemetrySpy.mockRestore();
    clearToasts();
  });

  async function fillRequiredDestinationAddress(
    user: ReturnType<typeof userEvent.setup>,
    modal: HTMLElement,
    values: Partial<{
      line1: string;
      city: string;
      district: string;
      sa_short_code: string;
      latitude: string;
      longitude: string;
    }> = {},
  ) {
    void user;
    fireEvent.change(within(modal).getByLabelText('Address line'), {
      target: { value: values.line1 ?? 'King Fahd Road Building 10' },
    });
    if (values.district !== '') {
      fireEvent.change(within(modal).getByLabelText('District'), {
        target: { value: values.district ?? 'Al Olaya' },
      });
    }
    fireEvent.change(within(modal).getByLabelText('City'), {
      target: { value: values.city ?? 'Riyadh' },
    });
    if (values.sa_short_code != null) {
      fireEvent.change(within(modal).getByLabelText('Saudi short national address'), {
        target: { value: values.sa_short_code },
      });
    }
    if (values.latitude != null) {
      fireEvent.change(within(modal).getByLabelText('Latitude'), {
        target: { value: values.latitude },
      });
    }
    if (values.longitude != null) {
      fireEvent.change(within(modal).getByLabelText('Longitude'), {
        target: { value: values.longitude },
      });
    }
  }

  function mockMinimalShipmentCreateCatalogs(options: {
    senders?: Array<{
      id: string;
      sender_id?: string;
      name: string;
      client_id?: string | null;
      status?: string | null;
    }>;
    offerings?: Array<{
      id: string;
      is_active: boolean;
      is_active_window?: boolean | null;
      is_archived?: boolean | null;
      is_draft?: boolean | null;
      display_name?: string | null;
      base_price?: number | null;
      currency?: string | null;
      metadata?: { display?: { name?: string | null } };
    }>;
  } = {}) {
    const realList = apiMod.ui_list_resource_complete;
    return vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return { rows: [{ id: 'cl_cod', name: 'COD Client' }], total: 1, page: 0, page_size: 100 };
      }
      if (resource === 'sender_summary' || resource === 'senders') {
        return {
          rows: options.senders ?? [{
            id: 'snd_cod',
            sender_id: 'snd_cod',
            name: 'COD Sender',
            client_id: 'cl_cod',
            status: 'active',
          }],
          total: options.senders?.length ?? 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'recipients') {
        return {
          rows: [{
            id: 'rcp_cod',
            name: 'COD Recipient',
            client_id: 'cl_cod',
            phone_number: '+12025550123',
            external_id: 'COD-RCP',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'service_offering_directory') {
        return {
          rows: options.offerings ?? [{
            id: 'sof_cod',
            is_active: true,
            is_active_window: true,
            is_archived: false,
            is_draft: false,
            display_name: 'COD Express',
            base_price: 30,
            currency: 'SAR',
          }],
          total: options.offerings?.length ?? 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
  }

  function mockShipmentTableRows() {
    const realList = apiMod.ui_list_resource_v1;
    return vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [{
            id: 'shp_bulk_1',
            tracking_number: '2600BULK1',
            status: 'pending',
            service_type: 'delivery',
            client_reference_number: 'BULK-ORDER-001',
            client_label: 'Bulk Client',
            sender_label: 'Bulk Sender',
            recipient_label: 'Bulk Recipient',
            destination_city: 'Riyadh',
            destination_district: 'Al Olaya',
            cod_amount: 100,
            cod_currency: 'SAR',
            boxes_count: 1,
            active_task_count: 0,
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
  }

  function mockCreatedShipmentReadback(row: {
    id?: string;
    tracking_number?: string;
    client_reference_number?: string;
  } = {}) {
    const realList = apiMod.ui_list_resource_v1;
    const readbackRow = {
      id: row.id ?? 'shp_test',
      tracking_number: row.tracking_number ?? 'SHP-TEST',
      status: 'pending',
      service_type: 'delivery',
      client_reference_number: row.client_reference_number ?? 'EXAMPLEMARKET-TEST-001',
      client_label: 'COD Client',
      sender_label: 'COD Sender',
      recipient_label: 'COD Recipient',
      destination_city: 'Riyadh',
      destination_district: 'Al Olaya',
      cod_amount: 0,
      cod_currency: 'SAR',
      boxes_count: 1,
      active_task_count: 0,
    };
    return vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [readbackRow],
          total: 1,
          page: 0,
          page_size: opts?.page_size ?? 100,
        };
      }
      return realList(resource, opts);
    });
  }

  it('disables Create shipment + shows lock chip when `shipments.write` missing', async () => {
    renderWithProviders(<ShipmentsModule />, { capabilities: ['shipments.read'] });
    const btn = await screen.findByRole('button', { name: /Create shipment/ });
    expect(btn).toBeDisabled();
    expect(screen.getAllByText(/Shipment Update permission required/i).length).toBeGreaterThan(0);
  });

  it('opens the modal with operator-facing workflow help text', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    const btn = await screen.findByRole('button', { name: /Create shipment/ });
    await user.click(btn);
    await waitFor(() => {
      expect(document.querySelector('.modal')).not.toBeNull();
    });
    // Help text references the approved workflow path without leaking backend
    // RPC names. After the W56-B-2
    // (F6) refactor the seed picker rows resolve through `useResourceList`
    // (canonical `ui_list_resource_v1`) which adds React Query's async
    // resolution step on top of the legacy direct-import accessor. We use
    // `findByText` so the assertion polls until the canonical reads land
    // and the composer body (gated on `seedRows !== null`) renders.
    expect(
      await screen.findByText(/approved shipment creation workflow/i),
    ).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/start_workflow_run|progress_workflow_run/i);
  });

  it('scopes shipment list and directory reads to the active tenant/client/sender/recipient lens', async () => {
    window.history.pushState(null, '', '/operate/shipments?client=cl_swift&sender=snd_swift&recipient=rcp_swift');
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    renderWithProviders(<ShipmentsModule />, {
      identity: {
        capabilities: ['shipments.read', 'shipments.write'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByRole('heading', { name: /Shipments/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'shipments',
        expect.objectContaining({
          filter: {
            organization_id: 'org_swift',
            client_id: 'cl_swift',
            sender_id: 'snd_swift',
            recipient_id: 'rcp_swift',
          },
        }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'shipment_directory',
        expect.objectContaining({
          filter: {
            organization_id: 'org_swift',
            client_id: 'cl_swift',
            sender_id: 'snd_swift',
            recipient_id: 'rcp_swift',
          },
        }),
      );
    });
  });

  it('scopes create-shipment catalogs to the active tenant/client/sender lens', async () => {
    window.history.pushState(null, '', '/operate/shipments?client=cl_swift&sender=snd_swift');
    const user = userEvent.setup();
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_complete');
    renderWithProviders(<ShipmentsModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    const btn = await screen.findByRole('button', { name: /Create shipment/ });
    await user.click(btn);
    await screen.findByText(/approved shipment creation workflow/i);
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'clients',
        expect.objectContaining({ filter: { organization_id: 'org_swift', id: 'cl_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'sender_summary',
        expect.objectContaining({
          filter: { organization_id_resolved: 'org_swift', client_id: 'cl_swift', sender_id: 'snd_swift' },
        }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'recipients',
        expect.objectContaining({ filter: { organization_id: 'org_swift', client_id: 'cl_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'service_offering_directory',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
    });
  });

  it('keeps a focused shipment visible when the lookup row is outside the loaded list', async () => {
    window.history.pushState(null, '', '/operate/shipments?focus=shp_created_off_page');
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const filter = (opts?.filter ?? {}) as Record<string, string>;
      if (resource === 'shipments' && filter.identifier === 'shp_created_off_page') {
        return {
          rows: [{
            id: 'shp_created_off_page',
            tracking_number: 'SHP-FOCUS-NEW',
            status: 'pending',
            service_type: 'delivery',
            client_reference_number: 'LIFE-MANUAL-FOCUS',
          }],
          total: 1,
          page: 0,
          page_size: 1,
        };
      }
      if (resource === 'shipments') {
        return {
          rows: [{
            id: 'shp_existing',
            tracking_number: 'SHP-EXISTING',
            status: 'pending',
            service_type: 'delivery',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'shipment_directory') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });

      await screen.findByRole('heading', { name: /Shipments/ });
      await waitFor(() => {
        const tableBody = document.querySelector('.dt__table tbody') as HTMLElement | null;
        expect(tableBody).not.toBeNull();
        expect(within(tableBody as HTMLElement).getByText('SHP-FOCUS-NEW')).toBeInTheDocument();
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('clears focused shipment URL on drawer close so Create shipment works without reload', async () => {
    window.history.pushState(null, '', '/operate/shipments?focus=shp_created_off_page&tab=labels');
    const user = userEvent.setup();
    const catalogSpy = mockMinimalShipmentCreateCatalogs();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const filter = (opts?.filter ?? {}) as Record<string, string>;
      if (resource === 'shipments' && filter.identifier === 'shp_created_off_page') {
        return {
          rows: [{
            id: 'shp_created_off_page',
            tracking_number: 'SHP-FOCUS-NEW',
            status: 'pending',
            service_type: 'delivery',
            client_reference_number: 'LIFE-MANUAL-FOCUS',
          }],
          total: 1,
          page: 0,
          page_size: 1,
        };
      }
      if (resource === 'shipments') {
        return {
          rows: [{
            id: 'shp_existing',
            tracking_number: 'SHP-EXISTING',
            status: 'pending',
            service_type: 'delivery',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'shipment_directory') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });

      const focusedDrawer = await screen.findByRole('dialog', { name: /SHP-FOCUS-NEW/i });
      await user.click(within(focusedDrawer).getByLabelText('Close'));

      await waitFor(() => {
        expect(window.location.pathname).toBe('/operate/shipments');
        expect(window.location.search).toBe('');
      });

      await user.click(await screen.findByRole('button', { name: /Create shipment/ }));
      expect(await screen.findByText(/approved shipment creation workflow/i)).toBeInTheDocument();
      expect(document.querySelector('.modal')).not.toBeNull();
    } finally {
      listSpy.mockRestore();
      catalogSpy.mockRestore();
    }
  });

  it('clears stale focused shipment URL when opening Create shipment without a navigation workaround', async () => {
    window.history.pushState(null, '', '/operate/shipments?focus=shp_missing_stale&tab=labels');
    const user = userEvent.setup();
    const catalogSpy = mockMinimalShipmentCreateCatalogs();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const filter = (opts?.filter ?? {}) as Record<string, string>;
      if (resource === 'shipments' && filter.identifier === 'shp_missing_stale') {
        return { rows: [], total: 0, page: 0, page_size: 1 };
      }
      if (resource === 'shipments') {
        return {
          rows: [{
            id: 'shp_existing',
            tracking_number: 'SHP-EXISTING',
            status: 'pending',
            service_type: 'delivery',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'shipment_directory') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });

      await screen.findByRole('heading', { name: /Shipments/ });
      expect(screen.queryByRole('dialog', { name: /SHP-FOCUS-NEW/i })).not.toBeInTheDocument();
      await user.click(await screen.findByRole('button', { name: /Create shipment/ }));

      await waitFor(() => {
        expect(window.location.pathname).toBe('/operate/shipments');
        expect(window.location.search).toBe('');
      });
      expect(await screen.findByText(/approved shipment creation workflow/i)).toBeInTheDocument();
      expect(document.querySelector('.modal')).not.toBeNull();
    } finally {
      listSpy.mockRestore();
      catalogSpy.mockRestore();
    }
  });

  it('exposes shipment-default read failures instead of rendering empty create pickers', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_complete;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'clients') {
          throw new Error('42501 clients permission denied');
        }
        return realList(resource, opts);
      },
    );
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const btn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(btn);

      expect(await screen.findByText('Shipment defaults unavailable')).toBeInTheDocument();
      expect(screen.getByText('42501 clients permission denied')).toBeInTheDocument();
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('blocks submit when client_reference_number is empty', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs();
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const btn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(btn);
      await waitFor(() => {
        expect(document.querySelector('.modal')).not.toBeNull();
      });
      // Wait for the seed catalogs to load (clients/senders/recipients) so the
      // Create button enables.
      await screen.findByRole('button', { name: /^Create$/ });
      const create = screen.getByRole('button', { name: /^Create$/ });
      await user.click(create);
      expect(createSpy).not.toHaveBeenCalled();
      expect(screen.getByText(/Client reference is required/)).toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('clears create validation after correction and submits decimal COD', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs();
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const btn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(btn);
      await screen.findByRole('button', { name: /^Create$/ });
      const modal = document.querySelector('.modal') as HTMLElement;
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));
      expect(screen.getByText(/Client reference is required/)).toBeInTheDocument();

      fireEvent.change(within(modal).getByLabelText('Client reference'), {
        target: { value: 'COD-DECIMAL-001' },
      });
      expect(screen.queryByText(/Client reference is required/)).not.toBeInTheDocument();

      fireEvent.change(within(modal).getByLabelText(/COD amount/i), {
        target: { value: '87.50' },
      });
      await fillRequiredDestinationAddress(user, modal, {
        sa_short_code: 'rnqa7082',
        latitude: '24.7136',
        longitude: '46.6753',
      });
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
      });
      const [payload] = createSpy.mock.calls[0] as [Record<string, unknown>];
      expect(payload).toMatchObject({
        client_reference_number: 'COD-DECIMAL-001',
        cod_amount: 87.5,
        cod_currency: expect.any(String),
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('blocks invalid COD before calling the backend', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs();
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const btn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(btn);
      await screen.findByRole('button', { name: /^Create$/ });
      const modal = document.querySelector('.modal') as HTMLElement;
      fireEvent.change(within(modal).getByLabelText('Client reference'), {
        target: { value: 'COD-INVALID-001' },
      });
      fireEvent.change(within(modal).getByLabelText(/COD amount/i), {
        target: { value: '-1' },
      });
      await fillRequiredDestinationAddress(user, modal, {
        sa_short_code: 'rnqa7082',
        latitude: '24.7136',
        longitude: '46.6753',
      });
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      expect(createSpy).not.toHaveBeenCalled();
      expect(screen.getByText(/COD amount must be zero or greater/i)).toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('fires ui_create_shipment_v1 with the right payload on Create', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs();
    const readbackSpy = mockCreatedShipmentReadback();
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await waitFor(() => {
        expect(document.querySelector('.modal')).not.toBeNull();
      });
      // Wait for seed catalogs.
      await screen.findByRole('button', { name: /^Create$/ });
      const modal = document.querySelector('.modal') as HTMLElement;
      const refInput = within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281');
      await user.type(refInput, 'EXAMPLEMARKET-TEST-001');
      fireEvent.input(within(modal).getByLabelText('Promised date'), {
        target: { value: '2026-05-12' },
      });
      await fillRequiredDestinationAddress(user, modal, {
        sa_short_code: 'rnqa7082',
        latitude: '24.7136',
        longitude: '46.6753',
      });
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));
      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
      });
      const [ctx] = createSpy.mock.calls[0] as [unknown];
      const payload = ctx as Record<string, unknown>;
      expect(payload.client_reference_number).toBe('EXAMPLEMARKET-TEST-001');
      expect(payload.service_type).toBeUndefined();
      expect(payload.service_offering_id).toBeTruthy();
      expect(payload.promised_delivery_date).toBe('2026-05-12');
      expect(payload.client_id).toBeTruthy();
      expect(payload.sender_id).toBeTruthy();
      expect(payload.recipient_id).toBeTruthy();
    expect(payload.new_recipient).toBeFalsy();
    expect(payload.destination_address).toMatchObject({
      line1: 'King Fahd Road Building 10',
      district: 'Al Olaya',
      city: 'Riyadh',
      sa_short_code: 'RNQA7082',
      latitude: 24.7136,
      longitude: 46.6753,
      coordinates: {
        latitude: 24.7136,
        longitude: 46.6753,
      },
    });
    expect(payload.dry_run).toBe(false);
    expect(amendSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(window.location.pathname).toBe('/operate/shipments');
      expect(window.location.search).toBe('?focus=shp_test');
    });
    } finally {
      readbackSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('waits for backend-refreshed shipment readback before reporting create success', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs();
    const realList = apiMod.ui_list_resource_v1;
    let gateReadback = false;
    let readbackStarted = false;
    let focusedIdentifierReadbacks = 0;
    const labelJobReadbacks: Array<Record<string, unknown>> = [];
    let releaseReadback: (() => void) | undefined;
    const readbackGate = new Promise<void>((resolve) => {
      releaseReadback = resolve;
    });
    const rowSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const identifier = (opts?.filter as { identifier?: string } | undefined)?.identifier;
      if (
        gateReadback &&
        (resource === 'shipments' || resource === 'shipment_directory') &&
        identifier === 'shp_create_readback_gate'
      ) {
        focusedIdentifierReadbacks += 1;
        if (focusedIdentifierReadbacks > 2) {
          return {
            rows: [],
            total: 0,
            page: 0,
            page_size: opts?.page_size ?? 100,
          };
        }
        readbackStarted = true;
        await readbackGate;
        const readbackRow = {
          id: 'shp_create_readback_gate',
          tracking_number: 'SHP-CREATE-READBACK',
          status: 'pending',
          service_type: 'delivery',
          client_reference_number: 'CREATE-READBACK-001',
          client_label: 'COD Client',
          sender_label: 'COD Sender',
          recipient_label: 'COD Recipient',
          destination_city: 'Riyadh',
          destination_district: 'Al Olaya',
          cod_amount: 0,
          cod_currency: 'SAR',
          boxes_count: 1,
          active_task_count: 0,
        };
        return {
          rows: [resource === 'shipment_directory'
            ? { ...readbackRow, id: 'dir_create_readback_gate', shipment_id: 'shp_create_readback_gate' }
            : readbackRow],
          total: 1,
          page: 0,
          page_size: opts?.page_size ?? 100,
        };
      }
      if (resource === 'label_jobs') {
        labelJobReadbacks.push((opts?.filter ?? {}) as Record<string, unknown>);
        return {
          rows: [],
          total: 0,
          page: 0,
          page_size: opts?.page_size ?? 100,
        };
      }
      return realList(resource, opts);
    });
    createSpy.mockResolvedValueOnce({
      status: 'shipment_created',
      workflow_template_id: 'tpl_create_shipment',
      workflow_run_id: 'wfr_create_readback_gate',
      workflow_status: 'completed',
      correlation_id: 'cor_create_readback_gate',
      shipment_id: 'shp_create_readback_gate',
      tracking_number: 'SHP-CREATE-READBACK',
      recipient_id: 'rcp_cod',
      label_job_id: 'lj_create_readback_gate',
      address_workflow_run_id: 'wfr_create_readback_address',
      operation: 'inserted',
      dry_run: false,
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await user.click(await screen.findByRole('button', { name: /Create shipment/ }));
      await screen.findByText(/approved shipment creation workflow/i);
      const modal = document.querySelector('.modal') as HTMLElement;
      fireEvent.change(within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281'), {
        target: { value: 'CREATE-READBACK-001' },
      });
      await fillRequiredDestinationAddress(user, modal);

      gateReadback = true;
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(readbackStarted).toBe(true);
      });
      expect(document.querySelector('.modal')).toBe(modal);
      expect(window.location.search).toBe('');
      expect(getToasts().some((toast) => /Shipment and address created/i.test(toast.message))).toBe(false);

      await act(async () => {
        releaseReadback?.();
      });

      await waitFor(() => {
        expect(document.querySelector('.modal')).toBeNull();
        expect(window.location.search).toBe('?focus=shp_create_readback_gate');
        expect(screen.getAllByText(/SHP-CREATE-READBACK/).length).toBeGreaterThan(0);
      });
      await waitFor(() => {
        expect(labelJobReadbacks).toContainEqual(expect.objectContaining({
          shipment_id: 'shp_create_readback_gate',
        }));
      });
      const createdShipmentDrawer = document.querySelector('.drawer') as HTMLElement;
      await user.click(within(createdShipmentDrawer).getByLabelText('Close'));
      await waitFor(() => {
        expect(document.querySelector('.drawer')).toBeNull();
        expect(window.location.search).toBe('');
      });
      expect(focusedIdentifierReadbacks).toBeGreaterThanOrEqual(2);
    } finally {
      rowSpy.mockRestore();
      listSpy.mockRestore();
    }
  }, 15000);

  it('keeps create modal open when backend-refreshed shipment readback is incomplete', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs();
    const realRead = apiMod.ui_list_resource_v1;
    const rowSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const identifier = (opts?.filter as { identifier?: string } | undefined)?.identifier;
      if (identifier === 'shp_readback_missing_directory' && resource === 'shipments') {
        return {
          rows: [{
            id: 'shp_readback_missing_directory',
            tracking_number: 'SHP-READBACK-MISSING-DIRECTORY',
            status: 'pending',
            service_type: 'delivery',
            client_reference_number: 'READBACK-MISSING-DIRECTORY-001',
          }],
          total: 1,
          page: 0,
          page_size: opts?.page_size ?? 100,
        };
      }
      if (identifier === 'shp_readback_missing_directory' && resource === 'shipment_directory') {
        return {
          rows: [],
          total: 0,
          page: 0,
          page_size: opts?.page_size ?? 100,
        };
      }
      return realRead(resource, opts);
    });
    createSpy.mockResolvedValueOnce({
      status: 'shipment_created',
      workflow_template_id: 'tpl_create_shipment',
      workflow_run_id: 'wfr_readback_missing_directory',
      workflow_status: 'completed',
      correlation_id: 'cor_readback_missing_directory',
      shipment_id: 'shp_readback_missing_directory',
      tracking_number: 'SHP-READBACK-MISSING-DIRECTORY',
      recipient_id: 'rcp_cod',
      label_job_id: 'lj_readback_missing_directory',
      address_workflow_run_id: 'wfr_address_readback_missing_directory',
      operation: 'inserted',
      dry_run: false,
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await user.click(await screen.findByRole('button', { name: /Create shipment/ }));
      await screen.findByText(/approved shipment creation workflow/i);
      const modal = document.querySelector('.modal') as HTMLElement;
      fireEvent.change(within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281'), {
        target: { value: 'READBACK-MISSING-DIRECTORY-001' },
      });
      await fillRequiredDestinationAddress(user, modal);
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      expect(
        await within(modal).findByText(/Shipment could not be created\. Check the form and try again\./i),
      ).toBeInTheDocument();
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.modal')).toBe(modal);
      expect(document.querySelector('.drawer')).toBeNull();
      expect(window.location.pathname).toBe('/operate/shipments');
      expect(window.location.search).toBe('');
      expect(getToasts().some((toast) => /Shipment and address created/i.test(toast.message))).toBe(false);
      expect(telemetrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'ui.error',
          payload: expect.objectContaining({
            message: 'Created shipment did not appear in backend-refreshed shipment lists.',
            surface: 'operate.shipments.create',
            operation: 'manual_shipment_final_create',
          }),
        }),
        'console-v2',
      );
    } finally {
      rowSpy.mockRestore();
      listSpy.mockRestore();
    }
  }, 15000);

  it('keeps the create modal open after backend address failure and clears the error on address correction', async () => {
    const user = userEvent.setup();
    createSpy
      .mockRejectedValueOnce(new Error('ui_create_manual_shipment_intake_v1 address amendment failed: geocode_failed'))
      .mockResolvedValueOnce({
        status: 'shipment_created',
        workflow_template_id: 'tpl_create_shipment',
        workflow_run_id: 'wfr_address_retry',
        workflow_status: 'completed',
        correlation_id: 'cor_address_retry',
        shipment_id: 'shp_address_retry',
        tracking_number: 'SHP-ADDRESS-RETRY',
        recipient_id: 'rcp_cod',
        label_job_id: 'lj_address_retry',
        address_workflow_run_id: 'wfr_address_retry_geocode',
        operation: 'inserted',
        dry_run: false,
      });
    const listSpy = mockMinimalShipmentCreateCatalogs();
    const readbackSpy = mockCreatedShipmentReadback({
      id: 'shp_address_retry',
      tracking_number: 'SHP-ADDRESS-RETRY',
      client_reference_number: 'ADDRESS-FAIL-001',
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await user.click(await screen.findByRole('button', { name: /Create shipment/ }));
      const modal = document.querySelector('.modal') as HTMLElement;
      fireEvent.change(within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281'), {
        target: { value: 'ADDRESS-FAIL-001' },
      });
      await fillRequiredDestinationAddress(user, modal, {
        line1: 'Ambiguous address tower',
        district: 'Unknown district',
        city: 'Riyadh',
      });
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      expect(
        await within(modal).findByText(/Address verification failed\. Check the destination address and try again\./i),
      ).toBeInTheDocument();
      expect(
        within(modal).queryByText(/ui_create_manual_shipment_intake_v1 address amendment failed: geocode_failed/i),
      ).not.toBeInTheDocument();
      expect(telemetrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'ui.error',
          payload: expect.objectContaining({
            message: 'ui_create_manual_shipment_intake_v1 address amendment failed: geocode_failed',
            surface: 'operate.shipments.create',
            operation: 'manual_shipment_final_create',
          }),
        }),
        'console-v2',
      );
      expect(document.querySelector('.modal')).toBe(modal);
      expect(window.location.pathname).toBe('/operate/shipments');
      expect(window.location.search).toBe('');

      fireEvent.change(within(modal).getByLabelText('Address line'), {
        target: { value: 'King Fahd Road Building 10 corrected' },
      });
      await waitFor(() => {
        expect(
          within(modal).queryByText(/Address verification failed\. Check the destination address and try again\./i),
        ).not.toBeInTheDocument();
      });
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(2);
        expect(document.querySelector('.modal')).toBeNull();
      });
      expect(window.location.search).toBe('?focus=shp_address_retry');
    } finally {
      readbackSpy.mockRestore();
      listSpy.mockRestore();
    }
  }, 15000);

  it('keeps the create modal open after backend address policy rejection', async () => {
    const user = userEvent.setup();
    createSpy.mockRejectedValueOnce(
      new Error('ui_create_manual_shipment_intake_v1 address amendment failed: shipment_status_not_allowed'),
    );
    const listSpy = mockMinimalShipmentCreateCatalogs();

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await user.click(await screen.findByRole('button', { name: /Create shipment/ }));
      const modal = document.querySelector('.modal') as HTMLElement;
      fireEvent.change(within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281'), {
        target: { value: 'ADDRESS-POLICY-REJECT-001' },
      });
      await fillRequiredDestinationAddress(user, modal, {
        line1: 'Policy blocked address',
        district: 'Al Olaya',
        city: 'Riyadh',
      });
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      expect(
        await within(modal).findByText(
          /Shipment creation is blocked by the current shipment state\. Check the shipment details and try again\./i,
        ),
      ).toBeInTheDocument();
      expect(
        within(modal).queryByText(/ui_create_manual_shipment_intake_v1 address amendment failed: shipment_status_not_allowed/i),
      ).not.toBeInTheDocument();
      expect(telemetrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'ui.error',
          payload: expect.objectContaining({
            message: 'ui_create_manual_shipment_intake_v1 address amendment failed: shipment_status_not_allowed',
            surface: 'operate.shipments.create',
            operation: 'manual_shipment_final_create',
          }),
        }),
        'console-v2',
      );
      expect(document.querySelector('.modal')).toBe(modal);
      expect(window.location.pathname).toBe('/operate/shipments');
      expect(window.location.search).toBe('');
    } finally {
      listSpy.mockRestore();
    }
  }, 15000);

  it('opens an existing shipment when backend reuses a duplicate client reference', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs();
    const realRead = apiMod.ui_list_resource_v1;
    const rowSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [{
            id: 'shp_existing',
            tracking_number: 'SHP-EXISTING',
            status: 'pending',
            service_type: 'delivery',
            client_reference_number: 'DUPLICATE-CLIENT-REF-001',
            client_label: 'COD Client',
            sender_label: 'COD Sender',
            recipient_label: 'COD Recipient',
            destination_city: 'Riyadh',
            destination_district: 'Al Olaya',
            cod_amount: 91.75,
            cod_currency: 'SAR',
            boxes_count: 1,
            active_task_count: 0,
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realRead(resource, opts);
    });
    createSpy.mockResolvedValueOnce({
      ok: true,
      status: 'manual_shipment_intake_reused',
      dry_run: false,
      recipient_mode: 'existing',
      recipient_id: 'rcp_cod',
      shipment_id: 'shp_existing',
      tracking_number: 'SHP-EXISTING',
      operation: 'reused_client_reference',
      duplicate_reused: true,
      decision_log_id: 'dlg_duplicate_ref',
      address_result: { skipped: true, reason: 'duplicate_reference_reuse' },
      label_result: { skipped: true, reason: 'duplicate_reference_reuse' },
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await screen.findByText(/approved shipment creation workflow/i);
      const modal = document.querySelector('.modal') as HTMLElement;
      fireEvent.change(within(modal).getByLabelText('Client reference'), {
        target: { value: 'DUPLICATE-CLIENT-REF-001' },
      });
      await fillRequiredDestinationAddress(user, modal, {
        line1: 'Duplicate replay should not amend address',
        city: 'Riyadh',
      });
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.modal')).toBeNull();
        expect(window.location.search).toBe('?focus=shp_existing');
      });

      const toastMessages = getToasts().map((toast) => toast.message).join('\n');
      expect(toastMessages).toMatch(/Existing shipment opened/i);
      expect(toastMessages).toMatch(/duplicate client reference/i);
      expect(toastMessages).toMatch(/SHP-EXISTING/i);
      expect(toastMessages).not.toMatch(/Shipment and address created/i);
      expect(toastMessages).not.toMatch(/label queued/i);
      expect(await screen.findByRole('dialog', { name: /SHP-EXISTING/i })).toBeInTheDocument();
    } finally {
      rowSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('keeps sender and recipient choices scoped to the selected client before submit', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_complete;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const filter = (opts?.filter ?? {}) as Record<string, string>;
      if (resource === 'clients') {
        return {
          rows: [
            { id: 'cl_launch_a', name: 'Launch Client A' },
            { id: 'cl_launch_b', name: 'Launch Client B' },
          ],
          total: 2,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'sender_summary' || resource === 'senders') {
        const allSenders = [
          { id: 'snd_launch_a', sender_id: 'snd_launch_a', name: 'Launch Sender A', client_id: 'cl_launch_a' },
          { id: 'snd_launch_b', sender_id: 'snd_launch_b', name: 'Launch Sender B', client_id: 'cl_launch_b' },
        ];
        const rows = filter.client_id
          ? allSenders.filter((sender) => sender.client_id === filter.client_id)
          : allSenders;
        return { rows, total: rows.length, page: 0, page_size: 100 };
      }
      if (resource === 'recipients') {
        const allRecipients = [
          { id: 'rcp_launch_a', name: 'Launch Recipient A', client_id: 'cl_launch_a' },
          { id: 'rcp_launch_b', name: 'Launch Recipient B', client_id: 'cl_launch_b' },
        ];
        const rows = filter.client_id
          ? allRecipients.filter((recipient) => recipient.client_id === filter.client_id)
          : allRecipients;
        return { rows, total: rows.length, page: 0, page_size: 100 };
      }
      if (resource === 'service_offering_directory') {
        return {
          rows: [
            {
              id: 'sof_launch',
              is_active: true,
              is_active_window: true,
              is_archived: false,
              is_draft: false,
              display_name: 'Launch Express',
              base_price: 25,
              currency: 'SAR',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    const readbackSpy = mockCreatedShipmentReadback({
      id: 'shp_test',
      tracking_number: 'SHP-TEST',
      client_reference_number: 'INLINE-RCP-ORDER-001',
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await screen.findByText(/approved shipment creation workflow/i);
      const modal = document.querySelector('.modal') as HTMLElement;
      const clientSelect = within(modal).getByLabelText('Client') as HTMLSelectElement;
      const senderSelect = within(modal).getByLabelText('Sender') as HTMLSelectElement;
      const recipientSelect = within(modal).getByLabelText('Recipient') as HTMLSelectElement;

      await waitFor(() => {
        expect(clientSelect.value).toBe('cl_launch_a');
        expect(senderSelect.value).toBe('snd_launch_a');
        expect(recipientSelect.value).toBe('rcp_launch_a');
      });

      await user.selectOptions(clientSelect, 'cl_launch_b');

      await waitFor(() => {
        expect(senderSelect.value).toBe('snd_launch_b');
        expect(recipientSelect.value).toBe('rcp_launch_b');
      });
      expect(Array.from(senderSelect.options).map((option) => option.value)).toEqual(['snd_launch_b']);
      expect(Array.from(recipientSelect.options).map((option) => option.value)).toEqual(['rcp_launch_b']);

      const refInput = within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281');
      await user.type(refInput, 'LAUNCH-CLIENT-B-001');
      await fillRequiredDestinationAddress(user, modal);
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
      });
      const [ctx] = createSpy.mock.calls[0] as [unknown];
      expect(ctx).toMatchObject({
        client_id: 'cl_launch_b',
        sender_id: 'snd_launch_b',
        recipient_id: 'rcp_launch_b',
        client_reference_number: 'LAUNCH-CLIENT-B-001',
      });
    } finally {
      readbackSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('sends a missing recipient, destination address, and label request in one shipment intake envelope', async () => {
    const user = userEvent.setup();
    const recipientCreateSpy = vi
      .spyOn(apiMod, 'recipient_create_v1')
      .mockResolvedValue({
        ok: true,
        recipient_id: 'rcp_inline_created',
        correlation_id: 'cor_recipient_inline',
        settings_resolution_id: 'srlv_recipient_inline',
      });
    const realList = apiMod.ui_list_resource_complete;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_launch_inline', name: 'Launch Inline Client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'sender_summary' || resource === 'senders') {
        return {
          rows: [{
            id: 'snd_launch_inline',
            sender_id: 'snd_launch_inline',
            name: 'Launch Inline Sender',
            client_id: 'cl_launch_inline',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'recipients') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      if (resource === 'service_offering_directory') {
        return {
          rows: [
            {
              id: 'sof_launch_inline',
              is_active: true,
              is_active_window: true,
              is_archived: false,
              is_draft: false,
              display_name: 'Launch Inline Express',
              base_price: 30,
              currency: 'SAR',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    const readbackSpy = mockCreatedShipmentReadback({
      id: 'shp_test',
      tracking_number: 'SHP-TEST',
      client_reference_number: 'INLINE-RCP-ORDER-001',
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await screen.findByText(/approved shipment creation workflow/i);
      const modal = document.querySelector('.modal') as HTMLElement;
      await user.click(within(modal).getByRole('button', { name: /New recipient/i }));

      fireEvent.change(within(modal).getByLabelText('Recipient name'), {
        target: { value: 'Inline Recipient' },
      });
      fireEvent.change(within(modal).getByLabelText('Recipient phone'), {
        target: { value: '+966500001111' },
      });
      fireEvent.change(within(modal).getByLabelText('Recipient email'), {
        target: { value: 'inline.recipient@example.com' },
      });
      fireEvent.change(within(modal).getByLabelText('Recipient external ID'), {
        target: { value: 'EXT-RCP-INLINE' },
      });
      await user.selectOptions(within(modal).getByLabelText('Language'), 'ar');
      await user.selectOptions(within(modal).getByLabelText('Channel'), 'whatsapp');
      fireEvent.change(within(modal).getByLabelText('Quiet from'), {
        target: { value: '22:00' },
      });
      fireEvent.change(within(modal).getByLabelText('Quiet to'), {
        target: { value: '08:00' },
      });
      fireEvent.change(within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281'), {
        target: { value: 'INLINE-RCP-ORDER-001' },
      });
      await fillRequiredDestinationAddress(user, modal, {
        line1: 'Inline recipient villa 7',
        district: 'Al Yasmin',
        city: 'Riyadh',
      });
      fireEvent.change(within(modal).getByLabelText('Promised date'), {
        target: { value: '2026-05-07' },
      });
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      await waitFor(() => {
        expect(recipientCreateSpy).not.toHaveBeenCalled();
        expect(createSpy).toHaveBeenCalledTimes(1);
      });
      const [shipmentPayload] = createSpy.mock.calls[0] as [Record<string, unknown>];
      expect(shipmentPayload).toMatchObject({
        client_id: 'cl_launch_inline',
        sender_id: 'snd_launch_inline',
        recipient_id: undefined,
        new_recipient: expect.objectContaining({
          name: 'Inline Recipient',
          phone_number: '+966500001111',
          email: 'inline.recipient@example.com',
          external_id: 'EXT-RCP-INLINE',
          preferred_language: 'ar',
          preferred_comm_channel: 'whatsapp',
          quiet_hours_start: '22:00',
          quiet_hours_end: '08:00',
        }),
        destination_address: expect.objectContaining({
          line1: 'Inline recipient villa 7',
          district: 'Al Yasmin',
          city: 'Riyadh',
        }),
        client_reference_number: 'INLINE-RCP-ORDER-001',
        promised_delivery_date: '2026-05-07',
        dry_run: false,
      });
      expect(getToasts().some((toast) => /label queued/i.test(toast.message))).toBe(true);
      expect(amendSpy).not.toHaveBeenCalled();
    } finally {
      readbackSpy.mockRestore();
      recipientCreateSpy.mockRestore();
      listSpy.mockRestore();
    }
  }, 15000);

  it('makes an inline-created recipient selectable in the next shipment create flow without reload', async () => {
    const user = userEvent.setup();
    const inlineRecipient = {
      id: 'rcp_inline_refetch',
      name: 'Inline Refetch Recipient',
      client_id: 'cl_inline_refetch',
      phone_number: '+966500009901',
      external_id: 'EXT-INLINE-REFETCH',
    };
    let recipientRows: Array<Record<string, unknown>> = [];
    createSpy.mockImplementation(async () => {
      recipientRows = [inlineRecipient];
      return {
        status: 'shipment_created',
        workflow_template_id: 'tpl_create_shipment',
        workflow_run_id: 'wfr_inline_refetch',
        workflow_status: 'completed',
        correlation_id: 'cor_inline_refetch',
        shipment_id: 'shp_inline_refetch',
        tracking_number: 'SHP-INLINE-REFETCH',
        recipient_id: inlineRecipient.id,
        label_job_id: 'lj_inline_refetch',
        address_workflow_run_id: 'wfr_address_inline_refetch',
        operation: 'inserted',
        dry_run: false,
      };
    });
    const realList = apiMod.ui_list_resource_complete;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_inline_refetch', name: 'Inline Refetch Client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'sender_summary' || resource === 'senders') {
        return {
          rows: [{
            id: 'snd_inline_refetch',
            sender_id: 'snd_inline_refetch',
            name: 'Inline Refetch Sender',
            client_id: 'cl_inline_refetch',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'recipients') {
        return { rows: recipientRows, total: recipientRows.length, page: 0, page_size: 100 };
      }
      if (resource === 'service_offering_directory') {
        return {
          rows: [
            {
              id: 'sof_inline_refetch',
              is_active: true,
              is_active_window: true,
              is_archived: false,
              is_draft: false,
              display_name: 'Inline Refetch Express',
              base_price: 30,
              currency: 'SAR',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    const readbackSpy = mockCreatedShipmentReadback({
      id: 'shp_inline_refetch',
      tracking_number: 'SHP-INLINE-REFETCH',
      client_reference_number: 'INLINE-REFETCH-ORDER-001',
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await user.click(await screen.findByRole('button', { name: /Create shipment/ }));
      let modal = document.querySelector('.modal') as HTMLElement;
      await user.click(within(modal).getByRole('button', { name: /New recipient/i }));
      fireEvent.change(within(modal).getByLabelText('Recipient name'), {
        target: { value: inlineRecipient.name },
      });
      fireEvent.change(within(modal).getByLabelText('Recipient phone'), {
        target: { value: inlineRecipient.phone_number },
      });
      fireEvent.change(within(modal).getByLabelText('Recipient external ID'), {
        target: { value: inlineRecipient.external_id },
      });
      fireEvent.change(within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281'), {
        target: { value: 'INLINE-REFETCH-ORDER-001' },
      });
      await fillRequiredDestinationAddress(user, modal, {
        line1: 'Inline refetch address',
        district: 'Al Malqa',
        city: 'Riyadh',
      });
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.modal')).toBeNull();
      });
      expect(window.location.pathname).toBe('/operate/shipments');
      await waitFor(() => {
        expect(document.querySelector('.drawer')?.textContent).toContain('SHP-INLINE-REFETCH');
      });
      const createdShipmentDrawer = document.querySelector('.drawer') as HTMLElement;
      await user.click(within(createdShipmentDrawer).getByLabelText('Close'));
      await waitFor(() => {
        expect(document.querySelector('.drawer')).toBeNull();
      });
      expect(window.location.pathname).toBe('/operate/shipments');

      await user.click(await screen.findByRole('button', { name: /Create shipment/ }));
      modal = document.querySelector('.modal') as HTMLElement;
      await user.type(within(modal).getByLabelText('Find recipient'), 'Inline Refetch');
      const recipientSelect = within(modal).getByLabelText('Recipient') as HTMLSelectElement;

      await waitFor(() => {
        expect(Array.from(recipientSelect.options).map((option) => option.value)).toContain(inlineRecipient.id);
      });
      expect(recipientSelect.value).toBe(inlineRecipient.id);
      expect(Array.from(recipientSelect.options).some((option) => option.textContent?.includes(inlineRecipient.name))).toBe(true);
      expect(window.location.pathname).toBe('/operate/shipments');
    } finally {
      readbackSpy.mockRestore();
      listSpy.mockRestore();
    }
  }, 15000);

  it('passes the active tenant lens to ui_create_shipment_v1 for platform operators', async () => {
    window.history.pushState(null, '', '/operate/shipments?client=cl_swift&sender=snd_swift');
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_complete;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return { rows: [{ id: 'cl_swift', name: 'Swift Client' }], total: 1, page: 0, page_size: 100 };
      }
      if (resource === 'sender_summary' || resource === 'senders') {
        return {
          rows: [{ id: 'snd_swift', sender_id: 'snd_swift', name: 'Swift Sender', client_id: 'cl_swift' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'recipients') {
        return { rows: [{ id: 'rcp_swift', name: 'Swift Recipient' }], total: 1, page: 0, page_size: 100 };
      }
      if (resource === 'service_offering_directory') {
        return {
          rows: [
            {
              id: 'sof_swift',
              is_active: true,
              is_active_window: true,
              is_archived: false,
              is_draft: false,
              display_name: 'Swift Express',
              base_price: 45,
              currency: 'SAR',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    renderWithProviders(<ShipmentsModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    try {
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await screen.findByText(/approved shipment creation workflow/i);
      const modal = document.querySelector('.modal') as HTMLElement;
      const refInput = within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281');
      await user.type(refInput, 'SWIFT-TENANT-ORDER-001');
      await fillRequiredDestinationAddress(user, modal);
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
      });
      const [ctx] = createSpy.mock.calls[0] as [unknown];
      expect((ctx as { organization_id?: string }).organization_id).toBe('org_swift');
    } finally {
      listSpy.mockRestore();
    }
  });

  it('forwards dry_run=true on the preview path and keeps the modal open', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs();
    createSpy.mockResolvedValueOnce({
      status: 'shipment_create_previewed',
      workflow_template_id: 'tpl_create_shipment',
      workflow_run_id: 'wfr_dry_run_preview',
      workflow_status: 'completed',
      correlation_id: 'cor_dry_run_preview',
      recipient_id: 'rcp_cod',
      dry_run: true,
    });
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await waitFor(() => {
        expect(document.querySelector('.modal')).not.toBeNull();
      });
      await screen.findByRole('button', { name: /Preview creation/ });
      const modal = document.querySelector('.modal') as HTMLElement;
      const refInput = within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281');
      await user.type(refInput, 'EXAMPLEMARKET-DRYRUN');
      await fillRequiredDestinationAddress(user, modal);
      await user.click(within(modal).getByRole('button', { name: /Preview creation/ }));
      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
      });
      const [ctx] = createSpy.mock.calls[0] as [unknown];
      expect((ctx as { dry_run?: boolean })?.dry_run).toBe(true);
      expect(amendSpy).not.toHaveBeenCalled();
      // Modal is still mounted after preview.
      expect(document.querySelector('.modal')).not.toBeNull();
      const readback = await within(modal).findByTestId('shipment-create-preview-status');
      expect(within(readback).getByText(/^Preview$/i)).toBeInTheDocument();
      expect(within(readback).getByText('Ready')).toBeInTheDocument();
      expect(within(readback).getByText('Prepared')).toBeInTheDocument();
      expect(readback).not.toHaveTextContent('wfr_dry_run_preview');
      expect(readback).not.toHaveTextContent('cor_dry_run_preview');

      fireEvent.change(refInput, { target: { value: 'EXAMPLEMARKET-DRYRUN-EDITED' } });
      expect(within(modal).queryByTestId('shipment-create-preview-status')).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('allows dry-run preview with a new recipient without creating the recipient separately', async () => {
    const user = userEvent.setup();
    const recipientCreateSpy = vi
      .spyOn(apiMod, 'recipient_create_v1')
      .mockResolvedValue({ ok: true, recipient_id: 'rcp_should_not_create', correlation_id: 'corr_preview_inline' });
    const realList = apiMod.ui_list_resource_complete;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return { rows: [{ id: 'cl_preview_inline', name: 'Preview Inline Client' }], total: 1, page: 0, page_size: 100 };
      }
      if (resource === 'sender_summary' || resource === 'senders') {
        return {
          rows: [{
            id: 'snd_preview_inline',
            sender_id: 'snd_preview_inline',
            name: 'Preview Inline Sender',
            client_id: 'cl_preview_inline',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'recipients') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      if (resource === 'service_offering_directory') {
        return {
          rows: [{
            id: 'sof_preview_inline',
            is_active: true,
            is_active_window: true,
            is_archived: false,
            is_draft: false,
            display_name: 'Preview Inline Express',
            base_price: 30,
            currency: 'SAR',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await screen.findByText(/approved shipment creation workflow/i);
      const modal = document.querySelector('.modal') as HTMLElement;
      await user.click(within(modal).getByRole('button', { name: /New recipient/i }));
      await user.type(within(modal).getByLabelText('Recipient name'), 'Preview Recipient');
      await user.type(within(modal).getByLabelText('Recipient phone'), '+12025550123');
      await user.type(within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281'), 'INLINE-RCP-PREVIEW-001');
      await fillRequiredDestinationAddress(user, modal, {
        line1: 'Preview recipient tower 4',
        district: 'Al Malqa',
        city: 'Riyadh',
      });
      await user.click(within(modal).getByRole('button', { name: /Preview creation/ }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
      });
      const [payload] = createSpy.mock.calls[0] as [Record<string, unknown>];
      expect(payload).toMatchObject({
        client_id: 'cl_preview_inline',
        sender_id: 'snd_preview_inline',
        dry_run: true,
        new_recipient: expect.objectContaining({
          name: 'Preview Recipient',
          phone_number: '+12025550123',
        }),
        destination_address: expect.objectContaining({
          line1: 'Preview recipient tower 4',
          city: 'Riyadh',
        }),
      });
      expect(recipientCreateSpy).not.toHaveBeenCalled();
      expect(amendSpy).not.toHaveBeenCalled();
      expect(document.querySelector('.modal')).not.toBeNull();
    } finally {
      recipientCreateSpy.mockRestore();
      listSpy.mockRestore();
    }
  }, 15000);

  it('rejects non-E.164 phone numbers for inline new recipients before shipment creation', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs();
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await screen.findByText(/approved shipment creation workflow/i);
      const modal = document.querySelector('.modal') as HTMLElement;
      await user.click(within(modal).getByRole('button', { name: /New recipient/i }));
      await user.type(within(modal).getByLabelText('Recipient name'), 'Invalid Inline Recipient');
      await user.type(within(modal).getByLabelText('Recipient phone'), 'not-a-phone');
      await user.type(within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281'), 'INLINE-RCP-INVALID-PHONE');
      await fillRequiredDestinationAddress(user, modal);
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      expect(createSpy).not.toHaveBeenCalled();
      expect(await within(modal).findByText(/Recipient phone must be in E\.164 format/i)).toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('detects a duplicate new-recipient phone and lets the operator reuse the existing recipient', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_complete;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return { rows: [{ id: 'cl_duplicate', name: 'Duplicate Client' }], total: 1, page: 0, page_size: 100 };
      }
      if (resource === 'sender_summary' || resource === 'senders') {
        return {
          rows: [{
            id: 'snd_duplicate',
            sender_id: 'snd_duplicate',
            name: 'Duplicate Sender',
            client_id: 'cl_duplicate',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'recipients') {
        return {
          rows: [
            {
              id: 'rcp_first',
              name: 'First Recipient Should Not Be Selected',
              client_id: 'cl_duplicate',
              phone_number: '+966500002222',
              external_id: 'EXT-FIRST',
            },
            {
              id: 'rcp_duplicate',
              name: 'Existing Duplicate Recipient',
              client_id: 'cl_duplicate',
              phone_number: '+966500001111',
              external_id: 'EXT-DUPLICATE',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'service_offering_directory') {
        return {
          rows: [{
            id: 'sof_duplicate',
            is_active: true,
            is_active_window: true,
            is_archived: false,
            is_draft: false,
            display_name: 'Duplicate Express',
            base_price: 30,
            currency: 'SAR',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await screen.findByText(/approved shipment creation workflow/i);
      const modal = document.querySelector('.modal') as HTMLElement;
      await user.click(within(modal).getByRole('button', { name: /New recipient/i }));
      await user.type(within(modal).getByLabelText('Recipient name'), 'Duplicate Draft');
      await user.type(within(modal).getByLabelText('Recipient phone'), '+966 50 000 1111');
      expect(await within(modal).findByText(/Existing recipient match/i)).toBeInTheDocument();

      await user.click(within(modal).getByRole('button', { name: /Use existing/i }));
      const recipientSelect = within(modal).getByLabelText('Recipient') as HTMLSelectElement;
      await waitFor(() => {
        expect(recipientSelect.value).toBe('rcp_duplicate');
      });
      expect(recipientSelect.selectedOptions[0]?.textContent).toContain('Existing Duplicate Recipient');
      expect(recipientSelect.selectedOptions[0]?.textContent).not.toContain('First Recipient Should Not Be Selected');
      await user.type(within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281'), 'DUPLICATE-RCP-ORDER-001');
      await fillRequiredDestinationAddress(user, modal, {
        line1: 'Duplicate recipient office',
        city: 'Riyadh',
      });
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
      });
      const [payload] = createSpy.mock.calls[0] as [Record<string, unknown>];
      expect(payload).toMatchObject({
        client_id: 'cl_duplicate',
        sender_id: 'snd_duplicate',
        recipient_id: 'rcp_duplicate',
        new_recipient: null,
        client_reference_number: 'DUPLICATE-RCP-ORDER-001',
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('searches the complete recipient catalog before submitting an existing recipient', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_complete;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return { rows: [{ id: 'cl_rich', name: 'Rich Catalog Client' }], total: 1, page: 0, page_size: 1 };
      }
      if (resource === 'sender_summary' || resource === 'senders') {
        return {
          rows: [{
            id: 'snd_rich',
            sender_id: 'snd_rich',
            name: 'Rich Catalog Sender',
            client_id: 'cl_rich',
          }],
          total: 1,
          page: 0,
          page_size: 1,
        };
      }
      if (resource === 'recipients') {
        return {
          rows: [
            {
              id: 'rcp_first',
              name: 'First Visible Recipient',
              client_id: 'cl_rich',
              phone_number: '+12025550123',
              external_id: 'EXT-FIRST',
            },
            {
              id: 'rcp_far',
              name: 'Rare Search Recipient',
              client_id: 'cl_rich',
              phone_number: '+12025550123',
              external_id: 'EXT-RARE',
            },
          ],
          total: 2,
          page: 0,
          page_size: 2,
        };
      }
      if (resource === 'service_offering_directory') {
        return {
          rows: [{
            id: 'sof_rich',
            is_active: true,
            is_active_window: true,
            is_archived: false,
            is_draft: false,
            display_name: 'Rich Express',
            base_price: 30,
            currency: 'SAR',
          }],
          total: 1,
          page: 0,
          page_size: 1,
        };
      }
      return realList(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await screen.findByText(/approved shipment creation workflow/i);
      const modal = document.querySelector('.modal') as HTMLElement;
      await user.type(within(modal).getByLabelText('Find recipient'), 'rare');
      await user.selectOptions(within(modal).getByLabelText('Recipient'), 'rcp_far');
      await user.type(within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281'), 'RICH-RCP-ORDER-001');
      await fillRequiredDestinationAddress(user, modal, {
        line1: 'Rich recipient office',
        city: 'Riyadh',
      });
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
      });
      const [payload] = createSpy.mock.calls[0] as [Record<string, unknown>];
      expect(payload).toMatchObject({
        client_id: 'cl_rich',
        sender_id: 'snd_rich',
        recipient_id: 'rcp_far',
        new_recipient: null,
        client_reference_number: 'RICH-RCP-ORDER-001',
      });
      expect(listSpy).toHaveBeenCalledWith(
        'recipients',
        expect.objectContaining({ filter: { organization_id: 'org_rashed' } }),
      );
    } finally {
      listSpy.mockRestore();
    }
  }, 15000);

  it('requires recipient-write permission for inline-recipient preview and create', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_complete;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return { rows: [{ id: 'cl_no_recipient_write', name: 'Permission Client' }], total: 1, page: 0, page_size: 1 };
      }
      if (resource === 'sender_summary' || resource === 'senders') {
        return {
          rows: [{
            id: 'snd_no_recipient_write',
            sender_id: 'snd_no_recipient_write',
            name: 'Permission Sender',
            client_id: 'cl_no_recipient_write',
          }],
          total: 1,
          page: 0,
          page_size: 1,
        };
      }
      if (resource === 'recipients') {
        return { rows: [], total: 0, page: 0, page_size: 0 };
      }
      if (resource === 'service_offering_directory') {
        return {
          rows: [{
            id: 'sof_no_recipient_write',
            is_active: true,
            is_active_window: true,
            is_archived: false,
            is_draft: false,
            display_name: 'Permission Express',
            base_price: 30,
            currency: 'SAR',
          }],
          total: 1,
          page: 0,
          page_size: 1,
        };
      }
      return realList(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, {
        capabilities: ['shipments.read', 'shipments.write', 'recipients.read'],
      });
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await screen.findByText(/approved shipment creation workflow/i);
      const modal = document.querySelector('.modal') as HTMLElement;

      expect(await within(modal).findByLabelText('Recipient name')).toBeInTheDocument();
      expect(within(modal).getAllByText(/Recipient Update permission required/i).length).toBeGreaterThan(0);
      expect(within(modal).getByRole('button', { name: /Preview creation/ })).toBeDisabled();
      expect(within(modal).getByRole('button', { name: /^Create Recipient Update permission required$/ })).toBeDisabled();
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
    }
  });

  // CLAIM-CATALOG-OFFERINGS (Wave 2, Phase B). The service_type select used to
  // be hardcoded to ['standard','express','same_day']. After the catalog
  // claim it must be sourced from the canonical `service_offerings` registry.
  // This is the load-bearing payoff of the catalog module.
  it('service_type select is row-driven from the service offering directory (no hardcoded options)', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs({
      offerings: [
        { id: 'sof_eco_kingdom', is_active: true, is_active_window: true, is_archived: false, is_draft: false, display_name: 'Kingdom Economy', base_price: 18, currency: 'SAR' },
        { id: 'sof_exp_airbridge', is_active: true, is_active_window: true, is_archived: false, is_draft: false, display_name: 'Air-Bridge Express', base_price: 40, currency: 'SAR' },
        { id: 'sof_wg_ruh', is_active: true, is_active_window: true, is_archived: false, is_draft: false, display_name: 'Riyadh White Glove', base_price: 70, currency: 'SAR' },
        { id: 'sof_same_day_jed', is_active: true, is_active_window: true, is_archived: false, is_draft: false, display_name: 'Jeddah Same Day', base_price: 55, currency: 'SAR' },
        { id: 'sof_return_collect', is_active: true, is_active_window: true, is_archived: false, is_draft: false, display_name: 'Return Collect', base_price: 25, currency: 'SAR' },
        { id: 'sof_archived', is_active: true, is_active_window: true, is_archived: true, is_draft: false, display_name: 'Archived Offering', base_price: 1, currency: 'SAR' },
      ],
    });
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const headerBtn = await screen.findByRole('button', { name: /Create shipment/ });
      await user.click(headerBtn);
      await waitFor(() => {
        expect(document.querySelector('.modal')).not.toBeNull();
      });
      // Wait for the async catalog query to resolve so options populate.
      const select = await screen.findByTestId('shipments-create-service-type');
      await waitFor(
        () => {
          const opts = Array.from(select.querySelectorAll('option'));
          expect(opts.length).toBeGreaterThanOrEqual(5);
        },
        { timeout: 3000 },
      );
      const options = Array.from(select.querySelectorAll('option'));
      const optionValues = options.map((o) => o.getAttribute('value'));
      // The legacy hardcoded literals must NOT be present as option values.
      expect(optionValues).not.toContain('standard');
      expect(optionValues).not.toContain('express');
      expect(optionValues).not.toContain('same_day');
      // The select exposes active backend offering ids and filters archived rows.
      expect(optionValues).toContain('sof_eco_kingdom');
      expect(optionValues).toContain('sof_exp_airbridge');
      expect(optionValues).toContain('sof_wg_ruh');
      expect(optionValues).not.toContain('sof_archived');
      // Each option label should include the display name from the directory.
      const expressOption = options.find((o) => o.getAttribute('value') === 'sof_exp_airbridge');
      expect(expressOption?.textContent).toMatch(/Air-Bridge Express/);
      // Pick a different offering and submit. The payload must keep
      // service_type canonical and send the offering as backend-validated
      // metadata.
      await user.selectOptions(select, 'sof_wg_ruh');
      const modal = document.querySelector('.modal') as HTMLElement;
      const refInput = within(modal).getByPlaceholderText('e.g. EXAMPLEMARKET-99281');
      await user.type(refInput, 'EXAMPLEMARKET-CATALOG-001');
      await fillRequiredDestinationAddress(user, modal);
      await user.click(within(modal).getByRole('button', { name: /^Create$/ }));
      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
      });
      const [ctx] = createSpy.mock.calls[0] as [unknown];
      expect((ctx as { service_type?: string }).service_type).toBeUndefined();
      expect((ctx as { service_offering_id: string }).service_offering_id).toBe('sof_wg_ruh');
    } finally {
      listSpy.mockRestore();
    }
  });

  it('filters inactive senders from manual shipment creation and blocks intake when none are active', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs({
      senders: [
        {
          id: 'snd_inactive_only',
          sender_id: 'snd_inactive_only',
          name: 'Inactive Sender',
          client_id: 'cl_cod',
          status: 'inactive',
        },
      ],
    });
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await user.click(await screen.findByRole('button', { name: /Create shipment/ }));
      const modal = document.querySelector('.modal') as HTMLElement;
      expect(await within(modal).findByText(/No active sender configured/i)).toBeInTheDocument();
      expect(within(modal).getByText(/Reactivate or create a sender/i)).toBeInTheDocument();
      expect(within(modal).getByRole('button', { name: /^Create$/ })).toBeDisabled();
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('keeps inactive senders out of the manual shipment sender picker when active senders exist', async () => {
    const user = userEvent.setup();
    const listSpy = mockMinimalShipmentCreateCatalogs({
      senders: [
        {
          id: 'snd_inactive_hidden',
          sender_id: 'snd_inactive_hidden',
          name: 'Inactive Hidden Sender',
          client_id: 'cl_cod',
          status: 'inactive',
        },
        {
          id: 'snd_active_visible',
          sender_id: 'snd_active_visible',
          name: 'Active Visible Sender',
          client_id: 'cl_cod',
          status: 'active',
        },
      ],
    });
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await user.click(await screen.findByRole('button', { name: /Create shipment/ }));
      const modal = document.querySelector('.modal') as HTMLElement;
      const senderSelect = within(modal).getByLabelText('Sender') as HTMLSelectElement;
      await waitFor(() => {
        const labels = Array.from(senderSelect.options).map((option) => option.textContent ?? '');
        expect(labels).toContain('Active Visible Sender');
        expect(labels).not.toContain('Inactive Hidden Sender');
      });
      expect(senderSelect.value).toBe('snd_active_visible');
    } finally {
      listSpy.mockRestore();
    }
  });

  it('bulk cancel apply calls the canonical batch operation without dry-run', async () => {
    const user = userEvent.setup();
    const batchSpy = vi
      .spyOn(apiMod, 'ui_execute_shipment_batch_operation_v1')
      .mockResolvedValue({ ok: true, count: 1 } as never);
    const listSpy = mockShipmentTableRows();
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
      });
      const firstRowCheckbox = screen
        .getAllByRole('checkbox')
        .find((cb) => cb.getAttribute('aria-label') === 'Select row');
      if (!firstRowCheckbox) throw new Error('No row checkbox');
      await user.click(firstRowCheckbox);

      const apply = await screen.findByRole('button', { name: /Bulk cancel apply/i });
      await user.click(apply);

      await waitFor(() => {
        expect(batchSpy).toHaveBeenCalledTimes(1);
      });
      const [ids, op, payload, opts] = batchSpy.mock.calls[0] as [
        string[],
        string,
        Record<string, unknown>,
        { dryRun?: boolean } | undefined,
      ];
      expect(ids.length).toBeGreaterThan(0);
      expect(ids[0]).not.toMatch(/^SHP-/);
      expect(op).toBe('cancel');
      expect(payload).toMatchObject({ source: 'console_v2.shipments.bulk_cancel_apply' });
      expect(!!opts?.dryRun).toBe(false);
    } finally {
      listSpy.mockRestore();
      batchSpy.mockRestore();
    }
  });

  it('bulk print labels calls the canonical print command with selected shipment ids', async () => {
    const user = userEvent.setup();
    const commandSpy = vi.spyOn(apiMod, 'runCommand').mockResolvedValue({
      ok: true,
      command: 'shipments.print_labels',
      params: {},
      dry_run: false,
      settings_resolution_id: 'srlv_bulk_print_test',
      workflow_run_id: 'wfr_bulk_print_test',
    } as never);
    const listSpy = mockShipmentTableRows();
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
      });
      const firstRowCheckbox = screen
        .getAllByRole('checkbox')
        .find((cb) => cb.getAttribute('aria-label') === 'Select row');
      if (!firstRowCheckbox) throw new Error('No row checkbox');
      await user.click(firstRowCheckbox);

      const print = await screen.findByRole('button', { name: /Bulk print labels/i });
      await user.click(print);

      await waitFor(() => {
        expect(commandSpy).toHaveBeenCalledTimes(1);
      });
      const [commandKey, params, opts] = commandSpy.mock.calls[0] as [
        string,
        Record<string, unknown>,
        { dryRun?: boolean },
      ];
      expect(commandKey).toBe('shipments.print_labels');
      expect(params).toMatchObject({
        resource_key: 'shipments',
        selection_count: 1,
        job_purpose: 'primary',
        source: 'console_v2.shipments.bulk_print_labels',
      });
      expect(params.selected_ids).toEqual([expect.any(String)]);
      expect((params.selected_ids as string[])[0]).not.toMatch(/^SHP-/);
      expect(!!opts?.dryRun).toBe(false);
    } finally {
      listSpy.mockRestore();
      commandSpy.mockRestore();
    }
  });

  it('ships import intake from the shipments workbench and does not expose unsupported bulk amend execution', async () => {
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    expect(screen.getByRole('button', { name: /Import shipments/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bulk amend preview/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Bulk amend \/ cancel/i })).toBeInTheDocument();
  });
});
