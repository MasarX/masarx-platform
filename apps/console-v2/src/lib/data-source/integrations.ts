import {
  type AdjustApiGatewayRateLimitArgs,
  type ArchiveWebhookSourceArgs,
  backendOutcomeError,
  type BindProviderAccountCredentialArgs,
  type BlockApiGatewaySourceArgs,
  buildMutationFallbackEnvelope,
  type IntegrationPluginExportHandoffArgs,
  type IntegrationPluginGenerateDraftArgs,
  livePArgsMutationResult,
  liveRpc,
  liveRpcTarget,
  nextResourceId,
  objectRecord,
  phaseC6Rpc,
  type PluginActivateArgs,
  type PluginApproveArgs,
  type PluginSetBindingArgs,
  type PluginSubmitArgs,
  readLiveResourceListReadback,
  requireLiveEvidence,
  requireLiveResourceListReadback,
  requireLiveResourceReadback,
  requireLiveRpcRecord,
  requireLiveStringField,
  resolveSettings,
  sleep,
  ui_list_resource_v1,
  type UnbindProviderAccountCredentialArgs,
  type UpsertApiGatewayRouteMappingArgs,
  type UpsertMappingArtifactArgs,
  type UpsertProviderAuthConfigArgs,
  type UpsertWebhookSourceArgs,
  type WebhookInboxForceStatusArgs,
  type WebhookInboxReplayArgs,
  type WebhookInboxRetryAsNewIntakeArgs,
} from '../data-source';
import {
  assertLogisticsCustomerMigrationConfigEvidence,
  assertLogisticsCustomerMigrationResultEvidence,
  isPersistedLogisticsCustomerMigrationOutcome,
  isPersistedLogisticsCustomerMigrationValidationFailure,
  type LogisticsCustomerMigrationArgs,
  type LogisticsCustomerMigrationConfigArgs,
  type LogisticsCustomerMigrationConfigResult,
  type LogisticsCustomerMigrationResult,
} from './customer-logistics-migration';
import { asNonEmptyString, booleanReadback, type ResourceRow } from './shared';

export async function ui_delete_mapping_config_v1(
  args: { mapping_config_id: string },
): Promise<Record<string, unknown>> {
  const mappingConfigId = asNonEmptyString(args.mapping_config_id);
  if (!mappingConfigId) throw new Error('ui_delete_mapping_config_v1 requires mapping_config_id');

  const live = await liveRpc<Record<string, unknown>>('ui_delete_resource_v1', {
    p_resource: 'mapping_configs',
    p_id: mappingConfigId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'ui_delete_mapping_config_v1 returned no backend outcome');
    const outcomeError = backendOutcomeError(rec, 'ui_delete_mapping_config_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const deletedId =
      asNonEmptyString(rec.mapping_config_id) ??
      asNonEmptyString(rec.id);
    if (deletedId !== mappingConfigId) {
      throw new Error('ui_delete_mapping_config_v1 backend outcome did not match the requested mapping');
    }
    const mappingReadback = await ui_list_resource_v1<Record<string, unknown>>('mapping_configs', {
      filter: { id: mappingConfigId },
      page_size: 1,
    });
    if (mappingReadback.rows.some((row) => asNonEmptyString(row.id) === mappingConfigId)) {
      throw new Error('ui_delete_mapping_config_v1 confirmation still shows the mapping in Intake mappings');
    }
    const directoryReadback = await ui_list_resource_v1<Record<string, unknown>>('mapping_config_directory', {
      filter: { id: mappingConfigId },
      page_size: 1,
    });
    if (directoryReadback.rows.some((row) => asNonEmptyString(row.id) === mappingConfigId)) {
      throw new Error('ui_delete_mapping_config_v1 confirmation still shows the mapping in External Intake usage');
    }
    return {
      ...rec,
      mapping_config_id: mappingConfigId,
    };
  }

  await sleep(60);
  return buildMutationFallbackEnvelope({ mapping_config_id: mappingConfigId }, 'mapping_config');
}

export async function ui_upsert_api_gateway_route_mapping_v1(
  args: UpsertApiGatewayRouteMappingArgs,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>('ui_upsert_api_gateway_route_mapping_v1', {
    p_args: args,
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'ui_upsert_api_gateway_route_mapping_v1 returned no backend outcome');
    const outcomeError = backendOutcomeError(rec, 'ui_upsert_api_gateway_route_mapping_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const routeId =
      asNonEmptyString(rec.api_route_id) ??
      asNonEmptyString(args.api_route_id);
    const mappingConfigId =
      asNonEmptyString(rec.mapping_config_id) ??
      asNonEmptyString(args.mapping_config_id);
    if (!routeId) throw new Error('ui_upsert_api_gateway_route_mapping_v1 did not return api_route_id');
    if (!mappingConfigId) throw new Error('ui_upsert_api_gateway_route_mapping_v1 did not return mapping_config_id');
    await requireLiveResourceReadback('api_routes', routeId, 'ui_upsert_api_gateway_route_mapping_v1');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'ui_upsert_api_gateway_route_mapping_v1');
    return rec;
  }

  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'api_route');
}

export async function ui_test_mapping_config_v1(
  mappingConfigId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mappingId = asNonEmptyString(mappingConfigId);
  const live = await liveRpc<Record<string, unknown>>('ui_test_mapping_config_v1', {
    p_mapping_config_id: mappingId,
    p_payload: payload ?? {},
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'ui_test_mapping_config_v1 returned no result');
    const outcomeError = backendOutcomeError(rec, 'ui_test_mapping_config_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(rec, [
      'mapping_operation_report_id',
      'operation_report_id',
      'report_id',
      'report',
    ], 'ui_test_mapping_config_v1 did not return backend mapping operation report evidence');
    const reportId =
      asNonEmptyString(rec.mapping_operation_report_id) ??
      asNonEmptyString(rec.operation_report_id) ??
      asNonEmptyString(rec.report_id);
    if (reportId) {
      await requireLiveResourceReadback('mapping_operation_reports', reportId, 'ui_test_mapping_config_v1');
    }
    return rec;
  }
  await sleep(60);
  return {
    ok: true,
    status: 'succeeded',
    mapping_config_id: mappingId,
    transformed_payload: payload ?? {},
    report_id: `mor_${Date.now()}`,
  };
}

