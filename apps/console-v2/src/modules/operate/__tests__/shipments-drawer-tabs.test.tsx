// shipments-drawer-tabs.test.tsx — covers CLAIM-OPERATIONS-WIRING (Phase C1)
// drawer tab read-seam wiring. Each tab now consumes the canonical resource
// registry (`ui_list_resource_v1`) instead of `api.seed.*`, so the production
// swap is a single getSupabaseClient() branch flip — module call sites stay
// stable.
//
// Asserted behavior:
//   1. Boxes / Labels / Scans / Comms tabs all fire `ui_list_resource_v1`
//      with the canonical resource key + a `shipment_id` filter.
//   2. The legacy `api.seed.*` reads for those tabs are NOT invoked.
//
// We spy on the data-source seam directly (same pattern used by
// shipments-reschedule.test.tsx) so the assertion observes the swap-point
// without needing MSW for purely client-side flows.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { clearToasts, getToasts } from '@/components/toastStore';
import {
  ShipmentsModule,
  ShipmentContextPanel,
  isCompletedRouteStopEvidenceTask,
  podEvidenceProjectionFromRow,
  resolveShipmentTaskTarget,
  selectActiveShipmentLabel,
} from '@/modules/operate/shipments';
import * as facadeApi from '@/lib/api';
import * as ds from '@/lib/data-source';

const REAL_LIST = ds.ui_list_resource_v1;
const REAL_COMPLETE_LIST = ds.ui_list_resource_complete;
const REAL_GET = ds.ui_get_resource_v1;
const REAL_TIMELINE = ds.ui_get_shipment_timeline_v1;
const REAL_RUN_COMMAND = ds.runCommand;
const REAL_GET_LOOKUPS = ds.getLookups;
const REAL_RESOLVE_DOWNLOAD = facadeApi.resolve_resource_download_url_v1;
const LIST_SPY = vi.spyOn(ds, 'ui_list_resource_v1');
const COMPLETE_LIST_SPY = vi.spyOn(ds, 'ui_list_resource_complete');
const GET_SPY = vi.spyOn(ds, 'ui_get_resource_v1');
const TIMELINE_SPY = vi.spyOn(ds, 'ui_get_shipment_timeline_v1');
const OPERATION_OPTIONS_SPY = vi.spyOn(ds, 'shipment_amend_cancel_options_v1');
const RUN_COMMAND_SPY = vi.spyOn(ds, 'runCommand');
const RESOLVE_DOWNLOAD_SPY = vi.spyOn(facadeApi, 'resolve_resource_download_url_v1');
const RESOLVE_MANUAL_REVIEW_SPY = vi.spyOn(ds, 'resolve_manual_review_task_v1');
const SHIPMENT_DETAIL_FIXTURES = new Map<string, Record<string, unknown>>();
const DEFAULT_BASKET_ID = 'bsk_drawer_default';
const DEFAULT_ROUTE_RUN_ID = 'rr_drawer_default';
const DEFAULT_SHIPMENT_ROW: Record<string, unknown> = {
  id: 'shp_drawer_default',
  shipment_id: 'shp_drawer_default',
  organization_id: 'org_drawer_default',
  tracking_number: 'SHP-DRAWER-DEFAULT',
  client_reference_number: 'CLIENT-DRAWER-DEFAULT',
  carrier_reference_number: 'CARRIER-DRAWER-DEFAULT',
  client_name: 'Drawer Test Client',
  sender_name: 'Drawer Test Sender',
  recipient_id: 'rec_drawer_default',
  recipient_name: 'Drawer Test Recipient',
  destination_address_id: 'addr_drawer_default',
  destination_city: 'Riyadh',
  destination_district: 'Al Olaya',
  destination_country: 'SA',
  status: 'pending',
  service_type: 'standard',
  cod_amount: 120,
  cod_currency: 'SAR',
  box_count: 1,
};

function shipmentFixture<T extends Record<string, unknown>>(row: T): T {
  const id = typeof row.id === 'string' ? row.id : '';
  if (id) SHIPMENT_DETAIL_FIXTURES.set(id, row);
  return row;
}

function shipmentDetailFixture(resource: string, id: string) {
  if (resource !== 'shipments') return null;
  return SHIPMENT_DETAIL_FIXTURES.get(id) ?? null;
}

async function defaultShipmentDrawerList(
  resource: string,
  opts?: Parameters<typeof REAL_LIST>[1],
) {
  if (resource === 'shipments' || resource === 'shipment_directory') {
    const shipmentId = String(opts?.filter?.shipment_id ?? DEFAULT_SHIPMENT_ROW.id);
    return {
      rows: [shipmentFixture({ ...DEFAULT_SHIPMENT_ROW, id: shipmentId, shipment_id: shipmentId })],
      total: 1,
      page: opts?.page ?? 0,
      page_size: opts?.page_size ?? 25,
    };
  }
  if (resource === 'basket_items') {
    const shipmentId = String(opts?.filter?.shipment_id ?? DEFAULT_SHIPMENT_ROW.id);
    return {
      rows: [{
        id: 'bit_drawer_default',
        shipment_id: shipmentId,
        basket_id: DEFAULT_BASKET_ID,
        added_at: '2026-05-09T08:00:00Z',
        state: 'active',
      }],
      total: 1,
      page: opts?.page ?? 0,
      page_size: opts?.page_size ?? 500,
    };
  }
  if (resource === 'route_stops') {
    const shipmentId = String(opts?.filter?.shipment_id ?? DEFAULT_SHIPMENT_ROW.id);
    return {
      rows: [{
        id: 'rs_drawer_default',
        shipment_id: shipmentId,
        route_run_id: DEFAULT_ROUTE_RUN_ID,
        stop_sequence: 1,
        status: 'planned',
      }],
      total: 1,
      page: opts?.page ?? 0,
      page_size: opts?.page_size ?? 25,
    };
  }
  return REAL_LIST(resource, opts);
}

function defaultShipmentDrawerGet(resource: string, id: string) {
  if (resource === 'baskets' && id === DEFAULT_BASKET_ID) {
    return {
      id,
      code: 'BASKET-DRAWER-DEFAULT',
      name: 'Drawer default basket',
      basket_type: 'shipment_basket',
      state: 'active',
      current_count: 1,
      capacity_count: 25,
    };
  }
  if (resource === 'route_runs' && id === DEFAULT_ROUTE_RUN_ID) {
    return {
      id,
      code: 'ROUTE-DRAWER-DEFAULT',
      status: 'planned',
      driver_name: 'Drawer Driver',
      vehicle_plate: 'DRV-001',
    };
  }
  if (resource === 'recipients' && id === DEFAULT_SHIPMENT_ROW.recipient_id) {
    return {
      id,
      name: DEFAULT_SHIPMENT_ROW.recipient_name,
      phone_number: '+12025550123',
      preferred_language: 'en',
    };
  }
  if (resource === 'addresses' && id === DEFAULT_SHIPMENT_ROW.destination_address_id) {
    return {
      id,
      line1: 'King Fahd Road',
      city: DEFAULT_SHIPMENT_ROW.destination_city,
      district: DEFAULT_SHIPMENT_ROW.destination_district,
      country_code: DEFAULT_SHIPMENT_ROW.destination_country,
      sa_short_code: 'RNQA7083',
      coordinates: '0101000020E6100000F5DBD78173564740BB270F0BB5B63840',
      validation_status: 'valid',
    };
  }
  return null;
}

beforeEach(() => {
  SHIPMENT_DETAIL_FIXTURES.clear();
  LIST_SPY.mockClear();
  LIST_SPY.mockImplementation(defaultShipmentDrawerList);
  COMPLETE_LIST_SPY.mockClear();
  COMPLETE_LIST_SPY.mockImplementation(REAL_COMPLETE_LIST);
  GET_SPY.mockClear();
  GET_SPY.mockImplementation(async (resource, id) => {
    const fixture = shipmentDetailFixture(resource, id);
    if (fixture) return fixture;
    const defaultFixture = defaultShipmentDrawerGet(resource, id);
    if (defaultFixture) return defaultFixture;
    return REAL_GET(resource, id);
  });
  TIMELINE_SPY.mockClear();
  TIMELINE_SPY.mockImplementation(REAL_TIMELINE);
  OPERATION_OPTIONS_SPY.mockClear();
  OPERATION_OPTIONS_SPY.mockImplementation(async (shipmentId) => ({
    shipment_id: shipmentId,
    status: 'pending',
    lock_source: 'shipment_operation_policy',
    operations: {
      modify: { operation: 'modify', allowed: true, lock_source: 'shipment_operation_policy', status: 'pending' },
      address: { operation: 'address', allowed: true, lock_source: 'shipment_operation_policy', status: 'pending' },
      reschedule: { operation: 'reschedule', allowed: true, lock_source: 'shipment_operation_policy', status: 'pending' },
      cancel: { operation: 'cancel', allowed: true, lock_source: 'shipment_operation_policy', status: 'pending' },
    },
  }));
  RUN_COMMAND_SPY.mockClear();
  RUN_COMMAND_SPY.mockImplementation(REAL_RUN_COMMAND);
  RESOLVE_DOWNLOAD_SPY.mockClear();
  RESOLVE_DOWNLOAD_SPY.mockImplementation(REAL_RESOLVE_DOWNLOAD);
  RESOLVE_MANUAL_REVIEW_SPY.mockClear();
  RESOLVE_MANUAL_REVIEW_SPY.mockResolvedValue({
    id: 'mrt_drawer_review',
    status: 'resolved',
    resolution_outcome: 'approved',
  });
  window.history.pushState(null, '', '/operate/shipments');
});

async function openFirstShipmentDrawer(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(screen.getAllByRole('button', { name: 'Row actions' }).length).toBeGreaterThan(0);
  });
  await user.click(document.querySelector('.dt__table tbody tr') as Element);
  await waitFor(() => {
    expect(document.querySelector('.drawer')).not.toBeNull();
  });
}

async function clickRailTab(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const target = await waitFor(() => screen.getByRole('tab', { name: new RegExp(escaped, 'i') }));
  expect(target).toBeTruthy();
  await user.click(target as HTMLElement);
  await waitFor(() => {
    expect((target as HTMLElement).getAttribute('aria-selected')).toBe('true');
  });
}

