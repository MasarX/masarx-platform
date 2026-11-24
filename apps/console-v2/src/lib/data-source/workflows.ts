import { translateAdapterMessage } from '../i18n';
import {
  _runStepCache,
  firstRpcRow,
  liveRpc,
  loadLiveWorkflowTemplateId,
  looksLikeUuid,
  requireLiveMutationResult,
  requireLiveResourceListReadback,
  requireLiveResourceReadback,
  requireLiveStringField,
  seed,
  sleep,
  type SyntheticRunStep,
  ui_list_resource_v1,
  type UiLogEventOptions,
  type UiLogEventResult,
  type WorkflowRunStartContext,
  type WorkflowRunTriggerCreateResult,
  type WorkflowRunTriggerDeleteResult,
  type WorkflowRunTriggerUpdateResult,
  type WorkflowScheduleCreateResult,
  type WorkflowScheduleRunNowResult,
  type WorkflowScheduleTaskPayloadRepairResult,
} from '../data-source';
import { getSupabaseClient } from '../supabase';
import { asNonEmptyString } from './shared';

function normalizeUiLogEventPayload(eventJson: unknown): Record<string, unknown> {
  const source: Record<string, unknown> = eventJson && typeof eventJson === 'object' && !Array.isArray(eventJson)
    ? { ...(eventJson as Record<string, unknown>) }
    : { type: 'ui.event', meta: { value: eventJson } };
  const type = asNonEmptyString(source.type)
    ?? asNonEmptyString(source.kind)
    ?? asNonEmptyString(source.event)
    ?? asNonEmptyString(source.name)
    ?? 'ui.event';
  const payload = source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
    ? source.payload as Record<string, unknown>
    : {};
  const meta = source.meta && typeof source.meta === 'object' && !Array.isArray(source.meta)
    ? { ...(source.meta as Record<string, unknown>) }
    : {};

  Object.entries(payload).forEach(([key, value]) => {
    if (meta[key] === undefined) meta[key] = value;
  });
  if (source.correlation_id !== undefined && meta.correlation_id === undefined) {
    meta.correlation_id = source.correlation_id;
  }

  return {
    ...source,
    type,
    name: asNonEmptyString(source.name) ?? type,
    meta,
  };
}

export async function ui_log_event_v1(
  eventJson: unknown,
  app: string = 'console',
  options: UiLogEventOptions = {},
): Promise<UiLogEventResult> {
  const client = getSupabaseClient();
  const loggedAt = new Date().toISOString();
  if (client) {
    try {
      const auth = (client as unknown as {
        auth?: { getSession?: () => Promise<{ data?: { session?: unknown | null } | null }> };
      }).auth;
      if (typeof auth?.getSession === 'function') {
        const { data } = await auth.getSession();
        if (!data?.session) {
          if (options.requireReadback) {
            throw new Error('ui_log_event_v1 backend readback requires an authenticated session');
          }
          return { ok: true, app, logged_at: loggedAt };
        }
      }
      const result = await client.rpc('ui_log_event_v1', {
        p_event: normalizeUiLogEventPayload(eventJson),
        p_app: app,
      } as never);
      if (result.error) {
        throw new Error(result.error.message ?? 'ui_log_event_v1 failed');
      }
      const row = firstRpcRow<Record<string, unknown>>(result.data);
      const eventId =
        asNonEmptyString(result.data) ??
        asNonEmptyString(row?.id) ??
        asNonEmptyString(row?.event_id);
      if (options.requireReadback) {
        if (!eventId) {
          throw new Error('ui_log_event_v1 did not return ui_event_log id for backend readback');
        }
        const readback = await requireLiveResourceReadback(
          'ui_event_log_directory',
          eventId,
          'ui_log_event_v1',
        );
        return { ok: true, app, logged_at: loggedAt, event_id: eventId, readback };
      }
      return { ok: true, app, logged_at: loggedAt, event_id: eventId ?? null };
    } catch (err) {
      if (options.requireReadback) {
        throw err instanceof Error
          ? err
          : new Error('ui_log_event_v1 backend readback failed');
      }
      // Swallow telemetry errors; envelope still returned.
    }
  }
  if (options.requireReadback) {
    throw new Error('ui_log_event_v1 backend readback requires a live backend');
  }
  return { ok: true, app, logged_at: loggedAt };
}

