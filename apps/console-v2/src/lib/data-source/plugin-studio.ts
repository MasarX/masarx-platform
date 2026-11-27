import { translateAdapterMessage } from '../i18n';
import {
  backendOutcomeError,
  type EdgeStudioErrorEnvelope,
  liveBackendUnavailableError,
  nextCorrelationId,
  nextResourceId,
  objectRecord,
  PLUGIN_STUDIO_FN,
  type PluginStudioInferArgs,
  type PluginStudioInferResult,
  type PluginStudioNormalizedContract,
  type PluginStudioParseArgs,
  type PluginStudioParseResult,
  type PluginStudioPreviewArgs,
  type PluginStudioPreviewResult,
  type PluginStudioReview,
  type PluginStudioSaveArgs,
  type PluginStudioSaveMode,
  type PluginStudioSaveResult,
  type PluginStudioSourceType,
  requireLiveEvidence,
  requireLiveResourceReadback,
  sleep,
} from '../data-source';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { getSupabaseClient } from '../supabase';
import { asNonEmptyString } from './shared';

async function requireLivePluginStudioSaveReadback(
  result: PluginStudioSaveResult,
): Promise<void> {
  const saved = objectRecord(result.result);
  const report = objectRecord(result.report);
  const mappingConfigId = asNonEmptyString(saved.mapping_config_id)
    ?? asNonEmptyString(result.mapping_config_id);
  if (mappingConfigId) {
    await requireLiveResourceReadback('mapping_configs', mappingConfigId, 'integration-plugin-studio/save');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'integration-plugin-studio/save');
  }
  const pluginVersionId = asNonEmptyString(saved.plugin_version_id)
    ?? asNonEmptyString(result.plugin_version_id);
  if (pluginVersionId) {
    await requireLiveResourceReadback('integration_plugin_versions', pluginVersionId, 'integration-plugin-studio/save');
  }
  const pluginId = asNonEmptyString(saved.plugin_id)
    ?? asNonEmptyString(result.plugin_id);
  if (pluginId) {
    await requireLiveResourceReadback('integration_plugins', pluginId, 'integration-plugin-studio/save');
    await requireLiveResourceReadback('integration_plugin_directory', pluginId, 'integration-plugin-studio/save');
  }
  const reportId = asNonEmptyString(report.mapping_operation_report_id)
    ?? asNonEmptyString(report.operation_report_id)
    ?? asNonEmptyString(report.report_id)
    ?? asNonEmptyString(report.id)
    ?? asNonEmptyString(result.report_id);
  if (reportId) {
    await requireLiveResourceReadback('mapping_operation_reports', reportId, 'integration-plugin-studio/save');
  }
  if (!mappingConfigId && !pluginVersionId && !pluginId) {
    throw new Error('integration-plugin-studio/save did not return persisted artifact id for readback');
  }
}

async function invokeStudioStage<TBody extends Record<string, unknown>, TResult>(
  stage: 'parse' | 'infer' | 'preview' | 'save',
  body: TBody,
): Promise<TResult | null> {
  const client = getSupabaseClient();
  if (!client) {
    if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError(`edge ${PLUGIN_STUDIO_FN}/${stage}`);
    return null;
  }
  // Edge fn resolves the endpoint from the URL path. Supabase JS client builds
  // the URL as `${SUPABASE_URL}/functions/v1/${name}`, so we pass the stage as a
  // sub-path on the function name. The edge fn's `resolveEndpoint` accepts both
  // path-based and `body.action` forms; we set both to be defensive.
  const { data, error } = await client.functions.invoke<TResult>(`${PLUGIN_STUDIO_FN}/${stage}`, {
    body: { ...body, action: stage },
  });
  if (error) {
    // Supabase wraps non-2xx responses in FunctionsHttpError with the response
    // body available via `await error.context?.json()`. Surface the structured
    // edge envelope when available, otherwise fall back to the error message.
    let message = error.message || `integration-plugin-studio/${stage} failed`;
    try {
      const ctx = (error as unknown as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') {
        const envelope = (await ctx.json()) as EdgeStudioErrorEnvelope;
        message = envelope.error?.message || envelope.message || message;
      }
    } catch {
      // best-effort; keep original message
    }
    throw new Error(message);
  }
  if (!data) {
    throw new Error(`integration-plugin-studio/${stage} returned no payload`);
  }
  const rec = objectRecord(data);
  if (Object.keys(rec).length === 0) {
    throw new Error(`integration-plugin-studio/${stage} returned no payload`);
  }
  const outcomeError = backendOutcomeError(rec, `integration-plugin-studio/${stage} was rejected by the backend`);
  if (outcomeError) throw outcomeError;
  requireLiveEvidence(
    rec,
    ['correlation_id'],
    `integration-plugin-studio/${stage} did not return backend edge evidence`,
  );
  if (stage === 'save') {
    requireLiveEvidence(
      rec,
      ['result', 'report', 'plugin_version_id', 'mapping_config_id', 'report_id'],
      'integration-plugin-studio/save did not return backend save evidence',
    );
  }
  return data;
}

