import { createBrowserClient } from "@masarx/auth/browser";
import { getPublicConfig } from "@masarx/config";
import { createUiClientFromSupabase } from "./ui-client";

export { normalizeUiScopeType } from "./scope-normalize";
export { normalizeUiScope } from "./scope-normalize";
export { isRetriableNetworkError, isRetriableSupabaseError } from "./retry";
export { WILDCARD_CAPABILITY, hasCapability, resolveCapabilitySet } from "./capabilities";
export { attachMarketplaceClient } from "./marketplace-client";
export type {
  MarketplaceContext,
  MarketplaceRequestKindCatalog,
  MarketplaceRequestKindCatalogEntry,
  MarketplaceRpcResult,
} from "./marketplace-types";
export {
  matchesResourceCategory,
  normalizeCommandRegistry,
  resolveResourceCommandCategory,
} from "./ui-command-registry";

export type UiScope = {
  scope_type: string;
  scope_id: string | null;
  scope_label?: string | null;
};

export type UiScopeOption = {
  scope_type: string;
  scope_id: string;
  scope_label?: string | null;
  href?: string | null;
};

export type UiUser = {
  id: string;
  email?: string | null;
  name?: string | null;
  user_type?: string | null;
};

export type UiMe = {
  user: UiUser;
  org?: { id: string; name?: string | null } | null;
  access_scope?: UiScope | null;
  locale?: string | null;
  timezone?: string | null;
  capabilities?: string[] | null;
  settings_resolution_id?: string | null;
};

export type UiOnboardingReadinessFinding = {
  severity?: string | null;
  component?: string | null;
  code?: string | null;
  message?: string | null;
  category?: string | null;
  binding_key?: string | null;
  stage_key?: string | null;
  plugin_key?: string | null;
  plugin_id?: string | null;
};

export type UiOnboardingReadinessPluginItem = {
  plugin_key?: string | null;
  plugin_name?: string | null;
  scope_type?: string | null;
  scope_id?: string | null;
  required?: boolean | null;
  activation_mode?: string | null;
  baseline_profile?: string | null;
  plugin_id?: string | null;
  plugin_status?: string | null;
  effective_version_id?: string | null;
  effective_version_status?: string | null;
  active_version_id?: string | null;
  binding_count?: number | null;
  validation_ok?: boolean | null;
  pending_task_idempotency_key?: string | null;
  pending_task_exists?: boolean | null;
  status?: string | null;
};

export type UiOnboardingReadinessComponent = {
  status?: string | null;
  healthy?: boolean | null;
  baseline_profile?: string | null;
  required_count?: number | null;
  present_count?: number | null;
  healthy_count?: number | null;
  pending_credentials_count?: number | null;
  blocking_count?: number | null;
  missing_categories?: string[] | null;
  missing_stages?: Array<{
    binding_key?: string | null;
    stage_key?: string | null;
  }> | null;
  items?: UiOnboardingReadinessPluginItem[] | null;
};

// Aggregate label readiness only; label provenance is not a plugin inventory.
export type UiOnboardingReadinessLabelDesign = Pick<
  UiOnboardingReadinessComponent,
  "status" | "healthy" | "required_count" | "present_count" | "healthy_count" | "blocking_count"
> & {
  warning_count?: number | null;
};

export type UiOnboardingReadiness = {
  scope_type: string;
  scope_id?: string | null;
  organization_id?: string | null;
  generated_at?: string | null;
  overall_status?: string | null;
  healthy?: boolean | null;
  settings_defaults?: UiOnboardingReadinessComponent | null;
  workflow_bindings?: UiOnboardingReadinessComponent | null;
  integration_plugins?: UiOnboardingReadinessComponent | null;
  label_design?: UiOnboardingReadinessLabelDesign | null;
  blocking_findings?: UiOnboardingReadinessFinding[] | null;
};

export type UiNavigationItem = {
  id: string;
  label: string;
  label_ar?: string | null;
  href?: string | null;
  badge?: string | null;
  icon?: string | null;
  resource?: string | null;
  capability?: string | null;
  disabled_reason?: string | null;
  items?: UiNavigationItem[] | null;
};

export type UiNavigationSection = {
  id: string;
  label: string;
  label_ar?: string | null;
  items: UiNavigationItem[];
};

export type UiNavigation = {
  app?: string | null;
  sections: UiNavigationSection[];
};

export type UiReadFilter = {
  key: string;
  column: string;
  resolver?: string | null;
  op?: string | null;
  ops?: string[] | null;
  label?: string | null;
  label_ar?: string | null;
  value_autocomplete?: {
    enabled?: boolean | null;
    source?: "distinct_values" | null;
    min_query_length?: number | null;
    limit?: number | null;
  } | null;
};