export async function ui_create_workflow_schedule_trigger_v1(args: {
  workflow_template_id: string;
  schedule: Record<string, unknown>;
  context_patch?: Record<string, unknown>;
  enabled?: boolean;
  notes?: string | null;
}): Promise<WorkflowScheduleCreateResult> {
  const workflowTemplateId = asNonEmptyString(args.workflow_template_id);
  if (!workflowTemplateId) throw new Error('workflow_template_id is required');
  const schedule = args.schedule && typeof args.schedule === 'object' ? args.schedule : {};
  const contextPatch = args.context_patch && typeof args.context_patch === 'object' ? args.context_patch : {};
  const enabled = args.enabled !== false;
  const notes = asNonEmptyString(args.notes);

  const live = await liveRpc<Record<string, unknown>>('ui_create_workflow_schedule_trigger_v1', {
    p_workflow_template_id: workflowTemplateId,
    p_schedule: schedule,
    p_context_patch: contextPatch,
    p_enabled: enabled,
    p_notes: notes ?? null,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_create_workflow_schedule_trigger_v1', [
      'workflow_schedule_trigger_id',
    ]);
    const triggerId = asNonEmptyString(rec.workflow_schedule_trigger_id);
    if (!triggerId) {
      throw new Error('ui_create_workflow_schedule_trigger_v1 did not return workflow_schedule_trigger_id');
    }
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_schedule_triggers',
      triggerId,
      'ui_create_workflow_schedule_trigger_v1',
    );
    if (asNonEmptyString(triggerReadback.workflow_template_id) !== workflowTemplateId) {
      throw new Error('ui_create_workflow_schedule_trigger_v1 backend readback did not match workflow_template_id');
    }
    if (!asNonEmptyString(triggerReadback.next_run_at)) {
      throw new Error('ui_create_workflow_schedule_trigger_v1 backend readback missing workflow_schedule_triggers.next_run_at');
    }
    return {
      ...rec,
      ok: true,
      status: String(rec.status ?? 'created'),
      workflow_schedule_trigger_id: triggerId,
      workflow_template_id: asNonEmptyString(triggerReadback.workflow_template_id) ?? workflowTemplateId,
      schedule: (triggerReadback.schedule ?? schedule) as Record<string, unknown>,
      context_patch: (triggerReadback.context_patch ?? contextPatch) as Record<string, unknown>,
      scope_type: asNonEmptyString(triggerReadback.scope_type) ?? null,
      scope_id: asNonEmptyString(triggerReadback.scope_id) ?? null,
      enabled: Boolean(triggerReadback.enabled),
      next_run_at: asNonEmptyString(triggerReadback.next_run_at) ?? null,
      notes: asNonEmptyString(triggerReadback.notes) ?? notes ?? null,
    };
  }

  await ui_log_event_v1({
    event: 'workflow_schedule_trigger.create',
    workflow_template_id: workflowTemplateId,
    schedule,
    enabled,
  });
  return {
    ok: true,
    status: 'seed_preview',
    workflow_schedule_trigger_id: `wst_schedule_${Date.now()}`,
    workflow_template_id: workflowTemplateId,
    schedule,
    context_patch: contextPatch,
    scope_type: null,
    scope_id: null,
    enabled,
    next_run_at: null,
    notes: notes ?? null,
  };
}

export async function ui_create_workflow_run_trigger_v1(args: {
  source_workflow_template_id: string;
  target_workflow_template_id: string;
  source_statuses?: string[] | null;
  context_patch?: Record<string, unknown>;
  enabled?: boolean;
  notes?: string | null;
  scope_id?: string | null;
}): Promise<WorkflowRunTriggerCreateResult> {
  const sourceTemplateId = asNonEmptyString(args.source_workflow_template_id);
  const targetTemplateId = asNonEmptyString(args.target_workflow_template_id);
  if (!sourceTemplateId) throw new Error('source_workflow_template_id is required');
  if (!targetTemplateId) throw new Error('target_workflow_template_id is required');
  if (sourceTemplateId === targetTemplateId) {
    throw new Error('source and target workflow templates must differ');
  }
  const sourceStatuses = Array.isArray(args.source_statuses)
    ? args.source_statuses.map((status) => asNonEmptyString(status)).filter(Boolean) as string[]
    : [];
  const contextPatch = args.context_patch && typeof args.context_patch === 'object' ? args.context_patch : {};
  const enabled = args.enabled !== false;
  const notes = asNonEmptyString(args.notes);
  const scopeId = asNonEmptyString(args.scope_id);

  const live = await liveRpc<Record<string, unknown>>('ui_create_workflow_run_trigger_v1', {
    p_source_workflow_template_id: sourceTemplateId,
    p_target_workflow_template_id: targetTemplateId,
    p_source_statuses: sourceStatuses.length ? sourceStatuses : null,
    p_context_patch: contextPatch,
    p_enabled: enabled,
    p_notes: notes ?? null,
    p_scope_id: scopeId ?? null,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_create_workflow_run_trigger_v1', [
      'workflow_run_trigger_id',
    ]);
    const triggerId = asNonEmptyString(rec.workflow_run_trigger_id);
    if (!triggerId) {
      throw new Error('ui_create_workflow_run_trigger_v1 did not return workflow_run_trigger_id');
    }
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_run_triggers',
      triggerId,
      'ui_create_workflow_run_trigger_v1',
    );
    if (asNonEmptyString(triggerReadback.source_workflow_template_id) !== sourceTemplateId) {
      throw new Error('ui_create_workflow_run_trigger_v1 backend readback did not match source_workflow_template_id');
    }
    if (asNonEmptyString(triggerReadback.target_workflow_template_id) !== targetTemplateId) {
      throw new Error('ui_create_workflow_run_trigger_v1 backend readback did not match target_workflow_template_id');
    }
    const readbackStatuses = Array.isArray(triggerReadback.source_statuses)
      ? triggerReadback.source_statuses.map((status) => String(status))
      : sourceStatuses;
    if (readbackStatuses.length === 0) {
      throw new Error('ui_create_workflow_run_trigger_v1 backend readback missing workflow_run_triggers.source_statuses');
    }
    if (scopeId && asNonEmptyString(triggerReadback.scope_id) !== scopeId) {
      throw new Error('ui_create_workflow_run_trigger_v1 backend readback did not match active tenant scope_id');
    }
    return {
      ...rec,
      ok: true,
      status: String(rec.status ?? 'created'),
      workflow_run_trigger_id: triggerId,
      source_workflow_template_id: asNonEmptyString(triggerReadback.source_workflow_template_id) ?? sourceTemplateId,
      target_workflow_template_id: asNonEmptyString(triggerReadback.target_workflow_template_id) ?? targetTemplateId,
      source_statuses: readbackStatuses,
      context_patch: (triggerReadback.context_patch ?? contextPatch) as Record<string, unknown>,
      scope_type: asNonEmptyString(triggerReadback.scope_type) ?? null,
      scope_id: asNonEmptyString(triggerReadback.scope_id) ?? null,
      enabled: Boolean(triggerReadback.enabled),
      notes: asNonEmptyString(triggerReadback.notes) ?? notes ?? null,
    };
  }

  await ui_log_event_v1({
    event: 'workflow_run_trigger.create',
    source_workflow_template_id: sourceTemplateId,
    target_workflow_template_id: targetTemplateId,
    source_statuses: sourceStatuses,
    enabled,
  });
  return {
    ok: true,
    status: 'seed_preview',
    workflow_run_trigger_id: `wrt_trigger_${Date.now()}`,
    source_workflow_template_id: sourceTemplateId,
    target_workflow_template_id: targetTemplateId,
    source_statuses: sourceStatuses.length ? sourceStatuses : ['succeeded'],
    context_patch: contextPatch,
    scope_type: null,
    scope_id: null,
    enabled,
    notes: notes ?? null,
  };
}

