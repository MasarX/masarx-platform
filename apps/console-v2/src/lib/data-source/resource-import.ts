import {
  backendOutcomeError,
  type EdgeStudioErrorEnvelope,
  hasConsoleLiveBackend,
  liveBackendUnavailableError,
  liveRpcTarget,
  nextCorrelationId,
  objectRecord,
  phaseC6Rpc,
  readFunctionErrorMessage,
  requireLiveResourceReadback,
  RESOURCE_IMPORT_PREPARE_READBACK_COUNT_KEYS,
  RESOURCE_IMPORT_PREPARE_READBACK_SUMMARY_KEYS,
  RESOURCE_IMPORT_STUDIO_FN,
  type ResourceDownloadUrlArgs,
  type ResourceDownloadUrlResult,
  type ResourceImportStudioCancelArgs,
  type ResourceImportStudioCancelResult,
  type ResourceImportStudioPrepareArgs,
  type ResourceImportStudioPrepareResult,
  type ResourceImportStudioStartArgs,
  type ResourceImportStudioStartResult,
  sleep,
} from '../data-source';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { getSupabaseClient } from '../supabase';
import { asNonEmptyString } from './shared';

function mergeResourceImportPrepareReadback(
  result: ResourceImportStudioPrepareResult,
  readback: Record<string, unknown>,
): ResourceImportStudioPrepareResult {
  const summary = objectRecord(readback.summary);
  const dryRun = objectRecord(result.dry_run);
  const mergedDryRun: Record<string, unknown> = {
    ...dryRun,
    id: readback.id ?? dryRun.id,
    run_id: readback.id ?? dryRun.run_id,
    resource_key: readback.resource_key ?? dryRun.resource_key,
    write_mode: readback.write_mode ?? dryRun.write_mode,
    source_format: readback.source_format ?? dryRun.source_format,
    source_file_name: readback.source_file_name ?? dryRun.source_file_name,
    header_fingerprint: readback.header_fingerprint ?? dryRun.header_fingerprint,
    sheet_name: readback.sheet_name ?? dryRun.sheet_name,
    status: readback.status ?? dryRun.status,
  };

  for (const key of RESOURCE_IMPORT_PREPARE_READBACK_COUNT_KEYS) {
    if (readback[key] !== undefined && readback[key] !== null) {
      mergedDryRun[key] = readback[key];
    }
  }
  for (const key of RESOURCE_IMPORT_PREPARE_READBACK_SUMMARY_KEYS) {
    if (summary[key] !== undefined && summary[key] !== null) {
      mergedDryRun[key] = summary[key];
    }
  }
  if (readback.rows !== undefined && readback.rows !== null) {
    mergedDryRun.rows = readback.rows;
  } else if (summary.rows_preview !== undefined && summary.rows_preview !== null) {
    mergedDryRun.rows = summary.rows_preview;
  }
  if (summary.related_node_summary !== undefined && summary.related_node_summary !== null) {
    mergedDryRun.related_nodes = summary.related_node_summary;
  }

  const summaryProfileMatch = objectRecord(summary.profile_match);
  const summaryAvailableProfiles = Array.isArray(summary.available_profiles) ? summary.available_profiles : null;
  const summaryResolvedRules = Array.isArray(summary.resolved_rules) ? summary.resolved_rules : null;

  return {
    ...result,
    dry_run: mergedDryRun,
    profile_match: Object.keys(summaryProfileMatch).length > 0 ? summaryProfileMatch : result.profile_match,
    available_profiles: summaryAvailableProfiles ?? result.available_profiles,
    resolved_rules: summaryResolvedRules ?? result.resolved_rules,
  };
}

async function requireLiveResourceImportPrepareReadback(
  result: ResourceImportStudioPrepareResult,
  args: ResourceImportStudioPrepareArgs,
): Promise<Record<string, unknown>> {
  const dryRun = objectRecord(result.dry_run);
  const runId = asNonEmptyString(dryRun.run_id)
    ?? asNonEmptyString(dryRun.id)
    ?? asNonEmptyString(result.run_id);
  if (!runId) throw new Error('resource-import-studio/prepare did not return run_id');
  const readback = await requireLiveResourceReadback('tabular_import_runs', runId, 'resource-import-studio/prepare');
  const status = String(readback.status ?? '').trim();
  if (status !== 'prepared') {
    throw new Error(`resource-import-studio/prepare backend readback status mismatch for tabular_import_runs:${runId}`);
  }
  const expectedResource = asNonEmptyString(dryRun.resource_key)
    ?? asNonEmptyString(args.resource_key);
  const actualResource = asNonEmptyString(readback.resource_key);
  if (expectedResource && actualResource && actualResource !== expectedResource) {
    throw new Error(`resource-import-studio/prepare backend readback resource mismatch for tabular_import_runs:${runId}`);
  }

  const profile = objectRecord(result.profile_match);
  const mappingConfigId = asNonEmptyString(profile.mapping_config_id)
    ?? asNonEmptyString(profile.id);
  if (mappingConfigId) {
    await requireLiveResourceReadback('mapping_configs', mappingConfigId, 'resource-import-studio/prepare');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'resource-import-studio/prepare');
  }
  return readback;
}

