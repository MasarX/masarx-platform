import "server-only";

import {
  createServerClient,
  getVerifiedAccessToken,
} from "@masarx/auth/server";
import { createRpc } from "./rpc";
import { normalizeUiScopeType } from "./scope-normalize";
import { attachMarketplaceClient } from "./marketplace-client";
import {
  requestAccessPolicyChangeWithCompat,
  requestSettingsChangeWithCompat,
} from "./settings-change-compat";
import { cache } from "react";
import type {
  UiAccessPolicy,
  UiCommandRegistry,
  UiDashboardConfig,
  UiDashboardMetrics,
  UiFilterOperators,
  UiRelatedResources,
  UiManualReviewTask,
  UiMe,
  UiOnboardingReadiness,
  UiNavigation,
  UiReadRegistry,
  UiResourceDetail,
  UiResourceList,
  UiResourceMetrics,
  UiSettingsPreview,
  UiShipmentPodAsset,
  UiShipmentTimeline,
  UiSort,
  UiTableViews,
  UiTrackingRegistry,
  UiTrace,
  UiWorkflowRunProgress,
  UiWorkflowRunOutputStatus,
} from "./index";

type CacheKeyValue = unknown;

function stableKey(value: CacheKeyValue): CacheKeyValue {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => stableKey(entry));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    keys.forEach((key) => {
      out[key] = stableKey(record[key]);
    });
    return out;
  }
  return value;
}

function stableStringify(value: CacheKeyValue) {
  return JSON.stringify(stableKey(value));
}

function buildCacheKey(fn: string, args?: Record<string, unknown> | null) {
  return `${fn}:${args ? stableStringify(args) : ""}`;
}