export async function ui_update_workflow_run_trigger_v1(args: {
  workflow_run_trigger_id: string;
  source_workflow_template_id?: string | null;
  target_workflow_template_id?: string | null;
  source_statuses?: string[] | null;
  context_patch?: Record<string, unknown>;
  enabled?: boolean;
  notes?: string | null;
  scope_id?: string | null;
}): Promise<WorkflowRunTriggerUpdateResult> {
  const triggerId = asNonEmptyString(args.workflow_run_trigger_id);
  if (!triggerId) throw new Error('workflow_run_trigger_id is required');
  const sourceTemplateId = asNonEmptyString(args.source_workflow_template_id);
  const targetTemplateId = asNonEmptyString(args.target_workflow_template_id);
  if (sourceTemplateId && targetTemplateId && sourceTemplateId === targetTemplateId) {
    throw new Error('source and target workflow templates must differ');
  }
  const sourceStatuses = Array.isArray(args.source_statuses)
    ? args.source_statuses.map((status) => asNonEmptyString(status)).filter(Boolean) as string[]
    : null;
  const contextPatch = args.context_patch && typeof args.context_patch === 'object' ? args.context_patch : undefined;
  const notes = args.notes === undefined ? undefined : asNonEmptyString(args.notes) ?? '';
  const scopeId = asNonEmptyString(args.scope_id);

  const live = await liveRpc<Record<string, unknown>>('ui_update_workflow_run_trigger_v1', {
    p_workflow_run_trigger_id: triggerId,
    p_source_workflow_template_id: sourceTemplateId ?? null,
    p_target_workflow_template_id: targetTemplateId ?? null,
    p_source_statuses: sourceStatuses && sourceStatuses.length ? sourceStatuses : null,
    p_context_patch: contextPatch ?? null,
    p_enabled: typeof args.enabled === 'boolean' ? args.enabled : null,
    p_notes: notes === undefined ? null : notes,
    p_scope_id: scopeId ?? null,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_update_workflow_run_trigger_v1', [
      'workflow_run_trigger_id',
    ]);
    const resultTriggerId = asNonEmptyString(rec.workflow_run_trigger_id);
    if (resultTriggerId !== triggerId) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback returned a different trigger id');
    }
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_run_triggers',
      triggerId,
      'ui_update_workflow_run_trigger_v1',
    );
    if (asNonEmptyString(triggerReadback.deleted_at)) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback returned a deleted workflow trigger');
    }
    if (sourceTemplateId && asNonEmptyString(triggerReadback.source_workflow_template_id) !== sourceTemplateId) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback did not match source_workflow_template_id');
    }
    if (targetTemplateId && asNonEmptyString(triggerReadback.target_workflow_template_id) !== targetTemplateId) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback did not match target_workflow_template_id');
    }
    const readbackStatuses = Array.isArray(triggerReadback.source_statuses)
      ? triggerReadback.source_statuses.map((status) => String(status))
      : [];
    if (sourceStatuses && sourceStatuses.length && readbackStatuses.length === 0) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback missing workflow_run_triggers.source_statuses');
    }
    if (typeof args.enabled === 'boolean' && Boolean(triggerReadback.enabled) !== args.enabled) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback did not match enabled');
    }
    if (scopeId && asNonEmptyString(triggerReadback.scope_id) !== scopeId) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback did not match active tenant scope_id');
    }
    return {
      ...rec,
      ok: true,
      status: String(rec.status ?? 'updated'),
      workflow_run_trigger_id: triggerId,
      source_workflow_template_id: asNonEmptyString(triggerReadback.source_workflow_template_id) ?? sourceTemplateId ?? null,
      target_workflow_template_id: asNonEmptyString(triggerReadback.target_workflow_template_id) ?? targetTemplateId ?? null,
      source_statuses: readbackStatuses,
      context_patch: (triggerReadback.context_patch ?? contextPatch ?? {}) as Record<string, unknown>,
      scope_type: asNonEmptyString(triggerReadback.scope_type) ?? null,
      scope_id: asNonEmptyString(triggerReadback.scope_id) ?? null,
      enabled: Boolean(triggerReadback.enabled),
      notes: asNonEmptyString(triggerReadback.notes) ?? null,
      updated_at: asNonEmptyString(triggerReadback.updated_at) ?? null,
    };
  }

  await ui_log_event_v1({
    event: 'workflow_run_trigger.update',
    workflow_run_trigger_id: triggerId,
    enabled: args.enabled,
  });
  return {
    ok: true,
    status: 'seed_preview',
    workflow_run_trigger_id: triggerId,
    source_workflow_template_id: sourceTemplateId ?? null,
    target_workflow_template_id: targetTemplateId ?? null,
    source_statuses: sourceStatuses?.length ? sourceStatuses : ['succeeded'],
    context_patch: contextPatch ?? {},
    scope_type: null,
    scope_id: null,
    enabled: args.enabled ?? true,
    notes: notes ?? null,
    updated_at: new Date().toISOString(),
  };
}