async function requireLiveResourceImportStartReadback(
  result: ResourceImportStudioStartResult,
  args: ResourceImportStudioStartArgs,
): Promise<void> {
  const run = objectRecord(result.run);
  const runId = asNonEmptyString(run.id)
    ?? asNonEmptyString(run.run_id)
    ?? asNonEmptyString(args.run_id);
  if (!runId) throw new Error('resource-import-studio/start did not return run_id');
  const readback = await requireLiveResourceReadback('tabular_import_runs', runId, 'resource-import-studio/start');
  const status = String(readback.status ?? run.status ?? '').trim();
  if (!['queued', 'processing', 'completed', 'completed_with_errors'].includes(status)) {
    throw new Error(`resource-import-studio/start backend readback status mismatch for tabular_import_runs:${runId}`);
  }
  if (['queued', 'processing'].includes(status) && !asNonEmptyString(readback.task_id) && !asNonEmptyString(run.task_id)) {
    throw new Error(`resource-import-studio/start backend readback missing task for tabular_import_runs:${runId}`);
  }

  const importJobId = asNonEmptyString(run.import_job_id)
    ?? asNonEmptyString(result.import_job_id)
    ?? asNonEmptyString(run.job_id)
    ?? asNonEmptyString(result.job_id);
  if (importJobId) {
    await requireLiveImportJobReadback('resource-import-studio/start', importJobId);
  }

  const profile = objectRecord(args.save_profile);
  const mappingConfigId = asNonEmptyString(run.mapping_config_id)
    ?? asNonEmptyString(result.mapping_config_id)
    ?? asNonEmptyString(profile.mapping_config_id)
    ?? asNonEmptyString(profile.id);
  if (mappingConfigId) {
    await requireLiveResourceReadback('mapping_configs', mappingConfigId, 'resource-import-studio/start');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'resource-import-studio/start');
  }
}

async function recoverLiveResourceImportStartReadback(
  args: ResourceImportStudioStartArgs,
  failureMessage: string,
): Promise<ResourceImportStudioStartResult | null> {
  const runId = asNonEmptyString(args.run_id);
  if (!runId || !hasConsoleLiveBackend()) return null;
  try {
    const readback = await requireLiveResourceReadback(
      'tabular_import_runs',
      runId,
      'resource-import-studio/start recovery',
    );
    const status = String(readback.status ?? '').trim();
    if (!['queued', 'processing', 'completed', 'completed_with_errors'].includes(status)) return null;
    if (['queued', 'processing'].includes(status) && !asNonEmptyString(readback.task_id)) return null;
    const result: ResourceImportStudioStartResult = {
      ok: true,
      run: {
        ...readback,
        id: asNonEmptyString(readback.id) ?? runId,
        recovered_from_edge_error: failureMessage,
      },
      report: objectRecord(readback.report),
      correlation_id: nextCorrelationId(),
    };
    await requireLiveResourceImportStartReadback(result, args);
    return result;
  } catch {
    return null;
  }
}

async function requireLiveResourceImportCancelReadback(
  result: ResourceImportStudioCancelResult,
  args: ResourceImportStudioCancelArgs,
): Promise<void> {
  const run = objectRecord(result.run);
  const runId = asNonEmptyString(run.id)
    ?? asNonEmptyString(run.run_id)
    ?? asNonEmptyString(args.run_id);
  if (!runId) throw new Error('resource-import-studio/cancel did not return run_id');
  const expectedReason = asNonEmptyString(args.reason);
  if (!expectedReason) throw new Error('resource-import-studio/cancel requires reason');
  const readback = await requireLiveResourceReadback(
    'tabular_import_runs',
    runId,
    'resource-import-studio/cancel',
  );
  const status = String(readback.status ?? run.status ?? '').trim();
  if (status !== 'canceled') {
    throw new Error(`resource-import-studio/cancel backend readback status mismatch for tabular_import_runs:${runId}`);
  }
  const summary = objectRecord(readback.summary);
  const cancellation = objectRecord(summary.cancellation);
  const actualReason = asNonEmptyString(cancellation.reason)
    ?? asNonEmptyString(summary.cancel_reason)
    ?? asNonEmptyString(summary.cancellation_reason);
  if (actualReason !== expectedReason) {
    throw new Error(`resource-import-studio/cancel backend readback reason mismatch for tabular_import_runs:${runId}`);
  }
}

