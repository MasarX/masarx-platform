// shipments.queries.test.tsx — exercises the canonical mutation seams used by
// the Shipments surface (claim-A) at the queries.ts level. These guard the
// invalidation contract that the UI relies on after writes.
//
// We use a long-lived QueryClient so seeded query state survives the
// invalidation transition, then spy on `invalidateQueries` to assert the
// exact key contract — same pattern the existing `queries.test.tsx` uses.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  qk,
  useShipmentBatchOp,
  useResortShipment,
  useReprintLabel,
  useReserveSlot,
} from '@/lib/queries';
import * as api from '@/lib/api';
import { useShipmentRoutingRefresh } from '@/modules/operate/shipments';

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('shipments mutation seams', () => {
  let client: QueryClient;
  beforeEach(() => {
    vi.restoreAllMocks();
    client = makeClient();
  });

  it('useShipmentBatchOp refreshes shipment operation read models on supported batch success', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    const refetchSpy = vi.spyOn(client, 'refetchQueries');
    const batchSpy = vi.spyOn(api, 'ui_execute_shipment_batch_operation_v1').mockResolvedValue({
      ok: true,
      count: 1,
      op: 'cancel',
      dry_run: true,
    });
    client.setQueryData(qk.list('shipments'), { rows: [{ id: 'shp_1' }], total: 1 });
    client.setQueryData(qk.list('shipment_directory'), { rows: [{ id: 'shp_1' }], total: 1 });
    const { result } = renderHook(() => useShipmentBatchOp(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({
        ids: ['shp_1'],
        op: 'cancel',
        payload: { source: 'console_v2.shipments.bulk_cancel_preview' },
        dryRun: true,
      });
    });
    expect(batchSpy).toHaveBeenCalledWith(
      ['shp_1'],
      'cancel',
      { source: 'console_v2.shipments.bulk_cancel_preview' },
      { dryRun: true },
    );
    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['list', 'shipments']);
    expect(calls).toContainEqual(['list', 'shipment_directory']);
    expect(calls).toContainEqual(['list', 'shipments', 'complete']);
    expect(calls).toContainEqual(['list', 'shipment_directory', 'complete']);
    expect(calls).toContainEqual(['list', 'shipment_actions']);
    expect(calls).toContainEqual(['list', 'decision_log']);
    expect(calls).toContainEqual(['list', 'audit_table_changes']);
    expect(calls).toContainEqual(qk.resource('shipments', 'shp_1'));
    expect(calls).toContainEqual(qk.shipmentTimeline('shp_1'));
    const refetchCalls = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(refetchCalls).toContainEqual(['list', 'shipments']);
    expect(refetchCalls).toContainEqual(['list', 'shipment_directory']);
    expect(refetchCalls).toContainEqual(['list', 'shipments', 'complete']);
    expect(refetchCalls).toContainEqual(['list', 'shipment_directory', 'complete']);
    expect(refetchCalls).toContainEqual(qk.resource('shipments', 'shp_1'));
    expect(refetchCalls).toContainEqual(qk.shipmentTimeline('shp_1'));
    spy.mockRestore();
    refetchSpy.mockRestore();
  });

  it('useResortShipment refreshes shipment, basket, and routing readback caches', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    const refetchSpy = vi.spyOn(client, 'refetchQueries');
    client.setQueryData(qk.resource('shipments', 'shp_seed'), { id: 'shp_seed' });
    const { result } = renderHook(() => useResortShipment(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync('shp_seed');
    });
    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(qk.resource('shipments', 'shp_seed'));
    expect(calls).toContainEqual(qk.shipmentTimeline('shp_seed'));
    expect(calls).toContainEqual(['list', 'shipment_directory']);
    expect(calls).toContainEqual(['list', 'shipment_actions']);
    expect(calls).toContainEqual(['list', 'baskets']);
    expect(calls).toContainEqual(['list', 'basket_items']);
    expect(calls).toContainEqual(['list', 'basket_transitions']);
    expect(calls).toContainEqual(['list', 'route_run_directory']);
    expect(calls).toContainEqual(['resources_by_ids', 'baskets']);
    expect(calls).toContainEqual(['list', 'shipments', 'complete']);
    expect(calls).toContainEqual(['list', 'baskets', 'complete']);
    const refetchCalls = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(refetchCalls).toContainEqual(qk.resource('shipments', 'shp_seed'));
    expect(refetchCalls).toContainEqual(qk.shipmentTimeline('shp_seed'));
    expect(refetchCalls).toContainEqual(['list', 'shipment_directory']);
    expect(refetchCalls).toContainEqual(['list', 'baskets']);
    expect(refetchCalls).toContainEqual(['list', 'shipments', 'complete']);
    expect(refetchCalls).toContainEqual(['list', 'baskets', 'complete']);
    spy.mockRestore();
    refetchSpy.mockRestore();
  });

  it('useShipmentRoutingRefresh requeues geocoding and refreshes shipment routing reads', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    const refetchSpy = vi.spyOn(client, 'refetchQueries');
    const geocodeSpy = vi.spyOn(api, 'ui_execute_shipment_update_geocode_v1').mockResolvedValue({
      ok: true,
      status: 'workflow_started',
      action_key: 'shipments.update_geocode',
      resource_key: 'shipments',
      count: 1,
      workflow_run_id: 'wfr_refresh_routing',
    });
    const { result } = renderHook(() => useShipmentRoutingRefresh(), { wrapper: wrapper(client) });
    let outcome: Awaited<ReturnType<typeof result.current.refreshRouting>> | undefined;

    await act(async () => {
      outcome = await result.current.refreshRouting({
        id: 'shp_seed',
        destination_address_id: 'addr_destination',
        address_id: 'addr_alias',
      });
    });

    expect(geocodeSpy).toHaveBeenCalledWith({
      shipment_id: 'shp_seed',
      destination_address_id: 'addr_destination',
      address_id: 'addr_alias',
    });
    expect(outcome?.payload).toMatchObject({
      shipment_id: 'shp_seed',
      destination_address_id: 'addr_destination',
      address_id: 'addr_alias',
    });
    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['list', 'addresses']);
    expect(calls).toContainEqual(['list', 'shipments']);
    expect(calls).toContainEqual(['list', 'shipment_directory']);
    expect(calls).toContainEqual(['list', 'geocodes']);
    expect(calls).toContainEqual(['list', 'geocoding_attempts']);
    expect(calls).toContainEqual(['list', 'manual_review_tasks']);
    expect(calls).toContainEqual(['list', 'workflow_runs']);
    expect(calls).toContainEqual(['list', 'workflow_run_steps']);
    expect(calls).toContainEqual(['list', 'baskets']);
    expect(calls).toContainEqual(['list', 'basket_items']);
    expect(calls).toContainEqual(['resources_by_ids', 'baskets']);
    expect(calls).toContainEqual(['lists_by_filters', 'basket_items']);
    expect(calls).toContainEqual(['list', 'route_runs']);
    expect(calls).toContainEqual(['list', 'route_stops']);
    expect(calls).toContainEqual(['list', 'route_plan_delivery_wave_candidates']);
    expect(calls).toContainEqual(qk.resource('shipments', 'shp_seed'));
    expect(calls).toContainEqual(qk.shipmentTimeline('shp_seed'));
    expect(calls).toContainEqual(['list', 'shipments', 'complete']);
    expect(calls).toContainEqual(['list', 'geocodes', 'complete']);
    const refetchCalls = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(refetchCalls).toContainEqual(['list', 'addresses']);
    expect(refetchCalls).toContainEqual(['list', 'shipments']);
    expect(refetchCalls).toContainEqual(['list', 'shipment_directory']);
    expect(refetchCalls).toContainEqual(['list', 'geocodes']);
    expect(refetchCalls).toContainEqual(['list', 'manual_review_tasks']);
    expect(refetchCalls).toContainEqual(['list', 'workflow_runs']);
    expect(refetchCalls).toContainEqual(['list', 'workflow_run_steps']);
    expect(refetchCalls).toContainEqual(['list', 'route_plan_delivery_wave_candidates']);
    expect(refetchCalls).toContainEqual(qk.resource('shipments', 'shp_seed'));
    expect(refetchCalls).toContainEqual(qk.shipmentTimeline('shp_seed'));
    expect(refetchCalls).toContainEqual(['list', 'shipments', 'complete']);
    spy.mockRestore();
    refetchSpy.mockRestore();
  });

  it('useReprintLabel resolves with a label_job_id and refreshes shipment readback when scoped', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    const refetchSpy = vi.spyOn(client, 'refetchQueries');
    const reprintSpy = vi.spyOn(api, 'request_label_reprint').mockResolvedValue({
      ok: true,
      label_id: 'lbl_test_1',
      reason: 'manual',
      label_job_id: 'ljob_test_1',
      new_version_id: null,
    });
    const { result } = renderHook(() => useReprintLabel(), { wrapper: wrapper(client) });
    let res: unknown;
    await act(async () => {
      res = await result.current.mutateAsync({
        labelId: 'lbl_test_1',
        reason: 'manual',
        shipmentId: 'shp_label_reprint_1',
      });
    });
    expect(reprintSpy).toHaveBeenCalledWith('lbl_test_1', { reason: 'manual' });
    expect(res).toMatchObject({
      ok: true,
      label_id: 'lbl_test_1',
      reason: 'manual',
    });
    // The seam returns the queued label job. Version lineage is only claimed
    // after the renderer completes and label_versions read back.
    expect((res as { label_job_id?: string }).label_job_id).toBeDefined();
    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['list', 'labels']);
    expect(calls).toContainEqual(['list', 'label_jobs']);
    expect(calls).toContainEqual(['list', 'label_versions']);
    expect(calls).toContainEqual(['list', 'shipment_directory']);
    expect(calls).toContainEqual(['list', 'shipments']);
    expect(calls).toContainEqual(['list', 'shipment_actions']);
    expect(calls).toContainEqual(['list', 'decision_log']);
    expect(calls).toContainEqual(['list', 'audit_table_changes']);
    expect(calls).toContainEqual(qk.resource('labels', 'lbl_test_1'));
    expect(calls).toContainEqual(qk.resource('shipments', 'shp_label_reprint_1'));
    expect(calls).toContainEqual(qk.shipmentTimeline('shp_label_reprint_1'));
    const refetchCalls = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(refetchCalls).toContainEqual(['list', 'labels']);
    expect(refetchCalls).toContainEqual(['list', 'label_jobs']);
    expect(refetchCalls).toContainEqual(['list', 'label_versions']);
    expect(refetchCalls).toContainEqual(['list', 'shipment_directory']);
    expect(refetchCalls).toContainEqual(['list', 'shipments']);
    expect(refetchCalls).toContainEqual(['list', 'shipment_actions']);
    expect(refetchCalls).toContainEqual(['list', 'decision_log']);
    expect(refetchCalls).toContainEqual(['list', 'audit_table_changes']);
    expect(refetchCalls).toContainEqual(qk.resource('labels', 'lbl_test_1'));
    expect(refetchCalls).toContainEqual(qk.resource('shipments', 'shp_label_reprint_1'));
    expect(refetchCalls).toContainEqual(qk.shipmentTimeline('shp_label_reprint_1'));
  });

  it('useReserveSlot resolves with the canonical reserve_delivery_slot_v1 shape', async () => {
    const reserveSpy = vi.spyOn(api, 'reserve_delivery_slot_v1').mockResolvedValue({
      ok: true,
      slot_date: '2026-04-26',
      reserved_at: '2026-04-26T08:00:00Z',
    });
    const { result } = renderHook(() => useReserveSlot(), { wrapper: wrapper(client) });
    let res: unknown;
    await act(async () => {
      res = await result.current.mutateAsync({ slot_date: '2026-04-26' });
    });
    expect(reserveSpy).toHaveBeenCalledWith({ slot_date: '2026-04-26' });
    expect(res).toMatchObject({
      ok: true,
      slot_date: '2026-04-26',
    });
  });
});