export async function ui_delete_workflow_run_trigger_v1(
  workflowRunTriggerId: string,
  scopeIdArg?: string | null,
): Promise<WorkflowRunTriggerDeleteResult> {
  const triggerId = asNonEmptyString(workflowRunTriggerId);
  if (!triggerId) throw new Error('workflow_run_trigger_id is required');
  const scopeId = asNonEmptyString(scopeIdArg);

  const live = await liveRpc<Record<string, unknown>>('ui_delete_workflow_run_trigger_v1', {
    p_workflow_run_trigger_id: triggerId,
    p_scope_id: scopeId ?? null,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_delete_workflow_run_trigger_v1', [
      'workflow_run_trigger_id',
    ]);
    const resultTriggerId = asNonEmptyString(rec.workflow_run_trigger_id);
    if (resultTriggerId !== triggerId) {
      throw new Error('ui_delete_workflow_run_trigger_v1 backend readback returned a different trigger id');
    }
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_run_triggers',
      triggerId,
      'ui_delete_workflow_run_trigger_v1',
    );
    if (triggerReadback.enabled) {
      throw new Error('ui_delete_workflow_run_trigger_v1 backend readback did not disable the workflow trigger');
    }
    if (!asNonEmptyString(triggerReadback.deleted_at)) {
      throw new Error('ui_delete_workflow_run_trigger_v1 backend readback missing workflow_run_triggers.deleted_at');
    }
    if (scopeId && asNonEmptyString(triggerReadback.scope_id) !== scopeId) {
      throw new Error('ui_delete_workflow_run_trigger_v1 backend readback did not match active tenant scope_id');
    }
    return {
      ...rec,
      ok: true,
      status: String(rec.status ?? 'deleted'),
      workflow_run_trigger_id: triggerId,
      source_workflow_template_id: asNonEmptyString(rec.source_workflow_template_id) ?? null,
      target_workflow_template_id: asNonEmptyString(rec.target_workflow_template_id) ?? null,
      scope_type: asNonEmptyString(rec.scope_type) ?? null,
      scope_id: asNonEmptyString(rec.scope_id) ?? null,
      enabled: Boolean(triggerReadback.enabled),
      deleted_at: asNonEmptyString(triggerReadback.deleted_at) ?? asNonEmptyString(rec.deleted_at) ?? null,
      workflow_trigger_fires_count: Number(rec.workflow_trigger_fires_count ?? 0),
    };
  }

  await ui_log_event_v1({
    event: 'workflow_run_trigger.delete',
    workflow_run_trigger_id: triggerId,
  });
  return {
    ok: true,
    status: 'seed_preview',
    workflow_run_trigger_id: triggerId,
    source_workflow_template_id: null,
    target_workflow_template_id: null,
    scope_type: null,
    scope_id: null,
    enabled: false,
    workflow_trigger_fires_count: 0,
  };
}

export async function ui_run_workflow_schedule_trigger_v1(
  workflowScheduleTriggerId: string,
): Promise<WorkflowScheduleRunNowResult> {
  const triggerId = asNonEmptyString(workflowScheduleTriggerId);
  if (!triggerId) throw new Error('workflow_schedule_trigger_id is required');

  const live = await liveRpc<Record<string, unknown>>('ui_run_workflow_schedule_trigger_v1', {
    p_workflow_schedule_trigger_id: triggerId,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_run_workflow_schedule_trigger_v1', [
      'workflow_schedule_trigger_id',
      'workflow_template_id',
    ]);
    const workflowRunId = asNonEmptyString(rec.workflow_run_id);
    const status = String(rec.status ?? 'workflow_started');
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_schedule_triggers',
      triggerId,
      'ui_run_workflow_schedule_trigger_v1',
    );
    if (status === 'preflight_failed') {
      const lastError = asNonEmptyString(triggerReadback.last_error) ?? asNonEmptyString(rec.last_error);
      if (!lastError) {
        throw new Error('ui_run_workflow_schedule_trigger_v1 preflight readback missing workflow_schedule_triggers.last_error');
      }
      return {
        ...rec,
        ok: true,
        status,
        workflow_schedule_trigger_id: String(rec.workflow_schedule_trigger_id ?? triggerId),
        workflow_template_id: asNonEmptyString(rec.workflow_template_id) ?? null,
        workflow_run_id: null,
        last_run_at: null,
        last_error: lastError,
        last_error_at: asNonEmptyString(triggerReadback.last_error_at) ?? asNonEmptyString(rec.last_error_at) ?? null,
      };
    }
    if (!workflowRunId) {
      throw new Error('ui_run_workflow_schedule_trigger_v1 did not return workflow_run_id');
    }
    const lastRunId = asNonEmptyString(triggerReadback.last_run_id);
    if (lastRunId !== workflowRunId) {
      throw new Error('ui_run_workflow_schedule_trigger_v1 backend readback did not update workflow_schedule_triggers.last_run_id');
    }
    if (!asNonEmptyString(triggerReadback.last_run_at)) {
      throw new Error('ui_run_workflow_schedule_trigger_v1 backend readback did not update workflow_schedule_triggers.last_run_at');
    }
    const runReadback = await requireLiveResourceReadback(
      'workflow_runs',
      workflowRunId,
      'ui_run_workflow_schedule_trigger_v1',
    );
    if (asNonEmptyString(runReadback.id) !== workflowRunId) {
      throw new Error('ui_run_workflow_schedule_trigger_v1 backend readback did not return the created workflow_runs row');
    }
    const directoryRows = await requireLiveResourceListReadback(
      'workflow_run_directory',
      { id: workflowRunId },
      'ui_run_workflow_schedule_trigger_v1',
    );
    const directoryRow = directoryRows.find((row) => asNonEmptyString(row.id) === workflowRunId) ?? directoryRows[0]!;
    if (asNonEmptyString(directoryRow.id) !== workflowRunId) {
      throw new Error('ui_run_workflow_schedule_trigger_v1 backend readback did not return the created workflow_run_directory row');
    }
    return {
      ok: true,
      status,
      workflow_schedule_trigger_id: String(rec.workflow_schedule_trigger_id ?? triggerId),
      workflow_template_id: asNonEmptyString(rec.workflow_template_id) ?? null,
      workflow_run_id: workflowRunId,
      last_run_at: asNonEmptyString(triggerReadback.last_run_at) ?? asNonEmptyString(rec.last_run_at) ?? null,
      ...rec,
    };
  }

  await ui_log_event_v1({
    event: 'workflow_schedule_trigger.run_now',
    workflow_schedule_trigger_id: triggerId,
  });
  return {
    ok: true,
    status: 'workflow_started',
    workflow_schedule_trigger_id: triggerId,
    workflow_template_id: null,
    workflow_run_id: `wfr_schedule_${Date.now()}`,
  };
}

