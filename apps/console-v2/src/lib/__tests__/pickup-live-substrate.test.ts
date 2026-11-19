import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  schema: vi.fn(),
}));

vi.mock('../supabase', () => ({
  getSupabaseClient: () => ({
    schema: mocks.schema,
    rpc: mocks.rpc,
  }),
  __resetSupabaseClientForTests: vi.fn(),
  rpc: vi.fn(),
}));

describe('pickup live backend substrate', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.rpc.mockReset();
    mocks.schema.mockReset();
    mocks.schema.mockReturnValue({ rpc: mocks.rpc });
  });

  it('routes pickup request, wave, and failure reads through canonical api RPCs', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [{
          shipment_id: '00000000-0000-4000-8000-000000000201',
          client_id: '00000000-0000-4000-8000-000000000202',
          sender_id: '00000000-0000-4000-8000-000000000203',
          status: 'pickup_requested',
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          route_run_id: '00000000-0000-4000-8000-000000000204',
          status: 'planned',
          pickup_stop_count: 2,
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          shipment_id: '00000000-0000-4000-8000-000000000205',
          status: 'pickup_failed',
          failure_reason: 'sender_not_ready',
        }],
        error: null,
      });

    const ds = await import('../data-source');
    const requests = await ds.pickup_requests_list_v1({
      client_id: '00000000-0000-4000-8000-000000000202',
      sender_id: '00000000-0000-4000-8000-000000000203',
      status: 'pickup_requested',
      limit: 15,
    });
    const waves = await ds.pickup_waves_list_v1({
      route_run_ids: ['00000000-0000-4000-8000-000000000204'],
      status: 'planned',
      limit: 10,
    });
    const failures = await ds.pickup_failures_list_v1({
      shipment_ids: ['00000000-0000-4000-8000-000000000205'],
      status: 'pickup_failed',
      limit: 5,
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'pickup_requests_list_v1', {
      p_client_id: '00000000-0000-4000-8000-000000000202',
      p_sender_id: '00000000-0000-4000-8000-000000000203',
      p_status: 'pickup_requested',
      p_limit: 15,
      p_offset: 0,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'pickup_waves_list_v1', {
      p_route_run_ids: ['00000000-0000-4000-8000-000000000204'],
      p_status: 'planned',
      p_limit: 10,
      p_offset: 0,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'pickup_failures_list_v1', {
      p_shipment_ids: ['00000000-0000-4000-8000-000000000205'],
      p_client_id: null,
      p_sender_id: null,
      p_status: 'pickup_failed',
      p_limit: 5,
      p_offset: 0,
    });
    expect(requests.rows[0]).toMatchObject({ id: '00000000-0000-4000-8000-000000000201' });
    expect(waves.rows[0]).toMatchObject({ id: '00000000-0000-4000-8000-000000000204' });
    expect(failures.rows[0]).toMatchObject({ id: '00000000-0000-4000-8000-000000000205' });
  });

  it('reads every pickup list page when no explicit pagination is supplied', async () => {
    const rows = (idKey: 'shipment_id' | 'route_run_id', prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        [idKey]: `${prefix}-${String(index).padStart(3, '0')}`,
        status: 'pickup_requested',
      }));

    mocks.rpc
      .mockResolvedValueOnce({ data: rows('shipment_id', 'request-a', 100), error: null })
      .mockResolvedValueOnce({ data: rows('shipment_id', 'request-b', 3), error: null })
      .mockResolvedValueOnce({ data: rows('route_run_id', 'wave-a', 100), error: null })
      .mockResolvedValueOnce({ data: rows('route_run_id', 'wave-b', 2), error: null })
      .mockResolvedValueOnce({ data: rows('shipment_id', 'failure-a', 100), error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const ds = await import('../data-source');
    const requests = await ds.pickup_requests_list_v1();
    const waves = await ds.pickup_waves_list_v1();
    const failures = await ds.pickup_failures_list_v1();

    expect(requests.total).toBe(103);
    expect(waves.total).toBe(102);
    expect(failures.total).toBe(100);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'pickup_requests_list_v1', {
      p_client_id: null,
      p_sender_id: null,
      p_status: null,
      p_limit: 100,
      p_offset: 0,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'pickup_requests_list_v1', {
      p_client_id: null,
      p_sender_id: null,
      p_status: null,
      p_limit: 100,
      p_offset: 100,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'pickup_waves_list_v1', {
      p_route_run_ids: null,
      p_status: null,
      p_limit: 100,
      p_offset: 0,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'pickup_waves_list_v1', {
      p_route_run_ids: null,
      p_status: null,
      p_limit: 100,
      p_offset: 100,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'pickup_failures_list_v1', {
      p_shipment_ids: null,
      p_client_id: null,
      p_sender_id: null,
      p_status: null,
      p_limit: 100,
      p_offset: 0,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(6, 'pickup_failures_list_v1', {
      p_shipment_ids: null,
      p_client_id: null,
      p_sender_id: null,
      p_status: null,
      p_limit: 100,
      p_offset: 100,
    });
  });

  it('creates pickup requests through the canonical RPC and requires backend request readback', async () => {
    const payload = {
      organization_id: '00000000-0000-4000-8000-000000000208',
      client_id: '00000000-0000-4000-8000-000000000202',
      sender_id: '00000000-0000-4000-8000-000000000203',
      requested_window_start_at: '2026-06-02T08:00:00.000Z',
      requested_window_end_at: '2026-06-02T12:00:00.000Z',
      box_count: 3,
    };
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          shipment_id: '00000000-0000-4000-8000-000000000206',
          tracking_number: 'PICKUP-REQ-206',
          created: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          shipment_id: '00000000-0000-4000-8000-000000000206',
          tracking_number: 'PICKUP-REQ-206',
          status: 'pickup_requested',
        }],
        error: null,
      });

    const ds = await import('../data-source');
    const created = await ds.create_pickup_request_v1(payload);

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'create_pickup_request_v1', {
      p_input: payload,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'pickup_requests_list_v1', {
      p_client_id: null,
      p_sender_id: null,
      p_status: null,
      p_limit: 100,
      p_offset: 0,
    });
    expect(created).toMatchObject({
      ok: true,
      shipment_id: '00000000-0000-4000-8000-000000000206',
      tracking_number: 'PICKUP-REQ-206',
    });
  });

  it('fails closed when pickup request creation cannot read back persisted backend state', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          shipment_id: '00000000-0000-4000-8000-000000000216',
          created: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null });

    const ds = await import('../data-source');
    await expect(ds.create_pickup_request_v1({
      organization_id: '00000000-0000-4000-8000-000000000208',
      client_id: '00000000-0000-4000-8000-000000000202',
      requested_window_start_at: '2026-06-02T08:00:00.000Z',
      requested_window_end_at: '2026-06-02T12:00:00.000Z',
    })).rejects.toThrow('create_pickup_request_v1 backend readback missing pickup request');
  });

  it('routes pickup wave create and assignment through canonical api RPC wrappers', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          route_run_id: '00000000-0000-4000-8000-000000000206',
          created: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          route_run_id: '00000000-0000-4000-8000-000000000206',
          status: 'planned',
          driver_user_id: null,
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          route_run_id: '00000000-0000-4000-8000-000000000206',
          driver_user_id: '00000000-0000-4000-8000-000000000207',
          created: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          route_run_id: '00000000-0000-4000-8000-000000000206',
          status: 'planned',
          driver_user_id: '00000000-0000-4000-8000-000000000207',
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{
          id: '00000000-0000-4000-8000-000000000210',
          route_run_id: '00000000-0000-4000-8000-000000000206',
          assignment_status: 'assigned',
          driver_user_id: '00000000-0000-4000-8000-000000000207',
        }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{
          id: '00000000-0000-4000-8000-000000000211',
          route_run_id: '00000000-0000-4000-8000-000000000206',
          event_type: 'assigned',
        }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{
          id: '00000000-0000-4000-8000-000000000212',
          route_run_id: '00000000-0000-4000-8000-000000000206',
        }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{
          id: '00000000-0000-4000-8000-000000000213',
          task_type_key: 'route_stop_execute',
          resource_type: 'route_stop',
          resource_id: '00000000-0000-4000-8000-000000000212',
          assigned_to: '00000000-0000-4000-8000-000000000207',
        }] },
        error: null,
      });

    const ds = await import('../data-source');
    const created = await ds.create_pickup_wave_v1({
      organization_id: '00000000-0000-4000-8000-000000000208',
      shipment_ids: ['00000000-0000-4000-8000-000000000209'],
    });
    const assigned = await ds.assign_pickup_wave_v1('00000000-0000-4000-8000-000000000206', {
      organization_id: '00000000-0000-4000-8000-000000000208',
      driver_user_id: '00000000-0000-4000-8000-000000000207',
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'create_pickup_wave_v1', {
      p_input: {
        organization_id: '00000000-0000-4000-8000-000000000208',
        shipment_ids: ['00000000-0000-4000-8000-000000000209'],
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'pickup_waves_list_v1', {
      p_route_run_ids: ['00000000-0000-4000-8000-000000000206'],
      p_status: null,
      p_limit: 1,
      p_offset: 0,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'assign_pickup_wave_v1', {
      p_input: {
        organization_id: '00000000-0000-4000-8000-000000000208',
        driver_user_id: '00000000-0000-4000-8000-000000000207',
        idempotency_key: 'console-v2:assign_pickup_wave_v1:00000000-0000-4000-8000-000000000206:00000000-0000-4000-8000-000000000207',
        route_run_id: '00000000-0000-4000-8000-000000000206',
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'pickup_waves_list_v1', {
      p_route_run_ids: ['00000000-0000-4000-8000-000000000206'],
      p_status: null,
      p_limit: 1,
      p_offset: 0,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'ui_list_resource_v1', {
      p_resource: 'route_run_assignments',
      p_filters: { route_run_id: '00000000-0000-4000-8000-000000000206' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(6, 'ui_list_resource_v1', {
      p_resource: 'route_run_assignment_events',
      p_filters: { route_run_id: '00000000-0000-4000-8000-000000000206' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(7, 'ui_list_resource_v1', {
      p_resource: 'route_stops',
      p_filters: { route_run_id: '00000000-0000-4000-8000-000000000206' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(8, 'ui_list_resource_v1', {
      p_resource: 'tasks',
      p_filters: {
        task_type_key: 'route_stop_execute',
        resource_type: 'route_stop',
        resource_id: '00000000-0000-4000-8000-000000000212',
      },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(created.wave_id).toBe('00000000-0000-4000-8000-000000000206');
    expect(assigned.wave_id).toBe('00000000-0000-4000-8000-000000000206');
  });

  it('fails closed when pickup wave mutations cannot read back persisted backend state', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: { route_run_id: '00000000-0000-4000-8000-000000000216' },
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({
        data: {
          route_run_id: '00000000-0000-4000-8000-000000000217',
          driver_user_id: '00000000-0000-4000-8000-000000000218',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          route_run_id: '00000000-0000-4000-8000-000000000217',
          driver_user_id: null,
        }],
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.create_pickup_wave_v1({
      organization_id: '00000000-0000-4000-8000-000000000208',
      shipment_ids: ['00000000-0000-4000-8000-000000000209'],
    })).rejects.toThrow('create_pickup_wave_v1 backend readback missing pickup wave');
    await expect(ds.assign_pickup_wave_v1('00000000-0000-4000-8000-000000000217', {
      organization_id: '00000000-0000-4000-8000-000000000208',
      driver_user_id: '00000000-0000-4000-8000-000000000218',
    })).rejects.toThrow('assign_pickup_wave_v1 backend readback did not persist pickup driver assignment');
  });

  it('fails closed when pickup assignment lacks Dispatch assignment readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          route_run_id: '00000000-0000-4000-8000-000000000227',
          driver_user_id: '00000000-0000-4000-8000-000000000228',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          route_run_id: '00000000-0000-4000-8000-000000000227',
          driver_user_id: '00000000-0000-4000-8000-000000000228',
        }],
        error: null,
      })
      .mockResolvedValueOnce({ data: { rows: [] }, error: null });

    const ds = await import('../data-source');
    await expect(ds.assign_pickup_wave_v1('00000000-0000-4000-8000-000000000227', {
      organization_id: '00000000-0000-4000-8000-000000000208',
      driver_user_id: '00000000-0000-4000-8000-000000000228',
    })).rejects.toThrow('assign_pickup_wave_v1 backend readback missing route_run_assignments');
  });

  it('fails closed when Dispatch task readback is not a route-stop execution task', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          route_run_id: '00000000-0000-4000-8000-000000000237',
          driver_user_id: '00000000-0000-4000-8000-000000000238',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          route_run_id: '00000000-0000-4000-8000-000000000237',
          driver_user_id: '00000000-0000-4000-8000-000000000238',
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{
          id: '00000000-0000-4000-8000-000000000239',
          route_run_id: '00000000-0000-4000-8000-000000000237',
          assignment_status: 'assigned',
          driver_user_id: '00000000-0000-4000-8000-000000000238',
        }] },
        error: null,
      })
      .mockResolvedValueOnce({ data: { rows: [{ id: '00000000-0000-4000-8000-000000000240' }] }, error: null })
      .mockResolvedValueOnce({
        data: { rows: [{
          id: '00000000-0000-4000-8000-000000000241',
          route_run_id: '00000000-0000-4000-8000-000000000237',
        }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{
          id: '00000000-0000-4000-8000-000000000242',
          task_type_key: 'dispatch_exception_review',
          resource_type: 'route_stop',
          resource_id: '00000000-0000-4000-8000-000000000241',
          assigned_to: '00000000-0000-4000-8000-000000000238',
        }] },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.assign_pickup_wave_v1('00000000-0000-4000-8000-000000000237', {
      organization_id: '00000000-0000-4000-8000-000000000208',
      driver_user_id: '00000000-0000-4000-8000-000000000238',
    })).rejects.toThrow('assign_pickup_wave_v1 backend readback did not assign Dispatch route-stop task');
  });
});