export async function ui_bind_provider_account_credential_v1(
  args: BindProviderAccountCredentialArgs,
): Promise<Record<string, unknown>> {
  const live = await livePArgsMutationResult('ui_bind_provider_account_credential_v1', args, [
    'provider_auth_config_id',
    'auth_config_id',
    'settings_version_id',
    'settings_id',
  ]);
  if (live) {
    const configId = resolveProviderAuthConfigId(live, args);
    if (!configId) throw new Error('ui_bind_provider_account_credential_v1 did not return provider_auth_config_id');
    // Provider-account bindings can attach tenant settings to a global route
    // provider. The direct secret table may stay outside tenant RLS; the
    // redacted credential directory is the browser-safe readback contract.
    const readback = await requireLiveResourceReadback(
      'integration_credential_directory',
      configId,
      'ui_bind_provider_account_credential_v1',
    );
    requireProviderAuthConfigDirectoryReadback(readback, args, 'ui_bind_provider_account_credential_v1', configId);
    return { ...live, provider_auth_config_id: configId };
  }
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'provider_account_credential');
}

export async function ui_unbind_provider_account_credential_v1(
  args: UnbindProviderAccountCredentialArgs,
): Promise<Record<string, unknown>> {
  const live = await livePArgsMutationResult('ui_unbind_provider_account_credential_v1', args, [
    'settings_version_id',
    'settings_id',
    'provider_account_category',
    'auth_config_id',
  ]);
  if (live) {
    const providerAccountCategory = asNonEmptyString(live.provider_account_category)
      ?? asNonEmptyString(args.provider_account_category)
      ?? 'logestechs_v2_account';
    const scopeType = asNonEmptyString(live.scope_type)
      ?? asNonEmptyString(args.scope_type)
      ?? 'tenant';
    const orgId =
      asNonEmptyString(live.organization_id)
      ?? asNonEmptyString(args.organization_id)
      ?? asNonEmptyString(args.tenant_id);
    const scopeId =
      asNonEmptyString(live.scope_id)
      ?? asNonEmptyString(args.scope_id)
      ?? (scopeType === 'tenant' ? orgId : asNonEmptyString(args.source_id));
    const scopeContext =
      scopeType === 'source'
        ? { webhook_source_id: scopeId, organization_id: orgId }
        : { tenant: { id: scopeId ?? orgId } };
    const readback = await resolveSettings(providerAccountCategory, scopeContext);
    const readbackValue =
      readback.value && typeof readback.value === 'object' && !Array.isArray(readback.value)
        ? readback.value as Record<string, unknown>
        : {};
    if (asNonEmptyString(readbackValue.auth_config_id)) {
      throw new Error('ui_unbind_provider_account_credential_v1 backend readback still exposes auth_config_id');
    }
    if (readbackValue.enabled !== false) {
      throw new Error('ui_unbind_provider_account_credential_v1 backend readback did not disable provider account');
    }
    return { ...live, bound: false, auth_config_id: null };
  }
  await sleep(60);
  return { ...buildMutationFallbackEnvelope(args, 'provider_account_credential_unbound'), bound: false };
}

export async function ui_execute_provider_circuit_reset_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = await livePArgsMutationResult('ui_execute_provider_circuit_reset_v1', args, [
    'provider_id',
    'operation_name',
    'circuit_breaker_id',
    'decision_log_id',
  ]);
  if (live) {
    const providerId = asNonEmptyString(live.provider_id) ?? asNonEmptyString(args.provider_id);
    const operationName = asNonEmptyString(live.operation_name) ?? asNonEmptyString(args.operation_name);
    if (!providerId || !operationName) {
      throw new Error('ui_execute_provider_circuit_reset_v1 did not return provider circuit identity');
    }

    const breakerRows = await readLiveResourceListReadback(
      'circuit_breaker_dashboard',
      { provider_id: providerId, operation_name: operationName },
      'ui_execute_provider_circuit_reset_v1',
    );
    const breaker = breakerRows.find(
      (row) => asNonEmptyString(row.provider_id) === providerId && asNonEmptyString(row.operation_name) === operationName,
    );
    if (!breaker || asNonEmptyString(breaker.state) !== 'closed') {
      throw new Error('ui_execute_provider_circuit_reset_v1 backend readback did not close the circuit breaker');
    }

    const healthRows = await readLiveResourceListReadback(
      'provider_health_latest',
      { provider_id: providerId },
      'ui_execute_provider_circuit_reset_v1',
    );
    const health = healthRows.find((row) => asNonEmptyString(row.provider_id) === providerId);
    if (!health || asNonEmptyString(health.status) !== 'healthy') {
      throw new Error('ui_execute_provider_circuit_reset_v1 backend readback did not mark provider healthy');
    }

    return live;
  }

  await sleep(60);
  return {
    ...buildMutationFallbackEnvelope(args, 'provider_circuit_reset'),
    provider_id: args.provider_id,
    operation_name: args.operation_name,
    state: 'closed',
    health_status: 'healthy',
  };
}