async function readFunctionsErrorMessage(error: unknown, fallback: string): Promise<string> {
  let message = (error as { message?: string } | null)?.message || fallback;
  try {
    const ctx = (error as { context?: Response } | null)?.context;
    if (ctx && typeof ctx.json === 'function') {
      const envelope = (await ctx.json()) as EdgeStudioErrorEnvelope;
      message = envelope.error?.message || envelope.message || message;
    }
  } catch {
    // best-effort; keep original message
  }
  return message;
}

export async function resource_import_studio_prepare_v1(
  args: ResourceImportStudioPrepareArgs,
): Promise<ResourceImportStudioPrepareResult> {
  const client = getSupabaseClient();
  if (client) {
    const form = new FormData();
    form.append('action', 'prepare');
    form.append('file', args.file);
    form.append('resource_key', args.resource_key);
    form.append('write_mode', args.write_mode ?? 'create');
    form.append('rule_source', args.rule_source ?? 'auto');
    if (args.sheet_name) form.append('sheet_name', args.sheet_name);
    if (args.rules) form.append('rules', JSON.stringify(args.rules));
    if (args.row_overrides) form.append('row_overrides', JSON.stringify(args.row_overrides));
    if (args.scope_context) form.append('scope_context', JSON.stringify(args.scope_context));

    const { data, error } = await client.functions.invoke<ResourceImportStudioPrepareResult>(
      RESOURCE_IMPORT_STUDIO_FN,
      { body: form },
    );
    if (error) {
      throw new Error(await readFunctionsErrorMessage(error, `${RESOURCE_IMPORT_STUDIO_FN}/prepare failed`));
    }
    if (!data) throw new Error(`${RESOURCE_IMPORT_STUDIO_FN}/prepare returned no payload`);
    const readback = await requireLiveResourceImportPrepareReadback(data, args);
    return mergeResourceImportPrepareReadback(data, readback);
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('resource_import_studio_prepare_v1');
  await sleep(140);
  let rowCount = 0;
  try {
    const text = await args.file.text();
    rowCount = Math.max(0, text.split(/\r?\n/).filter((line) => line.trim()).length - 1);
  } catch {
    rowCount = 0;
  }
  const runId = '00000000-0000-4000-8000-' + String(Math.floor(Math.random() * 999999999999)).padStart(12, '0');
  return {
    ok: true,
    dry_run: {
      run_id: runId,
      resource_key: args.resource_key,
      write_mode: args.write_mode ?? 'create',
      total_rows: rowCount,
      valid_rows: rowCount,
      error_rows: 0,
      source_file_name: args.file.name,
    },
    profile_match: null,
    available_profiles: [],
    resolved_rules: [],
    correlation_id: nextCorrelationId(),
  };
}

export async function resource_import_studio_start_v1(
  args: ResourceImportStudioStartArgs,
): Promise<ResourceImportStudioStartResult> {
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.functions.invoke<ResourceImportStudioStartResult>(
      RESOURCE_IMPORT_STUDIO_FN,
      {
        body: {
          action: 'start',
          run_id: args.run_id,
          save_profile: args.save_profile ?? null,
        },
      },
    );
    if (error) {
      const message = await readFunctionsErrorMessage(error, `${RESOURCE_IMPORT_STUDIO_FN}/start failed`);
      const recovered = await recoverLiveResourceImportStartReadback(args, message);
      if (recovered) return recovered;
      throw new Error(message);
    }
    if (!data) throw new Error(`${RESOURCE_IMPORT_STUDIO_FN}/start returned no payload`);
    await requireLiveResourceImportStartReadback(data, args);
    return data;
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('resource_import_studio_start_v1');
  await sleep(120);
  return {
    ok: true,
    run: {
      id: args.run_id,
      status: 'queued',
      started_at: new Date().toISOString(),
    },
    report: null,
    correlation_id: nextCorrelationId(),
  };
}

export async function resource_import_studio_cancel_v1(
  args: ResourceImportStudioCancelArgs,
): Promise<ResourceImportStudioCancelResult> {
  const runId = asNonEmptyString(args.run_id);
  if (!runId) throw new Error('resource-import-studio/cancel requires run_id');
  const reason = asNonEmptyString(args.reason);
  if (!reason) throw new Error('resource-import-studio/cancel requires reason');

  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.functions.invoke<ResourceImportStudioCancelResult>(
      RESOURCE_IMPORT_STUDIO_FN,
      {
        body: {
          action: 'cancel',
          run_id: runId,
          reason,
        },
      },
    );
    if (error) {
      throw new Error(await readFunctionsErrorMessage(error, `${RESOURCE_IMPORT_STUDIO_FN}/cancel failed`));
    }
    if (!data) throw new Error(`${RESOURCE_IMPORT_STUDIO_FN}/cancel returned no payload`);
    await requireLiveResourceImportCancelReadback(data, { run_id: runId, reason });
    return data;
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('resource_import_studio_cancel_v1');
  await sleep(80);
  const now = new Date().toISOString();
  return {
    ok: true,
    run: {
      id: runId,
      status: 'canceled',
      canceled_at: now,
      completed_at: now,
      summary: {
        cancellation: {
          reason,
          canceled_at: now,
        },
        cancel_reason: reason,
      },
    },
    correlation_id: nextCorrelationId(),
  };
}

export async function resolve_resource_download_url_v1(
  args: ResourceDownloadUrlArgs,
): Promise<ResourceDownloadUrlResult> {
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.functions.invoke<ResourceDownloadUrlResult>(
      'ui-resource-download',
      { body: args },
    );
    if (error) {
      throw new Error(await readFunctionErrorMessage(error, 'ui-resource-download failed'));
    }
    const rec = objectRecord(data);
    const outcomeError = backendOutcomeError(rec, 'ui-resource-download was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const url = asNonEmptyString(rec.url);
    if (!url) {
      throw new Error('ui-resource-download returned no signed URL');
    }
    return {
      ...rec,
      url,
      expires_at: asNonEmptyString(rec.expires_at),
      file_name: asNonEmptyString(rec.file_name),
      mime_type: asNonEmptyString(rec.mime_type),
    };
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('resolve_resource_download_url_v1');
  throw new Error('resolve_resource_download_url_v1 requires a live backend download service');
}

// PLATFORM/imports — W16-5. Canonical write RPCs replacing the PREVIEW chip.
// Migrations of record:
//   • import_job_create_v1   202604301905
//   • import_job_cancel_v1   202604301905
// Both RPCs accept a single jsonb envelope (`p_args`) and return the canonical
// envelope `{ ok, import_job_id, status, correlation_id, settings_resolution_id }`.
export async function requireLiveImportJobReadback(
  rpcName: string,
  importJobId: string,
  expected?: { status?: string; cancelledReason?: string },
): Promise<void> {
  const job = await requireLiveResourceReadback('import_jobs', importJobId, rpcName);
  if (expected?.status && String(job.status ?? '') !== expected.status) {
    throw new Error(`${rpcName} backend readback status mismatch for import_jobs:${importJobId}`);
  }
  if (expected?.cancelledReason !== undefined) {
    const jobReason = String(job.cancelled_reason ?? '').trim();
    if (jobReason !== expected.cancelledReason) {
      throw new Error(`${rpcName} backend readback cancellation reason mismatch for import_jobs:${importJobId}`);
    }
  }
  const directory = await requireLiveResourceReadback('import_job_directory', importJobId, rpcName);
  if (expected?.status && String(directory.status ?? '') !== expected.status) {
    throw new Error(`${rpcName} backend readback status mismatch for import_job_directory:${importJobId}`);
  }
  if (expected?.cancelledReason !== undefined) {
    const directoryReason = String(directory.cancelled_reason ?? '').trim();
    if (directoryReason !== expected.cancelledReason) {
      throw new Error(`${rpcName} backend readback cancellation reason mismatch for import_job_directory:${importJobId}`);
    }
  }
}

function resolveImportJobId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.import_job_id)
    ?? asNonEmptyString(rec.job_id)
    ?? asNonEmptyString(rec.id)
    ?? asNonEmptyString(args.import_job_id)
    ?? asNonEmptyString(args.job_id)
    ?? asNonEmptyString(args.id);
}

export async function import_job_create_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('import_job_create_v1', args, 'import_job');
  if (liveRpcTarget()) {
    const importJobId = resolveImportJobId(result, args);
    if (!importJobId) throw new Error('import_job_create_v1 did not return import_job_id');
    await requireLiveImportJobReadback('import_job_create_v1', importJobId);
  }
  return result;
}

export async function import_job_cancel_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reason = asNonEmptyString(args.reason);
  if (!reason) throw new Error('import_job_cancel_v1 requires cancellation reason');
  const result = await phaseC6Rpc('import_job_cancel_v1', args, 'import_job');
  if (liveRpcTarget()) {
    const importJobId = resolveImportJobId(result, args);
    if (!importJobId) throw new Error('import_job_cancel_v1 did not return import_job_id');
    await requireLiveImportJobReadback('import_job_cancel_v1', importJobId, {
      status: 'cancelled',
      cancelledReason: reason,
    });
  }
  return result;
}