export type UiSort = {
  key: string;
  direction?: string | null;
  group_key?: string | null;
};

export type UiReadDownload = {
  capability?: string | null;
  bucket?: string | null;
  path_column?: string | null;
  file_name_column?: string | null;
  expires_seconds?: number | null;
};

export type UiReadLookupOption = {
  value: string;
  label?: string | null;
  aliases?: string[] | null;
};

export type UiReadColumnImportReference = {
  resource: string;
  relation?: string | null;
  id_column?: string | null;
  label?: string | null;
  label_column?: string | null;
  display_columns?: string[] | null;
  allow_inline_node?: boolean | null;
  inline_node_key?: string | null;
  inline_node_label?: string | null;
  mapping_prefixes?: string[] | null;
  match_fields?: string[] | null;
  create_mode?: "match_or_create" | "create_only" | "link_only" | string | null;
};

export type UiReadColumnImport = {
  enabled?: boolean | null;
  required?: boolean | null;
  identity?: boolean | null;
  aliases?: string[] | null;
  coercions?: string[] | null;
  lookup?: {
    relation?: string | null;
    key_column?: string | null;
    label_column?: string | null;
    category?: string | null;
    allowed_values?: string[] | null;
    options?: UiReadLookupOption[] | null;
  } | null;
  enum_values?: string[] | null;
  reference?: UiReadColumnImportReference | null;
};

export type UiReadColumn = {
  key: string;
  label?: string | null;
  label_ar?: string | null;
  render_type?: string | null;
  format_options?: Record<string, unknown> | null;
  edit_mode?: string | null;
  edit_type?: string | null;
  edit_permission?: string | null;
  detail_section?: string | null;
  aggregation?: {
    enabled?: boolean | null;
    methods?: string[] | null;
  } | null;
  import?: UiReadColumnImport | null;
};

export type UiReadRelated = {
  resource: string;
  label?: string | null;
  label_ar?: string | null;
  filter_key: string;
  from: string;
  limit?: number | null;
};

export type UiReadReorder = {
  order_column: string;
  group_column?: string | null;
  require_full?: boolean | null;
  capability?: string | null;
  post_action?: string | null;
};

export type UiReadResourceImport = {
  enabled?: boolean | null;
  capability?: string | null;
  default_write_mode?: "create" | "upsert" | string | null;
  allow_upsert?: boolean | null;
  identity_columns?: string[] | null;
  accepted_formats?: string[] | null;
  disabled_reason?: string | null;
};

export type UiReadResource = {
  key: string;
  label?: string | null;
  label_ar?: string | null;
  relation: string;
  id_column?: string | null;
  scope_columns?: Record<string, string> | null;
  read_scope_types?: string[] | null;
  capability_read?: string | null;
  capability_write?: string | null;
  column_labels?: Record<string, string> | null;
  column_labels_ar?: Record<string, string> | null;
  columns?: UiReadColumn[] | null;
  strict_columns?: boolean | null;
  related?: UiReadRelated[] | null;
  reorder?: UiReadReorder | null;
  select?: string[] | null;
  filters?: UiReadFilter[] | null;
  default_sort?: { column?: string | null; direction?: string | null } | null;  
  download?: UiReadDownload | null;
  import?: UiReadResourceImport | null;
};

export type UiReadRegistry = {
  resources?: UiReadResource[] | null;
  scopes?: UiScopeOption[] | null;
};

export type UiTableView = {
  id: string;
  label: string;
  description?: string | null;
  columns?: {
    order?: string[] | null;
    hidden?: string[] | null;
    pinned?: string[] | null;
    widths?: Record<string, number> | null;
  } | null;
  density?: string | null;
  open_mode?: string | null;
  analytics?: boolean | null;
  filters?: Record<string, unknown> | null;
  sort?: UiSort | null;
  group_by?: string[] | string | null;
  page_size?: number | null;
};

export type UiTableViews = {
  resource: string;
  views?: Record<string, UiTableView> | null;
  default_view_id?: string | null;
  scope_type?: string | null;
  scope_id?: string | null;
  settings_resolution_id?: string | null;
  settings_id?: string | null;
  settings_version_id?: string | null;
  scope_path?: unknown;
  scope_value?: unknown;
};

export type UiCommandSelection = {
  mode?: "none" | "single" | "multi" | "any" | null;
  min_count?: number | null;
  max_count?: number | null;
  id_param?: string | null;
  ids_param?: string | null;
};