describe('ShipmentsModule · drawer tabs · canonical registry reads', () => {
  it('does not render fallback shipment facts while the backend context read is loading', async () => {
    GET_SPY.mockImplementation(async (resource, id) => {
      if (resource === 'shipments' && id === 'shp_pending_context') {
        return await new Promise<never>(() => {});
      }
      return REAL_GET(resource, id);
    });

    renderWithProviders(
      <ShipmentContextPanel
        shipmentId="shp_pending_context"
        fallbackShipment={{
          id: 'shp_pending_context',
          tracking_number: 'FALLBACK-TRACKING',
          status: 'unknown',
          service_type: 'delivery',
        }}
      />,
      { capabilities: ['all'] },
    );

    expect(await screen.findByText('Loading shipment context')).toBeInTheDocument();
    expect(screen.getByText(/Loading shipment record FALLBACK-TRACKING/i)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Timeline' })).not.toBeInTheDocument();
    expect(screen.queryByText('unknown')).not.toBeInTheDocument();
    expect(screen.queryByText('delivery')).not.toBeInTheDocument();
  });

  it('shipment summary edits require canonical shipment read-back before success', async () => {
    clearToasts();
    const user = userEvent.setup();
    const shipment = shipmentFixture({
      id: 'shp_summary_edit_readback',
      tracking_number: 'SHP-SUMMARY-001',
      client_reference_number: 'CLIENT-OLD',
      carrier_reference_number: 'CARR-OLD',
      status: 'created',
      service_type: 'delivery',
      cod_amount: 120,
      cod_currency: 'SAR',
      destination_city: 'Riyadh',
    });
    const amendSpy = vi.spyOn(ds, 'shipment_amend_cancel_v1').mockImplementation(async (shipmentId, op, payload, opts) => {
      expect(shipmentId).toBe('shp_summary_edit_readback');
      expect(op).toBe('amend_field');
      expect(payload).toEqual({ carrier_reference_number: 'CARR-NEW' });
      expect(opts).toEqual({ dryRun: false });
      SHIPMENT_DETAIL_FIXTURES.set('shp_summary_edit_readback', {
        ...shipment,
        carrier_reference_number: 'CARR-NEW',
      });
      return {
        ok: true,
        workflow_template: 'shipment_modify_v1',
        workflow_run_id: 'wf_summary_readback',
        started_via: 'console_v2',
        canonical_entrypoint: 'public.progress_workflow_run',
        dry_run: false,
        diff: { carrier_reference_number: { before: 'CARR-OLD', after: 'CARR-NEW' } },
        settings_resolution_id: 'srlv_summary_readback',
      };
    });

    renderWithProviders(<ShipmentContextPanel shipmentId="shp_summary_edit_readback" />, {
      capabilities: ['all'],
    });

    await screen.findByText('SHP-SUMMARY-001');
    await user.click(screen.getByText('CARR-OLD'));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'CARR-NEW{Enter}');

    await waitFor(() => expect(amendSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(
        GET_SPY.mock.calls.some(
          ([resource, id]) => resource === 'shipments' && id === 'shp_summary_edit_readback',
        ),
      ).toBe(true);
      expect(getToasts().some((toast) => toast.message.includes('Saved · carrier_reference_number'))).toBe(true);
    });
    clearToasts();
    amendSpy.mockRestore();
  });

  it('shipment summary edit fails closed when read-back does not match', async () => {
    clearToasts();
    const user = userEvent.setup();
    shipmentFixture({
      id: 'shp_summary_edit_mismatch',
      tracking_number: 'SHP-SUMMARY-002',
      client_reference_number: 'CLIENT-OLD',
      carrier_reference_number: 'CARR-OLD',
      status: 'created',
      service_type: 'delivery',
      cod_amount: 120,
      cod_currency: 'SAR',
      destination_city: 'Riyadh',
    });
    const amendSpy = vi.spyOn(ds, 'shipment_amend_cancel_v1').mockResolvedValue({
      ok: true,
      workflow_template: 'shipment_modify_v1',
      workflow_run_id: 'wf_summary_mismatch',
      started_via: 'console_v2',
      canonical_entrypoint: 'public.progress_workflow_run',
      dry_run: false,
      diff: { carrier_reference_number: { before: 'CARR-OLD', after: 'CARR-NEW' } },
      settings_resolution_id: 'srlv_summary_mismatch',
    });

    renderWithProviders(<ShipmentContextPanel shipmentId="shp_summary_edit_mismatch" />, {
      capabilities: ['all'],
    });

    await screen.findByText('SHP-SUMMARY-002');
    await user.click(screen.getByText('CARR-OLD'));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'CARR-NEW{Enter}');

    await waitFor(() => expect(amendSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(getToasts().some((toast) => toast.message.includes('Shipment summary could not be updated. Try again.'))).toBe(true);
    });
    expect(getToasts().some((toast) => toast.message.includes('Saved · carrier_reference_number'))).toBe(false);
    clearToasts();
    amendSpy.mockRestore();
  });

  it('shipment summary keeps formatted and derived fields read-only', async () => {
    shipmentFixture({
      id: 'shp_summary_readonly',
      tracking_number: 'SHP-SUMMARY-003',
      client_reference_number: 'CLIENT-EDITABLE',
      carrier_reference_number: 'CARR-EDITABLE',
      status: 'created',
      service_type: 'delivery',
      cod_amount: 120,
      cod_currency: 'SAR',
      destination_city: 'Riyadh',
      promised_delivery_date: '2026-05-08T10:00:00.000Z',
    });

    renderWithProviders(<ShipmentContextPanel shipmentId="shp_summary_readonly" />, {
      capabilities: ['all'],
    });

    await screen.findByText('SHP-SUMMARY-003');
    const editableTexts = Array.from(document.querySelectorAll('.kvgrid__val--editable'))
      .map((node) => node.textContent?.trim() ?? '');
    expect(editableTexts).toContain('CLIENT-EDITABLE');
    expect(editableTexts).toContain('CARR-EDITABLE');
    expect(editableTexts.some((text) => text.includes('Riyadh'))).toBe(false);
    expect(editableTexts.some((text) => text.includes('SAR'))).toBe(false);
  });

  it('selects the current active label by version metadata, not returned row order', () => {
    const selected = selectActiveShipmentLabel([
      {
        id: 'lbl_old_first',
        active_version_id: 'lv_old',
        active_version_number: 1,
        last_printed_at: '2026-04-20T10:00:00Z',
      },
      {
        id: 'lbl_missing_active',
        active_version_id: null,
        active_version_number: 999,
        last_printed_at: '2026-04-30T10:00:00Z',
      },
      {
        id: 'lbl_current',
        active_version_id: 'lv_current',
        active_version_number: 3,
        last_printed_at: '2026-04-21T10:00:00Z',
      },
    ]);

    expect(selected?.id).toBe('lbl_current');
  });

  it('renders the shipment workbench tabs in the domain order', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    const labels = Array.from(document.querySelectorAll('.rail-tab > span:first-child')).map((el) =>
      (el.textContent ?? '').trim(),
    );
    expect(labels).toEqual([
      'Timeline',
      'Evidence',
      'Boxes',
      'Baskets',
      'Recipient',
      'Address',
      'COD',
      'Route',
      'Tasks',
      'Comms',
      'Labels',
      'Scans',
      'Decisions',
      'Audit',
    ]);
  });

  it('Address tab surfaces backend geocode confidence and review state', async () => {
    const user = userEvent.setup();
    LIST_SPY.mockImplementation(async (resource, opts) => {
      const addressId = String(opts?.filter?.address_id ?? '');
      if (resource === 'geocodes' && addressId === DEFAULT_SHIPMENT_ROW.destination_address_id) {
        return {
          rows: [{
            id: 'geo_drawer_review',
            address_id: addressId,
            provider_name: 'row_driven_policy',
            confidence_score: 0.82,
            accuracy_type: 'approximate',
            formatted_address: 'King Fahd Road, Al Olaya, Riyadh',
            is_primary: true,
            geocoded_at: '2026-07-04T08:00:00Z',
          }],
          total: 1,
          page: opts?.page ?? 0,
          page_size: opts?.page_size ?? 10,
        };
      }
      if (resource === 'geocoding_attempts' && addressId === DEFAULT_SHIPMENT_ROW.destination_address_id) {
        return {
          rows: [{
            id: 'gatt_drawer_review',
            address_id: addressId,
            provider_name: 'row_driven_policy',
            attempt_type: 'manual_review',
            status: 'deferred',
            confidence_score: 0.82,
            decision_outcome: 'review_required',
            created_at: '2026-07-04T08:01:00Z',
          }],
          total: 1,
          page: opts?.page ?? 0,
          page_size: opts?.page_size ?? 10,
        };
      }
      if (resource === 'manual_review_tasks' && addressId === DEFAULT_SHIPMENT_ROW.destination_address_id) {
        return {
          rows: [{
            id: 'mrt_drawer_review',
            address_id: addressId,
            shipment_id: DEFAULT_SHIPMENT_ROW.id,
            task_type: 'geocoding',
            reason: 'low_confidence',
            status: 'pending',
            queue_assignment: 'geocoding_review',
            resolution_outcome: null,
            resolved_at: null,
            updated_at: '2026-07-04T08:02:00Z',
          }],
          total: 1,
          page: opts?.page ?? 0,
          page_size: opts?.page_size ?? 10,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Address');

    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(await within(drawer).findByText('Geocoding readback')).toBeInTheDocument();
    expect(within(drawer).getByText('Saudi short address')).toBeInTheDocument();
    expect(within(drawer).getByText('RNQA7083')).toBeInTheDocument();
    expect(within(drawer).getByText('82%')).toBeInTheDocument();
    expect(within(drawer).getByText('Approximate')).toBeInTheDocument();
    expect(within(drawer).getByText('Manual Review')).toBeInTheDocument();
    expect(within(drawer).getAllByText('Pending').length).toBeGreaterThan(0);
    expect(within(drawer).getByText('Geocoding Review')).toBeInTheDocument();
    expect(within(drawer).getByText('Low Confidence')).toBeInTheDocument();
    expect(within(drawer).getByText('Not Resolved')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: /Approve review/i }));
    await waitFor(() => {
      expect(RESOLVE_MANUAL_REVIEW_SPY).toHaveBeenCalledWith('mrt_drawer_review', {
        resolution_outcome: 'approved',
        resolution_notes: expect.stringContaining('SHP-DRAWER-DEFAULT'),
      });
    });
    expect(LIST_SPY.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'geocodes',
          expect.objectContaining({
            filter: { address_id: DEFAULT_SHIPMENT_ROW.destination_address_id },
          }),
        ],
        [
          'geocoding_attempts',
          expect.objectContaining({
            filter: { address_id: DEFAULT_SHIPMENT_ROW.destination_address_id },
          }),
        ],
        [
          'manual_review_tasks',
          expect.objectContaining({
            filter: { address_id: DEFAULT_SHIPMENT_ROW.destination_address_id },
          }),
        ],
      ]),
    );
  });

  it('Timeline tab reads canonical shipment timeline for the active shipment', async () => {
    const user = userEvent.setup();
    TIMELINE_SPY.mockResolvedValue([{
      time: '2026-05-05T10:00:00Z',
      status: 'completed',
      action: 'Shipment created',
      detail: 'Backend timeline readback confirmed.',
    }]);

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);

    await waitFor(() => {
      expect(TIMELINE_SPY).toHaveBeenCalledWith(String(DEFAULT_SHIPMENT_ROW.id));
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(within(drawer).getByText('Shipment created')).toBeInTheDocument();
    expect(within(drawer).getByText('Backend timeline readback confirmed.')).toBeInTheDocument();
  });

  it('shows a backend error state when the shipment timeline read fails', async () => {
    const user = userEvent.setup();
    TIMELINE_SPY.mockRejectedValue(new Error('timeline backend unavailable'));

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);

    expect(await screen.findByText(/This section could not load/i)).toBeInTheDocument();
    expect(screen.queryByText(/timeline backend unavailable/i)).not.toBeInTheDocument();
  });

  it('disables risky drawer actions when shipment operation policy blocks them', async () => {
    const user = userEvent.setup();
    OPERATION_OPTIONS_SPY.mockResolvedValue({
      shipment_id: String(DEFAULT_SHIPMENT_ROW.id),
      status: 'planned',
      lock_source: 'shipment_operation_policy',
      operations: {
        modify: {
          operation: 'modify',
          allowed: false,
          reason: 'shipment_status_not_allowed',
          allowed_statuses: ['created'],
          lock_source: 'shipment_operation_policy',
          status: 'planned',
        },
        address: {
          operation: 'address',
          allowed: false,
          reason: 'shipment_status_not_allowed',
          allowed_statuses: ['created'],
          lock_source: 'shipment_operation_policy',
          status: 'planned',
        },
        reschedule: {
          operation: 'reschedule',
          allowed: false,
          reason: 'shipment_status_not_allowed',
          allowed_statuses: ['created'],
          lock_source: 'shipment_operation_policy',
          status: 'planned',
        },
        cancel: {
          operation: 'cancel',
          allowed: false,
          reason: 'shipment_status_not_allowed',
          allowed_statuses: ['created'],
          lock_source: 'shipment_operation_policy',
          status: 'planned',
        },
      },
    });

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);

    await waitFor(() => expect(OPERATION_OPTIONS_SPY).toHaveBeenCalledWith(String(DEFAULT_SHIPMENT_ROW.id)));
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(within(drawer).getByRole('button', { name: /Reschedule/i })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: /Preview cancel/i })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: /^Amend$/i })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: /Preview cancel/i })).toHaveAttribute(
      'title',
      expect.stringContaining('Shipment policy blocks cancel'),
    );
  });

  it('shows a backend error state when shipment boxes fail to load', async () => {
    const user = userEvent.setup();
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipment_boxes') throw new Error('boxes backend unavailable');
      return defaultShipmentDrawerList(resource, opts);
    });

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Boxes');

    expect(await screen.findByText(/This section could not load/i)).toBeInTheDocument();
    expect(screen.queryByText(/boxes backend unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText('No boxes recorded for this shipment.')).not.toBeInTheDocument();
  });

  it('shows a backend error state when shipment scans fail to load', async () => {
    const user = userEvent.setup();
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'scan_events') throw new Error('scans backend unavailable');
      return defaultShipmentDrawerList(resource, opts);
    });

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Scans');

    expect(await screen.findByText(/This section could not load/i)).toBeInTheDocument();
    expect(screen.queryByText(/scans backend unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText('No scans yet.')).not.toBeInTheDocument();
  });

  it('projects POD evidence from canonical delivery completion payloads', () => {
    const projection = podEvidenceProjectionFromRow({
      id: 'sact_pod_unit',
      timestamp: '2026-05-07T08:00:00Z',
      action_data: {
        delivery_completion: {
          route_stop_id: 'rs_evidence_001',
          handover_mode: 'named_recipient',
          recipient_name: 'Noura Al Saud',
          recipient_identity_kind: 'national_id',
          recipient_identity_last4: '9876',
          otp_confirmed: true,
          otp_last4: '4321',
          signature_artifact_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
          photo_artifact_id: '22222222-2222-4222-8222-222222222222',
          artifact_ids: ['4d1fbd36-6b6e-4c35-acc4-5e3ad9043830'],
          captured_at: '2026-05-07T08:00:00Z',
          geostamp: { latitude: 24.7136, longitude: 46.6753, accuracy_m: 8 },
          payment_collection: {
            outcome: 'collected',
            method: 'cash',
            expected_amount: 125,
            collected_amount: 120,
            variance_amount: 5,
            has_discrepancy: true,
            discrepancy_kind: 'shortfall',
            currency: 'SAR',
            receipt_context: 'cashier-count-77',
          },
        },
      },
    }, 'shipment_action');

    expect(projection).toMatchObject({
      source: 'shipment_action',
      handoverMode: 'named_recipient',
      recipientName: 'Noura Al Saud',
      identityKind: 'national_id',
      identityLast4: '9876',
      otpConfirmed: true,
      otpLast4: '4321',
      signatureArtifactId: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
      photoArtifactId: '22222222-2222-4222-8222-222222222222',
      artifactIds: [
        '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
        '22222222-2222-4222-8222-222222222222',
      ],
      routeStopId: 'rs_evidence_001',
      capturedAt: '2026-05-07T08:00:00Z',
      geostamp: { latitude: 24.7136, longitude: 46.6753, accuracy_m: 8 },
      paymentCollection: {
        outcome: 'collected',
        method: 'cash',
        expectedAmount: 125,
        collectedAmount: 120,
        varianceAmount: 5,
        discrepancyKind: 'shortfall',
        currency: 'SAR',
        receiptContext: 'cashier-count-77',
      },
    });
  });

  it('ignores notes-only route-stop task rows as POD evidence', () => {
    expect(isCompletedRouteStopEvidenceTask({
      task_type: 'route_stop_execute',
      status: 'completed',
    })).toBe(true);
    expect(isCompletedRouteStopEvidenceTask({
      task_type: 'route_stop_execute',
      status: 'open',
    })).toBe(false);
    expect(podEvidenceProjectionFromRow({
      id: 'tsk_notes_only',
      task_type: 'route_stop_execute',
      status: 'completed',
      notes: 'Driver called recipient',
      completed_at: '2026-05-07T08:00:00Z',
    }, 'task_closeout')).toBeNull();
    expect(podEvidenceProjectionFromRow({
      id: 'sact_route_stop_top_level',
      action_data: {
        route_stop_id: 'rs_top_level_001',
        delivery_completion: {
          handover_mode: 'safe_drop',
        },
      },
    }, 'shipment_action')).toMatchObject({
      routeStopId: 'rs_top_level_001',
    });
  });

  it('Evidence tab reads shipment_actions and tasks, then presents POD proof inside the shipment drawer', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_evidence_drawer_test';
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            tracking_number: 'SHP-EVIDENCE-001',
            status: 'delivered',
            service_type: 'standard',
            cod_amount: 125,
            cod_currency: 'SAR',
            box_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'shipment_actions') {
        expect(opts?.filter?.shipment_id).toBe(shipmentId);
        return {
          rows: [{
            id: 'sact_pod_001',
            shipment_id: shipmentId,
            timestamp: '2026-05-07T08:00:00Z',
            action_data: {
              delivery_completion: {
                completion_kind: 'full',
                handover_mode: 'named_recipient',
                recipient_name: 'Noura Al Saud',
                recipient_identity_kind: 'national_id',
                recipient_identity_last4: '9876',
                otp_confirmed: true,
                otp_last4: '4321',
                signature_artifact_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
                photo_artifact_id: '22222222-2222-4222-8222-222222222222',
                artifact_ids: [
                  '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
                  '22222222-2222-4222-8222-222222222222',
                ],
                captured_at: '2026-05-07T08:00:00Z',
                geostamp: { latitude: 24.7136, longitude: 46.6753, accuracy_m: 8 },
                payment_collection: {
                  outcome: 'collected',
                  method: 'cash',
                  expected_amount: 125,
                  collected_amount: 120,
                  variance_amount: 5,
                  has_discrepancy: true,
                  discrepancy_kind: 'shortfall',
                  currency: 'SAR',
                  receipt_context: 'cashier-count-77',
                },
              },
            },
          }],
          total: 1,
        };
      }
      if (resource === 'tasks') {
        expect(opts?.filter?.shipment_id).toBe(shipmentId);
        return {
          rows: [{
            id: 'tsk_route_stop_evidence',
            task_id: 'TSK-EVIDENCE',
            task_type: 'route_stop_execute',
            shipment_id: shipmentId,
            status: 'completed',
            delivery_completion: {
              handover_mode: 'named_recipient',
              signature_artifact_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
            },
          }],
          total: 1,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await openFirstShipmentDrawer(user);
      await clickRailTab(user, 'Evidence');
      const drawer = await waitFor(() => {
        const node = document.querySelector('.drawer') as HTMLElement | null;
        expect(node?.textContent).toMatch(/Proof of delivery/);
        return node as HTMLElement;
      });
      await waitFor(() => {
        const calls = LIST_SPY.mock.calls.map((c) => c[0]);
        expect(calls).toContain('shipment_actions');
        expect(calls).toContain('tasks');
      });
      expect(within(drawer).getAllByText(/Named recipient/i).length).toBeGreaterThan(0);
      expect(within(drawer).getAllByText(/Noura Al Saud/i).length).toBeGreaterThan(0);
      expect(within(drawer).getByText(/Confirmed ending 4321/i)).toBeTruthy();
      expect(within(drawer).getByText(/24\.7136, 46\.6753/i)).toBeTruthy();
      expect(within(drawer).getByText(/2 artifacts linked/i)).toBeTruthy();
      expect(within(drawer).getAllByText(/Collected/i).length).toBeGreaterThan(0);
      expect(within(drawer).getByText(/cashier-count-77/i)).toBeTruthy();
      expect(within(drawer).getByText(/Shortfall/i)).toBeTruthy();
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
    }
  });

  it('keeps action POD visible when task evidence reads are unavailable', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_evidence_partial_read_test';
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            tracking_number: 'SHP-EVIDENCE-PARTIAL-001',
            status: 'delivered',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'shipment_actions') {
        expect(opts?.filter?.shipment_id).toBe(shipmentId);
        return {
          rows: [{
            id: 'sact_pod_partial_001',
            shipment_id: shipmentId,
            timestamp: '2026-05-07T08:00:00Z',
            action_data: {
              route_stop_id: 'rs_partial_001',
              delivery_completion: {
                handover_mode: 'named_recipient',
                recipient_name: 'Noura Al Saud',
                signature_artifact_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
                captured_at: '2026-05-07T08:00:00Z',
              },
            },
          }],
          total: 1,
        };
      }
      if (resource === 'tasks') {
        throw new Error('task evidence read denied');
      }
      return defaultShipmentDrawerList(resource, opts);
    });
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await openFirstShipmentDrawer(user);
      await clickRailTab(user, 'Evidence');
      const drawer = await waitFor(() => {
        const node = document.querySelector('.drawer') as HTMLElement | null;
        expect(node?.textContent).toMatch(/Proof of delivery/);
        return node as HTMLElement;
      });
      expect(within(drawer).getByTestId('shipment-evidence-partial-read')).toHaveTextContent(/Some evidence streams/);
      expect(within(drawer).getAllByText(/Named recipient/i).length).toBeGreaterThan(0);
      expect(within(drawer).getAllByText(/Noura Al Saud/i).length).toBeGreaterThan(0);
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
    }
  });

  it('Boxes tab fires ui_list_resource_v1("shipment_boxes")', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Boxes');
    await waitFor(() => {
      const calls = LIST_SPY.mock.calls.map((c) => c[0]);
      expect(calls).toContain('shipment_boxes');
    });
  });

  it('Labels tab fires ui_list_resource_v1("labels")', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Labels');
    await waitFor(() => {
      const calls = LIST_SPY.mock.calls.map((c) => c[0]);
      expect(calls).toContain('labels');
      expect(calls).toContain('label_jobs');
      expect(calls).toContain('label_versions');
    });
  });

  it('Labels tab shows queued label generation before an active artifact exists', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_label_queue_drawer_test';
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            tracking_number: 'SHP-LABEL-QUEUE-001',
            status: 'pending',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'labels') {
        return { rows: [], total: 0 };
      }
      if (resource === 'label_jobs') {
        return {
          rows: [{
            id: 'ljob_label_queue_001',
            shipment_id: shipmentId,
            status: 'queued',
            purpose: 'shipment_label',
            target_type: 'shipment',
            target_id: shipmentId,
            queued_at: '2026-05-07T08:00:00Z',
            workflow_run_id: 'wfr_label_queue_001',
          }],
          total: 1,
        };
      }
      if (resource === 'label_versions') {
        return { rows: [], total: 0 };
      }
      return defaultShipmentDrawerList(resource, opts);
    });
    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await openFirstShipmentDrawer(user);
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /Labels 1/i })).toBeTruthy();
      });
      await clickRailTab(user, 'Labels');

      const drawer = await waitFor(() => {
        const node = document.querySelector('.drawer');
        expect(node).toBeTruthy();
        return node as HTMLElement;
      });
      expect(within(drawer).getByText('Generation and print queue')).toBeTruthy();
      expect(within(drawer).getByText('Latest job: Queued')).toBeTruthy();
      expect(within(drawer).getByText(/Download and reprint unlock/)).toBeTruthy();
      expect(within(drawer).getByRole('button', { name: 'Download' })).toBeDisabled();
      expect(within(drawer).getByRole('button', { name: 'Reprint' })).toBeDisabled();
      expect(within(drawer).getByRole('button', { name: 'Reprint label' })).toBeDisabled();
      await waitFor(() => {
        const calls = LIST_SPY.mock.calls.map((c) => c[0]);
        expect(calls).toContain('labels');
        expect(calls).toContain('label_jobs');
        expect(calls).toContain('label_versions');
      });
      const [jobRowActions] = within(drawer).getAllByRole('button', { name: 'Row actions' });
      await user.click(jobRowActions as HTMLElement);
      const printArtifactAction = await waitFor(() =>
        Array.from(document.querySelectorAll<HTMLElement>('.palette__item')).find(
          (node) => node.querySelector('.palette__item-label')?.textContent?.trim() === 'Open print artifact',
        ),
      );
      expect(printArtifactAction).toBeTruthy();
      expect(printArtifactAction?.classList.contains('is-disabled')).toBe(true);
      expect(printArtifactAction?.textContent).toContain('Completed label artifact required');
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
    }
  });

  it('Labels tab reconciles async worker completion in the same drawer without reload', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_label_worker_refresh_test';
    const labelId = 'lbl_label_worker_refresh_test';
    const pendingJobId = 'ljob_label_worker_refresh_bead';
    let jobCompleted = false;
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            tracking_number: 'SHP-LABEL-WORKER-001',
            status: 'pending',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'labels') {
        return {
          rows: [{
            id: labelId,
            shipment_id: shipmentId,
            barcode: 'SHP-LABEL-WORKER-001',
            active_version_id: jobCompleted ? 'lv_label_worker_v3' : 'lv_label_worker_v2',
            active_version_number: jobCompleted ? 3 : 2,
            file_url: jobCompleted ? 'labels/worker-v3.pdf' : 'labels/worker-v2.pdf',
            print_count: jobCompleted ? 3 : 2,
            last_printed_at: jobCompleted ? '2026-05-06T08:04:00Z' : '2026-05-06T08:00:00Z',
          }],
          total: 1,
        };
      }
      if (resource === 'label_jobs') {
        return {
          rows: [{
            id: pendingJobId,
            shipment_id: shipmentId,
            status: jobCompleted ? 'succeeded' : 'pending',
            purpose: 'reprint',
            target_type: 'shipment',
            target_id: shipmentId,
            queued_at: '2026-05-06T08:03:00Z',
            completed_at: jobCompleted ? '2026-05-06T08:04:00Z' : null,
            output_file_url: jobCompleted ? 'labels/worker-v3.pdf' : null,
            workflow_run_id: 'wfr_label_worker_refresh',
          }],
          total: 1,
        };
      }
      if (resource === 'label_versions') {
        return {
          rows: jobCompleted
            ? [
                {
                  id: 'lv_label_worker_v3',
                  label_id: labelId,
                  shipment_id: shipmentId,
                  label_job_id: pendingJobId,
                  version_number: 3,
                  version_status: 'active',
                  job_purpose: 'reprint',
                  reprint_reason: 'operator_request',
                  file_url: 'labels/worker-v3.pdf',
                  generated_at: '2026-05-06T08:04:00Z',
                  last_printed_at: '2026-05-06T08:04:00Z',
                  print_count: 3,
                },
                {
                  id: 'lv_label_worker_v2',
                  label_id: labelId,
                  shipment_id: shipmentId,
                  label_job_id: 'ljob_label_worker_previous',
                  version_number: 2,
                  version_status: 'superseded',
                  job_purpose: 'reprint',
                  file_url: 'labels/worker-v2.pdf',
                  generated_at: '2026-05-06T08:00:00Z',
                  last_printed_at: '2026-05-06T08:00:00Z',
                  print_count: 2,
                },
              ]
            : [{
                id: 'lv_label_worker_v2',
                label_id: labelId,
                shipment_id: shipmentId,
                label_job_id: 'ljob_label_worker_previous',
                version_number: 2,
                version_status: 'active',
                job_purpose: 'reprint',
                file_url: 'labels/worker-v2.pdf',
                generated_at: '2026-05-06T08:00:00Z',
                last_printed_at: '2026-05-06T08:00:00Z',
                print_count: 2,
              }],
          total: jobCompleted ? 2 : 1,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await openFirstShipmentDrawer(user);
      await clickRailTab(user, 'Labels');

      const drawer = await waitFor(() => {
        const node = document.querySelector('.drawer');
        expect(node).toBeTruthy();
        return node as HTMLElement;
      });
      expect(within(drawer).getByText('Active label v2')).toBeTruthy();
      expect(within(drawer).getByText('Latest job: Pending')).toBeTruthy();

      jobCompleted = true;

      await waitFor(() => {
        expect(within(drawer).getByText('Active label v3')).toBeTruthy();
        expect(within(drawer).getByText('Latest job: Succeeded')).toBeTruthy();
        expect(within(drawer).getByText('Label status refreshed')).toBeTruthy();
        expect(within(drawer).getAllByText('3').length).toBeGreaterThan(0);
        expect(within(drawer).getByText('Superseded')).toBeTruthy();
      }, { timeout: 7000 });
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
    }
  });

  it('Recipient tab edits the customer profile through recipient_update_v1', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_recipient_profile_edit_test';
    const recipientId = 'rcp_recipient_profile_edit_test';
    const updateSpy = vi
      .spyOn(ds, 'recipient_update_v1')
      .mockResolvedValue({
        ok: true,
        recipient_id: recipientId,
        idempotent_no_op: false,
        correlation_id: 'cor_recipient_profile_edit_test',
        settings_resolution_id: 'srlv_recipient_profile_edit_test',
      });
    const amendSpy = vi.spyOn(ds, 'shipment_amend_cancel_v1');
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            recipient_id: recipientId,
            tracking_number: 'SHP-RECIPIENT-EDIT-001',
            recipient_label: 'Drawer Recipient',
            status: 'pending',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
          })],
          total: 1,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });
    GET_SPY.mockImplementation(async (resource, id) => {
      const fixture = shipmentDetailFixture(resource, id);
      if (fixture) return fixture;
      if (resource === 'recipients' && id === recipientId) {
        return {
          id: recipientId,
          name: 'Drawer Recipient',
          phone_number: '+966500000777',
          email: 'drawer-recipient@example.test',
          external_id: 'DRAWER-RCP-777',
          preferred_language: 'en',
          preferred_comm_channel: 'whatsapp',
        };
      }
      return REAL_GET(resource, id);
    });

    try {
      const { queryClient } = renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      await openFirstShipmentDrawer(user);
      await clickRailTab(user, 'Recipient');

      const phoneRow = await waitFor(() => {
        const row = Array.from(document.querySelectorAll('.drawer .kvgrid__row'))
          .find((el) => el.textContent?.includes('Phone')) as HTMLElement | undefined;
        expect(row).toBeTruthy();
        return row as HTMLElement;
      });
      const phoneValue = phoneRow.querySelector('.kvgrid__val') as HTMLElement;
      await user.click(phoneValue);
      const input = phoneRow.querySelector('input.dt-inline-input') as HTMLInputElement;
      expect(input).toBeTruthy();
      await user.clear(input);
      await user.type(input, '+966500000778{Enter}');

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            recipient_id: recipientId,
            phone_number: '+966500000778',
            communication_preferences: expect.objectContaining({
              source: 'console_v2.shipments_drawer.recipient_tab',
              shipment_id: shipmentId,
            }),
          }),
        );
      });
      expect(amendSpy).not.toHaveBeenCalled();
      const invalidations = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg));
      expect(invalidations.some((call) => call.includes('resources_by_ids') && call.includes('recipients'))).toBe(true);
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
      GET_SPY.mockImplementation(REAL_GET);
      updateSpy.mockRestore();
      amendSpy.mockRestore();
    }
  });

  it('Labels tab reprint queues the canonical label RPC and refreshes related projections', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_label_drawer_test';
    const labelId = 'lbl_label_drawer_test';
    let reprintQueued = false;
    const getLookupsSpy = vi.spyOn(ds, 'getLookups').mockImplementation((category) => {
      if (category === 'label_reprint_reason') {
        return [
          { value: 'operator_request', label: 'Operator request', is_default: true, rank: 10 },
        ];
      }
      return REAL_GET_LOOKUPS(category);
    });
    const reprintSpy = vi
      .spyOn(ds, 'request_label_reprint')
      .mockImplementation(async () => {
        reprintQueued = true;
        return {
        ok: true,
        label_id: labelId,
        reason: 'operator_request',
        label_job_id: 'ljob_label_drawer_reprint',
        new_version_id: null,
        };
      });
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            tracking_number: 'SHP-LABEL-001',
            status: 'pending',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'labels') {
        return {
          rows: [{
            id: labelId,
            shipment_id: shipmentId,
            barcode: 'SHP-LABEL-001',
            active_version_id: 'lv_label_drawer_active',
            active_version_number: 2,
            print_count: 1,
            last_printed_at: '2026-05-06T08:00:00Z',
          }],
          total: 1,
        };
      }
      if (resource === 'label_jobs') {
        return {
          rows: reprintQueued
            ? [{
              id: 'ljob_label_drawer_reprint',
              shipment_id: shipmentId,
              label_id: labelId,
              status: 'pending',
              job_purpose: 'reprint',
              purpose: 'reprint',
              queued_at: '2026-05-06T08:01:00Z',
              reprint_reason: 'operator_request',
              source_label_version_id: 'lv_label_drawer_active',
            }]
            : [],
          total: reprintQueued ? 1 : 0,
        };
      }
      if (resource === 'label_versions') {
        return { rows: [], total: 0 };
      }
      return defaultShipmentDrawerList(resource, opts);
    });

    try {
      const { queryClient } = renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      await openFirstShipmentDrawer(user);
      await clickRailTab(user, 'Labels');

      const drawer = document.querySelector('.drawer') as HTMLElement;
      await waitFor(() => {
        expect(within(drawer).getAllByText('SHP-LABEL-001').length).toBeGreaterThan(0);
      });
      const [rowActions] = within(drawer).getAllByRole('button', { name: 'Row actions' });
      fireEvent.click(rowActions as HTMLElement);
      const reprintAction = await waitFor(() =>
        Array.from(document.querySelectorAll<HTMLElement>('.palette__item')).find(
          (node) =>
            node.querySelector('.palette__item-label')?.textContent?.trim() === 'Reprint label' &&
            !node.classList.contains('is-disabled'),
        ),
      );
      expect(reprintAction).toBeTruthy();
      await user.click(reprintAction as HTMLElement);

      await waitFor(() => {
        expect(reprintSpy).toHaveBeenCalledWith(labelId, { reason: 'operator_request' });
        const calls = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg));
        expect(calls.some((call) => call.includes('"labels"'))).toBe(true);
        expect(calls.some((call) => call.includes('"label_jobs"'))).toBe(true);
        expect(calls.some((call) => call.includes('"label_versions"'))).toBe(true);
        expect(calls.some((call) => call.includes('"shipment_directory"'))).toBe(true);
      });
      await waitFor(() => {
        expect(within(drawer).getByRole('status')).toHaveTextContent(
          'Reprint queued; label status refreshed',
        );
        expect(within(drawer).getByText('Latest job: Pending')).toBeInTheDocument();
        expect(within(drawer).getAllByText('Reprint').length).toBeGreaterThan(1);
      });
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
      getLookupsSpy.mockRestore();
      reprintSpy.mockRestore();
    }
  });

  it('Labels tab keeps reprint single-flight while backend readback is pending', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_label_single_flight_test';
    const labelId = 'lbl_label_single_flight_test';
    let reprintQueued = false;
    type ReprintResult = {
      ok: true;
      label_id: string;
      reason: string;
      label_job_id: string;
      new_version_id: null;
    };
    let resolveReprint: (value: ReprintResult) => void = () => undefined;
    const getLookupsSpy = vi.spyOn(ds, 'getLookups').mockImplementation((category) => {
      if (category === 'label_reprint_reason') {
        return [
          { value: 'operator_request', label: 'Operator request', is_default: true, rank: 10 },
        ];
      }
      return REAL_GET_LOOKUPS(category);
    });
    const reprintSpy = vi
      .spyOn(ds, 'request_label_reprint')
      .mockImplementation(() => new Promise<ReprintResult>((resolve) => {
        resolveReprint = resolve;
      }));
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            tracking_number: 'SHP-LABEL-SINGLE-FLIGHT-001',
            status: 'pending',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'labels') {
        return {
          rows: [{
            id: labelId,
            shipment_id: shipmentId,
            barcode: 'SHP-LABEL-SINGLE-FLIGHT-001',
            active_version_id: 'lv_label_single_flight_active',
            active_version_number: 1,
            print_count: 1,
            last_printed_at: '2026-05-06T08:00:00Z',
          }],
          total: 1,
        };
      }
      if (resource === 'label_jobs') {
        return {
          rows: reprintQueued
            ? [{
              id: 'ljob_label_single_flight_reprint',
              shipment_id: shipmentId,
              label_id: labelId,
              status: 'pending',
              job_purpose: 'reprint',
              purpose: 'reprint',
              queued_at: '2026-05-06T08:01:00Z',
              reprint_reason: 'operator_request',
              source_label_version_id: 'lv_label_single_flight_active',
            }]
            : [],
          total: reprintQueued ? 1 : 0,
        };
      }
      if (resource === 'label_versions') return { rows: [], total: 0 };
      return defaultShipmentDrawerList(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await openFirstShipmentDrawer(user);
      await clickRailTab(user, 'Labels');
      const drawer = document.querySelector('.drawer') as HTMLElement;
      await waitFor(() => {
        expect(within(drawer).getByRole('button', { name: 'Reprint' })).not.toBeDisabled();
      });

      const reprintButton = within(drawer).getByRole('button', { name: 'Reprint' });
      await user.click(reprintButton);
      await waitFor(() => {
        expect(reprintSpy).toHaveBeenCalledTimes(1);
        expect(reprintButton).toBeDisabled();
      });
      await user.click(reprintButton);
      expect(reprintSpy).toHaveBeenCalledTimes(1);

      reprintQueued = true;
      resolveReprint({
        ok: true,
        label_id: labelId,
        reason: 'operator_request',
        label_job_id: 'ljob_label_single_flight_reprint',
        new_version_id: null,
      });
      await waitFor(() => {
        expect(within(drawer).getByRole('status')).toHaveTextContent(
          'Reprint queued; label status refreshed',
        );
        expect(within(drawer).getByText('Latest job: Pending')).toBeInTheDocument();
      });
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
      getLookupsSpy.mockRestore();
      reprintSpy.mockRestore();
    }
  });

  it('drawer footer reprint opens label readback only after an active backend label exists', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_label_footer_reprint_test';
    const labelId = 'lbl_label_footer_reprint_test';
    let reprintQueued = false;
    const getLookupsSpy = vi.spyOn(ds, 'getLookups').mockImplementation((category) => {
      if (category === 'label_reprint_reason') {
        return [
          { value: 'operator_request', label: 'Operator request', is_default: true, rank: 10 },
        ];
      }
      return REAL_GET_LOOKUPS(category);
    });
    const reprintSpy = vi
      .spyOn(ds, 'request_label_reprint')
      .mockImplementation(async () => {
        reprintQueued = true;
        return {
        ok: true,
        label_id: labelId,
        reason: 'operator_request',
        label_job_id: 'ljob_label_footer_reprint',
        new_version_id: null,
        };
      });
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            tracking_number: 'SHP-LABEL-FOOTER-001',
            status: 'pending',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'labels') {
        return {
          rows: [{
            id: labelId,
            shipment_id: shipmentId,
            barcode: 'SHP-LABEL-FOOTER-001',
            active_version_id: 'lv_label_footer_active',
            active_version_number: 1,
            print_count: 1,
            last_printed_at: '2026-05-06T08:00:00Z',
          }],
          total: 1,
        };
      }
      if (resource === 'label_jobs') {
        return {
          rows: reprintQueued
            ? [{
              id: 'ljob_label_footer_reprint',
              shipment_id: shipmentId,
              label_id: labelId,
              status: 'pending',
              job_purpose: 'reprint',
              purpose: 'reprint',
              queued_at: '2026-05-06T08:01:00Z',
              reprint_reason: 'operator_request',
              source_label_version_id: 'lv_label_footer_active',
            }]
            : [],
          total: reprintQueued ? 1 : 0,
        };
      }
      if (resource === 'label_versions') return { rows: [], total: 0 };
      return defaultShipmentDrawerList(resource, opts);
    });

    try {
      const { queryClient } = renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      await openFirstShipmentDrawer(user);
      const drawer = await waitFor(() => {
        const node = document.querySelector('.drawer');
        expect(node).toBeTruthy();
        return node as HTMLElement;
      });

      const footerReprint = within(drawer).getByRole('button', { name: 'Reprint label' });
      await waitFor(() => {
        expect(footerReprint).not.toBeDisabled();
      });
      await user.click(footerReprint);

      await waitFor(() => {
        expect(reprintSpy).toHaveBeenCalledWith(labelId, { reason: 'operator_request' });
        expect(within(drawer).getByRole('tab', { name: /Labels/i })).toHaveAttribute('aria-selected', 'true');
        expect(within(drawer).getByText('Latest job: Pending')).toBeInTheDocument();
        expect(within(drawer).getAllByText('Reprint').length).toBeGreaterThan(1);
        const calls = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg));
        expect(calls.some((call) => call.includes('"labels"'))).toBe(true);
        expect(calls.some((call) => call.includes('"label_jobs"'))).toBe(true);
        expect(calls.some((call) => call.includes('"label_versions"'))).toBe(true);
        expect(calls.some((call) => call.includes('"shipment_directory"'))).toBe(true);
      });
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
      getLookupsSpy.mockRestore();
      reprintSpy.mockRestore();
    }
  });

  it('Bulk reprint labels resolves active labels per selected shipment before queueing reprint', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_label_bulk_reprint_test';
    const labelId = 'lbl_label_bulk_reprint_test';
    const getLookupsSpy = vi.spyOn(ds, 'getLookups').mockImplementation((category) => {
      if (category === 'label_reprint_reason') {
        return [
          { value: 'operator_request', label: 'Operator request', is_default: true, rank: 10 },
        ];
      }
      return REAL_GET_LOOKUPS(category);
    });
    const reprintSpy = vi
      .spyOn(ds, 'request_label_reprint')
      .mockResolvedValue({
        ok: true,
        label_id: labelId,
        reason: 'operator_request',
        label_job_id: 'ljob_label_bulk_reprint',
        new_version_id: null,
      });
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            tracking_number: 'SHP-LABEL-BULK-001',
            status: 'pending',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
            label_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'labels') {
        expect(opts?.filter?.shipment_id).toBe(shipmentId);
        return {
          rows: [{
            id: labelId,
            shipment_id: shipmentId,
            barcode: 'SHP-LABEL-BULK-001',
            active_version_id: 'lv_label_bulk_active',
            active_version_number: 1,
            file_url: 'https://files.example.test/labels/lbl_label_bulk_reprint_test.pdf',
            print_count: 1,
            last_printed_at: '2026-05-06T08:00:00Z',
          }],
          total: 1,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });
    COMPLETE_LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'labels') {
        expect(opts?.filter?.shipment_id).toBe(shipmentId);
        return {
          rows: [{
            id: labelId,
            shipment_id: shipmentId,
            barcode: 'SHP-LABEL-BULK-001',
            active_version_id: 'lv_label_bulk_active',
            active_version_number: 1,
            file_url: 'https://files.example.test/labels/lbl_label_bulk_reprint_test.pdf',
            print_count: 1,
            last_printed_at: '2026-05-06T08:00:00Z',
          }],
          total: 1,
        };
      }
      return REAL_COMPLETE_LIST(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
      });
      const rowCheckbox = screen
        .getAllByRole('checkbox')
        .find((cb) => cb.getAttribute('aria-label') === 'Select row');
      expect(rowCheckbox).toBeTruthy();
      await user.click(rowCheckbox as HTMLElement);

      const bulkReprint = screen.getByRole('button', { name: /Bulk reprint labels/i });
      await waitFor(() => {
        expect(bulkReprint).not.toBeDisabled();
      });
      await user.click(bulkReprint);

      await waitFor(() => {
        expect(reprintSpy).toHaveBeenCalledWith(labelId, { reason: 'operator_request' });
      });
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
      COMPLETE_LIST_SPY.mockImplementation(REAL_COMPLETE_LIST);
      getLookupsSpy.mockRestore();
      reprintSpy.mockRestore();
    }
  });

  it('Bulk reprint labels stays disabled when selected shipments have no backend label projection', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_label_bulk_no_label_test';
    const reprintSpy = vi.spyOn(ds, 'request_label_reprint');
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            tracking_number: 'SHP-LABEL-BULK-NO-LABEL-001',
            status: 'pending',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
            label_count: 0,
          })],
          total: 1,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
      });
      const rowCheckbox = screen
        .getAllByRole('checkbox')
        .find((cb) => cb.getAttribute('aria-label') === 'Select row');
      expect(rowCheckbox).toBeTruthy();
      await user.click(rowCheckbox as HTMLElement);

      const bulkReprint = screen.getByRole('button', { name: /Bulk reprint labels/i });
      await waitFor(() => {
        expect(bulkReprint).toBeDisabled();
        expect(bulkReprint).toHaveAttribute('title', 'Select at least one shipment with an active label');
      });
      expect(reprintSpy).not.toHaveBeenCalled();
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
      reprintSpy.mockRestore();
    }
  });

  it('Labels tab and bulk label actions expose denied states without executing label commands', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_label_permission_denied_test';
    const labelId = 'lbl_label_permission_denied_test';
    const reprintSpy = vi.spyOn(ds, 'request_label_reprint');
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            tracking_number: 'SHP-LABEL-DENIED-001',
            status: 'pending',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
            label_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'labels') {
        expect(opts?.filter?.shipment_id).toBe(shipmentId);
        return {
          rows: [{
            id: labelId,
            shipment_id: shipmentId,
            barcode: 'SHP-LABEL-DENIED-001',
            active_version_id: 'lv_label_denied_active',
            active_version_number: 1,
            file_url: 'https://files.example.test/labels/lbl_label_permission_denied_test.pdf',
            print_count: 1,
            last_printed_at: '2026-05-06T08:00:00Z',
          }],
          total: 1,
        };
      }
      if (resource === 'label_jobs' || resource === 'label_versions') {
        return { rows: [], total: 0 };
      }
      return defaultShipmentDrawerList(resource, opts);
    });
    COMPLETE_LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'labels') {
        expect(opts?.filter?.shipment_id).toBe(shipmentId);
        return {
          rows: [{
            id: labelId,
            shipment_id: shipmentId,
            barcode: 'SHP-LABEL-DENIED-001',
            active_version_id: 'lv_label_denied_active',
            active_version_number: 1,
            file_url: 'https://files.example.test/labels/lbl_label_permission_denied_test.pdf',
          }],
          total: 1,
        };
      }
      return REAL_COMPLETE_LIST(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['shipments.read', 'labels.read'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
      });
      const rowCheckbox = screen
        .getAllByRole('checkbox')
        .find((cb) => cb.getAttribute('aria-label') === 'Select row');
      expect(rowCheckbox).toBeTruthy();
      await user.click(rowCheckbox as HTMLElement);
      const bulkReprint = screen.getByRole('button', { name: /Bulk reprint labels/i });
      await waitFor(() => {
        expect(bulkReprint).toBeDisabled();
        expect(bulkReprint).toHaveAttribute('title', 'Requires labels reprint permission');
      });

      await openFirstShipmentDrawer(user);
      await clickRailTab(user, 'Labels');
      const drawer = await waitFor(() => {
        const node = document.querySelector('.drawer');
        expect(node).toBeTruthy();
        return node as HTMLElement;
      });
      const [labelRowActions] = within(drawer).getAllByRole('button', { name: 'Row actions' });
      await user.click(labelRowActions as HTMLElement);
      const downloadAction = await screen.findByRole('option', { name: /^Download label/ });
      const reprintAction = await screen.findByRole('option', { name: /^Reprint label/ });
      expect(downloadAction).toHaveClass('is-disabled');
      expect(downloadAction).toHaveTextContent('Requires labels download permission');
      expect(reprintAction).toHaveClass('is-disabled');
      expect(reprintAction).toHaveTextContent('Requires labels reprint permission');
      await user.click(downloadAction).catch(() => undefined);
      await user.click(reprintAction).catch(() => undefined);
      expect(openSpy).not.toHaveBeenCalled();
      expect(reprintSpy).not.toHaveBeenCalled();
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
      COMPLETE_LIST_SPY.mockImplementation(REAL_COMPLETE_LIST);
      reprintSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it('Labels tab prints through the canonical command and downloads the active artifact', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_label_print_drawer_test';
    const organizationId = 'org_label_print_drawer_test';
    const labelId = 'lbl_label_print_drawer_test';
    const artifactUrl = 'https://files.example.test/labels/lbl_label_print_drawer_test.pdf';
    let printCommandCompleted = false;
    let labelProjectionReadsAfterPrint = 0;
    const labelProjectionReady = () => printCommandCompleted && labelProjectionReadsAfterPrint > 1;
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    RESOLVE_DOWNLOAD_SPY.mockResolvedValue({
      url: artifactUrl,
      expires_at: '2026-05-06T08:15:00Z',
      file_name: 'SHP-LABEL-PRINT-001.pdf',
      mime_type: 'application/pdf',
    });
    RUN_COMMAND_SPY.mockImplementation(async () => {
      printCommandCompleted = true;
      return {
      ok: true,
      command: 'shipments.print_labels',
      params: {},
      dry_run: false,
      settings_resolution_id: 'srlv_label_print_drawer_test',
      workflow_run_id: 'wfr_label_print_drawer_test',
      };
    });
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            organization_id: organizationId,
            tracking_number: 'SHP-LABEL-PRINT-001',
            status: 'pending',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'labels') {
        if (printCommandCompleted) labelProjectionReadsAfterPrint += 1;
        if (!labelProjectionReady()) return { rows: [], total: 0 };
        return {
          rows: [{
            id: labelId,
            shipment_id: shipmentId,
            barcode: 'SHP-LABEL-PRINT-001',
            active_version_id: 'lv_label_print_drawer_active',
            active_version_number: 1,
            file_url: artifactUrl,
            print_count: 1,
            last_printed_at: '2026-05-06T08:00:00Z',
          }],
          total: 1,
        };
      }
      if (resource === 'label_jobs') {
        return {
          rows: labelProjectionReady()
            ? [{
                id: 'ljob_label_print_001',
                shipment_id: shipmentId,
                job_status: 'completed',
                purpose: 'shipment_label',
                target_type: 'shipment',
                workflow_run_id: 'wfr_label_print_drawer_test',
                completed_at: '2026-05-06T08:00:00Z',
              }]
            : [],
          total: labelProjectionReady() ? 1 : 0,
        };
      }
      if (resource === 'label_versions') {
        if (!labelProjectionReady()) return { rows: [], total: 0 };
        return {
          rows: [{
            id: 'lv_label_print_drawer_active',
            label_id: labelId,
            shipment_id: shipmentId,
            label_job_id: 'ljob_label_print_001',
            version_number: 1,
            version_status: 'active',
            job_purpose: 'primary',
            file_url: artifactUrl,
            generated_at: '2026-05-06T08:00:00Z',
            last_printed_at: '2026-05-06T08:00:00Z',
            print_count: 1,
          }],
          total: 1,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });

    try {
      const { queryClient } = renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      await openFirstShipmentDrawer(user);
      await clickRailTab(user, 'Labels');

      const drawer = await waitFor(() => {
        const node = document.querySelector('.drawer');
        expect(node).toBeTruthy();
        return node as HTMLElement;
      });
      expect(within(drawer).getByText('No active label')).toBeTruthy();
      expect(within(drawer).getByRole('button', { name: 'Download' })).toBeDisabled();
      await user.click(within(drawer).getByRole('button', { name: 'Print label' }));
      await waitFor(() => {
        expect(within(drawer).getByText('Artifact ready')).toBeTruthy();
        expect(within(drawer).getByRole('button', { name: 'Download' })).not.toBeDisabled();
      });
      fireEvent.click(within(drawer).getByRole('button', { name: 'Download' }));
      expect(within(drawer).getByText('Version history and artifacts')).toBeTruthy();
      expect(within(drawer).getByText('Active')).toBeTruthy();

      await waitFor(() => {
        expect(RUN_COMMAND_SPY).toHaveBeenCalledWith(
          'shipments.print_labels',
          expect.objectContaining({
            resource_key: 'shipments',
            selected_ids: [shipmentId],
            selected_id: shipmentId,
            selection_count: 1,
            shipment_id: shipmentId,
            job_purpose: 'primary',
            organization_id: organizationId,
            source: 'console_v2.shipment_drawer.labels_tab',
          }),
          { dryRun: false },
        );
        const calls = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg));
        expect(calls.some((call) => call.includes('"labels"'))).toBe(true);
        expect(calls.some((call) => call.includes('"label_jobs"'))).toBe(true);
        expect(calls.some((call) => call.includes('"label_versions"'))).toBe(true);
        expect(RESOLVE_DOWNLOAD_SPY).toHaveBeenCalledWith({
          resource: 'labels',
          id: labelId,
          expires_seconds: 900,
        });
        expect(openSpy).toHaveBeenCalledWith(artifactUrl, '_blank', 'noopener,noreferrer');
        expect(writeText).toHaveBeenCalledWith(artifactUrl);
      });
      await waitFor(() => {
        expect(within(drawer).getByRole('button', { name: 'Download' })).not.toBeDisabled();
        expect(within(drawer).getByText('Signed label download URL copied; browser blocked the new tab')).toBeTruthy();
      });
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
      RUN_COMMAND_SPY.mockImplementation(REAL_RUN_COMMAND);
      RESOLVE_DOWNLOAD_SPY.mockImplementation(REAL_RESOLVE_DOWNLOAD);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
      openSpy.mockRestore();
    }
  });

  it('Labels tab surfaces a failed print workflow from backend readback in place', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_label_print_failed_readback_test';
    const organizationId = 'org_label_print_failed_readback_test';
    const workflowRunId = 'wfr_label_print_failed_readback_test';
    const failureReason = 'new row for relation "shipment_boxes" violates check constraint "shipment_boxes_barcode_format"';
    let printCommandCompleted = false;
    RUN_COMMAND_SPY.mockImplementation(async () => {
      printCommandCompleted = true;
      return {
        ok: true,
        command: 'shipments.print_labels',
        params: {},
        dry_run: false,
        settings_resolution_id: 'srlv_label_print_failed_readback_test',
        workflow_run_id: workflowRunId,
      };
    });
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            organization_id: organizationId,
            tracking_number: 'FT-LIVE-FAILED-LABEL-001',
            status: 'pending',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            box_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'labels' || resource === 'label_jobs' || resource === 'label_versions') {
        return { rows: [], total: 0 };
      }
      return defaultShipmentDrawerList(resource, opts);
    });
    GET_SPY.mockImplementation(async (resource, id) => {
      if (resource === 'workflow_runs' && id === workflowRunId) {
        return {
          id: workflowRunId,
          workflow_status: printCommandCompleted ? 'failed' : 'pending',
          failure_reason: failureReason,
          last_error: { error: failureReason },
        };
      }
      const fixture = shipmentDetailFixture(resource, id);
      if (fixture) return fixture;
      const defaultFixture = defaultShipmentDrawerGet(resource, id);
      if (defaultFixture) return defaultFixture;
      return REAL_GET(resource, id);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await openFirstShipmentDrawer(user);
      await clickRailTab(user, 'Labels');

      const drawer = await waitFor(() => {
        const node = document.querySelector('.drawer');
        expect(node).toBeTruthy();
        return node as HTMLElement;
      });
      await user.click(within(drawer).getByRole('button', { name: 'Print label' }));
      await waitFor(() => {
        expect(within(drawer).getByText(/Label print could not be completed\. Check the label queue before retrying\./i)).toBeTruthy();
      });
      expect(within(drawer).queryByText(new RegExp(failureReason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeNull();
      expect(getToasts().some(
          (toast) => toast.tone === 'danger'
          && toast.message.includes('Label print could not be completed. Check the label queue before retrying.'),
      )).toBe(true);
      expect(getToasts().some((toast) => toast.message.includes(failureReason))).toBe(false);
      expect(GET_SPY).toHaveBeenCalledWith('workflow_runs', workflowRunId);
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
      GET_SPY.mockImplementation(REAL_GET);
      RUN_COMMAND_SPY.mockImplementation(REAL_RUN_COMMAND);
    }
  });

  it('Scans tab fires ui_list_resource_v1("scan_events")', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Scans');
    await waitFor(() => {
      const calls = LIST_SPY.mock.calls.map((c) => c[0]);
      expect(calls).toContain('scan_events');
    });
    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).not.toMatch(/return_to_branch_intake|warehouse_checkpoint|scan_type/i);
  });

  it('Comms tab fires ui_list_resource_v1("comms_attempts")', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Comms');
    await waitFor(() => {
      const calls = LIST_SPY.mock.calls.map((c) => c[0]);
      expect(calls).toContain('comms_attempts');
    });
  });

  it('COD tab reads canonical payment collection from shipment_actions', async () => {
    const user = userEvent.setup();
    const shipmentId = 'shp_cod_drawer_test';
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'shipments' || resource === 'shipment_directory') {
        return {
          rows: [shipmentFixture({
            id: shipmentId,
            tracking_number: 'SHP-COD-001',
            status: 'out_for_delivery',
            service_type: 'standard',
            cod_amount: 225,
            cod_currency: 'SAR',
            box_count: 1,
          })],
          total: 1,
        };
      }
      if (resource === 'shipment_actions') {
        return {
          rows: [{
            id: 'sact_cod_001',
            shipment_id: shipmentId,
            timestamp: '2026-05-05T10:00:00Z',
            payment_collection_method: 'cash',
            payment_collection_outcome: 'collected',
            payment_expected_amount: 225,
            payment_collected_amount: 220,
            payment_variance_amount: -5,
            payment_currency: 'SAR',
          }],
          total: 1,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });

    try {
      renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
      await openFirstShipmentDrawer(user);
      await clickRailTab(user, 'COD');
      await waitFor(() => {
        const calls = LIST_SPY.mock.calls.map((c) => c[0]);
        expect(calls).toContain('shipment_actions');
      });
      const actionCall = LIST_SPY.mock.calls.find(
        (c) => (c as unknown[])[0] === 'shipment_actions',
      );
      const opts = (actionCall as unknown[])[1] as { filter?: { shipment_id?: string } } | undefined;
      expect(opts?.filter?.shipment_id).toBe(shipmentId);
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toMatch(/Cash/);
      expect(drawerText).toMatch(/Collected/);
      expect(drawerText).toMatch(/220/);
      expect(drawerText).toMatch(/-SAR\s*5/);
    } finally {
      LIST_SPY.mockImplementation(REAL_LIST);
    }
  });

  it('Baskets tab composes shipment basket items, baskets, and state history', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Baskets');
    await waitFor(() => {
      const calls = LIST_SPY.mock.calls.map((c) => c[0]);
      const completeCalls = COMPLETE_LIST_SPY.mock.calls.map((c) => c[0]);
      expect(calls).toContain('basket_items');
      expect(completeCalls).toContain('basket_transitions');
      expect(GET_SPY.mock.calls.some(([key]) => key === 'baskets')).toBe(true);
    });
    const basketItemsCall = LIST_SPY.mock.calls.find(
      (c) => (c as unknown[])[0] === 'basket_items',
    );
    const opts = (basketItemsCall as unknown[])[1] as { filter?: { shipment_id?: string } } | undefined;
    expect(opts?.filter?.shipment_id).toBeTruthy();
    const basketTransitionsCall = COMPLETE_LIST_SPY.mock.calls.find(
      (c) => (c as unknown[])[0] === 'basket_transitions',
    );
    const transitionOpts = (basketTransitionsCall as unknown[])[1] as
      | { filter?: { basket_id?: string } }
      | undefined;
    expect(transitionOpts?.filter?.basket_id).toBeTruthy();
    expect(
      LIST_SPY.mock.calls.some(
        ([key, callOpts]) => key === 'baskets' && !(callOpts as { filter?: unknown } | undefined)?.filter,
      ),
    ).toBe(false);
    await waitFor(() => {
      const drawer = document.querySelector('.drawer') as HTMLElement | null;
      expect(drawer?.textContent).not.toMatch(/\bbsk_|cor_|usr_/i);
    });
    const drawer = document.querySelector('.drawer') as HTMLElement | null;
    const leakedTitle = Array.from(drawer?.querySelectorAll('[title]') ?? []).some((el) =>
      /\bbsk_|cor_|usr_/.test(el.getAttribute('title') ?? ''),
    );
    expect(leakedTitle).toBe(false);
  });

  it('Baskets tab resolves the basket zone name from zones when basket rows only carry zone_id', async () => {
    const shipmentId = 'shp_basket_zone_lookup';
    shipmentFixture({
      id: shipmentId,
      tracking_number: 'SHP-BASKET-ZONE',
      status: 'created',
      service_type: 'delivery',
      cod_amount: 0,
      destination_city: 'Riyadh',
    });
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'basket_items') {
        return {
          rows: [{
            id: 'bit_zone_lookup',
            shipment_id: shipmentId,
            basket_id: 'bsk_zone_lookup',
            added_at: '2026-05-09T08:00:00Z',
          }],
          total: 1,
          page: 0,
          page_size: 500,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });
    COMPLETE_LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'basket_transitions') {
        return { rows: [], total: 0, page: 0, page_size: 500 };
      }
      return REAL_COMPLETE_LIST(resource, opts);
    });
    GET_SPY.mockImplementation(async (resource, id) => {
      const fixture = shipmentDetailFixture(resource, id);
      if (fixture) return fixture;
      if (resource === 'baskets' && id === 'bsk_zone_lookup') {
        return {
          id,
          basket_type: 'delivery',
          state: 'active',
          zone_id: 'zone_lookup_riyadh',
          current_count: 4,
          capacity_count: 12,
        };
      }
      if (resource === 'zones' && id === 'zone_lookup_riyadh') {
        return {
          id,
          name: 'North Riyadh Zone',
        };
      }
      return REAL_GET(resource, id);
    });

    renderWithProviders(<ShipmentContextPanel shipmentId={shipmentId} initialTab="baskets" />, {
      capabilities: ['all'],
    });

    expect((await screen.findAllByText(/North Riyadh Zone/i)).length).toBeGreaterThan(0);
    expect(GET_SPY.mock.calls.some(([resource, id]) => resource === 'zones' && id === 'zone_lookup_riyadh')).toBe(true);
  });

  it('Baskets tab row inspects the owning basket relationship inside the shipment drawer', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Baskets');
    await waitFor(() => {
      const drawer = document.querySelector('.drawer') as HTMLElement | null;
      expect(drawer?.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const drawer = document.querySelector('.drawer') as HTMLElement;
    const basketRow = Array.from(drawer.querySelectorAll('.dt__table tbody tr')).find((row) =>
      (row.textContent ?? '').toLowerCase().includes('basket'),
    );
    expect(basketRow).toBeTruthy();
    await user.click(basketRow as HTMLElement);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/operate/shipments');
      expect(screen.getByText('Basket relationship detail')).toBeInTheDocument();
      expect(screen.getByText('Basket activity for this shipment')).toBeInTheDocument();
    });
    expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/Active assignment|Removed from basket/);
  });

  it('Baskets tab row action names the shipment-basket relationship inspection', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Baskets');
    await waitFor(() => {
      const drawer = document.querySelector('.drawer') as HTMLElement | null;
      expect(drawer?.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    const [rowActions] = within(drawer).getAllByRole('button', { name: 'Row actions' });
    await user.click(rowActions as HTMLElement);
    await waitFor(() => {
      const actionLabels = Array.from(document.querySelectorAll('.palette__item-label')).map((node) =>
        node.textContent?.trim(),
      );
      expect(actionLabels).toContain('Inspect basket relationship');
    });
  });

  it('Baskets tab renders permission failures as a denied state', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);

    LIST_SPY.mockImplementationOnce(async () => {
      throw new Error('42501 permission denied');
    });
    await clickRailTab(user, 'Baskets');

    expect(await screen.findByText('Basket assignments unavailable')).toBeInTheDocument();
    expect(screen.getByText(/basket relationship reads require basket and zone access permission/i)).toBeInTheDocument();
  });

  it('Decisions tab reads this shipment and linked geocoding review decision rows', async () => {
    const user = userEvent.setup();
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'manual_review_tasks') {
        expect(opts?.filter).toEqual({ address_id: DEFAULT_SHIPMENT_ROW.destination_address_id });
        return {
          rows: [{
            id: 'mrt_drawer_decision',
            shipment_id: DEFAULT_SHIPMENT_ROW.id,
            address_id: DEFAULT_SHIPMENT_ROW.destination_address_id,
            task_type: 'geocoding',
            reason: 'confidence_below_threshold',
            status: 'resolved',
            resolution_outcome: 'approved',
            updated_at: '2026-05-14T13:28:08.000Z',
          }],
          total: 1,
          page: opts?.page ?? 0,
          page_size: opts?.page_size ?? 10,
        };
      }
      if (resource === 'decision_log') {
        const resourceType = String(opts?.filter?.resource_type ?? '');
        const resourceId = String(opts?.filter?.resource_id ?? DEFAULT_SHIPMENT_ROW.id);
        if (resourceType === 'manual_review_task') {
          return {
            rows: [{
              id: 'dlg_geocode_review_approved',
              resource_type: 'manual_review_task',
              resource_id: resourceId,
              timestamp: '2026-05-14T13:28:08.000Z',
              decision_category: 'manual_review',
              decision_point: 'resolve_task',
              decision_outcome: 'approved',
              decision_reason: 'Approved from shipment SHP-DRAWER-DEFAULT address review.',
            }],
            total: 1,
            page: opts?.page ?? 0,
            page_size: opts?.page_size ?? 25,
          };
        }
        return {
          rows: [{
            id: 'dlg_api_gateway_materialized',
            resource_type: 'shipment',
            resource_id: resourceId,
            timestamp: '2026-05-14T13:27:08.000Z',
            decision_category: 'shipment_create',
            decision_point: 'api_gateway_materialization',
            decision_outcome: 'materialized',
            correlation_id: '453f46f4-9583-4bb7-92ce-35b4428b3c0c',
            decision_inputs: {
              api_gateway_request_id: '77acafee-e0c7-4796-b849-f946cfd4cf68',
            },
          }],
          total: 1,
          page: opts?.page ?? 0,
          page_size: opts?.page_size ?? 25,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Decisions');
    await waitFor(() => {
      const decisionCall = LIST_SPY.mock.calls.find(
        (c) => (c as unknown[])[0] === 'decision_log',
      );
      expect(decisionCall).toBeTruthy();
      const opts = (decisionCall as unknown[])[1] as
        | { filter?: { resource_type?: string; resource_id?: string } }
        | undefined;
      expect(opts?.filter?.resource_type).toBe('shipment');
      expect(opts?.filter?.resource_id).toBeTruthy();
    });
    expect(await screen.findByText(/api gateway materialization/i)).toBeInTheDocument();
    expect(screen.getByText(/materialized/i)).toBeInTheDocument();
    expect(screen.getByText(/manual review/i)).toBeInTheDocument();
    expect(screen.getByText(/resolve task/i)).toBeInTheDocument();
    expect(screen.getByText(/approved/i)).toBeInTheDocument();
  });

  it('opens the shipment Decisions tab from the row action without leaving shipment context', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const [rowActions] = screen.getAllByRole('button', { name: 'Row actions' });
    await user.click(rowActions as HTMLElement);
    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll('.palette__item-label')).some(
          (node) => node.textContent?.trim() === 'View decision trail',
        ),
      ).toBe(true);
    });
    const decisionAction = Array.from(document.querySelectorAll<HTMLElement>('.palette__item')).find(
      (node) => node.querySelector('.palette__item-label')?.textContent?.trim() === 'View decision trail',
    );
    expect(decisionAction).toBeTruthy();
    await user.click(decisionAction as HTMLElement);

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    const decisionsTab = within(drawer).getByRole('tab', { name: /^Decisions$/ });
    expect(decisionsTab).toHaveAttribute('aria-selected', 'true');
    expect(window.location.pathname).toBe('/operate/shipments');
    expect(window.location.search).not.toContain('resource_type=shipment');

    await waitFor(() => {
      const decisionCall = LIST_SPY.mock.calls.find(
        (c) => (c as unknown[])[0] === 'decision_log',
      );
      expect(decisionCall).toBeTruthy();
      const opts = (decisionCall as unknown[])[1] as
        | { filter?: { resource_type?: string; resource_id?: string } }
        | undefined;
      expect(opts?.filter?.resource_type).toBe('shipment');
      expect(opts?.filter?.resource_id).toBeTruthy();
    });
  });

  it('row Amend opens a shipment-local workflow modal instead of the amend review queue', async () => {
    const user = userEvent.setup();
    const amendSpy = vi.spyOn(ds, 'shipment_amend_cancel_v1').mockResolvedValue({
      ok: true,
      workflow_template: 'shipment_modify_v1',
      workflow_run_id: 'wf_shipment_local_amend',
      started_via: 'console_v2',
      canonical_entrypoint: 'public.progress_workflow_run',
      dry_run: false,
      diff: { carrier_reference_number: { before: 'old', after: 'CARR-LOCAL-1' } },
      settings_resolution_id: 'srlv_shipment_local_amend',
    });
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const [rowActions] = screen.getAllByRole('button', { name: 'Row actions' });
    await user.click(rowActions as HTMLElement);
    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll('.palette__item-label')).some(
          (node) => node.textContent?.trim() === 'Amend',
        ),
      ).toBe(true);
    });
    const amendAction = Array.from(document.querySelectorAll<HTMLElement>('.palette__item')).find(
      (node) => node.querySelector('.palette__item-label')?.textContent?.trim() === 'Amend',
    );
    expect(amendAction).toBeTruthy();
    await user.click(amendAction as HTMLElement);

    const form = await screen.findByTestId('shipment-amend-form');
    expect(window.location.pathname).toBe('/operate/shipments');
    expect(window.location.pathname).not.toBe('/operate/amend-cancel');
    const carrierRef = within(form).getByLabelText(/Carrier reference/i);
    await user.clear(carrierRef);
    await user.type(carrierRef, 'CARR-LOCAL-1');
    await user.click(within(form).getByRole('button', { name: /Apply amend/i }));

    await waitFor(() => {
      expect(amendSpy).toHaveBeenCalledWith(
        expect.any(String),
        'modify',
        expect.objectContaining({
          carrier_reference_number: 'CARR-LOCAL-1',
          source: 'console_v2.shipments.amend_modal',
        }),
        { dryRun: false },
      );
    });
    amendSpy.mockRestore();
  });

  it('drawer footer Amend stays in the shipment domain view', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    const drawer = document.querySelector('.drawer') as HTMLElement;
    await user.click(within(drawer).getByRole('button', { name: /^Amend$/i }));
    expect(await screen.findByTestId('shipment-amend-form')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/operate/shipments');
  });

  it('Audit tab reads shipment audit rows without global fallback data', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    const shipmentRows = await ds.ui_list_resource_v1<Record<string, unknown>>('shipment_directory');
    const shipmentId = String(shipmentRows.rows[0]?.shipment_id ?? shipmentRows.rows[0]?.id ?? '');
    LIST_SPY.mockResolvedValueOnce({
      rows: [{
        id: 'audit_test',
        created_at: '2026-05-05T10:00:00Z',
        op: 'shipment_updated',
        changed_by: 'usr_operator',
        correlation_id: 'cor_audit',
        pk: { id: shipmentId },
      }],
      total: 1,
    });
    await clickRailTab(user, 'Audit');
    await waitFor(() => {
      const auditCall = LIST_SPY.mock.calls.find(
        (c) => (c as unknown[])[0] === 'audit_table_changes',
      );
      expect(auditCall).toBeTruthy();
      const opts = (auditCall as unknown[])[1] as { filter?: { table_name?: string; pk?: { id?: string } } } | undefined;
      expect(opts?.filter?.table_name).toBe('shipments');
      expect(opts?.filter?.pk?.id).toBe(shipmentId);
    });
    await waitFor(() => {
      expect(screen.getByText('Operation')).toBeInTheDocument();
    });
    expect(document.querySelector('.drawer')?.textContent ?? '').not.toMatch(/\bOp\b/);
  });

  it('Audit tab shows shipment action audit records when table audit rows are absent', async () => {
    const shipmentRows = await defaultShipmentDrawerList('shipment_directory');
    const shipmentId = String(shipmentRows.rows[0]?.shipment_id ?? shipmentRows.rows[0]?.id ?? '');
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'audit_table_changes') return { rows: [], total: 0 };
      if (resource === 'shipment_actions') {
        const filter = (opts as { filter?: { shipment_id?: string } } | undefined)?.filter;
        expect(filter?.shipment_id).toBe(shipmentId);
        return {
          rows: [{
            id: 'shipment_action_audit_test',
            shipment_id: shipmentId,
            timestamp: '2026-05-05T10:01:00Z',
            action_type: 'address_update',
            performed_by_system: 'workflow_handlers.execute_address_update',
            action_data: { correlation_id: 'cor_action_audit' },
          }],
          total: 1,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Audit');

    await waitFor(() => {
      const calls = LIST_SPY.mock.calls.map((c) => (c as unknown[])[0]);
      expect(calls).toContain('audit_table_changes');
      expect(calls).toContain('shipment_actions');
    });
    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).toContain('Shipment action');
    expect(drawerText).toContain('Address update');
    expect(drawerText).toContain('Actor #UPDATE');
    expect(drawerText).toContain('Activity');
    expect(drawerText).toContain('Linked');
    expect(drawerText).not.toContain('Trace #AUDIT');
    expect(drawerText).not.toContain('No audit changes recorded for this shipment.');
  });

  it('shipment_id filter is forwarded for each tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Boxes');
    await waitFor(() => {
      const boxesCall = LIST_SPY.mock.calls.find(
        (c) => (c as unknown[])[0] === 'shipment_boxes',
      );
      expect(boxesCall).toBeTruthy();
      const opts = (boxesCall as unknown[])[1] as { filter?: { shipment_id?: string } } | undefined;
      expect(opts?.filter?.shipment_id).toBeTruthy();
    });
  });

  it('Route tab scopes route-stop reads to the active shipment and fetches the linked route run by id', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Route');
    await waitFor(() => {
      const routeStopsCall = LIST_SPY.mock.calls.find(
        (c) => (c as unknown[])[0] === 'route_stops',
      );
      expect(routeStopsCall).toBeTruthy();
      const opts = (routeStopsCall as unknown[])[1] as { filter?: { shipment_id?: string } } | undefined;
      expect(opts?.filter?.shipment_id).toBeTruthy();
    });
    await waitFor(() => {
      expect(GET_SPY.mock.calls.some(([key]) => key === 'route_runs')).toBe(true);
    });
  });

  it('Route tab fails closed when any route-stop row does not belong to the active shipment', async () => {
    const user = userEvent.setup();
    let scopedShipmentId = '';
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'route_stops') {
        scopedShipmentId = String((opts as { filter?: { shipment_id?: string } } | undefined)?.filter?.shipment_id ?? '');
        return {
          rows: [
            {
              id: 'rst_right_scope',
              shipment_id: scopedShipmentId,
              route_run_id: 'rr_right_scope',
              sequence_order: 1,
              status: 'planned',
            },
            {
              id: 'rst_wrong_scope',
              shipment_id: 'shp_other_scope',
              route_run_id: 'rr_wrong_scope',
              sequence_order: 1,
              status: 'planned',
            },
          ],
          total: 1,
          page: 0,
          page_size: 25,
        };
      }
      return defaultShipmentDrawerList(resource, opts);
    });

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Route');

    expect(await screen.findByText('Route stop scope mismatch')).toBeInTheDocument();
    expect(screen.getByText(/Route stop details could not be matched to this shipment/i)).toBeInTheDocument();
    expect(screen.queryByText(/outside the active shipment scope/i)).not.toBeInTheDocument();
  });

  it('Route tab renders route-stop read failures as an error state', async () => {
    const user = userEvent.setup();
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'route_stops') throw new Error('42501 route permission denied');
      return defaultShipmentDrawerList(resource, opts);
    });

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Route');

    expect(await screen.findByText('Route stops unavailable')).toBeInTheDocument();
    expect(screen.getByText('42501 route permission denied')).toBeInTheDocument();
  });

  it('Tasks tab uses the shipment-scoped registry filter instead of loading the global task queue', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Tasks');
    await waitFor(() => {
      const tasksCall = LIST_SPY.mock.calls.find(
        (c) => (c as unknown[])[0] === 'tasks',
      );
      expect(tasksCall).toBeTruthy();
      const opts = (tasksCall as unknown[])[1] as { filter?: { shipment_id?: string } } | undefined;
      expect(opts?.filter?.shipment_id).toBeTruthy();
    });
  });

  it('Tasks tab renders read failures as an error state', async () => {
    const user = userEvent.setup();
    LIST_SPY.mockImplementation(async (resource, opts) => {
      if (resource === 'tasks') throw new Error('42501 tasks permission denied');
      return defaultShipmentDrawerList(resource, opts);
    });

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Tasks');

    expect(await screen.findByText('Tasks unavailable')).toBeInTheDocument();
    expect(screen.getByText('42501 tasks permission denied')).toBeInTheDocument();
  });

  it('Tasks tab row actions resolve task-specific console targets from lookup metadata', () => {
    expect(
      resolveShipmentTaskTarget({
        id: 'tsk_ndr',
        task_type: 'dispatch_exception_review',
        task_type_metadata: {
          console_path: '/operate/exceptions',
          console_focus_param: 'task',
          console_focus_source: 'id',
        },
      }),
    ).toBe(
      '/operate/exceptions?task=tsk_ndr',
    );
    expect(
      resolveShipmentTaskTarget({
        id: 'tsk_route',
        task_type: 'route_stop_execute',
        resource_id: 'rs_44000',
        task_type_metadata: {
          console_path: '/operate/dispatch',
          console_focus_param: 'route_stop',
          console_focus_source: 'resource_id',
        },
      }),
    ).toBe('/operate/dispatch?route_stop=rs_44000');
    expect(
      resolveShipmentTaskTarget({
        id: 'tsk_amend',
        task_type: 'shipment_amend_review',
        task_type_metadata: {
          console_path: '/operate/amend-cancel',
        },
      }),
    ).toBe(
      '/operate/amend-cancel?focus=tsk_amend',
    );
    expect(resolveShipmentTaskTarget({ id: 'tsk_manual', task_type: 'unknown_review' })).toBe(
      '/workflows/review-queue?focus=tsk_manual',
    );
  });

  it('Recipient and Address tabs fetch the shipment-linked rows by id instead of broad table reads', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);
    await clickRailTab(user, 'Recipient');
    await waitFor(() => {
      expect(GET_SPY.mock.calls.some(([key]) => key === 'recipients')).toBe(true);
    });
    expect(LIST_SPY.mock.calls.some(([key]) => key === 'recipients')).toBe(false);

    await clickRailTab(user, 'Address');
    await waitFor(() => {
      expect(GET_SPY.mock.calls.some(([key]) => key === 'addresses')).toBe(true);
    });
    expect(await screen.findByText('RNQA7083')).toBeInTheDocument();
    expect(screen.getByText('24.7137, 46.6754')).toBeInTheDocument();
    expect(LIST_SPY.mock.calls.some(([key]) => key === 'addresses')).toBe(false);
  });

  it('Recipient and Address tabs render read failures as error states', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openFirstShipmentDrawer(user);

    GET_SPY.mockImplementationOnce(async () => {
      throw new Error('42501 recipient permission denied');
    });
    await clickRailTab(user, 'Recipient');
    expect(await screen.findByText('Recipient unavailable')).toBeInTheDocument();
    expect(screen.getByText('42501 recipient permission denied')).toBeInTheDocument();

    GET_SPY.mockImplementation(async (resource, id) => {
      if (resource === 'addresses') throw new Error('42501 address permission denied');
      const fixture = shipmentDetailFixture(resource, id);
      if (fixture) return fixture;
      const defaultFixture = defaultShipmentDrawerGet(resource, id);
      if (defaultFixture) return defaultFixture;
      return REAL_GET(resource, id);
    });
    await clickRailTab(user, 'Address');
    expect(await screen.findByText('Address unavailable')).toBeInTheDocument();
    expect(screen.getByText('42501 address permission denied')).toBeInTheDocument();
  });
});
