import {
  backendOutcomeError,
  liveRpc,
  nextCorrelationId,
  nextResourceId,
  requireLiveEvidence,
  requireLiveResourceReadback,
  requireLiveRpcRecord,
  sleep,
  type RunPluginTestResult,
} from '../data-source';
import { asNonEmptyString } from './shared';

export async function runPluginTest(
  pluginId: string,
  payload: unknown,
  pluginVersionId?: string | null,
): Promise<RunPluginTestResult> {
  const args: Record<string, unknown> = {
    plugin_id: pluginId,
    payload: payload ?? {},
  };
  if (typeof pluginVersionId === 'string' && pluginVersionId.trim()) {
    args.plugin_version_id = pluginVersionId.trim();
  }
  const live = await liveRpc<RunPluginTestResult>('test_integration_plugin_v1', { p_args: args });
  if (live) {
    const result = requireLiveRpcRecord(
      live.data,
      'test_integration_plugin_v1 returned no backend outcome',
    ) as RunPluginTestResult;
    const outcomeError = backendOutcomeError(result, 'test_integration_plugin_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(result, [
      'validation_run_id',
      'integration_plugin_validation_run_id',
      'plugin_validation_run_id',
    ], 'test_integration_plugin_v1 did not return backend validation evidence');
    const validationRunId = asNonEmptyString(result.validation_run_id)
      ?? asNonEmptyString(result.integration_plugin_validation_run_id)
      ?? asNonEmptyString(result.plugin_validation_run_id);
    if (!validationRunId) {
      throw new Error('test_integration_plugin_v1 did not return validation_run_id');
    }
    await requireLiveResourceReadback(
      'integration_plugin_validation_runs',
      validationRunId,
      'test_integration_plugin_v1',
    );
    if (!Array.isArray(result.steps) || result.steps.length === 0) {
      throw new Error('test_integration_plugin_v1 did not return backend trace steps');
    }
    return {
      ok: true,
      plugin_id: result.plugin_id ?? pluginId,
      plugin_version_id: result.plugin_version_id,
      validation_run_id: validationRunId,
      duration_ms: result.duration_ms ?? 0,
      steps: result.steps ?? [],
      correlation_id: result.correlation_id,
      settings_resolution_id: result.settings_resolution_id,
    };
  }
  // In-memory branch: deterministic trace mirroring the canonical RPC shape.
  await sleep(420);
  const duration = 420 + Math.floor(Math.random() * 80);
  return {
    ok: true,
    plugin_id: pluginId,
    plugin_version_id: `pv_${pluginId}_demo`,
    validation_run_id: nextResourceId('vr'),
    duration_ms: duration,
    steps: [
      { name: 'verify_signature', ok: true, ms: 12, signature_required: true },
      { name: 'parse_payload', ok: true, ms: 24, payload_size: JSON.stringify(payload ?? {}).length },
      { name: 'apply_mapping', ok: true, ms: 88, mapping_present: true },
      { name: 'validate_schema', ok: true, ms: 31, plugin_kind: 'webhook' },
      { name: 'bind_workflow', ok: true, ms: 56, workflow_template_active: true },
      { name: 'respond', ok: true, ms: 14, plugin_status: 'active' },
    ],
    correlation_id: nextCorrelationId(),
    settings_resolution_id: 'srlv_demo',
  };
}
