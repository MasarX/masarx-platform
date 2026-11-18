import type { UiTranslateFn } from "./translate";

export type WorkflowRunProvenanceLabels = {
  title: string;
  description: string;
  triggeredVia: string;
  sources: {
    manual: string;
    webhook: string;
    api: string;
    worker: string;
    schedule: string;
    scheduleManual: string;
    task: string;
    workflowRunTrigger: string;
    unknown: string;
  };
  fields: {
    runId: string;
    correlationId: string;
    requestedBy: string;
    requestContextId: string;
    scheduleTriggerId: string;
    runTriggerId: string;
    triggerFireId: string;
    sourceRunId: string;
    sourceStatus: string;
    sourceCompletedAt: string;
    idempotencyKey: string;
    scope: string;
  };
  actions: {
    openRun: string;
    openSchedule: string;
    openTrigger: string;
    openFire: string;
    showRaw: string;
    copy: string;
    copySuccessTitle: string;
    copyFailedTitle: string;
  };
};

type CreateWorkflowRunProvenanceLabelsOptions = {
  keyPrefix: string;
};

function resolveKey(prefix: string, suffix: string) {
  const trimmedPrefix = prefix.trim().replace(/\.$/, "");
  const trimmedSuffix = suffix.trim().replace(/^\./, "");
  if (!trimmedPrefix) return trimmedSuffix;
  if (!trimmedSuffix) return trimmedPrefix;
  return `${trimmedPrefix}.${trimmedSuffix}`;
}

export function createWorkflowRunProvenanceLabels(
  t: UiTranslateFn,
  options: CreateWorkflowRunProvenanceLabelsOptions
): WorkflowRunProvenanceLabels {
  const keyPrefix = options.keyPrefix;
  const key = (suffix: string) => resolveKey(keyPrefix, suffix);
  return {
    title: t(key("title")),
    description: t(key("description")),
    triggeredVia: t(key("triggeredVia")),
    sources: {
      manual: t(key("sources.manual")),
      webhook: t(key("sources.webhook")),
      api: t(key("sources.api")),
      worker: t(key("sources.worker")),
      schedule: t(key("sources.schedule")),
      scheduleManual: t(key("sources.scheduleManual")),
      task: t(key("sources.task")),
      workflowRunTrigger: t(key("sources.workflowRunTrigger")),
      unknown: t(key("sources.unknown")),
    },
    fields: {
      runId: t(key("fields.runId")),
      correlationId: t(key("fields.correlationId")),
      requestedBy: t(key("fields.requestedBy")),
      requestContextId: t(key("fields.requestContextId")),
      scheduleTriggerId: t(key("fields.scheduleTriggerId")),
      runTriggerId: t(key("fields.runTriggerId")),
      triggerFireId: t(key("fields.triggerFireId")),
      sourceRunId: t(key("fields.sourceRunId")),
      sourceStatus: t(key("fields.sourceStatus")),
      sourceCompletedAt: t(key("fields.sourceCompletedAt")),
      idempotencyKey: t(key("fields.idempotencyKey")),
      scope: t(key("fields.scope")),
    },
    actions: {
      openRun: t(key("actions.openRun")),
      openSchedule: t(key("actions.openSchedule")),
      openTrigger: t(key("actions.openTrigger")),
      openFire: t(key("actions.openFire")),
      showRaw: t(key("actions.showRaw")),
      copy: t(key("actions.copy")),
      copySuccessTitle: t(key("actions.copySuccessTitle")),
      copyFailedTitle: t(key("actions.copyFailedTitle")),
    },
  };
}