export type UiCommandConfirm = {
  title?: string | null;
  description?: string | null;
  tone?: "default" | "danger" | null;
  confirm_label?: string | null;
  cancel_label?: string | null;
};

export type UiCommandInputField = {
  key: string;
  label: string;
  type?: "text" | "textarea" | "lookup" | "number" | null;
  required?: boolean | null;
  placeholder?: string | null;
  lookup_category?: string | null;
  lookup_rpc?: string | null;
  lookup_selection_param?: string | null;
  default_value?: unknown;
};

export type UiCommandInputSchema = {
  version?: number | null;
  title?: string | null;
  description?: string | null;
  fields?: UiCommandInputField[] | null;
  normalization?: "self_kyc_v1" | "financial_amount_v1" | null;
  task_type_overrides?: Record<string, unknown> | null;
};

export type UiCommandReadbackParamSource =
  | {
      source: "result";
      path?: string | null;
    }
  | {
      source: "selection";
      path: "id" | "ids" | "count";
    }
  | {
      source: "static";
      value: unknown;
    };

export type UiCommandReadback = {
  rpc: string;
  params?: Record<string, unknown> | null;
  success_path?: string | null;
  max_attempts?: number | null;
  delay_ms?: number | null;
};

export type UiCommandExecution = {
  idempotency?: "actor_retry_v1" | null;
  evidence?: {
    context: "self" | "task"; registration_rpc: string; bucket: string;
    min_items: number; max_items: number; tag_field?: string | null;
  } | null;
  transport?: "rpc" | "edge" | null;
  function?: string | null;
  type?: "navigate" | "workflow" | "workflow_binding" | "rpc" | "download" | "print" | null;
  rpc?: string | null;
  result_contract?: "batch_items_v1" | null;
  params?: Record<string, unknown> | null;
  input_schema?: UiCommandInputSchema | null;
  payload_key?: string | null;
  confirm?: UiCommandConfirm | null;
  binding_key?: string | null;
  stage_key?: string | null;
  readback?: UiCommandReadback | null;
};

export type UiCommandDefinition = {
  key: string;
  label: string;
  label_ar?: string | null;
  description?: string | null;
  description_ar?: string | null;
  capability?: string | null;
  schema_category?: string | null;
  workflow_key?: string | null;
  binding_key?: string | null;
  stage_key?: string | null;
  route_targets?: Record<string, UiRouteTarget | null> | null;
  selection?: UiCommandSelection | null;
  execution?: UiCommandExecution | null;
};

export type UiCommandRegistry = {
  commands?: UiCommandDefinition[] | null;
};

export type UiTrackingRegistry = {
  resource_key?: string | null;
  filter_key?: string | null;
  param_key?: string | null;
  title?: string | null;
  title_ar?: string | null;
  description?: string | null;
  description_ar?: string | null;
  results_description?: string | null;
  results_description_ar?: string | null;
  empty?: string | null;
  empty_ar?: string | null;
  operator_handoff?: {
    enabled?: boolean | null;
    label?: string | null;
    label_ar?: string | null;
    description?: string | null;
    description_ar?: string | null;
    identifier_param?: string | null;
    identifier_source?: string | null;
    tab_param?: string | null;
    tab?: string | null;
    route_targets?: { console?: { path?: string | null } | null } | null;
  } | null;
  form?: {
    label?: string | null;
    label_ar?: string | null;
    placeholder?: string | null;
    placeholder_ar?: string | null;
    search_label?: string | null;
    search_label_ar?: string | null;
    clear_label?: string | null;
    clear_label_ar?: string | null;
  } | null;
};

export type UiRouteTarget = {
  path: string;
  params?: Record<string, unknown> | null;
};

export type UiShipmentReportingConfig = { enabled: false } | {
  enabled: true;
  app_keys: string[];
  resource: string;
  status_filter: string;
  statuses: Array<{ key: string; label_key: string }>;
  active_status_keys: string[];
  delivered_status_key: string;
  pending_status_key: string;
  exception_status_key: string;
};

export type UiDashboardConfig = {
  shipment_reporting?: UiShipmentReportingConfig | null;
  max_sections?: number | null;
  max_items_per_section?: number | null;
  max_actions?: number | null;
  max_metrics?: number | null;
};

export type UiDashboardMetric = {
  resource: string;
  total: number | null;
};

export type UiDashboardMetrics = {
  metrics?: UiDashboardMetric[] | null;
};

export type UiFilterOperator = {
  key: string;
  label: string;
  label_ar?: string | null;
  supports_array?: boolean | null;
};