export async function ui_execute_provider_circuit_probe_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = await livePArgsMutationResult('ui_execute_provider_circuit_probe_v1', args, [
    'provider_id',
    'operation_name',
    'circuit_breaker_id',
    'decision_log_id',
  ]);
  if (live) {
    const providerId = asNonEmptyString(live.provider_id) ?? asNonEmptyString(args.provider_id);
    const operationName = asNonEmptyString(live.operation_name) ?? asNonEmptyString(args.operation_name);
    if (!providerId || !operationName) {
      throw new Error('ui_execute_provider_circuit_probe_v1 did not return provider circuit identity');
    }

    const breakerRows = await readLiveResourceListReadback(
      'circuit_breaker_dashboard',
      { provider_id: providerId, operation_name: operationName },
      'ui_execute_provider_circuit_probe_v1',
    );
    const breaker = breakerRows.find(
      (row) => asNonEmptyString(row.provider_id) === providerId && asNonEmptyString(row.operation_name) === operationName,
    );
    if (!breaker || asNonEmptyString(breaker.state) !== 'closed') {
      throw new Error('ui_execute_provider_circuit_probe_v1 backend readback did not close the circuit breaker');
    }

    const healthRows = await readLiveResourceListReadback(
      'provider_health_latest',
      { provider_id: providerId },
      'ui_execute_provider_circuit_probe_v1',
    );
    const health = healthRows.find((row) => asNonEmptyString(row.provider_id) === providerId);
    if (!health || asNonEmptyString(health.status) !== 'healthy') {
      throw new Error('ui_execute_provider_circuit_probe_v1 backend readback did not mark provider healthy');
    }

    return live;
  }

  await sleep(60);
  return {
    ...buildMutationFallbackEnvelope(args, 'provider_circuit_probe'),
    provider_id: args.provider_id,
    operation_name: args.operation_name,
    state: 'closed',
    health_status: 'healthy',
  };
}

export async function ui_upsert_logistics_customer_migration_config_v1(
  args: LogisticsCustomerMigrationConfigArgs,
): Promise<LogisticsCustomerMigrationConfigResult> {
  const rpcName = 'ui_upsert_logistics_customer_migration_config_v1';
  const live = await liveRpc<LogisticsCustomerMigrationConfigResult>(rpcName, { p_args: args });
  if (!live) throw new Error(`${rpcName} requires a live backend`);

  const result = requireLiveRpcRecord(
    live.data,
    `${rpcName} returned no backend outcome`,
  ) as LogisticsCustomerMigrationConfigResult;
  const outcomeError = backendOutcomeError(result, 'Customer migration config was rejected by the backend');
  if (outcomeError) throw outcomeError;
  assertLogisticsCustomerMigrationConfigEvidence(result);
  await Promise.all([
    requireLiveResourceReadback('logistics_migration_sources', result.source_id, rpcName),
    requireLiveResourceReadback('logistics_migration_profiles', result.profile_id, rpcName),
    requireLiveResourceReadback('integration_plugin_directory', result.plugin_id, rpcName),
    requireLiveResourceReadback('integration_plugin_versions', result.plugin_version_id, rpcName),
    requireLiveResourceReadback('integration_plugin_bindings', result.plugin_binding_id, rpcName),
    requireLiveResourceReadback('decision_log', result.decision_log_id, rpcName),
  ]);
  return result;
}

export async function ui_execute_logistics_customer_migration_v1(
  args: LogisticsCustomerMigrationArgs,
): Promise<LogisticsCustomerMigrationResult> {
  const rpcName = 'ui_execute_logistics_customer_migration_v1';
  const live = await liveRpc<LogisticsCustomerMigrationResult>(rpcName, { p_args: args });
  if (!live) throw new Error(`${rpcName} requires a live backend`);

  const result = requireLiveRpcRecord(
    live.data,
    `${rpcName} returned no backend outcome`,
  ) as LogisticsCustomerMigrationResult;
  if (
    !isPersistedLogisticsCustomerMigrationValidationFailure(result)
    && !isPersistedLogisticsCustomerMigrationOutcome(result)
  ) {
    const outcomeError = backendOutcomeError(result, 'Customer migration was rejected by the backend');
    if (outcomeError) throw outcomeError;
  }
  assertLogisticsCustomerMigrationResultEvidence(result);

  const readbacks: Array<Promise<ResourceRow>> = [
    requireLiveResourceReadback('logistics_migration_requests', result.request_id, rpcName),
    requireLiveResourceReadback('import_jobs', result.import_job_id, rpcName),
    requireLiveResourceReadback('integration_plugin_directory', result.plugin_id, rpcName),
    requireLiveResourceReadback('integration_plugin_versions', result.plugin_version_id, rpcName),
    requireLiveResourceReadback('integration_plugin_bindings', result.plugin_binding_id, rpcName),
  ];
  if (result.workflow_run_id) {
    readbacks.push(requireLiveResourceReadback('workflow_run_directory', result.workflow_run_id, rpcName));
  }
  if (result.decision_log_id) {
    readbacks.push(requireLiveResourceReadback('decision_log', result.decision_log_id, rpcName));
  }
  if (result.imported_client_id) {
    readbacks.push(requireLiveResourceReadback('clients', result.imported_client_id, rpcName));
  }
  for (const recipientId of result.imported_recipient_ids ?? []) {
    if (recipientId) {
      readbacks.push(requireLiveResourceReadback('recipients', String(recipientId), rpcName));
    }
  }
  for (const itemId of result.migration_item_ids ?? []) {
    if (itemId) {
      readbacks.push(requireLiveResourceReadback('logistics_migration_items', String(itemId), rpcName));
    }
  }
  for (const eventId of result.domain_event_ids ?? []) {
    if (eventId) {
      readbacks.push(requireLiveResourceReadback('recent_workflow_events', String(eventId), rpcName));
    }
  }
  await Promise.all(readbacks);
  return result;
}

