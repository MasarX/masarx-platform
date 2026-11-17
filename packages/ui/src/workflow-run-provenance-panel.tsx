"use client";

import * as React from "react";
import { Badge } from "./badge";
import { Button } from "./button";
import { copyTextToClipboard } from "./clipboard";
import { formatResourceValue, formatIdValue } from "./resource-utils";
import { useToast } from "./use-toast";
import { cn, normalizeLower } from "./utils";
import { formatJsonForUi } from "./workflow-run-logs-model";
import { resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";
import {
  extractWorkflowRunProvenance,
  type WorkflowRunProvenance,
} from "./workflow-run-provenance-model";
import type { WorkflowRunProvenanceLabels } from "./workflow-run-provenance-labels";

type WorkflowRunProvenancePanelProps = {
  workflowRun: Record<string, unknown> | null;
  appBasePath: string;
  labels: WorkflowRunProvenanceLabels;
  testIdPrefix?: string;
  className?: string;
};

function resolveSourceLabel(
  provenance: WorkflowRunProvenance,
  labels: WorkflowRunProvenanceLabels
) {
  const source = normalizeLower(provenance.triggerSource ?? null) ?? "unknown";
  if (source === "manual") return labels.sources.manual;
  if (source === "webhook") return labels.sources.webhook;
  if (source === "schedule") return labels.sources.schedule;
  if (source === "schedule_manual") return labels.sources.scheduleManual;
  if (source === "workflow_run_trigger") return labels.sources.workflowRunTrigger;
  return labels.sources.unknown;
}

function DefinitionRow({
  label,
  value,
  href,
  actionLabel,
  copyLabel,
  onCopy,
  testId,
  copyTestId,
}: {
  label: string;
  value: string | null;
  href?: string;
  actionLabel?: string;
  copyLabel?: string;
  onCopy?: (value: string) => void;
  testId?: string;
  copyTestId?: string;
}) {
  const display = value ? formatIdValue(value) : "-";
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ui-border bg-ui-paper/40 px-3 py-2"
      data-testid={testId}
    >
      <div className="min-w-0 space-y-1">
        <div className="text-[11px] font-medium text-ui-muted">{label}</div>
        <div className="truncate font-mono text-xs text-ui-ink" title={value ?? ""}>
          {display}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {href && value && actionLabel ? (
          <Button asChild size="sm" variant="ghost">
            <a href={href} target="_blank" rel="noreferrer">
              {actionLabel}
            </a>
          </Button>
        ) : null}
        {value && onCopy && copyLabel ? (
          <button
            type="button"
            className="text-[11px] font-medium text-ui-muted underline underline-offset-4 transition hover:text-ui-ink"
            aria-label={`${copyLabel}: ${label}`}
            onClick={() => onCopy(value)}
            data-testid={copyTestId}
          >
            {copyLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function WorkflowRunProvenancePanel({
  workflowRun,
  appBasePath,
  labels,
  testIdPrefix,
  className,
}: WorkflowRunProvenancePanelProps) {
  const { toast } = useToast();
  const basePath = React.useMemo(() => resolveSafeAppBasePath(appBasePath), [appBasePath]);
  const provenance = React.useMemo(
    () => extractWorkflowRunProvenance(workflowRun),
    [workflowRun]
  );
  const safeHref = React.useCallback(
    (path: string) => (basePath !== null ? resolveSafeHref(basePath, path) : null),
    [basePath]
  );

  const handleCopy = React.useCallback(
    async (value: string) => {
      try {
        const success = await copyTextToClipboard(value);
        toast({
          title: success ? labels.actions.copySuccessTitle : labels.actions.copyFailedTitle,
          tone: success ? "success" : "error",
        });
        return success;
      } catch {
        toast({
          title: labels.actions.copyFailedTitle,
          tone: "error",
        });
        return false;
      }
    },
    [labels.actions.copyFailedTitle, labels.actions.copySuccessTitle, toast]
  );

  if (!provenance) return null;

  const sourceLabel = resolveSourceLabel(provenance, labels);
  const rawContext = provenance.rawContext ? formatJsonForUi(provenance.rawContext) : null;
  const scopeType = provenance.scopeType?.trim() || "";
  const scopeId = provenance.scopeId?.trim() || "";
  const scope = scopeType && scopeId ? `${scopeType}:${scopeId}` : scopeType || scopeId || null;

  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border border-ui-border bg-ui-paper/60 p-4",
        className
      )}
      data-testid={testIdPrefix ? `${testIdPrefix}-provenance` : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium text-ui-muted">{labels.title}</div>
          <div className="text-sm font-semibold text-ui-ink">
            {labels.triggeredVia} {sourceLabel}
          </div>
          {labels.description ? (
            <div className="text-xs text-ui-muted">{labels.description}</div>
          ) : null}
        </div>
        <Badge tone="neutral" className="px-2 py-0.5 text-[10px]">
          {sourceLabel}
        </Badge>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {provenance.workflowRunId ? (
          <DefinitionRow
            label={labels.fields.runId}
            value={provenance.workflowRunId}
            href={
              safeHref(
                `/workflows/runs/${encodeURIComponent(provenance.workflowRunId)}`
              ) ?? undefined
            }
            actionLabel={labels.actions.openRun}
            copyLabel={labels.actions.copy}
            onCopy={(value) => handleCopy(value)}
            testId={testIdPrefix ? `${testIdPrefix}-provenance-run-id` : undefined}
            copyTestId={
              testIdPrefix ? `${testIdPrefix}-provenance-run-id-copy` : undefined
            }
          />
        ) : null}
        {provenance.correlationId ? (
          <DefinitionRow
            label={labels.fields.correlationId}
            value={provenance.correlationId}
            copyLabel={labels.actions.copy}
            onCopy={(value) => handleCopy(value)}
            testId={
              testIdPrefix ? `${testIdPrefix}-provenance-correlation-id` : undefined
            }
            copyTestId={
              testIdPrefix
                ? `${testIdPrefix}-provenance-correlation-id-copy`
                : undefined
            }
          />
        ) : null}
        {provenance.requestedBy ? (
          <DefinitionRow
            label={labels.fields.requestedBy}
            value={provenance.requestedBy}
            copyLabel={labels.actions.copy}
            onCopy={(value) => handleCopy(value)}
          />
        ) : null}
        {provenance.requestContextId ? (
          <DefinitionRow
            label={labels.fields.requestContextId}
            value={provenance.requestContextId}
            copyLabel={labels.actions.copy}
            onCopy={(value) => handleCopy(value)}
          />
        ) : null}
        {provenance.idempotencyKey ? (
          <DefinitionRow
            label={labels.fields.idempotencyKey}
            value={provenance.idempotencyKey}
            copyLabel={labels.actions.copy}
            onCopy={(value) => handleCopy(value)}
            testId={testIdPrefix ? `${testIdPrefix}-provenance-idempotency-key` : undefined}
            copyTestId={
              testIdPrefix ? `${testIdPrefix}-provenance-idempotency-key-copy` : undefined
            }
          />
        ) : null}
        {scope ? (
          <DefinitionRow
            label={labels.fields.scope}
            value={scope}
            copyLabel={labels.actions.copy}
            onCopy={(value) => handleCopy(value)}
            testId={testIdPrefix ? `${testIdPrefix}-provenance-scope` : undefined}
            copyTestId={testIdPrefix ? `${testIdPrefix}-provenance-scope-copy` : undefined}
          />
        ) : null}
        {provenance.workflowScheduleTriggerId ? (
          <DefinitionRow
            label={labels.fields.scheduleTriggerId}
            value={provenance.workflowScheduleTriggerId}
            href={safeHref(
              `/resources/workflow_schedule_triggers?id=${encodeURIComponent(
                provenance.workflowScheduleTriggerId
              )}`
            ) ?? undefined}
            actionLabel={labels.actions.openSchedule}
            copyLabel={labels.actions.copy}
            onCopy={(value) => handleCopy(value)}
          />
        ) : null}
        {provenance.workflowRunTriggerId ? (
          <DefinitionRow
            label={labels.fields.runTriggerId}
            value={provenance.workflowRunTriggerId}
            href={safeHref(
              `/resources/workflow_run_triggers?id=${encodeURIComponent(
                provenance.workflowRunTriggerId
              )}`
            ) ?? undefined}
            actionLabel={labels.actions.openTrigger}
            copyLabel={labels.actions.copy}
            onCopy={(value) => handleCopy(value)}
          />
        ) : null}
        {provenance.workflowTriggerFireId ? (
          <DefinitionRow
            label={labels.fields.triggerFireId}
            value={provenance.workflowTriggerFireId}
            href={safeHref(
              `/resources/workflow_trigger_fires?id=${encodeURIComponent(
                provenance.workflowTriggerFireId
              )}`
            ) ?? undefined}
            actionLabel={labels.actions.openFire}
            copyLabel={labels.actions.copy}
            onCopy={(value) => handleCopy(value)}
          />
        ) : null}
        {provenance.sourceWorkflowRunId ? (
          <DefinitionRow
            label={labels.fields.sourceRunId}
            value={provenance.sourceWorkflowRunId}
            href={
              safeHref(
                `/workflows/runs/${encodeURIComponent(
                  provenance.sourceWorkflowRunId
                )}`
              ) ?? undefined
            }
            actionLabel={labels.actions.openRun}
            copyLabel={labels.actions.copy}
            onCopy={(value) => handleCopy(value)}
          />
        ) : null}
      </div>

      {(provenance.sourceWorkflowStatus || provenance.sourceCompletedAt) && (
        <div className="rounded-xl border border-ui-border bg-ui-paper/40 p-3 text-xs text-ui-ink">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-ui-muted">
                {labels.fields.sourceStatus}
              </div>
              <div className="font-mono">
                {provenance.sourceWorkflowStatus ?? "-"}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-ui-muted">
                {labels.fields.sourceCompletedAt}
              </div>
              <div className="font-mono">
                {formatResourceValue(provenance.sourceCompletedAt, { renderType: "datetime" }) ||
                  "-"}
              </div>
            </div>
          </div>
        </div>
      )}

      {rawContext ? (
        <details className="rounded-xl border border-ui-border bg-ui-paper/40 p-3">
          <summary className="cursor-pointer text-sm font-medium text-ui-ink">
            {labels.actions.showRaw}
          </summary>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre rounded-xl border border-ui-border bg-ui-paper/60 p-3 font-mono text-[11px] leading-5 text-ui-ink">
            {rawContext}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
