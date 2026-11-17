import type { SupabaseClient } from "@supabase/supabase-js";
import { createRpc } from "./rpc";
import { normalizeUiScopeType } from "./scope-normalize";
import { attachMarketplaceClient } from "./marketplace-client";
import {
  requestAccessPolicyChangeWithCompat,
  requestSettingsChangeWithCompat,
} from "./settings-change-compat";
import type {
  UiAccessPolicy,
  UiCommandRegistry,
  UiDashboardConfig,
  UiDashboardMetrics,
  UiFilterOperators,
  UiManualReviewTask,
  UiMe,
  UiOnboardingReadiness,
  UiNavigation,
  UiReadRegistry,
  UiRelatedResources,
  UiResourceDetail,
  UiResourceList,
  UiResourceMetrics,
  UiResourceReorderResult,
  UiSettingsPreview,
  UiShipmentPodAsset,
  UiShipmentTimeline,
  UiSort,
  UiTableViews,
  MappingStudioResponse,
  UiTrackingRegistry,
  UiTrace,
  UiWorkflowRunProgress,
  UiWorkflowRunOutputStatus,
  UiStartWorkflowRunResult,
  UiCreateShipmentResult,
  UiCreateWarehouseTransferManifestResult,
  UiExecuteWarehouseTransferCheckpointResult,
  UiExecuteWarehouseTransferDispatchResult,
  UiCreateWorkflowTemplateResult,
  UiCreateWorkflowTemplateStepResult,
  UiCreateWorkflowScheduleTriggerResult,
  UiCreateWorkflowRunTriggerResult,
  UiRunWorkflowScheduleTriggerResult,
  ResourceImportPrepareResponse,
  ResourceImportRun,
  ResourceImportStartResponse,
  ResourceImportCancelResponse,
} from "./index";
import { getPublicConfig } from "@masarx/config";

