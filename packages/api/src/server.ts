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
  UiAutomationMarketplaceListingResult,
  UiAutomationMarketplaceInstallResult,
  UiAutomationMarketplaceUpgradePreview,
  UiIntegrationConnectionResult,
  UiIntegrationConnectionBindingResult,
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
  const rpc = async <T>(fn: string, args?: Record<string, unknown>, options?: { retries?: 0; reportUnconfirmed?: true }) => {
    const accessToken = await accessTokenPromise;
    const client = accessToken
      ? createServerClient({ allowCookieSet: false, accessToken })
      : createServerClient({ allowCookieSet: false });
    const runner = createRpc(client);
    return options ? runner<T>(fn, args, options) : runner<T>(fn, args);
  };
  const marketplace = attachMarketplaceClient(rpc);
  const memo = new Map<string, Promise<unknown>>();
  const mutate = async <T,>(fn: string, args: Record<string, unknown>) => {
    try { return await rpc<T>(fn, args, { retries: 0, reportUnconfirmed: true }); } finally { memo.clear(); }
  };

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
  const publicTrackingConfig = () =>
    memoize(buildCacheKey("public_tracking_config_v1"), () =>
      rpc<UiTrackingRegistry>("public_tracking_config_v1")
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

  const previewAutomationAssetUpgrade = (
    installId: string,
    targetListingVersionId?: string | null
  ) =>
    memoize(
      buildCacheKey("automation_asset_upgrade_preview_v1", {
        p_install_id: installId,
        p_target_listing_version_id: targetListingVersionId ?? null,
      }),
      () =>
        rpc<UiAutomationMarketplaceUpgradePreview>(
          "automation_asset_upgrade_preview_v1",
          {
            p_install_id: installId,
            p_target_listing_version_id: targetListingVersionId ?? null,
          }
        )
    );

  return {
    rpc,
    me,
    onboardingReadiness,
    navigation,
    accessPolicy,
    settingsPreview,
    mapPolicy: async (context: Record<string, unknown>) => {
      const rows = await rpc<Array<{ settings_id: string; settings_version_id: string; scope_type: string; scope_id: string | null; value: unknown; version: number; scope_path: unknown }>>("resolve_map_policy", { p_context: context });
      if (!Array.isArray(rows) || rows.length > 1) throw new Error("Invalid map policy resolution");
      if (rows.length === 0) return null;
      const row = rows[0];
      if (!row || typeof row !== "object" || Array.isArray(row)
        || typeof row.settings_id !== "string" || !row.settings_id.trim()
        || typeof row.settings_version_id !== "string" || !row.settings_version_id.trim()
        || typeof row.scope_type !== "string" || !row.scope_type.trim()
        || !(row.scope_id === null || (typeof row.scope_id === "string" && row.scope_id.trim()))
        || !row.value || typeof row.value !== "object" || Array.isArray(row.value)
        || !Number.isInteger(row.version) || row.version < 1
        || !Array.isArray(row.scope_path)) throw new Error("Invalid map policy resolution");
      return row;
    },
    labelRendererReadiness: (organizationId: string) =>
      rpc<{ configured: boolean }>("ui_label_renderer_readiness_v1", { p_organization_id: organizationId }),
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
    publicTrackingConfig,
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
    createAutomationAssetListing: (params: {
      listingId?: string | null;
      assetKind: string;
      sourceId: string;
      title?: string | null;
      summary?: string | null;
      visibility?: string | null;
      manifest?: Record<string, unknown> | null;
      docs?: Record<string, unknown> | null;
      metadata?: Record<string, unknown> | null;
      notes?: string | null;
    }) =>
      mutate<UiAutomationMarketplaceListingResult>("automation_asset_create_listing_v1", {
        p_listing_id: params.listingId ?? null,
        p_asset_kind: params.assetKind,
        p_source_id: params.sourceId,
        p_title: params.title ?? null,
        p_summary: params.summary ?? null,
        p_visibility: params.visibility ?? "private",
        p_manifest: params.manifest ?? {},
        p_docs: params.docs ?? {},
        p_metadata: params.metadata ?? {},
        p_notes: params.notes ?? null,
      }),
    publishAutomationAssetVersion: (params: {
      listingVersionId: string;
      visibility?: string | null;
    }) =>
      mutate<UiAutomationMarketplaceListingResult>("automation_asset_publish_version_v1", {
        p_listing_version_id: params.listingVersionId,
        p_visibility: params.visibility ?? "private",
      }),
    submitAutomationAssetReview: (params: {
      listingVersionId: string;
      submissionNotes?: string | null;
    }) =>
      mutate<UiAutomationMarketplaceListingResult>("automation_asset_submit_review_v1", {
        p_listing_version_id: params.listingVersionId,
        p_submission_notes: params.submissionNotes ?? null,
      }),
    decideAutomationAssetReview: (params: {
      reviewId: string;
      decision: string;
      decisionNotes?: string | null;
    }) =>
      mutate<UiAutomationMarketplaceListingResult>("automation_asset_review_decide_v1", {
        p_review_id: params.reviewId,
        p_decision: params.decision,
        p_decision_notes: params.decisionNotes ?? null,
      }),
    installAutomationAsset: (params: {
      listingVersionId: string;
      targetScopeType: string;
      targetScopeId: string;
      variableValues?: Record<string, unknown> | null;
      connectionBindings?: Record<string, unknown> | null;
      activate?: boolean | null;
    }) =>
      mutate<UiAutomationMarketplaceInstallResult>("automation_asset_install_v1", {
        p_listing_version_id: params.listingVersionId,
        p_target_scope_type: normalizeUiScopeType(params.targetScopeType),
        p_target_scope_id: params.targetScopeId,
        p_variable_values: params.variableValues ?? {},
        p_connection_bindings: params.connectionBindings ?? {},
        p_activate: params.activate ?? false,
      }),
    previewAutomationAssetUpgrade,
    applyAutomationAssetUpgrade: (params: {
      installId: string;
      targetListingVersionId?: string | null;
    }) =>
      mutate<UiAutomationMarketplaceInstallResult>("automation_asset_upgrade_apply_v1", {
        p_install_id: params.installId,
        p_target_listing_version_id: params.targetListingVersionId ?? null,
      }),
    forkAutomationAssetInstall: (params: { installId: string; reason?: string | null }) =>
      mutate<UiAutomationMarketplaceInstallResult>("automation_asset_fork_v1", {
        p_install_id: params.installId,
        p_reason: params.reason ?? null,
      }),
    upsertIntegrationConnection: (params: {
      connectionId?: string | null;
      ownerScopeType?: string | null;
      ownerScopeId?: string | null;
      providerId?: string | null;
      providerKey?: string | null;
      name?: string | null;
      authType?: string | null;
      config?: Record<string, unknown> | null;
      oauthMetadata?: Record<string, unknown> | null;
      metadata?: Record<string, unknown> | null;
      secretPayload?: Record<string, unknown> | null;
      secretStorageMode?: string | null;
      generateSecret?: boolean | null;
      expiresAt?: string | null;
    }) =>
      mutate<UiIntegrationConnectionResult>("integration_connection_upsert_v1", {
        p_connection_id: params.connectionId ?? null,
        p_owner_scope_type: normalizeUiScopeType(params.ownerScopeType),
        p_owner_scope_id: params.ownerScopeId ?? null,
        p_provider_id: params.providerId ?? null,
        p_provider_key: params.providerKey ?? null,
        p_name: params.name ?? null,
        p_auth_type: params.authType ?? null,
        p_config: params.config ?? null,
        p_oauth_metadata: params.oauthMetadata ?? null,
        p_metadata: params.metadata ?? null,
        p_secret_payload: params.secretPayload ?? null,
        p_secret_storage_mode: params.secretStorageMode ?? null,
        p_generate_secret: params.generateSecret ?? false,
        p_expires_at: params.expiresAt ?? null,
      }),
    testIntegrationConnection: (connectionId: string) =>
      mutate<UiIntegrationConnectionResult>("integration_connection_test_v1", {
        p_connection_id: connectionId,
      }),
    rotateIntegrationConnection: (params: {
      connectionId: string;
      secretPayload?: Record<string, unknown> | null;
      generateSecret?: boolean | null;
      expiresAt?: string | null;
    }) =>
      mutate<UiIntegrationConnectionResult>("integration_connection_rotate_v1", {
        p_connection_id: params.connectionId,
        p_secret_payload: params.secretPayload ?? null,
        p_generate_secret: params.generateSecret ?? false,
        p_expires_at: params.expiresAt ?? null,
      }),
    revokeIntegrationConnection: (params: {
      connectionId: string;
      notes?: string | null;
    }) =>
      mutate<UiIntegrationConnectionResult>("integration_connection_revoke_v1", {
        p_connection_id: params.connectionId,
        p_notes: params.notes ?? null,
      }),
    bindIntegrationConnectionInstall: (params: {
      installId: string;
      bindingKey: string;
      connectionId: string;
      bindingType?: string | null;
      config?: Record<string, unknown> | null;
    }) =>
      mutate<UiIntegrationConnectionBindingResult>("integration_connection_bind_install_v1", {
        p_install_id: params.installId,
        p_binding_key: params.bindingKey,
        p_connection_id: params.connectionId,
        p_binding_type: params.bindingType ?? "connection",
        p_config: params.config ?? {},
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
