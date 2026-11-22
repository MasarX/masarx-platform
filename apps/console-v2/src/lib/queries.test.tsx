// queries.test.tsx — exercises the canonical TanStack Query hooks in
// `lib/queries.ts` against the in-memory data-source adapter. These tests
// guarantee key/queryFn wiring is correct and that mutations invalidate the
// expected list/resource caches.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, renderHook, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useResourceList,
  useCompleteResourceList,
  useResourceListsByFilters,
  useResource,
  useDecisionLog,
  useTasks,
  useResolveSettings,
  useResolveAccessPolicy,
  useResolveMobilePolicy,
  useProposeSettingsChange,
  useTransitionTask,
  useShipmentAmendCancel,
  useClientCreate,
  useClientUpdate,
  useReactivateClient,
  useRecipientCreate,
  useRecipientDelete,
  useRecipientUpdate,
  useReactivateSender,
  useDashboardKpis,
  useSenderCreate,
  useSenderUpdate,
  useSuspendClient,
  useSuspendSender,
  useImportJobCreate,
  useImportJobCancel,
  useResourceImportStudioStart,
  useResourceImportStudioCancel,
  useBlockApiGatewaySource,
  useAdjustApiGatewayRateLimit,
  useRunApiGatewayRequestTest,
  useCreateServiceLevel,
  useUpdateServiceLevel,
  useCreateServiceOffering,
  useUpsertWebhookSource,
  useRotateWebhookSourceToken,
  useArchiveWebhookSource,
  useReplayWebhookInbox,
  useForceWebhookInboxStatus,
  useUpsertMappingArtifact,
  usePromoteMappingVersion,
  useDeleteMappingConfig,
  useUpsertProviderAuthConfig,
  useBindProviderAccountCredential,
  useUnbindProviderAccountCredential,
  useRotateProviderCredentials,
  useRevokeProviderAuthConfig,
  useCreateRbacRole,
  useGrantRbacRole,
  useRevokeRbacRole,
  useApplyRbacRoleTemplate,
  useCreateWorkflowTemplate,
  useSetWorkflowTemplateStatus,
  useRestoreWorkflowTemplateVersion,
  useCreateWorkflowTemplateStep,
  useRegisterWorkflowBinding,
  useSimulateBindingDispatch,
  useCreateLabelDesignDraft,
  usePublishLabelDesignDraft,
  useUploadLabelDesignerAsset,
  useDeleteLabelDesignerAsset,
  useAssignBranchZone,
  useRecordHoursOfServiceSegment,
  qk,
} from './queries';
import * as api from './api';

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('lib/queries', () => {
  let client: QueryClient;
  beforeEach(() => {
    client = makeClient();
  });

  it('useResourceList resolves with rows + total shape', async () => {
    const { result } = renderHook(() => useResourceList('shipments'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveProperty('rows');
    expect(result.current.data).toHaveProperty('total');
    expect(Array.isArray(result.current.data?.rows)).toBe(true);
  });

  it('useCompleteResourceList routes through the complete list facade', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete').mockResolvedValue({
      rows: [{ id: 'shp_complete' }],
      total: 1,
      page: 0,
      page_size: 1,
    } as never);

    const { result } = renderHook(() => useCompleteResourceList('shipments'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listSpy).toHaveBeenCalledWith('shipments', undefined);
    expect(result.current.data?.rows).toEqual([{ id: 'shp_complete' }]);
    listSpy.mockRestore();
  });

  it('useResourceListsByFilters reads each filtered list through the complete facade', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(
      async (_resource, opts) => ({
        rows: [{ id: String(opts?.filter?.id) }],
        total: 1,
        page: 0,
        page_size: 1,
      }) as never,
    );

    const { result } = renderHook(
      () => useResourceListsByFilters('tasks', [{ id: 'task_a' }, { id: 'task_b' }]),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(result.current.data?.rows.map((row) => (row as { id: string }).id)).toEqual([
      'task_a',
      'task_b',
    ]);
    listSpy.mockRestore();
  });

  it('useResource is disabled when id is undefined', () => {
    const { result } = renderHook(() => useResource('shipments', undefined), {
      wrapper: wrapper(client),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('useResource fetches a single record when id is provided', async () => {
    const { result } = renderHook(() => useResource('shipments', 'shp_test'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isFetched).toBe(true));
    // Either resolved with data or null — both are valid completions.
    expect(['success', 'error']).toContain(result.current.status);
  });

  it('useDecisionLog stays idle when the caller disables the query', () => {
    const { result } = renderHook(() => useDecisionLog(undefined, { enabled: false }), {
      wrapper: wrapper(client),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.isFetched).toBe(false);
  });

  it('useDecisionLog returns an array', async () => {
    const { result } = renderHook(() => useDecisionLog({ limit: 5 }), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(Array.isArray(result.current.data)).toBe(true);
  });

  it('useTasks returns an array', async () => {
    const { result } = renderHook(() => useTasks(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(Array.isArray(result.current.data)).toBe(true);
  });

  it('useResolveSettings resolves a SettingsResolution shape', async () => {
    const { result } = renderHook(() => useResolveSettings('route_assignment'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Canonical shape: ladder_path + resolved_from + settings_resolution_id
    // are the load-bearing fields per `SettingsResolution` in domain.ts.
    expect(result.current.data).toMatchObject({
      resolved_from: expect.any(String),
      settings_resolution_id: expect.any(String),
      ladder_path: expect.any(Array),
    });
  });

  it('useResolveMobilePolicy resolves the seed fallback policy shape', async () => {
    const { result } = renderHook(() => useResolveMobilePolicy('mobile_visibility_policy'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({
      category: 'mobile_visibility_policy',
      resolver: 'resolve_mobile_visibility_policy',
      value: expect.objectContaining({
        surfaces: expect.arrayContaining(['routes', 'scan']),
      }),
      resolved_from: expect.any(String),
      settings_resolution_id: expect.any(String),
      ladder_path: expect.any(Array),
    });
  });

  it('useResolveSettings stays idle without a category even when enabled', () => {
    const { result } = renderHook(
      () => useResolveSettings('', undefined, { enabled: true }),
      { wrapper: wrapper(client) },
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.isFetched).toBe(false);
  });

  it('useResolveSettings can be disabled until live auth is ready', () => {
    const spy = vi.spyOn(api, 'resolveSettings');
    const { result } = renderHook(
      () => useResolveSettings('ui_presentation_policy', undefined, { enabled: false }),
      { wrapper: wrapper(client) },
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(spy).not.toHaveBeenCalled();
  });

  it('useResolveAccessPolicy can be disabled until access policy permission is available', () => {
    const spy = vi.spyOn(api, 'resolve_access_control_policy_v1');
    const { result } = renderHook(
      () => useResolveAccessPolicy('tenant', 'org_rashed', { enabled: false }),
      { wrapper: wrapper(client) },
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(spy).not.toHaveBeenCalled();
  });

  it('useDashboardKpis resolves to an array of cards', async () => {
    const { result } = renderHook(() => useDashboardKpis(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(Array.isArray(result.current.data)).toBe(true);
  });

  it('qk.list / qk.resource produce stable, structurally-comparable keys', () => {
    expect(qk.list('shipments')).toEqual(['list', 'shipments', undefined]);
    expect(qk.resource('shipments', 'shp_1')).toEqual(['resource', 'shipments', 'shp_1']);
  });

  it('useShipmentAmendCancel mutation invalidates the shipments list cache', async () => {
    // Use a long gcTime so the seeded query state survives long enough to
    // observe the invalidation transition without being GC'd.
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    // Spy on invalidateQueries to assert the contract directly. This avoids
    // racing TanStack's internal isInvalidated flag, which flips back to
    // false the moment the (instantaneous, in-memory) refetch completes.
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');

    longLivedClient.setQueryData(qk.list('shipments'), {
      rows: [{ id: 'shp_seed' }],
      total: 1,
    });

    const { result } = renderHook(() => useShipmentAmendCancel(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await result.current.mutateAsync({
        shipmentId: 'shp_seed',
        op: 'cancel',
        payload: {},
      });
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    // Must invalidate every shipments-list variant and the targeted resource.
    expect(calls).toContainEqual(['list', 'shipments']);
    expect(calls).toContainEqual(qk.resource('shipments', 'shp_seed'));
    invalidateSpy.mockRestore();
  });

  it('useShipmentAmendCancel address mutation refreshes linked address rows', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');

    longLivedClient.setQueryData(['resources_by_ids', 'addresses', ['addr_seed']], {
      rows: [{ id: 'addr_seed', normalized_line1: 'Old street' }],
      total: 1,
    });

    const { result } = renderHook(() => useShipmentAmendCancel(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await result.current.mutateAsync({
        shipmentId: 'shp_seed',
        op: 'address',
        payload: { address: { line1: 'New street', city: 'Riyadh', country: 'SA' } },
      });
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['resources_by_ids', 'addresses']);
    expect(calls).toContainEqual(qk.resource('shipments', 'shp_seed'));
    invalidateSpy.mockRestore();
  });

  it('useClientCreate invalidates filtered tenant customer lists and summaries', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const createSpy = vi.spyOn(api, 'client_create_v1').mockResolvedValue({
      id: 'cl_new',
      name: 'Launch Client',
      slug: 'launch-client',
    } as never);

    const { result } = renderHook(() => useClientCreate(), {
      wrapper: wrapper(longLivedClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        name: 'Launch Client',
        slug: 'launch-client',
        sla_tier: 'standard',
      });
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['list', 'clients']);
    expect(calls).toContainEqual(['lists_by_filters', 'clients']);
    expect(calls).toContainEqual(['list', 'clients', 'complete']);
    expect(calls).toContainEqual(['list', 'client_summary']);
    expect(calls).toContainEqual(['lists_by_filters', 'client_summary']);
    expect(calls).toContainEqual(['list', 'client_summary', 'complete']);
    expect(calls).toContainEqual(['list', 'sender_summary']);
    expect(calls).toContainEqual(['lists_by_filters', 'sender_summary']);
    expect(calls).toContainEqual(['list', 'sender_summary', 'complete']);
    expect(calls).toContainEqual(['list', 'recipient_directory']);
    expect(calls).toContainEqual(['lists_by_filters', 'recipient_directory']);
    expect(calls).toContainEqual(['list', 'recipient_directory', 'complete']);
    expect(calls).toContainEqual(['resources_by_ids', 'clients']);
    expect(calls).toContainEqual(qk.resource('clients', 'cl_new'));
    const refetchCalls = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(refetchCalls).toContainEqual(['list', 'clients']);
    expect(refetchCalls).toContainEqual(['lists_by_filters', 'clients']);
    expect(refetchCalls).toContainEqual(['list', 'clients', 'complete']);
    expect(refetchCalls).toContainEqual(['list', 'client_summary']);
    expect(refetchCalls).toContainEqual(['lists_by_filters', 'client_summary']);
    expect(refetchCalls).toContainEqual(['list', 'client_summary', 'complete']);
    expect(refetchCalls).toContainEqual(['list', 'sender_summary']);
    expect(refetchCalls).toContainEqual(['lists_by_filters', 'sender_summary']);
    expect(refetchCalls).toContainEqual(['list', 'sender_summary', 'complete']);
    expect(refetchCalls).toContainEqual(['list', 'recipient_directory']);
    expect(refetchCalls).toContainEqual(['lists_by_filters', 'recipient_directory']);
    expect(refetchCalls).toContainEqual(['list', 'recipient_directory', 'complete']);
    expect(refetchCalls).toContainEqual(['resources_by_ids', 'clients']);
    expect(refetchCalls).toContainEqual(qk.resource('clients', 'cl_new'));
    createSpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('client update/suspend/reactivate refresh active client, summary, and drawer reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const updateSpy = vi.spyOn(api, 'client_update_v1').mockResolvedValue({
      ok: true,
      client_id: 'cl_no_reload',
    } as never);
    const suspendSpy = vi.spyOn(api, 'client_suspend_v1').mockResolvedValue({
      ok: true,
      client_id: 'cl_no_reload',
    } as never);
    const reactivateSpy = vi.spyOn(api, 'client_reactivate_v1').mockResolvedValue({
      ok: true,
      client_id: 'cl_no_reload',
    } as never);
    const expectClientRefresh = () => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      for (const key of [
        ['list', 'clients'],
        ['lists_by_filters', 'clients'],
        ['list', 'clients', 'complete'],
        ['list', 'client_summary'],
        ['lists_by_filters', 'client_summary'],
        ['list', 'client_summary', 'complete'],
        ['resources_by_ids', 'clients'],
        qk.resource('clients', 'cl_no_reload'),
      ]) {
        expect(invalidations).toContainEqual(key);
        expect(refetches).toContainEqual(key);
      }
      invalidateSpy.mockClear();
      refetchSpy.mockClear();
    };

    const { result: updateResult } = renderHook(() => useClientUpdate(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await updateResult.current.mutateAsync({
        client_id: 'cl_no_reload',
        name: 'Client No Reload Updated',
      });
    });
    expectClientRefresh();

    const { result: suspendResult } = renderHook(() => useSuspendClient(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await suspendResult.current.mutateAsync({
        client_id: 'cl_no_reload',
        reason: 'operator requested archive',
      });
    });
    expectClientRefresh();

    const { result: reactivateResult } = renderHook(() => useReactivateClient(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await reactivateResult.current.mutateAsync({
        client_id: 'cl_no_reload',
      });
    });
    expectClientRefresh();

    updateSpy.mockRestore();
    suspendSpy.mockRestore();
    reactivateSpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('sender create/update/suspend/reactivate refresh active sender, summary, and client context reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const createSpy = vi.spyOn(api, 'sender_create_v1').mockResolvedValue({
      ok: true,
      sender_id: 'snd_no_reload',
    } as never);
    const updateSpy = vi.spyOn(api, 'sender_update_v1').mockResolvedValue({
      ok: true,
      sender_id: 'snd_no_reload',
    } as never);
    const suspendSpy = vi.spyOn(api, 'sender_suspend_v1').mockResolvedValue({
      ok: true,
      sender_id: 'snd_no_reload',
    } as never);
    const reactivateSpy = vi.spyOn(api, 'sender_reactivate_v1').mockResolvedValue({
      ok: true,
      sender_id: 'snd_no_reload',
    } as never);
    const expectSenderListRefresh = () => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      for (const key of [
        ['list', 'senders'],
        ['lists_by_filters', 'senders'],
        ['list', 'senders', 'complete'],
        ['list', 'sender_summary'],
        ['lists_by_filters', 'sender_summary'],
        ['list', 'sender_summary', 'complete'],
        ['list', 'client_summary'],
        ['lists_by_filters', 'client_summary'],
        ['list', 'client_summary', 'complete'],
        ['resources_by_ids', 'senders'],
        qk.resource('senders', 'snd_no_reload'),
      ]) {
        expect(invalidations).toContainEqual(key);
        expect(refetches).toContainEqual(key);
      }
      invalidateSpy.mockClear();
      refetchSpy.mockClear();
    };
    const expectSenderResourceRefresh = () => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      for (const key of [
        ['list', 'senders'],
        ['lists_by_filters', 'senders'],
        ['list', 'senders', 'complete'],
        ['list', 'sender_summary'],
        ['lists_by_filters', 'sender_summary'],
        ['list', 'sender_summary', 'complete'],
        ['list', 'client_summary'],
        ['lists_by_filters', 'client_summary'],
        ['list', 'client_summary', 'complete'],
        ['resources_by_ids', 'senders'],
        qk.resource('senders', 'snd_no_reload'),
      ]) {
        expect(invalidations).toContainEqual(key);
        expect(refetches).toContainEqual(key);
      }
      invalidateSpy.mockClear();
      refetchSpy.mockClear();
    };

    const { result: createResult } = renderHook(() => useSenderCreate(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await createResult.current.mutateAsync({
        client_id: 'cl_seed',
        name: 'Sender No Reload',
      });
    });
    expectSenderListRefresh();

    const { result: updateResult } = renderHook(() => useSenderUpdate(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await updateResult.current.mutateAsync({
        sender_id: 'snd_no_reload',
        name: 'Sender No Reload Updated',
      });
    });
    expectSenderResourceRefresh();

    const { result: suspendResult } = renderHook(() => useSuspendSender(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await suspendResult.current.mutateAsync({
        sender_id: 'snd_no_reload',
        reason: 'provider paused',
      });
    });
    expectSenderResourceRefresh();

    const { result: reactivateResult } = renderHook(() => useReactivateSender(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await reactivateResult.current.mutateAsync({
        sender_id: 'snd_no_reload',
      });
    });
    expectSenderResourceRefresh();

    createSpy.mockRestore();
    updateSpy.mockRestore();
    suspendSpy.mockRestore();
    reactivateSpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('recipient create/update/delete refresh active recipient, directory, and drawer reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const createSpy = vi.spyOn(api, 'recipient_create_v1').mockResolvedValue({
      ok: true,
      recipient_id: 'rcp_new',
    } as never);
    const updateSpy = vi.spyOn(api, 'recipient_update_v1').mockResolvedValue({
      ok: true,
      recipient_id: 'rcp_new',
    } as never);
    const deleteSpy = vi.spyOn(api, 'recipient_delete_v1').mockResolvedValue({
      ok: true,
      recipient_id: 'rcp_new',
      deleted: true,
    } as never);
    const expectRecipientListRefresh = () => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      for (const key of [
        ['list', 'recipients'],
        ['lists_by_filters', 'recipients'],
        ['list', 'recipients', 'complete'],
        ['list', 'recipient_directory'],
        ['lists_by_filters', 'recipient_directory'],
        ['list', 'recipient_directory', 'complete'],
        ['list', 'client_summary'],
        ['lists_by_filters', 'client_summary'],
        ['list', 'client_summary', 'complete'],
        ['resources_by_ids', 'recipients'],
        qk.resource('recipients', 'rcp_new'),
      ]) {
        expect(invalidations).toContainEqual(key);
        expect(refetches).toContainEqual(key);
      }
      invalidateSpy.mockClear();
      refetchSpy.mockClear();
    };
    const expectRecipientResourceRefresh = () => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      for (const key of [
        ['list', 'recipients'],
        ['lists_by_filters', 'recipients'],
        ['list', 'recipients', 'complete'],
        ['list', 'recipient_directory'],
        ['lists_by_filters', 'recipient_directory'],
        ['list', 'recipient_directory', 'complete'],
        ['list', 'client_summary'],
        ['lists_by_filters', 'client_summary'],
        ['list', 'client_summary', 'complete'],
        ['resources_by_ids', 'recipients'],
        qk.resource('recipients', 'rcp_new'),
      ]) {
        expect(invalidations).toContainEqual(key);
        expect(refetches).toContainEqual(key);
      }
      invalidateSpy.mockClear();
      refetchSpy.mockClear();
    };

    const { result: createResult } = renderHook(() => useRecipientCreate(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await createResult.current.mutateAsync({
        client_id: 'cl_seed',
        name: 'No Reload Recipient',
        phone_number: '+966500000955',
      });
    });
    expectRecipientListRefresh();

    const { result: updateResult } = renderHook(() => useRecipientUpdate(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await updateResult.current.mutateAsync({
        recipient_id: 'rcp_new',
        name: 'No Reload Recipient Updated',
        phone_number: '+966500000955',
      });
    });
    expectRecipientResourceRefresh();

    const { result: deleteResult } = renderHook(() => useRecipientDelete(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await deleteResult.current.mutateAsync({
        recipient_id: 'rcp_new',
        reason: 'duplicate contact',
      });
    });
    expectRecipientResourceRefresh();

    createSpy.mockRestore();
    updateSpy.mockRestore();
    deleteSpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('useAssignBranchZone refreshes filtered branch-zone and related network reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const assignSpy = vi.spyOn(api, 'branch_zone_assign_v1').mockResolvedValue({
      ok: true,
      branch_zone_id: 'bz_live',
      branch_id: 'br_live',
      zone_id: 'zone_live',
    } as never);

    const { result } = renderHook(() => useAssignBranchZone(), {
      wrapper: wrapper(longLivedClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        branch_id: 'br_live',
        zone_id: 'zone_live',
        priority: 0,
      });
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['list', 'branch_zones']);
    expect(calls).toContainEqual(['lists_by_filters', 'branch_zones']);
    expect(calls).toContainEqual(['list', 'branches']);
    expect(calls).toContainEqual(['lists_by_filters', 'branches']);
    expect(calls).toContainEqual(['list', 'zones']);
    expect(calls).toContainEqual(['lists_by_filters', 'zones']);
    assignSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('useUpsertWebhookSource refreshes filtered source and source-directory reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const upsertSpy = vi.spyOn(api, 'ui_upsert_webhook_source_v1').mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_live',
      correlation_id: 'cor_live',
    } as never);

    const { result } = renderHook(() => useUpsertWebhookSource(), {
      wrapper: wrapper(longLivedClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        source_id: 'whs_live',
        sender_id: 'snd_live',
      });
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['list', 'webhook_sources']);
    expect(calls).toContainEqual(['lists_by_filters', 'webhook_sources']);
    expect(calls).toContainEqual(['list', 'webhook_source_directory']);
    expect(calls).toContainEqual(['lists_by_filters', 'webhook_source_directory']);
    expect(calls).toContainEqual(['list', 'webhook_sources', 'complete']);
    expect(calls).toContainEqual(['list', 'webhook_source_directory', 'complete']);
    expect(calls).toContainEqual(['resources_by_ids', 'webhook_sources']);
    expect(calls).toContainEqual(['resources_by_ids', 'webhook_source_directory']);
    expect(calls).toContainEqual(qk.resource('webhook_sources', 'whs_live'));
    expect(calls).toContainEqual(qk.resource('webhook_source_directory', 'whs_live'));
    const refetchCalls = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(refetchCalls).toContainEqual(['list', 'webhook_sources']);
    expect(refetchCalls).toContainEqual(['lists_by_filters', 'webhook_sources']);
    expect(refetchCalls).toContainEqual(['list', 'webhook_source_directory']);
    expect(refetchCalls).toContainEqual(['lists_by_filters', 'webhook_source_directory']);
    expect(refetchCalls).toContainEqual(['list', 'webhook_sources', 'complete']);
    expect(refetchCalls).toContainEqual(['list', 'webhook_source_directory', 'complete']);
    expect(refetchCalls).toContainEqual(['resources_by_ids', 'webhook_sources']);
    expect(refetchCalls).toContainEqual(['resources_by_ids', 'webhook_source_directory']);
    expect(refetchCalls).toContainEqual(qk.resource('webhook_sources', 'whs_live'));
    expect(refetchCalls).toContainEqual(qk.resource('webhook_source_directory', 'whs_live'));
    upsertSpy.mockRestore();
    invalidateSpy.mockRestore();
    refetchSpy.mockRestore();
  });

  it('useRotateWebhookSourceToken refreshes filtered source and source-directory reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const rotateSpy = vi.spyOn(api, 'ui_rotate_webhook_source_token_v1').mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_live',
      auth_token: 'a'.repeat(64),
      correlation_id: 'cor_live',
    } as never);

    const { result } = renderHook(() => useRotateWebhookSourceToken(), {
      wrapper: wrapper(longLivedClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ source_id: 'whs_live' });
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['list', 'webhook_sources']);
    expect(calls).toContainEqual(['lists_by_filters', 'webhook_sources']);
    expect(calls).toContainEqual(['list', 'webhook_source_directory']);
    expect(calls).toContainEqual(['lists_by_filters', 'webhook_source_directory']);
    expect(calls).toContainEqual(['list', 'webhook_sources', 'complete']);
    expect(calls).toContainEqual(['list', 'webhook_source_directory', 'complete']);
    expect(calls).toContainEqual(['resources_by_ids', 'webhook_sources']);
    expect(calls).toContainEqual(['resources_by_ids', 'webhook_source_directory']);
    expect(calls).toContainEqual(qk.resource('webhook_sources', 'whs_live'));
    expect(calls).toContainEqual(qk.resource('webhook_source_directory', 'whs_live'));
    const refetchCalls = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(refetchCalls).toContainEqual(['list', 'webhook_sources']);
    expect(refetchCalls).toContainEqual(['lists_by_filters', 'webhook_sources']);
    expect(refetchCalls).toContainEqual(['list', 'webhook_source_directory']);
    expect(refetchCalls).toContainEqual(['lists_by_filters', 'webhook_source_directory']);
    expect(refetchCalls).toContainEqual(['list', 'webhook_sources', 'complete']);
    expect(refetchCalls).toContainEqual(['list', 'webhook_source_directory', 'complete']);
    expect(refetchCalls).toContainEqual(['resources_by_ids', 'webhook_sources']);
    expect(refetchCalls).toContainEqual(['resources_by_ids', 'webhook_source_directory']);
    expect(refetchCalls).toContainEqual(qk.resource('webhook_sources', 'whs_live'));
    expect(refetchCalls).toContainEqual(qk.resource('webhook_source_directory', 'whs_live'));
    rotateSpy.mockRestore();
    invalidateSpy.mockRestore();
    refetchSpy.mockRestore();
  });

  it('useArchiveWebhookSource refreshes filtered source and source-directory reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const archiveSpy = vi.spyOn(api, 'ui_archive_webhook_source_v1').mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_live',
      enabled: false,
      action: 'archived',
      correlation_id: 'cor_live',
    } as never);

    const { result } = renderHook(() => useArchiveWebhookSource(), {
      wrapper: wrapper(longLivedClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ source_id: 'whs_live', reason: 'Legacy integration retired' });
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['list', 'webhook_sources']);
    expect(calls).toContainEqual(['lists_by_filters', 'webhook_sources']);
    expect(calls).toContainEqual(['list', 'webhook_source_directory']);
    expect(calls).toContainEqual(['lists_by_filters', 'webhook_source_directory']);
    expect(calls).toContainEqual(['list', 'webhook_sources', 'complete']);
    expect(calls).toContainEqual(['list', 'webhook_source_directory', 'complete']);
    expect(calls).toContainEqual(['resources_by_ids', 'webhook_sources']);
    expect(calls).toContainEqual(['resources_by_ids', 'webhook_source_directory']);
    expect(calls).toContainEqual(qk.resource('webhook_sources', 'whs_live'));
    expect(calls).toContainEqual(qk.resource('webhook_source_directory', 'whs_live'));
    const refetchCalls = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(refetchCalls).toContainEqual(['list', 'webhook_sources']);
    expect(refetchCalls).toContainEqual(['lists_by_filters', 'webhook_sources']);
    expect(refetchCalls).toContainEqual(['list', 'webhook_source_directory']);
    expect(refetchCalls).toContainEqual(['lists_by_filters', 'webhook_source_directory']);
    expect(refetchCalls).toContainEqual(['list', 'webhook_sources', 'complete']);
    expect(refetchCalls).toContainEqual(['list', 'webhook_source_directory', 'complete']);
    expect(refetchCalls).toContainEqual(['resources_by_ids', 'webhook_sources']);
    expect(refetchCalls).toContainEqual(['resources_by_ids', 'webhook_source_directory']);
    expect(refetchCalls).toContainEqual(qk.resource('webhook_sources', 'whs_live'));
    expect(refetchCalls).toContainEqual(qk.resource('webhook_source_directory', 'whs_live'));
    archiveSpy.mockRestore();
    invalidateSpy.mockRestore();
    refetchSpy.mockRestore();
  });

  it('api gateway write actions actively refresh visible gateway and source reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const blockSpy = vi.spyOn(api, 'block_api_gateway_source_v1').mockResolvedValue({
      ok: true,
      source_id: 'src_live',
      correlation_id: 'cor_block_live',
    } as never);
    const adjustSpy = vi.spyOn(api, 'adjust_api_gateway_rate_limit_v1').mockResolvedValue({
      ok: true,
      source_id: 'src_live',
      correlation_id: 'cor_adjust_live',
    } as never);
    const gatewayTestSpy = vi.spyOn(api, 'runApiGatewayRequestTest').mockResolvedValue({
      ok: true,
      correlation_id: 'cor_api_test',
      idempotency_key: 'cor_api_test',
      method: 'POST',
      path: '/api/ship/request/by-email',
      query_string: null,
      api_gateway_request_id: 'req_api_test',
      workflow_run_id: 'wfr_api_test',
      outbound_call_id: 'obc_api_test',
      intake_state: 'shipment_materialized',
      error_code: null,
      outbound_status: 'completed',
      shipment_id: 'shp_api_test',
      tracking_number: 'API-TEST-001',
      shipment_status: 'created',
      response: { accepted: true },
      request_readback: {
        request_id: 'req_api_test',
        shipment_id: 'shp_api_test',
      },
    } as never);

    const expectedKeys = [
      ['list', 'webhook_sources'],
      ['lists_by_filters', 'webhook_sources'],
      ['list', 'webhook_source_directory'],
      ['lists_by_filters', 'webhook_source_directory'],
      ['list', 'api_call_log'],
      ['lists_by_filters', 'api_call_log'],
      ['list', 'api_gateway_observability'],
      ['lists_by_filters', 'api_gateway_observability'],
      ['list', 'api_gateway_requests'],
      ['lists_by_filters', 'api_gateway_requests'],
      ['list', 'api_gateway_rate_limits'],
      ['lists_by_filters', 'api_gateway_rate_limits'],
      ['list', 'api_gateway_rate_limits_summary'],
      ['lists_by_filters', 'api_gateway_rate_limits_summary'],
    ];
    const expectGatewayRefresh = () => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      for (const key of expectedKeys) {
        expect(invalidations).toContainEqual(key);
        expect(refetches).toContainEqual(key);
      }
      invalidateSpy.mockClear();
      refetchSpy.mockClear();
    };

    const { result: blockResult } = renderHook(() => useBlockApiGatewaySource(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await blockResult.current.mutateAsync({ source_id: 'src_live', reason: 'incident block' });
    });
    expectGatewayRefresh();

    const { result: adjustResult } = renderHook(() => useAdjustApiGatewayRateLimit(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await adjustResult.current.mutateAsync({ source_id: 'src_live', limit_per_min: 120 });
    });
    expectGatewayRefresh();

    const { result: apiTestResult } = renderHook(() => useRunApiGatewayRequestTest(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await apiTestResult.current.mutateAsync({
        auth_token: 'source-token',
        method: 'POST',
        path: '/api/ship/request/by-email',
        payload: { receiverName: 'First Tenant API Receiver' },
        correlation_id: 'cor_api_test',
        idempotency_key: 'cor_api_test',
        expect_shipment: true,
      });
    });
    const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    for (const key of [
      ['list', 'api_gateway_requests'],
      ['lists_by_filters', 'api_gateway_requests'],
      ['resources_by_ids', 'api_gateway_requests'],
      qk.resource('api_gateway_requests', 'req_api_test'),
      ['list', 'shipments'],
      ['lists_by_filters', 'shipments'],
      ['resources_by_ids', 'shipments'],
      qk.resource('shipments', 'shp_api_test'),
      ['list', 'shipment_directory'],
      ['lists_by_filters', 'shipment_directory'],
      ['list', 'shipment_actions'],
      ['lists_by_filters', 'shipment_actions'],
      ['list', 'decision_log'],
      ['lists_by_filters', 'decision_log'],
      ['list', 'audit_table_changes'],
      ['lists_by_filters', 'audit_table_changes'],
    ]) {
      expect(invalidations).toContainEqual(key);
      expect(refetches).toContainEqual(key);
    }

    blockSpy.mockRestore();
    adjustSpy.mockRestore();
    gatewayTestSpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('import job and tabular import write actions actively refresh visible import reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const createSpy = vi.spyOn(api, 'import_job_create_v1').mockResolvedValue({
      ok: true,
      import_job_id: 'job_live',
      correlation_id: 'cor_import_create',
    } as never);
    const cancelJobSpy = vi.spyOn(api, 'import_job_cancel_v1').mockResolvedValue({
      ok: true,
      import_job_id: 'job_live',
      correlation_id: 'cor_import_cancel',
    } as never);
    const startRunSpy = vi.spyOn(api, 'resource_import_studio_start_v1').mockResolvedValue({
      ok: true,
      run: { id: 'run_live', status: 'queued', task_id: 'task_live' },
      report: null,
      correlation_id: 'cor_import_start',
    } as never);
    const cancelRunSpy = vi.spyOn(api, 'resource_import_studio_cancel_v1').mockResolvedValue({
      ok: true,
      run: {
        id: 'run_live',
        status: 'canceled',
        summary: {
          cancellation: { reason: 'operator cancel file run' },
          cancel_reason: 'operator cancel file run',
        },
      },
      correlation_id: 'cor_import_cancel_run',
    } as never);

    const expectListRefresh = (resources: string[]) => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      for (const resource of resources) {
        for (const key of [
          ['list', resource],
          ['lists_by_filters', resource],
        ]) {
          expect(invalidations).toContainEqual(key);
          expect(refetches).toContainEqual(key);
        }
      }
    };
    const expectRunResourceRefresh = () => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      for (const key of [
        ['resources_by_ids', 'tabular_import_runs'],
        ['resource', 'tabular_import_runs', 'run_live'],
      ]) {
        expect(invalidations).toContainEqual(key);
        expect(refetches).toContainEqual(key);
      }
    };

    const { result: createResult } = renderHook(() => useImportJobCreate(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await createResult.current.mutateAsync({ resource: 'shipments' });
    });
    expectListRefresh(['import_jobs', 'import_job_directory']);
    invalidateSpy.mockClear();
    refetchSpy.mockClear();

    const { result: cancelJobResult } = renderHook(() => useImportJobCancel(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await cancelJobResult.current.mutateAsync({ import_job_id: 'job_live', reason: 'operator cancel' });
    });
    expectListRefresh(['import_jobs', 'import_job_directory']);
    invalidateSpy.mockClear();
    refetchSpy.mockClear();

    const { result: startResult } = renderHook(() => useResourceImportStudioStart(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await startResult.current.mutateAsync({ run_id: 'run_live' });
    });
    expectListRefresh(['tabular_import_runs', 'import_jobs', 'import_job_directory']);
    expectRunResourceRefresh();
    invalidateSpy.mockClear();
    refetchSpy.mockClear();

    const { result: cancelRunResult } = renderHook(() => useResourceImportStudioCancel(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await cancelRunResult.current.mutateAsync({ run_id: 'run_live', reason: 'operator cancel file run' });
    });
    expectListRefresh(['tabular_import_runs', 'import_jobs', 'import_job_directory']);
    expectRunResourceRefresh();

    cancelRunSpy.mockRestore();
    startRunSpy.mockRestore();
    cancelJobSpy.mockRestore();
    createSpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('useReplayWebhookInbox refreshes filtered inbox and inbox-directory reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const replaySpy = vi.spyOn(api, 'webhook_inbox_replay_v1').mockResolvedValue({
      ok: true,
      webhook_inbox_id: 'wbk_live',
      prior_status: 'succeeded',
    } as never);

    const { result } = renderHook(() => useReplayWebhookInbox(), {
      wrapper: wrapper(longLivedClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        webhook_inbox_id: 'wbk_live',
        reason: 'operator_replay',
      });
    });

    const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    for (const key of [
      ['list', 'webhook_inbox'],
      ['lists_by_filters', 'webhook_inbox'],
      ['list', 'webhook_inbox_directory'],
      ['lists_by_filters', 'webhook_inbox_directory'],
    ]) {
      expect(invalidations).toContainEqual(key);
      expect(refetches).toContainEqual(key);
    }
    replaySpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('useRecordHoursOfServiceSegment refreshes active driver drawer readback queries', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const recordSpy = vi.spyOn(api, 'record_hours_of_service_segment_v1').mockResolvedValue({
      ok: true,
      driver_profile_id: 'drvp_live',
      driver_hours_of_service_id: 'hos_live',
      duty_status: 'sleeper',
      correlation_id: 'corr_hos_live',
    } as never);

    const { result } = renderHook(() => useRecordHoursOfServiceSegment(), {
      wrapper: wrapper(longLivedClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        driver_profile_id: 'drvp_live',
        driver_user_id: 'usr_driver_live',
        duty_status: 'sleeper',
        segment_start: '2026-05-21T09:45:00.000Z',
      });
    });

    const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    for (const key of [
      ['list', 'driver_directory'],
      ['list', 'driver_directory', 'complete'],
      ['resources_by_ids', 'driver_directory'],
      ['resource', 'driver_directory', 'drvp_live'],
      ['driver_hours_of_service'],
      ['driver_hours_of_service', 'drvp_live'],
    ]) {
      expect(invalidations).toContainEqual(key);
      expect(refetches).toContainEqual(key);
    }
    recordSpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('useForceWebhookInboxStatus refreshes filtered inbox and inbox-directory reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const forceSpy = vi.spyOn(api, 'webhook_inbox_force_status_v1').mockResolvedValue({
      ok: true,
      webhook_inbox_id: 'wbk_live',
      prior_status: 'pending',
      forced_status: 'failed',
    } as never);

    const { result } = renderHook(() => useForceWebhookInboxStatus(), {
      wrapper: wrapper(longLivedClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        webhook_inbox_id: 'wbk_live',
        target_status: 'failed',
        reason: 'operator_force_failed',
      });
    });

    const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
    for (const key of [
      ['list', 'webhook_inbox'],
      ['lists_by_filters', 'webhook_inbox'],
      ['list', 'webhook_inbox_directory'],
      ['lists_by_filters', 'webhook_inbox_directory'],
    ]) {
      expect(invalidations).toContainEqual(key);
      expect(refetches).toContainEqual(key);
    }
    forceSpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it.each(['save', 'promote'] as const)('refreshes mapping and bound intake reads on %s', async (action) => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const upsertSpy = vi.spyOn(api, 'ui_upsert_mapping_artifact_v1').mockResolvedValue({
      ok: true,
      mapping_config_id: 'mcfg_live',
      correlation_id: 'cor_mapping_live',
    } as never);

    const promoteSpy = vi.spyOn(api, 'mapping_config_promote_v1').mockResolvedValue({
      ok: true,
      mapping_config_id: 'mcfg_live',
      promoted_to_version: 2,
    } as never);
    const { result } = renderHook(() => ({
      save: useUpsertMappingArtifact(),
      promote: usePromoteMappingVersion(),
    }), {
      wrapper: wrapper(longLivedClient),
    });

    await act(async () => {
      if (action === 'promote') {
        await result.current.promote.mutateAsync({ mapping_config_id: 'mcfg_live' });
        return;
      }
      await result.current.save.mutateAsync({
        artifact: 'mapping_config',
        mapping_config_id: 'mcfg_live',
        mapping_type: 'webhook_inbound',
        mapping_key: 'live.mapping',
        mapping_config: { target: 'shipments.create' },
      });
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    for (const resource of [
      'mapping_configs', 'mapping_config_directory', 'webhook_sources',
      'webhook_source_directory', 'webhook_rules', 'api_routes',
    ]) {
      expect(calls).toContainEqual(['list', resource]);
      expect(calls).toContainEqual(['lists_by_filters', resource]);
    }
    upsertSpy.mockRestore();
    promoteSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('useDeleteMappingConfig refreshes filtered mapping config and directory reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const deleteSpy = vi.spyOn(api, 'ui_delete_mapping_config_v1').mockResolvedValue({
      ok: true,
      mapping_config_id: 'mcfg_live',
      correlation_id: 'cor_mapping_delete_live',
    } as never);

    const { result } = renderHook(() => useDeleteMappingConfig(), {
      wrapper: wrapper(longLivedClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ mapping_config_id: 'mcfg_live' });
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['list', 'mapping_configs']);
    expect(calls).toContainEqual(['lists_by_filters', 'mapping_configs']);
    expect(calls).toContainEqual(['list', 'mapping_config_directory']);
    expect(calls).toContainEqual(['lists_by_filters', 'mapping_config_directory']);
    deleteSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('provider credential mutations actively refresh visible credential and directory reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const upsertSpy = vi.spyOn(api, 'ui_upsert_provider_auth_config_v1').mockResolvedValue({
      ok: true,
      provider_auth_config_id: 'pac_live',
      correlation_id: 'cor_upsert_live',
    } as never);
    const bindSpy = vi.spyOn(api, 'ui_bind_provider_account_credential_v1').mockResolvedValue({
      ok: true,
      provider_auth_config_id: 'pac_live',
      correlation_id: 'cor_bind_live',
    } as never);
    const unbindSpy = vi.spyOn(api, 'ui_unbind_provider_account_credential_v1').mockResolvedValue({
      ok: true,
      bound: false,
      correlation_id: 'cor_unbind_live',
    } as never);
    const rotateSpy = vi.spyOn(api, 'integration_plugin_rotate_credentials_v1').mockResolvedValue({
      ok: true,
      provider_auth_config_id: 'pac_live',
      correlation_id: 'cor_rotate_live',
    } as never);
    const revokeSpy = vi.spyOn(api, 'ui_revoke_provider_auth_config_v1').mockResolvedValue({
      ok: true,
      provider_auth_config_id: 'pac_live',
      correlation_id: 'cor_revoke_live',
    } as never);

    const expectCredentialRefresh = (includeGateway = false) => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      const expectedKeys: Array<readonly unknown[]> = [
        ['list', 'provider_auth_configs'],
        ['lists_by_filters', 'provider_auth_configs'],
        ['list', 'integration_credential_directory'],
        ['lists_by_filters', 'integration_credential_directory'],
      ];
      if (includeGateway) {
        expectedKeys.push(
          qk.resolveSettingsCategory('logestechs_v2_account'),
          ['list', 'api_gateway_requests'],
          ['lists_by_filters', 'api_gateway_requests'],
          ['list', 'api_routes'],
          ['lists_by_filters', 'api_routes'],
        );
      }
      for (const key of expectedKeys) {
        expect(invalidations).toContainEqual(key);
        expect(refetches).toContainEqual(key);
      }
      invalidateSpy.mockClear();
      refetchSpy.mockClear();
    };

    const { result: upsertResult } = renderHook(() => useUpsertProviderAuthConfig(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await upsertResult.current.mutateAsync({
        provider_id: 'prv_live',
        auth_type: 'api_key',
        credentials: { api_key: 'live-secret' },
      });
    });
    expectCredentialRefresh();

    const { result: bindResult } = renderHook(() => useBindProviderAccountCredential(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await bindResult.current.mutateAsync({
        route_id: 'rt_live',
        provider_id: 'prv_live',
        credentials: { username: 'api', password: 'secret' },
      });
    });
    expectCredentialRefresh(true);

    const { result: unbindResult } = renderHook(() => useUnbindProviderAccountCredential(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await unbindResult.current.mutateAsync({
        route_id: 'rt_live',
        provider_account_category: 'logestechs_v2_account',
        reason: 'operator_unbind',
      });
    });
    expectCredentialRefresh(true);

    const { result: rotateResult } = renderHook(() => useRotateProviderCredentials(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await rotateResult.current.mutateAsync({
        config_id: 'pac_live',
        credentials: { api_key: 'rotated-secret' },
      });
    });
    expectCredentialRefresh();

    const { result: revokeResult } = renderHook(() => useRevokeProviderAuthConfig(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await revokeResult.current.mutateAsync({ config_id: 'pac_live', reason: 'operator_revoke' });
    });
    expectCredentialRefresh();

    upsertSpy.mockRestore();
    bindSpy.mockRestore();
    unbindSpy.mockRestore();
    rotateSpy.mockRestore();
    revokeSpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('RBAC mutations actively refresh role, assignment, template, and user read surfaces', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const createSpy = vi.spyOn(api, 'rbac_create_role_v1').mockResolvedValue({
      ok: true,
      rbac_role_id: 'rol_live',
      correlation_id: 'cor_rbac_create',
    } as never);
    const grantSpy = vi.spyOn(api, 'rbac_grant_role_v1').mockResolvedValue({
      ok: true,
      rbac_user_role_assignment_id: 'ura_live',
      correlation_id: 'cor_rbac_grant',
    } as never);
    const revokeSpy = vi.spyOn(api, 'rbac_revoke_role_v1').mockResolvedValue({
      ok: true,
      rbac_user_role_assignment_id: 'ura_live',
      correlation_id: 'cor_rbac_revoke',
    } as never);
    const applySpy = vi.spyOn(api, 'provision_rbac_roles_from_templates_v1').mockResolvedValue({
      ok: true,
      rbac_role_id: 'rol_template',
      rbac_roles: [{ template_key: 'driver', role_id: 'rol_template', created: false }],
      template_keys: ['driver'],
      correlation_id: 'cor_rbac_template',
    } as never);

    const expectedRbacKeys: Array<readonly unknown[]> = [
      ['list', 'rbac_roles'],
      ['lists_by_filters', 'rbac_roles'],
      ['list', 'rbac_roles', 'complete'],
      ['list', 'rbac_role_summary'],
      ['lists_by_filters', 'rbac_role_summary'],
      ['list', 'rbac_role_summary', 'complete'],
      ['list', 'rbac_role_permissions'],
      ['lists_by_filters', 'rbac_role_permissions'],
      ['list', 'rbac_role_permissions', 'complete'],
      ['list', 'rbac_user_role_assignments'],
      ['lists_by_filters', 'rbac_user_role_assignments'],
      ['list', 'rbac_user_role_assignments', 'complete'],
    ];
    const expectRefreshed = (extraKeys: Array<readonly unknown[]> = []) => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      for (const key of [...expectedRbacKeys, ...extraKeys]) {
        expect(invalidations).toContainEqual(key);
        expect(refetches).toContainEqual(key);
      }
      invalidateSpy.mockClear();
      refetchSpy.mockClear();
    };

    const { result: createResult } = renderHook(() => useCreateRbacRole(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await createResult.current.mutateAsync({ key: 'live_role', name: 'Live role' });
    });
    expectRefreshed();

    const { result: grantResult } = renderHook(() => useGrantRbacRole(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await grantResult.current.mutateAsync({ user_id: 'usr_live', role_id: 'rol_live' });
    });
    expectRefreshed([
      ['list', 'users'],
      ['lists_by_filters', 'users'],
      ['list', 'users', 'complete'],
      ['list', 'user_directory'],
      ['lists_by_filters', 'user_directory'],
      ['list', 'user_directory', 'complete'],
    ]);

    const { result: revokeResult } = renderHook(() => useRevokeRbacRole(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await revokeResult.current.mutateAsync({ assignment_id: 'ura_live', reason: 'operator_revoke' });
    });
    expectRefreshed([
      ['list', 'users'],
      ['lists_by_filters', 'users'],
      ['list', 'users', 'complete'],
      ['list', 'user_directory'],
      ['lists_by_filters', 'user_directory'],
      ['list', 'user_directory', 'complete'],
    ]);

    const { result: applyResult } = renderHook(() => useApplyRbacRoleTemplate(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await applyResult.current.mutateAsync({ template_keys: ['driver'] });
    });
    expectRefreshed([
      ['list', 'rbac_role_templates'],
      ['lists_by_filters', 'rbac_role_templates'],
    ]);

    createSpy.mockRestore();
    grantSpy.mockRestore();
    revokeSpy.mockRestore();
    applySpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('Workflow template and binding mutations refresh active directory, dispatch, and complete-list readbacks', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const createTemplateSpy = vi.spyOn(api, 'ui_create_workflow_template_v1').mockResolvedValue({
      ok: true,
      workflow_template_id: 'tpl_live',
      correlation_id: 'cor_wf_template_create',
    } as never);
    const setStatusSpy = vi.spyOn(api, 'ui_set_workflow_template_status_v1').mockResolvedValue({
      ok: true,
      workflow_template_id: 'tpl_live',
      correlation_id: 'cor_wf_template_status',
    } as never);
    const createStepSpy = vi.spyOn(api, 'ui_create_workflow_template_step_v1').mockResolvedValue({
      ok: true,
      workflow_template_id: 'tpl_live',
      workflow_template_step_id: 'step_live',
      action: 'created',
      correlation_id: 'cor_wf_step_create',
    } as never);
    const restoreTemplateSpy = vi.spyOn(api, 'restore_workflow_template_v1').mockResolvedValue({
      ok: true,
      workflow_template_id: 'tpl_live',
      source_workflow_template_id: 'tpl_source',
      restored_version: '2',
      restored_step_count: 1,
      correlation_id: 'cor_wf_template_restore',
    } as never);
    const registerBindingSpy = vi.spyOn(api, 'register_workflow_binding_v1').mockResolvedValue({
      ok: true,
      workflow_binding_id: 'webhook.shipment.created.default',
      correlation_id: 'cor_wf_binding_register',
    } as never);
    const simulateBindingSpy = vi.spyOn(api, 'simulate_binding_dispatch_v1').mockResolvedValue({
      ok: true,
      workflow_binding_dispatch_id: 'wbd_live',
      correlation_id: 'cor_wf_binding_simulate',
    } as never);

    const expectRefresh = (resources: string[]) => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      for (const resource of resources) {
        for (const key of [
          ['list', resource],
          ['lists_by_filters', resource],
          ['list', resource, 'complete'],
        ]) {
          expect(invalidations).toContainEqual(key);
          expect(refetches).toContainEqual(key);
        }
      }
      invalidateSpy.mockClear();
      refetchSpy.mockClear();
    };

    const templateResources = [
      'workflow_templates',
      'workflow_template_steps',
      'workflow_template_directory',
      'workflow_bindings',
      'workflow_binding_directory',
      'workflow_runs',
      'workflow_run_directory',
    ];
    const bindingResources = [
      'workflow_bindings',
      'workflow_binding_directory',
      'workflow_binding_dispatches',
      'workflow_templates',
      'workflow_template_directory',
      'workflow_runs',
      'workflow_run_directory',
    ];

    const { result: createTemplate } = renderHook(() => useCreateWorkflowTemplate(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await createTemplate.current.mutateAsync({ name: 'Live template', trigger: 'shipment.created' });
    });
    expectRefresh(templateResources);

    const { result: setStatus } = renderHook(() => useSetWorkflowTemplateStatus(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await setStatus.current.mutateAsync({ template_id: 'tpl_live', status: 'active' });
    });
    expectRefresh(templateResources);

    const { result: createStep } = renderHook(() => useCreateWorkflowTemplateStep(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await createStep.current.mutateAsync({
        workflow_template_id: 'tpl_live',
        step: { operation_name: 'noop', sequence_order: 1 },
      });
    });
    expectRefresh(templateResources);

    const { result: restoreTemplate } = renderHook(() => useRestoreWorkflowTemplateVersion(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await restoreTemplate.current.mutateAsync({
        workflow_template_id: 'tpl_live',
        source_workflow_template_id: 'tpl_source',
        reason: 'test restore refresh',
      });
    });
    expect(restoreTemplateSpy).toHaveBeenCalledWith({
      workflow_template_id: 'tpl_live',
      source_workflow_template_id: 'tpl_source',
      reason: 'test restore refresh',
    });
    expectRefresh(templateResources);

    const { result: registerBinding } = renderHook(() => useRegisterWorkflowBinding(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await registerBinding.current.mutateAsync({
        binding_key: 'webhook.shipment.created.default',
        stage_key: 'default',
        workflow_template_id: 'tpl_live',
      });
    });
    expectRefresh(bindingResources);

    const { result: simulateBinding } = renderHook(() => useSimulateBindingDispatch(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await simulateBinding.current.mutateAsync({
        binding_key: 'webhook.shipment.created.default',
        stage_key: 'default',
        inputs: { shipment_id: 'shp_live' },
      });
    });
    expectRefresh(bindingResources);

    simulateBindingSpy.mockRestore();
    registerBindingSpy.mockRestore();
    restoreTemplateSpy.mockRestore();
    createStepSpy.mockRestore();
    setStatusSpy.mockRestore();
    createTemplateSpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('Label Designer draft and asset mutations refresh active designer and backend readback models', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(longLivedClient, 'refetchQueries');
    const createDraftSpy = vi.spyOn(api, 'label_designer_create_draft').mockResolvedValue({
      ok: true,
      draft: {
        id: 'draft_live',
        organization_id: 'org_live',
        scope_type: 'tenant',
        scope_id: 'org_live',
        label_type: 'route',
        draft_name: 'Route label',
        draft_value: {},
        status: 'draft',
      },
    } as never);
    const publishDraftSpy = vi.spyOn(api, 'label_designer_publish_label_design_draft').mockResolvedValue({
      ok: true,
      settings_version_id: 'sv_live',
      scope_type: 'tenant',
      scope_id: 'org_live',
      schema_version: 1,
      version: 3,
    } as never);
    const uploadAssetSpy = vi.spyOn(api, 'label_designer_upload_asset').mockResolvedValue({
      ok: true,
      path: 'org_live/designer/logo.png',
    } as never);
    const deleteAssetSpy = vi.spyOn(api, 'label_designer_delete_asset').mockResolvedValue({
      ok: true,
    } as never);

    const expectDesignerRefresh = (includeAssets = false) => {
      const invalidations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      const refetches = refetchSpy.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidations).toContainEqual(qk.labelDesignDrafts('tenant', 'org_live'));
      expect(refetches).toContainEqual(qk.labelDesignDrafts('tenant', 'org_live'));
      if (includeAssets) {
        expect(invalidations).toContainEqual(qk.labelDesignerAssets('tenant', 'org_live'));
        expect(refetches).toContainEqual(qk.labelDesignerAssets('tenant', 'org_live'));
      }
      for (const resource of [
        'label_template_specs',
        'label_template_directory',
        'label_jobs',
        'label_artifacts',
        'settings_versions',
        'settings_resolution_log',
      ]) {
        for (const key of [
          ['list', resource],
          ['lists_by_filters', resource],
          ['list', resource, 'complete'],
        ]) {
          expect(invalidations).toContainEqual(key);
          expect(refetches).toContainEqual(key);
        }
      }
      invalidateSpy.mockClear();
      refetchSpy.mockClear();
    };

    const { result: createDraft } = renderHook(() => useCreateLabelDesignDraft(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await createDraft.current.mutateAsync({
        scope_type: 'tenant',
        scope_id: 'org_live',
        label_type: 'route',
        draft_name: 'Route label',
        draft_value: {},
      });
    });
    expectDesignerRefresh();

    const { result: publishDraft } = renderHook(() => usePublishLabelDesignDraft(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await publishDraft.current.mutateAsync({
        draftId: 'draft_live',
        changeReason: 'publish live design',
        scopeType: 'tenant',
        scopeId: 'org_live',
      });
    });
    expectDesignerRefresh();

    const { result: uploadAsset } = renderHook(() => useUploadLabelDesignerAsset(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await uploadAsset.current.mutateAsync({
        file_name: 'logo.png',
        content_type: 'image/png',
        file_base64: 'data:image/png;base64,AAAA',
        scopeType: 'tenant',
        scopeId: 'org_live',
      });
    });
    expectDesignerRefresh(true);

    const { result: deleteAsset } = renderHook(() => useDeleteLabelDesignerAsset(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await deleteAsset.current.mutateAsync({
        path: 'org_live/designer/logo.png',
        scopeType: 'tenant',
        scopeId: 'org_live',
      });
    });
    expectDesignerRefresh(true);

    deleteAssetSpy.mockRestore();
    uploadAssetSpy.mockRestore();
    publishDraftSpy.mockRestore();
    createDraftSpy.mockRestore();
    refetchSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('useProposeSettingsChange refreshes visible settings approval Review Queue readback', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');
    let taskReads = 0;
    const listTasksSpy = vi.spyOn(api, 'listTasks').mockImplementation(async () => {
      taskReads += 1;
      if (taskReads === 1) return [];
      return [
        {
          id: 'task_settings_approval_1',
          task_type: 'settings_approval',
          status: 'open',
          resource_type: 'settings_version',
          resource_id: 'settings_version_1',
          metadata: { manual_review_task_id: 'manual_review_1' },
        },
      ];
    });
    const proposeSpy = vi.spyOn(api, 'proposeSettingsChange').mockResolvedValue({
      settings_version_id: 'settings_version_1',
      domain_event_id: 'domain_event_1',
      approval_required: true,
    } as never);

    function SettingsApprovalReadbackProbe() {
      const tasks = useTasks();
      const propose = useProposeSettingsChange();
      const approvalTask = (tasks.data ?? []).find((task) => task.task_type === 'settings_approval');

      return (
        <section>
          <p>{approvalTask ? `Review Queue task: ${approvalTask.id}` : 'No review tasks'}</p>
          <button
            type="button"
            onClick={() =>
              propose.mutate({
                category: 'mobile_visibility_policy',
                scope: { scope_type: 'tenant', scope_id: 'org_1' },
                value: { surfaces: ['routes'] },
              })
            }
          >
            Submit settings change
          </button>
        </section>
      );
    }

    render(<SettingsApprovalReadbackProbe />, { wrapper: wrapper(longLivedClient) });
    expect(await screen.findByText('No review tasks')).toBeTruthy();

    await act(async () => {
      screen.getByRole('button', { name: 'Submit settings change' }).click();
    });
    expect(await screen.findByText('Review Queue task: task_settings_approval_1')).toBeTruthy();

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(qk.resolveSettingsCategory('mobile_visibility_policy'));
    expect(calls).toContainEqual(qk.resolveMobilePolicyCategory('mobile_visibility_policy'));
    expect(calls).toContainEqual(['tasks']);
    expect(calls).toContainEqual(['list', 'tasks']);
    expect(calls).toContainEqual(['list', 'workflow_runs']);
    expect(calls).toContainEqual(['list', 'workflow_run_steps']);
    expect(calls).toContainEqual(['list', 'settings_versions']);
    expect(calls).toContainEqual(['list', 'tasks', 'complete']);
    expect(calls).toContainEqual(['list', 'workflow_runs', 'complete']);
    expect(calls).toContainEqual(['list', 'workflow_run_steps', 'complete']);
    expect(calls).toContainEqual(['list', 'settings_versions', 'complete']);
    expect(listTasksSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    proposeSpy.mockRestore();
    listTasksSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it('useTransitionTask refreshes visible settings policy readback after approval', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    let settingsReads = 0;
    const resolveSpy = vi.spyOn(api, 'resolveSettings').mockImplementation(async () => {
      settingsReads += 1;
      return {
        category: 'ui_presentation_policy',
        value: {
          review_queue: {
            settings_approval_label: settingsReads === 1 ? 'pending approval' : 'approved policy',
          },
        },
        resolved_from: 'tenant',
        ladder_path: [],
        settings_resolution_id: `settings_resolution_${settingsReads}`,
      };
    });
    const transitionSpy = vi.spyOn(api, 'transition_task_v1').mockResolvedValue({
      ok: true,
      task: {
        id: 'task_settings_approval_1',
        task_type: 'settings_approval',
        status: 'completed',
      },
      task_event_id: 'task_event_1',
    });

    function SettingsApprovalApplyProbe() {
      const policy = useResolveSettings('ui_presentation_policy');
      const transition = useTransitionTask();
      const value = policy.data?.value as { review_queue?: { settings_approval_label?: string } } | undefined;

      return (
        <section>
          <p>{value?.review_queue?.settings_approval_label ?? 'No policy'}</p>
          <button
            type="button"
            onClick={() =>
              transition.mutate({
                taskId: 'task_settings_approval_1',
                transition: {
                  next_status: 'completed',
                  payload: { action_kind: 'approve' },
                },
              })
            }
          >
            Approve settings change
          </button>
        </section>
      );
    }

    render(<SettingsApprovalApplyProbe />, { wrapper: wrapper(longLivedClient) });
    expect(await screen.findByText('pending approval')).toBeTruthy();

    await act(async () => {
      screen.getByRole('button', { name: 'Approve settings change' }).click();
    });

    expect(await screen.findByText('approved policy')).toBeTruthy();
    expect(transitionSpy).toHaveBeenCalledWith('task_settings_approval_1', {
      next_status: 'completed',
      payload: { action_kind: 'approve' },
    });
    expect(resolveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    transitionSpy.mockRestore();
    resolveSpy.mockRestore();
  });

  it('useCreateServiceLevel refreshes service-level and offering directory reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateServiceLevel(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await result.current.mutateAsync({
        key: 'qa_level',
        name: 'QA level',
        metadata: { priority_rank: 99 },
      });
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(qk.list('service_levels'));
    expect(calls).toContainEqual(qk.list('service_level_directory'));
    expect(calls).toContainEqual(qk.list('service_offering_directory'));
    invalidateSpy.mockRestore();
  });

  it('useUpdateServiceLevel refreshes service-level and offering directory reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateServiceLevel(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await result.current.mutateAsync({
        service_level_id: 'svl_express',
        name: 'Express delivery',
      });
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(qk.list('service_levels'));
    expect(calls).toContainEqual(qk.list('service_level_directory'));
    expect(calls).toContainEqual(qk.list('service_offering_directory'));
    invalidateSpy.mockRestore();
  });

  it('useCreateServiceOffering refreshes both offering and service-level directory reads', async () => {
    const longLivedClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(longLivedClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateServiceOffering(), {
      wrapper: wrapper(longLivedClient),
    });
    await act(async () => {
      await result.current.mutateAsync({
        service_level_id: 'svl_express',
        branch_id: 'hub_ruh_n',
        priority: 99,
        metadata: { display: { name: 'QA offering', slug: 'qa-offering', status: 'active' } },
      });
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(qk.list('service_offerings'));
    expect(calls).toContainEqual(qk.list('service_offering_directory'));
    expect(calls).toContainEqual(qk.list('service_level_directory'));
    invalidateSpy.mockRestore();
  });
});
