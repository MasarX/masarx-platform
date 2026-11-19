// directory-projections.test.tsx — covers W24 OPERATIONS closure paired
// projection consumption. Each operate module that ships a paired
// `v_*_directory` view (shipments / route_runs / route_plans) must
// subscribe through `useResourceList<*DirectoryRow>('<directory_key>')` so
// the production cutover is a single getSupabaseClient() branch flip in
// `ui_list_resource_v1`.
//
// We spy on `ui_list_resource_v1` and assert that the directory keys
// resolve when each module mounts. This guarantees the seam is wired even
// before any UI interaction, which is the relevant invariant for the
// projection-as-registry-resource contract.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { ShipmentsModule } from '@/modules/operate/shipments';
import { DispatchModule } from '@/modules/operate/dispatch';
import { RoutePlansModule } from '@/modules/operate/route-plans';
import { TrackingMapModule } from '@/modules/operate/tracking-map';
import * as api from '@/lib/api';
import * as ds from '@/lib/data-source';

const LIST_SPY = vi.spyOn(api, 'ui_list_resource_v1');
const COMPLETE_LIST_SPY = vi.spyOn(api, 'ui_list_resource_complete');

beforeEach(() => {
  LIST_SPY.mockClear();
  COMPLETE_LIST_SPY.mockClear();
});

function listResourceCalls(): string[] {
  return [
    ...LIST_SPY.mock.calls.map((c) => c[0]),
    ...COMPLETE_LIST_SPY.mock.calls.map((c) => c[0]),
  ];
}

