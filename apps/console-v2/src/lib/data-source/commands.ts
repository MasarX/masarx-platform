import { asNonEmptyString } from './shared';
import {
  backendOutcomeError,
  backendReadbackFailureError,
  liveRpc,
  requireLiveRpcRecord,
  sleep,
  ui_get_resource_v1,
  ui_list_resource_complete,
} from '../data-source';

// ----------- Generic command runner -----------
function commandParamsRecord(params: unknown, dryRun: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = params && typeof params === 'object' && !Array.isArray(params)
    ? { ...(params as Record<string, unknown>) }
    : params === undefined
      ? {}
      : { value: params };
  if (base.dry_run === undefined) base.dry_run = dryRun;
  return base;
}

function commandSelectionIds(params: Record<string, unknown>): string[] {
  const raw = params.selected_ids ?? params.selection_ids ?? params.ids;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }
  const single = asNonEmptyString(params.selection_id ?? params.selected_id ?? params.id);
  return single ? [single] : [];
}

export async function runCommand(
  commandKey: string,
  params: unknown,
  opts: { dryRun?: boolean } = {},
): Promise<{
  ok: true;
  command: string;
  params: unknown;
  dry_run: boolean;
  settings_resolution_id: string;
  workflow_run_id: string;
}> {
  const dryRun = !!opts.dryRun;
  const liveParams = commandParamsRecord(params, dryRun);
  const selectedIds = commandSelectionIds(liveParams);
  const resourceKey =
    asNonEmptyString(liveParams.resource_key ?? liveParams.resourceKey ?? liveParams.resource) ??
    asNonEmptyString(commandKey.split('.')[0]) ??
    '';
  const selectionCount =
    typeof liveParams.selection_count === 'number' && Number.isFinite(liveParams.selection_count)
      ? liveParams.selection_count
      : selectedIds.length;
  const selectionId =
    asNonEmptyString(liveParams.selection_id ?? liveParams.selected_id) ??
    (selectedIds.length === 1 ? selectedIds[0]! : null);
  const live = await liveRpc<Record<string, unknown>>('ui_execute_command_v1', {
    p_action_key: commandKey,
    p_resource_key: resourceKey,
    p_selection_ids: selectedIds,
    p_selection_id: selectionId,
    p_selection_count: selectionCount,
    p_params: liveParams,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      `Command ${commandKey} returned no backend outcome`,
    );
    const outcomeError = backendOutcomeError(rec, `Command ${commandKey} failed`);
    if (outcomeError) throw outcomeError;
    const evidenceId =
      asNonEmptyString(rec.workflow_run_id) ??
      asNonEmptyString(rec.settings_resolution_id) ??
      asNonEmptyString(rec.correlation_id) ??
      asNonEmptyString(rec.label_job_id) ??
      asNonEmptyString(rec.job_id) ??
      asNonEmptyString(rec.task_id) ??
      asNonEmptyString(rec.event_id);
    if (!evidenceId) {
      throw new Error(`Command ${commandKey} did not return backend execution evidence`);
    }
    await requireCommandReadback(commandKey, rec, dryRun);
    return {
      ...rec,
      ok: true,
      command: String(rec.command ?? rec.action_key ?? commandKey),
      params,
      dry_run: Boolean(rec.dry_run ?? dryRun),
      settings_resolution_id: String(rec.settings_resolution_id ?? ''),
      workflow_run_id: String(rec.workflow_run_id ?? ''),
    };
  }

  await sleep(120);
  return {
    ok: true,
    command: commandKey,
    params,
    dry_run: dryRun,
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
    workflow_run_id: 'wfr_' + Date.now(),
  };
}

async function requireCommandReadback(
  commandKey: string,
  rec: Record<string, unknown>,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  if (commandKey !== 'shipments.print_labels') return;

  const labelJobId = asNonEmptyString(rec.label_job_id) ?? asNonEmptyString(rec.job_id);
  if (labelJobId) {
    const job = await ui_get_resource_v1<Record<string, unknown>>('label_jobs', labelJobId);
    if (!job) throw new Error('Command shipments.print_labels backend readback missing label_jobs');
    const jobError = backendReadbackFailureError(job, 'Command shipments.print_labels label job failed');
    if (jobError) throw jobError;
    return;
  }

  const workflowRunId = asNonEmptyString(rec.workflow_run_id);
  if (!workflowRunId) {
    throw new Error('Command shipments.print_labels did not return workflow_run_id or label_job_id');
  }

  const jobs = await ui_list_resource_complete<Record<string, unknown>>('label_jobs', {
    filter: { workflow_run_id: workflowRunId },
    sort: { key: 'created_at', dir: 'desc' },
    page_size: 25,
  });
  const failedJob = jobs.rows.find((job) => backendReadbackFailureError(job, 'Command shipments.print_labels label job failed'));
  if (failedJob) {
    throw backendReadbackFailureError(failedJob, 'Command shipments.print_labels label job failed');
  }

  const run = await ui_get_resource_v1<Record<string, unknown>>('workflow_runs', workflowRunId);
  if (!run) {
    throw new Error('Command shipments.print_labels backend readback missing workflow_runs or label_jobs');
  }
  const runError = backendReadbackFailureError(run, 'Command shipments.print_labels workflow failed');
  if (runError) throw runError;
  if (jobs.rows.length > 0) return;
}
