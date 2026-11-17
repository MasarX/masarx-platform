import { resolveSafeAppBasePath } from "./url-guard";

type UnknownRecord = Record<string, unknown>;

function normalizeText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getObject(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function extractWorkflowRunId(record: UnknownRecord | null): string | null {
  if (!record) return null;

  const directId = normalizeText(record.workflow_run_id);
  if (directId) return directId;

  const id = normalizeText(record.id);
  if (id) return id;

  const workflowRun = getObject(record.workflowRun);
  if (workflowRun) {
    const nestedId = normalizeText(workflowRun.id);
    if (nestedId) return nestedId;
  }

  const run = getObject(record.workflow_run);
  if (run) {
    const runId = normalizeText(run.id);
    if (runId) return runId;
  }

  return null;
}

function extractWorkflowRunCorrelation(record: UnknownRecord | null): string | null {
  if (!record) return null;

  const direct = normalizeText(record.correlation_id);
  if (direct) return direct;

  const triggered = normalizeText(record.triggered_by_request_id);
  if (triggered) return triggered;

  const context = getObject(record.context);
  if (context) {
    const contextCorrelation = normalizeText(context.correlation_id);
    if (contextCorrelation) return contextCorrelation;
  }

  const metadata = getObject(record.metadata);
  if (metadata) {
    const metadataCorrelation = normalizeText(metadata.correlation_id);
    if (metadataCorrelation) return metadataCorrelation;
  }

  const workflowRun = getObject(record.workflowRun);
  if (workflowRun) {
    const workflowRunCorrelation = extractWorkflowRunCorrelation(workflowRun);
    if (workflowRunCorrelation) return workflowRunCorrelation;
  }

  const run = getObject(record.workflow_run);
  if (run) {
    const nestedCorrelation = extractWorkflowRunCorrelation(run);
    if (nestedCorrelation) return nestedCorrelation;
  }

  return null;
}

export function resolveWorkflowRunDestination(args: {
  appBasePath: string;
  result: unknown;
}): string | null {
  const record = getObject(args.result);
  const runId = extractWorkflowRunId(record);
  if (!runId) return null;
  if (args.appBasePath !== "" && !args.appBasePath.trim()) return null;
  const base = resolveSafeAppBasePath(args.appBasePath);
  if (base === null) return null;
  const correlationId = extractWorkflowRunCorrelation(record);
  const runHref = `${base}/workflows/runs/${encodeURIComponent(runId)}`;
  if (!correlationId) return runHref;
  return `${base}/observability/trace/${encodeURIComponent(correlationId)}`;
}
