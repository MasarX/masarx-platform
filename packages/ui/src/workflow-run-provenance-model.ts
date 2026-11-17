type UnknownRecord = Record<string, unknown>;

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeObject(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function getString(record: UnknownRecord | null, key: string): string | null {
  if (!record) return null;
  return normalizeString(record[key]);
}

function getNestedObject(record: UnknownRecord | null, key: string): UnknownRecord | null {
  if (!record) return null;
  return normalizeObject(record[key]);
}

export type WorkflowRunProvenance = {
  workflowRunId: string | null;
  correlationId: string | null;
  triggerSource: string | null;
  requestedBy: string | null;
  requestContextId: string | null;
  idempotencyKey: string | null;
  scopeType: string | null;
  scopeId: string | null;

  workflowScheduleTriggerId: string | null;

  workflowRunTriggerId: string | null;
  workflowTriggerFireId: string | null;
  sourceWorkflowRunId: string | null;
  sourceWorkflowStatus: string | null;
  sourceCompletedAt: string | null;

  rawContext: UnknownRecord | null;
};

export function extractWorkflowRunCorrelationId(workflowRun: UnknownRecord | null): string | null {
  if (!workflowRun) return null;

  const direct = getString(workflowRun, "triggered_by_request_id");
  if (direct) return direct;

  const context = getNestedObject(workflowRun, "context");
  const contextCorrelationId = getString(context, "correlation_id");
  if (contextCorrelationId) return contextCorrelationId;

  const metadata = getNestedObject(workflowRun, "metadata");
  const metadataCorrelationId = getString(metadata, "correlation_id");
  if (metadataCorrelationId) return metadataCorrelationId;

  return null;
}

export function extractWorkflowRunProvenance(
  workflowRun: UnknownRecord | null
): WorkflowRunProvenance | null {
  if (!workflowRun) return null;
  const workflowRunId = getString(workflowRun, "id");
  const context = getNestedObject(workflowRun, "context");
  const correlationId = extractWorkflowRunCorrelationId(workflowRun);
  if (!context) {
    return {
      workflowRunId,
      correlationId,
      triggerSource: null,
      requestedBy: null,
      requestContextId: null,
      idempotencyKey: null,
      scopeType: null,
      scopeId: null,
      workflowScheduleTriggerId: null,
      workflowRunTriggerId: null,
      workflowTriggerFireId: null,
      sourceWorkflowRunId: null,
      sourceWorkflowStatus: null,
      sourceCompletedAt: null,
      rawContext: null,
    };
  }

  const source = getNestedObject(context, "source");

  return {
    workflowRunId,
    correlationId,
    triggerSource: getString(context, "trigger_source"),
    requestedBy: getString(context, "requested_by"),
    requestContextId: getString(context, "request_context_id"),
    idempotencyKey: getString(context, "idempotency_key"),
    scopeType: getString(context, "scope_type"),
    scopeId: getString(context, "scope_id"),

    workflowScheduleTriggerId: getString(context, "workflow_schedule_trigger_id"),

    workflowRunTriggerId: getString(context, "workflow_run_trigger_id"),
    workflowTriggerFireId: getString(context, "workflow_trigger_fire_id"),
    sourceWorkflowRunId: getString(source, "workflow_run_id"),
    sourceWorkflowStatus: getString(source, "workflow_status"),
    sourceCompletedAt: getString(source, "completed_at"),

    rawContext: context,
  };
}