export async function ui_repair_workflow_schedule_task_payload_v1(
  workflowScheduleTriggerId: string,
  taskPayload: Record<string, unknown> = {},
): Promise<WorkflowScheduleTaskPayloadRepairResult> {
  const triggerId = asNonEmptyString(workflowScheduleTriggerId);
  if (!triggerId) throw new Error('workflow_schedule_trigger_id is required');

  const live = await liveRpc<Record<string, unknown>>('ui_repair_workflow_schedule_task_payload_v1', {
    p_workflow_schedule_trigger_id: triggerId,
    p_task_payload: taskPayload,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_repair_workflow_schedule_task_payload_v1', [
      'workflow_schedule_trigger_id',
      'workflow_template_id',
      'task_type_key',
    ]);
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_schedule_triggers',
      triggerId,
      'ui_repair_workflow_schedule_task_payload_v1',
    );
    const contextPatch = (triggerReadback.context_patch ?? rec.context_patch) as Record<string, unknown> | undefined;
    const taskPayloadReadback = (contextPatch?.binding_payload as Record<string, unknown> | undefined)?.task;
    if (!taskPayloadReadback || typeof taskPayloadReadback !== 'object') {
      throw new Error('ui_repair_workflow_schedule_task_payload_v1 backend readback missing binding_payload.task');
    }
    if (asNonEmptyString(triggerReadback.last_error)) {
      throw new Error('ui_repair_workflow_schedule_task_payload_v1 backend readback did not clear workflow_schedule_triggers.last_error');
    }
    return {
      ...rec,
      ok: true,
      status: String(rec.status ?? 'payload_repaired'),
      workflow_schedule_trigger_id: String(rec.workflow_schedule_trigger_id ?? triggerId),
      workflow_template_id: asNonEmptyString(rec.workflow_template_id) ?? null,
      workflow_template_step_id: asNonEmptyString(rec.workflow_template_step_id) ?? null,
      operation_name: asNonEmptyString(rec.operation_name) ?? null,
      task_type_key: asNonEmptyString(rec.task_type_key) ?? null,
      queue_key: asNonEmptyString(rec.queue_key) ?? null,
      priority: typeof rec.priority === 'number' ? rec.priority : null,
      sla_minutes: typeof rec.sla_minutes === 'number' ? rec.sla_minutes : null,
      resource_type: asNonEmptyString(rec.resource_type) ?? null,
      resource_id: asNonEmptyString(rec.resource_id) ?? null,
      updated_at: asNonEmptyString(triggerReadback.updated_at) ?? asNonEmptyString(rec.updated_at) ?? null,
      context_patch: contextPatch ?? null,
    };
  }

  await ui_log_event_v1({
    event: 'workflow_schedule_trigger.task_payload_repair',
    workflow_schedule_trigger_id: triggerId,
  });
  return {
    ok: true,
    status: 'payload_repaired',
    workflow_schedule_trigger_id: triggerId,
    workflow_template_id: null,
    workflow_template_step_id: null,
    operation_name: null,
    task_type_key: asNonEmptyString(taskPayload.task_type_key) ?? null,
    queue_key: asNonEmptyString(taskPayload.queue_key) ?? null,
    priority: typeof taskPayload.priority === 'number' ? taskPayload.priority : null,
    sla_minutes: typeof taskPayload.sla_minutes === 'number' ? taskPayload.sla_minutes : null,
    resource_type: asNonEmptyString(taskPayload.resource_type) ?? null,
    resource_id: asNonEmptyString(taskPayload.resource_id) ?? null,
    updated_at: new Date().toISOString(),
    context_patch: { binding_payload: { task: taskPayload } },
  };
}