export async function integration_plugin_export_handoff_v1(
  args: IntegrationPluginExportHandoffArgs,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>('integration_plugin_export_handoff_v1', {
    p_plugin_version_id: args.plugin_version_id,
    p_base_url: args.base_url ?? null,
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'integration_plugin_export_handoff_v1 returned no backend outcome');
    const outcomeError = backendOutcomeError(rec, 'integration_plugin_export_handoff_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(
      rec,
      ['plugin_id', 'plugin_version_id', 'kind', 'endpoint', 'token', 'sample_curl'],
      'integration_plugin_export_handoff_v1 did not return backend handoff evidence',
    );
    const issuedToken = asNonEmptyString(rec.token);
    if (!issuedToken || issuedToken.includes('{{') || issuedToken.includes('}}')) {
      throw new Error('integration_plugin_export_handoff_v1 did not return an issued source token');
    }
    const endpoint = asNonEmptyString(rec.endpoint);
    const sampleCurl = asNonEmptyString(rec.sample_curl);
    if (!endpoint || endpoint.includes('{{') || endpoint.includes('}}') || !sampleCurl || sampleCurl.includes('{{') || sampleCurl.includes('}}')) {
      throw new Error('integration_plugin_export_handoff_v1 did not return a concrete endpoint handoff');
    }
    const pluginVersionId = asNonEmptyString(rec.plugin_version_id) ?? args.plugin_version_id;
    const versionRow = await requireLiveResourceReadback(
      'integration_plugin_versions',
      pluginVersionId,
      'integration_plugin_export_handoff_v1',
    );
    const versionPluginId = asNonEmptyString(versionRow.plugin_id);
    const pluginId = asNonEmptyString(rec.plugin_id) ?? versionPluginId;
    if (!pluginId) throw new Error('integration_plugin_export_handoff_v1 did not return integration_plugin_id');
    if (versionPluginId && pluginId !== versionPluginId) {
      throw new Error('integration_plugin_export_handoff_v1 plugin readback did not match version lineage');
    }
    await requireLiveResourceReadback('integration_plugins', pluginId, 'integration_plugin_export_handoff_v1');
    await requireLiveResourceReadback('integration_plugin_directory', pluginId, 'integration_plugin_export_handoff_v1');
    return rec;
  }
  await sleep(40);
  return {
    ok: true,
    plugin_id: nextResourceId('plg'),
    plugin_version_id: args.plugin_version_id,
    kind: 'webhook',
    endpoint: `${args.base_url ?? '{{BASE_URL}}'}/functions/v1/webhook-receiver`,
    token: '{{TOKEN}}',
    headers: { authorization: 'Bearer {{TOKEN}}' },
    instructions: [
      'Point webhook destination to endpoint.',
      'Send Authorization: Bearer {token}.',
      'Keep payload shape per plugin mapping configuration.',
    ],
    sample_curl: `curl -X POST "${args.base_url ?? '{{BASE_URL}}'}/functions/v1/webhook-receiver" -H "authorization: Bearer {{TOKEN}}" -H "content-type: application/json" -d '{}'`,
  };
}

function resolveProviderAuthConfigId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.provider_auth_config_id)
    ?? asNonEmptyString(rec.auth_config_id)
    ?? asNonEmptyString(rec.config_id)
    ?? asNonEmptyString(rec.id)
    ?? asNonEmptyString(args.provider_auth_config_id)
    ?? asNonEmptyString(args.auth_config_id)
    ?? asNonEmptyString(args.config_id);
}

function requireProviderAuthConfigDirectoryReadback(
  row: Record<string, unknown>,
  args: Record<string, unknown>,
  rpcName: string,
  expectedConfigId: string,
): void {
  if (asNonEmptyString(row.id) !== expectedConfigId) {
    throw new Error(`${rpcName} backend readback did not reflect provider_auth_config_id`);
  }
  if (
    Object.prototype.hasOwnProperty.call(row, 'credentials') ||
    Object.prototype.hasOwnProperty.call(row, 'credentials_vault_id')
  ) {
    throw new Error(`${rpcName} backend readback exposed credential secret fields`);
  }
  const expectedProvider = asNonEmptyString(args.provider_id);
  if (expectedProvider && asNonEmptyString(row.provider_id) !== expectedProvider) {
    throw new Error(`${rpcName} backend readback did not reflect provider_id`);
  }
  const expectedAuthType = asNonEmptyString(args.auth_type);
  if (expectedAuthType && asNonEmptyString(row.auth_type) !== expectedAuthType) {
    throw new Error(`${rpcName} backend readback did not reflect auth_type`);
  }
  if (rpcName === 'ui_revoke_provider_auth_config_v1') {
    const status = asNonEmptyString(row.status);
    if (status !== 'revoked') {
      throw new Error(`${rpcName} backend readback did not reflect revoked status`);
    }
  }
}

export async function providerAuthConfigMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = await livePArgsMutationResult(rpcName, args, [
    'provider_auth_config_id',
    'auth_config_id',
    'config_id',
    'id',
  ]);
  if (live) {
    const configId = resolveProviderAuthConfigId(live, args);
    if (!configId) throw new Error(`${rpcName} did not return provider_auth_config_id`);
    const readback = await requireLiveResourceReadback('integration_credential_directory', configId, rpcName);
    requireProviderAuthConfigDirectoryReadback(readback, args, rpcName, configId);
    return { ...live, provider_auth_config_id: configId };
  }
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'provider_auth_config');
}

function resolveIntegrationPluginId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
  versionRow?: Record<string, unknown> | null,
): string | null {
  return asNonEmptyString(rec.integration_plugin_id)
    ?? asNonEmptyString(rec.plugin_id)
    ?? asNonEmptyString(args.integration_plugin_id)
    ?? asNonEmptyString(args.plugin_id)
    ?? asNonEmptyString(versionRow?.plugin_id);
}

