import {
  type AssignTaskArgs,
  type BulkTransitionTasksArgs,
  compactRecord,
  finalizeRouteStopCloseoutEvent,
  firstRpcRow,
  isRouteStopCloseoutTransition,
  liveBackendUnavailableError,
  liveRpc,
  liveRpcTarget,
  objectRecord,
  type OpenOpsSessionArgs,
  type OpenOpsSessionResult,
  phaseC6Rpc,
  requireLiveMutationResult,
  requireLiveResourceListReadback,
  requireLiveResourceReadback,
  requireLiveStringField,
  seed,
  sleep,
  state,
  type TaskFilter,
  ui_get_resource_v1,
  ui_list_resource_complete,
} from '../data-source';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { asNonEmptyString } from './shared';

function normalizeTaskListRow(row: Record<string, unknown>): Record<string, unknown> {
  const metadata = objectRecord(row.metadata) ?? {};
  const id = asNonEmptyString(row.id);
  const taskType =
    asNonEmptyString(row.task_type) ??
    asNonEmptyString(row.task_type_key) ??
    asNonEmptyString(metadata.task_type_key) ??
    asNonEmptyString(metadata.task_type);
  const queue =
    asNonEmptyString(row.queue) ??
    asNonEmptyString(row.queue_key) ??
    asNonEmptyString(metadata.queue_key) ??
    asNonEmptyString(metadata.queue);
  const subject =
    asNonEmptyString(row.subject) ??
    asNonEmptyString(metadata.subject) ??
    asNonEmptyString(metadata.title);
  const description =
    asNonEmptyString(row.description) ??
    asNonEmptyString(metadata.description);
  const resourceType = asNonEmptyString(row.resource_type) ?? asNonEmptyString(metadata.resource_type);
  const resourceId = asNonEmptyString(row.resource_id) ?? asNonEmptyString(metadata.resource_id);
  const shipmentId =
    asNonEmptyString(row.shipment_id) ??
    asNonEmptyString(metadata.shipment_id) ??
    (resourceType === 'shipment' ? resourceId : null);
  const allowedActionsRaw = row.allowed_actions ?? metadata.allowed_actions ?? metadata.allowed_ndr_actions;
  const allowedActions = Array.isArray(allowedActionsRaw)
    ? allowedActionsRaw.map((action) => asNonEmptyString(action)).filter((action): action is string => !!action)
    : null;

  const normalized: Record<string, unknown> = { ...row };
  const taskId = asNonEmptyString(row.task_id) ?? asNonEmptyString(metadata.task_id) ?? (id ? `TSK-${id.slice(0, 8).toUpperCase()}` : null);
  if (taskId) normalized.task_id = taskId;
  if (taskType) {
    normalized.task_type = taskType;
    normalized.task_type_key = asNonEmptyString(row.task_type_key) ?? taskType;
  }
  if (queue) {
    normalized.queue = queue;
    normalized.queue_key = asNonEmptyString(row.queue_key) ?? queue;
  }
  if (subject) normalized.subject = subject;
  if (description) normalized.description = description;
  if (shipmentId) normalized.shipment_id = shipmentId;
  if (allowedActions) normalized.allowed_actions = allowedActions;
  if (row.evidence_required == null && typeof metadata.evidence_required === 'boolean') {
    normalized.evidence_required = metadata.evidence_required;
  }
  return normalized;
}

export async function listTasks(filters: TaskFilter = {}): Promise<Record<string, unknown>[]> {
  const target = liveRpcTarget();
  if (target) {
    const p_filters = compactRecord({
      task_type_key: filters.task_type,
      assigned_to: filters.assigned_to,
    });
    const result = await ui_list_resource_complete<Record<string, unknown>>('tasks', {
      filter: p_filters,
      sort: { key: 'created_at', dir: 'desc' },
    });
    let rows = result.rows.map(normalizeTaskListRow);
    if (filters.at_risk) {
      rows = rows.filter((r) => new Date((r as { sla_due_at?: string }).sla_due_at ?? 0).getTime() < Date.now());
    }
    return rows;
  }

  await sleep(30);
  let rows = [...((seed.tasks as Record<string, unknown>[]) ?? [])];
  if (filters.task_type) rows = rows.filter((r) => (r as { task_type?: string }).task_type === filters.task_type);
  if (filters.assigned_to) rows = rows.filter((r) => (r as { assigned_to?: string }).assigned_to === filters.assigned_to);
  if (filters.at_risk)
    rows = rows.filter((r) => new Date((r as { sla_due_at?: string }).sla_due_at ?? 0).getTime() < Date.now());
  return rows.map(normalizeTaskListRow);
}