function _materializeRunSteps(runId: string): SyntheticRunStep[] {
  const cached = _runStepCache.get(runId);
  if (cached) return cached;
  // Try seed first (deterministic for known runs)
  const seedSteps = (seed.workflow_run_steps as Record<string, unknown[]> | undefined)?.[runId];
  if (Array.isArray(seedSteps)) {
    const list = seedSteps.map((s, i) => {
      const r = s as Record<string, unknown>;
      const enq = (r.started_at as string) ?? new Date().toISOString();
      return {
        id: (r.id as string) ?? `wfs_${runId}_${i}`,
        step_id: (r.step_id as string) ?? `st_${i + 1}`,
        label: (r.label as string) ?? `${translateAdapterMessage('adapter.workflowStep')} ${i + 1}`,
        status: ((r.status as SyntheticRunStep['status']) ?? 'succeeded'),
        duration_ms: (r.duration_ms as number | null | undefined) ?? null,
        enqueued_at: enq,
        operation_started_at: enq,
        ...((r.duration_ms as number | undefined) != null
          ? { operation_completed_at: new Date(new Date(enq).getTime() + (r.duration_ms as number)).toISOString() }
          : {}),
        operation_result: (r.operation_result as Record<string, unknown> | undefined) ?? null,
        last_error: (r.error as string | undefined) ?? null,
        retry_attempt: (r.retry_attempt as number | undefined) ?? 1,
      } satisfies SyntheticRunStep;
    });
    _runStepCache.set(runId, list);
    return list;
  }
  // Fallback: derive from run + template steps (live behavior parity for newly-started runs)
  const run = (seed.workflow_runs as Record<string, unknown>[] | undefined)?.find(
    (r) => (r as Record<string, unknown>).id === runId,
  ) as Record<string, unknown> | undefined;
  const template = run
    ? (seed.workflow_templates as Record<string, unknown>[] | undefined)?.find(
        (t) => (t as Record<string, unknown>).id === run.template_id,
      )
    : undefined;
  const tplSteps = (template as { steps?: Record<string, unknown>[] } | undefined)?.steps ?? [];
  const main = tplSteps.filter(
    (s) => (s as Record<string, unknown>).branch !== 'error' && (s as Record<string, unknown>).branch !== 'manual',
  );
  const status = (run?.status as string) ?? 'succeeded';
  const startedAt = (run?.started_at as string) ?? new Date().toISOString();
  const out = main.map((s, i) => {
    const r = s as Record<string, unknown>;
    let stepStatus: SyntheticRunStep['status'] = 'succeeded';
    let dur: number | null = 80 + i * 60;
    let err: string | null = null;
    if (status === 'running') {
      if (i === 0) { stepStatus = 'succeeded'; dur = 80; }
      else if (i === 1) { stepStatus = 'running'; dur = null; }
      else { stepStatus = 'pending'; dur = null; }
    } else if (status === 'failed' && i === main.length - 1) {
      stepStatus = 'failed'; dur = 220;
      err = (run?.error as string) ?? 'workflow_handlers.run failed';
    } else if (status === 'failed' && i > main.length - 1) {
      stepStatus = 'skipped'; dur = null;
    }
    const enq = new Date(new Date(startedAt).getTime() + i * 80).toISOString();
    return {
      id: `wfs_${runId}_${i}`,
      step_id: (r.id as string) ?? `st_${i + 1}`,
      label: (r.label as string) ?? `${translateAdapterMessage('adapter.workflowStep')} ${i + 1}`,
      kind: (r.kind as string) ?? 'action',
      status: stepStatus,
      duration_ms: dur,
      enqueued_at: enq,
      ...(dur != null ? { operation_started_at: enq, operation_completed_at: new Date(new Date(enq).getTime() + dur).toISOString() } : { operation_started_at: enq }),
      operation_result: stepStatus === 'failed' ? { ok: false, error: err } : { ok: true },
      last_error: err,
      retry_attempt: 1,
      decision_log_id: `dlog_run_${runId}_${i}`,
    } satisfies SyntheticRunStep;
  });
  _runStepCache.set(runId, out);
  return out;
}