function resolveIntegrationPluginVersionId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.integration_plugin_version_id)
    ?? asNonEmptyString(rec.plugin_version_id)
    ?? asNonEmptyString(rec.version_id)
    ?? asNonEmptyString(rec.to_plugin_version_id)
    ?? asNonEmptyString(args.integration_plugin_version_id)
    ?? asNonEmptyString(args.plugin_version_id)
    ?? asNonEmptyString(args.target_plugin_version_id);
}

async function requireLiveIntegrationPluginReadback(
  rpcName: string,
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
  options: {
    approvalAction?: string | null;
    requireBinding?: boolean;
    requireBindingChangeCount?: boolean;
    allowVersionless?: boolean;
  } = {},
): Promise<void> {
  const versionId = resolveIntegrationPluginVersionId(rec, args);
  let versionRow: Record<string, unknown> | null = null;
  if (versionId) {
    versionRow = await requireLiveResourceReadback('integration_plugin_versions', versionId, rpcName);
  } else if (!options.allowVersionless) {
    throw new Error(`${rpcName} did not return integration_plugin_version_id`);
  }

  const pluginId = resolveIntegrationPluginId(rec, args, versionRow);
  if (!pluginId) throw new Error(`${rpcName} did not return integration_plugin_id`);
  await requireLiveResourceReadback('integration_plugins', pluginId, rpcName);
  await requireLiveResourceReadback('integration_plugin_directory', pluginId, rpcName);

  const action = asNonEmptyString(options.approvalAction);
  if (versionId && action && !rec.already_processed) {
    await requireLiveResourceListReadback(
      'integration_plugin_approval_events',
      { plugin_version_id: versionId, action },
      rpcName,
    );
  }

  if (versionId && options.requireBinding) {
    const bindingRows = await requireLiveResourceListReadback(
      'integration_plugin_bindings',
      { plugin_version_id: versionId },
      rpcName,
    );
    const expectedBindingEnabled = Object.prototype.hasOwnProperty.call(args, 'enabled')
      ? args.enabled
      : args.expected_binding_enabled;
    if (
      Object.prototype.hasOwnProperty.call(args, 'enabled')
      || Object.prototype.hasOwnProperty.call(args, 'expected_binding_enabled')
    ) {
      const expectedEnabled = booleanReadback(expectedBindingEnabled);
      if (expectedEnabled === null) {
        throw new Error(`${rpcName} requires boolean binding enabled readback expectation`);
      }
      const expectedScopeType = asNonEmptyString(args.scope_type)?.toLowerCase() ?? null;
      const expectedScopeId = asNonEmptyString(args.scope_id);
      const scopedRows = bindingRows.filter((row) => {
        const rowScopeType = asNonEmptyString(row.scope_type)?.toLowerCase() ?? null;
        const rowScopeId = asNonEmptyString(row.scope_id);
        return (!expectedScopeType || rowScopeType === expectedScopeType)
          && (!expectedScopeId || rowScopeId === expectedScopeId);
      });
      if (scopedRows.length === 0) {
        throw new Error(`${rpcName} backend readback missing scoped integration_plugin_bindings`);
      }
      const mismatched = scopedRows.find((row) => booleanReadback(row.enabled) !== expectedEnabled);
      if (mismatched) {
        throw new Error(`${rpcName} backend readback did not reflect integration_plugin_bindings.enabled=${expectedEnabled}`);
      }
      const changedCount = Number(rec.changed_count ?? 0);
      if (
        expectedEnabled === false
        && options.requireBindingChangeCount !== false
        && scopedRows.length > 0
        && changedCount <= 0
      ) {
        throw new Error(`${rpcName} backend readback reported no binding changes`);
      }
    }
  }
}

export interface IntegrationPluginMutationOptions {
  approvalAction?: string | null;
  requireBinding?: boolean;
  requireBindingChangeCount?: boolean;
  allowVersionless?: boolean;
  fallbackResourceKey?: string;
}

export async function integrationPluginMutation(
  rpcName: string,
  args: Record<string, unknown>,
  options?: IntegrationPluginMutationOptions,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>(rpcName, { p_args: args });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, `${rpcName} returned no backend outcome`);
    const lifecycleAction = asNonEmptyString(options?.approvalAction)?.toLowerCase() ?? null;
    const returnedStatus = asNonEmptyString(rec.status)?.toLowerCase() ?? null;
    const expectedRejectedDecision =
      rpcName === 'plugin_approve_v1'
      && lifecycleAction === 'rejected'
      && returnedStatus === 'rejected'
      && rec.ok !== false;
    const outcomeError = expectedRejectedDecision
      ? null
      : backendOutcomeError(rec, `${rpcName} was rejected by the backend`);
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(rec, [
      'integration_plugin_id',
      'plugin_id',
      'integration_plugin_version_id',
      'plugin_version_id',
      'version_id',
      'to_plugin_version_id',
      'status',
      'changed_count',
      'already_processed',
      'correlation_id',
      'settings_resolution_id',
    ], `${rpcName} did not return backend plugin evidence`);
    await requireLiveIntegrationPluginReadback(rpcName, rec, args, options);
    return rec;
  }
  await sleep(60);
  return buildMutationFallbackEnvelope(args, options?.fallbackResourceKey ?? 'integration_plugin');
}

export function resolveWebhookSourceId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.webhook_source_id)
    ?? asNonEmptyString(rec.source_id)
    ?? asNonEmptyString(rec.id)
    ?? asNonEmptyString(args.webhook_source_id)
    ?? asNonEmptyString(args.source_id);
}