const getUiServerClient = cache(() => {
  const accessTokenPromise = getVerifiedAccessToken({
    allowCookieSet: false,
  })
    .then((result) => result.accessToken ?? null)
    .catch(() => null);
  const rpc = async <T>(fn: string, args?: Record<string, unknown>) => {
    const accessToken = await accessTokenPromise;
    const client = accessToken
      ? createServerClient({ allowCookieSet: false, accessToken })
      : createServerClient({ allowCookieSet: false });
    const runner = createRpc(client);
    return runner<T>(fn, args);
  };
  const marketplace = attachMarketplaceClient(rpc);
  const memo = new Map<string, Promise<unknown>>();

  const memoize = <T,>(key: string, runner: () => Promise<T>) => {
    const cached = memo.get(key) as Promise<T> | undefined;
    if (cached) return cached;
    const promise = runner();
    memo.set(key, promise as Promise<unknown>);
    return promise;
  };

  const me = () =>
    memoize(buildCacheKey("ui_me_v1"), () => rpc<UiMe>("ui_me_v1"));
  const onboardingReadiness = (scopeType?: string | null, scopeId?: string | null) =>
    memoize(
      buildCacheKey("ui_get_onboarding_readiness_v1", {
        p_scope_type: normalizeUiScopeType(scopeType),
        p_scope_id: scopeId ?? null,
      }),
      () =>
        rpc<UiOnboardingReadiness>("ui_get_onboarding_readiness_v1", {
          p_scope_type: normalizeUiScopeType(scopeType),
          p_scope_id: scopeId ?? null,
        })
    );
  const navigation = (app: string) =>
    memoize(buildCacheKey("ui_navigation_v1", { p_app: app }), () =>
      rpc<UiNavigation>("ui_navigation_v1", { p_app: app })
    );
  const accessPolicy = (scopeType?: string | null, scopeId?: string | null) =>
    memoize(
      buildCacheKey("ui_access_policy_v1", {
        p_scope_type: normalizeUiScopeType(scopeType),
        p_scope_id: scopeId ?? null,
      }),
      () =>
        rpc<UiAccessPolicy>("ui_access_policy_v1", {
          p_scope_type: normalizeUiScopeType(scopeType),
          p_scope_id: scopeId ?? null,
        })
    );
  const settingsPreview = (params: {
    category: string;
    scopeType?: string | null;
    scopeId?: string | null;
  }) =>
    memoize(
      buildCacheKey("ui_settings_preview_v1", {
        p_category: params.category,
        p_scope_type: normalizeUiScopeType(params.scopeType),
        p_scope_id: params.scopeId ?? null,
      }),
      () =>
        rpc<UiSettingsPreview>("ui_settings_preview_v1", {
          p_category: params.category,
          p_scope_type: normalizeUiScopeType(params.scopeType),
          p_scope_id: params.scopeId ?? null,
        })
    );
  const readRegistry = () =>
    memoize(buildCacheKey("ui_read_registry_v1"), () =>
      rpc<UiReadRegistry>("ui_read_registry_v1")
    );
  const commandRegistry = () =>
    memoize(buildCacheKey("ui_command_registry_v1"), () =>
      rpc<UiCommandRegistry>("ui_command_registry_v1")
    );
  const trackingRegistry = () =>
    memoize(buildCacheKey("ui_tracking_registry_v1"), () =>
      rpc<UiTrackingRegistry>("ui_tracking_registry_v1")
    );
  const dashboardConfig = () =>
    memoize(buildCacheKey("ui_dashboard_config_v1"), () =>
      rpc<UiDashboardConfig>("ui_dashboard_config_v1")
    );
  const dashboardMetrics = (resources: string[]) =>
    memoize(buildCacheKey("ui_dashboard_metrics_v1", { p_resources: resources }), () =>
      rpc<UiDashboardMetrics>("ui_dashboard_metrics_v1", { p_resources: resources })
    );
  const filterOperators = () =>
    memoize(buildCacheKey("ui_filter_operators_v1"), () =>
      rpc<UiFilterOperators>("ui_filter_operators_v1")
    );
  const relatedResources = (resource: string, limit?: number | null) =>
    memoize(
      buildCacheKey("ui_related_resources_v1", {
        p_resource: resource,
        p_limit: limit ?? null,
      }),
      () =>
        rpc<UiRelatedResources>("ui_related_resources_v1", {
          p_resource: resource,
          p_limit: limit ?? null,
        })
    );
  const tableViews = (
    resource: string,
    scopeType?: string | null,
    scopeId?: string | null
  ) =>
    memoize(
      buildCacheKey("ui_table_views_v1", {
        p_resource: resource,
        p_scope_type: normalizeUiScopeType(scopeType),
        p_scope_id: scopeId ?? null,
      }),
      () =>
        rpc<UiTableViews>("ui_table_views_v1", {
          p_resource: resource,
          p_scope_type: normalizeUiScopeType(scopeType),
          p_scope_id: scopeId ?? null,
        })
    );
  const listResource = (
    resource: string,
    filters?: Record<string, unknown>,
    limit: number = 50,
    offset: number = 0,
    sort?: UiSort | null
  ) =>
    memoize(
      buildCacheKey("ui_list_resource_v1", {
        p_resource: resource,
        p_filters: filters ?? {},
        p_limit: limit,
        p_offset: offset,
        p_sort: sort ?? null,
      }),
      () =>
        rpc<UiResourceList>("ui_list_resource_v1", {
          p_resource: resource,
          p_filters: filters ?? {},
          p_limit: limit,
          p_offset: offset,
          p_sort: sort ?? null,
        })
    );
  const resourceMetrics = (
    resource: string,
    filters?: Record<string, unknown>,
    columns?: string[] | null
  ) =>
    memoize(
      buildCacheKey("ui_resource_metrics_v1", {
        p_resource: resource,
        p_filters: filters ?? {},
        p_columns: columns ?? null,
      }),
      () =>
        rpc<UiResourceMetrics>("ui_resource_metrics_v1", {
          p_resource: resource,
          p_filters: filters ?? {},
          p_columns: columns ?? null,
        })
    );
  const getResource = (resource: string, id: string) =>
    memoize(buildCacheKey("ui_get_resource_v1", { p_resource: resource, p_id: id }), () =>
      rpc<UiResourceDetail>("ui_get_resource_v1", { p_resource: resource, p_id: id })
    );
  const getWorkflowRunOutputStatus = (
    workflowRunId: string,
    outputUrlPaths?: string[] | null
  ) =>
    memoize(
      buildCacheKey("ui_get_workflow_run_output_status_v1", {
        p_workflow_run_id: workflowRunId,
        p_output_url_paths: outputUrlPaths ?? null,
      }),
      () =>
        rpc<UiWorkflowRunOutputStatus>("ui_get_workflow_run_output_status_v1", {
          p_workflow_run_id: workflowRunId,
          p_output_url_paths: outputUrlPaths ?? null,
        })
    );
  const getOnboardingReadiness = (
    scopeType?: string | null,
    scopeId?: string | null
  ) =>
    memoize(
      buildCacheKey("ui_get_onboarding_readiness_v1", {
        p_scope_type: normalizeUiScopeType(scopeType),
        p_scope_id: scopeId ?? null,
      }),
      () =>
        rpc<UiOnboardingReadiness>("ui_get_onboarding_readiness_v1", {
          p_scope_type: normalizeUiScopeType(scopeType),
          p_scope_id: scopeId ?? null,
        })
    );
  const progressWorkflowRunUntilWait = (
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
    });
  const getTrace = (correlationId: string) =>
    memoize(
      buildCacheKey("ui_get_trace_v1", { p_correlation_id: correlationId }),
      () => rpc<UiTrace>("ui_get_trace_v1", { p_correlation_id: correlationId })
    );
  const getShipmentTimeline = (shipmentId: string) =>
    memoize(
      buildCacheKey("ui_get_shipment_timeline_v1", { p_shipment_id: shipmentId }),
      () =>
        rpc<UiShipmentTimeline>("ui_get_shipment_timeline_v1", {
          p_shipment_id: shipmentId,
        })
    );
  const getShipmentPodAssets = (shipmentId: string) =>
    memoize(
      buildCacheKey("ui_list_shipment_pod_assets_v1", { p_shipment_id: shipmentId }),
      () =>
        rpc<UiShipmentPodAsset[]>("ui_list_shipment_pod_assets_v1", {
          p_shipment_id: shipmentId,
        })
    );

  return {
    rpc,
    me,
    onboardingReadiness,
    navigation,
    accessPolicy,
    settingsPreview,
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
    readRegistry,
    commandRegistry,
    trackingRegistry,
    dashboardConfig,
    dashboardMetrics,
    filterOperators,
    relatedResources,
    tableViews,
    listResource,
    resourceMetrics,
    getResource,
    getWorkflowRunOutputStatus,
    getOnboardingReadiness,
    progressWorkflowRunUntilWait,
    getTrace,
    getShipmentTimeline,
    getShipmentPodAssets,
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
      const [meValue, navigationValue] = await Promise.all([
        me(),
        navigation(app),
      ]);
      return { me: meValue, navigation: navigationValue };
    },
    ...marketplace,
  };
});

export function createUiServerClient() {
  return getUiServerClient();
}
