import { sanitizeUiError } from "./utils";
import { labelFromKey } from "./resource-query";

export type WorkflowRunStepStatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info";

export type WorkflowRunLogStep = {
  id: string;
  workflowTemplateStepId: string | null;
  sequenceOrder: number | null;
  operationName: string | null;
  operationLabel: string;
  status: string | null;
  statusLabel: string;
  statusTone: WorkflowRunStepStatusTone;
  enqueuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  durationLabel: string | null;
  retryAttempt: number | null;
  maxRetries: number | null;
  fallbackInvoked: boolean | null;
  notes: string | null;
  lastError: string | null;
  decisionLogId: string | null;
  operationResult: unknown;
  metadata: unknown;
};

const resolveStatusTone = (status: string | null): WorkflowRunStepStatusTone => {
  if (!status) return "neutral";
  const normalized = status.toLowerCase();
  if (normalized === "completed") return "success";
  if (normalized === "failed") return "danger";
  if (normalized === "in_progress") return "info";
  if (normalized === "pending") return "warning";
  if (normalized === "skipped") return "neutral";
  return "neutral";
};

export function formatDurationMs(durationMs: number | null): string | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    const precision = seconds < 10 ? 1 : 0;
    return `${seconds.toFixed(precision)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
}

function normalizeString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

function normalizeNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function normalizeBoolean(value: unknown) {
  if (typeof value !== "boolean") return null;
  return value;
}

function normalizeStatus(value: unknown) {
  const raw = normalizeString(value);
  return raw ? raw.toLowerCase() : null;
}

export function normalizeWorkflowRunLogSteps(items: Record<string, unknown>[]) {
  const normalized: WorkflowRunLogStep[] = [];
  items.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const id = normalizeString(item.id);
    if (!id) return;
    const workflowTemplateStepId = normalizeString(item.workflow_template_step_id);
    const operationName = normalizeString(item.operation_name);
    const status = normalizeStatus(item.step_status);
    const operationLabel = operationName ? labelFromKey(operationName) : labelFromKey("step");
    const statusLabel = status ? labelFromKey(status) : labelFromKey("unknown");
    const durationMs = normalizeNumber(item.duration_ms);
    normalized.push({
      id,
      workflowTemplateStepId,
      sequenceOrder: normalizeNumber(item.sequence_order),
      operationName,
      operationLabel,
      status,
      statusLabel,
      statusTone: resolveStatusTone(status),
      enqueuedAt: normalizeString(item.enqueued_at),
      startedAt: normalizeString(item.operation_started_at),
      completedAt: normalizeString(item.operation_completed_at),
      durationMs,
      durationLabel: formatDurationMs(durationMs),
      retryAttempt: normalizeNumber(item.retry_attempt),
      maxRetries: normalizeNumber(item.max_retries),
      fallbackInvoked: normalizeBoolean(item.fallback_invoked),
      notes: normalizeString(item.notes),
      lastError: sanitizeUiError(normalizeString(item.last_error)) ?? normalizeString(item.last_error),
      decisionLogId: normalizeString(item.decision_log_id),
      operationResult: item.operation_result,
      metadata: item.metadata,
    });
  });

  return normalized.sort((left, right) => {
    const leftOrder = typeof left.sequenceOrder === "number" ? left.sequenceOrder : Infinity;
    const rightOrder = typeof right.sequenceOrder === "number" ? right.sequenceOrder : Infinity;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.operationLabel.localeCompare(right.operationLabel);
  });
}

const SENSITIVE_KEY_PATTERN = /^(?:[a-z0-9]+[_-])*(authorization|cookie|set-cookie|x-api-key|api[_-]?key|password|secret|token|signature|private[_-]?key)$/i;

function isSensitiveKey(key: string) {
  return SENSITIVE_KEY_PATTERN.test(key.trim());
}

function sanitizeStringValue(value: string) {
  const sanitized = sanitizeUiError(value);
  return sanitized ?? value;
}

export function redactJsonForUi(value: unknown, maxDepth: number = 6): unknown {
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (current === null || current === undefined) return current;
    if (typeof current === "string") return sanitizeStringValue(current);
    if (typeof current === "number" || typeof current === "boolean") return current;
    if (depth >= maxDepth) return "[truncated]";

    if (Array.isArray(current)) {
      return current.map((entry) => visit(entry, depth + 1));
    }

    if (typeof current === "object") {
      if (seen.has(current as object)) return "[circular]";
      seen.add(current as object);
      const record = current as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      Object.entries(record).forEach(([key, entry]) => {
        if (isSensitiveKey(key)) {
          out[key] = "[redacted]";
          return;
        }
        out[key] = visit(entry, depth + 1);
      });
      return out;
    }

    try {
      return sanitizeStringValue(String(current));
    } catch {
      return "[unserializable]";
    }
  };

  return visit(value, 0);
}

export function formatJsonForUi(value: unknown) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(redactJsonForUi(value), null, 2);
  } catch {
    return String(value);
  }
}

export function matchesWorkflowRunLogStep(
  step: WorkflowRunLogStep,
  query: string
) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  const haystack = [
    step.operationName,
    step.operationLabel,
    step.status,
    step.statusLabel,
    step.lastError,
    step.notes,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return haystack.includes(trimmed);
}

export function filterWorkflowRunLogStepsByTemplateStep(
  steps: WorkflowRunLogStep[],
  workflowTemplateStepId?: string | null
) {
  const filterValue =
    typeof workflowTemplateStepId === "string" ? workflowTemplateStepId.trim() : "";
  if (!filterValue) return steps;
  return steps.filter((step) => step.workflowTemplateStepId === filterValue);
}

export function isWorkflowRunLogStepIssue(step: WorkflowRunLogStep) {
  if (step.statusTone === "danger") return true;
  if (step.lastError) return true;
  return false;
}

export function countWorkflowRunLogStepIssues(steps: WorkflowRunLogStep[]) {
  return steps.reduce(
    (count, step) => (isWorkflowRunLogStepIssue(step) ? count + 1 : count),
    0
  );
}