describe('OPERATIONS modules · paired projection consumption (W24)', () => {
  it('ShipmentsModule subscribes to ui_list_resource_v1("shipment_directory")', async () => {
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const calls = listResourceCalls();
      expect(calls).toContain('shipment_directory');
    });
  });

  it('DispatchModule subscribes to ui_list_resource_v1("route_run_directory")', async () => {
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const calls = listResourceCalls();
      expect(calls).toContain('route_run_directory');
    });
  });

  it('RoutePlansModule subscribes to ui_list_resource_v1("route_plan_directory")', async () => {
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const calls = listResourceCalls();
      expect(calls).toContain('route_plan_directory');
    });
  });

  // W38-OPERATIONS P2-2 closure regression guard (W39): tracking-map.tsx
  // additively consumes `shipment_directory` to enrich the bottom-card
  // destination_city resolution through the canonical address join. The
  // canonical SSOT remains the base `shipments` row read; this directory
  // read is the production-cutover seam for projected fields.
  it('TrackingMapModule subscribes to ui_list_resource_v1("shipment_directory") for canonical destination_city projection (W38 P2-2)', async () => {
    renderWithProviders(<TrackingMapModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const calls = listResourceCalls();
      expect(calls).toContain('shipment_directory');
    });
  });

  // W38-OPERATIONS P2-3 closure regression guard (W39): the route-plans
  // rebalance modal target picker consumes `route_plan_directory` for
  // plan_display_id / wave_label / status / stop_count / run_count
  // (matching the drawer body, which already consumed the directory at
  // W24). The mount-time subscription test above already proves the seam
  // is wired; this further asserts the canonical projection columns are
  // part of the directory row contract the picker reads.
  it('route_plan_directory rows surface plan_display_id + wave_label + status + stop_count + run_count for the rebalance modal picker (W38 P2-3)', async () => {
    const result = await ds.ui_list_resource_v1('route_plan_directory');
    expect(result.rows.length).toBeGreaterThan(0);
    const sample = result.rows[0] as Record<string, unknown>;
    // The 5 canonical projection columns the rebalance modal targetReference
    // display + sub callbacks consume via planDirectoryById.get(r.id).
    expect(typeof (sample as { plan_display_id?: unknown }).plan_display_id).toBe('string');
    expect(sample).toHaveProperty('wave_label');
    expect(sample).toHaveProperty('status');
    expect(typeof (sample as { stop_count?: unknown }).stop_count).toBe('number');
    expect(typeof (sample as { run_count?: unknown }).run_count).toBe('number');
  });

  it('shipment_directory rows surface canonical destination_city / counterparty labels / counters / is_at_risk', async () => {
    const result = await ds.ui_list_resource_v1('shipment_directory');
    expect(result.rows.length).toBeGreaterThan(0);
    const sample = result.rows[0] as Record<string, unknown>;
    // Canonical SSOT columns retained.
    expect(sample).toHaveProperty('id');
    expect(sample).toHaveProperty('client_id');
    expect(sample).toHaveProperty('tracking_number');
    expect(sample).toHaveProperty('status');
    // Address join projections (canonical destination_city resolution).
    expect(sample).toHaveProperty('destination_city');
    // Counterparty label projections.
    expect(sample).toHaveProperty('client_label');
    expect(sample).toHaveProperty('sender_label');
    expect(sample).toHaveProperty('recipient_label');
    // Derived counter projections.
    expect(sample).toHaveProperty('box_actual_count');
    expect(sample).toHaveProperty('label_count');
    expect(sample).toHaveProperty('scan_event_count');
    expect(sample).toHaveProperty('comms_attempt_count');
    expect(sample).toHaveProperty('active_task_count');
    // Derived risk flag (mirrors isShipmentRisk() FE helper).
    expect(typeof (sample as { is_at_risk?: unknown }).is_at_risk).toBe('boolean');
  });

  it('route_run_directory rows surface canonical branch/driver/vehicle labels and assignment projection', async () => {
    const result = await ds.ui_list_resource_v1('route_run_directory');
    expect(result.rows.length).toBeGreaterThan(0);
    const sample = result.rows[0] as Record<string, unknown>;
    // Canonical SSOT columns retained.
    expect(sample).toHaveProperty('id');
    expect(sample).toHaveProperty('branch_id');
    expect(sample).toHaveProperty('driver_user_id');
    expect(sample).toHaveProperty('vehicle_id');
    expect(sample).toHaveProperty('status');
    // Display alias.
    expect(typeof (sample as { run_display_id?: unknown }).run_display_id).toBe('string');
    // Joined label projections.
    expect(sample).toHaveProperty('branch_label');
    expect(sample).toHaveProperty('driver_label');
    expect(sample).toHaveProperty('vehicle_label');
    // Derived counter projections.
    expect(typeof (sample as { stop_count?: unknown }).stop_count).toBe('number');
    expect(typeof (sample as { cod_total?: unknown }).cod_total).toBe('number');
    // Assignment projection from active route_run_assignments.
    expect(sample).toHaveProperty('assignment_status');
    expect(sample).toHaveProperty('assignment_mode');
    expect(typeof (sample as { is_partner_run?: unknown }).is_partner_run).toBe('boolean');
  });

  it('route_plan_directory rows surface canonical branch label, wave projection, and counters', async () => {
    const result = await ds.ui_list_resource_v1('route_plan_directory');
    expect(result.rows.length).toBeGreaterThan(0);
    const sample = result.rows[0] as Record<string, unknown>;
    // Canonical SSOT columns retained.
    expect(sample).toHaveProperty('id');
    expect(sample).toHaveProperty('branch_id');
    expect(sample).toHaveProperty('status');
    // Display alias.
    expect(typeof (sample as { plan_display_id?: unknown }).plan_display_id).toBe('string');
    // Joined label projections.
    expect(sample).toHaveProperty('branch_label');
    // Wave projection from metadata/inputs JSONB or seed alias fallback.
    expect(sample).toHaveProperty('wave_label');
    // Derived counter projections.
    expect(typeof (sample as { run_count?: unknown }).run_count).toBe('number');
    expect(typeof (sample as { stop_count?: unknown }).stop_count).toBe('number');
    expect(typeof (sample as { drivers_notified_count?: unknown }).drivers_notified_count).toBe(
      'number',
    );
    // Derived applied flag.
    expect(typeof (sample as { is_applied?: unknown }).is_applied).toBe('boolean');
  });
});