export async function start_workflow_run(
  templateId: string,
  context: WorkflowRunStartContext = {},
): Promise<{
  ok: true;
  workflow_run_id: string;
  workflow_template_id: string;
  workflow_status: 'pending' | 'running';
  dry_run: boolean;
  idempotency_key: string;
  correlation_id: string;
  started_at: string;
  canonical_entrypoint: 'progress_workflow_run';
}> {
  const liveTemplateId = looksLikeUuid(templateId) ? templateId : (await loadLiveWorkflowTemplateId(templateId)) ?? templateId;
  const live = await liveRpc<Record<string, unknown>>('ui_start_workflow_run_v1', {
    p_workflow_template_id: liveTemplateId,
    p_payload: context,
    p_require_active: context.ui?.allow_inactive ? false : true,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_start_workflow_run_v1', [
      'workflow_run_id',
    ]);
    const runId = requireLiveStringField(
      rec,
      ['workflow_run_id', 'id'],
      'ui_start_workflow_run_v1 did not return workflow_run_id',
    );
    await requireLiveResourceReadback('workflow_runs', runId, 'ui_start_workflow_run_v1');
    await requireLiveResourceListReadback('workflow_run_steps', { workflow_run_id: runId }, 'ui_start_workflow_run_v1');
    const startedAt = String(rec.started_at ?? new Date().toISOString());
    return {
      ok: true,
      workflow_run_id: runId,
      workflow_template_id: String(rec.workflow_template_id ?? liveTemplateId),
      workflow_status: (rec.workflow_status as 'pending' | 'running' | undefined) ?? 'running',
      dry_run: Boolean(context.ui?.dry_run ?? rec.dry_run),
      idempotency_key: String(rec.idempotency_key ?? ''),
      correlation_id: String(rec.correlation_id ?? ''),
      started_at: startedAt,
      canonical_entrypoint: 'progress_workflow_run',
    };
  }

  await sleep(120);
  const dry = !!context.ui?.dry_run;
  const runId = (context.ui?.replay_of ? `wfr_replay_${Date.now()}` : `wfr_${Date.now()}`);
  const correlationId = `cor_${Math.random().toString(36).slice(2, 8)}`;
  const idem = `idem_${templateId}_${Math.random().toString(36).slice(2, 6)}`;
  // Materialize step trace eagerly so progress_workflow_run can return it.
  // W34c — accept either the FE seed `id` or the canonical_uuid so callers
  // routed through `resolve_workflow_template_id_v1(template_key)` stay
  // stable across demo/live mode without a translation layer.
  const t = (seed.workflow_templates as Record<string, unknown>[] | undefined)?.find(
    (x) =>
      (x as Record<string, unknown>).id === templateId ||
      (x as Record<string, unknown>).canonical_uuid === templateId,
  );
  const tplSteps = (t as { steps?: Record<string, unknown>[] } | undefined)?.steps ?? [];
  const main = tplSteps.filter(
    (s) => (s as Record<string, unknown>).branch !== 'error' && (s as Record<string, unknown>).branch !== 'manual',
  );
  const startedAt = new Date().toISOString();
  const trace: SyntheticRunStep[] = main.map((s, i) => {
    const r = s as Record<string, unknown>;
    const dur = 60 + i * 40 + Math.floor(Math.random() * 80);
    const enq = new Date(new Date(startedAt).getTime() + i * 30).toISOString();
    return {
      id: `wfs_${runId}_${i}`,
      step_id: (r.id as string) ?? `st_${i + 1}`,
      label: (r.label as string) ?? `${translateAdapterMessage('adapter.workflowStep')} ${i + 1}`,
      kind: (r.kind as string) ?? 'action',
      status: 'succeeded',
      duration_ms: dur,
      enqueued_at: enq,
      operation_started_at: enq,
      operation_completed_at: new Date(new Date(enq).getTime() + dur).toISOString(),
      operation_result: { ok: true, dry_run: dry },
      last_error: null,
      retry_attempt: 1,
      decision_log_id: `dlog_${runId}_${i}`,
    };
  });
  _runStepCache.set(runId, trace);
  return {
    ok: true,
    workflow_run_id: runId,
    workflow_template_id: templateId,
    workflow_status: dry ? 'pending' : 'running',
    dry_run: dry,
    idempotency_key: idem,
    correlation_id: correlationId,
    started_at: startedAt,
    canonical_entrypoint: 'progress_workflow_run',
  };
}

/**
 * Mirrors `public.progress_workflow_run(uuid, jsonb) RETURNS jsonb`.
 *
 * The third `action` argument is encoded into the canonical payload
 * (real backend reads it from the jsonb `action` key). Operator variants such
 * as `manual_override` / `reopen_pending` / `retry` / `pause` / `resume` ride
 * through the same RPC — no separate functions exist.
 */
export async function progress_workflow_run(
  runId: string,
  payload?: unknown,
  action?: 'progress' | 'manual_override' | 'reopen_pending' | 'retry' | 'pause' | 'resume',
): Promise<{
  ok: true;
  workflow_run_id: string;
  workflow_status: 'completed' | 'failed' | 'in_progress' | 'pending' | 'paused';
  duration_ms: number;
  steps: SyntheticRunStep[];
  payload?: unknown;
  action?: typeof action;
}> {
  const livePayload =
    payload && typeof payload === 'object'
      ? { ...(payload as Record<string, unknown>), ...(action ? { action } : {}) }
      : { input: payload ?? {}, ...(action ? { action } : {}) };
  const live = await liveRpc<Record<string, unknown>>('progress_workflow_run', {
    p_workflow_run_id: runId,
    p_input: livePayload,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'progress_workflow_run', [
      'workflow_run_id',
      'workflow_status',
      'status',
    ]);
    const workflowStatus = String(rec.workflow_status ?? rec.status ?? '').toLowerCase();
    const errorMessage = asNonEmptyString(rec.error);
    const message = asNonEmptyString(rec.message);
    const isBenignOpenStatus = workflowStatus === 'in_progress' || workflowStatus === 'pending';
    if (workflowStatus === 'failed' || errorMessage || (message && !isBenignOpenStatus)) {
      throw new Error(errorMessage || 'progress_workflow_run returned failed status');
    }
    const workflowRunId = requireLiveStringField(
      rec,
      ['workflow_run_id', 'id'],
      'progress_workflow_run did not return workflow_run_id',
    );
    const stepsResult = await ui_list_resource_v1<SyntheticRunStep>('workflow_run_steps', {
      filter: { workflow_run_id: runId },
      sort: { key: 'enqueued_at', dir: 'asc' },
    }).catch(() => ({ rows: [] as SyntheticRunStep[], total: 0 }));
    const steps = stepsResult.rows;
    return {
      ok: true,
      workflow_run_id: workflowRunId,
      workflow_status: (rec.workflow_status as 'completed' | 'failed' | 'in_progress' | 'pending' | 'paused' | undefined) ??
        (action === 'pause' ? 'paused' : 'completed'),
      duration_ms: Number(rec.duration_ms ?? steps.reduce((acc, step) => acc + (step.duration_ms ?? 0), 0)),
      steps,
      ...(payload !== undefined ? { payload } : {}),
      ...(action !== undefined ? { action } : {}),
      ...rec,
    } as {
      ok: true;
      workflow_run_id: string;
      workflow_status: 'completed' | 'failed' | 'paused';
      duration_ms: number;
      steps: SyntheticRunStep[];
      payload?: unknown;
      action?: typeof action;
    };
  }

  await sleep(180);
  const steps = _materializeRunSteps(runId);
  const total = steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0);
  const failed = steps.find((s) => s.status === 'failed');
  return {
    ok: true,
    workflow_run_id: runId,
    workflow_status: action === 'pause' ? 'paused' : failed ? 'failed' : 'completed',
    duration_ms: total,
    steps,
    ...(payload !== undefined ? { payload } : {}),
    ...(action !== undefined ? { action } : {}),
  };
}