function requireWebhookSourceFieldReadback(
  row: Record<string, unknown>,
  field: string,
  expected: unknown,
  rpcName: string,
): void {
  if (expected === undefined) return;
  const actual = row[field];
  if (field === 'rate_limit_per_hour' && (expected === null || expected === '')) {
    const actualNumber = typeof actual === 'number' ? actual : Number(actual);
    if (!Number.isFinite(actualNumber) || actualNumber < 1) {
      throw new Error(`${rpcName} backend readback did not resolve intake source ${field}`);
    }
    return;
  }
  if (field === 'enabled') {
    const actualBool = booleanReadback(actual);
    if (actualBool !== Boolean(expected)) {
      throw new Error(`${rpcName} backend readback did not reflect intake source enabled state`);
    }
    return;
  }
  if (expected === null || expected === '') {
    if (actual != null && String(actual).trim() !== '') {
      throw new Error(`${rpcName} backend readback did not clear intake source ${field}`);
    }
    return;
  }
  if (field === 'rate_limit_per_hour') {
    const actualNumber = typeof actual === 'number' ? actual : Number(actual);
    if (!Number.isFinite(actualNumber) || actualNumber !== Number(expected)) {
      throw new Error(`${rpcName} backend readback did not reflect intake source ${field}`);
    }
    return;
  }
  const actualString = asNonEmptyString(actual);
  if (actualString !== String(expected).trim()) {
    throw new Error(`${rpcName} backend readback did not reflect intake source ${field}`);
  }
}

export function requireWebhookSourceMutationReadback(
  sourceReadback: Record<string, unknown>,
  directoryReadback: Record<string, unknown>,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  rpcName: string,
): void {
  for (const field of [
    'name',
    'source_identifier',
    'provider_type',
    'mapping_config_id',
    'sender_id',
    'rate_limit_per_hour',
    'enabled',
  ]) {
    if (Object.prototype.hasOwnProperty.call(args, field)) {
      requireWebhookSourceFieldReadback(sourceReadback, field, args[field], rpcName);
      requireWebhookSourceFieldReadback(directoryReadback, field, args[field], rpcName);
    }
  }
  if (asNonEmptyString(result.auth_token) && !asNonEmptyString(directoryReadback.auth_token_masked)) {
    throw new Error(`${rpcName} backend readback did not expose redacted intake source token state`);
  }
}

function webhookSourceArchivedAt(row: Record<string, unknown>): string | null {
  return asNonEmptyString(row.archived_at)
    ?? asNonEmptyString(objectRecord(row.managed_metadata).archived_at);
}

export function requireWebhookSourceArchiveReadback(
  sourceReadback: Record<string, unknown>,
  directoryReadback: Record<string, unknown>,
  rpcName: string,
): void {
  for (const row of [sourceReadback, directoryReadback]) {
    const enabled = booleanReadback(row.enabled);
    if (enabled !== false) {
      throw new Error(`${rpcName} backend readback did not disable archived intake source`);
    }
    const metadata = objectRecord(row.managed_metadata);
    const lifecycleState = asNonEmptyString(row.lifecycle_state)
      ?? asNonEmptyString(metadata.lifecycle);
    if (lifecycleState !== 'archived' && !webhookSourceArchivedAt(row)) {
      throw new Error(`${rpcName} backend readback did not expose intake source archive metadata`);
    }
  }
}

function resolveApiGatewaySourceId(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  rpcName: string,
): string {
  return requireLiveStringField(
    { ...args, ...result },
    ['source_id', 'webhook_source_id', 'id'],
    `${rpcName} did not return source_id`,
  );
}

function requireApiGatewayBooleanReadback(
  row: Record<string, unknown>,
  field: string,
  expected: boolean,
  rpcName: string,
  projection: string,
): void {
  const actual = booleanReadback(row[field]);
  if (actual !== expected) {
    throw new Error(`${rpcName} backend readback did not reflect ${projection}.${field}`);
  }
}

function requireApiGatewayNumberReadback(
  row: Record<string, unknown>,
  field: string,
  expected: number,
  rpcName: string,
  projection: string,
): void {
  const actual = Number(row[field]);
  if (!Number.isFinite(actual) || actual !== expected) {
    throw new Error(`${rpcName} backend readback did not reflect ${projection}.${field}`);
  }
}

async function requireApiGatewaySourceReadback(
  rpcName: string,
  sourceId: string,
  expected: { enabled?: boolean; rateLimitPerHour?: number },
): Promise<void> {
  const source = await requireLiveResourceReadback('webhook_sources', sourceId, rpcName);
  if (expected.enabled !== undefined) {
    requireApiGatewayBooleanReadback(source, 'enabled', expected.enabled, rpcName, 'webhook_sources');
  }
  if (expected.rateLimitPerHour !== undefined) {
    requireApiGatewayNumberReadback(
      source,
      'rate_limit_per_hour',
      expected.rateLimitPerHour,
      rpcName,
      'webhook_sources',
    );
  }

  const directoryRows = await requireLiveResourceListReadback(
    'webhook_source_directory',
    { id: sourceId },
    rpcName,
  );
  const directory = directoryRows.find((row) => asNonEmptyString(row.id) === sourceId) ?? directoryRows[0]!;

  if (expected.enabled !== undefined) {
    requireApiGatewayBooleanReadback(
      directory,
      'enabled',
      expected.enabled,
      rpcName,
      'webhook_source_directory',
    );
  }
  if (expected.rateLimitPerHour !== undefined) {
    requireApiGatewayNumberReadback(
      directory,
      'rate_limit_per_hour',
      expected.rateLimitPerHour,
      rpcName,
      'webhook_source_directory',
    );
  }
}