export function createUiClientFromSupabase(
  client: SupabaseClient<any, any, any, any, any>
) {
  const rpc = createRpc(client);
  const marketplace = attachMarketplaceClient(rpc);
  const invokeEdgeJson = async <T = Record<string, unknown>>(params: {
    functionName: string;
    action: string;
    payload?: Record<string, unknown>;
    body?: BodyInit;
    headers?: Record<string, string>;
  }) => {
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError || !sessionData?.session?.access_token) {
      throw sessionError ?? new Error("Authenticated session is required.");
    }
    const { supabaseUrl, supabaseAnonKey, supabaseFunctionsUrl } = getPublicConfig();
    const functionsBaseUrl =
      supabaseFunctionsUrl?.trim() ||
      `${supabaseUrl.replace(/\/+$/g, "")}/functions/v1`;
    const response = await fetch(
      `${functionsBaseUrl.replace(/\/+$/g, "")}/${params.functionName}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionData.session.access_token}`,
          apikey: supabaseAnonKey,
          ...(params.body instanceof FormData
            ? {}
            : { "content-type": "application/json" }),
          ...(params.headers ?? {}),
        },
        body:
          params.body ??
          JSON.stringify({
            ...(params.payload ?? {}),
            action: params.action,
          }),
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok && (!data || typeof data !== "object")) {
      throw new Error(`${params.functionName} ${params.action} failed with status ${response.status}`);
    }
    return (data ?? {}) as T;
  };
  const invokeMappingStudio = async (
    action: "parse" | "infer" | "preview" | "save",
    payload: Record<string, unknown>
  ) =>
    invokeEdgeJson<MappingStudioResponse>({
      functionName: "integration-plugin-studio",
      action,
      payload,
    });
  const invokeBrowserResourceImport = async <T = Record<string, unknown>>(params: {
    action: string;
    payload?: Record<string, unknown>;
    body?: BodyInit;
  }) => {
    const response = await fetch("/api/resource-import", {
      method: "POST",
      headers:
        params.body instanceof FormData
          ? undefined
          : { "content-type": "application/json" },
      body:
        params.body ??
        JSON.stringify({
          ...(params.payload ?? {}),
          action: params.action,
        }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : `resource import ${params.action} failed with status ${response.status}`;
      throw new Error(message);
    }
    return (data ?? {}) as T;
  };
  const invokeResourceImport = async <T = Record<string, unknown>>(params: {
    action: string;
    payload?: Record<string, unknown>;
    body?: BodyInit;
  }) => {
    if (typeof window !== "undefined") {
      return invokeBrowserResourceImport<T>(params);
    }
    return invokeEdgeJson<T>({
      functionName: "resource-import-studio",
      action: params.action,
      payload: params.payload,
      body: params.body,
    });
  };

  return {
    rpc,
    mappingStudio: {
      parse: (payload: Record<string, unknown>) => invokeMappingStudio("parse", payload),
      infer: (payload: Record<string, unknown>) => invokeMappingStudio("infer", payload),
      preview: (payload: Record<string, unknown>) => invokeMappingStudio("preview", payload),
      save: (payload: Record<string, unknown>) => invokeMappingStudio("save", payload),
    },
    resourceImports: {
      prepare: (payload: Record<string, unknown> | FormData) =>
        invokeResourceImport<ResourceImportPrepareResponse>({
          action: "prepare",
          ...(payload instanceof FormData
            ? {
                body: (() => {
                  payload.set("action", "prepare");
                  return payload;
                })(),
              }
            : { payload }),
        }),
      start: (payload: Record<string, unknown>) =>
        invokeResourceImport<ResourceImportStartResponse>({
          action: "start",
          payload,
        }),
      getRun: (payload: { runId: string }) =>
        invokeResourceImport<ResourceImportRun>({
          action: "get_run",
          payload: {
            run_id: payload.runId,
          },
        }),
      cancel: (payload: { runId: string }) =>
        invokeResourceImport<ResourceImportCancelResponse>({
          action: "cancel",
          payload: {
            run_id: payload.runId,
          },
        }),
    },
    me: () => rpc<UiMe>("ui_me_v1"),
    onboardingReadiness: (scopeType?: string | null, scopeId?: string | null) =>
      rpc<UiOnboardingReadiness>("ui_get_onboarding_readiness_v1", {
        p_scope_type: normalizeUiScopeType(scopeType),
        p_scope_id: scopeId ?? null,
      }),
    navigation: (app: string) =>
      rpc<UiNavigation>("ui_navigation_v1", { p_app: app }),
    accessPolicy: (scopeType?: string | null, scopeId?: string | null) =>
      rpc<UiAccessPolicy>("ui_access_policy_v1", {
        p_scope_type: normalizeUiScopeType(scopeType),
        p_scope_id: scopeId ?? null,
      }),
    settingsPreview: (params: {
      category: string;
      scopeType?: string | null;
      scopeId?: string | null;
    }) =>
      rpc<UiSettingsPreview>("ui_settings_preview_v1", {
        p_category: params.category,
        p_scope_type: normalizeUiScopeType(params.scopeType),
        p_scope_id: params.scopeId ?? null,
      }),
    requestAccessPolicyChange: (params: {
      scopeType?: string | null;
      scopeId?: string | null;
      value: unknown;
      changeReason?: string | null;
      effectiveFrom?: string | null;
    }) =>
      requestAccessPolicyChangeWithCompat(rpc, params),
    requestSettingsChange: (params: {
      category: string;
      scopeType?: string | null;
      scopeId?: string | null;
      value: unknown;
      changeReason?: string | null;
      effectiveFrom?: string | null;
    }) =>
      requestSettingsChangeWithCompat(rpc, params),
    readRegistry: () => rpc<UiReadRegistry>("ui_read_registry_v1"),
    commandRegistry: () => rpc<UiCommandRegistry>("ui_command_registry_v1"),
    trackingRegistry: () => rpc<UiTrackingRegistry>("ui_tracking_registry_v1"),
    dashboardConfig: () => rpc<UiDashboardConfig>("ui_dashboard_config_v1"),
    dashboardMetrics: (resources: string[]) =>
      rpc<UiDashboardMetrics>("ui_dashboard_metrics_v1", {
        p_resources: resources,
      }),
    filterOperators: () => rpc<UiFilterOperators>("ui_filter_operators_v1"),
    filterDistinctValues: (params: {
      resource: string;
      filterKey: string;
      query?: string | null;
      limit?: number | null;
    }) =>
      rpc<string[]>("ui_filter_distinct_values_v1", {
        p_resource: params.resource,
        p_filter_key: params.filterKey,
        p_query: params.query ?? null,
        p_limit: params.limit ?? 25,
      }),
    relatedResources: (resource: string, limit?: number | null) =>
      rpc<UiRelatedResources>("ui_related_resources_v1", {
        p_resource: resource,
        p_limit: limit ?? null,
      }),
    tableViews: (
      resource: string,
      scopeType?: string | null,
      scopeId?: string | null
    ) =>
      rpc<UiTableViews>("ui_table_views_v1", {
        p_resource: resource,
        p_scope_type: normalizeUiScopeType(scopeType),
        p_scope_id: scopeId ?? null,
      }),
    listResource: (
      resource: string,
      filters?: Record<string, unknown>,
      limit: number = 50,
      offset: number = 0,
      sort?: UiSort | null
    ) =>
      rpc<UiResourceList>("ui_list_resource_v1", {
        p_resource: resource,
        p_filters: filters ?? {},
        p_limit: limit,
        p_offset: offset,
        p_sort: sort ?? null,
      }),
    resourceMetrics: (
      resource: string,
      filters?: Record<string, unknown>,
      columns?: string[] | null
    ) =>
      rpc<UiResourceMetrics>("ui_resource_metrics_v1", {
        p_resource: resource,
        p_filters: filters ?? {},
        p_columns: columns ?? null,
      }),
    updateResource: (params: {
      resource: string;
      id: string;
      patch: Record<string, unknown>;
    }) =>
      rpc<UiResourceDetail>("ui_update_resource_v1", {
        p_resource: params.resource,
        p_id: params.id,
        p_patch: params.patch,
      }),
    reorderResource: (params: { resource: string; ids: string[] }) =>
      rpc<UiResourceReorderResult>("ui_reorder_resource_v1", {
        p_resource: params.resource,
        p_ids: params.ids,
      }),
    startWorkflowRun: (params: {
      workflowTemplateId: string;
      payload?: unknown;
      requireActive?: boolean | null;
    }) =>
      rpc<UiStartWorkflowRunResult>("ui_start_workflow_run_v1", {
        p_workflow_template_id: params.workflowTemplateId,
        p_payload: params.payload ?? {},
        p_require_active: params.requireActive ?? true,
      }),
    createWorkflowTemplate: (params: {
      name: string;
      description?: string | null;
      cloneFrom?: string | null;
    }) =>
      rpc<UiCreateWorkflowTemplateResult>("ui_create_workflow_template_v1", {
        p_name: params.name,
        p_description: params.description ?? null,
        p_clone_from: params.cloneFrom ?? null,
      }),
    createShipment: (params: {
      clientId?: string | null;
      senderId?: string | null;
      serviceType?: string | null;
      trackingNumber?: string | null;
      clientReferenceNumber?: string | null;
      carrierReferenceNumber?: string | null;
      status?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<UiCreateShipmentResult>("ui_create_shipment_v1", {
        p_client_id: params.clientId ?? null,
        p_sender_id: params.senderId ?? null,
        p_service_type: params.serviceType ?? null,
        p_tracking_number: params.trackingNumber ?? null,
        p_client_reference_number: params.clientReferenceNumber ?? null,
        p_carrier_reference_number: params.carrierReferenceNumber ?? null,
        p_status: params.status ?? null,
        p_metadata: params.metadata ?? {},
      }),
    createWarehouseTransferManifest: (params: {
      organizationId?: string | null;
      transferCode: string;
      fromBranchId: string;
      toBranchId: string;
      shipmentIds: string[];
      plannedDispatchAt?: string | null;
      plannedReceiveAt?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<UiCreateWarehouseTransferManifestResult>(
        "create_warehouse_transfer_manifest_v1",
        {
          p_input: {
            organization_id: params.organizationId ?? null,
            transfer_code: params.transferCode,
            from_branch_id: params.fromBranchId,
            to_branch_id: params.toBranchId,
            shipment_ids: params.shipmentIds,
            planned_dispatch_at: params.plannedDispatchAt ?? null,
            planned_receive_at: params.plannedReceiveAt ?? null,
            metadata: params.metadata ?? {},
          },
        }
      ),
    dispatchWarehouseTransfer: (params: {
      transferId: string;
      actionKey?: string | null;
      resourceKey?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<UiExecuteWarehouseTransferDispatchResult>(
        "ui_execute_warehouse_transfer_dispatch_v1",
        {
          p_action_key: params.actionKey ?? "warehouse_transfers.dispatch",
          p_resource_key: params.resourceKey ?? "warehouse_transfers",
          p_selection_ids: [params.transferId],
          p_selection_id: params.transferId,
          p_selection_count: 1,
          p_params: params.metadata ?? {},
        }
      ),
    scanWarehouseTransferDeparture: (params: {
      transferId: string;
      barcode: string;
      handlingUnitCode?: string | null;
      deviceId?: string | null;
      opsSessionId?: string | null;
      notes?: string | null;
      actionKey?: string | null;
      resourceKey?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<UiExecuteWarehouseTransferCheckpointResult>(
        "ui_execute_warehouse_transfer_checkpoint_v1",
        {
          p_action_key: params.actionKey ?? "warehouse_transfers.scan_departure",
          p_resource_key: params.resourceKey ?? "warehouse_transfers",
          p_selection_ids: [params.transferId],
          p_selection_id: params.transferId,
          p_selection_count: 1,
          p_params: {
            barcode: params.barcode,
            handling_unit_code: params.handlingUnitCode ?? null,
            device_id: params.deviceId ?? null,
            ops_session_id: params.opsSessionId ?? null,
            notes: params.notes ?? null,
            metadata: params.metadata ?? {},
          },
        }
      ),
    scanWarehouseTransferArrival: (params: {
      transferId: string;
      barcode: string;
      handlingUnitCode?: string | null;
      deviceId?: string | null;
      opsSessionId?: string | null;
      notes?: string | null;
      actionKey?: string | null;
      resourceKey?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<UiExecuteWarehouseTransferCheckpointResult>(
        "ui_execute_warehouse_transfer_checkpoint_v1",
        {
          p_action_key: params.actionKey ?? "warehouse_transfers.scan_arrival",
          p_resource_key: params.resourceKey ?? "warehouse_transfers",
          p_selection_ids: [params.transferId],
          p_selection_id: params.transferId,
          p_selection_count: 1,
          p_params: {
            barcode: params.barcode,
            handling_unit_code: params.handlingUnitCode ?? null,
            device_id: params.deviceId ?? null,
            ops_session_id: params.opsSessionId ?? null,
            notes: params.notes ?? null,
            metadata: params.metadata ?? {},
          },
        }
      ),
    createWorkflowTemplateStep: (params: {
      workflowTemplateId: string;
      step: Record<string, unknown>;
    }) =>
      rpc<UiCreateWorkflowTemplateStepResult>(
        "ui_create_workflow_template_step_v1",
        {
          p_workflow_template_id: params.workflowTemplateId,
          p_step: params.step,
        }
      ),
    createWorkflowScheduleTrigger: (params: {
      workflowTemplateId: string;
      schedule: Record<string, unknown>;
      contextPatch?: Record<string, unknown> | null;
      enabled?: boolean | null;
      notes?: string | null;
    }) =>
      rpc<UiCreateWorkflowScheduleTriggerResult>(
        "ui_create_workflow_schedule_trigger_v1",
        {
          p_workflow_template_id: params.workflowTemplateId,
          p_schedule: params.schedule,
          p_context_patch: params.contextPatch ?? {},
          p_enabled: params.enabled ?? true,
          p_notes: params.notes ?? null,
        }
      ),
    createWorkflowRunTrigger: (params: {
      sourceWorkflowTemplateId: string;
      targetWorkflowTemplateId: string;
      sourceStatuses?: string[] | null;
      contextPatch?: Record<string, unknown> | null;
      enabled?: boolean | null;
      notes?: string | null;
    }) =>
      rpc<UiCreateWorkflowRunTriggerResult>("ui_create_workflow_run_trigger_v1", {
        p_source_workflow_template_id: params.sourceWorkflowTemplateId,
        p_target_workflow_template_id: params.targetWorkflowTemplateId,
        p_source_statuses: params.sourceStatuses ?? null,
        p_context_patch: params.contextPatch ?? null,
        p_enabled: params.enabled ?? null,
        p_notes: params.notes ?? null,
      }),
    runWorkflowScheduleTrigger: (workflowScheduleTriggerId: string) =>
      rpc<UiRunWorkflowScheduleTriggerResult>(
        "ui_run_workflow_schedule_trigger_v1",
        { p_workflow_schedule_trigger_id: workflowScheduleTriggerId }
      ),
    getResource: (resource: string, id: string) =>
      rpc<UiResourceDetail>("ui_get_resource_v1", { p_resource: resource, p_id: id }),
    getWorkflowRunOutputStatus: (
      workflowRunId: string,
      outputUrlPaths?: string[] | null
    ) =>
      rpc<UiWorkflowRunOutputStatus>("ui_get_workflow_run_output_status_v1", {
        p_workflow_run_id: workflowRunId,
        p_output_url_paths: outputUrlPaths ?? null,
      }),
    getOnboardingReadiness: (
      scopeType?: string | null,
      scopeId?: string | null
    ) =>
      rpc<UiOnboardingReadiness>("ui_get_onboarding_readiness_v1", {
        p_scope_type: normalizeUiScopeType(scopeType),
        p_scope_id: scopeId ?? null,
      }),
    progressWorkflowRunUntilWait: (
      workflowRunId: string,
      options?: {
        operationResult?: Record<string, unknown> | null;
        budgetMs?: number | null;
        maxSteps?: number | null;
      } | null
    ) =>
      rpc<UiWorkflowRunProgress>("progress_workflow_run_until_wait_v1", {
        p_workflow_run_id: workflowRunId,
        p_operation_result: options?.operationResult ?? {},
        p_budget_ms: options?.budgetMs ?? null,
        p_max_steps: options?.maxSteps ?? null,
      }),
    getTrace: (correlationId: string) =>
      rpc<UiTrace>("ui_get_trace_v1", { p_correlation_id: correlationId }),
    getShipmentTimeline: (shipmentId: string) =>
      rpc<UiShipmentTimeline>("ui_get_shipment_timeline_v1", {
        p_shipment_id: shipmentId,
      }),
    getShipmentPodAssets: (shipmentId: string) =>
      rpc<UiShipmentPodAsset[]>("ui_list_shipment_pod_assets_v1", {
        p_shipment_id: shipmentId,
      }),
    resolveManualReviewTask: (
      taskId: string,
      outcome: string,
      notes?: string | null
    ) =>
      rpc<UiManualReviewTask>("resolve_manual_review_task_v1", {
        p_task_id: taskId,
        p_resolution_outcome: outcome,
        p_resolution_notes: notes ?? null,
      }),
    context: async (app: string) => {
      const [me, navigation] = await Promise.all([
        rpc<UiMe>("ui_me_v1"),
        rpc<UiNavigation>("ui_navigation_v1", { p_app: app }),
      ]);
      return { me, navigation };
    },
    ...marketplace,
  };
}