export async function transition_task_v1(
  taskId: string,
  transition: { next_status?: string; payload?: Record<string, unknown>; [k: string]: unknown },
): Promise<{ ok: true; task: Record<string, unknown> | undefined; task_event_id?: string | null }> {
  const target = liveRpcTarget();
  if (target) {
    const toStatus = String(transition.next_status ?? transition.to_status ?? 'completed');
    const payload = (transition.payload && typeof transition.payload === 'object')
      ? transition.payload
      : {};
    const { data, error } = await target.rpc('transition_task_v1', {
      p_task_id: taskId,
      p_to_status: toStatus,
      p_status_reason: transition.status_reason ?? null,
      p_payload: payload,
      p_idempotency_key: transition.idempotency_key ?? null,
    });
    if (error) throw new Error(error.message);
    requireLiveMutationResult(data, 'transition_task_v1', ['task_id', 'id', 'task_event_id']);
    const taskEventId = asNonEmptyString(firstRpcRow<Record<string, unknown>>(data)?.task_event_id);
    if (taskEventId && isRouteStopCloseoutTransition(toStatus, payload)) {
      await finalizeRouteStopCloseoutEvent(taskEventId);
    }
    await requireLiveTaskEventReadback('transition_task_v1', taskId, taskEventId);
    const task = await ui_get_resource_v1<Record<string, unknown>>('tasks', taskId);
    if (!task) throw new Error('transition_task_v1 backend readback missing tasks');
    const taskStatus = String(task.status ?? '').trim().toLowerCase();
    const expectedStatus = toStatus.trim().toLowerCase();
    const statusMatches = taskStatus === expectedStatus;
    if (!statusMatches) {
      throw new Error(`transition_task_v1 backend readback status mismatch: expected ${expectedStatus}, got ${taskStatus || 'missing'}`);
    }
    return { ok: true, task: normalizeTaskListRow(task), task_event_id: taskEventId };
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('transition_task_v1');
  await sleep(80);
  const tasks = seed.tasks as Array<Record<string, unknown> & { id: string; status: string }>;
  const task = tasks.find((t) => t.id === taskId);
  let taskEventId: string | null = null;
  if (task) {
    const previousStatus = task.status;
    const toStatus = transition.next_status || String(transition.to_status ?? 'completed');
    task.status = toStatus;
    // Persist arbitrary payload fields (e.g. snooze_until ISO) so callers
    // can verify the seam received the row-driven payload, mirroring how
    // `transition_task_v1` would land columns/JSON on the real task row.
    const payload = transition.payload;
    if (payload && typeof payload === 'object') {
      for (const [k, v] of Object.entries(payload)) {
        (task as Record<string, unknown>)[k] = v;
      }
    }
    taskEventId = `tev_transition_${taskId}_${Date.now()}`;
    const taskEvents = seed.task_events as Array<Record<string, unknown>> | undefined;
    taskEvents?.push?.({
      id: taskEventId,
      task_id: taskId,
      occurred_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      event_type: 'status_changed',
      event: 'status_changed',
      actor: state.user.id,
      from_status: previousStatus,
      to_status: toStatus,
      payload: payload ?? {},
      idempotency_key: transition.idempotency_key ?? null,
    });
  }
  return { ok: true, task: task as Record<string, unknown> | undefined, task_event_id: taskEventId };
}

export async function resolve_manual_review_task_v1(
  taskId: string,
  resolution: { resolution_outcome?: string; resolution_notes?: string | null },
): Promise<Record<string, unknown>> {
  const target = liveRpcTarget();
  if (target) {
    const outcome = String(resolution.resolution_outcome ?? 'approved').trim().toLowerCase();
    const { data, error } = await target.rpc('resolve_manual_review_task_v1', {
      p_task_id: taskId,
      p_resolution_outcome: outcome,
      p_resolution_notes: resolution.resolution_notes ?? null,
    });
    if (error) throw new Error(error.message);
    requireLiveMutationResult(data, 'resolve_manual_review_task_v1', ['id', 'status', 'resolution_outcome']);
    const row = await requireLiveResourceReadback(
      'manual_review_tasks',
      taskId,
      'resolve_manual_review_task_v1',
    );
    const status = String(row.status ?? '').trim().toLowerCase();
    const readbackOutcome = String(row.resolution_outcome ?? '').trim().toLowerCase();
    if (status !== 'resolved') {
      throw new Error(`resolve_manual_review_task_v1 backend readback status mismatch: expected resolved, got ${status || 'missing'}`);
    }
    if (readbackOutcome !== outcome) {
      throw new Error(`resolve_manual_review_task_v1 backend readback outcome mismatch: expected ${outcome}, got ${readbackOutcome || 'missing'}`);
    }
    return row;
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('resolve_manual_review_task_v1');
  await sleep(60);
  const seedRows = (seed as { manual_review_tasks?: Array<Record<string, unknown> & { id: string }> }).manual_review_tasks ?? [];
  const task = seedRows.find((t) => t.id === taskId);
  if (!task) throw new Error(`manual_review_task not found: ${taskId}`);
  task.status = 'resolved';
  task.resolution_outcome = resolution.resolution_outcome ?? 'approved';
  task.resolution_notes = resolution.resolution_notes ?? null;
  task.resolved_at = new Date().toISOString();
  task.updated_at = task.resolved_at;
  return task;
}

async function requireLiveTaskEventReadback(
  rpcName: string,
  taskId: string,
  taskEventId?: string | null,
): Promise<void> {
  const normalizedEventId = asNonEmptyString(taskEventId);
  if (normalizedEventId) {
    await requireLiveResourceReadback('task_events', normalizedEventId, rpcName);
  } else {
    await requireLiveResourceListReadback('task_events', { task_id: taskId }, rpcName);
  }
}

export async function assign_task_v1(
  args: AssignTaskArgs,
): Promise<{ task_id: string; task_event_id: string | null; task?: Record<string, unknown> }> {
  const taskId = asNonEmptyString(args.task_id);
  const assignedTo = asNonEmptyString(args.assigned_to);
  if (!taskId) throw new Error('assign_task_v1 requires task_id');
  if (!assignedTo) throw new Error('assign_task_v1 requires assigned_to');

  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>('assign_task_v1', {
    p_task_id: taskId,
    p_assigned_to: assignedTo,
    p_idempotency_key: args.idempotency_key ?? null,
    p_notes: args.notes ?? null,
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'assign_task_v1', ['task_id', 'task_event_id']);
    const returnedTaskId = requireLiveStringField(
      row,
      ['task_id', 'id'],
      'assign_task_v1 did not return task_id',
    );
    const taskEventId = asNonEmptyString(row.task_event_id);
    const task = await requireLiveResourceReadback('tasks', returnedTaskId, 'assign_task_v1');
    await requireLiveTaskEventReadback('assign_task_v1', returnedTaskId, taskEventId);
    return {
      task_id: returnedTaskId,
      task_event_id: taskEventId,
      task: normalizeTaskListRow(task),
    };
  }

  await sleep(80);
  const tasks = seed.tasks as Array<Record<string, unknown> & { id: string; assigned_to?: string | null; version?: number }>;
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`assign_task_v1 task not found: ${taskId}`);
  task.assigned_to = assignedTo;
  task.assigned_at = new Date().toISOString();
  task.version = typeof task.version === 'number' ? task.version + 1 : 1;
  const taskEventId = `tev_assign_${taskId}_${Date.now()}`;
  const taskEvents = seed.task_events as Array<Record<string, unknown>> | undefined;
  taskEvents?.push?.({
    id: taskEventId,
    task_id: taskId,
    occurred_at: task.assigned_at,
    event: 'assigned',
    actor: state.user.id,
    assigned_to: assignedTo,
    notes: args.notes ?? null,
    idempotency_key: args.idempotency_key ?? null,
  });
  return { task_id: taskId, task_event_id: taskEventId, task: normalizeTaskListRow(task) };
}

export async function open_ops_session_v1(args: OpenOpsSessionArgs): Promise<OpenOpsSessionResult> {
  const sessionType = asNonEmptyString(args.session_type);
  const idempotencyKey = asNonEmptyString(args.idempotency_key);
  if (!sessionType) throw new Error('open_ops_session_v1 requires session_type');
  if (!idempotencyKey) throw new Error('open_ops_session_v1 requires idempotency_key');

  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>('open_ops_session_v1', {
    p_input: compactRecord({
      session_type: sessionType,
      branch_id: args.branch_id ?? null,
      session_code: args.session_code ?? null,
      idempotency_key: idempotencyKey,
      metadata: args.metadata ?? {},
    }),
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'open_ops_session_v1', ['ops_session_id']);
    const opsSessionId = requireLiveStringField(
      row,
      ['ops_session_id', 'id'],
      'open_ops_session_v1 did not return ops_session_id',
    );
    await requireLiveResourceReadback('ops_sessions', opsSessionId, 'open_ops_session_v1');
    return {
      ...row,
      ops_session_id: opsSessionId,
      created: row.created === true,
    };
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('open_ops_session_v1');
  return {
    ops_session_id: `ops_${sessionType}_${Date.now().toString(36)}`,
    created: true,
  };
}

async function requireLiveBulkTaskTransitionReadback(
  result: Record<string, unknown>,
  args: BulkTransitionTasksArgs,
): Promise<void> {
  const expectedPayload = args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
    ? args.payload
    : null;
  const outcomes = Array.isArray(result.outcomes)
    ? result.outcomes.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    : [];
  const taskIdsFromArgs = Array.isArray(args.task_ids)
    ? args.task_ids.map((id) => asNonEmptyString(id)).filter((id): id is string => !!id)
    : [];
  const successful = outcomes
    .filter((row) => row.ok !== false)
    .map((row) => ({
      taskId: asNonEmptyString(row.task_id) ?? asNonEmptyString(row.id),
      taskEventId: asNonEmptyString(row.task_event_id),
    }))
    .filter((row): row is { taskId: string; taskEventId: string | null } => !!row.taskId);

  const tasksToVerify = successful.length > 0
    ? successful
    : taskIdsFromArgs.map((taskId) => ({ taskId, taskEventId: null }));

  if (tasksToVerify.length === 0) {
    throw new Error('bulk_transition_tasks_v1 did not return backend task transition evidence');
  }

  await Promise.all(tasksToVerify.map(async ({ taskId, taskEventId }) => {
    await requireLiveResourceReadback('tasks', taskId, 'bulk_transition_tasks_v1');
    const taskEvents = taskEventId
      ? [await requireLiveResourceReadback('task_events', taskEventId, 'bulk_transition_tasks_v1')]
      : await requireLiveResourceListReadback('task_events', { task_id: taskId }, 'bulk_transition_tasks_v1');
    if (expectedPayload && Object.keys(expectedPayload).length > 0) {
      const event = taskEvents.find((row) => String(row.task_id ?? '') === taskId) ?? taskEvents[0];
      const eventPayload = event && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      for (const [key, value] of Object.entries(expectedPayload)) {
        if (JSON.stringify(eventPayload[key] ?? null) !== JSON.stringify(value ?? null)) {
          throw new Error(`bulk_transition_tasks_v1 backend task_event payload mismatch for ${taskId}:${key}`);
        }
      }
    }
  }));
}

export const bulk_transition_tasks_v1 = async (args: BulkTransitionTasksArgs) => {
  const result = await phaseC6Rpc('bulk_transition_tasks_v1', args);
  if (liveRpcTarget()) {
    await requireLiveBulkTaskTransitionReadback(result, args);
  }
  return result;
};