async function requireApiGatewayRateLimitSummaryReadback(
  sourceId: string,
  expectedLimitPerHour: number,
  rpcName: string,
): Promise<void> {
  const summaryRows = await requireLiveResourceListReadback(
    'api_gateway_rate_limits_summary',
    { source_id: sourceId },
    rpcName,
  );
  const summary = summaryRows.find((row) => asNonEmptyString(row.source_id) === sourceId) ?? summaryRows[0]!;
  requireApiGatewayNumberReadback(
    summary,
    'limit_per_hour',
    expectedLimitPerHour,
    rpcName,
    'api_gateway_rate_limits_summary',
  );
  const expectedLimitPerMin = Math.floor(expectedLimitPerHour / 60);
  requireApiGatewayNumberReadback(
    summary,
    'limit_per_min',
    expectedLimitPerMin,
    rpcName,
    'api_gateway_rate_limits_summary',
  );
}

export async function block_api_gateway_source_v1(
  args: BlockApiGatewaySourceArgs,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('block_api_gateway_source_v1', args, 'source');
  if (liveRpcTarget()) {
    const sourceId = resolveApiGatewaySourceId(result, args, 'block_api_gateway_source_v1');
    await requireApiGatewaySourceReadback('block_api_gateway_source_v1', sourceId, {
      enabled: false,
    });
  }
  return result;
}

function expectedApiGatewayLimitPerHour(args: AdjustApiGatewayRateLimitArgs): number {
  const perHour = Number(args.limit_per_hour);
  if (Number.isFinite(perHour)) return perHour;
  const perMin = Number(args.limit_per_min);
  if (Number.isFinite(perMin)) return perMin * 60;
  throw new Error('adjust_api_gateway_rate_limit_v1 requires limit_per_hour or limit_per_min');
}

export async function adjust_api_gateway_rate_limit_v1(
  args: AdjustApiGatewayRateLimitArgs,
): Promise<Record<string, unknown>> {
  const expectedLimitPerHour = expectedApiGatewayLimitPerHour(args);
  const result = await phaseC6Rpc('adjust_api_gateway_rate_limit_v1', args, 'source');
  if (liveRpcTarget()) {
    const sourceId = resolveApiGatewaySourceId(result, args, 'adjust_api_gateway_rate_limit_v1');
    await requireApiGatewaySourceReadback('adjust_api_gateway_rate_limit_v1', sourceId, {
      rateLimitPerHour: expectedLimitPerHour,
    });
    await requireApiGatewayRateLimitSummaryReadback(
      sourceId,
      expectedLimitPerHour,
      'adjust_api_gateway_rate_limit_v1',
    );
  }
  return result;
}

async function webhookSourceMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'webhook_source');
  if (liveRpcTarget()) {
    const sourceId = resolveWebhookSourceId(result, args);
    if (!sourceId) throw new Error(`${rpcName} did not return webhook_source_id`);
    const sourceReadback = await requireLiveResourceReadback('webhook_sources', sourceId, rpcName);
    const directoryReadback = await requireLiveResourceReadback('webhook_source_directory', sourceId, rpcName);
    requireWebhookSourceMutationReadback(sourceReadback, directoryReadback, args, result, rpcName);
  }
  return result;
}

export const ui_upsert_webhook_source_v1 = (args: UpsertWebhookSourceArgs) =>
  webhookSourceMutation('ui_upsert_webhook_source_v1', args);

export const ui_rotate_webhook_source_token_v1 = (args: { source_id: string }) =>
  webhookSourceMutation('ui_rotate_webhook_source_token_v1', args);

export async function ui_archive_webhook_source_v1(args: ArchiveWebhookSourceArgs) {
  const result = await phaseC6Rpc('ui_archive_webhook_source_v1', args, 'webhook_source');
  if (liveRpcTarget()) {
    const sourceId = resolveWebhookSourceId(result, args);
    if (!sourceId) throw new Error('ui_archive_webhook_source_v1 did not return webhook_source_id');
    const sourceReadback = await requireLiveResourceReadback('webhook_sources', sourceId, 'ui_archive_webhook_source_v1');
    const directoryReadback = await requireLiveResourceReadback('webhook_source_directory', sourceId, 'ui_archive_webhook_source_v1');
    requireWebhookSourceArchiveReadback(sourceReadback, directoryReadback, 'ui_archive_webhook_source_v1');
  }
  return result;
}

export async function ui_upsert_mapping_artifact_v1(
  args: UpsertMappingArtifactArgs,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>('ui_upsert_mapping_artifact_v1', {
    p_artifact: args,
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'ui_upsert_mapping_artifact_v1 returned no backend outcome');
    const outcomeError = backendOutcomeError(rec, 'ui_upsert_mapping_artifact_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(rec, [
      'mapping_config_id',
      'mapping_artifact_id',
      'artifact_id',
      'id',
    ], 'ui_upsert_mapping_artifact_v1 did not return backend mapping artifact evidence');
    const mappingConfigId =
      asNonEmptyString(rec.mapping_config_id) ??
      asNonEmptyString(args.mapping_config_id);
    if (!mappingConfigId) throw new Error('ui_upsert_mapping_artifact_v1 did not return mapping_config_id');
    await requireLiveResourceReadback('mapping_configs', mappingConfigId, 'ui_upsert_mapping_artifact_v1');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'ui_upsert_mapping_artifact_v1');
    return rec;
  }

  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'mapping_config');
}

export async function ui_create_mapping_operation_report_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>('ui_create_mapping_operation_report_v1', {
    p_report: args,
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'ui_create_mapping_operation_report_v1 returned no backend outcome');
    const outcomeError = backendOutcomeError(rec, 'ui_create_mapping_operation_report_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(rec, [
      'mapping_operation_report_id',
      'operation_report_id',
      'report_id',
      'id',
    ], 'ui_create_mapping_operation_report_v1 did not return backend report evidence');
    const reportId =
      asNonEmptyString(rec.mapping_operation_report_id) ??
      asNonEmptyString(rec.operation_report_id) ??
      asNonEmptyString(rec.report_id) ??
      asNonEmptyString(rec.id);
    if (!reportId) throw new Error('ui_create_mapping_operation_report_v1 did not return mapping_operation_report_id');
    await requireLiveResourceReadback('mapping_operation_reports', reportId, 'ui_create_mapping_operation_report_v1');
    return rec;
  }

  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'mapping_operation_report');
}