export type UiFilterOperators = {
  operators?: UiFilterOperator[] | null;
};

export type UiResourceList = {
  resource: string;
  keys?: string[] | null;
  items: Record<string, unknown>[];
  limit: number;
  offset: number;
  total?: number | null;
  total_strategy?: string | null;
  total_is_estimate?: boolean | null;
};

export type UiResourceReorderResult = {
  status: string;
  resource: string;
  count: number;
  group_value?: string | null;
};

export type UiResourceMetricColumn = {
  count: number;
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
};

export type UiResourceMetrics = {
  resource: string;
  total: number;
  columns: Record<string, UiResourceMetricColumn>;
};

export type UiResourceDetail = Record<string, unknown> | null;

export type UiManualReviewTask = Record<string, unknown>;

export type UiResourceDownloadResult =
  | { ok: true; url: string; expires_at?: string | null }
  | { ok: false; status: number; error: string };

export type UiTrace = {
  correlation_id: string;
  observability_events?: Record<string, unknown>[] | null;
  domain_events?: Record<string, unknown>[] | null;
  workflow_runs?: Record<string, unknown>[] | null;
};

export type UiShipmentTimelineEvent = {
  event_id: string;
  event_source: string;
  event_type: string;
  status?: string | null;
  event_time: string;
  correlation_id?: string | null;
  summary?: string | null;
  actor?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type UiShipmentTimeline = {
  shipment_id: string;
  timeline_events?: UiShipmentTimelineEvent[] | null;
};

export type UiShipmentPodAsset = {
  shipment_id: string;
  shipment_action_id?: string | null;
  artifact_id: string;
  asset_kind?: string | null;
  label?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  created_at?: string | null;
};

export type UiWorkflowRunOutputStatus = {
  workflow_run_id: string;
  workflow_status?: string | null;
  current_operation?: string | null;
  phase?: string | null;
  output_url?: string | null;
  output_file_path?: string | null;
  output_bucket?: string | null;
  output_needs_signing?: boolean | null;
  output_source?: string | null;
  output_ready?: boolean | null;
  terminal?: boolean | null;
  failure_reason?: string | null;
  pending_count?: number | null;
  ready_count?: number | null;
  print_async_request_id?: number | string | null;
  print_async_completed?: boolean | null;
  print_mode?: string | null;
  artifact_kind?: string | null;
  bundle_async_request_id?: number | string | null;
  bundle_async_completed?: boolean | null;
  function_total_ms?: number | null;
  fresh_expected_count?: number | null;
  fresh_ready_count?: number | null;
  fresh_failed_count?: number | null;
  fresh_request_scope_key?: string | null;
  fresh_only_resolved?: boolean | null;
  stage_prepare_ms?: number | null;
  stage_execute_ms?: number | null;
  stage_enqueue_ms?: number | null;
  stage_render_ms?: number | null;
  stage_bundle_ms?: number | null;
  stage_complete_ms?: number | null;
  stage_render_wait_ms?: number | null;
  stage_bundle_wait_ms?: number | null;
  stage_finalize_ms?: number | null;
  status_checked_at?: string | null;
  poll_progress_managed?: boolean | null;
  poll_progress_attempted?: boolean | null;
  poll_progress_status?: string | null;
  poll_progress_error?: string | null;
  print_async_progress_attempted?: boolean | null;
  print_async_progress_status?: string | null;
  print_async_progress_error?: string | null;
  async_progress_attempted?: boolean | null;
  async_progress_status?: string | null;
  async_progress_error?: string | null;
};

export type UiWorkflowRunProgress = {
  workflow_run_id: string;
  status?: string | null;
  attempts?: number | null;
  elapsed_ms?: number | null;
  budget_ms?: number | null;
  max_steps?: number | null;
  next_run_at?: string | null;
  error?: string | null;
};

export type UiAccessPolicy = {
  policy?: Record<string, unknown> | null;
  settings_resolution_id?: string | null;
  scope_type?: string | null;
  scope_id?: string | null;
  scope_path?: unknown;
};

export type UiSettingsPreview = {
  category: string;
  scope_type?: string | null;
  scope_id?: string | null;
  settings_id?: string | null;
  settings_version_id?: string | null;
  settings_resolution_id?: string | null;
  scope_path?: unknown;
  value?: unknown;
};

export type UiSettingsChangeRequest = {
  settings_version_id: string;
  domain_event_id: string;
};

export type UiStartWorkflowRunResult = {
  status: string;
  workflow_template_id?: string | null;
  workflow_run_id?: string | null;
};

export type UiCreateWorkflowTemplateResult = {
  status: string;
  workflow_template_id?: string | null;
};

export type UiCreateWorkflowTemplateStepResult = {
  status: string;
  workflow_template_step_id?: string | null;
};

export type UiShipmentDestinationAddress = {
  line1?: string;
  city?: string;
  sa_short_code?: string;
  latitude?: number;
  longitude?: number;
  coordinates?: { latitude: number; longitude: number };
};

export type UiDestinationAddressCapture =
  | { status: "pending" }
  | {
      status: "verified";
      address_id: string;
      sa_short_code?: string | null;
      coordinates?: { latitude: number; longitude: number } | null;
    };

export type UiCreateShipmentResult = {
  destination_address_capture?: UiDestinationAddressCapture;
  status: string;
  workflow_template_id?: string | null;
  workflow_run_id?: string | null;
  workflow_status?: string | null;
  correlation_id?: string | null;
  shipment_id?: string | null;
  tracking_number?: string | null;
  operation?: string | null;
};

export type UiCreateServiceLevelResult = {
  ok: boolean;
  service_level_id?: string | null;
  organization_id?: string | null;
  correlation_id?: string | null;
};

export type UiCreateServiceOfferingResult = {
  ok: boolean;
  service_offering_id?: string | null;
  organization_id?: string | null;
  correlation_id?: string | null;
};

export type UiCreateWarehouseTransferManifestResult = {
  status: string;
  created?: boolean | null;
  operation?: string | null;
  transfer_id?: string | null;
  warehouse_transfer_id?: string | null;
  transfer_code?: string | null;
  transfer_status?: string | null;
  shipment_count?: number | null;
};

export type UiExecuteWarehouseTransferDispatchResult = {
  status: string;
  action_key?: string | null;
  resource_key?: string | null;
  workflow_run_id?: string | null;
  workflow_template_id?: string | null;
  workflow_status?: string | null;
  warehouse_transfer_id?: string | null;
  transfer_status?: string | null;
  started?: boolean | null;
  count?: number | null;
  progress?: Record<string, unknown> | null;
  items?: Array<Record<string, unknown>> | null;
};

export type UiExecuteWarehouseTransferCheckpointResult = {
  status: string;
  action_key?: string | null;
  resource_key?: string | null;
  phase?: string | null;
  checkpoint_key?: string | null;
  workflow_run_id?: string | null;
  workflow_status?: string | null;
  warehouse_transfer_id?: string | null;
  transfer_status?: string | null;
  task_id?: string | null;
  task_event_id?: string | null;
  scan_event_id?: string | null;
  scan_created?: boolean | null;
  count?: number | null;
  progress?: Record<string, unknown> | null;
  items?: Array<Record<string, unknown>> | null;
};

export type UiExecuteRouteRunScanoutResult = {
  status: string;
  action_key?: string | null;
  resource_key?: string | null;
  blocked_reason?: string | null;
  route_run_id?: string | null;
  route_stop_id?: string | null;
  task_id?: string | null;
  scan_event_id?: string | null;
  scan_created?: boolean | null;
  scan_out?: Record<string, unknown> | null;
  route_departure?: Record<string, unknown> | null;
  route_execution_manifest?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  count?: number | null;
  items?: Array<Record<string, unknown>> | null;
};

export type UiCreateWorkflowScheduleTriggerResult = {
  status: string;
  workflow_schedule_trigger_id?: string | null;
};

export type UiCreateWorkflowRunTriggerResult = {
  status: string;
  workflow_run_trigger_id?: string | null;
  id?: string | null;
  source_workflow_template_id?: string | null;
  target_workflow_template_id?: string | null;
  source_statuses?: string[] | null;
  context_patch?: Record<string, unknown> | null;
  enabled?: boolean | null;
  notes?: string | null;
  deleted_at?: string | null;
  decision_log_id?: string | null;
  domain_event_id?: string | null;
  correlation_id?: string | null;
};

export type UiUpdateWorkflowRunTriggerResult = UiCreateWorkflowRunTriggerResult;
export type UiDeleteWorkflowRunTriggerResult = UiCreateWorkflowRunTriggerResult & {
  workflow_trigger_fires_count?: number | null;
};

export type UiRunWorkflowScheduleTriggerResult = {
  status: string;
  workflow_schedule_trigger_id?: string | null;
  workflow_template_id?: string | null;
  workflow_run_id?: string | null;
};

export type UiAutomationMarketplaceListingResult = {
  ok: boolean;
  listing_id?: string | null;
  listing_version_id?: string | null;
  asset_kind?: string | null;
  visibility?: string | null;
  publication_status?: string | null;
  review_id?: string | null;
  decision?: string | null;
};

export type UiAutomationMarketplaceInstallResult = {
  ok: boolean;
  install_id?: string | null;
  installed_resource_type?: string | null;
  installed_resource_id?: string | null;
  activation_result?: Record<string, unknown> | null;
  status?: string | null;
  target_listing_version_id?: string | null;
  runtime_activated?: boolean | null;
  staged_plugin_version_id?: string | null;
};

export type UiAutomationMarketplaceUpgradePreview = {
  ok: boolean;
  install_id?: string | null;
  forked?: boolean | null;
  current_listing_version_id?: string | null;
  target_listing_version_id?: string | null;
  current_artifact_hash?: string | null;
  target_artifact_hash?: string | null;
  has_changes?: boolean | null;
};

export type UiIntegrationConnectionResult = {
  ok: boolean;
  connection_id?: string | null;
  status?: string | null;
  secret_hint?: string | null;
  generated_secret?: string | null;
  runtime_auth_config_id?: string | null;
  test_kind?: string | null;
  remote_verified?: boolean | null;
  credential_generation?: number | null;
  last_tested_credential_generation?: number | null;
};

export type UiIntegrationConnectionBindingResult = {
  ok: boolean;
  binding_id?: string | null;
  install_id?: string | null;
  connection_id?: string | null;
  runtime_auth_config_id?: string | null;
};

export type UiRelatedResourceKey = string | string[];

export type UiRelatedResourceDef = {
  resource: string;
  label?: string | null;
  filter_key: UiRelatedResourceKey;
  from: UiRelatedResourceKey;
  limit?: number | null;
};

export type UiRelatedResources = UiRelatedResourceDef[];

export type MappingArtifact =
  | "tabular_import"
  | "webhook_inbound"
  | "api_outbound"
  | "integration_plugin";

export type MappingDiagnostic = {
  level: "error" | "warning" | "info";
  blocking: boolean;
  code: string;
  fieldPath?: string | null;
  message: string;
  why: string;
  recommended_fix: string;
  source_policy?: string | null;
  settings_resolution_id?: string | null;
};

export type MappingCoercion = {
  target_field: string;
  source_path?: string | null;
  original_type: string;
  original_value: unknown;
  converted_type: string;
  converted_value: unknown;
  reason: string;
  can_override: boolean;
};

export type MappingReviewSummary = {
  blocking_count?: number | null;
  warning_count?: number | null;
  coercion_count?: number | null;
  next_steps?: string[] | null;
  egress_policy_resolution_id?: string | null;
};

export type MappingOperationReport = {
  id?: string | null;
  organization_id?: string | null;
  artifact_type?: MappingArtifact | null;
  operation_kind?: string | null;
  save_mode?: "direct" | "draft" | null;
  status?: "succeeded" | "failed" | null;
  primary_resource_type?: string | null;
  primary_resource_id?: string | null;
  workflow_template_id?: string | null;
  correlation_id?: string | null;
  request_summary?: unknown;
  conversion_summary?: unknown;
  diagnostics_summary?: unknown;
  result_payload?: unknown;
  decision_refs?: unknown;
  next_steps?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type MappingStudioReview = {
  mapping_config?: unknown;
  coerced_preview?: unknown;
  coercions?: MappingCoercion[] | null;
  diagnostics?: MappingDiagnostic[] | null;
  review_summary?: MappingReviewSummary | null;
};

export type MappingStudioResponse = {
  ok?: boolean;
  endpoint?: string | null;
  artifact?: MappingArtifact | null;
  normalized_contract?: unknown;
  mapping_suggestion?: unknown;
  outbound_suggestions?: unknown;
  review?: MappingStudioReview | null;
  save_modes?: {
    direct_allowed?: boolean | null;
    draft_allowed?: boolean | null;
    recommended?: "direct" | "draft" | null;
  } | null;
  save_mode?: "direct" | "draft" | null;
  result?: unknown;
  report?: MappingOperationReport | null;
  draft?: unknown;
  validation?: unknown;
  correlation_id?: string | null;
};

export type ResourceImportArtifactLink = {
  artifact_id?: string | null;
  relation_type?: string | null;
  storage_bucket?: string | null;
  storage_key?: string | null;
  mime_type?: string | null;
  file_name?: string | null;
  signed_url?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type OrganizationProfile = {
  id: string;
  name: string;
  timezone: string;
  locale: string;
  default_settings: { branding: { primary_color?: string; secondary_color?: string } };
};

export type OrganizationProfileResult = {
  ok: true;
  profile: OrganizationProfile;
  logo: { artifact_id: string; file_name: string; mime_type: string; size_bytes: number } | null;
};

export type OrganizationProfilePatch = {
  organization_id: string;
  name?: string;
  timezone?: string;
  locale?: string;
  primary_color?: string;
  secondary_color?: string;
  file_name?: string;
  content_type?: string;
  file_base64?: string;
};

export type TabularImportRelatedNodeContract = {
  node_key: string;
  node_label?: string | null;
  reference_field: string;
  target_resource: string;
  target_label?: string | null;
  relation?: string | null;
  id_column?: string | null;
  scope_columns?: Record<string, string> | null;
  columns?: UiReadColumn[] | null;
  required_targets?: string[] | null;
  mapping_prefixes?: string[] | null;
  match_fields?: string[] | null;
  create_mode?: "match_or_create" | "create_only" | "link_only" | string | null;
};

export type ResourceImportRelatedNodeSummary = {
  node_key: string;
  node_label?: string | null;
  target_resource?: string | null;
  will_create?: number | null;
  will_link?: number | null;
  blocked_count?: number | null;
  skipped_count?: number | null;
  created_count?: number | null;
  linked_count?: number | null;
  failed_count?: number | null;
};

export type ResourceImportRelatedNodePlan = {
  node_key: string;
  node_label?: string | null;
  reference_field?: string | null;
  target_resource?: string | null;
  target_label?: string | null;
  relation?: string | null;
  id_column?: string | null;
  create_mode?: string | null;
  match_fields?: string[] | null;
  payload?: Record<string, unknown> | null;
  action?: "create" | "link" | "skip" | "block" | null;
  execution_status?: string | null;
  match_count?: number | null;
  target_record_id?: string | null;
  diagnostics?: MappingDiagnostic[] | null;
  coercions?: MappingCoercion[] | null;
};

export type ResourceImportProfileSummary = {
  id?: string | null;
  profile_name?: string | null;
  profile_slug?: string | null;
  header_fingerprint?: string | null;
  sheet_hint?: string | null;
  write_mode?: string | null;
  mapping_key?: string | null;
  mapping_config?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ResourceImportRowSummary = {
  row_number: number;
  execution_status?: string | null;
  action?: "create" | "update" | "skip" | "block" | "failed" | null;
  diagnostics?: MappingDiagnostic[] | null;
  coercions?: MappingCoercion[] | null;
  original_row?: Record<string, unknown> | null;
  mapped_row?: Record<string, unknown> | null;
  target_record_id?: string | null;
  reason_codes?: string[] | null;
  reason_messages?: string[] | null;
  related_nodes?: ResourceImportRelatedNodePlan[] | null;
};

export type ResourceImportDryRunSummary = {
  run_id?: string | null;
  resource?: string | null;
  write_mode?: string | null;
  source_format?: string | null;
  source_file_name?: string | null;
  header_fingerprint?: string | null;
  sheet_name?: string | null;
  unmatched_headers?: string[] | null;
  unresolved_targets?: string[] | null;
  total_rows?: number | null;
  will_create?: number | null;
  will_update?: number | null;
  will_skip?: number | null;
  blocked_count?: number | null;
  warning_count?: number | null;
  automatic_corrections?: MappingCoercion[] | null;
  blocking_diagnostics?: MappingDiagnostic[] | null;
  warning_diagnostics?: MappingDiagnostic[] | null;
  rows?: ResourceImportRowSummary[] | null;
  profile?: ResourceImportProfileSummary | null;
  available_profiles?: ResourceImportProfileSummary[] | null;
  artifacts?: ResourceImportArtifactLink[] | null;
  related_nodes?: ResourceImportRelatedNodeSummary[] | null;
  available_related_nodes?: TabularImportRelatedNodeContract[] | null;
};

export type ResourceImportRun = {
  id?: string | null;
  organization_id?: string | null;
  resource_key?: string | null;
  relation_name?: string | null;
  write_mode?: string | null;
  status?: string | null;
  profile_name?: string | null;
  header_fingerprint?: string | null;
  sheet_name?: string | null;
  source_format?: string | null;
  source_file_name?: string | null;
  source_artifact_id?: string | null;
  error_artifact_id?: string | null;
  report_id?: string | null;
  total_rows?: number | null;
  will_create?: number | null;
  will_update?: number | null;
  will_skip?: number | null;
  blocked_count?: number | null;
  created_count?: number | null;
  updated_count?: number | null;
  skipped_count?: number | null;
  failed_count?: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  canceled_at?: string | null;
  summary?: unknown;
  artifacts?: ResourceImportArtifactLink[] | null;
  report?: MappingOperationReport | null;
  rows?: ResourceImportRowSummary[] | null;
};

export type ResourceImportPrepareResponse = {
  ok?: boolean;
  dry_run?: ResourceImportDryRunSummary | null;
  profile_match?: ResourceImportProfileSummary | null;
  available_profiles?: ResourceImportProfileSummary[] | null;
  resolved_rules?: Array<{
    source_column?: string | null;
    target_field: string;
    confidence?: number | null;
    source?: string | null;
    enabled?: boolean | null;
    value_mode?: "source" | "fixed" | null;
    fixed_value?: unknown;
  }> | null;
  correlation_id?: string | null;
};

export type ResourceImportStartResponse = {
  ok?: boolean;
  processing_warning?: string | null;
  run?: ResourceImportRun | null;
  report?: MappingOperationReport | null;
  result?: unknown;
  correlation_id?: string | null;
};

export type ResourceImportCancelResponse = {
  ok?: boolean;
  run?: ResourceImportRun | null;
  correlation_id?: string | null;
};

export { normalizeNavigation } from "./navigation-normalize";
export {
  buildTabularHeaderFingerprint,
  coerceTabularValue,
  detectWorkbookVisibleSheets,
  inferTabularFieldRules,
  isTabularRuleConfigured,
  matrixToTabularData,
  matrixToTabularPreview,
  normalizeTabularHeader,
  parseCsvTextMatrix,
  parseTabularTargetField,
  prepareTabularRows,
  resolveWorkbookWorksheet,
  resolveInlineRelatedNodeContracts,
  resolveTabularRuleMode,
  resolveImportAcceptedFormats,
  resolveImportCapability,
  resolveImportEnabled,
  resolveImportIdentityColumns,
  resolveImportReference,
  resolveImportableColumns,
  resolveImportWriteMode,
  resolveLookupOptions,
  resolveEnumOptions,
  worksheetToMatrix,
  worksheetToTabularPreview,
  type TabularImportFieldRule,
  type TabularImportInference,
  type TabularImportPreparedRow,
  type TabularImportRowOverrides,
} from "./tabular-import";


export function createUiClient() {
  return createUiClientFromSupabase(createBrowserClient());
}

async function requestUiDownload(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<UiResourceDownloadResult> {
  const { supabaseUrl } = getPublicConfig();
  const response = await fetch(`${supabaseUrl}/functions/v1/ui-resource-download`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch (_err) {
    payload = null;
  }

  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : `Download request failed with status ${response.status}`;
    return { ok: false, status: response.status, error: message };
  }

  const url = typeof payload?.url === "string" ? payload.url : "";
  const expiresAt = typeof payload?.expires_at === "string" ? payload.expires_at : null;
  if (!url) {
    return { ok: false, status: 502, error: "Download signer did not return a URL." };
  }

  return { ok: true, url, expires_at: expiresAt };
}

export async function requestUiResourceDownload(params: {
  accessToken: string;
  resource: string;
  id: string;
  app?: string;
  extraParams?: Record<string, string | null | undefined>;
}): Promise<UiResourceDownloadResult> {
  const { accessToken, resource, id, app, extraParams } = params;
  return requestUiDownload(accessToken, {
    resource,
    id,
    ...(app ? { app } : {}),
    ...Object.fromEntries(
      Object.entries(extraParams ?? {}).filter(([, value]) => typeof value === "string" && value.trim())
    ),
  });
}

export async function requestUiWorkflowRunOutputDownload(params: {
  accessToken: string;
  workflowRunId: string;
  outputUrlPaths?: string[] | null;
  app?: string;
}): Promise<UiResourceDownloadResult> {
  const { accessToken, workflowRunId, outputUrlPaths, app } = params;
  return requestUiDownload(accessToken, {
    workflow_run_id: workflowRunId,
    output_url_paths: outputUrlPaths ?? null,
    ...(app ? { app } : {}),
  });
}

export type StudioTestSubmission = { ok?: boolean; accepted?: boolean; pending?: boolean; source_id?: string; external_id?: string };
export type StudioTestStatus = { ok?: boolean; state: "pending" | "failed" | "succeeded"; source_id: string; external_id: string;
  inbox_id?: string | null; shipment_id?: string | null; workflow_run_id?: string | null; workflow_run_step_id?: string | null; decision_log_ids?: string[] };
