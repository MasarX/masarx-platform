import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  schema: vi.fn(),
  invoke: vi.fn(),
  authGetSession: vi.fn(),
}));

vi.mock('../supabase', () => ({
  getSupabaseClient: () => ({
    schema: mocks.schema,
    rpc: mocks.rpc,
    functions: {
      invoke: mocks.invoke,
    },
    auth: {
      getSession: mocks.authGetSession,
    },
  }),
  __resetSupabaseClientForTests: vi.fn(),
  rpc: vi.fn(),
}));

describe('data-source live backend substrate', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.rpc.mockReset();
    mocks.schema.mockReset();
    mocks.invoke.mockReset();
    mocks.authGetSession.mockReset();
    mocks.schema.mockReturnValue({ rpc: mocks.rpc });
    mocks.authGetSession.mockResolvedValue({ data: { session: { access_token: 'test' } } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('routes generic resource reads through the api schema RPC and normalizes rows', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        items: [{ id: '00000000-0000-4000-8000-000000000001', status: 'created' }],
        total: 1,
        limit: 25,
        offset: 50,
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.ui_list_resource_v1('shipments', {
      filter: { status: 'created' },
      sort: { key: 'created_at', dir: 'desc' },
      page: 2,
      page_size: 25,
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'shipments',
      p_filters: { status: 'created' },
      p_limit: 25,
      p_offset: 50,
      p_sort: { key: 'created_at', direction: 'desc' },
    });
    expect(result.rows).toEqual([{ id: '00000000-0000-4000-8000-000000000001', status: 'created' }]);
    expect(result.total).toBe(1);
    expect(result.page).toBe(2);
  });

  it('keeps modify audit source outside shipment changes for amend/cancel RPCs', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          workflow_template: 'shipment_modify_v1',
          workflow_run_id: '00000000-0000-4000-8000-000000000601',
          shipment_action_id: '00000000-0000-4000-8000-000000000602',
          started_via: 'start_workflow_run',
          canonical_entrypoint: 'progress_workflow_run',
          dry_run: false,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000600', tracking_number: 'SHP-AMEND-001' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000600', tracking_number: 'SHP-AMEND-001' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000602', action_type: 'shipment_modified' },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.shipment_amend_cancel_v1(
      '00000000-0000-4000-8000-000000000600',
      'modify',
      {
        carrier_reference_number: 'CARRIER-LIVE-2355',
        source: 'console_v2.shipments.amend_modal',
      },
      { dryRun: false },
    );

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'shipment_amend_cancel_v1', {
      p_input: {
        shipment_id: '00000000-0000-4000-8000-000000000600',
        operation: 'modify',
        surface: 'console',
        dry_run: false,
        source: 'console_v2.shipments.amend_modal',
        changes: {
          carrier_reference_number: 'CARRIER-LIVE-2355',
        },
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'shipments',
      p_id: '00000000-0000-4000-8000-000000000600',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'shipment_directory',
      p_id: '00000000-0000-4000-8000-000000000600',
    });
  });

  it('routes tabular import run detail reads through the dedicated details RPC', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000221',
        status: 'completed',
        rows: [
          {
            row_number: 1,
            target_record_id: '00000000-0000-4000-8000-000000000222',
            related_nodes: [
              {
                target_resource: 'recipients',
                target_record_id: '00000000-0000-4000-8000-000000000223',
              },
            ],
          },
        ],
        report: { id: '00000000-0000-4000-8000-000000000224' },
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.ui_get_resource_v1('tabular_import_runs', '00000000-0000-4000-8000-000000000221');

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_tabular_import_run_v1', {
      p_run_id: '00000000-0000-4000-8000-000000000221',
    });
    expect(result).toMatchObject({
      id: '00000000-0000-4000-8000-000000000221',
      rows: [
        expect.objectContaining({
          target_record_id: '00000000-0000-4000-8000-000000000222',
          related_nodes: [
            expect.objectContaining({ target_resource: 'recipients' }),
          ],
        }),
      ],
      report: { id: '00000000-0000-4000-8000-000000000224' },
    });
  });

  it('paginates complete generic resource reads until the backend total is reached', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          rows: [
            { id: '00000000-0000-4000-8000-000000000101' },
            { id: '00000000-0000-4000-8000-000000000102' },
          ],
          total: 3,
          limit: 2,
          offset: 0,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{ id: '00000000-0000-4000-8000-000000000103' }],
          total: 3,
          limit: 2,
          offset: 2,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_list_resource_complete('shipments', {
      page_size: 2,
      sort: { key: 'created_at', dir: 'desc' },
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_list_resource_v1', {
      p_resource: 'shipments',
      p_filters: {},
      p_limit: 2,
      p_offset: 0,
      p_sort: { key: 'created_at', direction: 'desc' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_list_resource_v1', {
      p_resource: 'shipments',
      p_filters: {},
      p_limit: 2,
      p_offset: 2,
      p_sort: { key: 'created_at', direction: 'desc' },
    });
    expect(result.rows.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000103',
    ]);
    expect(result.total).toBe(3);
  });

  it('fails closed when complete generic resource reads stop before backend total', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          rows: [
            { id: '00000000-0000-4000-8000-000000000111' },
            { id: '00000000-0000-4000-8000-000000000112' },
          ],
          total: 3,
          limit: 2,
          offset: 0,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [],
          total: 3,
          limit: 2,
          offset: 2,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(
      ds.ui_list_resource_complete('users', {
        page_size: 2,
        sort: { key: 'created_at', dir: 'desc' },
      }),
    ).rejects.toThrow(/ui_list_resource_complete\(users\) readback incomplete/i);

    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_list_resource_v1', {
      p_resource: 'users',
      p_filters: {},
      p_limit: 2,
      p_offset: 2,
      p_sort: { key: 'created_at', direction: 'desc' },
    });
  });

  it('fails closed when complete generic resource reads collect a non-empty but incomplete final page', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          rows: [
            { id: '00000000-0000-4000-8000-000000000121' },
            { id: '00000000-0000-4000-8000-000000000122' },
          ],
          total: 4,
          limit: 2,
          offset: 0,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{ id: '00000000-0000-4000-8000-000000000123' }],
          total: 4,
          limit: 2,
          offset: 2,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(
      ds.ui_list_resource_complete('rbac_roles', {
        page_size: 2,
      }),
    ).rejects.toThrow(/ui_list_resource_complete\(rbac_roles\) readback incomplete: received 3 of 4 rows/i);
  });

  it('requires client row and client-summary readback after live client create', async () => {
    const clientId = '00000000-0000-4000-8000-000000000301';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          client_id: clientId,
          correlation_id: 'cor_client_create',
          settings_resolution_id: 'srlv_client_create',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: clientId, name: 'Backend Client' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { client_id: clientId, name: 'Backend Client', sender_count: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.client_create_v1({ name: 'Backend Client', slug: 'backend-client' });

    expect(result.client_id).toBe(clientId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'client_create_v1', {
      p_args: { name: 'Backend Client', slug: 'backend-client' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'clients',
      p_id: clientId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'client_summary',
      p_id: clientId,
    });
  });

  it('requires sender row and sender-summary readback after live sender update', async () => {
    const senderId = '00000000-0000-4000-8000-000000000302';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          sender_id: senderId,
          idempotent_no_op: false,
          correlation_id: 'cor_sender_update',
          settings_resolution_id: 'srlv_sender_update',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: senderId, name: 'Backend Sender' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { sender_id: senderId, name: 'Backend Sender', active_shipments: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.sender_update_v1({ sender_id: senderId, name: 'Backend Sender' });

    expect(result.sender_id).toBe(senderId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'senders',
      p_id: senderId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'sender_summary',
      p_id: senderId,
    });
  });

  it('requires recipient row and recipient-directory readback after live recipient create', async () => {
    const recipientId = '00000000-0000-4000-8000-000000000303';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          recipient_id: recipientId,
          correlation_id: 'cor_recipient_create',
          settings_resolution_id: 'srlv_recipient_create',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: recipientId, name: 'Backend Recipient', phone_number: '+12025550123' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { recipient_id: recipientId, name: 'Backend Recipient', phone_number: '+12025550123' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.recipient_create_v1({
      client_id: '00000000-0000-4000-8000-000000000304',
      name: 'Backend Recipient',
      phone_number: '+12025550123',
    });

    expect(result.recipient_id).toBe(recipientId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'recipients',
      p_id: recipientId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'recipient_directory',
      p_id: recipientId,
    });
  });

  it('fails closed when live recipient update lacks directory readback', async () => {
    const recipientId = '00000000-0000-4000-8000-000000000305';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          recipient_id: recipientId,
          idempotent_no_op: false,
          correlation_id: 'cor_recipient_update',
          settings_resolution_id: 'srlv_recipient_update',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: recipientId, name: 'Backend Recipient' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.recipient_update_v1({
      recipient_id: recipientId,
      name: 'Updated Recipient',
    })).rejects.toThrow(`recipient_update_v1 backend readback missing recipient_directory:${recipientId}`);
  });

  it('requires recipient base and directory absence after live recipient delete', async () => {
    const recipientId = '00000000-0000-4000-8000-000000000306';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          recipient_id: recipientId,
          deleted: true,
          correlation_id: 'cor_recipient_delete',
          settings_resolution_id: 'srlv_recipient_delete',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { items: [], total: 0, limit: 25, offset: 0 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { items: [], total: 0, limit: 25, offset: 0 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ id: 'dec_recipient_delete', resource_type: 'recipient', resource_id: recipientId }],
          total: 1,
          limit: 25,
          offset: 0,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.recipient_delete_v1({
      recipient_id: recipientId,
      reason: 'duplicate contact',
    });

    expect(result.recipient_id).toBe(recipientId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_list_resource_v1', {
      p_resource: 'recipients',
      p_filters: { id: recipientId },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_list_resource_v1', {
      p_resource: 'recipient_directory',
      p_filters: { recipient_id: recipientId },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_list_resource_v1', {
      p_resource: 'decision_log',
      p_filters: { resource_type: 'recipient', resource_id: recipientId },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
  });

  it('fails closed when live recipient delete still appears in recipient directory', async () => {
    const recipientId = '00000000-0000-4000-8000-000000000307';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          recipient_id: recipientId,
          deleted: true,
          correlation_id: 'cor_recipient_delete_stale',
          settings_resolution_id: 'srlv_recipient_delete_stale',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { items: [], total: 0, limit: 25, offset: 0 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ recipient_id: recipientId, name: 'Stale Recipient' }],
          total: 1,
          limit: 25,
          offset: 0,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.recipient_delete_v1({
      recipient_id: recipientId,
      reason: 'duplicate contact',
    })).rejects.toThrow(`recipient_delete_v1 backend readback still lists recipient_directory:${recipientId}`);
  });

  it('fails closed when live recipient delete still appears in base recipients', async () => {
    const recipientId = '00000000-0000-4000-8000-000000000308';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          recipient_id: recipientId,
          deleted: true,
          correlation_id: 'cor_recipient_delete_base_stale',
          settings_resolution_id: 'srlv_recipient_delete_base_stale',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ id: recipientId, name: 'Stale Base Recipient' }],
          total: 1,
          limit: 25,
          offset: 0,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.recipient_delete_v1({
      recipient_id: recipientId,
      reason: 'duplicate contact',
    })).rejects.toThrow(`recipient_delete_v1 backend readback still lists recipients:${recipientId}`);
  });

  it('fails closed when live recipient delete lacks decision log readback', async () => {
    const recipientId = '00000000-0000-4000-8000-000000000309';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          recipient_id: recipientId,
          deleted: true,
          correlation_id: 'cor_recipient_delete_no_decision',
          settings_resolution_id: 'srlv_recipient_delete_no_decision',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { items: [], total: 0, limit: 25, offset: 0 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { items: [], total: 0, limit: 25, offset: 0 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { items: [], total: 0, limit: 25, offset: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.recipient_delete_v1({
      recipient_id: recipientId,
      reason: 'duplicate contact',
    })).rejects.toThrow('recipient_delete_v1 backend readback missing decision_log');
  });

  it('routes trace lookup through the live api schema RPC and requires backend trace evidence', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        trace: {
          correlation_id: '00000000-0000-4000-8000-000000000201',
          observability_events: [{ event_id: '00000000-0000-4000-8000-000000000202' }],
          domain_events: [{ id: '00000000-0000-4000-8000-000000000203' }],
          workflow_runs: [{ id: '00000000-0000-4000-8000-000000000204' }],
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.ui_get_trace_v1('00000000-0000-4000-8000-000000000201');

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_trace_v2', {
      p_args: { correlation_id: '00000000-0000-4000-8000-000000000201' },
    });
    expect(result).toEqual({
      correlation_id: '00000000-0000-4000-8000-000000000201',
      observability_events: [{ event_id: '00000000-0000-4000-8000-000000000202' }],
      domain_events: [{ id: '00000000-0000-4000-8000-000000000203' }],
      workflow_runs: [{ id: '00000000-0000-4000-8000-000000000204' }],
    });
  });

  it('fails closed when live trace lookup omits the backend trace envelope', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        correlation_id: '00000000-0000-4000-8000-000000000201',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.ui_get_trace_v1('00000000-0000-4000-8000-000000000201')).rejects.toThrow(
      'backend trace evidence',
    );
  });

  it('routes decision log reads through the live registry instead of seed data', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        rows: [{
          id: '00000000-0000-4000-8000-000000000006',
          decision_category: 'shipment.amend',
          decision_outcome: 'approved',
        }],
        total: 1,
      },
      error: null,
    });

    const ds = await import('../data-source');
    const rows = await ds.listDecisionLog({ category: 'shipment.amend', limit: 10 });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'decision_log',
      p_filters: { decision_category: 'shipment.amend' },
      p_limit: 10,
      p_offset: 0,
      p_sort: { key: 'timestamp', direction: 'desc' },
    });
    expect(rows).toEqual([{
      id: '00000000-0000-4000-8000-000000000006',
      decision_category: 'shipment.amend',
      decision_outcome: 'approved',
    }]);
  });

  it('uses the capability-asserted workflow start wrapper in live mode', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          status: 'workflow_started',
          workflow_template_id: '00000000-0000-4000-8000-000000000010',
          workflow_run_id: '00000000-0000-4000-8000-000000000011',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000011', status: 'running' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{ id: '00000000-0000-4000-8000-000000000012', workflow_run_id: '00000000-0000-4000-8000-000000000011' }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.start_workflow_run('00000000-0000-4000-8000-000000000010', {
      ui: { allow_inactive: true, dry_run: true },
      payload: { sample: true },
    });

    expect(mocks.rpc).toHaveBeenCalledWith('ui_start_workflow_run_v1', {
      p_workflow_template_id: '00000000-0000-4000-8000-000000000010',
      p_payload: { ui: { allow_inactive: true, dry_run: true }, payload: { sample: true } },
      p_require_active: false,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_runs',
      p_id: '00000000-0000-4000-8000-000000000011',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'workflow_run_steps',
      p_filters: { workflow_run_id: '00000000-0000-4000-8000-000000000011' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(result.workflow_run_id).toBe('00000000-0000-4000-8000-000000000011');
    expect(result.canonical_entrypoint).toBe('progress_workflow_run');
  });

  it('fails closed when workflow start lacks run step readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          status: 'workflow_started',
          workflow_template_id: '00000000-0000-4000-8000-000000000010',
          workflow_run_id: '00000000-0000-4000-8000-000000000011',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000011', status: 'running' },
        error: null,
      })
      .mockResolvedValueOnce({ data: { rows: [], total: 0 }, error: null });

    const ds = await import('../data-source');
    await expect(ds.start_workflow_run('00000000-0000-4000-8000-000000000010', {})).rejects.toThrow(
      'ui_start_workflow_run_v1 backend readback missing workflow_run_steps',
    );
  });

  it('requires workflow run and step readback after closing a live workflow run', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000011',
          workflow_status: 'cancelled',
          completed_at: '2026-05-08T08:00:00.000Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{ id: '00000000-0000-4000-8000-000000000012', workflow_run_id: '00000000-0000-4000-8000-000000000011' }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.close_workflow_run('00000000-0000-4000-8000-000000000011', 'cancelled');

    expect(mocks.rpc).toHaveBeenCalledWith('close_workflow_run', {
      p_workflow_run_id: '00000000-0000-4000-8000-000000000011',
      p_status: 'cancelled',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_runs',
      p_id: '00000000-0000-4000-8000-000000000011',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'workflow_run_steps',
      p_filters: { workflow_run_id: '00000000-0000-4000-8000-000000000011' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(result).toEqual({
      ok: true,
      workflow_run_id: '00000000-0000-4000-8000-000000000011',
      workflow_status: 'cancelled',
      closed_at: '2026-05-08T08:00:00.000Z',
    });
  });

  it('fails closed when workflow close lacks run-step readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000011', workflow_status: 'cancelled' },
        error: null,
      })
      .mockResolvedValueOnce({ data: { rows: [], total: 0 }, error: null });

    const ds = await import('../data-source');
    await expect(ds.close_workflow_run('00000000-0000-4000-8000-000000000011', 'cancelled')).rejects.toThrow(
      'close_workflow_run backend readback missing workflow_run_steps',
    );
  });

  it('requires ops_alerts row readback after acknowledging a live ops alert', async () => {
    const alertId = '00000000-0000-4000-8000-000000000701';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          ops_alert_id: alertId,
          acknowledged_at: '2026-05-20T08:10:00.000Z',
          correlation_id: '00000000-0000-4000-8000-000000000702',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: alertId,
          acknowledged_at: '2026-05-20T08:10:00.000Z',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.acknowledge_ops_alert_v1({ ops_alert_id: alertId });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'acknowledge_ops_alert_v1', {
      p_args: { ops_alert_id: alertId },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'ops_alerts',
      p_id: alertId,
    });
    expect(result.ops_alert_id).toBe(alertId);
  });

  it('fails closed when acknowledged ops alert readback is stale', async () => {
    const alertId = '00000000-0000-4000-8000-000000000703';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          ops_alert_id: alertId,
          acknowledged_at: '2026-05-20T08:10:00.000Z',
          correlation_id: '00000000-0000-4000-8000-000000000704',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: alertId,
          acknowledged_at: null,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.acknowledge_ops_alert_v1({ ops_alert_id: alertId })).rejects.toThrow(
      `acknowledge_ops_alert_v1 backend readback missing acknowledged_at for ops_alerts:${alertId}`,
    );
  });

  it('requires ops_alerts row readback after resolving a live ops alert', async () => {
    const alertId = '00000000-0000-4000-8000-000000000705';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          ops_alert_id: alertId,
          resolved_at: '2026-05-20T08:20:00.000Z',
          correlation_id: '00000000-0000-4000-8000-000000000706',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: alertId,
          resolved_at: '2026-05-20T08:20:00.000Z',
          resolution_notes: 'backend confirmed',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.resolve_ops_alert_v1({
      ops_alert_id: alertId,
      resolution_notes: 'backend confirmed',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'resolve_ops_alert_v1', {
      p_args: { ops_alert_id: alertId, resolution_notes: 'backend confirmed' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'ops_alerts',
      p_id: alertId,
    });
    expect(result.ops_alert_id).toBe(alertId);
  });

  it('fails closed when resolved ops alert readback has stale notes', async () => {
    const alertId = '00000000-0000-4000-8000-000000000707';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          ops_alert_id: alertId,
          resolved_at: '2026-05-20T08:20:00.000Z',
          correlation_id: '00000000-0000-4000-8000-000000000708',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: alertId,
          resolved_at: '2026-05-20T08:20:00.000Z',
          resolution_notes: 'old note',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.resolve_ops_alert_v1({
      ops_alert_id: alertId,
      resolution_notes: 'backend confirmed',
    })).rejects.toThrow(
      `resolve_ops_alert_v1 backend readback resolution_notes mismatch for ops_alerts:${alertId}`,
    );
  });

  it('requires persisted capability grant request readback after an access request', async () => {
    const requestId = '00000000-0000-4000-8000-000000000711';
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        capability_grant_request_id: requestId,
        status: 'pending',
        correlation_id: '00000000-0000-4000-8000-000000000712',
        request_readback: {
          id: requestId,
          capability_key: 'shipments.write',
          scope_type: 'tenant',
          scope_id: '00000000-0000-4000-8000-000000000713',
          reason: 'Backend readback access request proof.',
          duration_hours: 4,
          status: 'pending',
          correlation_id: '00000000-0000-4000-8000-000000000712',
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.request_capability_grant_v1({
      capability_key: 'shipments.write',
      scope_type: 'tenant',
      scope_id: '00000000-0000-4000-8000-000000000713',
      duration_hours: 4,
      reason: 'Backend readback access request proof.',
    });

    expect(mocks.rpc).toHaveBeenCalledWith('request_capability_grant_v1', {
      p_args: {
        capability_key: 'shipments.write',
        scope_type: 'tenant',
        scope_id: '00000000-0000-4000-8000-000000000713',
        duration_hours: 4,
        reason: 'Backend readback access request proof.',
      },
    });
    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(result.capability_grant_request_id).toBe(requestId);
  });

  it('fails closed when an access request omits persisted request readback', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        capability_grant_request_id: '00000000-0000-4000-8000-000000000714',
        status: 'pending',
        correlation_id: '00000000-0000-4000-8000-000000000715',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.request_capability_grant_v1({
      capability_key: 'shipments.write',
      scope_type: 'tenant',
      reason: 'Missing readback should fail.',
    })).rejects.toThrow('request_capability_grant_v1 did not return capability_grant_requests readback');
  });

  it('fails closed when access request readback belongs to a different capability', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        capability_grant_request_id: '00000000-0000-4000-8000-000000000716',
        status: 'pending',
        correlation_id: '00000000-0000-4000-8000-000000000717',
        request_readback: {
          id: '00000000-0000-4000-8000-000000000716',
          capability_key: 'shipments.read',
          scope_type: 'tenant',
          reason: 'Wrong capability readback.',
          status: 'pending',
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.request_capability_grant_v1({
      capability_key: 'shipments.write',
      scope_type: 'tenant',
      reason: 'Wrong capability readback.',
    })).rejects.toThrow('request_capability_grant_v1 backend readback mismatch for capability_key');
  });

  it('fails closed when access request readback belongs to a different request id', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        capability_grant_request_id: '00000000-0000-4000-8000-000000000718',
        status: 'pending',
        correlation_id: '00000000-0000-4000-8000-000000000719',
        request_readback: {
          id: '00000000-0000-4000-8000-000000000720',
          capability_key: 'shipments.write',
          scope_type: 'tenant',
          reason: 'Mismatched request id.',
          status: 'pending',
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.request_capability_grant_v1({
      capability_key: 'shipments.write',
      scope_type: 'tenant',
      reason: 'Mismatched request id.',
    })).rejects.toThrow('request_capability_grant_v1 backend readback request id mismatch');
  });

  it('requires persisted capability grant review readback and backend row confirmation', async () => {
    const requestId = '00000000-0000-4000-8000-000000000721';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          capability_grant_request_id: requestId,
          status: 'approved',
          decision: 'approved',
          correlation_id: '00000000-0000-4000-8000-000000000722',
          rbac_role_id: '00000000-0000-4000-8000-000000000723',
          rbac_role_permission_id: '00000000-0000-4000-8000-000000000724',
          rbac_user_role_assignment_id: '00000000-0000-4000-8000-000000000725',
          request_readback: {
            id: requestId,
            capability_key: 'shipments.write',
            status: 'approved',
            decision_notes: 'Approved from live adapter test.',
            correlation_id: '00000000-0000-4000-8000-000000000722',
            approved_role_id: '00000000-0000-4000-8000-000000000723',
            approved_permission_id: '00000000-0000-4000-8000-000000000724',
            approved_assignment_id: '00000000-0000-4000-8000-000000000725',
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: requestId,
          status: 'approved',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_review_capability_grant_request_v1({
      request_id: requestId,
      decision: 'approve',
      decision_notes: 'Approved from live adapter test.',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_review_capability_grant_request_v1', {
      p_args: {
        request_id: requestId,
        decision: 'approve',
        decision_notes: 'Approved from live adapter test.',
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'capability_grant_requests',
      p_id: requestId,
    });
    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(result.capability_grant_request_id).toBe(requestId);
  });

  it('fails closed when reviewed access request backend row status is stale', async () => {
    const requestId = '00000000-0000-4000-8000-000000000726';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          capability_grant_request_id: requestId,
          status: 'approved',
          decision: 'approved',
          correlation_id: '00000000-0000-4000-8000-000000000727',
          rbac_role_id: '00000000-0000-4000-8000-000000000728',
          rbac_user_role_assignment_id: '00000000-0000-4000-8000-000000000729',
          request_readback: {
            id: requestId,
            status: 'approved',
            correlation_id: '00000000-0000-4000-8000-000000000727',
            approved_role_id: '00000000-0000-4000-8000-000000000728',
            approved_assignment_id: '00000000-0000-4000-8000-000000000729',
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: requestId,
          status: 'pending',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_review_capability_grant_request_v1({
      request_id: requestId,
      decision: 'approved',
    })).rejects.toThrow('ui_review_capability_grant_request_v1 backend resource readback status mismatch');
  });

  it('routes bank statement ingestion through the browser-safe api RPC', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          finance_event_id: '00000000-0000-4000-8000-000000000021',
          created: true,
          correlation_id: '00000000-0000-4000-8000-000000000022',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', amount: 125.75 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', bank_account_id: '00000000-0000-4000-8000-000000000020' },
        error: null,
      });

    const ds = await import('../data-source');
    const payload = {
      bank_account_id: '00000000-0000-4000-8000-000000000020',
      bank_account_key: 'ncb-ruh-001',
      direction: 'in',
      amount: 125.75,
      currency: 'SAR',
      occurred_at: '2026-05-03T08:30:00.000Z',
      idempotency_key: 'bank_statement:00000000-0000-4000-8000-000000000020:stmt-1',
      metadata: { statement_reference: 'stmt-1' },
    };

    const result = await ds.ui_record_bank_statement_event_v1(payload);

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_record_bank_statement_event_v1', {
      p_args: payload,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'finance_events_ledger',
      p_id: '00000000-0000-4000-8000-000000000021',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'finance_events_bank_statement',
      p_id: '00000000-0000-4000-8000-000000000021',
    });
    expect(result).toMatchObject({
      ok: true,
      finance_event_id: '00000000-0000-4000-8000-000000000021',
      created: true,
    });
  });

  it('fails closed when bank statement ingestion lacks bank-statement projection readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          finance_event_id: '00000000-0000-4000-8000-000000000021',
          created: true,
          correlation_id: '00000000-0000-4000-8000-000000000022',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', amount: 125.75 },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_record_bank_statement_event_v1({
      bank_account_id: '00000000-0000-4000-8000-000000000020',
      direction: 'in',
      amount: 125.75,
      currency: 'SAR',
      occurred_at: '2026-05-03T08:30:00.000Z',
      idempotency_key: 'bank_statement:missing-projection',
    })).rejects.toThrow('ui_record_bank_statement_event_v1 backend readback missing finance_events_bank_statement');
  });

  it('routes bank account setup through the browser-safe api RPC with readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          bank_account_id: '00000000-0000-4000-8000-000000000031',
          key: 'main-clearing',
          organization_id: '00000000-0000-4000-8000-000000000032',
          correlation_id: '00000000-0000-4000-8000-000000000033',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000031', key: 'main-clearing' },
        error: null,
      });

    const ds = await import('../data-source');
    const payload = {
      key: 'main-clearing',
      name: 'Main Clearing Account',
      bank_name: 'Saudi Bank',
      currency: 'SAR',
      iban_last4: '1234',
      account_last4: '9876',
      metadata: { source: 'console_v2_bank_recon_setup' },
    };

    const result = await ds.ui_create_bank_account_v1(payload);

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_create_bank_account_v1', {
      p_args: payload,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'bank_accounts',
      p_id: '00000000-0000-4000-8000-000000000031',
    });
    expect(result).toMatchObject({
      ok: true,
      bank_account_id: '00000000-0000-4000-8000-000000000031',
      key: 'main-clearing',
    });
  });

  it('requires bank recon match and finance ledger readback after matching', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          bank_recon_match_id: '00000000-0000-4000-8000-000000000023',
          finance_event_id: '00000000-0000-4000-8000-000000000021',
          correlation_id: '00000000-0000-4000-8000-000000000024',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000023', status: 'matched' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', reconciliation_status: 'matched' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.bank_recon_match_v1({
      bank_statement_event_id: '00000000-0000-4000-8000-000000000021',
      bank_statement_occurred_at: '2026-05-03T08:30:00.000Z',
      resource_type: 'settlement_batch',
      resource_id: '00000000-0000-4000-8000-000000000025',
      matched_amount: 125.75,
      currency: 'SAR',
    });

    expect(result).toMatchObject({ bank_recon_match_id: '00000000-0000-4000-8000-000000000023' });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'bank_recon_matches',
      p_id: '00000000-0000-4000-8000-000000000023',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'finance_events_ledger',
      p_id: '00000000-0000-4000-8000-000000000021',
    });
  });

  it('fails closed when bank recon match lacks match readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          bank_recon_match_id: '00000000-0000-4000-8000-000000000023',
          correlation_id: '00000000-0000-4000-8000-000000000024',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.bank_recon_match_v1({
      bank_statement_event_id: '00000000-0000-4000-8000-000000000021',
      bank_statement_occurred_at: '2026-05-03T08:30:00.000Z',
      resource_type: 'settlement_batch',
      resource_id: '00000000-0000-4000-8000-000000000025',
      matched_amount: 125.75,
      currency: 'SAR',
    })).rejects.toThrow('bank_recon_match_v1 backend readback missing bank_recon_matches');
  });

  it('requires settlement readback when a settlement mutation returns only id', async () => {
    const settlementBatchId = '00000000-0000-4000-8000-000000000072';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          id: settlementBatchId,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: settlementBatchId, status: 'counting' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: settlementBatchId, status: 'counting', expected_amount: 120 },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_create_settlement_batch_v1({
      scope_type: 'driver_shift',
      idempotency_key: 'settlement-id-only',
    });

    expect(result).toMatchObject({
      ok: true,
      id: settlementBatchId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'settlement_batches',
      p_id: settlementBatchId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'settlement_batch_summary',
      p_id: settlementBatchId,
    });
  });

  it('requires settlement, COD entry, and finance ledger readback after COD adjustment', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          finance_event_id: '00000000-0000-4000-8000-000000000071',
          settlement_batch_id: '00000000-0000-4000-8000-000000000072',
          cod_entry_id: '00000000-0000-4000-8000-000000000073',
          correlation_id: '00000000-0000-4000-8000-000000000074',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000072', status: 'counting' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000072', status: 'counting', expected_amount: 120 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000071', amount: 5, direction: 'out' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000073', settlement_batch_id: '00000000-0000-4000-8000-000000000072' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_adjust_cod_collection_v1({
      cod_entry_id: '00000000-0000-4000-8000-000000000073',
      settlement_batch_id: '00000000-0000-4000-8000-000000000072',
      adjustment_amount: 5,
      reason: 'cashier_variance',
    });

    expect(result).toMatchObject({
      ok: true,
      finance_event_id: '00000000-0000-4000-8000-000000000071',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'settlement_batches',
      p_id: '00000000-0000-4000-8000-000000000072',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'settlement_batch_summary',
      p_id: '00000000-0000-4000-8000-000000000072',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'finance_events_ledger',
      p_id: '00000000-0000-4000-8000-000000000071',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'cod_entries',
      p_id: '00000000-0000-4000-8000-000000000073',
    });
  });

  it('fails closed when COD adjustment lacks finance ledger readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          finance_event_id: '00000000-0000-4000-8000-000000000071',
          settlement_batch_id: '00000000-0000-4000-8000-000000000072',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000072', status: 'counting' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000072', status: 'counting' },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_adjust_cod_collection_v1({
      settlement_batch_id: '00000000-0000-4000-8000-000000000072',
      adjustment_amount: 5,
      reason: 'cashier_variance',
    })).rejects.toThrow('ui_adjust_cod_collection_v1 backend readback missing finance_events_ledger');
  });

  it('fails closed when a closeout mutation returns only id without finance ledger readback', async () => {
    const reversalEventId = '00000000-0000-4000-8000-000000000075';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          id: reversalEventId,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_reverse_finance_event_v1({
      finance_event_id: '00000000-0000-4000-8000-000000000076',
      reason: 'cashier correction',
    })).rejects.toThrow(`ui_reverse_finance_event_v1 backend readback missing finance_events_ledger:${reversalEventId}`);
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'finance_events_ledger',
      p_id: reversalEventId,
    });
  });

  it('routes workflow schedule run-now through the canonical api RPC', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: 'workflow_started',
        workflow_schedule_trigger_id: '00000000-0000-4000-8000-000000000012',
        workflow_template_id: '00000000-0000-4000-8000-000000000010',
        workflow_run_id: '00000000-0000-4000-8000-000000000011',
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000012',
        last_run_id: '00000000-0000-4000-8000-000000000011',
        last_run_at: '2026-05-23T01:50:00.000Z',
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000011',
        workflow_template_id: '00000000-0000-4000-8000-000000000010',
        workflow_status: 'pending',
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        rows: [
          {
            id: '00000000-0000-4000-8000-000000000011',
            workflow_template_id: '00000000-0000-4000-8000-000000000010',
            workflow_status: 'pending',
          },
        ],
        total: 1,
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.ui_run_workflow_schedule_trigger_v1(
      '00000000-0000-4000-8000-000000000012',
    );

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_run_workflow_schedule_trigger_v1', {
      p_workflow_schedule_trigger_id: '00000000-0000-4000-8000-000000000012',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_schedule_triggers',
      p_id: '00000000-0000-4000-8000-000000000012',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_runs',
      p_id: '00000000-0000-4000-8000-000000000011',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'workflow_run_directory',
      p_filters: { id: '00000000-0000-4000-8000-000000000011' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(result).toMatchObject({
      ok: true,
      workflow_run_id: '00000000-0000-4000-8000-000000000011',
      last_run_at: '2026-05-23T01:50:00.000Z',
    });
  });

  it('creates workflow schedules through the canonical api RPC and requires schedule readback', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: 'ok',
        workflow_schedule_trigger_id: '00000000-0000-4000-8000-000000000012',
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000012',
        workflow_template_id: '00000000-0000-4000-8000-000000000010',
        schedule: { type: 'interval', interval_seconds: 900 },
        context_patch: { branch: 'rh_jed' },
        scope_type: 'tenant',
        scope_id: '00000000-0000-4000-8000-000000000013',
        enabled: true,
        next_run_at: '2026-05-24T02:15:00.000Z',
        notes: 'operator schedule proof',
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.ui_create_workflow_schedule_trigger_v1({
      workflow_template_id: '00000000-0000-4000-8000-000000000010',
      schedule: { type: 'interval', interval_seconds: 900 },
      context_patch: { branch: 'rh_jed' },
      enabled: true,
      notes: 'operator schedule proof',
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_create_workflow_schedule_trigger_v1', {
      p_workflow_template_id: '00000000-0000-4000-8000-000000000010',
      p_schedule: { type: 'interval', interval_seconds: 900 },
      p_context_patch: { branch: 'rh_jed' },
      p_enabled: true,
      p_notes: 'operator schedule proof',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_schedule_triggers',
      p_id: '00000000-0000-4000-8000-000000000012',
    });
    expect(result).toMatchObject({
      ok: true,
      workflow_schedule_trigger_id: '00000000-0000-4000-8000-000000000012',
      workflow_template_id: '00000000-0000-4000-8000-000000000010',
      enabled: true,
      next_run_at: '2026-05-24T02:15:00.000Z',
      context_patch: { branch: 'rh_jed' },
      notes: 'operator schedule proof',
    });
  });

  it('fails workflow schedule creation when backend readback does not match the template', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: 'ok',
        workflow_schedule_trigger_id: '00000000-0000-4000-8000-000000000012',
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000012',
        workflow_template_id: '00000000-0000-4000-8000-000000000099',
        schedule: { type: 'interval', interval_seconds: 900 },
        enabled: true,
        next_run_at: '2026-05-24T02:15:00.000Z',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.ui_create_workflow_schedule_trigger_v1({
      workflow_template_id: '00000000-0000-4000-8000-000000000010',
      schedule: { type: 'interval', interval_seconds: 900 },
      context_patch: {},
      enabled: true,
    })).rejects.toThrow(
      'ui_create_workflow_schedule_trigger_v1 backend readback did not match workflow_template_id',
    );
  });

  it('requires live readback for workflow run trigger update and delete lifecycle RPCs', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: 'updated',
        workflow_run_trigger_id: '00000000-0000-4000-8000-000000000020',
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000020',
        source_workflow_template_id: '00000000-0000-4000-8000-000000000021',
        target_workflow_template_id: '00000000-0000-4000-8000-000000000022',
        source_statuses: ['succeeded'],
        context_patch: { handoff: 'updated' },
        scope_type: 'tenant',
        scope_id: '00000000-0000-4000-8000-000000000023',
        enabled: false,
        notes: 'updated trigger',
        updated_at: '2026-06-01T11:00:00.000Z',
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        status: 'deleted',
        workflow_run_trigger_id: '00000000-0000-4000-8000-000000000020',
        source_workflow_template_id: '00000000-0000-4000-8000-000000000021',
        target_workflow_template_id: '00000000-0000-4000-8000-000000000022',
        scope_type: 'tenant',
        scope_id: '00000000-0000-4000-8000-000000000023',
        enabled: false,
        deleted_at: '2026-06-01T11:05:00.000Z',
        workflow_trigger_fires_count: 2,
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000020',
        source_workflow_template_id: '00000000-0000-4000-8000-000000000021',
        target_workflow_template_id: '00000000-0000-4000-8000-000000000022',
        source_statuses: ['succeeded'],
        context_patch: { handoff: 'updated' },
        scope_type: 'tenant',
        scope_id: '00000000-0000-4000-8000-000000000023',
        enabled: false,
        deleted_at: '2026-06-01T11:05:00.000Z',
        notes: 'updated trigger',
        updated_at: '2026-06-01T11:05:00.000Z',
      },
      error: null,
    });

    const ds = await import('../data-source');
    const updateResult = await ds.ui_update_workflow_run_trigger_v1({
      workflow_run_trigger_id: '00000000-0000-4000-8000-000000000020',
      source_workflow_template_id: '00000000-0000-4000-8000-000000000021',
      target_workflow_template_id: '00000000-0000-4000-8000-000000000022',
      source_statuses: ['succeeded'],
      context_patch: { handoff: 'updated' },
      enabled: false,
      notes: 'updated trigger',
      scope_id: '00000000-0000-4000-8000-000000000023',
    });
    const deleteResult = await ds.ui_delete_workflow_run_trigger_v1(
      '00000000-0000-4000-8000-000000000020',
      '00000000-0000-4000-8000-000000000023',
    );

    expect(mocks.rpc).toHaveBeenCalledWith('ui_update_workflow_run_trigger_v1', {
      p_workflow_run_trigger_id: '00000000-0000-4000-8000-000000000020',
      p_source_workflow_template_id: '00000000-0000-4000-8000-000000000021',
      p_target_workflow_template_id: '00000000-0000-4000-8000-000000000022',
      p_source_statuses: ['succeeded'],
      p_context_patch: { handoff: 'updated' },
      p_enabled: false,
      p_notes: 'updated trigger',
      p_scope_id: '00000000-0000-4000-8000-000000000023',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_run_triggers',
      p_id: '00000000-0000-4000-8000-000000000020',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_delete_workflow_run_trigger_v1', {
      p_workflow_run_trigger_id: '00000000-0000-4000-8000-000000000020',
      p_scope_id: '00000000-0000-4000-8000-000000000023',
    });
    expect(updateResult).toMatchObject({
      status: 'updated',
      workflow_run_trigger_id: '00000000-0000-4000-8000-000000000020',
      enabled: false,
      notes: 'updated trigger',
    });
    expect(deleteResult).toMatchObject({
      status: 'deleted',
      workflow_run_trigger_id: '00000000-0000-4000-8000-000000000020',
      deleted_at: '2026-06-01T11:05:00.000Z',
      workflow_trigger_fires_count: 2,
    });
  });

  it('rejects workflow run trigger update readback when the backend row is already deleted', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: 'updated',
        workflow_run_trigger_id: '00000000-0000-4000-8000-000000000020',
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000020',
        source_workflow_template_id: '00000000-0000-4000-8000-000000000021',
        target_workflow_template_id: '00000000-0000-4000-8000-000000000022',
        source_statuses: ['succeeded'],
        context_patch: { handoff: 'stale' },
        scope_type: 'tenant',
        scope_id: '00000000-0000-4000-8000-000000000023',
        enabled: false,
        deleted_at: '2026-06-01T11:05:00.000Z',
        notes: 'deleted trigger',
        updated_at: '2026-06-01T11:05:00.000Z',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.ui_update_workflow_run_trigger_v1({
      workflow_run_trigger_id: '00000000-0000-4000-8000-000000000020',
      enabled: true,
      scope_id: '00000000-0000-4000-8000-000000000023',
    })).rejects.toThrow(
      'ui_update_workflow_run_trigger_v1 backend readback returned a deleted workflow trigger',
    );
  });

  it('accepts workflow schedule run-now preflight failures as backend readback without requiring a created run', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: 'preflight_failed',
        workflow_schedule_trigger_id: '00000000-0000-4000-8000-000000000012',
        workflow_template_id: '00000000-0000-4000-8000-000000000010',
        workflow_run_id: null,
        last_error: 'workflow_schedule_trigger_preflight: missing object at $.context.binding_payload.task',
        last_error_at: '2026-05-24T01:50:00.000Z',
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000012',
        last_run_id: null,
        last_run_at: null,
        last_error: 'workflow_schedule_trigger_preflight: missing object at $.context.binding_payload.task',
        last_error_at: '2026-05-24T01:50:00.000Z',
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.ui_run_workflow_schedule_trigger_v1(
      '00000000-0000-4000-8000-000000000012',
    );

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_run_workflow_schedule_trigger_v1', {
      p_workflow_schedule_trigger_id: '00000000-0000-4000-8000-000000000012',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_schedule_triggers',
      p_id: '00000000-0000-4000-8000-000000000012',
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_runs',
      p_id: expect.any(String),
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith('ui_list_resource_v1', expect.anything());
    expect(result).toMatchObject({
      ok: true,
      status: 'preflight_failed',
      workflow_run_id: null,
      last_run_at: null,
      last_error: 'workflow_schedule_trigger_preflight: missing object at $.context.binding_payload.task',
      last_error_at: '2026-05-24T01:50:00.000Z',
    });
  });

  it('repairs workflow schedule task payloads only after backend schedule readback confirms the patch', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: 'payload_repaired',
        workflow_schedule_trigger_id: '00000000-0000-4000-8000-000000000012',
        workflow_template_id: '00000000-0000-4000-8000-000000000010',
        workflow_template_step_id: '00000000-0000-4000-8000-000000000013',
        operation_name: 'binding_marketing_lead_review_task',
        task_type_key: 'marketing_lead_followup',
        queue_key: 'default',
        priority: 50,
        sla_minutes: null,
        updated_at: '2026-05-24T02:00:00.000Z',
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000012',
        updated_at: '2026-05-24T02:00:00.000Z',
        last_error: null,
        last_error_at: null,
        context_patch: {
          binding_payload: {
            task: {
              task_type_key: 'marketing_lead_followup',
              organization_id: '00000000-0000-4000-8000-000000000014',
            },
          },
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.ui_repair_workflow_schedule_task_payload_v1(
      '00000000-0000-4000-8000-000000000012',
    );

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_repair_workflow_schedule_task_payload_v1', {
      p_workflow_schedule_trigger_id: '00000000-0000-4000-8000-000000000012',
      p_task_payload: {},
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_schedule_triggers',
      p_id: '00000000-0000-4000-8000-000000000012',
    });
    expect(result).toMatchObject({
      ok: true,
      status: 'payload_repaired',
      workflow_schedule_trigger_id: '00000000-0000-4000-8000-000000000012',
      task_type_key: 'marketing_lead_followup',
      queue_key: 'default',
      updated_at: '2026-05-24T02:00:00.000Z',
    });
  });

  it('fails workflow schedule run-now when schedule readback does not reference the created run', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: 'workflow_started',
        workflow_schedule_trigger_id: '00000000-0000-4000-8000-000000000012',
        workflow_template_id: '00000000-0000-4000-8000-000000000010',
        workflow_run_id: '00000000-0000-4000-8000-000000000011',
      },
      error: null,
    }).mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000012',
        last_run_id: '00000000-0000-4000-8000-000000000099',
        last_run_at: '2026-05-23T01:50:00.000Z',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.ui_run_workflow_schedule_trigger_v1(
      '00000000-0000-4000-8000-000000000012',
    )).rejects.toThrow(
      'ui_run_workflow_schedule_trigger_v1 backend readback did not update workflow_schedule_triggers.last_run_id',
    );
  });

  it('normalizes frontend telemetry events into the canonical ui_log_event_v1 payload', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: '00000000-0000-4000-8000-000000000019',
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.ui_log_event_v1({
      kind: 'web_vital.lcp',
      payload: { value: 1250, rating: 'good' },
      correlation_id: 'corr-console-1',
    }, 'console-v2');

    expect(mocks.rpc).toHaveBeenCalledWith('ui_log_event_v1', {
      p_event: {
        kind: 'web_vital.lcp',
        payload: { value: 1250, rating: 'good' },
        correlation_id: 'corr-console-1',
        type: 'web_vital.lcp',
        name: 'web_vital.lcp',
        meta: {
          value: 1250,
          rating: 'good',
          correlation_id: 'corr-console-1',
        },
      },
      p_app: 'console-v2',
    });
    expect(result).toMatchObject({ ok: true, app: 'console-v2' });
  });

  it('supports strict backend readback for operator workflow telemetry actions', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: '00000000-0000-4000-8000-000000000020',
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000020',
          app: 'console',
          event_type: 'workflow_run.inspected',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_log_event_v1(
      {
        event: 'workflow_run.inspected',
        workflow_run_id: '00000000-0000-4000-8000-000000000021',
      },
      'console',
      { requireReadback: true },
    );

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_log_event_v1', {
      p_event: expect.objectContaining({
        event: 'workflow_run.inspected',
        type: 'workflow_run.inspected',
        name: 'workflow_run.inspected',
      }),
      p_app: 'console',
    });
    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'ui_event_log_directory',
      p_id: '00000000-0000-4000-8000-000000000020',
    });
    expect(result).toMatchObject({
      ok: true,
      app: 'console',
      event_id: '00000000-0000-4000-8000-000000000020',
      readback: {
        id: '00000000-0000-4000-8000-000000000020',
        event_type: 'workflow_run.inspected',
      },
    });
  });

  it('does not emit browser telemetry before a live auth session exists', async () => {
    mocks.authGetSession.mockResolvedValueOnce({ data: { session: null } });

    const ds = await import('../data-source');
    const result = await ds.ui_log_event_v1({
      kind: 'web_vital.fcp',
      payload: { value: 420 },
    }, 'console-v2');

    expect(mocks.rpc).not.toHaveBeenCalledWith(
      'ui_log_event_v1',
      expect.anything(),
    );
    expect(result).toMatchObject({ ok: true, app: 'console-v2' });
  });

  it('routes onboarding bootstrap repair through the canonical api RPC', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        scope_type: 'tenant',
        scope_id: '00000000-0000-4000-8000-000000000013',
        bootstrap_run_id: '00000000-0000-4000-8000-000000000113',
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.ui_execute_onboarding_bootstrap_v1({
      scope_type: 'tenant',
      scope_id: '00000000-0000-4000-8000-000000000013',
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_execute_onboarding_bootstrap_v1', {
      p_scope_type: 'tenant',
      p_scope_id: '00000000-0000-4000-8000-000000000013',
    });
    expect(result).toMatchObject({ ok: true, scope_type: 'tenant' });
  });

  it('fails closed when onboarding bootstrap returns only echoed scope data', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        scope_type: 'tenant',
        scope_id: '00000000-0000-4000-8000-000000000013',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.ui_execute_onboarding_bootstrap_v1({
      scope_type: 'tenant',
      scope_id: '00000000-0000-4000-8000-000000000013',
    })).rejects.toThrow('backend execution evidence');
  });

  it('routes mapping test execution through the canonical api RPC', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          mapping_config_id: '00000000-0000-4000-8000-000000000014',
          report_id: '00000000-0000-4000-8000-000000000015',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000015',
          mapping_config_id: '00000000-0000-4000-8000-000000000014',
          status: 'succeeded',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_test_mapping_config_v1(
      '00000000-0000-4000-8000-000000000014',
      { external_id: 'MX-1' },
    );

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_test_mapping_config_v1', {
      p_mapping_config_id: '00000000-0000-4000-8000-000000000014',
      p_payload: { external_id: 'MX-1' },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'mapping_operation_reports',
      p_id: '00000000-0000-4000-8000-000000000015',
    });
    expect(result).toMatchObject({
      ok: true,
      report_id: '00000000-0000-4000-8000-000000000015',
    });
  });

  it('fails closed when the live mapping test RPC returns no result', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const ds = await import('../data-source');
    await expect(
      ds.ui_test_mapping_config_v1(
        '00000000-0000-4000-8000-000000000014',
        { external_id: 'MX-1' },
      ),
    ).rejects.toThrow('ui_test_mapping_config_v1 returned no result');
  });

  it('fails closed when the live mapping test RPC returns no report evidence', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        mapping_config_id: '00000000-0000-4000-8000-000000000014',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(
      ds.ui_test_mapping_config_v1(
        '00000000-0000-4000-8000-000000000014',
        { external_id: 'MX-1' },
      ),
    ).rejects.toThrow('backend mapping operation report evidence');
  });

  it('routes integration plugin test execution through the api schema wrapper', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          plugin_id: '00000000-0000-4000-8000-000000000016',
          validation_run_id: '00000000-0000-4000-8000-000000000017',
          duration_ms: 12,
          steps: [{ name: 'validate_schema', ok: true, ms: 12 }],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000017', status: 'succeeded' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.runPluginTest(
      '00000000-0000-4000-8000-000000000016',
      { external_id: 'MX-2' },
    );

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('test_integration_plugin_v1', {
      p_args: {
        plugin_id: '00000000-0000-4000-8000-000000000016',
        payload: { external_id: 'MX-2' },
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'integration_plugin_validation_runs',
      p_id: '00000000-0000-4000-8000-000000000017',
    });
    expect(result).toMatchObject({
      ok: true,
      validation_run_id: '00000000-0000-4000-8000-000000000017',
      duration_ms: 12,
    });
  });

  it('forwards the selected integration plugin version into live plugin diagnostics', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          plugin_id: '00000000-0000-4000-8000-000000000016',
          plugin_version_id: '00000000-0000-4000-8000-000000000022',
          validation_run_id: '00000000-0000-4000-8000-000000000023',
          duration_ms: 18,
          steps: [{ name: 'validate_schema', ok: true, ms: 18 }],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000023', status: 'succeeded' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.runPluginTest(
      '00000000-0000-4000-8000-000000000016',
      { external_id: 'MX-2' },
      '00000000-0000-4000-8000-000000000022',
    );

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('test_integration_plugin_v1', {
      p_args: {
        plugin_id: '00000000-0000-4000-8000-000000000016',
        payload: { external_id: 'MX-2' },
        plugin_version_id: '00000000-0000-4000-8000-000000000022',
      },
    });
    expect(result).toMatchObject({
      ok: true,
      plugin_id: '00000000-0000-4000-8000-000000000016',
      plugin_version_id: '00000000-0000-4000-8000-000000000022',
      validation_run_id: '00000000-0000-4000-8000-000000000023',
    });
  });

  it('fails closed when live integration plugin test returns no backend evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { ok: true, plugin_id: '00000000-0000-4000-8000-000000000016' }, error: null });

    const ds = await import('../data-source');
    await expect(ds.runPluginTest(
      '00000000-0000-4000-8000-000000000016',
      { external_id: 'MX-2' },
    )).rejects.toThrow('test_integration_plugin_v1 returned no backend outcome');
    await expect(ds.runPluginTest(
      '00000000-0000-4000-8000-000000000016',
      { external_id: 'MX-2' },
    )).rejects.toThrow('test_integration_plugin_v1 did not return backend validation evidence');
  });

  it('fails closed when live integration plugin test omits backend trace steps', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          plugin_id: '00000000-0000-4000-8000-000000000016',
          validation_run_id: '00000000-0000-4000-8000-000000000017',
          duration_ms: 12,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000017', status: 'succeeded' },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.runPluginTest(
      '00000000-0000-4000-8000-000000000016',
      { external_id: 'MX-2' },
    )).rejects.toThrow('test_integration_plugin_v1 did not return backend trace steps');
  });

  it('fails closed when live integration plugin test lacks validation run readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          plugin_id: '00000000-0000-4000-8000-000000000016',
          validation_run_id: '00000000-0000-4000-8000-000000000017',
          duration_ms: 12,
          steps: [{ name: 'validate_schema', ok: true, ms: 12 }],
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.runPluginTest(
      '00000000-0000-4000-8000-000000000016',
      { external_id: 'MX-2' },
    )).rejects.toThrow('test_integration_plugin_v1 backend readback missing integration_plugin_validation_runs:00000000-0000-4000-8000-000000000017');
  });

  it('requires browser-safe credential-directory readback after credential mutations', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          provider_auth_config_id: '00000000-0000-4000-8000-000000000018',
          correlation_id: '00000000-0000-4000-8000-000000000019',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000018',
          provider_id: '00000000-0000-4000-8000-000000000020',
          provider_label: 'Carrier API',
          auth_type: 'api_key',
          status: 'active',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_upsert_provider_auth_config_v1({
      provider_id: '00000000-0000-4000-8000-000000000020',
      auth_type: 'api_key',
      credentials: { token: 'vault-ref' },
    });

    expect(result.provider_auth_config_id).toBe('00000000-0000-4000-8000-000000000018');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_upsert_provider_auth_config_v1', {
      p_args: {
        provider_id: '00000000-0000-4000-8000-000000000020',
        auth_type: 'api_key',
        credentials: { token: 'vault-ref' },
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'integration_credential_directory',
      p_id: '00000000-0000-4000-8000-000000000018',
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'provider_auth_configs',
      p_id: '00000000-0000-4000-8000-000000000018',
    });
  });

  it('fails closed when credential-directory readback exposes secret fields', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          provider_auth_config_id: '00000000-0000-4000-8000-000000000018',
          correlation_id: '00000000-0000-4000-8000-000000000019',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000018',
          provider_id: '00000000-0000-4000-8000-000000000020',
          auth_type: 'api_key',
          credentials: { token: 'must-not-leak' },
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_upsert_provider_auth_config_v1({
      provider_id: '00000000-0000-4000-8000-000000000020',
      auth_type: 'api_key',
      credentials: { token: 'vault-ref' },
    })).rejects.toThrow(/credential secret fields/);
  });

  it('fails closed when credential-directory readback returns a different credential id', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          provider_auth_config_id: '00000000-0000-4000-8000-000000000018',
          correlation_id: '00000000-0000-4000-8000-000000000019',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000999',
          provider_id: '00000000-0000-4000-8000-000000000020',
          auth_type: 'api_key',
          status: 'active',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_upsert_provider_auth_config_v1({
      provider_id: '00000000-0000-4000-8000-000000000020',
      auth_type: 'api_key',
      credentials: { token: 'vault-ref' },
    })).rejects.toThrow(/provider_auth_config_id/);
  });

  it('requires revoked credential-directory readback after provider credential revoke', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          provider_auth_config_id: '00000000-0000-4000-8000-000000000018',
          correlation_id: '00000000-0000-4000-8000-000000000019',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000018',
          status: 'revoked',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_revoke_provider_auth_config_v1({
      config_id: '00000000-0000-4000-8000-000000000018',
      reason: 'replaced during readiness',
    })).resolves.toMatchObject({
      provider_auth_config_id: '00000000-0000-4000-8000-000000000018',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'integration_credential_directory',
      p_id: '00000000-0000-4000-8000-000000000018',
    });
  });

  it('requires browser-safe credential-directory readback after generic provider credential rotation', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          provider_auth_config_id: '00000000-0000-4000-8000-000000000018',
          correlation_id: '00000000-0000-4000-8000-000000000019',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000018',
          provider_id: '00000000-0000-4000-8000-000000000020',
          provider_label: 'Carrier API',
          auth_type: 'api_key',
          status: 'active',
          last_rotated_at: '2026-05-13T07:10:00.000Z',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.integration_plugin_rotate_credentials_v1({
      config_id: '00000000-0000-4000-8000-000000000018',
      auth_type: 'api_key',
      credentials: { token: 'rotated-vault-ref' },
      reason: 'scheduled readiness rotation',
    });

    expect(result.provider_auth_config_id).toBe('00000000-0000-4000-8000-000000000018');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'integration_plugin_rotate_credentials_v1', {
      p_args: {
        config_id: '00000000-0000-4000-8000-000000000018',
        auth_type: 'api_key',
        credentials: { token: 'rotated-vault-ref' },
        reason: 'scheduled readiness rotation',
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'integration_credential_directory',
      p_id: '00000000-0000-4000-8000-000000000018',
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'provider_auth_configs',
      p_id: '00000000-0000-4000-8000-000000000018',
    });
  });

  it('fails closed when provider credential revoke readback is not revoked', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          provider_auth_config_id: '00000000-0000-4000-8000-000000000018',
          correlation_id: '00000000-0000-4000-8000-000000000019',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000018',
          status: 'active',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_revoke_provider_auth_config_v1({
      config_id: '00000000-0000-4000-8000-000000000018',
      reason: 'replaced during readiness',
    })).rejects.toThrow(/revoked status/);
  });

  it('requires browser-safe credential-directory readback after provider-account binding', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          provider_auth_config_id: '00000000-0000-4000-8000-000000000118',
          settings_version_id: '00000000-0000-4000-8000-000000000119',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000118',
          provider_label: 'Logestechs 3PL',
          auth_type: 'basic_auth',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_bind_provider_account_credential_v1({
      route_method: 'POST',
      route_path: '/api/ship/request/by-email',
      organization_id: '00000000-0000-4000-8000-000000000120',
      scope_type: 'tenant',
      company_id: '362',
      auth_type: 'basic_auth',
      credentials: { username: 'api-user', password: 'api-pass' },
    });

    expect(result.provider_auth_config_id).toBe('00000000-0000-4000-8000-000000000118');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_bind_provider_account_credential_v1', {
      p_args: {
        route_method: 'POST',
        route_path: '/api/ship/request/by-email',
        organization_id: '00000000-0000-4000-8000-000000000120',
        scope_type: 'tenant',
        company_id: '362',
        auth_type: 'basic_auth',
        credentials: { username: 'api-user', password: 'api-pass' },
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'integration_credential_directory',
      p_id: '00000000-0000-4000-8000-000000000118',
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'provider_auth_configs',
      p_id: '00000000-0000-4000-8000-000000000118',
    });
  });

  it('fails closed when provider-account binding lacks credential-directory readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          provider_auth_config_id: '00000000-0000-4000-8000-000000000118',
          settings_version_id: '00000000-0000-4000-8000-000000000119',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_bind_provider_account_credential_v1({
      route_method: 'POST',
      route_path: '/api/ship/request/by-email',
      organization_id: '00000000-0000-4000-8000-000000000120',
      scope_type: 'tenant',
      company_id: '362',
      auth_type: 'basic_auth',
      credentials: { username: 'api-user', password: 'api-pass' },
    })).rejects.toThrow(
      'ui_bind_provider_account_credential_v1 backend readback missing integration_credential_directory:00000000-0000-4000-8000-000000000118',
    );
  });

  it('fails closed when provider-account binding readback exposes secret fields', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          provider_auth_config_id: '00000000-0000-4000-8000-000000000118',
          settings_version_id: '00000000-0000-4000-8000-000000000119',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000118',
          provider_label: 'Logestechs 3PL',
          auth_type: 'basic_auth',
          credentials: { username: 'must-not-leak' },
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_bind_provider_account_credential_v1({
      route_method: 'POST',
      route_path: '/api/ship/request/by-email',
      organization_id: '00000000-0000-4000-8000-000000000120',
      scope_type: 'tenant',
      company_id: '362',
      auth_type: 'basic_auth',
      credentials: { username: 'api-user', password: 'api-pass' },
    })).rejects.toThrow(/credential secret fields/);
  });

  it('requires settings readback after provider-account unbind', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          bound: false,
          provider_account_category: 'logestechs_v2_account',
          scope_type: 'tenant',
          scope_id: '00000000-0000-4000-8000-000000000120',
          organization_id: '00000000-0000-4000-8000-000000000120',
          settings_version_id: '00000000-0000-4000-8000-000000000121',
          auth_config_id: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          value: {
            enabled: false,
            auth_config_id: null,
            company_id: '362',
          },
          scope_type: 'tenant',
          scope_id: '00000000-0000-4000-8000-000000000120',
          settings_id: '00000000-0000-4000-8000-000000000122',
          settings_version_id: '00000000-0000-4000-8000-000000000121',
        }],
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_unbind_provider_account_credential_v1({
      route_method: 'POST',
      route_path: '/api/ship/request/by-email',
      organization_id: '00000000-0000-4000-8000-000000000120',
      scope_type: 'tenant',
      provider_account_category: 'logestechs_v2_account',
      reason: 'readiness unbind proof',
    });

    expect(result.bound).toBe(false);
    expect(result.auth_config_id).toBeNull();
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_unbind_provider_account_credential_v1', {
      p_args: {
        route_method: 'POST',
        route_path: '/api/ship/request/by-email',
        organization_id: '00000000-0000-4000-8000-000000000120',
        scope_type: 'tenant',
        provider_account_category: 'logestechs_v2_account',
        reason: 'readiness unbind proof',
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'resolve_settings_row_from_policy_context_v1', {
      p_category: 'logestechs_v2_account',
      p_context: expect.objectContaining({
        organization_id: '00000000-0000-4000-8000-000000000120',
      }),
    });
  });

  it('fails closed when provider-account unbind readback still has auth_config_id', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          bound: false,
          provider_account_category: 'logestechs_v2_account',
          scope_type: 'tenant',
          scope_id: '00000000-0000-4000-8000-000000000120',
          organization_id: '00000000-0000-4000-8000-000000000120',
          settings_version_id: '00000000-0000-4000-8000-000000000121',
          auth_config_id: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          value: {
            enabled: true,
            auth_config_id: '00000000-0000-4000-8000-000000000118',
            company_id: '362',
          },
          scope_type: 'tenant',
          scope_id: '00000000-0000-4000-8000-000000000120',
        }],
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_unbind_provider_account_credential_v1({
      route_method: 'POST',
      route_path: '/api/ship/request/by-email',
      organization_id: '00000000-0000-4000-8000-000000000120',
      scope_type: 'tenant',
      provider_account_category: 'logestechs_v2_account',
      reason: 'readiness unbind proof',
    })).rejects.toThrow(/still exposes auth_config_id/);
  });

  it('fails closed when credential mutation lacks credential-directory readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          provider_auth_config_id: '00000000-0000-4000-8000-000000000018',
          correlation_id: '00000000-0000-4000-8000-000000000019',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.integration_plugin_rotate_credentials_v1({
      config_id: '00000000-0000-4000-8000-000000000018',
      credentials: { token: 'new-vault-ref' },
    })).rejects.toThrow('integration_plugin_rotate_credentials_v1 backend readback missing integration_credential_directory:00000000-0000-4000-8000-000000000018');
  });

  it('requires plugin version, plugin, directory, and approval ledger readback after plugin submit', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          plugin_id: '00000000-0000-4000-8000-000000000021',
          plugin_version_id: '00000000-0000-4000-8000-000000000022',
          status: 'submitted',
          correlation_id: '00000000-0000-4000-8000-000000000023',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000022', plugin_id: '00000000-0000-4000-8000-000000000021', status: 'submitted' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', status: 'submitted' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', status: 'submitted', latest_version_status: 'submitted' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{ id: '00000000-0000-4000-8000-000000000024', plugin_version_id: '00000000-0000-4000-8000-000000000022', action: 'submitted' }], total: 1 },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.plugin_submit_v1({
      plugin_version_id: '00000000-0000-4000-8000-000000000022',
      reason: 'ready for review',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'plugin_submit_v1', {
      p_args: {
        plugin_version_id: '00000000-0000-4000-8000-000000000022',
        reason: 'ready for review',
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_get_resource_v1', {
      p_resource: 'integration_plugin_directory',
      p_id: '00000000-0000-4000-8000-000000000021',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'ui_list_resource_v1', {
      p_resource: 'integration_plugin_approval_events',
      p_filters: {
        plugin_version_id: '00000000-0000-4000-8000-000000000022',
        action: 'submitted',
      },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
  });

  it('reads plugin export handoff through api schema and confirms plugin readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          plugin_id: '00000000-0000-4000-8000-000000000021',
          plugin_version_id: '00000000-0000-4000-8000-000000000022',
          kind: 'webhook',
          endpoint: 'http://127.0.0.1:58429/functions/v1/webhook-receiver',
          token: 'ipt_export_handoff_secret',
          sample_curl: 'curl -H "authorization: Bearer ipt_export_handoff_secret"',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000022',
          plugin_id: '00000000-0000-4000-8000-000000000021',
          status: 'active',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', version_label: 'v1' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.integration_plugin_export_handoff_v1({
      plugin_version_id: '00000000-0000-4000-8000-000000000022',
      base_url: 'http://127.0.0.1:58429',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'integration_plugin_export_handoff_v1', {
      p_plugin_version_id: '00000000-0000-4000-8000-000000000022',
      p_base_url: 'http://127.0.0.1:58429',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'integration_plugin_versions',
      p_id: '00000000-0000-4000-8000-000000000022',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_get_resource_v1', {
      p_resource: 'integration_plugin_directory',
      p_id: '00000000-0000-4000-8000-000000000021',
    });
    expect(result.plugin_version_id).toBe('00000000-0000-4000-8000-000000000022');
  });

  it('fails closed when plugin export handoff only returns a placeholder token', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        plugin_id: '00000000-0000-4000-8000-000000000021',
        plugin_version_id: '00000000-0000-4000-8000-000000000022',
        kind: 'webhook',
        endpoint: 'http://127.0.0.1:58429/functions/v1/webhook-receiver',
        token: '{{TOKEN}}',
        sample_curl: 'curl -H "authorization: Bearer {{TOKEN}}"',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.integration_plugin_export_handoff_v1({
      plugin_version_id: '00000000-0000-4000-8000-000000000022',
      base_url: 'http://127.0.0.1:58429',
    })).rejects.toThrow('integration_plugin_export_handoff_v1 did not return an issued source token');
  });

  it('fails closed when plugin export handoff returns a placeholder endpoint', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        plugin_id: '00000000-0000-4000-8000-000000000021',
        plugin_version_id: '00000000-0000-4000-8000-000000000022',
        kind: 'api',
        endpoint: 'http://127.0.0.1:58429/functions/v1/api-gateway/t/ipt_export_handoff/{{PATH_TEMPLATE}}',
        token: 'ipt_export_handoff',
        sample_curl: 'curl -X POST "http://127.0.0.1:58429/functions/v1/api-gateway/t/ipt_export_handoff/{{PATH_TEMPLATE}}"',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.integration_plugin_export_handoff_v1({
      plugin_version_id: '00000000-0000-4000-8000-000000000022',
      base_url: 'http://127.0.0.1:58429',
    })).rejects.toThrow('integration_plugin_export_handoff_v1 did not return a concrete endpoint handoff');
  });

  it('fails closed when plugin lifecycle mutation lacks directory readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          plugin_id: '00000000-0000-4000-8000-000000000021',
          plugin_version_id: '00000000-0000-4000-8000-000000000022',
          status: 'approved',
          correlation_id: '00000000-0000-4000-8000-000000000023',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000022', plugin_id: '00000000-0000-4000-8000-000000000021', status: 'approved' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', status: 'approved' },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.plugin_approve_v1({
      plugin_version_id: '00000000-0000-4000-8000-000000000022',
      decision: 'approved',
    })).rejects.toThrow('plugin_approve_v1 backend readback missing integration_plugin_directory:00000000-0000-4000-8000-000000000021');
  });

  it('treats plugin rejection as a successful governance decision with live readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          plugin_id: '00000000-0000-4000-8000-000000000021',
          plugin_version_id: '00000000-0000-4000-8000-000000000022',
          status: 'rejected',
          correlation_id: '00000000-0000-4000-8000-000000000023',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000022',
          plugin_id: '00000000-0000-4000-8000-000000000021',
          status: 'rejected',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000021',
          status: 'draft',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000021',
          status: 'draft',
          latest_version_status: 'rejected',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000024',
            plugin_version_id: '00000000-0000-4000-8000-000000000022',
            action: 'rejected',
          }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.plugin_approve_v1({
      plugin_version_id: '00000000-0000-4000-8000-000000000022',
      decision: 'rejected',
    })).resolves.toMatchObject({
      plugin_version_id: '00000000-0000-4000-8000-000000000022',
      status: 'rejected',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_get_resource_v1', {
      p_resource: 'integration_plugin_directory',
      p_id: '00000000-0000-4000-8000-000000000021',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'ui_list_resource_v1', {
      p_resource: 'integration_plugin_approval_events',
      p_filters: {
        plugin_version_id: '00000000-0000-4000-8000-000000000022',
        action: 'rejected',
      },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
  });

  it('requires binding readback after plugin activation', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          plugin_id: '00000000-0000-4000-8000-000000000021',
          plugin_version_id: '00000000-0000-4000-8000-000000000022',
          status: 'active',
          correlation_id: '00000000-0000-4000-8000-000000000023',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000022', plugin_id: '00000000-0000-4000-8000-000000000021', status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', status: 'active', active_binding_count: 1 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{ id: '00000000-0000-4000-8000-000000000025', plugin_version_id: '00000000-0000-4000-8000-000000000022', enabled: true }], total: 1 },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.plugin_activate_v1({
      plugin_version_id: '00000000-0000-4000-8000-000000000022',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'ui_list_resource_v1', {
      p_resource: 'integration_plugin_bindings',
      p_filters: { plugin_version_id: '00000000-0000-4000-8000-000000000022' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
  });

  it('requires plugin, directory, approval ledger, and disabled binding readback after plugin deactivate', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          plugin_id: '00000000-0000-4000-8000-000000000021',
          plugin_version_id: '00000000-0000-4000-8000-000000000022',
          status: 'disabled',
          version_status: 'approved',
          changed_count: 1,
          correlation_id: '00000000-0000-4000-8000-000000000023',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000022',
          plugin_id: '00000000-0000-4000-8000-000000000021',
          status: 'approved',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000021',
          status: 'disabled',
          active_version_id: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000021',
          status: 'disabled',
          latest_version_status: 'approved',
          has_active_version: false,
          active_binding_count: 0,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000024',
            plugin_version_id: '00000000-0000-4000-8000-000000000022',
            action: 'deactivated',
          }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000025',
            plugin_version_id: '00000000-0000-4000-8000-000000000022',
            enabled: false,
          }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.plugin_deactivate_v1({
      plugin_id: '00000000-0000-4000-8000-000000000021',
      plugin_version_id: '00000000-0000-4000-8000-000000000022',
      reason: 'operator disabled inactive provider',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'plugin_deactivate_v1', {
      p_args: {
        plugin_id: '00000000-0000-4000-8000-000000000021',
        plugin_version_id: '00000000-0000-4000-8000-000000000022',
        reason: 'operator disabled inactive provider',
        expected_binding_enabled: false,
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_get_resource_v1', {
      p_resource: 'integration_plugin_directory',
      p_id: '00000000-0000-4000-8000-000000000021',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'ui_list_resource_v1', {
      p_resource: 'integration_plugin_approval_events',
      p_filters: {
        plugin_version_id: '00000000-0000-4000-8000-000000000022',
        action: 'deactivated',
      },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(6, 'ui_list_resource_v1', {
      p_resource: 'integration_plugin_bindings',
      p_filters: { plugin_version_id: '00000000-0000-4000-8000-000000000022' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
  });

  it('fails closed when plugin binding toggle does not change scoped binding readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          plugin_id: '00000000-0000-4000-8000-000000000021',
          plugin_version_id: '00000000-0000-4000-8000-000000000022',
          enabled: false,
          changed_count: 0,
          correlation_id: '00000000-0000-4000-8000-000000000023',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000022', plugin_id: '00000000-0000-4000-8000-000000000021', status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000021', status: 'active', active_binding_count: 1 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000025',
            plugin_version_id: '00000000-0000-4000-8000-000000000022',
            scope_type: 'tenant',
            scope_id: '00000000-0000-4000-8000-000000000026',
            enabled: true,
          }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.plugin_set_binding_v1({
      plugin_version_id: '00000000-0000-4000-8000-000000000022',
      enabled: false,
      scope_type: 'tenant',
      scope_id: '00000000-0000-4000-8000-000000000026',
    })).rejects.toThrow('plugin_set_binding_v1 backend readback did not reflect integration_plugin_bindings.enabled=false');
  });

  it('requires webhook source and source-directory readback after source mutations', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_source_id: '00000000-0000-4000-8000-000000000026',
          correlation_id: '00000000-0000-4000-8000-000000000027',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000026',
          name: 'Logistics webhook',
          source_identifier: 'logistics-webhook',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000026',
          name: 'Logistics webhook',
          source_identifier: 'logistics-webhook',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.ui_upsert_webhook_source_v1({
      name: 'Logistics webhook',
      source_identifier: 'logistics-webhook',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'webhook_source_directory',
      p_id: '00000000-0000-4000-8000-000000000026',
    });
  });

  it('fails closed when webhook source readback does not reflect requested enabled state', async () => {
    const sourceId = '00000000-0000-4000-8000-000000000026';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_source_id: sourceId,
          correlation_id: '00000000-0000-4000-8000-000000000027',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId, enabled: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId, enabled: true },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_upsert_webhook_source_v1({
      source_id: sourceId,
      enabled: false,
    })).rejects.toThrow(/enabled state/);
  });

  it('accepts row-driven webhook source default rate-limit readback when create omits a rate limit', async () => {
    const sourceId = '00000000-0000-4000-8000-000000000026';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_source_id: sourceId,
          correlation_id: '00000000-0000-4000-8000-000000000027',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: sourceId,
          name: 'Defaulted webhook',
          source_identifier: 'defaulted-webhook',
          rate_limit_per_hour: 4321,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: sourceId,
          name: 'Defaulted webhook',
          source_identifier: 'defaulted-webhook',
          rate_limit_per_hour: 4321,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_upsert_webhook_source_v1({
      name: 'Defaulted webhook',
      source_identifier: 'defaulted-webhook',
      rate_limit_per_hour: null,
    })).resolves.toMatchObject({ webhook_source_id: sourceId });
  });

  it('requires rotated webhook source token state to be redacted in directory readback', async () => {
    const sourceId = '00000000-0000-4000-8000-000000000026';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_source_id: sourceId,
          auth_token: 'c'.repeat(64),
          correlation_id: '00000000-0000-4000-8000-000000000027',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId, auth_token_masked: 'stored' },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_rotate_webhook_source_token_v1({
      source_id: sourceId,
    })).resolves.toMatchObject({ webhook_source_id: sourceId });
  });

  it('fails closed when rotated webhook source token state is not redacted in readback', async () => {
    const sourceId = '00000000-0000-4000-8000-000000000026';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_source_id: sourceId,
          auth_token: 'd'.repeat(64),
          correlation_id: '00000000-0000-4000-8000-000000000027',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_rotate_webhook_source_token_v1({
      source_id: sourceId,
    })).rejects.toThrow(/redacted intake source token state/);
  });

  it('requires archived webhook source readback from source and directory projections', async () => {
    const sourceId = '00000000-0000-4000-8000-000000000026';
    const archivedAt = '2026-05-12T05:20:00.000Z';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_source_id: sourceId,
          enabled: false,
          archived_at: archivedAt,
          correlation_id: '00000000-0000-4000-8000-000000000027',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: sourceId,
          enabled: false,
          managed_metadata: { lifecycle: 'archived', archived_at: archivedAt },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: sourceId,
          enabled: false,
          lifecycle_state: 'archived',
          archived_at: archivedAt,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_archive_webhook_source_v1({
      source_id: sourceId,
      reason: 'Legacy integration retired',
    })).resolves.toMatchObject({ webhook_source_id: sourceId });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_archive_webhook_source_v1', {
      p_args: { source_id: sourceId, reason: 'Legacy integration retired' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'webhook_source_directory',
      p_id: sourceId,
    });
  });

  it('fails closed when archived webhook source readback stays enabled', async () => {
    const sourceId = '00000000-0000-4000-8000-000000000026';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_source_id: sourceId,
          enabled: false,
          correlation_id: '00000000-0000-4000-8000-000000000027',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId, enabled: true, managed_metadata: { lifecycle: 'archived' } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId, enabled: false, lifecycle_state: 'archived' },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_archive_webhook_source_v1({
      source_id: sourceId,
      reason: 'Legacy integration retired',
    })).rejects.toThrow(/disable archived intake source/);
  });

  it('requires webhook rule readback after upsert and validates changed fields', async () => {
    const ruleId = '00000000-0000-4000-8000-000000000128';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_rule_id: ruleId,
          correlation_id: '00000000-0000-4000-8000-000000000129',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: ruleId,
          name: 'Priority webhook rule',
          enabled: false,
          priority: 42,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_upsert_webhook_rule_v1({
      rule_id: ruleId,
      name: 'Priority webhook rule',
      enabled: false,
      priority: 42,
    })).resolves.toMatchObject({ webhook_rule_id: ruleId });

    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'webhook_rules',
      p_id: ruleId,
    });
  });

  it('fails closed when webhook rule readback does not reflect enabled state', async () => {
    const ruleId = '00000000-0000-4000-8000-000000000128';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_rule_id: ruleId,
          correlation_id: '00000000-0000-4000-8000-000000000129',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: ruleId,
          enabled: true,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_upsert_webhook_rule_v1({
      rule_id: ruleId,
      enabled: false,
    })).rejects.toThrow(/webhook rule enabled state/);
  });

  it('requires webhook rule priority readback after reorder', async () => {
    const ruleId = '00000000-0000-4000-8000-000000000128';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_rule_id: ruleId,
          priority: 43,
          correlation_id: '00000000-0000-4000-8000-000000000129',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: ruleId,
          priority: 43,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_reorder_webhook_rule_v1({
      rule_id: ruleId,
      priority: 43,
    })).resolves.toMatchObject({ webhook_rule_id: ruleId });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_reorder_webhook_rule_v1', {
      p_args: { rule_id: ruleId, priority: 43 },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'webhook_rules',
      p_id: ruleId,
    });
  });

  it('fails closed when webhook rule reorder readback has stale priority', async () => {
    const ruleId = '00000000-0000-4000-8000-000000000128';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_rule_id: ruleId,
          priority: 43,
          correlation_id: '00000000-0000-4000-8000-000000000129',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: ruleId,
          priority: 42,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_reorder_webhook_rule_v1({
      rule_id: ruleId,
      priority: 43,
    })).rejects.toThrow(/webhook rule priority/);
  });

  it('requires webhook rule absence readback after delete', async () => {
    const ruleId = '00000000-0000-4000-8000-000000000128';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_rule_id: ruleId,
          correlation_id: '00000000-0000-4000-8000-000000000129',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [], total: 0 },
        error: null,
      })
      .mockResolvedValue({
        data: { rows: [], total: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_delete_webhook_rule_v1({
      rule_id: ruleId,
    })).resolves.toMatchObject({ webhook_rule_id: ruleId });

    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_list_resource_v1', {
      p_resource: 'webhook_rules',
      p_filters: { id: ruleId },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
  });

  it('fails closed when deleted webhook rule still appears in readback', async () => {
    const ruleId = '00000000-0000-4000-8000-000000000128';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_rule_id: ruleId,
          correlation_id: '00000000-0000-4000-8000-000000000129',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{ id: ruleId }], total: 1 },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_delete_webhook_rule_v1({
      rule_id: ruleId,
    })).rejects.toThrow(/still lists webhook_rules/);
  });

  it('requires webhook inbox and inbox-directory readback after inbox replay', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          webhook_inbox_id: '00000000-0000-4000-8000-000000000028',
          correlation_id: '00000000-0000-4000-8000-000000000029',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000028', status: 'queued' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000028', source_label: 'Logistics webhook' },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.webhook_inbox_replay_v1({
      webhook_inbox_id: '00000000-0000-4000-8000-000000000028',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'webhook_inbox_directory',
      p_id: '00000000-0000-4000-8000-000000000028',
    });
  });

  it('returns accepted in-progress receiver readback without waiting for terminal shipment proof', async () => {
    const webhookId = '00000000-0000-4000-8000-000000000190';
    const workflowRunId = '00000000-0000-4000-8000-000000000191';
    let inboxDirectoryReads = 0;

    mocks.invoke.mockResolvedValueOnce({
      data: {
        accepted: true,
        workflow_run_id: workflowRunId,
        webhook_id: webhookId,
        correlation_id: 'idem-terminal-readback',
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'workflow_run_steps') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_inbox_directory') {
        inboxDirectoryReads += 1;
        if (inboxDirectoryReads > 1) {
          throw new Error('receiver POST should return accepted readback without waiting for terminal shipment proof');
        }
        return {
          data: {
            rows: [
              {
                id: webhookId,
                workflow_run_id: workflowRunId,
                processing_status: 'in_progress',
                is_terminal: false,
                is_actionable: true,
                shipment_id: null,
                tracking_number: '260094PEND',
                mapping_target: 'shipments.create',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    const result = await ds.runWebhookReceiverTest({
      auth_token: 'src_live_terminal_token',
      idempotency_key: 'idem-terminal-readback',
      payload: { event_type: 'shipment.created' },
    });

    expect(inboxDirectoryReads).toBe(1);
    expect(result.workflow_run_id).toBe(workflowRunId);
    expect(result.webhook_processing_status).toBe('in_progress');
    expect(result.is_terminal).toBe(false);
    expect(result.tracking_number).toBe('260094PEND');
    expect(result.shipment_id).toBeNull();
    expect(
      mocks.rpc.mock.calls.some(([, args]) => (args as Record<string, unknown>).p_resource === 'shipment_directory'),
    ).toBe(false);
  });

  it('recovers webhook receiver proof from inbox readback when the edge invocation hangs', async () => {
    vi.useFakeTimers();
    const webhookId = '00000000-0000-4000-8000-000000000213';
    const workflowRunId = '00000000-0000-4000-8000-000000000214';
    const shipmentId = '00000000-0000-4000-8000-000000000215';

    mocks.invoke.mockImplementationOnce(() => new Promise(() => {}));
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_inbox_directory') {
        return {
          data: {
            rows: [
              {
                id: webhookId,
                workflow_run_id: workflowRunId,
                processing_status: 'succeeded',
                is_terminal: true,
                is_actionable: false,
                shipment_id: shipmentId,
                tracking_number: '2600TIMEOUT',
                mapping_target: 'shipments.create',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'workflow_run_steps') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      if (rpcName === 'ui_get_resource_v1') {
        return {
          data: {
            id: args.p_id,
            shipment_id: args.p_id,
            tracking_number: '2600TIMEOUT',
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    try {
      const ds = await import('../data-source');
      const resultPromise = ds.runWebhookReceiverTest({
        auth_token: 'src_live_timeout_token',
        idempotency_key: 'idem-timeout-readback',
        payload: { event_type: 'shipment.created' },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;

      expect(result.response).toMatchObject({ invoke_timeout: true });
      expect(result.workflow_run_id).toBe(workflowRunId);
      expect(result.webhook_processing_status).toBe('succeeded');
      expect(result.shipment_id).toBe(shipmentId);
      expect(result.tracking_number).toBe('2600TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces direct webhook receiver edge 400 responses without waiting for inbox lineage', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://edge.local');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    vi.stubEnv('VITE_WEBHOOK_RECEIVER_DIRECT_FETCH_TEST', '1');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        response_reason: 'webhook_source_missing_sender_client',
        response_outcome: 'response_failed',
        correlation_id: 'idem-webhook-direct-400',
      })),
    });
    vi.stubGlobal('fetch', fetchMock);

    const ds = await import('../data-source');
    const result = await ds.runWebhookReceiverTest({
      auth_token: 'src_live_missing_sender_token',
      idempotency_key: 'idem-webhook-direct-400',
      payload: { event: { type: 'shipment.created' } },
    });

    expect(result.receiver_status).toBe(400);
    expect(result.response_outcome).toBe('response_failed');
    expect(result.ack_reason).toBe('webhook_source_missing_sender_client');
    expect(result.error_message).toBe('webhook_source_missing_sender_client');
    expect(result.webhook_processing_status).toBe('response_failed');
    expect(result.is_terminal).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://edge.local/functions/v1/webhook-receiver',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'anon-key',
          authorization: 'Bearer anon-key',
          'x-webhook-token': 'src_live_missing_sender_token',
        }),
      }),
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('does not promote planned tracking to shipment proof while receiver inbox is non-terminal', async () => {
    const webhookId = '00000000-0000-4000-8000-000000000193';
    const workflowRunId = '00000000-0000-4000-8000-000000000194';
    let inboxDirectoryReads = 0;

    mocks.invoke.mockResolvedValueOnce({
      data: {
        accepted: true,
        workflow_run_id: workflowRunId,
        webhook_id: webhookId,
        tracking_number: '260099PEND',
        correlation_id: 'idem-pending-readback',
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'workflow_run_steps') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_inbox_directory') {
        inboxDirectoryReads += 1;
        if (inboxDirectoryReads > 1) {
          throw new Error('pending inbox readback still not terminal');
        }
        return {
          data: {
            rows: [
              {
                id: webhookId,
                processing_status: 'in_progress',
                is_terminal: false,
                tracking_number: '260099PEND',
                mapping_target: 'shipments.create',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    const result = await ds.runWebhookReceiverTest({
      auth_token: 'src_live_pending_token',
      idempotency_key: 'idem-pending-readback',
      payload: { event_type: 'shipment.created' },
    });

    expect(result.webhook_processing_status).toBe('in_progress');
    expect(result.is_terminal).toBe(false);
    expect(result.tracking_number).toBe('260099PEND');
    expect(result.shipment_id).toBeNull();
    expect(
      mocks.rpc.mock.calls.some(([, args]) => (args as Record<string, unknown>).p_resource === 'shipment_directory'),
    ).toBe(false);
  });

  it('returns workflow-backed webhook mutation readback without waiting for shipment terminal proof', async () => {
    const webhookId = '00000000-0000-4000-8000-000000000305';
    const workflowRunId = '00000000-0000-4000-8000-000000000306';
    const followupWorkflowRunId = '00000000-0000-4000-8000-000000000307';
    let inboxDirectoryReads = 0;

    mocks.invoke.mockResolvedValueOnce({
      data: {
        accepted: true,
        workflow_run_id: workflowRunId,
        followup_workflow_run_id: followupWorkflowRunId,
        webhook_id: webhookId,
        canonical_intent: 'shipment.delete',
        ack_status_code: 202,
        correlation_id: 'idem-mutation-in-progress',
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'workflow_run_steps') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_inbox_directory') {
        inboxDirectoryReads += 1;
        if (inboxDirectoryReads > 1) {
          throw new Error('mutation receiver should not wait for terminal shipment readback');
        }
        return {
          data: {
            rows: [
              {
                id: webhookId,
                workflow_run_id: workflowRunId,
                processing_status: 'in_progress',
                is_terminal: false,
                mapping_target: 'shipments.cancel',
                shipment_id: null,
                tracking_number: '2600MUTATE',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    const result = await ds.runWebhookReceiverTest({
      auth_token: 'src_live_mutation_token',
      idempotency_key: 'idem-mutation-in-progress',
      payload: {
        event: { type: 'shipment.canceled' },
        shipment: { tracking_number: '2600MUTATE' },
      },
    });

    expect(inboxDirectoryReads).toBe(1);
    expect(result.workflow_run_id).toBe(workflowRunId);
    expect(result.followup_workflow_run_id).toBe(followupWorkflowRunId);
    expect(result.canonical_intent).toBe('shipment.delete');
    expect(result.webhook_processing_status).toBe('in_progress');
    expect(result.is_terminal).toBe(false);
    expect(result.shipment_id).toBeNull();
    expect(
      mocks.rpc.mock.calls.some(([, args]) => (args as Record<string, unknown>).p_resource === 'shipment_directory'),
    ).toBe(false);
  });

  it('fails closed when a terminal shipment-create receiver readback has no linked shipment', async () => {
    const webhookId = '00000000-0000-4000-8000-000000000195';
    const workflowRunId = '00000000-0000-4000-8000-000000000196';

    mocks.invoke.mockResolvedValueOnce({
      data: {
        accepted: true,
        workflow_run_id: workflowRunId,
        webhook_id: webhookId,
        canonical_intent: 'shipment.create',
        correlation_id: 'idem-terminal-missing-shipment',
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'workflow_run_steps') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_inbox_directory') {
        return {
          data: {
            rows: [
              {
                id: webhookId,
                processing_status: 'succeeded',
                is_terminal: true,
                mapping_target: 'shipments.create',
                shipment_id: null,
                tracking_number: '260099MISS',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'shipment_directory') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');

    await expect(ds.runWebhookReceiverTest({
      auth_token: 'src_live_terminal_missing_token',
      idempotency_key: 'idem-terminal-missing-shipment',
      payload: { event_type: 'shipment.created' },
    })).rejects.toThrow('webhook-receiver completed shipment.create without shipment readback');
  });

  it('treats shipment.created as shipment-create proof and fails closed without shipment readback', async () => {
    const webhookId = '00000000-0000-4000-8000-000000000295';
    const workflowRunId = '00000000-0000-4000-8000-000000000296';

    mocks.invoke.mockResolvedValueOnce({
      data: {
        accepted: true,
        workflow_run_id: workflowRunId,
        webhook_id: webhookId,
        canonical_intent: 'shipment.created',
        correlation_id: 'idem-terminal-missing-created-alias',
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'workflow_run_steps') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_inbox_directory') {
        return {
          data: {
            rows: [
              {
                id: webhookId,
                processing_status: 'succeeded',
                is_terminal: true,
                mapping_target: 'shipment.created',
                shipment_id: null,
                tracking_number: '260099ALIAS',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'shipment_directory') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');

    await expect(ds.runWebhookReceiverTest({
      auth_token: 'src_live_terminal_missing_alias_token',
      idempotency_key: 'idem-terminal-missing-created-alias',
      payload: { event_type: 'shipment.created' },
    })).rejects.toThrow('webhook-receiver completed shipment.create without shipment readback');
  });

  it('keeps terminal failed shipment-create receiver readback visible without shipment proof', async () => {
    const webhookId = '00000000-0000-4000-8000-000000000197';
    const workflowRunId = '00000000-0000-4000-8000-000000000198';

    mocks.invoke.mockResolvedValueOnce({
      data: {
        accepted: true,
        workflow_run_id: workflowRunId,
        webhook_id: webhookId,
        canonical_intent: 'shipment.create',
        correlation_id: 'idem-terminal-failed-no-shipment',
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'workflow_run_steps') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_inbox_directory') {
        return {
          data: {
            rows: [
              {
                id: webhookId,
                processing_status: 'failed',
                error_message: 'webhook shipment.create did not enqueue shipment materialization workflow',
                is_terminal: true,
                mapping_target: 'shipments.create',
                shipment_id: null,
                tracking_number: '260099FAIL',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'shipment_directory') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    const result = await ds.runWebhookReceiverTest({
      auth_token: 'src_live_terminal_failed_token',
      idempotency_key: 'idem-terminal-failed-no-shipment',
      payload: { event_type: 'shipment.created' },
    });

    expect(result.webhook_processing_status).toBe('failed');
    expect(result.is_terminal).toBe(true);
    expect(result.error_message).toBe('webhook shipment.create did not enqueue shipment materialization workflow');
    expect(result.shipment_id).toBeNull();
    expect(result.tracking_number).toBeNull();
    expect(
      mocks.rpc.mock.calls.some(([, args]) => (args as Record<string, unknown>).p_resource === 'shipment_directory'),
    ).toBe(false);
  });

  it('keeps terminal failed HMAC receiver readback visible when no workflow was started', async () => {
    const webhookId = '00000000-0000-4000-8000-000000000297';

    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'Edge Function returned a non-2xx status code',
        context: {
          json: async () => ({
            accepted: false,
            ack_outcome: 'ack_failed',
            ack_status_code: 400,
            ack_reason: 'HMAC signature mismatch',
            webhook_id: webhookId,
            canonical_intent: 'shipment.create',
            correlation_id: 'idem-terminal-hmac-failed-no-workflow',
            error: { message: 'HMAC signature mismatch' },
          }),
        },
      },
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_inbox_directory') {
        return {
          data: {
            rows: [
              {
                id: webhookId,
                workflow_run_id: null,
                idempotency_key: 'idem-terminal-hmac-failed-no-workflow',
                correlation_id: 'idem-terminal-hmac-failed-no-workflow',
                ack_outcome: 'ack_failed',
                ack_status_code: 400,
                ack_reason: 'HMAC signature mismatch',
                response_outcome: 'response_failed',
                response_status_code: 400,
                response_reason: 'HMAC signature mismatch',
                processing_status: 'failed',
                error_message: 'HMAC signature mismatch',
                is_terminal: true,
                mapping_target: 'shipments.create',
                shipment_id: null,
                tracking_number: null,
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    const result = await ds.runWebhookReceiverTest({
      auth_token: 'src_live_hmac_failed_token',
      idempotency_key: 'idem-terminal-hmac-failed-no-workflow',
      signature: 'not-a-valid-signature',
      payload: { event_type: 'shipment.created' },
    });

    expect(result.workflow_run_id).toBeNull();
    expect(result.webhook_id).toBe(webhookId);
    expect(result.ack_outcome).toBe('ack_failed');
    expect(result.ack_status_code).toBe(400);
    expect(result.ack_reason).toBe('HMAC signature mismatch');
    expect(result.webhook_processing_status).toBe('failed');
    expect(result.is_terminal).toBe(true);
    expect(result.error_message).toBe('HMAC signature mismatch');
    expect(result.shipment_id).toBeNull();
    expect(result.tracking_number).toBeNull();
    expect(
      mocks.rpc.mock.calls.some(([, args]) => (args as Record<string, unknown>).p_resource === 'workflow_run_steps'),
    ).toBe(false);
    expect(
      mocks.rpc.mock.calls.some(([, args]) => (args as Record<string, unknown>).p_resource === 'shipment_directory'),
    ).toBe(false);
  });

  it('returns webhook receiver auth-rejection readback without requiring inbox or workflow evidence', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'Edge Function returned a non-2xx status code',
        context: {
          json: async () => ({
            accepted: false,
            error: 'Unauthorized webhook source',
            status: 401,
            correlation_id: 'idem-webhook-auth-rejected',
          }),
        },
      },
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_auth_rejections') {
        return {
          data: {
            rows: [
              {
                id: 'iar-webhook-auth-rejected',
                service: 'webhook-receiver',
                failure_code: 'retired_webhook_source_token',
                failure_message: 'Retired webhook source token',
                http_status: 401,
                correlation_id: 'idem-webhook-auth-rejected',
                request_id: 'idem-webhook-auth-rejected',
                source_label: 'API Browser Proof Source',
                source_identifier: 'api-browser-proof-source',
                source_resolved: true,
                token_fingerprint: 'sha256:reader-safe-fingerprint',
                rejection_class: 'unauthorized',
                occurred_at: new Date().toISOString(),
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_inbox_directory') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    const result = await ds.runWebhookReceiverTest({
      auth_token: 'src_retired_token',
      idempotency_key: 'idem-webhook-auth-rejected',
      payload: { event_type: 'shipment.created' },
    });

    expect(result.workflow_run_id).toBeNull();
    expect(result.webhook_id).toBeNull();
    expect(result.shipment_id).toBeNull();
    expect(result.ack_status_code).toBe(401);
    expect(result.response_outcome).toBe('auth_rejected');
    expect(result.webhook_processing_status).toBe('auth_rejected');
    expect(result.auth_rejection_id).toBe('iar-webhook-auth-rejected');
    expect(result.auth_rejection_failure_code).toBe('retired_webhook_source_token');
    expect(result.auth_rejection_source_label).toBe('API Browser Proof Source');
    expect(result.auth_rejection_source_resolved).toBe(true);
    expect(
      mocks.rpc.mock.calls.some(([, args]) => (args as Record<string, unknown>).p_resource === 'workflow_run_steps'),
    ).toBe(false);
    expect(
      mocks.rpc.mock.calls.some(([, args]) => (args as Record<string, unknown>).p_resource === 'shipment_directory'),
    ).toBe(false);
  });

  it('uses webhook directory readback when duplicate receiver replay omits workflow_run_id', async () => {
    const webhookId = '00000000-0000-4000-8000-000000000199';
    const workflowRunId = '00000000-0000-4000-8000-000000000200';

    mocks.invoke.mockResolvedValueOnce({
      data: {
        ack_outcome: 'ack_replayed',
        webhook_id: webhookId,
        canonical_intent: 'shipment.create',
        correlation_id: 'idem-terminal-replayed-no-workflow',
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_inbox_directory') {
        return {
          data: {
            rows: [
              {
                id: webhookId,
                workflow_run_id: workflowRunId,
                idempotency_key: 'idem-terminal-replayed-no-workflow',
                ack_outcome: 'ack_replayed',
                ack_status_code: 202,
                ack_reason: 'duplicate delivery replayed from original inbox row',
                processing_status: 'failed',
                error_message: 'execute_shipment_create_v1: missing required webhook shipment recipient/address',
                is_terminal: true,
                mapping_target: 'shipments.create',
                shipment_id: null,
                tracking_number: '260099DUP',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'workflow_run_steps') {
        return {
          data: {
            rows: [
              {
                id: '00000000-0000-4000-8000-000000000201',
                workflow_run_id: workflowRunId,
                handler_key: 'shipment_create',
                step_status: 'failed',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'shipment_directory') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    const result = await ds.runWebhookReceiverTest({
      auth_token: 'src_live_terminal_replay_token',
      idempotency_key: 'idem-terminal-replayed-no-workflow',
      payload: { event_type: 'shipment.created' },
    });

    expect(result.workflow_run_id).toBe(workflowRunId);
    expect(result.idempotency_key).toBe('idem-terminal-replayed-no-workflow');
    expect(result.ack_outcome).toBe('ack_replayed');
    expect(result.ack_status_code).toBe(202);
    expect(result.ack_reason).toBe('duplicate delivery replayed from original inbox row');
    expect(result.webhook_processing_status).toBe('failed');
    expect(result.is_terminal).toBe(true);
    expect(result.error_message).toBe('execute_shipment_create_v1: missing required webhook shipment recipient/address');
    expect(result.shipment_id).toBeNull();
    expect(result.tracking_number).toBeNull();
  });

  it('labels accepted receiver idempotency reuse from canonical response outcome readback', async () => {
    const webhookId = '00000000-0000-4000-8000-000000000299';
    const workflowRunId = '00000000-0000-4000-8000-000000000300';

    mocks.invoke.mockResolvedValueOnce({
      data: {
        status: 'accepted_async',
        webhook_id: webhookId,
        correlation_id: 'idem-existing-accepted-reuse',
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'webhook_inbox_directory') {
        return {
          data: {
            rows: [
              {
                id: webhookId,
                workflow_run_id: workflowRunId,
                idempotency_key: 'idem-existing-accepted-reuse',
                response_outcome: 'response_replayed',
                response_status_code: 202,
                response_reason: 'duplicate delivery replayed from original inbox row',
                processing_status: 'succeeded',
                is_terminal: true,
                mapping_target: 'shipments.create',
                shipment_id: '00000000-0000-4000-8000-000000000302',
                tracking_number: '2600REUSED',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'workflow_run_steps') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      if (rpcName === 'ui_get_resource_v1') {
        return {
          data: {
            id: args.p_id,
            shipment_id: args.p_id,
            tracking_number: '2600REUSED',
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    const result = await ds.runWebhookReceiverTest({
      auth_token: 'src_live_existing_reuse_token',
      idempotency_key: 'idem-existing-accepted-reuse',
      payload: { event_type: 'shipment.created' },
    });

    expect(result.response_outcome).toBe('response_replayed');
    expect(result.receiver_status).toBe(202);
    expect(result.ack_status_code).toBe(202);
    expect(result.ack_reason).toBe('duplicate delivery replayed from original inbox row');
    expect(result.workflow_run_id).toBe(workflowRunId);
    expect(result.tracking_number).toBe('2600REUSED');
  });

  it('runs API Gateway shipment tests through the edge function and requires shipment readback when materialized', async () => {
    const requestId = '00000000-0000-4000-8000-000000000301';
    const shipmentId = '00000000-0000-4000-8000-000000000302';

    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        correlation_id: 'corr-api-gateway-live',
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_requests') {
        return {
          data: {
            rows: [
              {
                id: requestId,
                request_id: requestId,
                correlation_id: 'corr-api-gateway-live',
                method: 'POST',
                path: '/api/ship/request/by-email',
                intake_state: 'shipment_materialized',
                workflow_run_id: '00000000-0000-4000-8000-000000000303',
                outbound_call_id: '00000000-0000-4000-8000-000000000304',
                outbound_status: 'completed',
                shipment_id: shipmentId,
                tracking_number: '2600API001',
                shipment_status: 'created',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      if (rpcName === 'ui_get_resource_v1') {
        return {
          data: {
            id: args.p_id,
            shipment_id: args.p_id,
            tracking_number: '2600API001',
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    const result = await ds.runApiGatewayRequestTest({
      auth_token: 'source-token-api-live',
      method: 'POST',
      path: '/api/ship/request/by-email',
      payload: { receiverName: 'API Receiver' },
      correlation_id: 'corr-api-gateway-live',
      idempotency_key: 'idem-api-gateway-live',
      replay_of: 'req-api-gateway-original',
      expect_shipment: true,
    });

    expect(mocks.invoke).toHaveBeenCalledWith('api-gateway/api/ship/request/by-email', {
      method: 'POST',
      body: { receiverName: 'API Receiver' },
      headers: expect.objectContaining({
        'x-webhook-token': 'source-token-api-live',
        'x-correlation-id': 'corr-api-gateway-live',
        'idempotency-key': 'idem-api-gateway-live',
        'x-masarx-replay-of': 'req-api-gateway-original',
      }),
    });
    expect(mocks.invoke.mock.calls[0]?.[1]?.headers).not.toHaveProperty('content-type');
    expect(result.api_gateway_request_id).toBe(requestId);
    expect(result.shipment_id).toBe(shipmentId);
    expect(result.tracking_number).toBe('2600API001');
    expect(
      mocks.rpc.mock.calls.filter(([, args]) => (args as Record<string, unknown>).p_resource === 'shipments').length,
    ).toBe(1);
    expect(
      mocks.rpc.mock.calls.filter(([, args]) => (args as Record<string, unknown>).p_resource === 'shipment_directory').length,
    ).toBe(1);
  });

  it('fails API Gateway tests when selected source and authenticated request source differ', async () => {
    const requestId = '00000000-0000-4000-8000-000000000329';

    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        correlation_id: 'corr-api-gateway-source-mismatch',
        api_gateway_request_id: requestId,
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_requests') {
        return {
          data: {
            rows: [
              {
                id: requestId,
                request_id: requestId,
                correlation_id: 'corr-api-gateway-source-mismatch',
                method: 'POST',
                path: '/api/ship/request/by-email',
                source_id: 'source-authenticated-token',
                intake_state: 'provider_failed',
                error_code: 'provider_failed',
                outbound_status: 'permanently_failed',
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    await expect(ds.runApiGatewayRequestTest({
      auth_token: 'source-token-api-live',
      source_id: 'source-selected-in-tester',
      method: 'POST',
      path: '/api/ship/request/by-email',
      payload: { receiverName: 'API Receiver' },
      correlation_id: 'corr-api-gateway-source-mismatch',
      idempotency_key: 'idem-api-gateway-source-mismatch',
      expect_shipment: true,
    })).rejects.toThrow(/API Gateway source mismatch: selected source source-selected-in-tester does not match authenticated token source source-authenticated-token/);
  });

  it('waits for terminal API Gateway shipment readback before returning shipment proof', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const requestId = '00000000-0000-4000-8000-000000000331';
    const shipmentId = '00000000-0000-4000-8000-000000000332';
    let requestReads = 0;

    mocks.invoke.mockResolvedValueOnce({
      data: {
        accepted: true,
        correlation_id: 'corr-api-gateway-terminal-wait',
        api_gateway_request_id: requestId,
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_requests') {
        requestReads += 1;
        return {
          data: {
            rows: [
              requestReads === 1
                ? {
                    id: requestId,
                    request_id: requestId,
                    correlation_id: 'corr-api-gateway-terminal-wait',
                    method: 'POST',
                    path: '/api/ship/request/by-email',
                    intake_state: 'workflow_queued',
                    workflow_run_id: '00000000-0000-4000-8000-000000000333',
                    outbound_call_id: null,
                    outbound_status: null,
                    shipment_id: null,
                    tracking_number: null,
                  }
                : {
                    id: requestId,
                    request_id: requestId,
                    correlation_id: 'corr-api-gateway-terminal-wait',
                    method: 'POST',
                    path: '/api/ship/request/by-email',
                    intake_state: 'shipment_materialized',
                    workflow_run_id: '00000000-0000-4000-8000-000000000333',
                    outbound_call_id: '00000000-0000-4000-8000-000000000334',
                    outbound_status: 'completed',
                    shipment_id: shipmentId,
                    tracking_number: '2600API331',
                    shipment_status: 'created',
                  },
            ],
            total: 1,
          },
          error: null,
        };
      }
      if (rpcName === 'ui_get_resource_v1') {
        return {
          data: {
            id: args.p_id,
            shipment_id: args.p_id,
            tracking_number: '2600API331',
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    try {
      const ds = await import('../data-source');
      const promise = ds.runApiGatewayRequestTest({
        auth_token: 'source-token-api-terminal-wait',
        method: 'POST',
        path: '/api/ship/request/by-email',
        payload: { receiverName: 'Terminal Wait Receiver' },
        correlation_id: 'corr-api-gateway-terminal-wait',
        idempotency_key: 'idem-api-gateway-terminal-wait',
        expect_shipment: true,
      });

      await vi.advanceTimersByTimeAsync(1_500);
      const result = await promise;

      expect(requestReads).toBeGreaterThanOrEqual(2);
      expect(result.intake_state).toBe('shipment_materialized');
      expect(result.shipment_id).toBe(shipmentId);
      expect(result.tracking_number).toBe('2600API331');
      expect(
        mocks.rpc.mock.calls.filter(([, args]) => (args as Record<string, unknown>).p_resource === 'shipments').length,
      ).toBe(1);
      expect(
        mocks.rpc.mock.calls.filter(([, args]) => (args as Record<string, unknown>).p_resource === 'shipment_directory').length,
      ).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns API Gateway request readback promptly while workflow processing is still pending without fake shipment proof', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const requestId = '00000000-0000-4000-8000-000000000307';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        accepted: true,
        correlation_id: 'corr-api-gateway-queued',
        api_gateway_request_id: requestId,
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_requests') {
        return {
          data: {
            rows: [
              {
                id: requestId,
                request_id: requestId,
                correlation_id: 'corr-api-gateway-queued',
                method: 'POST',
                path: '/api/ship/request/by-email',
                intake_state: 'workflow_queued',
                workflow_run_id: '00000000-0000-4000-8000-000000000308',
                outbound_call_id: null,
                outbound_status: null,
                shipment_id: null,
                tracking_number: null,
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    try {
      const ds = await import('../data-source');
      const promise = ds.runApiGatewayRequestTest({
        auth_token: 'source-token-api-queued',
        method: 'POST',
        path: '/api/ship/request/by-email',
        payload: { receiverName: 'Queued Receiver' },
        correlation_id: 'corr-api-gateway-queued',
        idempotency_key: 'idem-api-gateway-queued',
        expect_shipment: true,
      });

      await vi.advanceTimersByTimeAsync(6_000);
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(result.api_gateway_request_id).toBe(requestId);
      expect(result.workflow_run_id).toBe('00000000-0000-4000-8000-000000000308');
      expect(result.intake_state).toBe('workflow_queued');
      expect(result.shipment_id).toBeNull();
      expect(result.tracking_number).toBeNull();
      expect(result.request_readback).toMatchObject({
        request_id: requestId,
        intake_state: 'workflow_queued',
        shipment_id: null,
        tracking_number: null,
      });
      expect(
        mocks.rpc.mock.calls.filter(([, args]) => (args as Record<string, unknown>).p_resource === 'api_gateway_requests').length,
      ).toBeGreaterThan(1);
      expect(
        mocks.rpc.mock.calls.some(([, args]) => (
          (args as Record<string, unknown>).p_resource === 'shipments'
          || (args as Record<string, unknown>).p_resource === 'shipment_directory'
        )),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps API Gateway provider failures visible without fake shipment proof', async () => {
    const requestId = '00000000-0000-4000-8000-000000000305';
    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'FunctionsHttpError',
        context: {
          json: async () => ({ error: { message: 'Provider validation failed' } }),
        },
      },
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_requests') {
        return {
          data: {
            rows: [
              {
                id: requestId,
                request_id: requestId,
                correlation_id: 'corr-api-gateway-failed',
                method: 'POST',
                path: '/api/ship/request/by-email',
                status_code: 422,
                error_code: 'validation_failed',
                intake_state: 'provider_failed',
                outbound_status: 'failed',
                shipment_id: null,
                tracking_number: null,
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    const result = await ds.runApiGatewayRequestTest({
      auth_token: 'source-token-api-failed',
      method: 'POST',
      path: '/api/ship/request/by-email',
      payload: { bad: true },
      correlation_id: 'corr-api-gateway-failed',
      idempotency_key: 'idem-api-gateway-failed',
      expect_shipment: true,
    });

    expect(result.ok).toBe(false);
    expect(result.api_gateway_request_id).toBe(requestId);
    expect(result.intake_state).toBe('provider_failed');
    expect(result.error_code).toBe('validation_failed');
    expect(result.shipment_id).toBeNull();
    expect(
      mocks.rpc.mock.calls.some(([, args]) => (args as Record<string, unknown>).p_resource === 'shipments'),
    ).toBe(false);
  });

  it('fails API Gateway tests from backend auth-rejection readback without waiting for request rows', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'name resolution failed' },
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_auth_rejections') {
        expect((args.p_filters as Record<string, unknown>).correlation_id).toBe('corr-api-gateway-invalid-token');
        return {
          data: {
            rows: [
              {
                id: '00000000-0000-4000-8000-000000000309',
                service: 'api_gateway',
                failure_code: 'invalid_token',
                failure_message: 'API gateway source token was invalid or disabled.',
                http_status: 401,
                correlation_id: 'corr-api-gateway-invalid-token',
                method: 'POST',
                path: '/api/ship/request/by-email',
                occurred_at: new Date().toISOString(),
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    await expect(ds.runApiGatewayRequestTest({
      auth_token: 'source-token-api-invalid',
      method: 'POST',
      path: '/api/ship/request/by-email',
      payload: { receiverName: 'Invalid Token Receiver' },
      correlation_id: 'corr-api-gateway-invalid-token',
      idempotency_key: 'idem-api-gateway-invalid-token',
      expect_shipment: true,
    })).rejects.toThrow(/API Gateway auth rejected by backend readback.*401.*invalid_token/);

    expect(
      mocks.rpc.mock.calls.some(([, args]) => (
        (args as Record<string, unknown>).p_resource === 'api_gateway_requests'
      )),
    ).toBe(false);
  });

  it('fails API Gateway tests from exact auth-rejection readback when edge returns an empty unauthorized body', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {},
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_auth_rejections') {
        expect((args.p_filters as Record<string, unknown>).correlation_id).toBe('corr-api-gateway-empty-401');
        return {
          data: {
            rows: [
              {
                id: '00000000-0000-4000-8000-000000000310',
                service: 'api_gateway',
                failure_code: 'invalid_token',
                failure_message: 'invalid_token',
                http_status: 401,
                correlation_id: 'corr-api-gateway-empty-401',
                method: 'POST',
                path: '/api/codex/readiness/ship/1778436135990',
                occurred_at: new Date().toISOString(),
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    await expect(ds.runApiGatewayRequestTest({
      auth_token: 'source-token-api-empty-401',
      method: 'POST',
      path: '/api/codex/readiness/ship/1778436135990',
      payload: { receiverName: 'Empty Auth Body Receiver' },
      correlation_id: 'corr-api-gateway-empty-401',
      idempotency_key: 'idem-api-gateway-empty-401',
      expect_shipment: true,
    })).rejects.toThrow(/API Gateway auth rejected by backend readback.*401.*invalid_token/);

    expect(
      mocks.rpc.mock.calls.some(([, args]) => (
        (args as Record<string, unknown>).p_resource === 'api_gateway_requests'
      )),
    ).toBe(false);
  });

  it('uses direct Edge fetch for API Gateway tests when browser env is configured', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://edge.local');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    vi.stubEnv('VITE_API_GATEWAY_DIRECT_FETCH_TEST', '1');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        error: 'invalid_token',
        correlation_id: 'corr-api-gateway-direct-401',
      })),
    });
    vi.stubGlobal('fetch', fetchMock);
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_auth_rejections') {
        expect((args.p_filters as Record<string, unknown>).correlation_id).toBe('corr-api-gateway-direct-401');
        return {
          data: {
            rows: [
              {
                id: '00000000-0000-4000-8000-000000000311',
                service: 'api_gateway',
                failure_code: 'invalid_token',
                failure_message: 'invalid_token',
                http_status: 401,
                correlation_id: 'corr-api-gateway-direct-401',
                method: 'POST',
                path: '/api/ship/request/by-email',
                occurred_at: new Date().toISOString(),
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    await expect(ds.runApiGatewayRequestTest({
      auth_token: 'source-token-api-direct-401',
      method: 'POST',
      path: '/api/ship/request/by-email',
      payload: { receiverName: 'Direct Fetch Auth Receiver' },
      correlation_id: 'corr-api-gateway-direct-401',
      idempotency_key: 'idem-api-gateway-direct-401',
      expect_shipment: true,
    })).rejects.toThrow(/API Gateway auth rejected by backend readback.*401.*invalid_token/);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://edge.local/functions/v1/api-gateway/api/ship/request/by-email',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'anon-key',
          authorization: 'Bearer anon-key',
          'x-webhook-token': 'source-token-api-direct-401',
        }),
      }),
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('fails API Gateway tests from edge auth errors when tenant-scoped rejection readback is not visible', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://edge.local');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    vi.stubEnv('VITE_API_GATEWAY_DIRECT_FETCH_TEST', '1');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        error: 'invalid_token',
        correlation_id: 'corr-api-gateway-direct-unscoped-401',
      })),
    });
    vi.stubGlobal('fetch', fetchMock);
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_auth_rejections') {
        expect((args.p_filters as Record<string, unknown>).correlation_id).toBe('corr-api-gateway-direct-unscoped-401');
        return { data: { rows: [], total: 0 }, error: null };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    await expect(ds.runApiGatewayRequestTest({
      auth_token: 'source-token-api-direct-unscoped-401',
      method: 'POST',
      path: '/api/codex/readiness/ship/1778436135990',
      payload: { receiverName: 'Direct Fetch Unscoped Auth Receiver' },
      correlation_id: 'corr-api-gateway-direct-unscoped-401',
      idempotency_key: 'idem-api-gateway-direct-unscoped-401',
      expect_shipment: true,
    })).rejects.toThrow(/API Gateway auth rejected by edge response.*401.*invalid_token/);

    expect(
      mocks.rpc.mock.calls.some(([, args]) => (
        (args as Record<string, unknown>).p_resource === 'api_gateway_requests'
      )),
    ).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('fails closed when the API Gateway edge request never returns and no backend request readback appears', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    mocks.invoke.mockReturnValue(new Promise(() => {}));
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_requests') {
        return { data: { rows: [], total: 0 }, error: null };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    try {
      const ds = await import('../data-source');
      const promise = ds.runApiGatewayRequestTest({
        auth_token: 'source-token-api-timeout',
        method: 'POST',
        path: '/api/ship/request/by-email',
        payload: { receiverName: 'Timeout Receiver' },
        correlation_id: 'corr-api-gateway-timeout',
        idempotency_key: 'idem-api-gateway-timeout',
        expect_shipment: true,
      });

      const rejection = expect(promise).rejects.toThrow('api-gateway request timed out before backend response completed');
      await vi.advanceTimersByTimeAsync(46_000);
      await rejection;
      expect(mocks.invoke).toHaveBeenCalledWith('api-gateway/api/ship/request/by-email', expect.any(Object));
      expect(
        mocks.rpc.mock.calls.some(([, args]) => (
          (args as Record<string, unknown>).p_resource === 'api_gateway_requests'
          && ((args as Record<string, unknown>).p_filters as Record<string, unknown>)?.correlation_id === 'corr-api-gateway-timeout'
        )),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns API Gateway timeout request readback without fake shipment proof when edge response hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    mocks.invoke.mockReturnValue(new Promise(() => {}));
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_requests') {
        return {
          data: {
            rows: [
              {
                id: 'req_api_gateway_timeout_readback',
                request_id: 'req_api_gateway_timeout_readback',
                correlation_id: 'corr-api-gateway-timeout-readback',
                method: 'POST',
                path: '/api/ship/request/by-email',
                status_code: 504,
                intake_state: 'timeout',
                error_code: 'provider_timeout',
                outbound_error_message: 'provider dispatch timed out after route timeout policy',
                workflow_run_id: 'wfr_api_gateway_timeout_readback',
                outbound_call_id: 'obc_api_gateway_timeout_readback',
                outbound_status: 'timed_out',
                shipment_id: null,
                tracking_number: null,
                occurred_at: new Date(Date.now()).toISOString(),
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    try {
      const ds = await import('../data-source');
      const promise = ds.runApiGatewayRequestTest({
        auth_token: 'source-token-api-timeout',
        method: 'POST',
        path: '/api/ship/request/by-email',
        payload: { receiverName: 'Timeout Receiver' },
        correlation_id: 'corr-api-gateway-timeout-readback',
        idempotency_key: 'idem-api-gateway-timeout-readback',
        expect_shipment: true,
      });

      await vi.advanceTimersByTimeAsync(46_000);
      const result = await promise;
      expect(result.api_gateway_request_id).toBe('req_api_gateway_timeout_readback');
      expect(result.intake_state).toBe('timeout');
      expect(result.outbound_status).toBe('timed_out');
      expect(result.error_code).toBe('provider_timeout');
      expect(result.outbound_error_message).toBe('provider dispatch timed out after route timeout policy');
      expect(result.workflow_run_id).toBe('wfr_api_gateway_timeout_readback');
      expect(result.outbound_call_id).toBe('obc_api_gateway_timeout_readback');
      expect(result.shipment_id).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when API Gateway marks shipment materialized without canonical shipment readback', async () => {
    const requestId = '00000000-0000-4000-8000-000000000306';
    mocks.invoke.mockResolvedValueOnce({
      data: { ok: true, correlation_id: 'corr-api-gateway-missing-shipment' },
      error: null,
    });
    mocks.rpc.mockImplementation(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'ui_list_resource_v1' && args.p_resource === 'api_gateway_requests') {
        return {
          data: {
            rows: [
              {
                id: requestId,
                request_id: requestId,
                correlation_id: 'corr-api-gateway-missing-shipment',
                method: 'POST',
                path: '/api/ship/request/by-email',
                intake_state: 'shipment_materialized',
                shipment_id: null,
                tracking_number: null,
              },
            ],
            total: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${rpcName}:${String(args.p_resource ?? '')}`);
    });

    const ds = await import('../data-source');
    await expect(ds.runApiGatewayRequestTest({
      auth_token: 'source-token-api-missing',
      method: 'POST',
      path: '/api/ship/request/by-email',
      payload: { receiverName: 'Missing Shipment' },
      correlation_id: 'corr-api-gateway-missing-shipment',
      idempotency_key: 'idem-api-gateway-missing-shipment',
      expect_shipment: true,
    })).rejects.toThrow('api-gateway materialized shipment without canonical shipment readback');
  });

  it('requires import prepare dry-run and matched mapping readback', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        dry_run: {
          run_id: '00000000-0000-4000-8000-000000000030',
          resource_key: 'shipments',
        },
        profile_match: {
          mapping_config_id: '00000000-0000-4000-8000-000000000031',
        },
        available_profiles: [],
        resolved_rules: [],
        correlation_id: '00000000-0000-4000-8000-000000000032',
      },
      error: null,
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000030',
          status: 'prepared',
          resource_key: 'shipments',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000031', mapping_key: 'shipments.import.default' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000031', mapping_key: 'shipments.import.default', is_active: true },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.resource_import_studio_prepare_v1({
      file: new File(['awb\nSHP-1'], 'shipments.csv', { type: 'text/csv' }),
      resource_key: 'shipments',
    });

    expect(mocks.invoke).toHaveBeenCalledWith('resource-import-studio', {
      body: expect.any(FormData),
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_get_tabular_import_run_v1', {
      p_run_id: '00000000-0000-4000-8000-000000000030',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'mapping_config_directory',
      p_id: '00000000-0000-4000-8000-000000000031',
    });
  });

  it('fails closed when import prepare readback is not prepared', async () => {
    const runId = '00000000-0000-4000-8000-000000000342';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        dry_run: {
          run_id: runId,
          resource_key: 'shipments',
        },
        profile_match: null,
        available_profiles: [],
        resolved_rules: [],
        correlation_id: 'cor_import_prepare_stale',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: runId,
        status: 'queued',
        resource_key: 'shipments',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.resource_import_studio_prepare_v1({
      file: new File(['awb\nSHP-1'], 'shipments.csv', { type: 'text/csv' }),
      resource_key: 'shipments',
    }))
      .rejects
      .toThrow(`resource-import-studio/prepare backend readback status mismatch for tabular_import_runs:${runId}`);
  });

  it('reconciles import prepare validation from canonical run readback when edge dry-run is stale', async () => {
    const runId = '00000000-0000-4000-8000-000000000350';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        dry_run: {
          run_id: runId,
          resource_key: 'shipments',
          total_rows: 1,
          will_create: 1,
          blocked_count: 0,
          warning_count: 0,
          blocking_diagnostics: [],
        },
        profile_match: null,
        available_profiles: [],
        resolved_rules: [],
        correlation_id: 'cor_import_prepare_related_blocked',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: runId,
        status: 'prepared',
        resource_key: 'shipments',
        total_rows: 1,
        will_create: 0,
        blocked_count: 1,
        warning_count: 0,
        rows: [
          {
            row_number: 1,
            status: 'blocked',
          },
        ],
        summary: {
          blocking_diagnostics: [
            {
              row: 1,
              fieldPath: 'destination_address.province',
              code: 'related_required_field_missing',
              message: 'Required related field destination_address.province is missing on row 1.',
              blocking: true,
            },
          ],
          related_node_summary: [
            {
              node_key: 'destination_address',
              target_resource: 'addresses',
              blocked_count: 1,
            },
          ],
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.resource_import_studio_prepare_v1({
      file: new File(['tracking_number,address_line_1\nMX-1,King Fahd Road'], 'shipments.csv', { type: 'text/csv' }),
      resource_key: 'shipments',
    });

    expect(result.dry_run.blocked_count).toBe(1);
    expect(result.dry_run.will_create).toBe(0);
    expect(result.dry_run.blocking_diagnostics).toEqual([
      expect.objectContaining({
        fieldPath: 'destination_address.province',
        code: 'related_required_field_missing',
      }),
    ]);
    expect(result.dry_run.related_nodes).toEqual([
      expect.objectContaining({
        node_key: 'destination_address',
        blocked_count: 1,
      }),
    ]);
    expect(result.dry_run.rows).toEqual([
      expect.objectContaining({
        row_number: 1,
        status: 'blocked',
      }),
    ]);
  });

  it('requires queued tabular import task readback after live import start', async () => {
    const runId = '00000000-0000-4000-8000-000000000343';
    const taskId = '00000000-0000-4000-8000-000000000344';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        run: {
          id: runId,
          status: 'queued',
          task_id: taskId,
        },
        report: null,
        correlation_id: 'cor_import_start',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: runId,
        status: 'queued',
        task_id: taskId,
      },
      error: null,
    });

    const ds = await import('../data-source');
    await ds.resource_import_studio_start_v1({ run_id: runId });

    expect(mocks.invoke).toHaveBeenCalledWith('resource-import-studio', {
      body: {
        action: 'start',
        run_id: runId,
        save_profile: null,
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_get_tabular_import_run_v1', {
      p_run_id: runId,
    });
  });

  it('recovers import start when the edge response fails after backend queued the run', async () => {
    const runId = '00000000-0000-4000-8000-000000000349';
    const taskId = '00000000-0000-4000-8000-000000000350';
    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'An invalid response was received from the upstream server',
      },
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: runId,
        status: 'queued',
        task_id: taskId,
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: runId,
        status: 'queued',
        task_id: taskId,
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.resource_import_studio_start_v1({ run_id: runId });

    expect(result.run.id).toBe(runId);
    expect(result.run.status).toBe('queued');
    expect(result.run.recovered_from_edge_error).toContain('invalid response');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_tabular_import_run_v1', {
      p_run_id: runId,
    });
  });

  it('fails closed when import start readback is still prepared', async () => {
    const runId = '00000000-0000-4000-8000-000000000345';
    const taskId = '00000000-0000-4000-8000-000000000346';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        run: {
          id: runId,
          status: 'queued',
          task_id: taskId,
        },
        report: null,
        correlation_id: 'cor_import_start_stale',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: runId,
        status: 'prepared',
        task_id: taskId,
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.resource_import_studio_start_v1({ run_id: runId }))
      .rejects
      .toThrow(`resource-import-studio/start backend readback status mismatch for tabular_import_runs:${runId}`);
  });

  it('fails closed when import start readback has no task', async () => {
    const runId = '00000000-0000-4000-8000-000000000347';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        run: {
          id: runId,
          status: 'queued',
        },
        report: null,
        correlation_id: 'cor_import_start_missing_task',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: runId,
        status: 'queued',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.resource_import_studio_start_v1({ run_id: runId }))
      .rejects
      .toThrow(`resource-import-studio/start backend readback missing task for tabular_import_runs:${runId}`);
  });

  it('requires canceled tabular import run readback after live import file-run cancel', async () => {
    const runId = '00000000-0000-4000-8000-000000000340';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        run: {
          id: runId,
          status: 'canceled',
          summary: {
            cancellation: {
              reason: 'operator confirmed duplicate file run',
            },
            cancel_reason: 'operator confirmed duplicate file run',
          },
        },
        correlation_id: 'cor_import_file_run_cancel',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: runId,
        status: 'canceled',
        summary: {
          cancellation: {
            reason: 'operator confirmed duplicate file run',
          },
          cancel_reason: 'operator confirmed duplicate file run',
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    await ds.resource_import_studio_cancel_v1({
      run_id: runId,
      reason: 'operator confirmed duplicate file run',
    });

    expect(mocks.invoke).toHaveBeenCalledWith('resource-import-studio', {
      body: {
        action: 'cancel',
        run_id: runId,
        reason: 'operator confirmed duplicate file run',
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_get_tabular_import_run_v1', {
      p_run_id: runId,
    });
  });

  it('fails closed when live import file-run cancel reason is missing', async () => {
    const runId = '00000000-0000-4000-8000-000000000342';
    const ds = await import('../data-source');
    await expect(ds.resource_import_studio_cancel_v1({ run_id: runId, reason: '' }))
      .rejects
      .toThrow('resource-import-studio/cancel requires reason');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('fails closed when live import file-run cancel readback is not canceled', async () => {
    const runId = '00000000-0000-4000-8000-000000000341';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        run: {
          id: runId,
          status: 'canceled',
          summary: {
            cancellation: {
              reason: 'operator confirmed duplicate file run',
            },
            cancel_reason: 'operator confirmed duplicate file run',
          },
        },
        correlation_id: 'cor_import_file_run_cancel_stale',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: runId,
        status: 'queued',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.resource_import_studio_cancel_v1({
      run_id: runId,
      reason: 'operator confirmed duplicate file run',
    }))
      .rejects
      .toThrow(`resource-import-studio/cancel backend readback status mismatch for tabular_import_runs:${runId}`);
  });

  it('fails closed when live import file-run cancel reason readback differs', async () => {
    const runId = '00000000-0000-4000-8000-000000000348';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        run: {
          id: runId,
          status: 'canceled',
          summary: {
            cancellation: {
              reason: 'operator confirmed duplicate file run',
            },
            cancel_reason: 'operator confirmed duplicate file run',
          },
        },
        correlation_id: 'cor_import_file_run_cancel_reason_mismatch',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: runId,
        status: 'canceled',
        summary: {
          cancellation: {
            reason: 'different backend reason',
          },
          cancel_reason: 'different backend reason',
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.resource_import_studio_cancel_v1({
      run_id: runId,
      reason: 'operator confirmed duplicate file run',
    }))
      .rejects
      .toThrow(`resource-import-studio/cancel backend readback reason mismatch for tabular_import_runs:${runId}`);
  });

  it('requires cancellation reason and cancelled import job readback after live import cancel', async () => {
    const importJobId = '00000000-0000-4000-8000-000000000330';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          import_job_id: importJobId,
          status: 'cancelled',
          correlation_id: 'cor_import_cancel',
          settings_resolution_id: 'srlv_import_cancel',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: importJobId,
          status: 'cancelled',
          cancelled_reason: 'operator confirmed duplicate file',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: importJobId,
          status: 'cancelled',
          cancelled_reason: 'operator confirmed duplicate file',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.import_job_cancel_v1({
      import_job_id: importJobId,
      reason: 'operator confirmed duplicate file',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'import_job_cancel_v1', {
      p_args: {
        import_job_id: importJobId,
        reason: 'operator confirmed duplicate file',
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'import_jobs',
      p_id: importJobId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'import_job_directory',
      p_id: importJobId,
    });
  });

  it('fails closed when live import cancel lacks operator reason', async () => {
    const ds = await import('../data-source');
    await expect(ds.import_job_cancel_v1({
      import_job_id: '00000000-0000-4000-8000-000000000331',
    })).rejects.toThrow('import_job_cancel_v1 requires cancellation reason');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('fails closed when live import cancel readback is not cancelled', async () => {
    const importJobId = '00000000-0000-4000-8000-000000000332';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          import_job_id: importJobId,
          status: 'cancelled',
          correlation_id: 'cor_import_cancel_stale_status',
          settings_resolution_id: 'srlv_import_cancel_stale_status',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: importJobId,
          status: 'running',
          cancelled_reason: 'operator cancelled stale run',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.import_job_cancel_v1({
      import_job_id: importJobId,
      reason: 'operator cancelled stale run',
    })).rejects.toThrow(`import_job_cancel_v1 backend readback status mismatch for import_jobs:${importJobId}`);
  });

  it('fails closed when live import cancel readback reason does not match submitted reason', async () => {
    const importJobId = '00000000-0000-4000-8000-000000000333';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          import_job_id: importJobId,
          status: 'cancelled',
          correlation_id: 'cor_import_cancel_reason_mismatch',
          settings_resolution_id: 'srlv_import_cancel_reason_mismatch',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: importJobId,
          status: 'cancelled',
          cancelled_reason: 'different reason',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.import_job_cancel_v1({
      import_job_id: importJobId,
      reason: 'operator cancelled wrong upload',
    })).rejects.toThrow(`import_job_cancel_v1 backend readback cancellation reason mismatch for import_jobs:${importJobId}`);
  });

  it('requires invoice and invoice-directory readback after billing invoice creation', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          billing_invoice_id: '00000000-0000-4000-8000-000000000030',
          status: 'draft',
          correlation_id: '00000000-0000-4000-8000-000000000034',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000030', status: 'draft' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000030', invoice_number: 'INV-30', status: 'draft' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.create_billing_invoice_v1({
      client_id: '00000000-0000-4000-8000-000000000035',
      currency: 'SAR',
      lines: [{ description: 'Delivery', amount: 100 }],
    });

    expect(result).toMatchObject({ billing_invoice_id: '00000000-0000-4000-8000-000000000030' });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'billing_invoices',
      p_id: '00000000-0000-4000-8000-000000000030',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'billing_invoice_directory',
      p_id: '00000000-0000-4000-8000-000000000030',
    });
  });

  it('fails closed when billing invoice creation lacks invoice readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          billing_invoice_id: '00000000-0000-4000-8000-000000000030',
          correlation_id: '00000000-0000-4000-8000-000000000034',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.create_billing_invoice_v1({
      client_id: '00000000-0000-4000-8000-000000000035',
      currency: 'SAR',
    })).rejects.toThrow('create_billing_invoice_v1 backend readback missing billing_invoices');
  });

  it('routes finance bulk invoice send through the canonical api RPC', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          operation: 'billing_invoice_send',
          succeeded_count: 2,
          failed_count: 0,
          results: [],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000031', status: 'sent' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000031', status: 'sent', invoice_number: 'INV-31' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000032', status: 'sent' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000032', status: 'sent', invoice_number: 'INV-32' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_bulk_billing_invoice_send_v1({
      billing_invoice_ids: [
        '00000000-0000-4000-8000-000000000031',
        '00000000-0000-4000-8000-000000000032',
      ],
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_bulk_billing_invoice_send_v1', {
      p_args: {
        billing_invoice_ids: [
          '00000000-0000-4000-8000-000000000031',
          '00000000-0000-4000-8000-000000000032',
        ],
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'billing_invoices',
      p_id: '00000000-0000-4000-8000-000000000031',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'billing_invoice_directory',
      p_id: '00000000-0000-4000-8000-000000000032',
    });
    expect(result).toMatchObject({ ok: true, succeeded_count: 2 });
  });

  it('fails closed when bulk invoice send lacks invoice directory readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          operation: 'billing_invoice_send',
          succeeded_count: 1,
          failed_count: 0,
          results: [],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000031', status: 'sent' },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_bulk_billing_invoice_send_v1({
      billing_invoice_ids: ['00000000-0000-4000-8000-000000000031'],
    })).rejects.toThrow('ui_bulk_billing_invoice_send_v1 backend readback missing billing_invoice_directory');
  });

  it('routes finance bulk dispute actions through the canonical api RPC', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          operation: 'resolve',
          succeeded_count: 1,
          failed_count: 0,
          results: [],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000033', status: 'resolved' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000033', status: 'resolved', subject: 'Invoice dispute' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_bulk_dispute_action_v1({
      dispute_ids: ['00000000-0000-4000-8000-000000000033'],
      operation: 'resolve',
      resolution: 'credit',
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_bulk_dispute_action_v1', {
      p_args: {
        dispute_ids: ['00000000-0000-4000-8000-000000000033'],
        operation: 'resolve',
        resolution: 'credit',
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'marketplace_disputes',
      p_id: '00000000-0000-4000-8000-000000000033',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'dispute_directory',
      p_id: '00000000-0000-4000-8000-000000000033',
    });
    expect(result).toMatchObject({ ok: true, operation: 'resolve' });
  });

  it('fails closed when dispute bulk action lacks dispute directory readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          operation: 'resolve',
          succeeded_count: 1,
          failed_count: 0,
          results: [],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000033', status: 'resolved' },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_bulk_dispute_action_v1({
      dispute_ids: ['00000000-0000-4000-8000-000000000033'],
      operation: 'resolve',
      resolution: 'credit',
    })).rejects.toThrow('ui_bulk_dispute_action_v1 backend readback missing dispute_directory');
  });

  it('maps shipment amend/cancel calls to the canonical live p_input envelope', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          workflow_template: 'shipment_modify_v1',
          workflow_run_id: '00000000-0000-4000-8000-000000000021',
          dry_run: false,
          settings_resolution_id: '00000000-0000-4000-8000-000000000022',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000020', status: 'ready' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000020', status: 'ready', directory_projection: true },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.shipment_amend_cancel_v1(
      '00000000-0000-4000-8000-000000000020',
      'amend_field',
      { status: 'ready' },
      { dryRun: false },
    );

    expect(mocks.rpc).toHaveBeenCalledWith('shipment_amend_cancel_v1', {
      p_input: {
        shipment_id: '00000000-0000-4000-8000-000000000020',
        operation: 'modify',
        surface: 'console',
        dry_run: false,
        changes: { status: 'ready' },
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipments',
      p_id: '00000000-0000-4000-8000-000000000020',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipment_directory',
      p_id: '00000000-0000-4000-8000-000000000020',
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_runs',
      p_id: '00000000-0000-4000-8000-000000000021',
    });
  });

  it('accepts real shipment cancel responses that expose workflow template through workflow readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          operation: 'cancel',
          shipment_id: '00000000-0000-4000-8000-000000000120',
          workflow_run_id: '00000000-0000-4000-8000-000000000121',
          workflow_status: 'completed',
          workflow_step_status: 'completed',
          operation_result: {
            shipment_action_id: '00000000-0000-4000-8000-000000000122',
            status: 'cancelled',
          },
          shipment_action_id: '00000000-0000-4000-8000-000000000122',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000121',
          workflow_status: 'completed',
          workflow_template_id: '00000000-0000-4000-8000-000000000123',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000120',
          status: 'cancelled',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000120',
          status: 'cancelled',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000122',
          action_type: 'delete',
          canonical_status: 'cancelled',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.shipment_amend_cancel_v1(
      '00000000-0000-4000-8000-000000000120',
      'cancel',
      { reason: 'console_v2.shipments.cancel_preview_modal' },
      { dryRun: false },
    );

    expect(result.workflow_template).toBe('00000000-0000-4000-8000-000000000123');
    expect(result.workflow_run_id).toBe('00000000-0000-4000-8000-000000000121');
    expect(result.canonical_entrypoint).toBe('progress_workflow_run');
    expect(mocks.rpc).toHaveBeenCalledWith('shipment_amend_cancel_v1', {
      p_input: {
        shipment_id: '00000000-0000-4000-8000-000000000120',
        operation: 'cancel',
        surface: 'console',
        dry_run: false,
        reason: 'console_v2.shipments.cancel_preview_modal',
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_runs',
      p_id: '00000000-0000-4000-8000-000000000121',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipment_actions',
      p_id: '00000000-0000-4000-8000-000000000122',
    });
  });

  it('requires drawer-visible address readback after live shipment address edits', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          workflow_template: 'shipment_address_update_v1',
          workflow_run_id: '00000000-0000-4000-8000-000000000041',
          dry_run: false,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000040',
          destination_address_id: '00000000-0000-4000-8000-000000000042',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000040',
          destination_address_id: '00000000-0000-4000-8000-000000000042',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000041', workflow_status: 'in_progress' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000042', line1: 'Backend Street 9' },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.shipment_amend_cancel_v1(
      '00000000-0000-4000-8000-000000000040',
      'address',
      { address: { line1: 'Backend Street 9', city: 'Riyadh' } },
      { dryRun: false },
    );

    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipment_directory',
      p_id: '00000000-0000-4000-8000-000000000040',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'addresses',
      p_id: '00000000-0000-4000-8000-000000000042',
    });
  });

  it('requires shipment-box readback after live shipment box edits', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          workflow_template: 'shipment_modify_v1',
          workflow_run_id: '00000000-0000-4000-8000-000000000051',
          dry_run: false,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000050', status: 'ready' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000050', box_actual_count: 1 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000051', workflow_status: 'in_progress' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000052', weight_kg: 2.5 },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.shipment_amend_cancel_v1(
      '00000000-0000-4000-8000-000000000050',
      'modify',
      {
        changes: {
          boxes: {
            '00000000-0000-4000-8000-000000000052': { weight_kg: 2.5 },
          },
        },
      },
      { dryRun: false },
    );

    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipment_boxes',
      p_id: '00000000-0000-4000-8000-000000000052',
    });
  });

  it('fails closed when live address edits cannot resolve an address readback id', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          workflow_template: 'shipment_address_update_v1',
          workflow_run_id: '00000000-0000-4000-8000-000000000061',
          dry_run: false,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000060' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000060' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000061', workflow_status: 'in_progress' },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.shipment_amend_cancel_v1(
      '00000000-0000-4000-8000-000000000060',
      'address',
      { address: { line1: 'Missing destination address id' } },
      { dryRun: false },
    )).rejects.toThrow('shipment_amend_cancel_v1 did not expose destination_address_id for address readback');
  });

  it('routes manual shipment creation through live RPC without frontend service-type literals', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'shipment_created',
          shipment_id: '00000000-0000-4000-8000-000000000025',
          recipient_id: '00000000-0000-4000-8000-000000000028',
          label_job_id: '00000000-0000-4000-8000-000000000029',
          shipment_result: {
            workflow_run_id: '00000000-0000-4000-8000-000000000026',
            workflow_template_id: '00000000-0000-4000-8000-000000000027',
            tracking_number: 'SHP-LIVE-025',
            correlation_id: '00000000-0000-4000-8000-000000000030',
            operation: 'inserted',
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000025',
          tracking_number: 'SHP-LIVE-025',
          recipient_id: '00000000-0000-4000-8000-000000000028',
          destination_address_id: '00000000-0000-4000-8000-000000000035',
          branch_id: '00000000-0000-4000-8000-000000000038',
          zone_id: '00000000-0000-4000-8000-000000000040',
          service_level: 'standard',
          metadata: {
            service_offering_branch_id: '00000000-0000-4000-8000-000000000038',
            service_offering_zone_id: '00000000-0000-4000-8000-000000000040',
            service_level_key: 'standard',
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000025',
          tracking_number: 'SHP-LIVE-025',
          recipient_id: '00000000-0000-4000-8000-000000000028',
          destination_address_id: '00000000-0000-4000-8000-000000000035',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000026', workflow_status: 'completed' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000028', name: 'Backend Recipient' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { recipient_id: '00000000-0000-4000-8000-000000000028', name: 'Backend Recipient' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000035',
          city: 'Riyadh',
          sa_short_code: 'RNQA7082',
          coordinates: '0101000020E6100000F5DBD78173564740BB270F0BB5B63840',
          raw_input: JSON.stringify({
            sa_short_code: 'RNQA7082',
            provided_coordinates: {
              latitude: 24.7137,
              longitude: 46.6754,
            },
          }),
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000029',
          shipment_id: '00000000-0000-4000-8000-000000000025',
          label_id: '00000000-0000-4000-8000-000000000036',
          active_version_id: '00000000-0000-4000-8000-000000000037',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000036', shipment_id: '00000000-0000-4000-8000-000000000025' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000037', label_id: '00000000-0000-4000-8000-000000000036' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_create_shipment_v1({
      organization_id: '00000000-0000-4000-8000-000000000031',
      client_id: '00000000-0000-4000-8000-000000000032',
      sender_id: '00000000-0000-4000-8000-000000000033',
      new_recipient: { name: 'Backend Recipient', phone_number: '+12025550123' },
      destination_address: {
        line1: 'Backend Road 1',
        city: 'Riyadh',
        sa_short_code: 'RNQA7082',
        coordinates: {
          latitude: 24.7137,
          longitude: 46.6754,
        },
      },
      service_offering_id: '00000000-0000-4000-8000-000000000034',
      client_reference_number: 'LIVE-MANUAL-001',
      dry_run: false,
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_create_manual_shipment_intake_v1', {
      p_args: expect.objectContaining({
        organization_id: '00000000-0000-4000-8000-000000000031',
        client_id: '00000000-0000-4000-8000-000000000032',
        sender_id: '00000000-0000-4000-8000-000000000033',
        service_type: null,
        service_offering_id: '00000000-0000-4000-8000-000000000034',
        destination_address: expect.objectContaining({
          sa_short_code: 'RNQA7082',
          coordinates: {
            latitude: 24.7137,
            longitude: 46.6754,
          },
        }),
        client_reference_number: 'LIVE-MANUAL-001',
        request_label: true,
        dry_run: false,
      }),
    });
    expect(result).toMatchObject({
      shipment_id: '00000000-0000-4000-8000-000000000025',
      tracking_number: 'SHP-LIVE-025',
      workflow_run_id: '00000000-0000-4000-8000-000000000026',
      label_job_id: '00000000-0000-4000-8000-000000000029',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipments',
      p_id: '00000000-0000-4000-8000-000000000025',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipment_directory',
      p_id: '00000000-0000-4000-8000-000000000025',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'workflow_runs',
      p_id: '00000000-0000-4000-8000-000000000026',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'recipients',
      p_id: '00000000-0000-4000-8000-000000000028',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'recipient_directory',
      p_id: '00000000-0000-4000-8000-000000000028',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'addresses',
      p_id: '00000000-0000-4000-8000-000000000035',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'label_jobs',
      p_id: '00000000-0000-4000-8000-000000000029',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'labels',
      p_id: '00000000-0000-4000-8000-000000000036',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'label_versions',
      p_id: '00000000-0000-4000-8000-000000000037',
    });
  });

  it('fails closed when manual create address readback only echoes SNA in raw input', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'shipment_created',
          shipment_id: '00000000-0000-4000-8000-000000000025',
          recipient_id: '00000000-0000-4000-8000-000000000028',
          shipment_result: {
            workflow_run_id: '00000000-0000-4000-8000-000000000026',
            tracking_number: 'SHP-LIVE-025',
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000025',
          tracking_number: 'SHP-LIVE-025',
          recipient_id: '00000000-0000-4000-8000-000000000028',
          destination_address_id: '00000000-0000-4000-8000-000000000035',
          branch_id: '00000000-0000-4000-8000-000000000038',
          zone_id: '00000000-0000-4000-8000-000000000040',
          service_level: 'standard',
          metadata: {
            service_offering_branch_id: '00000000-0000-4000-8000-000000000038',
            service_offering_zone_id: '00000000-0000-4000-8000-000000000040',
            service_level_key: 'standard',
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000025',
          destination_address_id: '00000000-0000-4000-8000-000000000035',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000026', workflow_status: 'completed' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000028', name: 'Backend Recipient' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { recipient_id: '00000000-0000-4000-8000-000000000028', name: 'Backend Recipient' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000035',
          city: 'Riyadh',
          raw_input: JSON.stringify({
            sa_short_code: 'RNQA7082',
            coordinates: {
              latitude: 24.7137,
              longitude: 46.6754,
            },
          }),
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_create_shipment_v1({
      organization_id: '00000000-0000-4000-8000-000000000031',
      client_id: '00000000-0000-4000-8000-000000000032',
      sender_id: '00000000-0000-4000-8000-000000000033',
      new_recipient: { name: 'Backend Recipient', phone_number: '+12025550123' },
      destination_address: {
        line1: 'Backend Road 1',
        city: 'Riyadh',
        sa_short_code: 'RNQA7082',
        coordinates: {
          latitude: 24.7137,
          longitude: 46.6754,
        },
      },
      service_offering_id: '00000000-0000-4000-8000-000000000034',
      client_reference_number: 'LIVE-MANUAL-RAW-ONLY-001',
      dry_run: false,
    })).rejects.toThrow('backend address readback did not project Saudi short national address to canonical address fields');
  });

  it('fails closed when service-offering lineage stays metadata-only after manual create', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'shipment_created',
          shipment_id: '00000000-0000-4000-8000-000000000025',
          recipient_id: '00000000-0000-4000-8000-000000000028',
          shipment_result: {
            workflow_run_id: '00000000-0000-4000-8000-000000000026',
            tracking_number: 'SHP-LIVE-025',
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000025',
          tracking_number: 'SHP-LIVE-025',
          recipient_id: '00000000-0000-4000-8000-000000000028',
          metadata: {
            service_offering_branch_id: '00000000-0000-4000-8000-000000000038',
            service_offering_zone_id: '00000000-0000-4000-8000-000000000040',
            service_level_key: 'standard',
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000025',
          tracking_number: 'SHP-LIVE-025',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_create_shipment_v1({
      organization_id: '00000000-0000-4000-8000-000000000031',
      client_id: '00000000-0000-4000-8000-000000000032',
      sender_id: '00000000-0000-4000-8000-000000000033',
      new_recipient: { name: 'Backend Recipient', phone_number: '+12025550123' },
      destination_address: { line1: 'Backend Road 1', city: 'Riyadh' },
      service_offering_id: '00000000-0000-4000-8000-000000000034',
      client_reference_number: 'LIVE-MANUAL-METADATA-ONLY-001',
      dry_run: false,
    })).rejects.toThrow('backend readback did not project service_offering_branch_id to shipments.branch_id');
  });

  it('accepts manual shipment dry-run evidence nested under the backend preview payload', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        status: 'manual_shipment_intake_preview',
        dry_run: true,
        recipient_mode: 'inline',
        new_recipient_preview: {
          name: 'Preview Recipient',
          phone_number_normalized: '+12025550123',
          would_reject_duplicate: false,
        },
        shipment_preview: {
          status: 'shipment_create_preview',
          dry_run: true,
          workflow_template_id: '00000000-0000-4000-8000-000000000027',
          correlation_id: '00000000-0000-4000-8000-000000000030',
          tracking_number: 'SHP-PREVIEW-025',
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.ui_create_shipment_v1({
      organization_id: '00000000-0000-4000-8000-000000000031',
      client_id: '00000000-0000-4000-8000-000000000032',
      sender_id: '00000000-0000-4000-8000-000000000033',
      new_recipient: { name: 'Preview Recipient', phone_number: '+12025550123' },
      destination_address: { line1: 'Preview Road 1', city: 'Riyadh' },
      service_offering_id: '00000000-0000-4000-8000-000000000034',
      client_reference_number: 'LIVE-MANUAL-PREVIEW-001',
      dry_run: true,
    });

    expect(result).toMatchObject({
      status: 'manual_shipment_intake_preview',
      dry_run: true,
      tracking_number: 'SHP-PREVIEW-025',
      workflow_template_id: '00000000-0000-4000-8000-000000000027',
      correlation_id: '00000000-0000-4000-8000-000000000030',
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('accepts duplicate manual shipment reuse with shipment readback and no new workflow requirement', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'manual_shipment_intake_reused',
          dry_run: false,
          recipient_mode: 'existing',
          recipient_id: '00000000-0000-4000-8000-000000000028',
          shipment_id: '00000000-0000-4000-8000-000000000025',
          tracking_number: 'SHP-LIVE-025',
          operation: 'reused_client_reference',
          duplicate_reused: true,
          decision_log_id: '00000000-0000-4000-8000-000000000039',
          address_result: { skipped: true, reason: 'duplicate_reference_reuse' },
          label_result: { skipped: true, reason: 'duplicate_reference_reuse' },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000025',
          recipient_id: '00000000-0000-4000-8000-000000000028',
          destination_address_id: '00000000-0000-4000-8000-000000000035',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000025', tracking_number: 'SHP-LIVE-025' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000028', name: 'Backend Recipient' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { recipient_id: '00000000-0000-4000-8000-000000000028', name: 'Backend Recipient' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000035', city: 'Riyadh' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_create_shipment_v1({
      organization_id: '00000000-0000-4000-8000-000000000031',
      client_id: '00000000-0000-4000-8000-000000000032',
      sender_id: '00000000-0000-4000-8000-000000000033',
      recipient_id: '00000000-0000-4000-8000-000000000028',
      destination_address: { line1: 'Duplicate replay should be skipped', city: 'Riyadh' },
      service_offering_id: '00000000-0000-4000-8000-000000000034',
      client_reference_number: 'LIVE-MANUAL-001',
      dry_run: false,
    });

    expect(result).toMatchObject({
      status: 'manual_shipment_intake_reused',
      shipment_id: '00000000-0000-4000-8000-000000000025',
      tracking_number: 'SHP-LIVE-025',
      operation: 'reused_client_reference',
      workflow_run_id: null,
      label_job_id: null,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipments',
      p_id: '00000000-0000-4000-8000-000000000025',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipment_directory',
      p_id: '00000000-0000-4000-8000-000000000025',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'recipients',
      p_id: '00000000-0000-4000-8000-000000000028',
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith('ui_get_resource_v1', expect.objectContaining({
      p_resource: 'workflow_runs',
    }));
    expect(mocks.rpc).not.toHaveBeenCalledWith('ui_get_resource_v1', expect.objectContaining({
      p_resource: 'label_jobs',
    }));
  });

  it('fails closed when manual shipment address amendment is rejected by the backend', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'ui_create_manual_shipment_intake_v1 address amendment failed: geocode_failed',
      },
    });

    const ds = await import('../data-source');
    await expect(ds.ui_create_shipment_v1({
      organization_id: '00000000-0000-4000-8000-000000000031',
      client_id: '00000000-0000-4000-8000-000000000032',
      sender_id: '00000000-0000-4000-8000-000000000033',
      recipient_id: '00000000-0000-4000-8000-000000000028',
      destination_address: { line1: 'Ambiguous backend road', city: 'Riyadh' },
      service_offering_id: '00000000-0000-4000-8000-000000000034',
      client_reference_number: 'LIVE-MANUAL-GEOCODE-FAIL-001',
      dry_run: false,
    })).rejects.toThrow('ui_create_manual_shipment_intake_v1 address amendment failed: geocode_failed');

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('ui_create_manual_shipment_intake_v1', {
      p_args: expect.objectContaining({
        client_reference_number: 'LIVE-MANUAL-GEOCODE-FAIL-001',
        destination_address: expect.objectContaining({
          line1: 'Ambiguous backend road',
          city: 'Riyadh',
        }),
        dry_run: false,
      }),
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith('ui_get_resource_v1', expect.anything());
  });

  it('fails closed when live shipment creation returns no backend shipment evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          workflow_run_id: '00000000-0000-4000-8000-000000000026',
          tracking_number: 'SHP-LIVE-025',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const args = {
      organization_id: '00000000-0000-4000-8000-000000000031',
      client_id: '00000000-0000-4000-8000-000000000032',
      sender_id: '00000000-0000-4000-8000-000000000033',
      new_recipient: { name: 'Backend Recipient', phone_number: '+12025550123' },
      destination_address: { line1: 'Backend Road 1', city: 'Riyadh' },
      service_offering_id: '00000000-0000-4000-8000-000000000034',
      client_reference_number: 'LIVE-MANUAL-001',
      dry_run: false,
    };
    await expect(ds.ui_create_shipment_v1(args)).rejects.toThrow(
      'ui_create_manual_shipment_intake_v1 returned no backend outcome',
    );
    await expect(ds.ui_create_shipment_v1(args)).rejects.toThrow(
      'ui_create_manual_shipment_intake_v1 did not return shipment_id',
    );
  });

  it('fails closed when live shipment mutation returns no workflow-backed outcome', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });

    const ds = await import('../data-source');
    await expect(ds.shipment_amend_cancel_v1(
      '00000000-0000-4000-8000-000000000020',
      'amend_field',
      { status: 'ready' },
      { dryRun: false },
    )).rejects.toThrow('Shipment mutation returned no backend outcome');
    await expect(ds.shipment_amend_cancel_v1(
      '00000000-0000-4000-8000-000000000020',
      'amend_field',
      { status: 'ready' },
      { dryRun: false },
    )).rejects.toThrow('workflow_run_id');
  });

  it('fails closed when shipment lifecycle mutations lack persisted readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'shipment_created',
          shipment_id: '00000000-0000-4000-8000-000000000025',
          workflow_run_id: '00000000-0000-4000-8000-000000000026',
          tracking_number: 'SHP-LIVE-025',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          workflow_template: 'shipment_modify_v1',
          workflow_run_id: '00000000-0000-4000-8000-000000000021',
          dry_run: false,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_create_shipment_v1({
      organization_id: '00000000-0000-4000-8000-000000000031',
      client_id: '00000000-0000-4000-8000-000000000032',
      sender_id: '00000000-0000-4000-8000-000000000033',
      new_recipient: { name: 'Backend Recipient', phone_number: '+12025550123' },
      destination_address: { line1: 'Backend Road 1', city: 'Riyadh' },
      dry_run: false,
    })).rejects.toThrow('ui_create_manual_shipment_intake_v1 backend readback missing shipments');

    await expect(ds.shipment_amend_cancel_v1(
      '00000000-0000-4000-8000-000000000020',
      'amend_field',
      { status: 'ready' },
      { dryRun: false },
    )).rejects.toThrow('shipment_amend_cancel_v1 backend readback missing shipments');
  });

  it('routes shipment batch operations only through supported canonical command keys', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { ok: true, count: 2, op: 'cancel' }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, count: 2, op: 'reschedule' }, error: null })
      .mockResolvedValueOnce({ data: { id: '00000000-0000-4000-8000-000000000023', status: 'rescheduled' }, error: null })
      .mockResolvedValueOnce({ data: { id: '00000000-0000-4000-8000-000000000024', status: 'rescheduled' }, error: null });

    const ds = await import('../data-source');
    await ds.ui_execute_shipment_batch_operation_v1(
      ['00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000024'],
      'cancel',
      { reason: 'duplicate' },
      { dryRun: true },
    );
    await ds.ui_execute_shipment_batch_operation_v1(
      ['00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000024'],
      'reschedule',
      { slot_date: '2026-05-07' },
      { dryRun: false },
    );

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_execute_shipment_batch_operation_v1', {
      p_action_key: 'shipments.delete',
      p_resource_key: 'shipments',
      p_selection_ids: ['00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000024'],
      p_selection_id: null,
      p_selection_count: 2,
      p_params: {
        reason: 'duplicate',
        operation: 'cancel',
        surface: 'console',
        dry_run: true,
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_execute_shipment_batch_operation_v1', {
      p_action_key: 'shipments.reschedule',
      p_resource_key: 'shipments',
      p_selection_ids: ['00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000024'],
      p_selection_id: null,
      p_selection_count: 2,
      p_params: {
        slot_date: '2026-05-07',
        operation: 'reschedule',
        surface: 'console',
        dry_run: false,
      },
    });
    await expect(
      ds.ui_execute_shipment_batch_operation_v1(
        ['00000000-0000-4000-8000-000000000023'],
        'amend',
        {},
        { dryRun: true },
      ),
    ).rejects.toThrow(/unsupported operation amend/i);
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipments',
      p_id: '00000000-0000-4000-8000-000000000023',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipments',
      p_id: '00000000-0000-4000-8000-000000000024',
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(4);
  });

  it('fails closed when shipment batch operation lacks shipment readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { ok: true, count: 1, op: 'reschedule' }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_execute_shipment_batch_operation_v1(
      ['00000000-0000-4000-8000-000000000023'],
      'reschedule',
      { slot_date: '2026-05-07' },
      { dryRun: false },
    )).rejects.toThrow('ui_execute_shipment_batch_operation_v1 backend readback missing shipments');
  });

  it('routes route-plan and dispatch actions through canonical api RPC envelopes', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [{ route_plan_id: '00000000-0000-4000-8000-000000000030', status: 'solved' }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000030', status: 'solved' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          status: 'assigned',
          count: 1,
          route_run_assignment_id: '00000000-0000-4000-8000-000000000033',
          route_run_assignment_event_id: '00000000-0000-4000-8000-000000000034',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000031', assignment_status: 'assigned' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000033', route_run_id: '00000000-0000-4000-8000-000000000031' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000034', route_run_id: '00000000-0000-4000-8000-000000000031' },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.ui_solve_route_plan_v1('00000000-0000-4000-8000-000000000030');
    await ds.ui_execute_route_run_assign_v1('00000000-0000-4000-8000-000000000031', {
      driver_user_id: '00000000-0000-4000-8000-000000000032',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_solve_route_plan_v1', {
      p_input: { route_plan_id: '00000000-0000-4000-8000-000000000030' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'route_plans',
      p_id: '00000000-0000-4000-8000-000000000030',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_execute_route_run_assign_v1', {
      p_action_key: 'route_runs.assign',
      p_resource_key: 'route_runs',
      p_selection_ids: ['00000000-0000-4000-8000-000000000031'],
      p_selection_id: '00000000-0000-4000-8000-000000000031',
      p_selection_count: 1,
      p_params: { driver_user_id: '00000000-0000-4000-8000-000000000032' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_get_resource_v1', {
      p_resource: 'route_runs',
      p_id: '00000000-0000-4000-8000-000000000031',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'ui_get_resource_v1', {
      p_resource: 'route_run_assignments',
      p_id: '00000000-0000-4000-8000-000000000033',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(6, 'ui_get_resource_v1', {
      p_resource: 'route_run_assignment_events',
      p_id: '00000000-0000-4000-8000-000000000034',
    });
  });

  it('fails closed when route assignment and stop reassignment lack canonical readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: { status: 'assigned', count: 1 },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: { status: 'reassigned', count: 1 },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_execute_route_run_assign_v1(
      '00000000-0000-4000-8000-000000000031',
      { driver_user_id: '00000000-0000-4000-8000-000000000032' },
    )).rejects.toThrow('ui_execute_route_run_assign_v1 backend readback missing route_runs');
    await expect(ds.ui_execute_route_stop_reassign_v1(
      ['00000000-0000-4000-8000-000000000203'],
      { target_route_run_id: '00000000-0000-4000-8000-000000000204' },
    )).rejects.toThrow('ui_execute_route_stop_reassign_v1 backend readback missing route_stops');
  });

  it('fails closed when live route assignment lacks assignment ledger readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: { status: 'assigned', count: 1 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000031', assignment_status: 'assigned' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [], total: 0 },
        error: null,
      })
      .mockResolvedValue({
        data: { rows: [], total: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_execute_route_run_assign_v1(
      '00000000-0000-4000-8000-000000000031',
      { driver_user_id: '00000000-0000-4000-8000-000000000032' },
    )).rejects.toThrow('ui_execute_route_run_assign_v1 backend readback missing route_run_assignments');
  });

  it('requires route-stop, assignment, and event readback after live stop reassignment', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          status: 'reassigned',
          count: 1,
          route_run_assignment_id: '00000000-0000-4000-8000-000000000205',
          route_stop_reassignment_event_id: '00000000-0000-4000-8000-000000000206',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000203', route_run_id: '00000000-0000-4000-8000-000000000204' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000205', route_run_id: '00000000-0000-4000-8000-000000000204' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000206', route_stop_id: '00000000-0000-4000-8000-000000000203' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_execute_route_stop_reassign_v1(
      ['00000000-0000-4000-8000-000000000203'],
      { target_route_run_id: '00000000-0000-4000-8000-000000000204' },
    );

    expect(result).toMatchObject({ ok: true, count: 1, assignment_status: 'reassigned' });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'route_stops',
      p_id: '00000000-0000-4000-8000-000000000203',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'route_run_assignments',
      p_id: '00000000-0000-4000-8000-000000000205',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'route_stop_reassignment_events',
      p_id: '00000000-0000-4000-8000-000000000206',
    });
  });

  it('fails closed when live stop reassignment lacks event ledger readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          status: 'reassigned',
          count: 1,
          route_run_assignment_id: '00000000-0000-4000-8000-000000000205',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000203', route_run_id: '00000000-0000-4000-8000-000000000204' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000205', route_run_id: '00000000-0000-4000-8000-000000000204' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [], total: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_execute_route_stop_reassign_v1(
      ['00000000-0000-4000-8000-000000000203'],
      { target_route_run_id: '00000000-0000-4000-8000-000000000204' },
    )).rejects.toThrow('ui_execute_route_stop_reassign_v1 backend readback missing route_stop_reassignment_events');
  });

  it('requires live route-plan readback after create, solve, freeze, publish, and apply', async () => {
    const planId = '00000000-0000-4000-8000-000000000130';
    const runId = '00000000-0000-4000-8000-000000000131';
    mocks.rpc
      .mockResolvedValueOnce({
        data: { route_plan_id: planId, status: 'created', plan_id: planId, correlation_id: 'corr-create' },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: planId, status: 'created' }, error: null })
      .mockResolvedValueOnce({
        data: { route_plan_id: planId, status: 'solved', settings_resolution_id: 'srlv-solve' },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: planId, status: 'solved' }, error: null })
      .mockResolvedValueOnce({
        data: {
          route_plan_id: planId,
          status: 'frozen',
          constraint_validation: { fail_count: 0 },
          settings_resolution_id: 'srlv-freeze',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: planId, status: 'frozen' }, error: null })
      .mockResolvedValueOnce({
        data: { route_plan_id: planId, status: 'published', execution_pack_hash: 'pack-live-130' },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: planId, status: 'published' }, error: null })
      .mockResolvedValueOnce({
        data: { route_plan_id: planId, execution_pack_hash: 'pack-live-130', stop_count: 2 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ route_plan_id: planId, status: 'applied', route_run_id: runId }],
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: planId, status: 'applied' }, error: null })
      .mockResolvedValueOnce({
        data: { rows: [{ id: runId, route_plan_id: planId }], total: 1 },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.ui_create_route_plan_v1({
      organization_id: '00000000-0000-4000-8000-000000000132',
      branch_id: '00000000-0000-4000-8000-000000000133',
      planned_date: '2026-05-08',
    });
    await ds.ui_solve_route_plan_v1(planId);
    await ds.ui_freeze_route_plan_v1(planId);
    await ds.ui_publish_route_plan_v1(planId);
    await ds.ui_apply_route_plan_v1(planId);

    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'route_plans',
      p_id: planId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_get_resource_v1', {
      p_resource: 'route_plans',
      p_id: planId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(6, 'ui_get_resource_v1', {
      p_resource: 'route_plans',
      p_id: planId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(8, 'ui_get_resource_v1', {
      p_resource: 'route_plans',
      p_id: planId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(9, 'ui_route_plan_execution_pack_v1', {
      p_route_plan_id: planId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(11, 'ui_get_resource_v1', {
      p_resource: 'route_plans',
      p_id: planId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(12, 'ui_list_resource_v1', {
      p_resource: 'route_runs',
      p_filters: { route_plan_id: planId },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
  });

  it('accepts route-plan freeze constraint validation from backend readback metadata', async () => {
    const planId = '00000000-0000-4000-8000-000000000144';
    mocks.rpc
      .mockResolvedValueOnce({
        data: { route_plan_id: planId, status: 'frozen', settings_resolution_id: 'srlv-freeze' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: planId,
          status: 'frozen',
          metadata: {
            constraint_validation: {
              valid: true,
              enabled: true,
              route_plan_id: planId,
              violations: [],
              validated_at: '2026-05-14T20:00:00.000Z',
            },
          },
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_freeze_route_plan_v1(planId);

    expect(result).toMatchObject({
      ok: true,
      plan_id: planId,
      status: 'frozen',
      constraint_validation: {
        valid: true,
        fail_count: 0,
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'route_plans',
      p_id: planId,
    });
  });

  it('fails closed when route-plan freeze readback omits constraint validation', async () => {
    const planId = '00000000-0000-4000-8000-000000000145';
    mocks.rpc
      .mockResolvedValueOnce({
        data: { route_plan_id: planId, status: 'frozen', settings_resolution_id: 'srlv-freeze' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: planId, status: 'frozen', metadata: {} },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_freeze_route_plan_v1(planId))
      .rejects.toThrow('Route plan freeze backend readback missing constraint validation');
  });

  it('fails closed when route-plan live readback is missing after mutation', async () => {
    const planId = '00000000-0000-4000-8000-000000000134';
    mocks.rpc
      .mockResolvedValueOnce({
        data: { route_plan_id: planId, status: 'solved', settings_resolution_id: 'srlv-solve' },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_solve_route_plan_v1(planId)).rejects.toThrow(
      'ui_solve_route_plan_v1 backend readback missing route_plans',
    );
  });

  it('fails closed when route-plan constraint validation returns empty or weak live evidence', async () => {
    const planId = '00000000-0000-4000-8000-000000000135';
    mocks.rpc
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({
        data: {
          route_plan_id: planId,
          valid: true,
          violations: [],
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.route_plan_validate_constraints_v1(planId)).rejects.toThrow(
      'returned no backend validation outcome',
    );
    await expect(ds.route_plan_validate_constraints_v1(planId)).rejects.toThrow(
      'backend validation evidence',
    );
  });

  it('normalizes canonical route-plan constraint validation evidence from the live backend', async () => {
    const planId = '00000000-0000-4000-8000-000000000136';
    mocks.rpc.mockResolvedValueOnce({
      data: {
        route_plan_id: planId,
        valid: false,
        enabled: true,
        settings_version_id: '00000000-0000-4000-8000-000000000137',
        validated_at: '2026-05-08T10:00:00.000Z',
        violations: [{
          code: 'driver_skill_missing',
          message: 'Assigned driver is missing required skill keys.',
        }],
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.route_plan_validate_constraints_v1(planId);

    expect(result).toMatchObject({
      ok: true,
      plan_id: planId,
      fail_count: 1,
      items: [{
        name: 'driver_skill_missing',
        passed: 0,
        failed: 1,
        status: 'danger',
        detail: 'Assigned driver is missing required skill keys.',
      }],
    });
    expect(mocks.rpc).toHaveBeenCalledWith('route_plan_validate_constraints_v1', {
      p_route_plan_id: planId,
    });
  });

  it('requires source and target route-plan readback after live rebalance', async () => {
    const sourcePlanId = '00000000-0000-4000-8000-000000000138';
    const targetPlanId = '00000000-0000-4000-8000-000000000139';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          source_route_plan_id: sourcePlanId,
          target_route_plan_id: targetPlanId,
          moved_stop_count: 1,
          source_status: 'submitted',
          target_status: 'submitted',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: sourcePlanId, status: 'submitted' }, error: null })
      .mockResolvedValueOnce({ data: { id: targetPlanId, status: 'submitted' }, error: null });

    const ds = await import('../data-source');
    const result = await ds.ui_rebalance_route_plan_v1({
      source_route_plan_id: sourcePlanId,
      target_route_plan_id: targetPlanId,
      shipment_ids: ['00000000-0000-4000-8000-000000000140'],
    });

    expect(result).toMatchObject({
      ok: true,
      plan_id: sourcePlanId,
      moves_applied: 1,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_rebalance_route_plan_v1', {
      p_input: {
        source_route_plan_id: sourcePlanId,
        target_route_plan_id: targetPlanId,
        shipment_ids: ['00000000-0000-4000-8000-000000000140'],
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'route_plans',
      p_id: sourcePlanId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'route_plans',
      p_id: targetPlanId,
    });
  });

  it('fails closed when live rebalance omits target route-plan readback evidence', async () => {
    const sourcePlanId = '00000000-0000-4000-8000-000000000141';
    const targetPlanId = '00000000-0000-4000-8000-000000000142';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          source_route_plan_id: sourcePlanId,
          target_route_plan_id: targetPlanId,
          moved_stop_count: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: sourcePlanId, status: 'submitted' }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_rebalance_route_plan_v1({
      source_route_plan_id: sourcePlanId,
      target_route_plan_id: targetPlanId,
      shipment_ids: ['00000000-0000-4000-8000-000000000143'],
    })).rejects.toThrow(`ui_rebalance_route_plan_v1 target backend readback missing route_plans:${targetPlanId}`);
  });

  it('fails closed when route planning and assignment live actions return no backend evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: { ok: true, route_plan_id: '00000000-0000-4000-8000-000000000030' }, error: null })
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: { ok: true, route_plan_id: '00000000-0000-4000-8000-000000000030', status: 'published' }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, route_plan_id: '00000000-0000-4000-8000-000000000030', status: 'applied' }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, source_route_plan_id: '00000000-0000-4000-8000-000000000030' }, error: null })
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: { ok: true, status: 'reassigned' }, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_create_route_plan_v1({
      branch_id: '00000000-0000-4000-8000-000000000201',
      planned_date: '2026-05-08',
    })).rejects.toThrow('no backend outcome');
    await expect(ds.ui_solve_route_plan_v1('00000000-0000-4000-8000-000000000030'))
      .rejects.toThrow('status');
    await expect(ds.ui_freeze_route_plan_v1('00000000-0000-4000-8000-000000000030'))
      .rejects.toThrow('no backend outcome');
    await expect(ds.ui_publish_route_plan_v1('00000000-0000-4000-8000-000000000030'))
      .rejects.toThrow('execution_pack_hash');
    await expect(ds.ui_apply_route_plan_v1('00000000-0000-4000-8000-000000000030'))
      .rejects.toThrow('materialized route-run evidence');
    await expect(ds.ui_rebalance_route_plan_v1({
      source_route_plan_id: '00000000-0000-4000-8000-000000000030',
      shipment_ids: ['00000000-0000-4000-8000-000000000202'],
    })).rejects.toThrow('moved stop count');
    await expect(ds.ui_execute_route_run_assign_v1(
      '00000000-0000-4000-8000-000000000031',
      { driver_user_id: '00000000-0000-4000-8000-000000000032' },
    )).rejects.toThrow('no backend outcome');
    await expect(ds.ui_execute_route_stop_reassign_v1(
      ['00000000-0000-4000-8000-000000000203'],
      { target_route_run_id: '00000000-0000-4000-8000-000000000204' },
    )).rejects.toThrow('affected count');
  });

  it('routes dispatch exception preview and apply through live api command wrappers', async () => {
    const taskId = '00000000-0000-4000-8000-000000000141';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          status: 'preview',
          items: [{
            task_id: taskId,
            status: 'preview',
            preview: { settings_resolution_id: '00000000-0000-4000-8000-000000000142' },
          }],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          status: 'completed',
          items: [{ task_id: taskId, status: 'completed' }],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: taskId, status: 'completed', metadata: { resolution_action: 'reschedule' } },
        error: null,
      });

    const ds = await import('../data-source');
    const preview = await ds.ui_execute_dispatch_exception_resolution_v1(
      taskId,
      { resolution_action: 'reschedule', notes: 'customer requested a new slot' },
      { dryRun: true },
    );
    const applied = await ds.ui_execute_dispatch_exception_resolution_v1(taskId, 'reschedule');

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'preview_dispatch_exception_resolution_v1', {
      p_action_key: 'dispatch_exception_review.complete',
      p_resource_key: 'dispatch_exception_review',
      p_selection_ids: [taskId],
      p_selection_id: taskId,
      p_selection_count: 1,
      p_params: {
        resolution_action: 'reschedule',
        resolution_notes: 'customer requested a new slot',
        dry_run: true,
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_execute_dispatch_exception_resolution_v1', {
      p_action_key: 'dispatch_exception_review.complete',
      p_resource_key: 'dispatch_exception_review',
      p_selection_ids: [taskId],
      p_selection_id: taskId,
      p_selection_count: 1,
      p_params: { resolution_action: 'reschedule' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'tasks',
      p_id: taskId,
    });
    expect(preview.apply_status).toBe('preview');
    expect(preview.canonical_entrypoint).toBe('api.preview_dispatch_exception_resolution_v1');
    expect(applied.results).toEqual([expect.objectContaining({ task_id: taskId, outcome: 'ok' })]);
  });

  it('fails closed when dispatch exception apply lacks task readback', async () => {
    const taskId = '00000000-0000-4000-8000-000000000141';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          status: 'completed',
          items: [{ task_id: taskId, status: 'completed' }],
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_execute_dispatch_exception_resolution_v1(taskId, 'reschedule')).rejects.toThrow(
      `ui_execute_dispatch_exception_resolution_v1 backend readback missing tasks:${taskId}`,
    );
  });

  it('routes returned-to-branch reads and intake scans through live api wrappers', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000151',
            tracking_number: 'SHP-9381201',
            status: 'returned_to_branch',
          }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          scan_event_id: '00000000-0000-4000-8000-000000000152',
          created: true,
        }],
        error: null,
      });

    const ds = await import('../data-source');
    const rows = await ds.return_to_branch_shipments_v1.list();
    const scan = await ds.record_scan_event_v1({
      scan_type: 'return_to_branch_intake',
      tracking_number: 'SHP-9381201',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_list_resource_v1', {
      p_resource: 'return_to_branch_shipments',
      p_filters: {},
      p_limit: 100,
      p_offset: 0,
      p_sort: { key: 'updated_at', direction: 'desc' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'record_scan_event_v1', {
      p_scan: {
        scan_type: 'return_to_branch_intake',
        tracking_number: 'SHP-9381201',
        barcode: 'SHP-9381201',
        metadata: { tracking_number: 'SHP-9381201' },
        idempotency_key: 'console-v2:return_to_branch_intake:SHP-9381201',
      },
    });
    expect(rows).toEqual([expect.objectContaining({ tracking_number: 'SHP-9381201' })]);
    expect(scan).toMatchObject({
      ok: true,
      scan_event_id: '00000000-0000-4000-8000-000000000152',
      created: true,
    });
  });

  it('routes Dispatch scanner load scans through the live api RPC wrapper', async () => {
    const payload = {
      organization_id: 'org_demo',
      scan_type: 'load',
      route_run_id: 'run_2841',
      route_stop_id: 'rs_44000',
      branch_id: 'hub_ruh_n',
      client_id: 'client_demo',
      shipment_id: 'shp_9381201',
      barcode: 'SHP-9381201',
      idempotency_key: 'console-v2-load:run_2841:rs_44000:SHP-9381201',
      metadata: {
        source: 'console_v2_dispatch',
        action: 'route_load_scan',
      },
    };

    mocks.rpc
      .mockResolvedValueOnce({
        data: [{
          device_id: '00000000-0000-4000-8000-000000000222',
          created: true,
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          scan_event_id: 'scan_route_load_1',
          created: true,
        }],
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.record_scan_event_v1(payload);

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'register_user_device_v1', {
      p_device: expect.objectContaining({
        device_platform: 'web',
        device_label: 'Console V2 Dispatch scanner',
        metadata: expect.objectContaining({
          source: 'console_v2_dispatch',
          surface: 'dispatch_scan_out',
        }),
      }),
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'record_scan_event_v1', {
      p_scan: {
        ...payload,
        device_id: '00000000-0000-4000-8000-000000000222',
      },
    });
    expect(result).toMatchObject({
      ok: true,
      scan_event_id: 'scan_route_load_1',
      created: true,
    });
  });

  it('fails closed when live scan RPC returns no scan_event_id', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ created: true }],
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.record_scan_event_v1({
      scan_type: 'load',
      route_run_id: 'run_2841',
      barcode: 'SHP-9381201',
    })).rejects.toThrow('record_scan_event_v1 did not return scan_event_id');
  });

  it('fails closed when live scan RPC reports ok false', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{
        ok: false,
        error: 'scan rejected by policy',
      }],
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.record_scan_event_v1({
      scan_type: 'load',
      route_run_id: 'run_2841',
      barcode: 'SHP-9381201',
    })).rejects.toThrow('scan rejected by policy');
  });

  it('requires shipment, workflow, geocode ledger, and review task readback after live geocode requeue', async () => {
    const shipmentId = '00000000-0000-4000-8000-000000000341';
    const workflowRunId = '00000000-0000-4000-8000-000000000342';
    const nestedRunId = '00000000-0000-4000-8000-000000000345';
    const attemptId = '00000000-0000-4000-8000-000000000343';
    const geocodeId = '00000000-0000-4000-8000-000000000344';
    const manualReviewTaskId = '00000000-0000-4000-8000-000000000346';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'workflow_started',
          workflow_run_id: workflowRunId,
          geocode_workflow_run_id: nestedRunId,
          geocode_workflow_status: 'waiting',
          manual_review_task_id: manualReviewTaskId,
          geocoding_attempt_id: attemptId,
          geocode_id: geocodeId,
          correlation_id: 'cor_geocode_requeue',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: shipmentId, status: 'pending' }, error: null })
      .mockResolvedValueOnce({ data: { id: workflowRunId, status: 'running' }, error: null })
      .mockResolvedValueOnce({ data: { id: nestedRunId, status: 'waiting' }, error: null })
      .mockResolvedValueOnce({ data: { id: attemptId, status: 'queued' }, error: null })
      .mockResolvedValueOnce({ data: { id: geocodeId, is_primary: true }, error: null })
      .mockResolvedValueOnce({ data: { id: manualReviewTaskId, task_type: 'geocoding' }, error: null });

    const ds = await import('../data-source');
    const result = await ds.ui_execute_shipment_update_geocode_v1(shipmentId);

    expect(result.workflow_run_id).toBe(workflowRunId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'shipments',
      p_id: shipmentId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'workflow_runs',
      p_id: workflowRunId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_get_resource_v1', {
      p_resource: 'workflow_runs',
      p_id: nestedRunId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'ui_get_resource_v1', {
      p_resource: 'geocoding_attempts',
      p_id: attemptId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(6, 'ui_get_resource_v1', {
      p_resource: 'geocodes',
      p_id: geocodeId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(7, 'ui_get_resource_v1', {
      p_resource: 'manual_review_tasks',
      p_id: manualReviewTaskId,
    });
  });

  it('fails closed when shipment geocode readback reports a failed nested workflow', async () => {
    const shipmentId = '00000000-0000-4000-8000-000000000347';
    const workflowRunId = '00000000-0000-4000-8000-000000000348';
    const nestedRunId = '00000000-0000-4000-8000-000000000349';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'completed',
          workflow_run_id: workflowRunId,
          items: [
            {
              shipment_id: shipmentId,
              geocode_workflow_run_id: nestedRunId,
              geocode_workflow_status: 'failed',
            },
          ],
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: shipmentId, status: 'pending' }, error: null })
      .mockResolvedValueOnce({ data: { id: workflowRunId, status: 'completed' }, error: null });

    const ds = await import('../data-source');

    await expect(ds.ui_execute_shipment_update_geocode_v1(shipmentId)).rejects.toThrow(
      `ui_execute_shipment_update_geocode_v1 nested geocode workflow failed (${nestedRunId})`,
    );
  });

  it('requires comms attempt and shipment readback after live operator comms enqueue', async () => {
    const shipmentId = '00000000-0000-4000-8000-000000000345';
    const attemptId = '00000000-0000-4000-8000-000000000346';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          comms_attempt_id: attemptId,
          shipment_id: shipmentId,
          channel: 'whatsapp',
          template_id: null,
          status: 'queued',
          correlation_id: 'cor_comms_enqueue',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: attemptId, shipment_id: shipmentId, status: 'queued' }, error: null })
      .mockResolvedValueOnce({ data: { id: shipmentId, status: 'pending' }, error: null });

    const ds = await import('../data-source');
    const result = await ds.enqueue_comms_attempt_v1({
      shipment_id: shipmentId,
      channel: 'whatsapp',
    });

    expect(result.comms_attempt_id).toBe(attemptId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'comms_attempts',
      p_id: attemptId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'shipments',
      p_id: shipmentId,
    });
  });

  it('fails closed when workflow and operator actions omit live backend evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });

    const ds = await import('../data-source');

    await expect(ds.ui_execute_shipment_update_geocode_v1('shp_demo')).rejects.toThrow(
      'ui_execute_shipment_update_geocode_v1 did not return backend execution evidence',
    );
    await expect(ds.reserve_delivery_slot_v1({
      slot_date: '2026-05-09',
      shipment_id: 'shp_demo',
      client_id: 'client_demo',
      window_start_local: '10:00',
      window_end_local: '12:00',
    })).rejects.toThrow('reserve_delivery_slot_v1 did not return backend execution evidence');
    await expect(ds.ui_run_workflow_schedule_trigger_v1('trigger_demo')).rejects.toThrow(
      'ui_run_workflow_schedule_trigger_v1 did not return backend execution evidence',
    );
    await expect(ds.ui_execute_user_device_revoke_v1('device_demo', 'lost device')).rejects.toThrow(
      'ui_execute_user_device_revoke_v1 did not return backend execution evidence',
    );
    await expect(ds.start_workflow_run('00000000-0000-4000-8000-000000000040', {})).rejects.toThrow(
      'ui_start_workflow_run_v1 did not return backend execution evidence',
    );
    await expect(ds.progress_workflow_run('wfr_demo', { action: 'continue' })).rejects.toThrow(
      'progress_workflow_run did not return backend execution evidence',
    );
    await expect(ds.progress_workflow_run_base('wfr_demo', { action: 'continue' })).rejects.toThrow(
      'progress_workflow_run did not return backend execution evidence',
    );
  });

  it('fails closed when live shipment resort RPC reports blocked or ok false', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: false,
          error: { code: 'basket_policy_disabled', message: 'basket policy disabled' },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          ok: true,
          status: 'blocked',
          reason: 'shipment is locked by dispatch policy',
        }],
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_execute_shipment_resort_v1('shp_policy_disabled')).rejects.toThrow('basket policy disabled');
    await expect(ds.ui_execute_shipment_resort_v1('shp_policy_locked')).rejects.toThrow('shipment is locked by dispatch policy');

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_execute_shipment_resort_v1', {
      p_action_key: 'shipments.resort',
      p_resource_key: 'shipments',
      p_selection_ids: ['shp_policy_disabled'],
      p_selection_id: 'shp_policy_disabled',
      p_selection_count: 1,
      p_params: {},
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_execute_shipment_resort_v1', {
      p_action_key: 'shipments.resort',
      p_resource_key: 'shipments',
      p_selection_ids: ['shp_policy_locked'],
      p_selection_id: 'shp_policy_locked',
      p_selection_count: 1,
      p_params: {},
    });
  });

  it('requires shipment readback after live shipment resort', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'resorted',
          basket_policy_applied: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'shp_resort_readback', status: 'pending' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_execute_shipment_resort_v1('shp_resort_readback');

    expect(result).toMatchObject({ ok: true, basket_policy_applied: true });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'shipments',
      p_id: 'shp_resort_readback',
    });
  });

  it('fails closed when live shipment resort lacks shipment readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'resorted',
          basket_policy_applied: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_execute_shipment_resort_v1('shp_resort_missing')).rejects.toThrow(
      'ui_execute_shipment_resort_v1 backend readback missing shipments',
    );
  });

  it('fails closed when live shipment resort RPC returns no backend outcome', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: {}, error: null });

    const ds = await import('../data-source');
    await expect(ds.ui_execute_shipment_resort_v1('shp_empty_null')).rejects.toThrow('no backend outcome');
    await expect(ds.ui_execute_shipment_resort_v1('shp_empty_array')).rejects.toThrow('no backend outcome');
    await expect(ds.ui_execute_shipment_resort_v1('shp_empty_object')).rejects.toThrow('no backend outcome');
  });

  it('routes fleet vehicle creation through the live api create_vehicle_v1 RPC', async () => {
    const payload = {
      organization_id: 'org_demo',
      plate_number: 'QA-FLEET-501',
      vehicle_type_id: 'vt_van',
      branch_id: 'hub_ruh_n',
      status: 'available',
      metadata: {
        submitted_from: 'console_v2_vehicles',
      },
    };

    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          vehicle_id: 'veh_qa_fleet_501',
          correlation_id: 'corr_vehicle_501',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'veh_qa_fleet_501', plate_number: 'QA-FLEET-501', status: 'available' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.create_vehicle_v1(payload);

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('create_vehicle_v1', {
      p_args: payload,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'vehicle_directory',
      p_id: 'veh_qa_fleet_501',
    });
    expect(result).toMatchObject({
      ok: true,
      vehicle_id: 'veh_qa_fleet_501',
      correlation_id: 'corr_vehicle_501',
    });
  });

  it('fails closed when live fleet vehicle creation lacks vehicle directory readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: { ok: true, vehicle_id: 'veh_qa_fleet_502', correlation_id: 'corr_vehicle_502' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.create_vehicle_v1({
      organization_id: 'org_demo',
      plate_number: 'QA-FLEET-502',
      vehicle_type_id: 'vt_van',
      branch_id: 'hub_ruh_n',
    })).rejects.toThrow('create_vehicle_v1 backend readback missing vehicle_directory');
  });

  it('requires vehicle directory, assignment, and event readback after fleet lifecycle mutations', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          vehicle_assignment_id: 'vasg_501',
          vehicle_id: 'veh_qa_fleet_501',
          correlation_id: 'corr_vehicle_assign_501',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'veh_qa_fleet_501', active_assignment_id: 'vasg_501' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'vasg_501', vehicle_id: 'veh_qa_fleet_501', status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          vehicle_id: 'veh_qa_fleet_501',
          vehicle_event_id: 'vevt_501',
          correlation_id: 'corr_vehicle_oos_501',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'veh_qa_fleet_501', status: 'out_of_service', is_oos: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'vevt_501', vehicle_id: 'veh_qa_fleet_501', event_type: 'out_of_service' },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.assign_driver_to_vehicle_v1({
      vehicle_id: 'veh_qa_fleet_501',
      driver_user_id: 'usr_driver_501',
    });
    await ds.mark_vehicle_oos_v1({
      vehicle_id: 'veh_qa_fleet_501',
      reason: 'inspection_failed',
    });

    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'vehicle_assignments',
      p_id: 'vasg_501',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'vehicle_events',
      p_id: 'vevt_501',
    });
  });

  it('requires live driver create, document, and HOS readback after mutations', async () => {
    const driverProfileId = '00000000-0000-4000-8000-000000000501';
    const driverUserId = '00000000-0000-4000-8000-000000000502';
    const driverDocumentId = '00000000-0000-4000-8000-000000000503';
    const hosSegmentId = '00000000-0000-4000-8000-000000000504';
    const driverPayload = {
      organization_id: '00000000-0000-4000-8000-000000000505',
      user_id: driverUserId,
      driver_code: 'DRV-LIVE-501',
      status: 'active',
    };
    const documentPayload = {
      driver_profile_id: driverProfileId,
      artifact_id: '00000000-0000-4000-8000-000000000506',
      doc_type: 'license',
    };
    const hosPayload = {
      driver_profile_id: driverProfileId,
      driver_user_id: driverUserId,
      duty_status: 'driving',
      segment_start: '2026-05-08T08:00:00.000Z',
    };

    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          driver_profile_id: driverProfileId,
          driver_user_id: driverUserId,
          status: 'active',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: driverProfileId, user_id: driverUserId, status: 'active', driver_code: 'DRV-LIVE-501' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          driver_document_id: driverDocumentId,
          driver_profile_id: driverProfileId,
          status: 'submitted',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: driverDocumentId, driver_id: driverProfileId, status: 'submitted' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          driver_hours_of_service_id: hosSegmentId,
          id: hosSegmentId,
          driver_profile_id: driverProfileId,
          driver_user_id: driverUserId,
          duty_status: 'driving',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          today: [{ type: 'driving', durationMinutes: 15 }],
          week_total: { driving: 15, on_duty: 15, off_duty: 0, sleeper: 0 },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: hosSegmentId,
          driver_id: driverProfileId,
          duty_status: 'driving',
          segment_start: '2026-05-08T08:00:00.000Z',
          segment_end: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: driverProfileId,
          hos_active_segment_id: hosSegmentId,
          hos_active_duty_status: 'driving',
          hos_segment_count_24h: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.create_driver_v1(driverPayload);
    await ds.upload_driver_document_v1(documentPayload);
    await ds.record_hours_of_service_segment_v1(hosPayload);

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'create_driver_v1', { p_args: driverPayload });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'driver_directory',
      p_id: driverProfileId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'upload_driver_document_v1', {
      p_args: documentPayload,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_get_resource_v1', {
      p_resource: 'driver_documents',
      p_id: driverDocumentId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'record_hours_of_service_segment_v1', {
      p_args: hosPayload,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(6, 'resolve_driver_hours_of_service_v1', {
      p_driver_id: driverProfileId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(7, 'ui_get_resource_v1', {
      p_resource: 'driver_hours_of_service',
      p_id: hosSegmentId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(8, 'ui_get_resource_v1', {
      p_resource: 'driver_directory',
      p_id: driverProfileId,
    });
  });

  it('fails closed when driver lifecycle live readback is missing after mutation', async () => {
    const driverProfileId = '00000000-0000-4000-8000-000000000511';
    mocks.rpc
      .mockResolvedValueOnce({
        data: { ok: true, driver_profile_id: driverProfileId, driver_user_id: '00000000-0000-4000-8000-000000000512' },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          driver_hours_of_service_id: '00000000-0000-4000-8000-000000000513',
          driver_profile_id: driverProfileId,
          duty_status: 'driving',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          today: [],
          week_total: { driving: 0, on_duty: 0, off_duty: 0, sleeper: 0 },
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.create_driver_v1({
      organization_id: '00000000-0000-4000-8000-000000000514',
      user_id: '00000000-0000-4000-8000-000000000512',
    })).rejects.toThrow('create_driver_v1 backend readback missing driver_directory');
    await expect(ds.record_hours_of_service_segment_v1({
      driver_profile_id: driverProfileId,
      duty_status: 'driving',
      segment_start: '2026-05-08T08:00:00.000Z',
    })).rejects.toThrow('record_hours_of_service_segment_v1 backend readback missing driver hours-of-service');
  });

  it('routes fleet maintenance and vehicle event actions through live api RPC wrappers', async () => {
    const completePayload = {
      vehicle_maintenance_window_id: 'mw_backend_001',
      notes: 'maintenance finished',
    };
    const cancelPayload = {
      vehicle_maintenance_window_id: 'mw_backend_002',
      reason: 'vehicle reassigned',
    };
    const eventPayload = {
      vehicle_id: 'veh_qa_fleet_501',
      event_type: 'inspection',
      notes: 'pre-dispatch inspection complete',
    };

    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          vehicle_maintenance_window_id: 'mw_backend_001',
          vehicle_id: 'veh_qa_fleet_501',
          status: 'completed',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'mw_backend_001', status: 'completed', vehicle_id: 'veh_qa_fleet_501' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'mw_backend_001', status: 'completed', plate_number: 'QA-FLEET-501' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'veh_qa_fleet_501', status: 'available' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          vehicle_maintenance_window_id: 'mw_backend_002',
          vehicle_id: 'veh_qa_fleet_501',
          status: 'cancelled',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'mw_backend_002', status: 'cancelled', vehicle_id: 'veh_qa_fleet_501' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'mw_backend_002', status: 'cancelled', plate_number: 'QA-FLEET-501' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'veh_qa_fleet_501', status: 'available' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          vehicle_event_id: 'veh_event_backend_001',
          vehicle_id: 'veh_qa_fleet_501',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'veh_event_backend_001', vehicle_id: 'veh_qa_fleet_501', event_type: 'inspection' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'veh_qa_fleet_501', status: 'available' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'veh_qa_fleet_501', plate_number: 'QA-FLEET-501', event_count_24h: 1 },
        error: null,
      });

    const ds = await import('../data-source');
    const completed = await ds.complete_maintenance_v1(completePayload);
    const cancelled = await ds.cancel_maintenance_v1(cancelPayload);
    const recorded = await ds.record_vehicle_event_v1(eventPayload);

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('complete_maintenance_v1', {
      p_args: completePayload,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('cancel_maintenance_v1', {
      p_args: cancelPayload,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('record_vehicle_event_v1', {
      p_args: eventPayload,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'vehicle_maintenance_windows',
      p_id: 'mw_backend_001',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'vehicle_maintenance_directory',
      p_id: 'mw_backend_001',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'vehicle_events',
      p_id: 'veh_event_backend_001',
    });
    expect(completed).toMatchObject({ ok: true, status: 'completed' });
    expect(cancelled).toMatchObject({ ok: true, status: 'cancelled' });
    expect(recorded).toMatchObject({ ok: true, vehicle_event_id: 'veh_event_backend_001' });
  });

  it('accepts vehicle maintenance directory readback when raw window UI resource is unavailable', async () => {
    const completePayload = {
      vehicle_maintenance_window_id: 'mw_backend_projection_001',
      notes: 'maintenance finished from projection readback',
    };

    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          vehicle_maintenance_window_id: 'mw_backend_projection_001',
          vehicle_id: 'veh_qa_fleet_projection',
          status: 'completed',
        },
        error: null,
      })
      .mockRejectedValueOnce(new Error('ui_list_resource_v1 unknown resource vehicle_maintenance_windows'))
      .mockResolvedValueOnce({
        data: {
          id: 'mw_backend_projection_001',
          status: 'completed',
          vehicle_id: 'veh_qa_fleet_projection',
          plate_number: 'QA-FLEET-PROJECTION',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'veh_qa_fleet_projection', status: 'available' },
        error: null,
      });

    const ds = await import('../data-source');
    const completed = await ds.complete_maintenance_v1(completePayload);

    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'vehicle_maintenance_windows',
      p_id: 'mw_backend_projection_001',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'vehicle_maintenance_directory',
      p_id: 'mw_backend_projection_001',
    });
    expect(completed).toMatchObject({ ok: true, status: 'completed' });
  });

  it('routes basket create, edit, and state transition through live api RPCs', async () => {
    const createPayload = {
      organization_id: 'org_demo',
      zone_id: 'zone_ruh_north',
      basket_type: 'zone_based',
      state: 'forming',
      capacity_count: 40,
      expires_in_minutes: 240,
    };
    const updatePayload = {
      basket_id: 'bsk_backend_001',
      patch: {
        capacity_count: 45,
        basket_type: 'route_based',
      },
    };
    const transitionPayload = {
      basket_id: 'bsk_backend_001',
      state: 'ready',
      reason: 'scan-out complete',
    };

    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          basket_id: 'bsk_backend_001',
          state: 'forming',
          correlation_id: 'corr_basket_create',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          basket_id: 'bsk_backend_001',
          changed: { capacity_count: 45, basket_type: 'route_based' },
          correlation_id: 'corr_basket_update',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          basket_id: 'bsk_backend_001',
          previous_state: 'forming',
          new_state: 'ready',
          correlation_id: 'corr_basket_transition',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const created = await ds.basket_create_v1(createPayload);
    const updated = await ds.basket_update_v1(updatePayload);
    const transitioned = await ds.ui_update_basket_state_v1(transitionPayload);

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'basket_create_v1', {
      p_args: createPayload,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'basket_update_v1', {
      p_args: updatePayload,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_update_basket_state_v1', {
      p_args: transitionPayload,
    });
    expect(created).toMatchObject({ ok: true, basket_id: 'bsk_backend_001' });
    expect(updated).toMatchObject({ ok: true, basket_id: 'bsk_backend_001' });
    expect(transitioned).toMatchObject({
      ok: true,
      basket_id: 'bsk_backend_001',
      new_state: 'ready',
    });
  });

  it('fails closed when basket and zone live mutations omit backend evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });

    const ds = await import('../data-source');

    await expect(ds.basket_create_v1({ organization_id: 'org_demo' })).rejects.toThrow(
      'basket_create_v1 did not return backend execution evidence',
    );
    await expect(ds.basket_update_v1({ basket_id: 'basket_demo', patch: { capacity_count: 25 } })).rejects.toThrow(
      'basket_update_v1 did not return backend execution evidence',
    );
    await expect(ds.zone_create_v1({ name: 'North', code: 'north' })).rejects.toThrow(
      'zone_create_v1 did not return backend execution evidence',
    );
    await expect(ds.zone_update_v1({ zone_id: 'zone_demo', patch: { name: 'North 2' } })).rejects.toThrow(
      'zone_update_v1 did not return backend execution evidence',
    );
    await expect(ds.zone_delete_v1({ zone_id: 'zone_demo', reason: 'retired' })).rejects.toThrow(
      'zone_delete_v1 did not return backend execution evidence',
    );
    await expect(ds.zone_district_add_v1({ zone_id: 'zone_demo', district_id: 'district_demo' })).rejects.toThrow(
      'zone_district_add_v1 did not return backend execution evidence',
    );
    await expect(ds.zone_district_remove_v1({ zone_district_id: 'zd_demo' })).rejects.toThrow(
      'zone_district_remove_v1 did not return backend execution evidence',
    );
  });

  it('routes Dispatch departure confirmation through the live api RPC wrapper', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          route_run_id: 'run_2841',
          route_departure: {
            confirmed_at: '2026-05-08T08:00:00.000Z',
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: 'run_2841',
          metadata: {
            route_departure: {
              confirmed_at: '2026-05-08T08:00:00.000Z',
            },
          },
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_confirm_route_run_departure_v1('run_2841');

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_confirm_route_run_departure_v1', {
      p_input: { route_run_id: 'run_2841' },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'route_runs',
      p_id: 'run_2841',
    });
    expect(result).toMatchObject({
      ok: true,
      run_id: 'run_2841',
      departure_confirmed_at: '2026-05-08T08:00:00.000Z',
    });
  });

  it('fails closed when Dispatch departure confirmation lacks canonical route-departure readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          route_run_id: 'run_2841',
          confirmed_at: '2026-05-08T08:00:00.000Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: 'run_2841',
          metadata: {
            departure: {
              confirmed_at: '2026-05-08T08:00:00.000Z',
            },
          },
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_confirm_route_run_departure_v1('run_2841')).rejects.toThrow(
      'route_runs departure confirmation',
    );
  });

  it('fails closed with backend scan-out detail when Dispatch departure is blocked', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: 'route_departure_blocked',
        route_run_id: 'run_2841',
        blocked_reason: 'route_load_reconciliation',
        scan_out: {
          missing_route_stop_ids: ['stop_1'],
          duplicate_route_stop_ids: ['stop_2'],
          unexpected_barcodes: ['BOX-9'],
        },
        error: {
          code: '23514',
          message:
            'confirm_route_run_departure_v1 route_run run_2841 is not ready for departure (missing 1, duplicate 1, unexpected 1); missing_route_stop_ids ["stop_1"], duplicate_route_stop_ids ["stop_2"], unexpected_barcodes ["BOX-9"]',
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.ui_confirm_route_run_departure_v1('run_2841')).rejects.toThrow(
      'missing_route_stop_ids ["stop_1"]',
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Dispatch departure confirmation lacks route-run readback proof', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          route_run_id: 'run_2841',
          route_departure: {
            confirmed_at: '2026-05-08T08:00:00.000Z',
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: 'run_2841',
          status: 'departing',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_confirm_route_run_departure_v1('run_2841')).rejects.toThrow(
      'route_runs departure confirmation',
    );
  });

  it('routes warehouse transfer actions through browser-safe api RPCs', async () => {
    const transferId = '00000000-0000-4000-8000-000000000161';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          warehouse_transfer_id: transferId,
          workflow_run_id: '00000000-0000-4000-8000-000000000162',
          correlation_id: '00000000-0000-4000-8000-000000000163',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          warehouse_transfer_id: transferId,
          updated: true,
          status: 'received',
          dispatched_at: null,
          received_at: '2026-05-03T08:00:00.000Z',
        }],
        error: null,
      });

    const ds = await import('../data-source');
    const executed = await ds.warehouse_transfer_execute_v1({
      warehouse_transfer_id: transferId,
    });
    const transitioned = await ds.transition_warehouse_transfer_v1({
      warehouse_transfer_id: transferId,
      to_status: 'received',
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'warehouse_transfer_execute_v1', {
      p_args: { warehouse_transfer_id: transferId },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'transition_warehouse_transfer_v1', {
      p_input: { warehouse_transfer_id: transferId, to_status: 'received' },
    });
    expect(executed).toMatchObject({ ok: true, warehouse_transfer_id: transferId });
    expect(transitioned).toMatchObject({
      ok: true,
      warehouse_transfer_id: transferId,
      to_status: 'received',
      updated: true,
    });
  });

  it('reads route-plan execution packs through the api schema after publish', async () => {
    const planId = '00000000-0000-4000-8000-000000000171';
    mocks.rpc.mockResolvedValueOnce({
      data: {
        route_plan_id: planId,
        execution_pack_hash: '0xpack171',
        stop_count: 12,
        shipment_count: 18,
      },
      error: null,
    });

    const ds = await import('../data-source');
    const pack = await ds.ui_route_plan_execution_pack_v1(planId);

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_route_plan_execution_pack_v1', {
      p_route_plan_id: planId,
    });
    expect(pack).toEqual(expect.objectContaining({
      route_plan_id: planId,
      execution_pack_hash: '0xpack171',
      stop_count: 12,
      shipment_count: 18,
    }));
  });

  it('routes generic command actions through canonical api command executor', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        action_key: 'shipments.print_labels',
        workflow_run_id: '00000000-0000-4000-8000-000000000133',
        settings_resolution_id: '00000000-0000-4000-8000-000000000134',
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.runCommand(
      'shipments.print_labels',
      {
        resource_key: 'shipments',
        selected_ids: ['00000000-0000-4000-8000-000000000132'],
        reason: 'label damaged',
      },
      { dryRun: true },
    );

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_execute_command_v1', {
      p_action_key: 'shipments.print_labels',
      p_resource_key: 'shipments',
      p_selection_ids: ['00000000-0000-4000-8000-000000000132'],
      p_selection_id: '00000000-0000-4000-8000-000000000132',
      p_selection_count: 1,
      p_params: {
        resource_key: 'shipments',
        selected_ids: ['00000000-0000-4000-8000-000000000132'],
        reason: 'label damaged',
        dry_run: true,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      command: 'shipments.print_labels',
      workflow_run_id: '00000000-0000-4000-8000-000000000133',
    });
  });

  it('resolves resource downloads through the browser-safe edge function', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {
        url: 'https://storage.example.test/object/sign/labels/shp.pdf?token=signed',
        expires_at: '2026-05-06T08:15:00Z',
        file_name: 'shp.pdf',
        mime_type: 'application/pdf',
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.resolve_resource_download_url_v1({
      resource: 'labels',
      id: '00000000-0000-4000-8000-000000000132',
      expires_seconds: 900,
    });

    expect(mocks.invoke).toHaveBeenCalledWith('ui-resource-download', {
      body: {
        resource: 'labels',
        id: '00000000-0000-4000-8000-000000000132',
        expires_seconds: 900,
      },
    });
    expect(result).toMatchObject({
      url: 'https://storage.example.test/object/sign/labels/shp.pdf?token=signed',
      expires_at: '2026-05-06T08:15:00Z',
      file_name: 'shp.pdf',
      mime_type: 'application/pdf',
    });
  });

  it('fails closed when resource download returns no signed URL', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: { ok: true },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.resolve_resource_download_url_v1({
      resource: 'labels',
      id: '00000000-0000-4000-8000-000000000132',
    })).rejects.toThrow('returned no signed URL');
  });

  it('surfaces resource download edge-function error bodies', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'Edge Function returned a non-2xx status code',
        context: {
          json: vi.fn().mockResolvedValue({ error: 'labels.download capability required' }),
        },
      },
    });

    const ds = await import('../data-source');
    await expect(ds.resolve_resource_download_url_v1({
      resource: 'labels',
      id: '00000000-0000-4000-8000-000000000132',
    })).rejects.toThrow('labels.download capability required');
  });

  it('requires backend readback after live print-label command execution', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          action_key: 'shipments.print_labels',
          workflow_run_id: '00000000-0000-4000-8000-000000000133',
          settings_resolution_id: '00000000-0000-4000-8000-000000000134',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000135',
            workflow_run_id: '00000000-0000-4000-8000-000000000133',
            shipment_id: '00000000-0000-4000-8000-000000000132',
            status: 'pending',
          }],
          total: 1,
          limit: 25,
          offset: 0,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000133',
          workflow_status: 'queued',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.runCommand(
      'shipments.print_labels',
      {
        resource_key: 'shipments',
        selected_ids: ['00000000-0000-4000-8000-000000000132'],
      },
      { dryRun: false },
    );

    expect(result.workflow_run_id).toBe('00000000-0000-4000-8000-000000000133');
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_list_resource_v1', {
      p_resource: 'label_jobs',
      p_filters: { workflow_run_id: '00000000-0000-4000-8000-000000000133' },
      p_limit: 25,
      p_offset: 0,
      p_sort: { key: 'created_at', direction: 'desc' },
    });
  });

  it('fails closed when live print-label command has no workflow or label-job readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          action_key: 'shipments.print_labels',
          workflow_run_id: '00000000-0000-4000-8000-000000000133',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [], total: 0, limit: 25, offset: 0 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.runCommand(
      'shipments.print_labels',
      {
        resource_key: 'shipments',
        selected_ids: ['00000000-0000-4000-8000-000000000132'],
      },
      { dryRun: false },
    )).rejects.toThrow('backend readback missing workflow_runs or label_jobs');
  });

  it('fails closed when live print-label workflow readback is failed', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          action_key: 'shipments.print_labels',
          workflow_run_id: '00000000-0000-4000-8000-000000000133',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [], total: 0, limit: 25, offset: 0 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000133',
          workflow_status: 'failed',
          failure_reason: 'resolve_label_renderer_invoke_config_v1: provider invoke configuration not activated',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.runCommand(
      'shipments.print_labels',
      {
        resource_key: 'shipments',
        selected_ids: ['00000000-0000-4000-8000-000000000132'],
      },
      { dryRun: false },
    )).rejects.toThrow('provider invoke configuration not activated');
  });

  it('fails closed when live print-label workflow fails even if a stale pending label job is visible', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          action_key: 'shipments.print_labels',
          workflow_run_id: '00000000-0000-4000-8000-000000000133',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000135',
            shipment_id: '00000000-0000-4000-8000-000000000132',
            status: 'pending',
          }],
          total: 1,
          limit: 25,
          offset: 0,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000133',
          workflow_status: 'failed',
          failure_reason: 'resolve_label_renderer_invoke_config_v1: provider invoke configuration not activated',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.runCommand(
      'shipments.print_labels',
      {
        resource_key: 'shipments',
        selected_ids: ['00000000-0000-4000-8000-000000000132'],
      },
      { dryRun: false },
    )).rejects.toThrow('provider invoke configuration not activated');
  });

  it('fails closed when generic command actions return no backend execution evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          action_key: 'shipments.print_labels',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.runCommand(
      'shipments.print_labels',
      {
        resource_key: 'shipments',
        selected_ids: ['00000000-0000-4000-8000-000000000132'],
      },
      { dryRun: false },
    )).rejects.toThrow('no backend outcome');
    await expect(ds.runCommand(
      'shipments.print_labels',
      {
        resource_key: 'shipments',
        selected_ids: ['00000000-0000-4000-8000-000000000132'],
      },
      { dryRun: false },
    )).rejects.toThrow('backend execution evidence');
  });

  it('fails closed when label reprint returns no backend job or version id', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: '', error: null })
      .mockResolvedValueOnce({ data: {}, error: null });

    const ds = await import('../data-source');
    await expect(ds.request_label_reprint(
      '00000000-0000-4000-8000-000000000401',
      { reason: 'operator_request' },
    )).rejects.toThrow('Label reprint did not return');
    await expect(ds.request_label_reprint(
      '00000000-0000-4000-8000-000000000401',
      { reason: 'operator_request' },
    )).rejects.toThrow('Label reprint did not return');
  });

  it('requires backend label-job readback after live label reprint', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: '00000000-0000-4000-8000-000000000402',
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000402',
          label_id: '00000000-0000-4000-8000-000000000401',
          status: 'pending',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.request_label_reprint(
      '00000000-0000-4000-8000-000000000401',
      { reason: 'operator_request' },
    );

    expect(result).toMatchObject({
      ok: true,
      label_id: '00000000-0000-4000-8000-000000000401',
      label_job_id: '00000000-0000-4000-8000-000000000402',
      new_version_id: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'label_jobs',
      p_id: '00000000-0000-4000-8000-000000000402',
    });
  });

  it('accepts target-neutral artifact lineage readback after live label reprint', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: '00000000-0000-4000-8000-000000000502',
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000502',
          label_id: null,
          target_type: 'route_run',
          target_id: '00000000-0000-4000-8000-000000000503',
          target_metadata: {
            source_label_artifact_id: '00000000-0000-4000-8000-000000000501',
            source_label_job_id: '00000000-0000-4000-8000-000000000500',
          },
          status: 'pending',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.request_label_reprint(
      '00000000-0000-4000-8000-000000000501',
      { reason: 'operator_request' },
    );

    expect(result).toMatchObject({
      ok: true,
      label_id: '00000000-0000-4000-8000-000000000501',
      label_job_id: '00000000-0000-4000-8000-000000000502',
      new_version_id: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'label_jobs',
      p_id: '00000000-0000-4000-8000-000000000502',
    });
  });

  it('fails closed when live label reprint lacks label job or version readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: '00000000-0000-4000-8000-000000000402',
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.request_label_reprint(
      '00000000-0000-4000-8000-000000000401',
      { reason: 'operator_request' },
    )).rejects.toThrow('Label reprint backend readback missing label_jobs or label_versions');
  });

  it('requires label job, label, and version readback after live label completion', async () => {
    const jobId = '00000000-0000-4000-8000-000000000420';
    const labelId = '00000000-0000-4000-8000-000000000421';
    const shipmentId = '00000000-0000-4000-8000-000000000422';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          label_job_id: jobId,
          status: 'completed',
          correlation_id: '00000000-0000-4000-8000-000000000423',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: jobId,
          status: 'succeeded',
          label_id: labelId,
          shipment_id: shipmentId,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: labelId,
          shipment_id: shipmentId,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000424',
            label_job_id: jobId,
            label_id: labelId,
            version_status: 'active',
          }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.complete_label_job(jobId, {
      status: 'completed',
      file_url: '/storage/labels/shp-1.pdf',
      renderer_metadata: { correlation_id: '00000000-0000-4000-8000-000000000423' },
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'complete_label_job', {
      p_args: {
        label_job_id: jobId,
        status: 'completed',
        file_url: '/storage/labels/shp-1.pdf',
        renderer_metadata: { correlation_id: '00000000-0000-4000-8000-000000000423' },
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'label_jobs',
      p_id: jobId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'labels',
      p_id: labelId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_list_resource_v1', {
      p_resource: 'label_versions',
      p_filters: { label_job_id: jobId },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(result.label_job_id).toBe(jobId);
  });

  it('fails closed when completed shipment label lacks version readback', async () => {
    const jobId = '00000000-0000-4000-8000-000000000420';
    const labelId = '00000000-0000-4000-8000-000000000421';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          label_job_id: jobId,
          status: 'completed',
          correlation_id: '00000000-0000-4000-8000-000000000423',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: jobId,
          status: 'succeeded',
          label_id: labelId,
          shipment_id: '00000000-0000-4000-8000-000000000422',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: labelId }, error: null })
      .mockResolvedValueOnce({ data: { rows: [], total: 0 }, error: null });

    const ds = await import('../data-source');
    await expect(ds.complete_label_job(jobId, {
      status: 'completed',
      file_url: '/storage/labels/shp-1.pdf',
    })).rejects.toThrow('complete_label_job backend readback missing label_versions');
  });

  it('requires target-neutral label artifact readback after live label completion', async () => {
    const jobId = '00000000-0000-4000-8000-000000000430';
    const artifactId = '00000000-0000-4000-8000-000000000431';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          label_job_id: jobId,
          status: 'completed',
          correlation_id: '00000000-0000-4000-8000-000000000433',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: jobId,
          status: 'succeeded',
          label_id: artifactId,
          target_type: 'route_run',
          target_id: '00000000-0000-4000-8000-000000000432',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: artifactId,
          source_label_job_id: jobId,
          target_type: 'route_run',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.complete_label_job(jobId, {
      status: 'completed',
      file_url: '/storage/labels/route-run.pdf',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'label_artifacts',
      p_id: artifactId,
    });
  });

  it('requires published label-design draft readback after live publish', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          settings_version_id: '00000000-0000-4000-8000-000000000412',
          scope_type: 'tenant',
          scope_id: '00000000-0000-4000-8000-000000000411',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          drafts: [{
            id: '00000000-0000-4000-8000-000000000410',
            organization_id: '00000000-0000-4000-8000-000000000411',
            scope_type: 'tenant',
            scope_id: '00000000-0000-4000-8000-000000000411',
            label_type: 'shipping',
            draft_name: 'Active design',
            draft_value: {},
            status: 'published',
            published_settings_version_id: '00000000-0000-4000-8000-000000000412',
            published_at: '2026-05-08T07:00:00Z',
            created_at: '2026-05-08T06:00:00Z',
            updated_at: '2026-05-08T07:00:00Z',
          }],
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.label_designer_publish_label_design_draft(
      '00000000-0000-4000-8000-000000000410',
      'activate tenant design',
      {
        scopeType: 'tenant',
        scopeId: '00000000-0000-4000-8000-000000000411',
      },
    );

    expect(result).toMatchObject({
      ok: true,
      settings_version_id: '00000000-0000-4000-8000-000000000412',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'label_designer_list_drafts', {
      p_scope_type: 'tenant',
      p_scope_id: '00000000-0000-4000-8000-000000000411',
    });
  });

  it('fails closed when live label-design publish lacks published draft readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          settings_version_id: '00000000-0000-4000-8000-000000000412',
          scope_type: 'tenant',
          scope_id: '00000000-0000-4000-8000-000000000411',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { ok: true, drafts: [] },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.label_designer_publish_label_design_draft(
      '00000000-0000-4000-8000-000000000410',
      'activate tenant design',
      {
        scopeType: 'tenant',
        scopeId: '00000000-0000-4000-8000-000000000411',
      },
    )).rejects.toThrow('published draft readback missing draft');
  });

  it('requires label-design draft list readback after live create and update', async () => {
    const createdDraft = {
      id: '00000000-0000-4000-8000-000000000420',
      organization_id: '00000000-0000-4000-8000-000000000421',
      scope_type: 'tenant',
      scope_id: '00000000-0000-4000-8000-000000000421',
      label_type: 'shipping',
      draft_name: 'Saved draft',
      draft_value: { templates: { shipping: { blocks: [] } } },
      status: 'draft',
      published_settings_version_id: null,
      published_at: null,
      created_at: '2026-05-23T12:00:00Z',
      updated_at: '2026-05-23T12:00:00Z',
    };
    const updatedDraft = {
      ...createdDraft,
      draft_name: 'Saved draft updated',
      updated_at: '2026-05-23T12:01:00Z',
    };
    mocks.rpc
      .mockResolvedValueOnce({ data: { ok: true, draft: createdDraft }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, drafts: [createdDraft] }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, draft: updatedDraft }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, drafts: [updatedDraft] }, error: null });

    const ds = await import('../data-source');
    const createResult = await ds.label_designer_create_draft({
      scope_type: 'tenant',
      scope_id: '00000000-0000-4000-8000-000000000421',
      label_type: 'shipping',
      draft_name: 'Saved draft',
      draft_value: { templates: { shipping: { blocks: [] } } },
    });
    const updateResult = await ds.label_designer_update_draft({
      draft_id: '00000000-0000-4000-8000-000000000420',
      label_type: 'shipping',
      draft_name: 'Saved draft updated',
      draft_value: { templates: { shipping: { blocks: [] } } },
    });

    expect(createResult.draft?.draft_name).toBe('Saved draft');
    expect(updateResult.draft?.draft_name).toBe('Saved draft updated');
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'label_designer_list_drafts', {
      p_scope_type: 'tenant',
      p_scope_id: '00000000-0000-4000-8000-000000000421',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'label_designer_list_drafts', {
      p_scope_type: 'tenant',
      p_scope_id: '00000000-0000-4000-8000-000000000421',
    });
  });

  it('fails closed when live label-design draft mutations lack list readback', async () => {
    const draft = {
      id: '00000000-0000-4000-8000-000000000430',
      organization_id: '00000000-0000-4000-8000-000000000431',
      scope_type: 'tenant',
      scope_id: '00000000-0000-4000-8000-000000000431',
      label_type: 'shipping',
      draft_name: 'Stale draft',
      draft_value: { templates: { shipping: { blocks: [] } } },
      status: 'draft',
      published_settings_version_id: null,
      published_at: null,
      created_at: '2026-05-23T12:00:00Z',
      updated_at: '2026-05-23T12:00:00Z',
    };
    mocks.rpc
      .mockResolvedValueOnce({ data: { ok: true, draft }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, drafts: [] }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, draft }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, drafts: [] }, error: null });

    const ds = await import('../data-source');
    await expect(ds.label_designer_create_draft({
      scope_type: 'tenant',
      scope_id: '00000000-0000-4000-8000-000000000431',
      draft_value: { templates: { shipping: { blocks: [] } } },
    })).rejects.toThrow('label_designer_create_draft backend draft list readback missing draft');
    await expect(ds.label_designer_update_draft({
      draft_id: '00000000-0000-4000-8000-000000000430',
      draft_value: { templates: { shipping: { blocks: [] } } },
    })).rejects.toThrow('label_designer_update_draft backend draft list readback missing draft');
  });

  it('requires archived label-design draft readback after live archive', async () => {
    const archivedDraft = {
      id: '00000000-0000-4000-8000-000000000440',
      organization_id: '00000000-0000-4000-8000-000000000441',
      scope_type: 'tenant',
      scope_id: '00000000-0000-4000-8000-000000000441',
      label_type: 'shipping',
      draft_name: 'Stale draft',
      draft_value: { templates: { shipping: { blocks: [] } } },
      status: 'archived',
      archive_reason: 'cleanup',
      archived_at: '2026-05-27T19:00:00Z',
      archived_by: '00000000-0000-4000-8000-000000000442',
      published_settings_version_id: null,
      published_at: null,
      created_at: '2026-05-27T18:00:00Z',
      updated_at: '2026-05-27T19:00:00Z',
    };
    mocks.rpc
      .mockResolvedValueOnce({ data: { ok: true, draft: archivedDraft }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, drafts: [archivedDraft] }, error: null });

    const ds = await import('../data-source');
    const result = await ds.label_designer_archive_draft({
      draft_id: '00000000-0000-4000-8000-000000000440',
      archive_reason: 'cleanup',
    });

    expect(result.draft?.status).toBe('archived');
    expect(result.draft?.archive_reason).toBe('cleanup');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'label_designer_archive_draft', {
      p_draft_id: '00000000-0000-4000-8000-000000000440',
      p_archive_reason: 'cleanup',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'label_designer_list_drafts', {
      p_scope_type: 'tenant',
      p_scope_id: '00000000-0000-4000-8000-000000000441',
    });
  });

  it('fails closed when live label-design archive readback is not archived', async () => {
    const staleDraft = {
      id: '00000000-0000-4000-8000-000000000450',
      organization_id: '00000000-0000-4000-8000-000000000451',
      scope_type: 'tenant',
      scope_id: '00000000-0000-4000-8000-000000000451',
      label_type: 'shipping',
      draft_name: 'Still active draft',
      draft_value: { templates: { shipping: { blocks: [] } } },
      status: 'draft',
      published_settings_version_id: null,
      published_at: null,
      created_at: '2026-05-27T18:00:00Z',
      updated_at: '2026-05-27T19:00:00Z',
    };
    mocks.rpc
      .mockResolvedValueOnce({ data: { ok: true, draft: { ...staleDraft, status: 'archived' } }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, drafts: [staleDraft] }, error: null });

    const ds = await import('../data-source');
    await expect(ds.label_designer_archive_draft({
      draft_id: '00000000-0000-4000-8000-000000000450',
      archive_reason: 'cleanup',
    })).rejects.toThrow('label_designer_archive_draft backend draft list readback is not archived');
  });

  it('fails closed when live label designer RPCs omit backend evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { errors: [] }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });

    const ds = await import('../data-source');

    await expect(ds.label_designer_list_drafts('tenant', 'org_demo')).rejects.toThrow(
      'label_designer_list_drafts returned no backend draft list',
    );
    await expect(ds.label_designer_create_draft({
      scope_type: 'tenant',
      scope_id: 'org_demo',
      draft_value: { templates: {} },
    })).rejects.toThrow('label_designer_create_draft did not return backend draft evidence');
    await expect(ds.label_designer_update_draft({
      draft_id: 'draft_demo',
      draft_value: { templates: {} },
    })).rejects.toThrow('label_designer_update_draft did not return backend draft evidence');
    await expect(ds.label_designer_archive_draft({
      draft_id: 'draft_demo',
      archive_reason: 'cleanup',
    })).rejects.toThrow('label_designer_archive_draft did not return backend draft evidence');
    await expect(ds.label_designer_validate_label_design_draft('draft_demo')).rejects.toThrow(
      'label_designer_validate_label_design_draft did not return backend validation evidence',
    );
    await expect(ds.label_designer_publish_label_design_draft('draft_demo', 'activate')).rejects.toThrow(
      'label_designer_publish_label_design_draft did not return backend publish evidence',
    );
  });

  it('normalizes guarded route scan-out reconciliation counters from live payloads', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          route_run_id: '00000000-0000-4000-8000-000000000034',
          expected_stop_count: 18,
          scanned_stop_count: 17,
          missing_stop_count: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000034', status: 'planned' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: '00000000-0000-4000-8000-000000000134',
              route_run_id: '00000000-0000-4000-8000-000000000034',
            },
          ],
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.route_run_scan_out_reconciliation_v1(
      '00000000-0000-4000-8000-000000000034',
    );

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('route_run_scan_out_reconciliation_v1', {
      p_route_run_id: '00000000-0000-4000-8000-000000000034',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'route_runs',
      p_id: '00000000-0000-4000-8000-000000000034',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'route_stops',
      p_filters: { route_run_id: '00000000-0000-4000-8000-000000000034' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(result).toMatchObject({
      ok: true,
      expected: 18,
      scanned: 17,
      run_id: '00000000-0000-4000-8000-000000000034',
    });
    expect(result.discrepancies).toContain('Missing 1 route load scan');
  });

  it('fails closed when scan-out reconciliation lacks explicit backend counts', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        route_run_id: '00000000-0000-4000-8000-000000000034',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.route_run_scan_out_reconciliation_v1(
      '00000000-0000-4000-8000-000000000034',
    )).rejects.toThrow('expected count');
  });

  it('routes delivery slot list and reserve through guarded live wrappers', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000035', client_id: '00000000-0000-4000-8000-000000000036' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          slot_date: '2026-05-04',
          window_start_local: '10:00',
          window_end_local: '12:00',
          capacity_remaining: 8,
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          reserved: true,
          action_id: '00000000-0000-4000-8000-000000000037',
          reserved_at: '2026-05-04T10:00:00.000Z',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const slots = await ds.list_delivery_slots_v1({
      shipment_id: '00000000-0000-4000-8000-000000000035',
      slot_date: '2026-05-04',
    });
    const result = await ds.reserve_delivery_slot_v1({
      shipment_id: '00000000-0000-4000-8000-000000000035',
      client_id: '00000000-0000-4000-8000-000000000036',
      slot_date: '2026-05-04',
      window_id: 'win_2026_05_04_10_00_12_00',
      window_start_local: '10:00',
      window_end_local: '12:00',
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_get_resource_v1', {
      p_resource: 'shipments',
      p_id: '00000000-0000-4000-8000-000000000035',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'list_delivery_slots_v1', {
      p_input: {
        shipment_id: '00000000-0000-4000-8000-000000000035',
        slot_date: '2026-05-04',
        client_id: '00000000-0000-4000-8000-000000000036',
        start_date: '2026-05-04',
        days: 1,
        include_unavailable: false,
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'reserve_delivery_slot_v1', {
      p_input: {
        shipment_id: '00000000-0000-4000-8000-000000000035',
        client_id: '00000000-0000-4000-8000-000000000036',
        slot_date: '2026-05-04',
        window_id: 'win_2026_05_04_10_00_12_00',
        window_start_local: '10:00',
        window_end_local: '12:00',
        performed_by_system: 'console-v2',
      },
    });
    expect(slots).toEqual([expect.objectContaining({ remaining: 8 })]);
    expect(result).toMatchObject({ ok: true, reserved: true });
  });

  it('routes tenant invite role catalog through the users.manage-gated api RPC', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ role_key: 'ops_admin', name: 'Operations admin', is_active: true }],
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.ui_list_tenant_invitable_roles_v1({
      organization_id: '00000000-0000-4000-8000-000000000041',
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_tenant_invitable_roles_v1', {
      p_organization_id: '00000000-0000-4000-8000-000000000041',
    });
    expect(result.rows).toEqual([{ role_key: 'ops_admin', name: 'Operations admin', is_active: true }]);
  });

  it('requires user, directory, RBAC assignment, and canonical hosted redirect readback after tenant invite', async () => {
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'https://unjijvxjrwurjgsnokovrvom.example.invalid/');
    const invitedUserId = '00000000-0000-4000-8000-000000000341';
    const assignmentId = '00000000-0000-4000-8000-000000000342';
    const decisionId = '00000000-0000-4000-8000-000000000345';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          user_id: invitedUserId,
          rbac_user_role_assignment_id: assignmentId,
          email: 'ops@example.test',
          role_key: 'ops_admin',
          invite_email_sent: true,
          settings_resolution_id: decisionId,
        },
        correlation_id: '00000000-0000-4000-8000-000000000343',
      },
      error: null,
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: { id: invitedUserId, email: 'ops@example.test', status: 'invited', access_scope_type: 'client', access_scope_id: '00000000-0000-4000-8000-000000000346' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: invitedUserId, email: 'ops@example.test', active_role_keys: ['ops_admin'], access_scope_type: 'client', access_scope_id: '00000000-0000-4000-8000-000000000346' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: assignmentId,
          user_id: invitedUserId,
          role_id: '00000000-0000-4000-8000-000000000344',
          role_key: 'ops_admin',
          revoked_at: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000344', key: 'ops_admin', is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000344', key: 'ops_admin', is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [], total: 0, limit: 5, offset: 0 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: decisionId,
            resource_type: 'user',
            resource_id: invitedUserId,
            decision_point: 'tenant_user_invite_apply_v1',
            correlation_id: '00000000-0000-4000-8000-000000000343',
            role_key: 'ops_admin',
            invite_email: 'ops@example.test',
            invite_email_sent: 'true',
            send_invite_email_requested: 'true',
            invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
            decision_inputs: {
              email: 'ops@example.test',
              role_key: 'ops_admin',
              rbac_user_role_assignment_id: assignmentId,
              invite_email_sent: true,
              send_invite_email_requested: true,
              invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
            },
          }],
          total: 1,
          limit: 5,
          offset: 0,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.tenant_user_invite_v1({
      email: 'ops@example.test',
      full_name: 'Ops User',
      role_key: 'ops_admin',
      organization_id: '00000000-0000-4000-8000-000000000041',
      access_scope_type: 'client',
      access_scope_id: '00000000-0000-4000-8000-000000000346',
    });

    expect(result).toMatchObject({ ok: true, user_id: invitedUserId, role_key: 'ops_admin' });
    expect(mocks.invoke).toHaveBeenCalledWith('tenant-user-invite', {
      body: expect.objectContaining({
        email: 'ops@example.test',
        role_key: 'ops_admin',
        access_scope_type: 'client',
        access_scope_id: '00000000-0000-4000-8000-000000000346',
        send_invite_email: true,
        invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
      }),
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'users',
      p_id: invitedUserId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'user_directory',
      p_id: invitedUserId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'rbac_user_role_assignments',
      p_id: assignmentId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_user_security_actions_v1', {
      p_target_user_id: invitedUserId,
      p_limit: 5,
    });
    expect(
      mocks.rpc.mock.calls.filter(([rpc]) => rpc === 'ui_list_user_security_actions_v1'),
    ).toHaveLength(2);
  });

  it('preserves no-hosted tenant invite intent when hosted redirects are configured', async () => {
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback');
    const invitedUserId = '00000000-0000-4000-8000-000000000351';
    const assignmentId = '00000000-0000-4000-8000-000000000352';
    const decisionId = '00000000-0000-4000-8000-000000000355';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          user_id: invitedUserId,
          rbac_user_role_assignment_id: assignmentId,
          email: 'ops.noemail@example.test',
          role_key: 'ops_admin',
          invite_email_sent: false,
          settings_resolution_id: decisionId,
        },
        correlation_id: '00000000-0000-4000-8000-000000000353',
      },
      error: null,
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: { id: invitedUserId, email: 'ops.noemail@example.test', status: 'invited', access_scope_type: 'tenant', access_scope_id: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: invitedUserId, email: 'ops.noemail@example.test', active_role_keys: ['ops_admin'], access_scope_type: 'tenant', access_scope_id: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: assignmentId,
          user_id: invitedUserId,
          role_id: '00000000-0000-4000-8000-000000000354',
          role_key: 'ops_admin',
          revoked_at: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000354', key: 'ops_admin', is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000354', key: 'ops_admin', is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: decisionId,
            resource_type: 'user',
            resource_id: invitedUserId,
            decision_point: 'tenant_user_invite_apply_v1',
            correlation_id: '00000000-0000-4000-8000-000000000353',
            role_key: 'ops_admin',
            invite_email: 'ops.noemail@example.test',
            invite_email_sent: 'false',
            send_invite_email_requested: 'false',
            invite_redirect_to: null,
            decision_inputs: {
              email: 'ops.noemail@example.test',
              role_key: 'ops_admin',
              invite_email_sent: false,
              send_invite_email_requested: false,
              invite_redirect_to: null,
            },
          }],
          total: 1,
          limit: 5,
          offset: 0,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.tenant_user_invite_v1({
      email: 'ops.noemail@example.test',
      full_name: 'Ops No Email',
      role_key: 'ops_admin',
      organization_id: '00000000-0000-4000-8000-000000000041',
      send_invite_email: false,
      invite_redirect_to: null,
    });

    expect(result).toMatchObject({ ok: true, user_id: invitedUserId, role_key: 'ops_admin' });
    expect(mocks.invoke).toHaveBeenCalledWith('tenant-user-invite', {
      body: expect.objectContaining({
        email: 'ops.noemail@example.test',
        role_key: 'ops_admin',
        send_invite_email: false,
        invite_redirect_to: null,
      }),
    });
  });

  it('passes explicit tenant invite resend intent through the live edge function', async () => {
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback');
    const invitedUserId = '00000000-0000-4000-8000-000000000361';
    const assignmentId = '00000000-0000-4000-8000-000000000362';
    const decisionId = '00000000-0000-4000-8000-000000000365';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        invite_email_sent: true,
        result: {
          user_id: invitedUserId,
          rbac_user_role_assignment_id: assignmentId,
          email: 'ops.resend@example.test',
          role_key: 'ops_admin',
          invite_email_sent: true,
          settings_resolution_id: decisionId,
        },
        correlation_id: '00000000-0000-4000-8000-000000000363',
      },
      error: null,
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: { id: invitedUserId, email: 'ops.resend@example.test', status: 'invited', access_scope_type: 'tenant', access_scope_id: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: invitedUserId, email: 'ops.resend@example.test', active_role_keys: ['ops_admin'], access_scope_type: 'tenant', access_scope_id: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: assignmentId,
          user_id: invitedUserId,
          role_id: '00000000-0000-4000-8000-000000000364',
          role_key: 'ops_admin',
          revoked_at: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000364', key: 'ops_admin', is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000364', key: 'ops_admin', is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: decisionId,
            resource_type: 'user',
            resource_id: invitedUserId,
            decision_point: 'tenant_user_invite_apply_v1',
            correlation_id: '00000000-0000-4000-8000-000000000363',
            role_key: 'ops_admin',
            invite_email: 'ops.resend@example.test',
            invite_email_sent: 'true',
            send_invite_email_requested: 'true',
            invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
            decision_inputs: {
              email: 'ops.resend@example.test',
              role_key: 'ops_admin',
              rbac_user_role_assignment_id: assignmentId,
              invite_email_sent: true,
              send_invite_email_requested: true,
              invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
            },
          }],
          total: 1,
          limit: 5,
          offset: 0,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.tenant_user_invite_v1({
      email: 'ops.resend@example.test',
      full_name: 'Ops Resend',
      role_key: 'ops_admin',
      organization_id: '00000000-0000-4000-8000-000000000041',
      send_invite_email: true,
      invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
      resend_existing_invite: true,
    });

    expect(result).toMatchObject({ ok: true, user_id: invitedUserId, role_key: 'ops_admin' });
    expect(mocks.invoke).toHaveBeenCalledWith('tenant-user-invite', {
      body: expect.objectContaining({
        email: 'ops.resend@example.test',
        role_key: 'ops_admin',
        send_invite_email: true,
        invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
        resend_existing_invite: true,
      }),
    });
  });

  it('fails closed when tenant invite security-action readback is stale', async () => {
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback');
    const invitedUserId = '00000000-0000-4000-8000-000000000371';
    const assignmentId = '00000000-0000-4000-8000-000000000372';
    const decisionId = '00000000-0000-4000-8000-000000000375';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          user_id: invitedUserId,
          rbac_user_role_assignment_id: assignmentId,
          email: 'ops.fresh@example.test',
          role_key: 'ops_admin',
          invite_email_sent: true,
          settings_resolution_id: decisionId,
        },
        correlation_id: '00000000-0000-4000-8000-000000000373',
      },
      error: null,
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: { id: invitedUserId, email: 'ops.fresh@example.test', status: 'invited', access_scope_type: 'tenant', access_scope_id: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: invitedUserId, email: 'ops.fresh@example.test', active_role_keys: ['ops_admin'], access_scope_type: 'tenant', access_scope_id: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: assignmentId,
          user_id: invitedUserId,
          role_id: '00000000-0000-4000-8000-000000000374',
          role_key: 'ops_admin',
          revoked_at: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000374', key: 'ops_admin', is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000374', key: 'ops_admin', is_active: true },
        error: null,
      })
      .mockResolvedValue({
        data: {
          rows: [{
            id: decisionId,
            resource_type: 'user',
            resource_id: invitedUserId,
            decision_point: 'tenant_user_invite_apply_v1',
            correlation_id: '00000000-0000-4000-8000-000000000373',
            role_key: 'ops_admin',
            invite_email: 'ops.stale@example.test',
            invite_email_sent: 'true',
            send_invite_email_requested: 'true',
            invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
            decision_inputs: {
              email: 'ops.stale@example.test',
              role_key: 'ops_admin',
              rbac_user_role_assignment_id: assignmentId,
              invite_email_sent: true,
              send_invite_email_requested: true,
              invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
            },
          }],
          total: 1,
          limit: 5,
          offset: 0,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.tenant_user_invite_v1({
      email: 'ops.fresh@example.test',
      full_name: 'Ops Fresh',
      role_key: 'ops_admin',
      organization_id: '00000000-0000-4000-8000-000000000041',
    })).rejects.toThrow('tenant-user-invite backend readback missing user security action');
  });

  it('fails closed when no-hosted tenant invite readback omits explicit redirect evidence', async () => {
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback');
    const invitedUserId = '00000000-0000-4000-8000-000000000381';
    const assignmentId = '00000000-0000-4000-8000-000000000382';
    const decisionId = '00000000-0000-4000-8000-000000000385';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          user_id: invitedUserId,
          rbac_user_role_assignment_id: assignmentId,
          email: 'ops.no-redirect-key@example.test',
          role_key: 'ops_admin',
          invite_email_sent: false,
          settings_resolution_id: decisionId,
        },
        correlation_id: '00000000-0000-4000-8000-000000000383',
      },
      error: null,
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: { id: invitedUserId, email: 'ops.no-redirect-key@example.test', status: 'active', access_scope_type: 'tenant', access_scope_id: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: invitedUserId, email: 'ops.no-redirect-key@example.test', active_role_keys: ['ops_admin'], access_scope_type: 'tenant', access_scope_id: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: assignmentId,
          user_id: invitedUserId,
          role_id: '00000000-0000-4000-8000-000000000384',
          role_key: 'ops_admin',
          revoked_at: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000384', key: 'ops_admin', is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000384', key: 'ops_admin', is_active: true },
        error: null,
      })
      .mockResolvedValue({
        data: {
          rows: [{
            id: decisionId,
            resource_type: 'user',
            resource_id: invitedUserId,
            decision_point: 'tenant_user_invite_apply_v1',
            correlation_id: '00000000-0000-4000-8000-000000000383',
            role_key: 'ops_admin',
            invite_email: 'ops.no-redirect-key@example.test',
            invite_email_sent: 'false',
            send_invite_email_requested: 'false',
            invite_redirect_to: null,
            decision_inputs: {
              email: 'ops.no-redirect-key@example.test',
              role_key: 'ops_admin',
              rbac_user_role_assignment_id: assignmentId,
              invite_email_sent: false,
              send_invite_email_requested: false,
            },
          }],
          total: 1,
          limit: 5,
          offset: 0,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.tenant_user_invite_v1({
      email: 'ops.no-redirect-key@example.test',
      full_name: 'Ops No Redirect Key',
      role_key: 'ops_admin',
      organization_id: '00000000-0000-4000-8000-000000000041',
      send_invite_email: false,
      invite_redirect_to: null,
    })).rejects.toThrow('tenant-user-invite backend readback missing user security action');
  });

  it('requires live users and directory readback after platform user lifecycle mutations', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000245';
    const assignmentId = '00000000-0000-4000-8000-000000000246';
    const roleId = '00000000-0000-4000-8000-000000000251';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          user_role_assignment_id: assignmentId,
          target_user_id: targetUserId,
          role_id: roleId,
          role_key: 'finance',
          correlation_id: '00000000-0000-4000-8000-000000000247',
          settings_resolution_id: '00000000-0000-4000-8000-000000000253',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, active_role_keys: ['finance'] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: assignmentId,
          user_id: targetUserId,
          role_id: roleId,
          role_key: 'finance',
          revoked_at: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: roleId, key: 'finance', is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: roleId, key: 'finance', is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000253',
            resource_type: 'rbac_user_role_assignment',
            resource_id: assignmentId,
            decision_point: 'grant_user_role_v1',
            decision_outcome: 'granted',
            correlation_id: '00000000-0000-4000-8000-000000000247',
            decision_inputs: {
              target_user_id: targetUserId,
              role_key: 'finance',
            },
          }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          target_user_id: targetUserId,
          status: 'suspended',
          correlation_id: '00000000-0000-4000-8000-000000000248',
          settings_resolution_id: '00000000-0000-4000-8000-000000000254',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, status: 'suspended' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, status: 'suspended', active_role_keys: ['finance'] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000254',
            resource_type: 'user',
            resource_id: targetUserId,
            decision_point: 'suspend_user_v1',
            decision_outcome: 'suspended',
            correlation_id: '00000000-0000-4000-8000-000000000248',
          }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValue({
        data: { rows: [], total: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.grant_user_role_v1({
      target_user_id: targetUserId,
      role_key: 'finance',
    });
    const suspended = await ds.suspend_user_v1({ target_user_id: targetUserId });

    expect(suspended.status).toBe('suspended');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'grant_user_role_v1', {
      p_args: { target_user_id: targetUserId, role_key: 'finance' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'users',
      p_id: targetUserId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'user_directory',
      p_id: targetUserId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_get_resource_v1', {
      p_resource: 'rbac_user_role_assignments',
      p_id: assignmentId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'ui_get_resource_v1', {
      p_resource: 'rbac_roles',
      p_id: roleId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(6, 'ui_get_resource_v1', {
      p_resource: 'rbac_role_summary',
      p_id: roleId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(7, 'ui_list_user_security_actions_v1', {
      p_target_user_id: targetUserId,
      p_limit: 5,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(8, 'suspend_user_v1', {
      p_args: { target_user_id: targetUserId },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(9, 'ui_get_resource_v1', {
      p_resource: 'users',
      p_id: targetUserId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(10, 'ui_get_resource_v1', {
      p_resource: 'user_directory',
      p_id: targetUserId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(11, 'ui_list_user_security_actions_v1', {
      p_target_user_id: targetUserId,
      p_limit: 5,
    });
  });

  it('requires user security-action readback after force password reset', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000252';
    const intentId = '00000000-0000-4000-8000-000000000253';
    const reason = 'Security review';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          target_user_id: targetUserId,
          password_reset_intent_id: intentId,
          correlation_id: '00000000-0000-4000-8000-000000000254',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, active_role_keys: ['ops_admin'] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: '00000000-0000-4000-8000-000000000255',
              resource_type: 'user',
              resource_id: targetUserId,
              decision_point: 'force_password_reset_v1',
              decision_outcome: 'pending',
              password_reset_intent_id: intentId,
              action_reason: reason,
              correlation_id: '00000000-0000-4000-8000-000000000254',
            },
          ],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.force_password_reset_v1({
      target_user_id: targetUserId,
      email: 'operator@example.test',
      reason,
    });

    expect(result.password_reset_intent_id).toBe(intentId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'force_password_reset_v1', {
      p_args: { target_user_id: targetUserId, email: 'operator@example.test', reason },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_list_user_security_actions_v1', {
      p_target_user_id: targetUserId,
      p_limit: 5,
    });
  });

  it('fails closed when force password reset is missing an operator reason', async () => {
    const ds = await import('../data-source');

    await expect(ds.force_password_reset_v1({
      target_user_id: '00000000-0000-4000-8000-000000000256',
      reason: '   ',
    })).rejects.toThrow('force_password_reset_v1 requires reason');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('fails closed when force password reset lacks security-action readback', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000256';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          target_user_id: targetUserId,
          password_reset_intent_id: '00000000-0000-4000-8000-000000000257',
          correlation_id: '00000000-0000-4000-8000-000000000258',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, active_role_keys: ['ops_admin'] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [], total: 0 },
        error: null,
      })
      .mockResolvedValue({
        data: { rows: [], total: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.force_password_reset_v1({
      target_user_id: targetUserId,
      reason: 'Security review',
    })).rejects.toThrow(
      'force_password_reset_v1 backend readback missing user security action',
    );
  });

  it('fails closed when force password reset reason is not persisted in readback', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000263';
    const intentId = '00000000-0000-4000-8000-000000000264';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          target_user_id: targetUserId,
          password_reset_intent_id: intentId,
          correlation_id: '00000000-0000-4000-8000-000000000265',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, active_role_keys: ['ops_admin'] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: '00000000-0000-4000-8000-000000000266',
              resource_type: 'user',
              resource_id: targetUserId,
              decision_point: 'force_password_reset_v1',
              password_reset_intent_id: intentId,
              action_reason: 'Different reason',
              correlation_id: '00000000-0000-4000-8000-000000000265',
            },
          ],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.force_password_reset_v1({
      target_user_id: targetUserId,
      reason: 'Security review',
    })).rejects.toThrow('force_password_reset_v1 backend readback missing persisted action reason');
  });

  it('requires pending session revocation readback after live session revoke', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000259';
    const sessionId = '00000000-0000-4000-8000-000000000260';
    const auditId = '00000000-0000-4000-8000-000000000261';
    const decisionId = '00000000-0000-4000-8000-000000000263';
    const correlationId = '00000000-0000-4000-8000-000000000262';
    const reason = 'Revoked by operator';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          target_user_id: targetUserId,
          revocation_audit_id: auditId,
          status: 'pending',
          correlation_id: correlationId,
          settings_resolution_id: decisionId,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: sessionId,
              user_id: targetUserId,
              revocation_audit_id: auditId,
              revocation_status: 'pending',
              revocation_reason: reason,
            },
          ],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: decisionId,
              resource_type: 'user',
              resource_id: targetUserId,
              decision_point: 'revoke_session_v1',
              decision_outcome: 'pending',
              correlation_id: correlationId,
              decision_inputs: {
                session_id: sessionId,
                reason,
              },
              action_reason: reason,
            },
          ],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.revoke_session_v1({
      target_user_id: targetUserId,
      session_id: sessionId,
      reason,
    });

    expect(result.revocation_audit_id).toBe(auditId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'revoke_session_v1', {
      p_args: { target_user_id: targetUserId, session_id: sessionId, reason },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_list_user_sessions_v1', {
      p_target_user_id: targetUserId,
      p_limit: 50,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_list_user_security_actions_v1', {
      p_target_user_id: targetUserId,
      p_limit: 5,
    });
  });

  it('fails closed when live session revoke is missing an operator reason', async () => {
    const ds = await import('../data-source');

    await expect(ds.revoke_session_v1({
      target_user_id: '00000000-0000-4000-8000-000000000267',
      session_id: '00000000-0000-4000-8000-000000000268',
      reason: '',
    })).rejects.toThrow('revoke_session_v1 requires reason');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('fails closed when live session revoke lacks session readback', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000269';
    const sessionId = '00000000-0000-4000-8000-000000000270';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          target_user_id: targetUserId,
          revocation_audit_id: '00000000-0000-4000-8000-000000000271',
          status: 'pending',
          correlation_id: '00000000-0000-4000-8000-000000000272',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: sessionId,
              user_id: targetUserId,
              revocation_status: null,
            },
          ],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.revoke_session_v1({
      target_user_id: targetUserId,
      session_id: sessionId,
      reason: 'Security rotation',
    })).rejects.toThrow('revoke_session_v1 backend readback missing revoked session evidence');
  });

  it('fails closed when live session revoke reason is not persisted in readback', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000271';
    const sessionId = '00000000-0000-4000-8000-000000000272';
    const auditId = '00000000-0000-4000-8000-000000000273';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          target_user_id: targetUserId,
          revocation_audit_id: auditId,
          status: 'pending',
          correlation_id: '00000000-0000-4000-8000-000000000274',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: sessionId,
              user_id: targetUserId,
              revocation_audit_id: auditId,
              revocation_status: 'pending',
              revocation_reason: 'Different reason',
            },
          ],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.revoke_session_v1({
      target_user_id: targetUserId,
      session_id: sessionId,
      reason: 'Security rotation',
    })).rejects.toThrow('revoke_session_v1 backend readback missing persisted revocation reason');
  });

  it('fails closed when live session revoke lacks security action readback', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000275';
    const sessionId = '00000000-0000-4000-8000-000000000276';
    const auditId = '00000000-0000-4000-8000-000000000277';
    const decisionId = '00000000-0000-4000-8000-000000000278';
    const correlationId = '00000000-0000-4000-8000-000000000279';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          target_user_id: targetUserId,
          revocation_audit_id: auditId,
          status: 'pending',
          correlation_id: correlationId,
          settings_resolution_id: decisionId,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: sessionId,
              user_id: targetUserId,
              revocation_audit_id: auditId,
              revocation_status: 'pending',
              revocation_reason: 'Security rotation',
            },
          ],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [],
          total: 0,
        },
        error: null,
      })
      .mockResolvedValue({
        data: { rows: [], total: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.revoke_session_v1({
      target_user_id: targetUserId,
      session_id: sessionId,
      reason: 'Security rotation',
    })).rejects.toThrow('revoke_session_v1 backend readback missing user security action');
  });

  it('requires user device and drawer summary readback after live device revoke', async () => {
    const deviceId = '00000000-0000-4000-8000-000000000273';
    const revokedAt = '2026-05-12T02:00:00.000Z';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'revoked',
          device_id: deviceId,
          count: 1,
          items: [{ id: deviceId, revoked_at: revokedAt, revoked_reason: 'Security rotation' }],
          correlation_id: '00000000-0000-4000-8000-000000000274',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: deviceId,
          is_revoked: true,
          revoked_at: revokedAt,
          revoked_reason: 'Security rotation',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: deviceId,
          is_revoked: true,
          revoked_at: revokedAt,
          revoked_reason: 'Security rotation',
          push_token_cleared: true,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.ui_execute_user_device_revoke_v1(deviceId, 'Security rotation');

    expect(result.revoked_at).toBe(revokedAt);
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'user_devices',
      p_id: deviceId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'user_device_summary',
      p_id: deviceId,
    });
  });

  it('fails closed when live device revoke readback is not revoked', async () => {
    const deviceId = '00000000-0000-4000-8000-000000000275';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'revoked',
          device_id: deviceId,
          count: 1,
          items: [{ id: deviceId, revoked_at: '2026-05-12T02:00:00.000Z' }],
          correlation_id: '00000000-0000-4000-8000-000000000276',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: deviceId, is_revoked: false, revoked_at: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: deviceId, is_revoked: false, revoked_at: null },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_execute_user_device_revoke_v1(deviceId, 'Security rotation')).rejects.toThrow(
      `ui_execute_user_device_revoke_v1 backend readback device ${deviceId} is not revoked`,
    );
  });

  it('requires user security-action readback after live user role grant', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000301';
    const assignmentId = '00000000-0000-4000-8000-000000000302';
    const roleId = '00000000-0000-4000-8000-000000000303';
    const decisionId = '00000000-0000-4000-8000-000000000304';
    const correlationId = '00000000-0000-4000-8000-000000000305';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_user_role_assignment_id: assignmentId,
          target_user_id: targetUserId,
          role_id: roleId,
          role_key: 'finance',
          correlation_id: correlationId,
          settings_resolution_id: decisionId,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: targetUserId, status: 'active' }, error: null })
      .mockResolvedValueOnce({ data: { id: targetUserId, active_role_keys: ['finance'] }, error: null })
      .mockResolvedValueOnce({
        data: { id: assignmentId, user_id: targetUserId, role_id: roleId, role_key: 'finance', revoked_at: null },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: roleId, is_active: true }, error: null })
      .mockResolvedValueOnce({ data: { id: roleId, is_active: true }, error: null })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: decisionId,
            resource_type: 'rbac_user_role_assignment',
            resource_id: assignmentId,
            decision_point: 'grant_user_role_v1',
            decision_outcome: 'granted',
            correlation_id: correlationId,
            decision_inputs: {
              target_user_id: targetUserId,
              role_key: 'finance',
              reason: 'Need finance access',
            },
          }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValue({
        data: { rows: [], total: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.grant_user_role_v1({
      target_user_id: targetUserId,
      role_key: 'finance',
      reason: 'Need finance access',
    });

    expect(result.rbac_user_role_assignment_id).toBe(assignmentId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(7, 'ui_list_user_security_actions_v1', {
      p_target_user_id: targetUserId,
      p_limit: 5,
    });
  });

  it('requires user security-action readback after live user role revoke', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000306';
    const assignmentId = '00000000-0000-4000-8000-000000000307';
    const roleId = '00000000-0000-4000-8000-000000000308';
    const decisionId = '00000000-0000-4000-8000-000000000309';
    const correlationId = '00000000-0000-4000-8000-000000000310';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_user_role_assignment_id: assignmentId,
          target_user_id: targetUserId,
          role_id: roleId,
          role_key: 'finance',
          correlation_id: correlationId,
          settings_resolution_id: decisionId,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: targetUserId, status: 'active' }, error: null })
      .mockResolvedValueOnce({ data: { id: targetUserId, active_role_keys: [] }, error: null })
      .mockResolvedValueOnce({
        data: {
          id: assignmentId,
          user_id: targetUserId,
          role_id: roleId,
          role_key: 'finance',
          revoked_at: '2026-05-20T14:30:00.000Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: roleId, is_active: true }, error: null })
      .mockResolvedValueOnce({ data: { id: roleId, is_active: true }, error: null })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: decisionId,
            resource_type: 'rbac_user_role_assignment',
            resource_id: assignmentId,
            decision_point: 'revoke_user_role_v1',
            decision_outcome: 'revoked',
            correlation_id: correlationId,
            decision_inputs: {
              target_user_id: targetUserId,
              role_key: 'finance',
              reason: 'Role no longer required',
            },
          }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.revoke_user_role_v1({
      target_user_id: targetUserId,
      role_key: 'finance',
      reason: 'Role no longer required',
    });

    expect(result.rbac_user_role_assignment_id).toBe(assignmentId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(7, 'ui_list_user_security_actions_v1', {
      p_target_user_id: targetUserId,
      p_limit: 5,
    });
  });

  it('requires user security-action readback after live suspend and reactivate', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000311';
    const suspendDecisionId = '00000000-0000-4000-8000-000000000312';
    const reactivateDecisionId = '00000000-0000-4000-8000-000000000313';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          target_user_id: targetUserId,
          status: 'suspended',
          correlation_id: '00000000-0000-4000-8000-000000000314',
          settings_resolution_id: suspendDecisionId,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: targetUserId, status: 'suspended' }, error: null })
      .mockResolvedValueOnce({ data: { id: targetUserId, active_role_keys: ['ops_admin'] }, error: null })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: suspendDecisionId,
            resource_type: 'user',
            resource_id: targetUserId,
            decision_point: 'suspend_user_v1',
            decision_outcome: 'suspended',
            correlation_id: '00000000-0000-4000-8000-000000000314',
            action_reason: 'Security review',
          }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          target_user_id: targetUserId,
          status: 'active',
          correlation_id: '00000000-0000-4000-8000-000000000315',
          settings_resolution_id: reactivateDecisionId,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: targetUserId, status: 'active' }, error: null })
      .mockResolvedValueOnce({ data: { id: targetUserId, active_role_keys: ['ops_admin'] }, error: null })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: reactivateDecisionId,
            resource_type: 'user',
            resource_id: targetUserId,
            decision_point: 'reactivate_user_v1',
            decision_outcome: 'reactivated',
            correlation_id: '00000000-0000-4000-8000-000000000315',
          }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.suspend_user_v1({ target_user_id: targetUserId, reason: 'Security review' });
    await ds.reactivate_user_v1({ target_user_id: targetUserId });

    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_list_user_security_actions_v1', {
      p_target_user_id: targetUserId,
      p_limit: 5,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(8, 'ui_list_user_security_actions_v1', {
      p_target_user_id: targetUserId,
      p_limit: 5,
    });
  });

  it('fails closed when user role grant readback is not active', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000261';
    const assignmentId = '00000000-0000-4000-8000-000000000262';
    const roleId = '00000000-0000-4000-8000-000000000263';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_user_role_assignment_id: assignmentId,
          target_user_id: targetUserId,
          role_id: roleId,
          role_key: 'finance',
          correlation_id: '00000000-0000-4000-8000-000000000264',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, active_role_keys: ['ops_admin'] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: assignmentId,
          user_id: targetUserId,
          role_id: roleId,
          role_key: 'finance',
          revoked_at: '2026-05-12T00:00:00.000Z',
        },
        error: null,
      })
      .mockResolvedValue({
        data: { rows: [], total: 0 },
        error: null,
      })
      .mockResolvedValue({
        data: { rows: [], total: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.grant_user_role_v1({
      target_user_id: targetUserId,
      role_key: 'finance',
    })).rejects.toThrow('grant_user_role_v1 backend readback missing active rbac assignment');
  });

  it('fails closed when user role grant security action readback is stale for a different role', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000316';
    const assignmentId = '00000000-0000-4000-8000-000000000317';
    const roleId = '00000000-0000-4000-8000-000000000318';
    const decisionId = '00000000-0000-4000-8000-000000000319';
    const correlationId = '00000000-0000-4000-8000-000000000320';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_user_role_assignment_id: assignmentId,
          target_user_id: targetUserId,
          role_id: roleId,
          role_key: 'finance',
          correlation_id: correlationId,
          settings_resolution_id: decisionId,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: targetUserId, status: 'active' }, error: null })
      .mockResolvedValueOnce({ data: { id: targetUserId, active_role_keys: ['finance'] }, error: null })
      .mockResolvedValueOnce({
        data: { id: assignmentId, user_id: targetUserId, role_id: roleId, role_key: 'finance', revoked_at: null },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: roleId, is_active: true }, error: null })
      .mockResolvedValueOnce({ data: { id: roleId, is_active: true }, error: null })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: decisionId,
            resource_type: 'rbac_user_role_assignment',
            resource_id: assignmentId,
            decision_point: 'grant_user_role_v1',
            decision_outcome: 'granted',
            correlation_id: correlationId,
            decision_inputs: {
              target_user_id: targetUserId,
              role_key: 'ops_admin',
            },
          }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValue({
        data: { rows: [], total: 0 },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.grant_user_role_v1({
      target_user_id: targetUserId,
      role_key: 'finance',
    })).rejects.toThrow('grant_user_role_v1 backend readback missing user security action');
  });

  it('fails closed when user role revoke readback still shows an active role', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000265';
    const assignmentId = '00000000-0000-4000-8000-000000000266';
    const roleId = '00000000-0000-4000-8000-000000000267';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_user_role_assignment_id: assignmentId,
          target_user_id: targetUserId,
          role_id: roleId,
          role_key: 'finance',
          correlation_id: '00000000-0000-4000-8000-000000000268',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: targetUserId, active_role_keys: ['finance'] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: assignmentId,
          user_id: targetUserId,
          role_id: roleId,
          role_key: 'finance',
          revoked_at: null,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.revoke_user_role_v1({
      target_user_id: targetUserId,
      role_key: 'finance',
    })).rejects.toThrow('revoke_user_role_v1 backend readback assignment');
  });

  it('fails closed when platform user lifecycle readback is missing after mutation', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000249';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          target_user_id: targetUserId,
          correlation_id: '00000000-0000-4000-8000-000000000250',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.reactivate_user_v1({ target_user_id: targetUserId })).rejects.toThrow(
      `reactivate_user_v1 backend readback missing users:${targetUserId}`,
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'reactivate_user_v1', {
      p_args: { target_user_id: targetUserId },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'users',
      p_id: targetUserId,
    });
  });

  it('fails closed when tenant edge-function mutations return no backend evidence', async () => {
    mocks.invoke
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({
        data: {
          result: {
            tenant_signup_request_id: '00000000-0000-4000-8000-000000000241',
            status: 'approved',
          },
          correlation_id: '00000000-0000-4000-8000-000000000242',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          result: {
            organization_id: '00000000-0000-4000-8000-000000000243',
          },
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.tenant_signup_console_request_v1({
      email: 'launch@example.test',
      full_name: 'Launch Owner',
      organization_name: 'Launch Tenant',
    })).rejects.toThrow('no backend outcome');
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000241',
          status: 'approved',
          review_decision: 'approved',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000241',
          status: 'approved',
          review_decision: 'approved',
        },
        error: null,
      });
    await expect(ds.tenant_signup_review_apply_v1({
      request_id: '00000000-0000-4000-8000-000000000241',
      decision: 'approved',
    })).rejects.toThrow('approval readback missing approved organization');
    await expect(ds.ui_update_organization_profile_v1({
      organization_id: '00000000-0000-4000-8000-000000000243',
      name: 'Launch Tenant',
    })).rejects.toThrow('backend execution evidence');
  });

  it('requires tenant signup queue and summary readback after console request', async () => {
    const requestId = '00000000-0000-4000-8000-000000000241';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        tenant_signup_request_id: requestId,
        status: 'queued',
        organization_name: 'Stale Edge Tenant',
        email: 'stale-edge@example.test',
        full_name: 'Stale Edge Owner',
        correlation_id: '00000000-0000-4000-8000-000000000242',
      },
      error: null,
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          id: requestId,
          status: 'pending',
          organization_name: 'Launch Tenant',
          email: 'launch@example.test',
          full_name: 'Launch Owner',
          metadata: { created_via: 'tenant-signup-console-request' },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: requestId,
          status: 'pending',
          completion_status: 'waiting_review',
          attestation_count: 2,
          attestation_passed_count: 2,
          attestation_complete: true,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.tenant_signup_console_request_v1({
      email: 'launch@example.test',
      full_name: 'Launch Owner',
      organization_name: 'Launch Tenant',
    });

    expect(result).toMatchObject({
      tenant_signup_request_id: requestId,
      request_id: requestId,
      id: requestId,
      status: 'pending',
      organization_name: 'Launch Tenant',
      email: 'launch@example.test',
      full_name: 'Launch Owner',
      completion_status: 'waiting_review',
      attestation_count: 2,
      attestation_passed_count: 2,
      attestation_complete: true,
      metadata: { created_via: 'tenant-signup-console-request' },
    });
    expect(result.organization_name).not.toBe('Stale Edge Tenant');
    expect(result.email).not.toBe('stale-edge@example.test');
    expect(result.full_name).not.toBe('Stale Edge Owner');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_get_resource_v1', {
      p_resource: 'tenant_signup_requests',
      p_id: requestId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'tenant_signup_request_summary',
      p_id: requestId,
    });
  });

  it('fails closed when tenant signup console request lacks canonical queue readback', async () => {
    const requestId = '00000000-0000-4000-8000-000000000241';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        tenant_signup_request_id: requestId,
        status: 'pending',
        correlation_id: '00000000-0000-4000-8000-000000000242',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.tenant_signup_console_request_v1({
      email: 'launch@example.test',
      full_name: 'Launch Owner',
      organization_name: 'Launch Tenant',
    })).rejects.toThrow(`tenant-signup-console-request backend readback missing tenant_signup_requests:${requestId}`);
  });

  it('requires request, summary, organization, and user readback after tenant approval', async () => {
    const requestId = '00000000-0000-4000-8000-000000000241';
    const organizationId = '00000000-0000-4000-8000-000000000243';
    const userId = '00000000-0000-4000-8000-000000000244';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        tenant_signup_request_id: requestId,
        decision: 'approved',
        reviewed_at: '2026-05-08T09:00:00.000Z',
        approved_organization_id: organizationId,
        approved_user_id: userId,
        invite_email_sent_at: '2026-05-08T09:00:01.000Z',
        correlation_id: '00000000-0000-4000-8000-000000000242',
      },
      error: null,
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          id: requestId,
          status: 'approved',
          review_decision: 'approved',
          approved_organization_id: organizationId,
          approved_user_id: userId,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: requestId,
          status: 'approved',
          review_decision: 'approved',
          approved_organization_id: organizationId,
          approved_user_id: userId,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: organizationId, name: 'Launch Tenant' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: userId, email: 'launch@example.test', status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: userId, email: 'launch@example.test', organization_id: organizationId },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.tenant_signup_review_apply_v1({
      request_id: requestId,
      decision: 'approved',
    });

    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'organizations',
      p_id: organizationId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'user_directory',
      p_id: userId,
    });
  });

  it('accepts tenant approval evidence from canonical readback when the edge response is status-only', async () => {
    const requestId = '00000000-0000-4000-8000-000000000251';
    const organizationId = '00000000-0000-4000-8000-000000000253';
    const userId = '00000000-0000-4000-8000-000000000254';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        tenant_signup_request_id: requestId,
        status: 'approved',
        correlation_id: '00000000-0000-4000-8000-000000000252',
      },
      error: null,
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          id: requestId,
          status: 'approved',
          review_decision: 'approved',
          approved_organization_id: organizationId,
          approved_user_id: userId,
          approved_auth_user_id: userId,
          invite_email_sent_at: '2026-05-08T09:00:01.000Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: requestId,
          status: 'approved',
          review_decision: 'approved',
          approved_organization_id: organizationId,
          approved_user_id: userId,
          approved_auth_user_id: userId,
          invite_email_sent_at: '2026-05-08T09:00:01.000Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: organizationId, name: 'Launch Tenant' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: userId, email: 'launch@example.test', status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: userId, email: 'launch@example.test', status: 'active' },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.tenant_signup_review_apply_v1({
      request_id: requestId,
      decision: 'approved',
    });

    expect(result).toMatchObject({
      tenant_signup_request_id: requestId,
      status: 'approved',
      approved_organization_id: organizationId,
      approved_user_id: userId,
      approved_auth_user_id: userId,
      invite_email_sent_at: '2026-05-08T09:00:01.000Z',
    });
  });

  it('requires organization readback after organization profile update', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000243';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        organization_id: organizationId,
        name: 'Launch Tenant',
        timezone: 'Asia/Riyadh',
        locale: 'en-SA',
        branding: {
          logo_url: 'https://assets.example.test/logo.png',
          primary_color: '#123456',
          secondary_color: '#abcdef',
        },
        default_settings: {
          branding: {
            logo_url: 'https://assets.example.test/logo.png',
            primary_color: '#123456',
            secondary_color: '#abcdef',
          },
          profile_audit: { marker: 'readback-proof' },
        },
        changed_fields: ['name'],
        updated_at: '2026-05-08T09:00:00.000Z',
        correlation_id: '00000000-0000-4000-8000-000000000244',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: organizationId,
        name: 'Launch Tenant',
        timezone: 'Asia/Riyadh',
        locale: 'en-SA',
        default_settings: {
          branding: {
            logo_url: 'https://assets.example.test/logo.png',
            primary_color: '#123456',
            secondary_color: '#abcdef',
          },
          profile_audit: { marker: 'readback-proof' },
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    await ds.ui_update_organization_profile_v1({
      organization_id: organizationId,
      name: 'Launch Tenant',
      timezone: 'Asia/Riyadh',
      locale: 'en-SA',
      logo_url: 'https://assets.example.test/logo.png',
      primary_color: '#123456',
      secondary_color: '#abcdef',
      default_settings_patch: { profile_audit: { marker: 'readback-proof' } },
    });

    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'organizations',
      p_id: organizationId,
    });
  });

  it('requires organization logo file metadata readback after profile upload', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000243';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        organization_id: organizationId,
        branding: {
          logo_url: 'https://assets.example.test/logo-upload.png',
          logo_file_name: 'logo-upload.png',
          logo_content_type: 'image/png',
          logo_artifact_id: '00000000-0000-4000-8000-000000000245',
          logo_storage_bucket: 'organization-assets',
          logo_storage_key: '00000000-0000-4000-8000-000000000243/branding/logo-upload.png',
        },
        updated_at: '2026-05-08T09:00:00.000Z',
        correlation_id: '00000000-0000-4000-8000-000000000244',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: organizationId,
        name: 'Launch Tenant',
        default_settings: {
          branding: {
            logo_url: 'https://assets.example.test/logo-upload.png',
            logo_file_name: 'logo-upload.png',
            logo_content_type: 'image/png',
            logo_artifact_id: '00000000-0000-4000-8000-000000000245',
            logo_storage_bucket: 'organization-assets',
            logo_storage_key: '00000000-0000-4000-8000-000000000243/branding/logo-upload.png',
          },
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    await ds.ui_update_organization_profile_v1({
      organization_id: organizationId,
      logo_url: 'https://assets.example.test/logo-upload.png',
      file_name: 'logo-upload.png',
      content_type: 'image/png',
    });
  });

  it('fails closed when organization logo upload readback omits artifact storage metadata', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000243';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        organization_id: organizationId,
        branding: {
          logo_url: 'https://assets.example.test/logo-upload.png',
          logo_file_name: 'logo-upload.png',
          logo_content_type: 'image/png',
          logo_artifact_id: '00000000-0000-4000-8000-000000000245',
          logo_storage_bucket: 'organization-assets',
          logo_storage_key: '00000000-0000-4000-8000-000000000243/branding/logo-upload.png',
        },
        updated_at: '2026-05-08T09:00:00.000Z',
        correlation_id: '00000000-0000-4000-8000-000000000244',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: organizationId,
        name: 'Launch Tenant',
        default_settings: {
          branding: {
            logo_url: 'https://assets.example.test/logo-upload.png',
            logo_file_name: 'logo-upload.png',
            logo_content_type: 'image/png',
            logo_artifact_id: '00000000-0000-4000-8000-000000000245',
            logo_storage_bucket: 'organization-assets',
          },
        },
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.ui_update_organization_profile_v1({
      organization_id: organizationId,
      logo_url: 'https://assets.example.test/logo-upload.png',
      file_name: 'logo-upload.png',
      content_type: 'image/png',
    })).rejects.toThrow('organization-profile backend readback mismatch for default_settings.branding.logo_storage_key');
  });

  it('fails closed when organization profile readback does not match submitted fields', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000243';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        organization_id: organizationId,
        name: 'Launch Tenant',
        branding: { logo_url: 'https://assets.example.test/logo.png' },
        updated_at: '2026-05-08T09:00:00.000Z',
        correlation_id: '00000000-0000-4000-8000-000000000244',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: organizationId,
        name: 'Different Tenant',
        default_settings: { branding: { logo_url: 'https://assets.example.test/logo.png' } },
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.ui_update_organization_profile_v1({
      organization_id: organizationId,
      name: 'Launch Tenant',
      logo_url: 'https://assets.example.test/logo.png',
    })).rejects.toThrow('organization-profile backend readback mismatch for name');
  });

  it('fails closed when tenant invite edge-function mutations omit live user evidence', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        result: { status: 'invited' },
        correlation_id: '00000000-0000-4000-8000-000000000244',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.tenant_user_invite_v1({
      email: 'ops@example.test',
      full_name: 'Ops User',
      role_key: 'ops_admin',
      organization_id: '00000000-0000-4000-8000-000000000041',
    })).rejects.toThrow('tenant-user-invite did not return backend execution evidence');
  });

  it('routes zone creation through the api schema RPC', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        zone_id: '00000000-0000-4000-8000-000000000042',
        initial_district_count: 2,
        correlation_id: '00000000-0000-4000-8000-000000000043',
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.zone_create_v1({
      organization_id: '00000000-0000-4000-8000-000000000041',
      name: 'Central Riyadh',
      initial_district_ids: [
        '00000000-0000-4000-8000-000000000044',
        '00000000-0000-4000-8000-000000000045',
      ],
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('zone_create_v1', {
      p_args: {
        organization_id: '00000000-0000-4000-8000-000000000041',
        name: 'Central Riyadh',
        initial_district_ids: [
          '00000000-0000-4000-8000-000000000044',
          '00000000-0000-4000-8000-000000000045',
        ],
      },
    });
    expect(result).toMatchObject({
      zone_id: '00000000-0000-4000-8000-000000000042',
      initial_district_count: 2,
    });
  });

  it('routes mapping studio save/report through their actual api wrapper arg names', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          mapping_config_id: '00000000-0000-4000-8000-000000000052',
          correlation_id: '00000000-0000-4000-8000-000000000053',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000052', mapping_key: 'shipments.import.default' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000052', mapping_key: 'shipments.import.default', is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000054',
          status: 'succeeded',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000054', status: 'succeeded' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          mapping_config_id: '00000000-0000-4000-8000-000000000052',
          promoted_to_version: 3,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000052', active_version: 3 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000052', active_version: 3, is_active: true },
        error: null,
      });

    const ds = await import('../data-source');
    const artifact = {
      organization_id: '00000000-0000-4000-8000-000000000051',
      artifact: 'tabular_import',
      mapping_key: 'shipments.import.default',
      mapping_config: { fields: { tracking_number: 'awb' } },
    };
    const report = {
      organization_id: '00000000-0000-4000-8000-000000000051',
      artifact_type: 'tabular_import',
      operation_kind: 'mapping_save',
      status: 'succeeded',
    };

    await ds.ui_upsert_mapping_artifact_v1(artifact);
    await ds.ui_create_mapping_operation_report_v1(report);
    await ds.mapping_config_promote_v1({
      mapping_config_id: '00000000-0000-4000-8000-000000000052',
      target_version: 3,
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_upsert_mapping_artifact_v1', {
      p_artifact: artifact,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'mapping_configs',
      p_id: '00000000-0000-4000-8000-000000000052',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'mapping_config_directory',
      p_id: '00000000-0000-4000-8000-000000000052',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_create_mapping_operation_report_v1', {
      p_report: report,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'ui_get_resource_v1', {
      p_resource: 'mapping_operation_reports',
      p_id: '00000000-0000-4000-8000-000000000054',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(6, 'mapping_config_promote_v1', {
      p_args: {
        mapping_config_id: '00000000-0000-4000-8000-000000000052',
        target_version: 3,
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(7, 'ui_get_resource_v1', {
      p_resource: 'mapping_configs',
      p_id: '00000000-0000-4000-8000-000000000052',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(8, 'ui_get_resource_v1', {
      p_resource: 'mapping_config_directory',
      p_id: '00000000-0000-4000-8000-000000000052',
    });
  });

  it('fails closed when mapping studio live save returns no mutation evidence', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true },
      error: null,
    });

    const ds = await import('../data-source');
    const artifact = {
      organization_id: '00000000-0000-4000-8000-000000000051',
      artifact: 'mapping_config',
      mapping_key: 'shipments.import.default',
      mapping_config: { target: 'shipments.create' },
    };

    await expect(ds.ui_upsert_mapping_artifact_v1(artifact)).rejects.toThrow(
      'ui_upsert_mapping_artifact_v1 did not return backend mapping artifact evidence',
    );
    expect(mocks.rpc).toHaveBeenCalledWith('ui_upsert_mapping_artifact_v1', {
      p_artifact: artifact,
    });
  });

  it('confirms deleted mappings disappear from the visible list and usage directory', async () => {
    const mappingId = '00000000-0000-4000-8000-000000000152';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          id: mappingId,
          correlation_id: '00000000-0000-4000-8000-000000000153',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [],
          total: 0,
          page: 1,
          page_size: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [],
          total: 0,
          page: 1,
          page_size: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_delete_mapping_config_v1({
      mapping_config_id: mappingId,
    })).resolves.toMatchObject({ mapping_config_id: mappingId });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_delete_resource_v1', {
      p_resource: 'mapping_configs',
      p_id: mappingId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_list_resource_v1', {
      p_resource: 'mapping_configs',
      p_filters: { id: mappingId },
      p_sort: null,
      p_limit: 1,
      p_offset: 0,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_list_resource_v1', {
      p_resource: 'mapping_config_directory',
      p_filters: { id: mappingId },
      p_sort: null,
      p_limit: 1,
      p_offset: 0,
    });
  });

  it('fails closed when deleted mappings still appear in the visible list', async () => {
    const mappingId = '00000000-0000-4000-8000-000000000154';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          id: mappingId,
          correlation_id: '00000000-0000-4000-8000-000000000155',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{ id: mappingId }],
          total: 1,
          page: 1,
          page_size: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.ui_delete_mapping_config_v1({
      mapping_config_id: mappingId,
    })).rejects.toThrow(/still shows the mapping in Intake mappings/);
  });

  it('routes shared Phase C6 mutation facades through the api schema', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        alert_rule_id: '00000000-0000-4000-8000-000000000051',
        correlation_id: '00000000-0000-4000-8000-000000000052',
      },
      error: null,
    });

    const ds = await import('../data-source');
    await ds.create_alert_rule_v1({
      name: 'High failure rate',
      severity: 'high',
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('create_alert_rule_v1', {
      p_args: {
        name: 'High failure rate',
        severity: 'high',
      },
    });
  });

  it('fails closed when shared Phase C6 live mutations return no backend evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: { ok: false, error: 'policy blocked' }, error: null });

    const ds = await import('../data-source');
    await expect(ds.create_alert_rule_v1({
      name: 'High failure rate',
      severity: 'high',
    })).rejects.toThrow('no backend outcome');
    await expect(ds.create_alert_rule_v1({
      name: 'High failure rate',
      severity: 'high',
    })).rejects.toThrow('policy blocked');
  });

  it('routes marketplace live mutations through named api RPC parameters', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: { ok: true, id: '00000000-0000-4000-8000-000000000091' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { ok: true, id: '00000000-0000-4000-8000-000000000093' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { ok: true, refreshed_count: 2 },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.marketplace_request_create_v1({
      request_kind_key: 'same_day_capacity',
      request_details: { lane: 'RUH-JED' },
    });
    await ds.marketplace_award_respond_v1({
      award_id: '00000000-0000-4000-8000-000000000093',
      response: 'cancel',
      reason: 'capacity returned',
    });
    await ds.marketplace_refresh_reputation_snapshot_v1({
      participant_profile_id: null,
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'marketplace_request_create_v1', {
      p_request_kind_key: 'same_day_capacity',
      p_title: 'RUH-JED',
      p_summary: null,
      p_request_details: { lane: 'RUH-JED' },
      p_items: [],
      p_private_pool: [],
      p_expires_at: null,
      p_metadata: {},
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      'marketplace_award_respond_v1',
      {
        p_award_id: '00000000-0000-4000-8000-000000000093',
        p_decision: 'reject',
        p_metadata: { reason: 'capacity returned' },
      },
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      3,
      'marketplace_refresh_reputation_snapshots_for_visible_v1',
      {
        p_participant_profile_id: null,
      },
    );
  });

  it('routes RBAC, branch, customer, and catalog live mutations through api schema with backend evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_role_id: '00000000-0000-4000-8000-000000000101',
          correlation_id: '00000000-0000-4000-8000-000000000102',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000101',
          key: 'ops_reviewer',
          name: 'Ops Reviewer',
          organization_id: '00000000-0000-4000-8000-000000000041',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000101',
          key: 'ops_reviewer',
          active_assignment_count: 0,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_user_role_assignment_id: '00000000-0000-4000-8000-000000000103',
          correlation_id: '00000000-0000-4000-8000-000000000104',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000103',
          user_id: '00000000-0000-4000-8000-000000000114',
          role_id: '00000000-0000-4000-8000-000000000101',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000101',
          key: 'ops_reviewer',
          organization_id: '00000000-0000-4000-8000-000000000041',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000101',
          key: 'ops_reviewer',
          active_assignment_count: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          branch_id: '00000000-0000-4000-8000-000000000105',
          correlation_id: '00000000-0000-4000-8000-000000000106',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          branch_ids: ['00000000-0000-4000-8000-000000000105'],
          already_oos: [],
          updated_count: 1,
          correlation_id: '00000000-0000-4000-8000-000000000107',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          client_id: '00000000-0000-4000-8000-000000000108',
          correlation_id: '00000000-0000-4000-8000-000000000109',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000108',
          name: 'Client A',
          status: 'active',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          client_id: '00000000-0000-4000-8000-000000000108',
          name: 'Client A',
          status: 'active',
          sender_count: 0,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          service_offering_id: '00000000-0000-4000-8000-000000000110',
          correlation_id: '00000000-0000-4000-8000-000000000111',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          lookup_definition_id: '00000000-0000-4000-8000-000000000112',
          category: 'driver_document_type',
          correlation_id: '00000000-0000-4000-8000-000000000113',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const role = await ds.rbac_create_role_v1({
      key: 'ops_reviewer',
      name: 'Ops Reviewer',
      organization_id: '00000000-0000-4000-8000-000000000041',
    });
    const grant = await ds.rbac_grant_role_v1({
      role_id: '00000000-0000-4000-8000-000000000101',
      user_id: '00000000-0000-4000-8000-000000000114',
    });
    const branch = await ds.branch_create_v1({ name: 'Riyadh East', branch_type: 'branch' });
    const oos = await ds.branch_mark_oos_v1({
      branch_ids: ['00000000-0000-4000-8000-000000000105'],
      reason: 'maintenance',
    });
    const client = await ds.client_create_v1({ name: 'Client A', slug: 'client-a' });
    const offering = await ds.service_offering_create_v1({
      service_level_id: '00000000-0000-4000-8000-000000000115',
    });
    const lookup = await ds.lookup_definition_create_v1({ category: 'driver_document_type' });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'rbac_create_role_v1', {
      p_args: {
        key: 'ops_reviewer',
        name: 'Ops Reviewer',
        organization_id: '00000000-0000-4000-8000-000000000041',
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'rbac_roles',
      p_id: '00000000-0000-4000-8000-000000000101',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'rbac_role_summary',
      p_id: '00000000-0000-4000-8000-000000000101',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'rbac_user_role_assignments',
      p_id: '00000000-0000-4000-8000-000000000103',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('mark_branch_oos_v1', {
      p_args: {
        branch_ids: ['00000000-0000-4000-8000-000000000105'],
        reason: 'maintenance',
      },
    });
    expect(role.rbac_role_id).toBe('00000000-0000-4000-8000-000000000101');
    expect(grant.rbac_user_role_assignment_id).toBe('00000000-0000-4000-8000-000000000103');
    expect(branch.branch_id).toBe('00000000-0000-4000-8000-000000000105');
    expect(oos.updated_count).toBe(1);
    expect(client.client_id).toBe('00000000-0000-4000-8000-000000000108');
    expect(offering.service_offering_id).toBe('00000000-0000-4000-8000-000000000110');
    expect(lookup.lookup_definition_id).toBe('00000000-0000-4000-8000-000000000112');
  });

  it('requires RBAC template provisioning readback through canonical role projections', async () => {
    const driverRoleId = '00000000-0000-4000-8000-000000000131';
    const warehouseRoleId = '00000000-0000-4000-8000-000000000132';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_role_id: driverRoleId,
          rbac_roles: [
            { template_key: 'driver', role_id: driverRoleId, created: true },
            { template_key: 'warehouse_operator', role_id: warehouseRoleId, created: false },
          ],
          organization_id: '00000000-0000-4000-8000-000000000041',
          template_keys: ['driver', 'warehouse_operator'],
          correlation_id: '00000000-0000-4000-8000-000000000133',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: driverRoleId,
          key: 'driver',
          organization_id: '00000000-0000-4000-8000-000000000041',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: driverRoleId,
          key: 'driver',
          permission_count: 3,
          permission_values: ['routes.read', 'shipments.read', 'tasks.complete'],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: '00000000-0000-4000-8000-000000000134',
              key: 'driver',
              permission_count: 3,
              permission_values: ['routes.read', 'shipments.read', 'tasks.complete'],
            },
          ],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: warehouseRoleId,
          key: 'warehouse_operator',
          organization_id: '00000000-0000-4000-8000-000000000041',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: warehouseRoleId,
          key: 'warehouse_operator',
          permission_count: 3,
          permission_values: ['baskets.read', 'shipments.read', 'warehouse.read'],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: '00000000-0000-4000-8000-000000000135',
              key: 'warehouse_operator',
              permission_count: 3,
              permission_values: ['baskets.read', 'shipments.read', 'warehouse.read'],
            },
          ],
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.provision_rbac_roles_from_templates_v1({
      organization_id: '00000000-0000-4000-8000-000000000041',
      template_keys: ['driver', 'warehouse_operator'],
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'provision_rbac_roles_from_templates_v1', {
      p_args: {
        organization_id: '00000000-0000-4000-8000-000000000041',
        template_keys: ['driver', 'warehouse_operator'],
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'rbac_roles',
      p_id: driverRoleId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'rbac_role_summary',
      p_id: driverRoleId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'rbac_roles',
      p_id: warehouseRoleId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'rbac_role_summary',
      p_id: warehouseRoleId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'rbac_role_templates',
      p_filters: { key: 'driver' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'rbac_role_templates',
      p_filters: { key: 'warehouse_operator' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(result.rbac_role_id).toBe(driverRoleId);
    expect(result.rbac_roles).toHaveLength(2);
  });

  it('fails closed when RBAC template provisioning lacks canonical role readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_role_id: '00000000-0000-4000-8000-000000000141',
          rbac_roles: [
            {
              template_key: 'driver',
              role_id: '00000000-0000-4000-8000-000000000141',
              created: true,
            },
          ],
          correlation_id: '00000000-0000-4000-8000-000000000142',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.provision_rbac_roles_from_templates_v1({
      organization_id: '00000000-0000-4000-8000-000000000041',
      template_keys: ['driver'],
    })).rejects.toThrow(
      'provision_rbac_roles_from_templates_v1 backend readback missing rbac_roles:00000000-0000-4000-8000-000000000141',
    );
  });

  it('fails closed when RBAC template provisioning lacks applied permission readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_role_id: '00000000-0000-4000-8000-000000000151',
          rbac_roles: [
            {
              template_key: 'driver',
              role_id: '00000000-0000-4000-8000-000000000151',
              created: false,
            },
          ],
          correlation_id: '00000000-0000-4000-8000-000000000152',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000151',
          key: 'driver',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000151',
          key: 'driver',
          permission_count: 1,
          permission_values: ['routes.read'],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: '00000000-0000-4000-8000-000000000153',
              key: 'driver',
              permission_count: 2,
              permission_values: ['routes.read', 'tasks.complete'],
            },
          ],
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.provision_rbac_roles_from_templates_v1({
      organization_id: '00000000-0000-4000-8000-000000000041',
      template_keys: ['driver'],
    })).rejects.toThrow(
      'provision_rbac_roles_from_templates_v1 backend readback role driver has fewer permissions than its template',
    );
  });

  it('fails closed when RBAC role mutations lack canonical role readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_role_id: '00000000-0000-4000-8000-000000000121',
          correlation_id: '00000000-0000-4000-8000-000000000122',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.rbac_create_role_v1({
      role_id: 'ops_reviewer',
      organization_id: '00000000-0000-4000-8000-000000000041',
    })).rejects.toThrow(
      'rbac_create_role_v1 backend readback missing rbac_roles:00000000-0000-4000-8000-000000000121',
    );
  });

  it('fails closed when RBAC assignment mutations lack canonical assignment readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_user_role_assignment_id: '00000000-0000-4000-8000-000000000123',
          correlation_id: '00000000-0000-4000-8000-000000000124',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.rbac_grant_role_v1({
      role_id: 'ops_reviewer',
      target_user_id: '00000000-0000-4000-8000-000000000114',
    })).rejects.toThrow(
      'rbac_grant_role_v1 backend readback missing rbac_user_role_assignments:00000000-0000-4000-8000-000000000123',
    );
  });

  it('fails closed when RBAC role update readback does not contain the requested fields', async () => {
    const roleId = '00000000-0000-4000-8000-000000000161';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_role_id: roleId,
          action: 'updated',
          correlation_id: '00000000-0000-4000-8000-000000000162',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: roleId,
          name: 'Old role name',
          description: 'Old role description',
          is_active: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: roleId,
          is_active: true,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.rbac_update_role_v1({
      role_id: roleId,
      name: 'New role name',
      description: 'New role description',
    })).rejects.toThrow('rbac_update_role_v1 backend readback mismatch for rbac_roles.name');
  });

  it('fails closed when RBAC delete readback still shows an active role', async () => {
    const roleId = '00000000-0000-4000-8000-000000000163';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_role_id: roleId,
          action: 'deleted',
          assignments_revoked: 0,
          correlation_id: '00000000-0000-4000-8000-000000000164',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: roleId,
          is_active: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: roleId,
          is_active: true,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.rbac_delete_role_v1({ role_id: roleId })).rejects.toThrow(
      `rbac_delete_role_v1 backend readback role ${roleId} is still active`,
    );
  });

  it('fails closed when RBAC grant readback is already revoked', async () => {
    const assignmentId = '00000000-0000-4000-8000-000000000165';
    const roleId = '00000000-0000-4000-8000-000000000166';
    const userId = '00000000-0000-4000-8000-000000000167';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_user_role_assignment_id: assignmentId,
          action: 'granted',
          correlation_id: '00000000-0000-4000-8000-000000000168',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: assignmentId,
          user_id: userId,
          role_id: roleId,
          revoked_at: '2026-05-12T00:00:00.000Z',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.rbac_grant_role_v1({
      user_id: userId,
      role_id: roleId,
    })).rejects.toThrow('rbac_grant_role_v1 backend readback missing active rbac assignment');
  });

  it('fails closed when RBAC revoke readback is still active', async () => {
    const assignmentId = '00000000-0000-4000-8000-000000000169';
    const roleId = '00000000-0000-4000-8000-000000000170';
    const userId = '00000000-0000-4000-8000-000000000171';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          rbac_user_role_assignment_id: assignmentId,
          action: 'revoked',
          correlation_id: '00000000-0000-4000-8000-000000000172',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: assignmentId,
          user_id: userId,
          role_id: roleId,
          revoked_at: null,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.rbac_revoke_role_v1({
      assignment_id: assignmentId,
      user_id: userId,
      role_id: roleId,
    })).rejects.toThrow(`rbac_revoke_role_v1 backend readback assignment ${assignmentId} is still active`);
  });

  it('fails closed when promoted live mutation adapters return only generic success evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { ok: true, correlation_id: 'corr_rbac' }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, correlation_id: 'corr_branch' }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, correlation_id: 'corr_oos' }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, correlation_id: 'corr_client' }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, correlation_id: 'corr_catalog' }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, correlation_id: 'corr_lookup' }, error: null });

    const ds = await import('../data-source');
    await expect(ds.rbac_create_role_v1({ role_id: 'weak_role' })).rejects.toThrow(
      'rbac_create_role_v1 did not return rbac_role_id',
    );
    await expect(ds.branch_create_v1({ name: 'Weak branch' })).rejects.toThrow(
      'branch_create_v1 did not return branch_id',
    );
    await expect(ds.branch_mark_oos_v1({ branch_ids: ['weak_branch'] })).rejects.toThrow(
      'mark_branch_oos_v1 did not return backend branch selection evidence',
    );
    await expect(ds.client_create_v1({ name: 'Weak Client', slug: 'weak-client' })).rejects.toThrow(
      'client_create_v1 did not return client_id',
    );
    await expect(ds.service_offering_create_v1({ service_level_id: 'weak_service_level' })).rejects.toThrow(
      'service_offering_create_v1 did not return service_offering_id',
    );
    await expect(ds.lookup_value_create_v1({ value: 'weak', label: 'Weak' })).rejects.toThrow(
      'lookup_value_create_v1 did not return lookup_value_id',
    );
  });

  it('routes marketplace participant review through the service-backed edge function', async () => {
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback');
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        decision: 'approved',
        result: {
          marketplace_participant_request_id: '00000000-0000-4000-8000-000000000092',
          status: 'approved',
        },
        decision_log_id: '00000000-0000-4000-8000-000000000094',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: { rows: [{
        id: '00000000-0000-4000-8000-000000000092',
        requested_participant_type_key: 'freelancer_driver',
        status: 'approved',
        review_decision: 'approved',
        reviewed_at: '2026-05-20T10:00:00.000Z',
      }] },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000092',
        requested_participant_type_key: 'freelancer_driver',
        status: 'approved',
        review_decision: 'approved',
        reviewed_at: '2026-05-20T10:00:00.000Z',
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.marketplace_participant_request_review_apply_v1({
      participant_request_id: '00000000-0000-4000-8000-000000000092',
      decision: 'approve',
      metadata: { reason: 'documents verified' },
    });

    expect(mocks.invoke).toHaveBeenCalledWith('marketplace-participant-review', {
      body: {
        request_id: '00000000-0000-4000-8000-000000000092',
        decision: 'approve',
        reason: 'documents verified',
        invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
        metadata: { reason: 'documents verified' },
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_list_resource_v1', {
      p_resource: 'marketplace_participant_requests',
      p_filters: { id: '00000000-0000-4000-8000-000000000092' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'driver_application_directory',
      p_id: '00000000-0000-4000-8000-000000000092',
    });
    expect(result).toMatchObject({
      ok: true,
      decision: 'approved',
      status: 'approved',
      participant_request_readback: {
        id: '00000000-0000-4000-8000-000000000092',
        status: 'approved',
        review_decision: 'approved',
      },
    });
  });

  it('recovers marketplace participant review when the edge response errors after backend mutation', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'marketplace-participant-review was rejected by the backend' },
    });
    mocks.rpc.mockResolvedValueOnce({
      data: { rows: [{
        id: '00000000-0000-4000-8000-000000000592',
        requested_participant_type_key: 'freelancer_driver',
        status: 'rejected',
        review_decision: 'rejected',
        reviewed_at: '2026-05-20T10:00:00.000Z',
        review_reason: 'duplicate_identity',
      }] },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: '00000000-0000-4000-8000-000000000592',
        requested_participant_type_key: 'freelancer_driver',
        status: 'rejected',
        review_decision: 'rejected',
        reviewed_at: '2026-05-20T10:00:00.000Z',
        review_reason: 'duplicate_identity',
        is_pending: false,
        is_rejected: true,
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.marketplace_participant_request_review_apply_v1({
      participant_request_id: '00000000-0000-4000-8000-000000000592',
      decision: 'reject',
      metadata: { reason: 'duplicate_identity', participant_type: 'freelancer_driver' },
    });

    expect(mocks.invoke).toHaveBeenCalledWith('marketplace-participant-review', {
      body: {
        request_id: '00000000-0000-4000-8000-000000000592',
        decision: 'reject',
        reason: 'duplicate_identity',
        metadata: { reason: 'duplicate_identity', participant_type: 'freelancer_driver' },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      recovered_from_function_error: true,
      function_error_message: 'marketplace-participant-review was rejected by the backend',
      decision: 'rejected',
      participant_request_readback: {
        id: '00000000-0000-4000-8000-000000000592',
        status: 'rejected',
        review_decision: 'rejected',
        review_reason: 'duplicate_identity',
      },
      driver_application_readback: {
        id: '00000000-0000-4000-8000-000000000592',
        status: 'rejected',
        review_decision: 'rejected',
        review_reason: 'duplicate_identity',
        is_rejected: true,
      },
    });
  });

  it('keeps non-driver marketplace participant review on the shared request readback', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        decision: 'approved',
        result: {
          marketplace_participant_request_id: '00000000-0000-4000-8000-000000000192',
          status: 'approved',
        },
        decision_log_id: '00000000-0000-4000-8000-000000000194',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: { rows: [{
        id: '00000000-0000-4000-8000-000000000192',
        requested_participant_type_key: 'partner_carrier',
        status: 'approved',
        review_decision: 'approved',
        reviewed_at: '2026-05-20T10:00:00.000Z',
      }] },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.marketplace_participant_request_review_apply_v1({
      participant_request_id: '00000000-0000-4000-8000-000000000192',
      decision: 'approve',
      metadata: { participant_type: 'partner_carrier' },
    });

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'marketplace_participant_requests',
      p_filters: { id: '00000000-0000-4000-8000-000000000192' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(result).toMatchObject({
      ok: true,
      decision: 'approved',
      status: 'approved',
      participant_request_readback: {
        id: '00000000-0000-4000-8000-000000000192',
        status: 'approved',
        review_decision: 'approved',
      },
    });
  });

  it('derives marketplace participant review decision from backend readback when function envelope omits status', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          marketplace_participant_request_id: '00000000-0000-4000-8000-000000000492',
          reviewed_at: '2026-05-20T10:00:00.000Z',
        },
        decision_log_id: '00000000-0000-4000-8000-000000000494',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: { rows: [{
        id: '00000000-0000-4000-8000-000000000492',
        requested_participant_type_key: 'partner_carrier',
        status: 'rejected',
        review_decision: 'rejected',
        reviewed_at: '2026-05-20T10:00:00.000Z',
        review_reason: 'BrowserNetworkRejectProof',
      }] },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.marketplace_participant_request_review_apply_v1({
      participant_request_id: '00000000-0000-4000-8000-000000000492',
      decision: 'reject',
      metadata: { reason: 'BrowserNetworkRejectProof' },
    });

    expect(result).toMatchObject({
      ok: true,
      decision: 'rejected',
      participant_request_readback: {
        id: '00000000-0000-4000-8000-000000000492',
        status: 'rejected',
        review_decision: 'rejected',
        review_reason: 'BrowserNetworkRejectProof',
      },
    });
  });

  it('fails closed when marketplace participant review omits backend evidence', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        decision: 'approved',
        result: { status: 'approved' },
      },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.marketplace_participant_request_review_apply_v1({
      participant_request_id: '00000000-0000-4000-8000-000000000092',
      decision: 'approve',
    })).rejects.toThrow('marketplace-participant-review did not return backend execution evidence');
  });

  it('fails closed when marketplace participant review lacks driver application directory readback', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        decision: 'approved',
        result: {
          marketplace_participant_request_id: '00000000-0000-4000-8000-000000000092',
          status: 'approved',
        },
        decision_log_id: '00000000-0000-4000-8000-000000000094',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: { rows: [{
        id: '00000000-0000-4000-8000-000000000092',
        requested_participant_type_key: 'freelancer_driver',
        status: 'approved',
        review_decision: 'approved',
        reviewed_at: '2026-05-20T10:00:00.000Z',
      }] },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.marketplace_participant_request_review_apply_v1({
      participant_request_id: '00000000-0000-4000-8000-000000000092',
      decision: 'approve',
    })).rejects.toThrow(
      'marketplace-participant-review backend readback missing driver_application_directory:00000000-0000-4000-8000-000000000092',
    );
  });

  it('fails closed when marketplace participant review readback is stale', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        decision: 'approved',
        result: {
          marketplace_participant_request_id: '00000000-0000-4000-8000-000000000092',
          status: 'approved',
        },
        decision_log_id: '00000000-0000-4000-8000-000000000094',
      },
      error: null,
    });
    mocks.rpc.mockResolvedValue({
      data: { rows: [{
        id: '00000000-0000-4000-8000-000000000092',
        requested_participant_type_key: 'partner_carrier',
        status: 'pending',
        review_decision: null,
        reviewed_at: null,
      }] },
      error: null,
    });

    const ds = await import('../data-source');
    await expect(ds.marketplace_participant_request_review_apply_v1({
      participant_request_id: '00000000-0000-4000-8000-000000000092',
      decision: 'approve',
    })).rejects.toThrow(
      'marketplace-participant-review backend readback marketplace_participant_requests:00000000-0000-4000-8000-000000000092 is not approved',
    );
  });

  it('retries marketplace participant request-docs readback until backend metadata is visible', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        decision: 'request_additional_docs',
        result: {
          id: '00000000-0000-4000-8000-000000000292',
          status: 'pending',
        },
        decision_log_id: '00000000-0000-4000-8000-000000000294',
      },
      error: null,
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: { rows: [{
          id: '00000000-0000-4000-8000-000000000292',
          requested_participant_type_key: 'freelancer_driver',
          status: 'pending',
          review_decision: null,
          reviewed_at: null,
          decision_metadata: {},
        }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{
          id: '00000000-0000-4000-8000-000000000292',
          requested_participant_type_key: 'freelancer_driver',
          status: 'pending',
          review_decision: null,
          reviewed_at: null,
          decision_metadata: {
            request_additional_docs: true,
            requested_documents: ['medical'],
          },
        }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000292',
          requested_participant_type_key: 'freelancer_driver',
          status: 'pending',
          review_decision: null,
          reviewed_at: null,
          decision_metadata: {
            request_additional_docs: true,
            requested_documents: ['medical'],
          },
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.marketplace_participant_request_review_apply_v1({
      participant_request_id: '00000000-0000-4000-8000-000000000292',
      decision: 'request_additional_docs',
      requested_documents: ['medical'],
      note: 'Need medical certificate',
      metadata: { participant_type: 'freelancer_driver', request_additional_docs: true },
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_list_resource_v1', {
      p_resource: 'marketplace_participant_requests',
      p_filters: { id: '00000000-0000-4000-8000-000000000292' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_list_resource_v1', {
      p_resource: 'marketplace_participant_requests',
      p_filters: { id: '00000000-0000-4000-8000-000000000292' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'driver_application_directory',
      p_id: '00000000-0000-4000-8000-000000000292',
    });
    expect(result).toMatchObject({
      ok: true,
      marketplace_participant_request_id: '00000000-0000-4000-8000-000000000292',
    });
  });

  it('routes settings resolution and settings change requests through api schema RPCs', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [{
          settings_id: '00000000-0000-4000-8000-000000000061',
          settings_version_id: '00000000-0000-4000-8000-000000000062',
          scope_type: 'tenant',
          scope_id: '00000000-0000-4000-8000-000000000063',
          value: { enabled: true },
          version: 3,
          scope_path: [
            { scope_type: 'tenant', scope_id: '00000000-0000-4000-8000-000000000063' },
            { scope_type: 'global', scope_id: null },
          ],
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: { settings_change_request_id: '00000000-0000-4000-8000-000000000064' },
        error: null,
      });

    const ds = await import('../data-source');
    const resolved = await ds.resolveSettings('delivery_slot_policy', {
      tenant: { id: '00000000-0000-4000-8000-000000000063' },
    });
    const requested = await ds.proposeSettingsChange(
      'delivery_slot_policy',
      { tenant: { id: '00000000-0000-4000-8000-000000000063' } },
      { max_days: 5 },
      { justification: 'tenant launch policy' },
    );

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'resolve_settings_row_from_policy_context_v1', {
      p_category: 'delivery_slot_policy',
      p_context: expect.objectContaining({
        organization_id: '00000000-0000-4000-8000-000000000063',
      }),
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'request_settings_change_v1', {
      p_category: 'delivery_slot_policy',
      p_scope_type: 'tenant',
      p_scope_id: '00000000-0000-4000-8000-000000000063',
      p_value: { max_days: 5 },
      p_change_reason: 'tenant launch policy',
      p_effective_from: null,
    });
    expect(resolved.value).toEqual({ enabled: true });
    expect(requested.settings_resolution_id).toBe('00000000-0000-4000-8000-000000000064');
  });

  it('routes mobile policy resolution through the category-specific api schema RPC', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{
        settings_id: '00000000-0000-4000-8000-000000000161',
        settings_version_id: '00000000-0000-4000-8000-000000000162',
        scope_type: 'tenant',
        scope_id: '00000000-0000-4000-8000-000000000163',
        value: { surfaces: ['routes', 'scan'] },
        version: 5,
        scope_path: [
          { scope_type: 'tenant', scope_id: '00000000-0000-4000-8000-000000000163' },
          { scope_type: 'global', scope_id: null },
        ],
      }],
      error: null,
    });

    const ds = await import('../data-source');
    const resolved = await ds.resolveMobilePolicy('mobile_visibility_policy', {
      tenant: { id: '00000000-0000-4000-8000-000000000163' },
    });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('resolve_mobile_visibility_policy', {
      p_context: expect.objectContaining({
        organization_id: '00000000-0000-4000-8000-000000000163',
      }),
    });
    expect(resolved).toMatchObject({
      category: 'mobile_visibility_policy',
      resolver: 'resolve_mobile_visibility_policy',
      value: { surfaces: ['routes', 'scan'] },
      resolved_from: 'tenant',
      settings_resolution_id: '00000000-0000-4000-8000-000000000162',
      ladder_path: [
        expect.objectContaining({
          scope_type: 'tenant',
          has_value: true,
          value: { surfaces: ['routes', 'scan'] },
        }),
        expect.objectContaining({
          scope_type: 'global',
          has_value: false,
        }),
      ],
    });
  });

  it('routes tasks through registry reads and the canonical transition wrapper', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000071',
            status: 'open',
            task_type_key: 'dispatch_exception_review',
            resource_type: 'shipment',
            resource_id: '00000000-0000-4000-8000-000000000072',
            queue_key: 'ndr_review',
            metadata: {
              subject: 'Delivery exception review',
              allowed_ndr_actions: ['hold_at_branch', 'return_to_sender'],
              evidence_required: false,
            },
          }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ task_id: '00000000-0000-4000-8000-000000000071' }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{ id: '00000000-0000-4000-8000-000000000091', task_id: '00000000-0000-4000-8000-000000000071' }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000071',
          status: 'completed',
          task_type_key: 'dispatch_exception_review',
          queue_key: 'ndr_review',
          metadata: { subject: 'Delivery exception review' },
        },
        error: null,
      });

    const ds = await import('../data-source');
    const tasks = await ds.listTasks({ task_type: 'dispatch_exception_review' });
    await ds.transition_task_v1('00000000-0000-4000-8000-000000000071', {
      next_status: 'completed',
      payload: { resolution: 'approved' },
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_list_resource_v1', {
      p_resource: 'tasks',
      p_filters: { task_type_key: 'dispatch_exception_review' },
      p_limit: 100,
      p_offset: 0,
      p_sort: { key: 'created_at', direction: 'desc' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'transition_task_v1', {
      p_task_id: '00000000-0000-4000-8000-000000000071',
      p_to_status: 'completed',
      p_status_reason: null,
      p_payload: { resolution: 'approved' },
      p_idempotency_key: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_list_resource_v1', {
      p_resource: 'task_events',
      p_filters: { task_id: '00000000-0000-4000-8000-000000000071' },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_get_resource_v1', {
      p_resource: 'tasks',
      p_id: '00000000-0000-4000-8000-000000000071',
    });
    expect(tasks).toEqual([expect.objectContaining({
      id: '00000000-0000-4000-8000-000000000071',
      status: 'open',
      task_id: 'TSK-00000000',
      task_type: 'dispatch_exception_review',
      task_type_key: 'dispatch_exception_review',
      queue: 'ndr_review',
      queue_key: 'ndr_review',
      subject: 'Delivery exception review',
      shipment_id: '00000000-0000-4000-8000-000000000072',
      allowed_actions: ['hold_at_branch', 'return_to_sender'],
      evidence_required: false,
    })]);
  });

  it('waits for route-stop closeout shipment_action readback after live task transition', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          task_id: '00000000-0000-4000-8000-000000000081',
          task_event_id: '00000000-0000-4000-8000-000000000082',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          task_event_id: '00000000-0000-4000-8000-000000000082',
          workflow_run_id: '00000000-0000-4000-8000-000000000083',
          workflow_status: 'completed',
          shipment_action_id: '00000000-0000-4000-8000-000000000084',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000082',
          task_id: '00000000-0000-4000-8000-000000000081',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000081',
          status: 'completed',
          task_type_key: 'route_stop_execute',
          resource_type: 'route_stop',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.transition_task_v1('00000000-0000-4000-8000-000000000081', {
      next_status: 'completed',
      payload: {
        delivery_completion: {
          completion_kind: 'full',
        },
      },
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'transition_task_v1', {
      p_task_id: '00000000-0000-4000-8000-000000000081',
      p_to_status: 'completed',
      p_status_reason: null,
      p_payload: { delivery_completion: { completion_kind: 'full' } },
      p_idempotency_key: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_finalize_route_stop_closeout_event_v1', {
      p_task_event_id: '00000000-0000-4000-8000-000000000082',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_get_resource_v1', {
      p_resource: 'task_events',
      p_id: '00000000-0000-4000-8000-000000000082',
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_get_resource_v1', {
      p_resource: 'tasks',
      p_id: '00000000-0000-4000-8000-000000000081',
    });
  });

  it('fails closed when task transition returns weak backend evidence or no task readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({
        data: [{ task_id: '00000000-0000-4000-8000-000000000072' }],
        error: null,
      })
      .mockResolvedValueOnce({ data: { rows: [{ id: '00000000-0000-4000-8000-000000000092' }] }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.transition_task_v1('00000000-0000-4000-8000-000000000072', {
      next_status: 'completed',
      payload: { resolution: 'approved' },
    })).rejects.toThrow('transition_task_v1 returned no backend outcome');
    await expect(ds.transition_task_v1('00000000-0000-4000-8000-000000000072', {
      next_status: 'completed',
      payload: { resolution: 'approved' },
    })).rejects.toThrow('transition_task_v1 backend readback missing tasks');
  });

  it('fails closed when completed task transition readback is still open', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [{ task_id: '00000000-0000-4000-8000-000000000085', task_event_id: '00000000-0000-4000-8000-000000000086' }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000086', task_id: '00000000-0000-4000-8000-000000000085' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000085',
          status: 'open',
          task_type_key: 'dispatch_exception_review',
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.transition_task_v1('00000000-0000-4000-8000-000000000085', {
      next_status: 'completed',
      payload: { resolution: 'approved' },
    })).rejects.toThrow('transition_task_v1 backend readback status mismatch: expected completed, got open');
  });

  it('requires task and task-event readback after assigning a live task', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          task_id: '00000000-0000-4000-8000-000000000073',
          task_event_id: '00000000-0000-4000-8000-000000000074',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000073',
          assigned_to: '00000000-0000-4000-8000-000000000075',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000074',
          task_id: '00000000-0000-4000-8000-000000000073',
          event: 'assigned',
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.assign_task_v1({
      task_id: '00000000-0000-4000-8000-000000000073',
      assigned_to: '00000000-0000-4000-8000-000000000075',
      notes: 'Claimed from review queue',
    });

    expect(mocks.rpc).toHaveBeenCalledWith('assign_task_v1', {
      p_task_id: '00000000-0000-4000-8000-000000000073',
      p_assigned_to: '00000000-0000-4000-8000-000000000075',
      p_idempotency_key: null,
      p_notes: 'Claimed from review queue',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'tasks',
      p_id: '00000000-0000-4000-8000-000000000073',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'task_events',
      p_id: '00000000-0000-4000-8000-000000000074',
    });
    expect(result).toEqual({
      task_id: '00000000-0000-4000-8000-000000000073',
      task_event_id: '00000000-0000-4000-8000-000000000074',
      task: {
        id: '00000000-0000-4000-8000-000000000073',
        assigned_to: '00000000-0000-4000-8000-000000000075',
        task_id: 'TSK-00000000',
      },
    });
  });

  it('fails closed when live task assignment lacks task-event readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          task_id: '00000000-0000-4000-8000-000000000073',
          task_event_id: '00000000-0000-4000-8000-000000000074',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: '00000000-0000-4000-8000-000000000073' },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.assign_task_v1({
      task_id: '00000000-0000-4000-8000-000000000073',
      assigned_to: '00000000-0000-4000-8000-000000000075',
    })).rejects.toThrow('assign_task_v1 backend readback missing task_events:00000000-0000-4000-8000-000000000074');
  });

  it('requires task and task-event readbacks after bulk task transitions', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          total: 2,
          succeeded: 2,
          failed: 0,
          outcomes: [
            {
              task_id: '00000000-0000-4000-8000-000000000076',
              ok: true,
              task_event_id: '00000000-0000-4000-8000-000000000078',
            },
            {
              task_id: '00000000-0000-4000-8000-000000000077',
              ok: true,
              task_event_id: '00000000-0000-4000-8000-000000000079',
            },
          ],
          correlation_id: '00000000-0000-4000-8000-000000000080',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: '00000000-0000-4000-8000-000000000076', status: 'completed' }, error: null })
      .mockResolvedValueOnce({ data: { id: '00000000-0000-4000-8000-000000000077', status: 'completed' }, error: null })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000078',
          task_id: '00000000-0000-4000-8000-000000000076',
          payload: { snooze_until: '2026-05-24T22:00:00.000Z' },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000079',
          task_id: '00000000-0000-4000-8000-000000000077',
          payload: { snooze_until: '2026-05-24T22:00:00.000Z' },
        },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.bulk_transition_tasks_v1({
      task_ids: [
        '00000000-0000-4000-8000-000000000076',
        '00000000-0000-4000-8000-000000000077',
      ],
      to_status: 'snoozed',
      reason: 'Batch snooze',
      payload: { snooze_until: '2026-05-24T22:00:00.000Z' },
    });

    expect(mocks.rpc).toHaveBeenCalledWith('bulk_transition_tasks_v1', {
      p_args: {
        task_ids: [
          '00000000-0000-4000-8000-000000000076',
          '00000000-0000-4000-8000-000000000077',
        ],
        to_status: 'snoozed',
        reason: 'Batch snooze',
        payload: { snooze_until: '2026-05-24T22:00:00.000Z' },
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'tasks',
      p_id: '00000000-0000-4000-8000-000000000076',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'task_events',
      p_id: '00000000-0000-4000-8000-000000000079',
    });
  });

  it('routes public tracking review through the api schema p_input envelope', async () => {
    const payload = {
      support_case_id: '00000000-0000-4000-8000-000000000901',
      decision: 'approved',
      reason: 'Backend confirmed from Console',
    };
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        support_case_id: payload.support_case_id,
        outcome: 'applied',
      },
      error: null,
    });

    const ds = await import('../data-source');
    const result = await ds.public_tracking_review_request_v1(payload);

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('public_tracking_review_request_v1', {
      p_input: payload,
    });
    expect(result).toMatchObject({
      ok: true,
      support_case_id: payload.support_case_id,
      outcome: 'applied',
    });
  });

  it('fails closed when bulk task transition drops caller payload from task event readback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          total: 1,
          succeeded: 1,
          failed: 0,
          outcomes: [{
            task_id: '00000000-0000-4000-8000-000000000076',
            ok: true,
            task_event_id: '00000000-0000-4000-8000-000000000078',
          }],
          correlation_id: '00000000-0000-4000-8000-000000000080',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: '00000000-0000-4000-8000-000000000076', status: 'snoozed' }, error: null })
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000078',
          task_id: '00000000-0000-4000-8000-000000000076',
          payload: { bulk_correlation_id: '00000000-0000-4000-8000-000000000080' },
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.bulk_transition_tasks_v1({
      task_ids: ['00000000-0000-4000-8000-000000000076'],
      to_status: 'snoozed',
      payload: { snooze_until: '2026-05-24T22:00:00.000Z' },
    })).rejects.toThrow('bulk_transition_tasks_v1 backend task_event payload mismatch for 00000000-0000-4000-8000-000000000076:snooze_until');
  });

  it('fails closed when bulk task transition lacks task readback evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          total: 1,
          succeeded: 1,
          failed: 0,
          outcomes: [{
            task_id: '00000000-0000-4000-8000-000000000076',
            ok: true,
            task_event_id: '00000000-0000-4000-8000-000000000078',
          }],
          correlation_id: '00000000-0000-4000-8000-000000000080',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const ds = await import('../data-source');
    await expect(ds.bulk_transition_tasks_v1({
      task_ids: ['00000000-0000-4000-8000-000000000076'],
      to_status: 'completed',
    })).rejects.toThrow('bulk_transition_tasks_v1 backend readback missing tasks:00000000-0000-4000-8000-000000000076');
  });

  it('routes COD summary and planning governance reads through api schema RPCs', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          expected_amount: 1000,
          collected_amount: 950,
          remitted_amount: 900,
          variance_amount: -50,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ issue_number: 3037, title: 'Onboarding closure', status: 'Ready' }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const cod = await ds.compute_cod_payment_collection_summary_v1({
      tenant: '00000000-0000-4000-8000-000000000081',
      branch_id: '00000000-0000-4000-8000-000000000082',
    });
    const cards = await ds.listExecutionCards();

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'compute_cod_payment_collection_summary_v1', {
      p_organization_id: '00000000-0000-4000-8000-000000000081',
      p_branch_id: '00000000-0000-4000-8000-000000000082',
      p_subject_type: null,
      p_subject_id: null,
      p_window_start_at: null,
      p_window_end_at: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_list_resource_v1', {
      p_resource: 'planning_os_execution_cards',
      p_filters: {},
      p_limit: 50,
      p_offset: 0,
      p_sort: null,
    });
    expect(cod).toMatchObject({ expected: 1000, collected: 950, remitted: 900, variance: -50 });
    expect(cards).toEqual([{ issue_number: 3037, title: 'Onboarding closure', status: 'Ready' }]);
  });

  it('hydrates lookup helpers from api-schema lookup_values rows in live mode', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{
        value: 'ready',
        label: 'Ready',
        sort_order: 10,
        is_default: true,
        metadata: { tone: 'good' },
      }],
      error: null,
    });

    const ds = await import('../data-source');
    ds.getLookups('console_live_only_status');

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('list_lookup_values_v1', {
      p_category: 'console_live_only_status',
    });
    await vi.waitFor(() => {
      expect(ds.getLookups('console_live_only_status')).toEqual([{
        value: 'ready',
        label: 'Ready',
        rank: 10,
        tone: 'good',
        is_default: true,
        metadata: { tone: 'good' },
      }]);
    });
  });

  it('hydrates settings categories from the live settings registry resource', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        rows: [{
          category: 'console_live_only_policy',
          allowed_scopes: ['global', 'tenant'],
          side_effecting: true,
          metadata: { domain: 'Operations', schema_id: 'dispatch_policy.v1' },
        }],
        total: 1,
      },
      error: null,
    });

    const ds = await import('../data-source');
    ds.getSettingsCategories();

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'settings_category_registry',
      p_filters: {},
      p_limit: 500,
      p_offset: 0,
      p_sort: { key: 'category', direction: 'asc' },
    });
    await vi.waitFor(() => {
      expect(ds.getSettingsCategories()).toEqual([expect.objectContaining({
        category: 'console_live_only_policy',
        domain: 'Operations',
        scopes: ['global', 'tenant'],
        approval_required: true,
        schema_id: 'dispatch_policy.v1',
      })]);
    });
  });

  it('preloads live boot metadata before sync shell helpers render', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          app: 'console',
          groups: [{
            id: 'operate',
            label: 'Operate',
            items: [{ key: 'shipments', label: 'Shipments', icon: 'truck', route: '/operate/shipments' }],
          }, {
            id: 'integrations',
            label: 'Integrations',
            items: [{
              key: 'int-intake',
              label: 'Inbound intake monitor',
              icon: 'download',
              path: '/integrations/intake',
              resource: 'webhook_inbox_directory',
            }, {
              key: 'int-catalog',
              label: 'Integrations catalog',
              icon: 'plug',
              path: '/integrations/catalog',
              resource: 'integration_plugin_directory',
              capability: 'integration_plugins.read',
            }, {
              key: 'int-plugin-studio',
              label: 'Plugin studio',
              icon: 'plug',
              path: '/integrations/plugin-studio',
              resource: 'integration_plugin_directory',
              capability: 'integration_plugins.write',
            }],
          }],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          resources: {
            shipments: { key: 'shipments', columns: [{ key: 'tracking_number', label: 'Tracking' }] },
            webhook_inbox_directory: { key: 'webhook_inbox_directory', capability_read: 'webhooks.read' },
            integration_plugin_directory: {
              key: 'integration_plugin_directory',
              capability_read: 'integrations.read',
            },
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          commands: [{ key: 'shipments.resort', label: 'Resort', section: 'Operate' }],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            category: 'tenant_currency',
            domain: 'Finance',
            allowed_scopes: ['tenant'],
            schema_id: 'tenant_currency.v1',
          }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          shipment_status: [{
            category: 'shipment_status',
            value: 'created',
            label: 'Created',
            sort_order: 1,
            metadata: { tone: 'info' },
          }],
          tenant_signup_request_status: [{
            category: 'tenant_signup_request_status',
            value: 'pending',
            label: 'Pending',
            sort_order: 10,
            is_default: true,
            metadata: { tone: 'warn', lifecycle: 'pending', is_terminal: false },
          }],
          task_action_kind: [{
            category: 'task_action_kind',
            value: 'resolve',
            label: 'Resolve',
            sort_order: 20,
            next_status: 'completed',
            metadata: { tone: 'good' },
          }],
        },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.hydrateConsoleLiveMetadata();

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_navigation_v1', { p_app: 'console' });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_read_registry_v1', undefined);
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_command_registry_v1', undefined);
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_list_resource_v1', {
      p_resource: 'settings_category_registry',
      p_filters: {},
      p_limit: 500,
      p_offset: 0,
      p_sort: { key: 'category', direction: 'asc' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'list_lookup_values_catalog_json_v1', {
      p_include_inactive: false,
    });
    expect(ds.getNavigation()).toEqual(expect.objectContaining({
      app: 'console',
      groups: expect.arrayContaining([expect.objectContaining({ id: 'operate' })]),
    }));
    expect(ds.getNavigation()).toEqual(expect.objectContaining({
      groups: expect.arrayContaining([
        expect.objectContaining({
          id: 'integrations',
          items: expect.arrayContaining([
            expect.objectContaining({
              key: 'int-intake',
              route: '/integrations/intake',
              capability: 'webhooks.read',
              capabilities: ['webhooks.read'],
            }),
            expect.objectContaining({
              key: 'int-catalog',
              route: '/integrations/catalog',
              capability: 'integration_plugins.read',
            }),
            expect.objectContaining({
              key: 'int-plugin-studio',
              route: '/integrations/plugin-studio',
              capability: 'integration_plugins.write',
            }),
          ]),
        }),
      ]),
    }));
    expect(ds.getReadRegistry()).toEqual(expect.objectContaining({
      shipments: expect.objectContaining({ key: 'shipments' }),
      webhook_inbox_directory: expect.objectContaining({ capability_read: 'webhooks.read' }),
      integration_plugin_directory: expect.objectContaining({ capability_read: 'integrations.read' }),
    }));
    expect(ds.getCommandRegistry()).toEqual([
      expect.objectContaining({ key: 'shipments.resort' }),
    ]);
    expect(ds.getSettingsCategories()).toEqual([
      expect.objectContaining({ category: 'tenant_currency', domain: 'Finance' }),
    ]);
    expect(ds.getLookups('shipment_status')).toEqual([
      expect.objectContaining({ value: 'created', tone: 'info' }),
    ]);
    expect(ds.lookupRow('shipment_status', 'created')).toEqual(
      expect.objectContaining({ value: 'created', tone: 'info' }),
    );
    expect(ds.lookupRow('tenant_signup_request_status', 'pending')).toEqual(
      expect.objectContaining({
        value: 'pending',
        tone: 'warn',
        metadata: expect.objectContaining({ lifecycle: 'pending' }),
      }),
    );
    expect(ds.lookupRow('task_action_kind', 'resolve')).toEqual(
      expect.objectContaining({
        value: 'resolve',
        metadata: expect.objectContaining({ next_status: 'completed' }),
      }),
    );
  });

  it('retries Console read registry hydration once when the live RPC hits a statement timeout', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: { app: 'console', groups: [{ id: 'operate', label: 'Operate', items: [] }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'canceling statement due to statement timeout' },
      })
      .mockResolvedValueOnce({
        data: { commands: [] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{ category: 'tenant_currency', domain: 'Finance' }], total: 1 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          shipment_status: [{
            category: 'shipment_status',
            value: 'created',
            label: 'Created',
          }],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { resources: [{ key: 'shipments', columns: [] }] },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.hydrateConsoleLiveMetadata();

    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_read_registry_v1', undefined);
    expect(mocks.rpc).toHaveBeenNthCalledWith(6, 'ui_read_registry_v1', undefined);
    expect(ds.getReadRegistry()).toEqual(expect.objectContaining({
      shipments: expect.objectContaining({ key: 'shipments' }),
    }));
  });

  it('fails live boot metadata when lookup catalog preload is not authorized', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: { app: 'console', groups: [{ id: 'operate', label: 'Operate', items: [] }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { resources: [{ key: 'shipments', columns: [] }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { commands: [] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{ category: 'tenant_currency', domain: 'Finance' }], total: 1 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'list_lookup_values_catalog_json_v1 requires lookup_values read or console_metadata.read capability' },
      });

    const ds = await import('../data-source');
    await expect(ds.hydrateConsoleLiveMetadata()).rejects.toThrow(
      /list_lookup_values_catalog_json_v1 requires lookup_values read or console_metadata\.read capability/,
    );

    expect(mocks.rpc).toHaveBeenCalledWith('list_lookup_values_catalog_json_v1', {
      p_include_inactive: false,
    });
    expect(ds.getLookups('shipment_status')).toEqual([]);
    expect(ds.lookupRow('shipment_status', 'created')).toBeNull();
  });

  it('hydrates live boot lookups through ui_list_resource_v1 when catalog RPCs are missing', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: { app: 'console', groups: [{ id: 'operate', label: 'Operate', items: [] }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { resources: [{ key: 'shipments', columns: [] }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { commands: [] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [{ category: 'tenant_currency', domain: 'Finance' }], total: 1 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'Could not find the function api.list_lookup_values_catalog_json_v1(p_include_inactive) in the schema cache' },
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'Could not find the function api.list_lookup_values_catalog_v1(p_include_inactive) in the schema cache' },
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            category: 'shipment_status',
            value: 'created',
            label: 'Created',
            sort_order: 1,
            metadata: { tone: 'info' },
          }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await ds.hydrateConsoleLiveMetadata();

    expect(mocks.rpc).toHaveBeenNthCalledWith(5, 'list_lookup_values_catalog_json_v1', {
      p_include_inactive: false,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(6, 'list_lookup_values_catalog_v1', {
      p_include_inactive: false,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(7, 'ui_list_resource_v1', {
      p_resource: 'lookup_values',
      p_filters: { status: 'active' },
      p_limit: 5000,
      p_offset: 0,
      p_sort: { key: 'category', direction: 'asc' },
    });
    expect(ds.getLookups('shipment_status')).toEqual([
      expect.objectContaining({ value: 'created', tone: 'info' }),
    ]);
    expect(ds.lookupRow('shipment_status', 'created')).toEqual(
      expect.objectContaining({ value: 'created', tone: 'info' }),
    );
  });

  it('hydrates workflow template key resolution through api-schema resource reads', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        rows: [{
          id: '00000000-0000-4000-8000-000000000101',
          template_key: 'console_live_template_v1',
          status: 'active',
        }],
        total: 1,
      },
      error: null,
    });

    const ds = await import('../data-source');
    ds.resolve_workflow_template_id_v1('console_live_template_v1');

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'workflow_templates',
      p_filters: { template_key: 'console_live_template_v1', status: 'active' },
      p_limit: 1,
      p_offset: 0,
      p_sort: null,
    });
    await vi.waitFor(() => {
      expect(ds.resolve_workflow_template_id_v1('console_live_template_v1')).toBe(
        '00000000-0000-4000-8000-000000000101',
      );
    });
  });

  it('routes dashboard KPI cards through the live KPI directory resource', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        rows: [{
          id: 'kpi_delivery_success',
          kpi_key: 'delivery_success_rate',
          label: 'Delivery success',
          value_num: 98.5,
          delta: '+1.2%',
          tone: 'good',
        }],
        total: 1,
      },
      error: null,
    });

    const ds = await import('../data-source');
    const cards = await ds.dashboardKpis();

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'kpi_rollup_directory',
      p_filters: {},
      p_limit: 12,
      p_offset: 0,
      p_sort: { key: 'rank', direction: 'asc' },
    });
    expect(cards).toEqual([{
      label: 'Delivery success',
      key: 'delivery_success_rate',
      value: 98.5,
      delta: '+1.2%',
      tone: 'good',
      spark: undefined,
    }]);
  });

  it('routes dashboard audit feed reads through canonical audit_table_changes', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        rows: [{
          id: '00000000-0000-4000-8000-000000000111',
          created_at: '2026-05-03T08:00:00Z',
          table_name: 'shipments',
          op: 'UPDATE',
          pk: { id: '00000000-0000-4000-8000-000000000112' },
          changed_by: '00000000-0000-4000-8000-000000000113',
        }],
        total: 1,
      },
      error: null,
    });

    const ds = await import('../data-source');
    const rows = await ds.listAuditLog({ limit: 8 });

    expect(mocks.schema).toHaveBeenCalledWith('api');
    expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
      p_resource: 'audit_table_changes',
      p_filters: {},
      p_limit: 8,
      p_offset: 0,
      p_sort: { key: 'created_at', direction: 'desc' },
    });
    expect(rows).toEqual([expect.objectContaining({
      occurred_at: '2026-05-03T08:00:00Z',
      table: 'shipments',
      pk: '00000000-0000-4000-8000-000000000112',
      actor: '00000000-0000-4000-8000-000000000113',
    })]);
  });

  it('routes resolution and UI event logs through live registry resources', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000121',
            category: 'shipment_promise_policy',
            resolved_at: '2026-05-03T09:00:00Z',
          }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000122',
            event_type: 'console.page_view',
            created_at: '2026-05-03T09:01:00Z',
          }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const resolutions = await ds.listResolutionLog({ category: 'shipment_promise_policy', limit: 7 });
    const uiEvents = await ds.listUiEventLog({ limit: 3 });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'ui_list_resource_v1', {
      p_resource: 'settings_resolution_log',
      p_filters: { category: 'shipment_promise_policy' },
      p_limit: 7,
      p_offset: 0,
      p_sort: { key: 'resolved_at', direction: 'desc' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_list_resource_v1', {
      p_resource: 'ui_event_log',
      p_filters: {},
      p_limit: 3,
      p_offset: 0,
      p_sort: { key: 'created_at', direction: 'desc' },
    });
    expect(resolutions).toEqual([expect.objectContaining({ category: 'shipment_promise_policy' })]);
    expect(uiEvents).toEqual([expect.objectContaining({ event_type: 'console.page_view' })]);
  });

  it('requires API Gateway block source backend readback across source projections', async () => {
    const sourceId = '00000000-0000-4000-8000-000000000141';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          source_id: sourceId,
          enabled: false,
          correlation_id: '00000000-0000-4000-8000-000000000142',
          decision_log_id: '00000000-0000-4000-8000-000000000143',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId, enabled: false },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{ id: sourceId, enabled: false }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.block_api_gateway_source_v1({
      source_id: sourceId,
      reason: 'abuse threshold exceeded',
    });

    expect(result.source_id).toBe(sourceId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'block_api_gateway_source_v1', {
      p_args: { source_id: sourceId, reason: 'abuse threshold exceeded' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'webhook_sources',
      p_id: sourceId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, 'ui_list_resource_v1', {
      p_resource: 'webhook_source_directory',
      p_filters: { id: sourceId },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
  });

  it('fails closed when API Gateway block source readback is stale', async () => {
    const sourceId = '00000000-0000-4000-8000-000000000144';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          source_id: sourceId,
          enabled: false,
          correlation_id: '00000000-0000-4000-8000-000000000145',
          decision_log_id: '00000000-0000-4000-8000-000000000146',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId, enabled: true },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.block_api_gateway_source_v1({
      source_id: sourceId,
      reason: 'abuse threshold exceeded',
    })).rejects.toThrow('block_api_gateway_source_v1 backend readback did not reflect webhook_sources.enabled');
  });

  it('requires API Gateway rate-limit backend readback across source and summary projections', async () => {
    const sourceId = '00000000-0000-4000-8000-000000000147';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          source_id: sourceId,
          rate_limit_per_hour: 1800,
          previous_limit_per_hour: 1200,
          correlation_id: '00000000-0000-4000-8000-000000000148',
          decision_log_id: '00000000-0000-4000-8000-000000000149',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId, rate_limit_per_hour: 1800 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{ id: sourceId, rate_limit_per_hour: 1800 }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000150',
            source_id: sourceId,
            limit_per_hour: 1800,
            limit_per_min: 30,
          }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    const result = await ds.adjust_api_gateway_rate_limit_v1({
      source_id: sourceId,
      limit_per_min: 30,
      reason: 'temporary partner throttle',
    });

    expect(result.source_id).toBe(sourceId);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'adjust_api_gateway_rate_limit_v1', {
      p_args: { source_id: sourceId, limit_per_min: 30, reason: 'temporary partner throttle' },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(4, 'ui_list_resource_v1', {
      p_resource: 'api_gateway_rate_limits_summary',
      p_filters: { source_id: sourceId },
      p_limit: 25,
      p_offset: 0,
      p_sort: null,
    });
  });

  it('fails closed when API Gateway rate-limit summary readback is stale', async () => {
    const sourceId = '00000000-0000-4000-8000-000000000151';
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          source_id: sourceId,
          rate_limit_per_hour: 1800,
          previous_limit_per_hour: 1200,
          correlation_id: '00000000-0000-4000-8000-000000000152',
          decision_log_id: '00000000-0000-4000-8000-000000000153',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: sourceId, rate_limit_per_hour: 1800 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{ id: sourceId, rate_limit_per_hour: 1800 }],
          total: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000154',
            source_id: sourceId,
            limit_per_hour: 1200,
            limit_per_min: 20,
          }],
          total: 1,
        },
        error: null,
      });

    const ds = await import('../data-source');
    await expect(ds.adjust_api_gateway_rate_limit_v1({
      source_id: sourceId,
      limit_per_min: 30,
      reason: 'temporary partner throttle',
    })).rejects.toThrow(
      'adjust_api_gateway_rate_limit_v1 backend readback did not reflect api_gateway_rate_limits_summary.limit_per_hour',
    );
  });

  it('primes evidence stream from live decision log reads', async () => {
    vi.useFakeTimers();
    try {
      mocks.rpc.mockResolvedValueOnce({
        data: {
          rows: [{
            id: '00000000-0000-4000-8000-000000000131',
            decision_category: 'shipment.reschedule',
            timestamp: '2026-05-03T09:02:00Z',
          }],
          total: 1,
        },
        error: null,
      });

      const ds = await import('../data-source');
      const cb = vi.fn();
      const unsubscribe = ds.streamEvidence(cb);
      await Promise.resolve();
      await Promise.resolve();

      expect(mocks.rpc).toHaveBeenCalledWith('ui_list_resource_v1', {
        p_resource: 'decision_log',
        p_filters: {},
        p_limit: 5,
        p_offset: 0,
        p_sort: { key: 'timestamp', direction: 'desc' },
      });
      await vi.waitFor(() => {
        expect(cb).toHaveBeenCalledWith(expect.objectContaining({
          decision_category: 'shipment.reschedule',
        }));
      });
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