export async function mapping_config_promote_v1(
  args: { mapping_config_id: string; target_version?: number },
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('mapping_config_promote_v1', args, 'mapping_config');
  if (liveRpcTarget()) {
    const mappingConfigId =
      asNonEmptyString(result.mapping_config_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString(args.mapping_config_id);
    if (!mappingConfigId) throw new Error('mapping_config_promote_v1 did not return mapping_config_id');
    await requireLiveResourceReadback('mapping_configs', mappingConfigId, 'mapping_config_promote_v1');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'mapping_config_promote_v1');
  }
  return result;
}

export const ui_upsert_provider_auth_config_v1 = (args: UpsertProviderAuthConfigArgs) =>
  providerAuthConfigMutation('ui_upsert_provider_auth_config_v1', args);

export const ui_revoke_provider_auth_config_v1 = (args: { config_id: string; reason?: string | null }) =>
  providerAuthConfigMutation('ui_revoke_provider_auth_config_v1', args);

export const integration_plugin_rotate_credentials_v1 = (args: Record<string, unknown>) =>
  providerAuthConfigMutation('integration_plugin_rotate_credentials_v1', args);

export const integration_plugin_generate_draft_v1 = (args: IntegrationPluginGenerateDraftArgs) =>
  integrationPluginMutation('integration_plugin_generate_draft_v1', args);

export const integration_plugin_rollback_v1 = (args: {
  plugin_id: string;
  target_plugin_version_id?: string | null;
  reason?: string | null;
}) =>
  integrationPluginMutation('integration_plugin_rollback_v1', args, {
    approvalAction: 'rolled_back',
    requireBinding: true,
  });

export const plugin_deactivate_v1 = (args: {
  plugin_id: string;
  plugin_version_id?: string | null;
  reason?: string | null;
}) =>
  integrationPluginMutation('plugin_deactivate_v1', {
    ...args,
    expected_binding_enabled: false,
  }, {
    approvalAction: 'deactivated',
    requireBinding: true,
    requireBindingChangeCount: false,
    fallbackResourceKey: 'integration_plugin',
  });

export const plugin_submit_v1 = (args: PluginSubmitArgs) =>
  integrationPluginMutation('plugin_submit_v1', args, {
    approvalAction: 'submitted',
    fallbackResourceKey: 'integration_plugin_version',
  });

export const plugin_approve_v1 = (args: PluginApproveArgs) =>
  integrationPluginMutation('plugin_approve_v1', args, {
    approvalAction: args.decision,
    fallbackResourceKey: 'integration_plugin_version',
  });

export const plugin_activate_v1 = (args: PluginActivateArgs) =>
  integrationPluginMutation('plugin_activate_v1', args, {
    requireBinding: true,
    fallbackResourceKey: 'integration_plugin_version',
  });

export const plugin_set_binding_v1 = (args: PluginSetBindingArgs) =>
  integrationPluginMutation('plugin_set_binding_v1', args, {
    requireBinding: true,
    fallbackResourceKey: 'integration_plugin_version',
  });

function resolveWebhookInboxId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.webhook_inbox_id)
    ?? asNonEmptyString(rec.inbox_id)
    ?? asNonEmptyString(rec.id)
    ?? asNonEmptyString(args.webhook_inbox_id)
    ?? asNonEmptyString(args.inbox_id);
}

async function webhookInboxMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'webhook_inbox');
  if (liveRpcTarget()) {
    const inboxId = resolveWebhookInboxId(result, args);
    if (!inboxId) throw new Error(`${rpcName} did not return webhook_inbox_id`);
    await requireLiveResourceReadback('webhook_inbox', inboxId, rpcName);
    await requireLiveResourceReadback('webhook_inbox_directory', inboxId, rpcName);
  }
  return result;
}

export const webhook_inbox_replay_v1 = (args: WebhookInboxReplayArgs) =>
  webhookInboxMutation('webhook_inbox_replay_v1', args);

export const ui_retry_webhook_inbox_as_new_intake_v1 = async (
  args: WebhookInboxRetryAsNewIntakeArgs,
) => {
  const result = await phaseC6Rpc('ui_retry_webhook_inbox_as_new_intake_v1', args, 'webhook_inbox');
  if (liveRpcTarget()) {
    const originalInboxId = asNonEmptyString(result.webhook_inbox_id) ?? asNonEmptyString(args.webhook_inbox_id);
    if (!originalInboxId) throw new Error('ui_retry_webhook_inbox_as_new_intake_v1 did not return webhook_inbox_id');
    await requireLiveResourceReadback('webhook_inbox', originalInboxId, 'ui_retry_webhook_inbox_as_new_intake_v1');
    await requireLiveResourceReadback('webhook_inbox_directory', originalInboxId, 'ui_retry_webhook_inbox_as_new_intake_v1');
    const newInboxId = asNonEmptyString(result.new_webhook_inbox_id);
    if (newInboxId) {
      await requireLiveResourceReadback('webhook_inbox', newInboxId, 'ui_retry_webhook_inbox_as_new_intake_v1');
      await requireLiveResourceReadback('webhook_inbox_directory', newInboxId, 'ui_retry_webhook_inbox_as_new_intake_v1');
    }
  }
  return result;
};

export const webhook_inbox_force_status_v1 = (args: WebhookInboxForceStatusArgs) =>
  webhookInboxMutation('webhook_inbox_force_status_v1', args);