export async function progress_workflow_run_until_wait_v1(
  runId: string,
  payload?: unknown,
  opts: { budget_ms?: number; max_steps?: number } = {},
): Promise<{
  ok: true;
  workflow_run_id: string;
  workflow_status: 'completed' | 'failed' | 'in_progress' | 'pending' | 'paused';
  duration_ms: number;
  steps: SyntheticRunStep[];
  payload?: unknown;
}> {
  const livePayload = payload && typeof payload === 'object'
    ? { ...(payload as Record<string, unknown>) }
    : { input: payload ?? {} };
  const live = await liveRpc<Record<string, unknown>>('progress_workflow_run_until_wait_v1', {
    p_workflow_run_id: runId,
    p_operation_result: livePayload,
    p_budget_ms: opts.budget_ms ?? 5000,
    p_max_steps: opts.max_steps ?? 8,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'progress_workflow_run_until_wait_v1', [
      'workflow_run_id',
      'workflow_status',
      'status',
    ]);
    const workflowStatus = String(rec.workflow_status ?? rec.status ?? '').toLowerCase();
    const errorMessage = asNonEmptyString(rec.error);
    const message = asNonEmptyString(rec.message);
    const isBenignOpenStatus = workflowStatus === 'in_progress' || workflowStatus === 'pending' || workflowStatus === 'waiting';
    if (workflowStatus === 'failed' || errorMessage || (message && !isBenignOpenStatus)) {
      throw new Error(errorMessage || 'progress_workflow_run_until_wait_v1 returned failed status');
    }
    const workflowRunId = requireLiveStringField(
      rec,
      ['workflow_run_id', 'id'],
      'progress_workflow_run_until_wait_v1 did not return workflow_run_id',
    );
    const stepsResult = await ui_list_resource_v1<SyntheticRunStep>('workflow_run_steps', {
      filter: { workflow_run_id: runId },
      sort: { key: 'enqueued_at', dir: 'asc' },
    }).catch(() => ({ rows: [] as SyntheticRunStep[], total: 0 }));
    const steps = stepsResult.rows;
    return {
      ok: true,
      workflow_run_id: workflowRunId,
      workflow_status: (rec.workflow_status as 'completed' | 'failed' | 'in_progress' | 'pending' | 'paused' | undefined) ?? 'in_progress',
      duration_ms: Number(rec.duration_ms ?? steps.reduce((acc, step) => acc + (step.duration_ms ?? 0), 0)),
      steps,
      ...(payload !== undefined ? { payload } : {}),
      ...rec,
    } as {
      ok: true;
      workflow_run_id: string;
      workflow_status: 'completed' | 'failed' | 'in_progress' | 'pending' | 'paused';
      duration_ms: number;
      steps: SyntheticRunStep[];
      payload?: unknown;
    };
  }

  return progress_workflow_run(runId, payload);
}

export async function progress_workflow_run_base(
  runId: string,
  payload?: unknown,
): Promise<{ ok: true; workflow_run_id: string; payload?: unknown }> {
  const live = await liveRpc<Record<string, unknown>>('progress_workflow_run', {
    p_workflow_run_id: runId,
    p_input: payload ?? {},
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'progress_workflow_run', [
      'workflow_run_id',
      'workflow_status',
      'status',
    ]);
    const workflowRunId = requireLiveStringField(
      rec,
      ['workflow_run_id', 'id'],
      'progress_workflow_run did not return workflow_run_id',
    );
    return {
      ...rec,
      ok: true,
      workflow_run_id: workflowRunId,
      ...(payload !== undefined ? { payload } : {}),
    } as { ok: true; workflow_run_id: string; payload?: unknown };
  }

  await sleep(60);
  return {
    ok: true,
    workflow_run_id: runId,
    ...(payload !== undefined ? { payload } : {}),
  };
}

/**
 * Mirrors `public.close_workflow_run(uuid, text) RETURNS void`.
 * The richer `closed_at`/`workflow_status` envelope is FE-side enrichment for
 * the in-memory adapter; on Supabase swap, derive `closed_at` from a follow-up
 * `ui_list_resource_v1('workflow_runs', { filter: { id }})` read.
 */
export async function close_workflow_run(
  runId: string,
  status: 'completed' | 'failed' | 'cancelled',
): Promise<{ ok: true; workflow_run_id: string; workflow_status: typeof status; closed_at: string }> {
  const live = await liveRpc<null>('close_workflow_run', {
    p_workflow_run_id: runId,
    p_status: status,
  });
  if (live) {
    const run = await requireLiveResourceReadback('workflow_runs', runId, 'close_workflow_run');
    await requireLiveResourceListReadback('workflow_run_steps', { workflow_run_id: runId }, 'close_workflow_run');
    const readbackStatus = asNonEmptyString(run.workflow_status) ?? asNonEmptyString(run.status);
    if (readbackStatus && readbackStatus !== status) {
      throw new Error('close_workflow_run backend readback status mismatch');
    }
    return {
      ok: true,
      workflow_run_id: runId,
      workflow_status: status,
      closed_at: String(run.completed_at ?? run.closed_at ?? new Date().toISOString()),
    };
  }

  await sleep(80);
  return { ok: true, workflow_run_id: runId, workflow_status: status, closed_at: new Date().toISOString() };
}