function buildSyntheticContract(args: PluginStudioParseArgs): PluginStudioNormalizedContract {
  const explicitKind = args.plugin_kind;
  if (args.source_type === 'curl') {
    const raw = typeof args.source_payload === 'string'
      ? args.source_payload
      : (args.source_payload as { curl?: string; raw?: string } | null)?.curl
        ?? (args.source_payload as { curl?: string; raw?: string } | null)?.raw
        ?? '';
    // Naive curl extraction for the demo branch — only recognizes URL + METHOD
    const urlMatch = /https?:\/\/[^\s'"]+/i.exec(raw);
    const url = urlMatch ? urlMatch[0] : 'https://example.invalid/path';
    let path = '/';
    try {
      path = new URL(url).pathname || '/';
    } catch {
      path = '/';
    }
    const methodMatch = /(?:-X|--request)\s+([A-Z]+)/.exec(raw);
    const method = (methodMatch?.[1] ?? 'POST').toUpperCase();
    return {
      source_type: 'curl',
      plugin_kind: explicitKind ?? 'api',
      route: {
        method,
        path_template: path,
        upstream_method: method,
        upstream_path_template: path,
      },
      sample_schema: { type: 'object', properties: {} },
      metadata: { source_url: url },
    };
  }
  if (args.source_type === 'webhook_sample') {
    const sample = (args.source_payload as { sample?: unknown; payload?: unknown } | null)?.sample
      ?? (args.source_payload as { sample?: unknown; payload?: unknown } | null)?.payload
      ?? args.source_payload
      ?? {};
    return {
      source_type: 'webhook_sample',
      plugin_kind: explicitKind ?? 'webhook',
      webhook: { sample_payload: sample },
      sample_schema: { type: 'object', properties: {} },
      metadata: {},
    };
  }
  if (args.source_type === 'openapi') {
    return {
      source_type: 'openapi',
      plugin_kind: explicitKind ?? 'api',
      route: { method: 'POST', path_template: '/', upstream_method: 'POST', upstream_path_template: '/' },
      sample_schema: { type: 'object', properties: {} },
      metadata: { document_kind: 'openapi' },
    };
  }
  return {
    source_type: 'manual',
    plugin_kind: explicitKind ?? 'webhook',
    webhook: { sample_payload: {} },
    sample_schema: { type: 'object', properties: {} },
    metadata: {},
  };
}

function buildSyntheticMapping(contract: PluginStudioNormalizedContract): Record<string, unknown> {
  return {
    version: 1,
    mode: 'deterministic',
    plugin_kind: contract.plugin_kind,
    fields: [
      { target_field: 'external_id', source_path: '$.id', confidence: 0.75, source: 'deterministic' },
      { target_field: 'event_type', source_path: '$.event', confidence: 0.75, source: 'deterministic' },
    ],
  };
}

function buildSyntheticReview(coerciveBlocking = 0): PluginStudioReview {
  return {
    mapping_config: { version: 1, fields: [] },
    coerced_preview: {},
    coercions: [],
    diagnostics: coerciveBlocking > 0
      ? [{
          level: 'error',
          blocking: true,
          code: 'demo_blocking',
          fieldPath: null,
          message: translateAdapterMessage('adapter.pluginBlockingDiagnostic'),
          why: 'In-memory mode; live mode returns real diagnostics from edge fn.',
          recommended_fix: 'Run against a live Supabase project to see real diagnostics.',
        }]
      : [],
    review_summary: {
      blocking_count: coerciveBlocking,
      warning_count: 0,
      coercion_count: 0,
      next_steps: [],
      egress_policy_resolution_id: null,
    },
  };
}

/**
 * Stage 1 — `parse`. Normalizes a raw source (curl text, OpenAPI doc, webhook
 * sample JSON, or manual config) into the canonical `normalized_contract` shape
 * and produces an initial deterministic mapping suggestion. Optionally persists
 * a draft plugin version when `persist_draft=true`.
 */
export async function plugin_studio_parse_v1(
  args: PluginStudioParseArgs,
): Promise<PluginStudioParseResult> {
  const live = await invokeStudioStage<typeof args, PluginStudioParseResult>('parse', args);
  if (live) return live;
  await sleep(160);
  const contract = buildSyntheticContract(args);
  return {
    ok: true,
    endpoint: 'parse',
    normalized_contract: contract,
    mapping_suggestion: buildSyntheticMapping(contract),
    draft: null,
    correlation_id: nextCorrelationId(),
  };
}

/**
 * Stage 2 — `infer`. Takes a normalized contract (or raw source) and produces a
 * mapping suggestion plus outbound operation suggestions for API plugins.
 */
export async function plugin_studio_infer_v1(
  args: PluginStudioInferArgs,
): Promise<PluginStudioInferResult> {
  const live = await invokeStudioStage<typeof args, PluginStudioInferResult>('infer', args);
  if (live) return live;
  await sleep(180);
  const contract = args.normalized_contract ?? buildSyntheticContract(args);
  return {
    ok: true,
    endpoint: 'infer',
    mapping_suggestion: buildSyntheticMapping(contract),
    outbound_suggestions: contract.plugin_kind === 'api'
      ? [{
          operation_name: 'forward_event',
          method: (contract.route as { method?: string } | undefined)?.method ?? 'POST',
          url_template: 'https://example-provider.invalid/',
          headers_template: { 'content-type': 'application/json' },
          body_template: { payload: '$.payload' },
          auth: { mode: 'bearer_token_header' },
          timeout_seconds: 30,
        }]
      : [],
    normalized_contract: contract,
    draft: null,
    correlation_id: nextCorrelationId(),
  };
}

/**
 * Stage 3 — `preview`. Validates a candidate mapping against the target schema,
 * resolves egress/header policy, returns blocking/non-blocking diagnostics,
 * coercions, and the recommended save mode (direct vs draft).
 */
export async function plugin_studio_preview_v1(
  args: PluginStudioPreviewArgs,
): Promise<PluginStudioPreviewResult> {
  const live = await invokeStudioStage<typeof args, PluginStudioPreviewResult>('preview', args);
  if (live) return live;
  await sleep(150);
  const contract = args.normalized_contract ?? buildSyntheticContract({
    source_type: (args.source_type ?? 'manual') as PluginStudioSourceType,
    source_payload: args.source_payload ?? {},
    plugin_kind: args.plugin_kind,
  });
  return {
    ok: true,
    endpoint: 'preview',
    artifact: args.artifact,
    normalized_contract: args.artifact === 'tabular_import' ? null : contract,
    mapping_suggestion: args.mapping_config ?? buildSyntheticMapping(contract),
    review: buildSyntheticReview(),
    save_modes: {
      direct_allowed: args.artifact !== 'integration_plugin',
      draft_allowed: args.artifact !== 'tabular_import',
      recommended: args.artifact === 'integration_plugin' ? 'draft' : 'direct',
    },
    correlation_id: nextCorrelationId(),
  };
}

/**
 * Stage 4 — `save`. Persists the artifact (draft for `integration_plugin` via
 * `integration_plugin_generate_draft_v1`; direct for tabular/webhook/api via
 * `ui_upsert_mapping_artifact_v1`) and writes a canonical operation report
 * through `ui_create_mapping_operation_report_v1`.
 *
 * Throws when blocking diagnostics exist or no eligible save mode is available
 * (the edge fn returns 400/403 with a structured error envelope which is
 * surfaced as `Error.message` here).
 */
export async function plugin_studio_save_v1(
  args: PluginStudioSaveArgs,
): Promise<PluginStudioSaveResult> {
  const live = await invokeStudioStage<typeof args, PluginStudioSaveResult>('save', args);
  if (live) {
    await requireLivePluginStudioSaveReadback(live);
    return live;
  }
  await sleep(220);
  const contract = args.normalized_contract ?? buildSyntheticContract({
    source_type: (args.source_type ?? 'manual') as PluginStudioSourceType,
    source_payload: args.source_payload ?? {},
    plugin_kind: args.plugin_kind,
  });
  const recommendedMode: PluginStudioSaveMode = args.save_mode
    ?? (args.artifact === 'integration_plugin' ? 'draft' : 'direct');
  return {
    ok: true,
    endpoint: 'save',
    artifact: args.artifact,
    save_mode: recommendedMode,
    normalized_contract: args.artifact === 'tabular_import' ? null : contract,
    review: buildSyntheticReview(),
    result: {
      primary_resource_type: args.artifact,
      primary_resource_id: nextResourceId('art'),
      mapping_config_id: nextResourceId('mc'),
      ...(args.artifact === 'integration_plugin'
        ? { plugin_id: nextResourceId('plg'), plugin_version_id: nextResourceId('pv') }
        : {}),
    },
    report: {
      report_id: nextResourceId('rep'),
      status: 'succeeded',
    },
    correlation_id: nextCorrelationId(),
  };
}
