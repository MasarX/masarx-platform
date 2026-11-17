"use client";

import * as React from "react";
import { Badge } from "./badge";
import { Button } from "./button";
import { ChevronDownIcon } from "./icons";
import { Input } from "./input";
import { Select } from "./select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
import { formatReferenceValue, formatResourceValue } from "./resource-utils";
import { cn } from "./utils";
import { useToast } from "./use-toast";
import { copyTextToClipboard } from "./clipboard";
import { downloadBlob } from "./file-download";
import { WorkflowTemplateStudioActions } from "./workflow-template-studio-actions";
import { resolveSafeHref } from "./url-guard";
import {
  countWorkflowRunLogStepIssues,
  filterWorkflowRunLogStepsByTemplateStep,
  formatJsonForUi,
  isWorkflowRunLogStepIssue,
  matchesWorkflowRunLogStep,
  normalizeWorkflowRunLogSteps,
  type WorkflowRunLogStep,
} from "./workflow-run-logs-model";
import {
  buildBatchReplayPayload,
  buildReplayPayload,
  extractReplayAudit,
  resolveReplayIssueSteps,
  type WorkflowRunStepReplayConfig,
} from "./workflow-run-replay";

type WorkflowRunLogsEmptyLabels = {
  title: string;
  description: string;
};

export type WorkflowRunLogsPanelLabels = {
  tabs: {
    simple: string;
    advanced: string;
  };
  summary: {
    stepsLabel: string;
    issuesLabel: string;
  };
  controls: {
    issuesOnly: string;
    replayLabel: string;
    replayLatestIssue: string;
    replayFirstIssue: string;
    replayAllIssues: string;
    replayModalTitle: string;
    replayModalDescription: string;
  };
  filters: {
    searchPlaceholder: string;
    statusLabel: string;
    statusAll: string;
  };
  actions: {
    copyJson: string;
    downloadJson: string;
    copySuccessTitle: string;
    copyFailedTitle: string;
    downloadFailedTitle: string;
  };
  empty: {
    title: string;
    description: string;
  };
  emptyNoMatches: WorkflowRunLogsEmptyLabels;
  emptyNoIssues: WorkflowRunLogsEmptyLabels;
  emptyStepFilter: WorkflowRunLogsEmptyLabels;
  step: {
    statusLabel: string;
    durationLabel: string;
    attemptLabel: string;
    decisionLogLabel: string;
    openDecisionLog: string;
    resultLabel: string;
    metadataLabel: string;
    errorLabel: string;
      notesLabel: string;
      timestampsLabel: string;
      enqueuedAtLabel: string;
      startedAtLabel: string;
      completedAtLabel: string;
      replayFromStep: string;
      replayModalTitle: string;
      replayModalDescription: string;
    };
};

type WorkflowRunLogsPanelProps = {
  steps: Record<string, unknown>[];
  appBasePath: string;
  labels: WorkflowRunLogsPanelLabels;
  testIdPrefix?: string;
  filterWorkflowTemplateStepId?: string | null;
  stepReplay?: WorkflowRunStepReplayConfig | null;
};

function ReplayPresetActions({
  issueSteps,
  stepReplay,
  labels,
  appBasePath,
  testIdPrefix,
}: {
  issueSteps: WorkflowRunLogStep[];
  stepReplay?: WorkflowRunStepReplayConfig | null;
  labels: WorkflowRunLogsPanelLabels;
  appBasePath: string;
  testIdPrefix?: string;
}) {
  if (!stepReplay || issueSteps.length === 0) return null;
  const firstIssue = issueSteps[0] ?? null;
  const latestIssue = issueSteps[issueSteps.length - 1] ?? null;
  if (!latestIssue) return null;
  const showFirst =
    Boolean(firstIssue) &&
    Boolean(firstIssue?.id) &&
    Boolean(latestIssue.id) &&
    firstIssue?.id !== latestIssue.id;
  const showAll = issueSteps.length > 1;
  const latestPayload = buildReplayPayload(
    stepReplay.payload,
    latestIssue,
    stepReplay.workflowRunId
  );
  const firstPayload =
    showFirst && firstIssue
      ? buildReplayPayload(stepReplay.payload, firstIssue, stepReplay.workflowRunId)
      : null;
  const allPayload = showAll
    ? buildBatchReplayPayload(stepReplay.payload, issueSteps, stepReplay.workflowRunId)
    : null;

  return (
    <div
      className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ui-border bg-ui-paper/60 p-2"
      data-testid={testIdPrefix ? `${testIdPrefix}-logs-replay-presets` : undefined}
    >
      <div className="text-xs font-medium text-ui-muted">{labels.controls.replayLabel}</div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {showFirst && firstPayload ? (
          <WorkflowTemplateStudioActions
            templateId={stepReplay.workflowTemplateId}
            capabilities={stepReplay.capabilities}
            appBasePath={appBasePath}
            defaultPayload={firstPayload}
            triggerLabel={labels.controls.replayFirstIssue}
            modalTitle={labels.controls.replayModalTitle}
            modalDescription={labels.controls.replayModalDescription}
            testIdPrefix={
              testIdPrefix ? `${testIdPrefix}-logs-replay-first` : null
            }
          />
        ) : null}
        <WorkflowTemplateStudioActions
          templateId={stepReplay.workflowTemplateId}
          capabilities={stepReplay.capabilities}
          appBasePath={appBasePath}
          defaultPayload={latestPayload}
          triggerLabel={labels.controls.replayLatestIssue}
          modalTitle={labels.controls.replayModalTitle}
          modalDescription={labels.controls.replayModalDescription}
          testIdPrefix={
            testIdPrefix ? `${testIdPrefix}-logs-replay-latest` : null
          }
        />
        {showAll && allPayload ? (
          <WorkflowTemplateStudioActions
            templateId={stepReplay.workflowTemplateId}
            capabilities={stepReplay.capabilities}
            appBasePath={appBasePath}
            defaultPayload={allPayload}
            triggerLabel={labels.controls.replayAllIssues}
            modalTitle={labels.controls.replayModalTitle}
            modalDescription={labels.controls.replayModalDescription}
            testIdPrefix={
              testIdPrefix ? `${testIdPrefix}-logs-replay-all` : null
            }
          />
        ) : null}
      </div>
    </div>
  );
}

function resolveReplayAuditStepCount(audit: ReturnType<typeof extractReplayAudit>) {
  if (!audit) return 0;
  if (audit.sourceWorkflowRunStepIds.length > 0) {
    return audit.sourceWorkflowRunStepIds.length;
  }
  if (audit.sourceWorkflowTemplateStepIds.length > 0) {
    return audit.sourceWorkflowTemplateStepIds.length;
  }
  if (audit.sourceWorkflowRunStepId || audit.sourceWorkflowTemplateStepId) {
    return 1;
  }
  return 0;
}

function resolveStatusOptions(steps: WorkflowRunLogStep[]) {
  const options = new Map<string, string>();
  steps.forEach((step) => {
    if (!step.status) return;
    if (!options.has(step.status)) {
      options.set(step.status, step.statusLabel);
    }
  });
  return Array.from(options.entries()).sort((left, right) => left[1].localeCompare(right[1]));
}

function DecisionLogAction({
  appBasePath,
  decisionLogId,
  label,
  variant = "ghost",
  compact = false,
}: {
  appBasePath: string;
  decisionLogId: string;
  label: string;
  variant?: "solid" | "ghost" | "soft";
  compact?: boolean;
}) {
  const href = resolveSafeHref(
    appBasePath,
    `/resources/decision_log?id=${encodeURIComponent(decisionLogId)}`
  );

  if (!href) {
    return <span className="text-sm text-ui-muted">{label}</span>;
  }

  return (
    <Button asChild size="sm" variant={variant} className={compact ? "px-0" : undefined}>
      <a href={href} target="_blank" rel="noreferrer">
        {label}
      </a>
    </Button>
  );
}

function StepSummaryLine({ step, labels }: { step: WorkflowRunLogStep; labels: WorkflowRunLogsPanelLabels }) {
  const duration = step.durationLabel ? (
    <span className="text-xs text-ui-muted">
      {labels.step.durationLabel}: {step.durationLabel}
    </span>
  ) : null;
  const attempt =
    typeof step.retryAttempt === "number" && typeof step.maxRetries === "number" ? (
      <span className="text-xs text-ui-muted">
        {labels.step.attemptLabel}: {step.retryAttempt}/{step.maxRetries}
      </span>
    ) : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={step.statusTone}>{step.statusLabel}</Badge>
      {duration}
      {attempt}
    </div>
  );
}

function StepJsonBlock({
  title,
  value,
}: {
  title: string;
  value: unknown;
}) {
  const formatted = React.useMemo(() => formatJsonForUi(value), [value]);
  if (!formatted) return null;
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-ui-muted">{title}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre rounded-xl border border-ui-border bg-ui-paper/60 p-3 font-mono text-[11px] leading-5 text-ui-ink">
        {formatted}
      </pre>
    </div>
  );
}

function SimpleLogView({
  steps,
  labels,
  emptyLabels,
  appBasePath,
  stepReplay,
  testIdPrefix,
}: {
  steps: WorkflowRunLogStep[];
  labels: WorkflowRunLogsPanelLabels;
  emptyLabels?: WorkflowRunLogsEmptyLabels | null;
  appBasePath: string;
  stepReplay?: WorkflowRunStepReplayConfig | null;
  testIdPrefix?: string;
}) {
  if (steps.length === 0) {
    const resolvedEmpty = emptyLabels ?? labels.empty;
    return (
      <div
        className="rounded-xl border border-ui-border bg-ui-paper/60 p-4 text-sm text-ui-muted"
        data-testid={testIdPrefix ? `${testIdPrefix}-logs-simple-empty` : undefined}
      >
        <div className="font-medium text-ui-ink">{resolvedEmpty.title}</div>
        <div className="mt-1 text-xs text-ui-muted">{resolvedEmpty.description}</div>
      </div>
    );
  }

  return (
    <ol
      className="space-y-3"
      data-testid={testIdPrefix ? `${testIdPrefix}-logs-simple` : undefined}
    >
      {steps.map((step) => {
        const error = step.lastError ? (
          <div className="mt-2 rounded-lg border border-ui-border bg-ui-surface/70 p-3 text-xs text-ui-ink">
            <div className="font-medium text-ui-muted">{labels.step.errorLabel}</div>
            <div className="mt-1 whitespace-pre-wrap break-words">{step.lastError}</div>
          </div>
        ) : null;
        const canReplayFromStep =
          Boolean(
            stepReplay?.workflowTemplateId &&
              stepReplay?.workflowRunId &&
              step.workflowTemplateStepId &&
              isWorkflowRunLogStepIssue(step)
          );
        const stepReplayPayload =
          canReplayFromStep && stepReplay
            ? buildReplayPayload(stepReplay.payload, step, stepReplay.workflowRunId)
            : null;

        return (
          <li
            key={step.id}
            className="rounded-xl border border-ui-border bg-ui-surface p-4"
            data-testid={
              testIdPrefix ? `${testIdPrefix}-logs-simple-step-${step.id}` : undefined
            }
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="truncate text-sm font-semibold text-ui-ink">
                    {step.operationLabel}
                  </div>
                  {typeof step.sequenceOrder === "number" ? (
                    <span className="rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 font-mono text-[11px] text-ui-muted">
                      #{step.sequenceOrder}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2">
                  <StepSummaryLine step={step} labels={labels} />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {canReplayFromStep && stepReplayPayload && stepReplay ? (
                  <WorkflowTemplateStudioActions
                    templateId={stepReplay.workflowTemplateId}
                    capabilities={stepReplay.capabilities}
                    appBasePath={appBasePath}
                    defaultPayload={stepReplayPayload}
                    triggerLabel={labels.step.replayFromStep}
                    modalTitle={labels.step.replayModalTitle}
                    modalDescription={labels.step.replayModalDescription}
                    testIdPrefix={
                      testIdPrefix ? `${testIdPrefix}-logs-step-replay-${step.id}` : null
                    }
                  />
                ) : null}
                {step.decisionLogId ? (
                  <DecisionLogAction
                    appBasePath={appBasePath}
                    decisionLogId={step.decisionLogId}
                    label={labels.step.openDecisionLog}
                  />
                ) : null}
              </div>
            </div>
            {error}
          </li>
        );
      })}
    </ol>
  );
}

function AdvancedLogView({
  steps,
  labels,
  emptyLabels,
  appBasePath,
  stepReplay,
  testIdPrefix,
}: {
  steps: WorkflowRunLogStep[];
  labels: WorkflowRunLogsPanelLabels;
  emptyLabels?: WorkflowRunLogsEmptyLabels | null;
  appBasePath: string;
  stepReplay?: WorkflowRunStepReplayConfig | null;
  testIdPrefix?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("");
  const { toast } = useToast();

  const statusOptions = React.useMemo(() => resolveStatusOptions(steps), [steps]);
  const filtered = React.useMemo(() => {
    return steps.filter((step) => {
      if (status && step.status !== status) return false;
      return matchesWorkflowRunLogStep(step, query);
    });
  }, [query, status, steps]);

  const exportJson = React.useMemo(() => formatJsonForUi(filtered), [filtered]);
  const exportDisabled = filtered.length === 0 || !exportJson;
  const emptyState = steps.length === 0 ? (emptyLabels ?? labels.empty) : labels.emptyNoMatches;

  const handleCopyJson = async () => {
    if (!exportJson) return;
    try {
      const success = await copyTextToClipboard(exportJson);
      toast({
        title: success ? labels.actions.copySuccessTitle : labels.actions.copyFailedTitle,
        tone: success ? "success" : "error",
      });
    } catch {
      toast({
        title: labels.actions.copyFailedTitle,
        tone: "error",
      });
    }
  };

  const handleDownloadJson = () => {
    if (!exportJson) return;
    const name = `workflow-run-logs-${new Date().toISOString().slice(0, 10)}.json`;
    const blob = new Blob([exportJson], { type: "application/json;charset=utf-8;" });
    const ok = downloadBlob(blob, name);
    if (!ok) {
      toast({
        title: labels.actions.downloadFailedTitle,
        tone: "error",
      });
    }
  };

  return (
    <div data-testid={testIdPrefix ? `${testIdPrefix}-logs-advanced` : undefined}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-1 flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <div className="text-[11px] font-medium text-ui-muted">{labels.filters.searchPlaceholder}</div>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={labels.filters.searchPlaceholder}
              data-testid={testIdPrefix ? `${testIdPrefix}-logs-filter-search` : undefined}
            />
          </div>
          <div className="min-w-[180px]">
            <div className="text-[11px] font-medium text-ui-muted">{labels.filters.statusLabel}</div>
            <Select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              data-testid={testIdPrefix ? `${testIdPrefix}-logs-filter-status` : undefined}
            >
              <option value="">{labels.filters.statusAll}</option>
              {statusOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {steps.length > 0 ? (
            <div className="text-xs text-ui-muted">
              {filtered.length} / {steps.length}
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={exportDisabled}
            className="border border-ui-border bg-ui-paper/60 text-ui-ink hover:bg-ui-highlight/70"
            onClick={handleCopyJson}
            data-testid={testIdPrefix ? `${testIdPrefix}-logs-action-copy-json` : undefined}
          >
            {labels.actions.copyJson}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={exportDisabled}
            className="border border-ui-border bg-ui-paper/60 text-ui-ink hover:bg-ui-highlight/70"
            onClick={handleDownloadJson}
            data-testid={testIdPrefix ? `${testIdPrefix}-logs-action-download-json` : undefined}
          >
            {labels.actions.downloadJson}
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="mt-4 rounded-xl border border-ui-border bg-ui-paper/60 p-4 text-sm text-ui-muted">
          <div className="font-medium text-ui-ink">{emptyState.title}</div>
          <div className="mt-1 text-xs text-ui-muted">{emptyState.description}</div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {filtered.map((step) => {
            const canReplayFromStep =
              Boolean(
                stepReplay?.workflowTemplateId &&
                  stepReplay?.workflowRunId &&
                  step.workflowTemplateStepId &&
                  isWorkflowRunLogStepIssue(step)
              );
            const stepReplayPayload =
              canReplayFromStep && stepReplay
                ? buildReplayPayload(stepReplay.payload, step, stepReplay.workflowRunId)
                : null;

            return (
              <details
                key={step.id}
                className="group rounded-xl border border-ui-border bg-ui-surface"
                data-testid={testIdPrefix ? `${testIdPrefix}-logs-step-${step.id}` : undefined}
              >
              <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="truncate text-sm font-semibold text-ui-ink">
                      {step.operationLabel}
                    </div>
                    {typeof step.sequenceOrder === "number" ? (
                      <span className="rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 font-mono text-[11px] text-ui-muted">
                        #{step.sequenceOrder}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2">
                    <StepSummaryLine step={step} labels={labels} />
                  </div>
                </div>
                <ChevronDownIcon className="text-ui-muted transition group-open:rotate-180" />
              </summary>

              <div className="space-y-4 border-t border-ui-border px-4 py-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <div className="text-[11px] font-medium text-ui-muted">
                      {labels.step.statusLabel}
                    </div>
                    <div className="text-sm text-ui-ink">
                      <Badge tone={step.statusTone}>{step.statusLabel}</Badge>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-[11px] font-medium text-ui-muted">
                      {labels.step.durationLabel}
                    </div>
                    <div className="text-sm text-ui-ink">{step.durationLabel ?? "-"}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-[11px] font-medium text-ui-muted">
                      {labels.step.attemptLabel}
                    </div>
                    <div className="text-sm text-ui-ink">
                      {typeof step.retryAttempt === "number" &&
                      typeof step.maxRetries === "number"
                        ? `${step.retryAttempt}/${step.maxRetries}`
                        : "-"}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-[11px] font-medium text-ui-muted">
                      {labels.step.decisionLogLabel}
                    </div>
                    {step.decisionLogId ? (
                      <DecisionLogAction
                        appBasePath={appBasePath}
                        decisionLogId={step.decisionLogId}
                        label={labels.step.openDecisionLog}
                        variant="ghost"
                        compact
                      />
                    ) : (
                      <div className="text-sm text-ui-ink">-</div>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-ui-border bg-ui-paper/60 p-3">
                  <div className="text-xs font-medium text-ui-muted">
                    {labels.step.timestampsLabel}
                  </div>
                  <div className="mt-2 grid gap-2 text-xs text-ui-ink md:grid-cols-3">
                    <div>
                      <div className="text-[11px] text-ui-muted">{labels.step.enqueuedAtLabel}</div>
                      <div className="mt-0.5 font-mono">
                        {formatResourceValue(step.enqueuedAt, { renderType: "datetime" })}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-ui-muted">{labels.step.startedAtLabel}</div>
                      <div className="mt-0.5 font-mono">
                        {formatResourceValue(step.startedAt, { renderType: "datetime" })}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-ui-muted">{labels.step.completedAtLabel}</div>
                      <div className="mt-0.5 font-mono">
                        {formatResourceValue(step.completedAt, { renderType: "datetime" })}
                      </div>
                    </div>
                  </div>
                </div>

                {step.notes ? (
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-ui-muted">{labels.step.notesLabel}</div>
                    <div className="whitespace-pre-wrap break-words rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-xs text-ui-ink">
                      {step.notes}
                    </div>
                  </div>
                ) : null}

                {step.lastError ? (
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-ui-muted">{labels.step.errorLabel}</div>
                    <div className="whitespace-pre-wrap break-words rounded-xl border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.08)] p-3 text-xs text-ui-ink">
                      {step.lastError}
                    </div>
                  </div>
                ) : null}

                <div className={cn("grid gap-4", step.operationResult && step.metadata ? "lg:grid-cols-2" : "")}>
                  <StepJsonBlock title={labels.step.resultLabel} value={step.operationResult} />
                  <StepJsonBlock title={labels.step.metadataLabel} value={step.metadata} />
                </div>
                {canReplayFromStep && stepReplayPayload && stepReplay ? (
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ui-border pt-3">
                    <WorkflowTemplateStudioActions
                      templateId={stepReplay.workflowTemplateId}
                      capabilities={stepReplay.capabilities}
                      appBasePath={appBasePath}
                      defaultPayload={stepReplayPayload}
                      triggerLabel={labels.step.replayFromStep}
                      modalTitle={labels.step.replayModalTitle}
                      modalDescription={labels.step.replayModalDescription}
                      testIdPrefix={
                        testIdPrefix ? `${testIdPrefix}-logs-step-replay-${step.id}` : null
                      }
                    />
                  </div>
                ) : null}
              </div>
            </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function WorkflowRunLogsPanel({
  steps,
  appBasePath,
  labels,
  testIdPrefix,
  filterWorkflowTemplateStepId,
  stepReplay,
}: WorkflowRunLogsPanelProps) {
  const [issuesOnly, setIssuesOnly] = React.useState(false);
  const normalized = React.useMemo(() => normalizeWorkflowRunLogSteps(steps), [steps]);
  const replayAudit = React.useMemo(
    () => extractReplayAudit(stepReplay?.payload),
    [stepReplay?.payload]
  );
  const filteredByTemplateStep = React.useMemo(
    () => filterWorkflowRunLogStepsByTemplateStep(normalized, filterWorkflowTemplateStepId),
    [filterWorkflowTemplateStepId, normalized]
  );
  const issuesCount = React.useMemo(
    () => countWorkflowRunLogStepIssues(filteredByTemplateStep),
    [filteredByTemplateStep]
  );
  const filteredByControls = React.useMemo(() => {
    if (!issuesOnly) return filteredByTemplateStep;
    return filteredByTemplateStep.filter(isWorkflowRunLogStepIssue);
  }, [filteredByTemplateStep, issuesOnly]);
  const replayIssueSteps = React.useMemo(
    () => resolveReplayIssueSteps(filteredByTemplateStep, stepReplay),
    [filteredByTemplateStep, stepReplay]
  );
  const replayAuditStepCount = React.useMemo(
    () => resolveReplayAuditStepCount(replayAudit),
    [replayAudit]
  );
  const emptyLabels = React.useMemo(() => {
    if (normalized.length === 0) return labels.empty;
    const hasTemplateStepFilter = Boolean(filterWorkflowTemplateStepId?.trim());
    if (hasTemplateStepFilter && filteredByTemplateStep.length === 0) return labels.emptyStepFilter;
    if (issuesOnly && filteredByControls.length === 0) return labels.emptyNoIssues;
    return null;
  }, [
    filteredByControls.length,
    filteredByTemplateStep.length,
    filterWorkflowTemplateStepId,
    issuesOnly,
    labels.empty,
    labels.emptyNoIssues,
    labels.emptyStepFilter,
    normalized.length,
  ]);

  return (
    <div data-testid={testIdPrefix ? `${testIdPrefix}-logs` : undefined}>
      <div
        className="mb-3 flex flex-wrap items-center justify-between gap-3"
        data-testid={testIdPrefix ? `${testIdPrefix}-logs-summary` : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">
            {labels.summary.stepsLabel}: {filteredByControls.length}
          </Badge>
          <Badge tone={issuesCount > 0 ? "danger" : "neutral"}>
            {labels.summary.issuesLabel}: {issuesCount}
          </Badge>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(
            "border border-ui-border bg-ui-paper/60 text-ui-ink hover:bg-ui-highlight/70",
            issuesOnly ? "bg-ui-highlight/70" : ""
          )}
          aria-pressed={issuesOnly}
          onClick={() => setIssuesOnly((value) => !value)}
          data-testid={testIdPrefix ? `${testIdPrefix}-logs-issues-toggle` : undefined}
        >
          {labels.controls.issuesOnly}
        </Button>
      </div>
      <ReplayPresetActions
        issueSteps={replayIssueSteps}
        stepReplay={stepReplay}
        labels={labels}
        appBasePath={appBasePath}
        testIdPrefix={testIdPrefix}
      />
      {replayAudit ? (
        <div
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ui-border bg-ui-paper/60 p-2"
          data-testid={testIdPrefix ? `${testIdPrefix}-logs-replay-audit` : undefined}
        >
          <div className="text-xs font-medium text-ui-muted">
            {labels.controls.replayLabel}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
            <Badge tone="neutral">{replayAudit.mode}</Badge>
            {replayAudit.sourceRunId ? (
              <Badge tone="neutral">
                {formatReferenceValue(replayAudit.sourceRunId)}
              </Badge>
            ) : null}
            {replayAuditStepCount > 0 ? (
              <Badge tone="neutral">
                {labels.summary.stepsLabel}: {replayAuditStepCount}
              </Badge>
            ) : null}
            <Badge tone={issuesCount > 0 ? "warning" : "neutral"}>
              {labels.summary.issuesLabel}: {issuesCount}
            </Badge>
          </div>
        </div>
      ) : null}
      <Tabs defaultValue="simple">
        <TabsList className="w-full flex-wrap">
          <TabsTrigger
            value="simple"
            data-testid={testIdPrefix ? `${testIdPrefix}-logs-tab-simple` : undefined}
          >
            {labels.tabs.simple}
          </TabsTrigger>
          <TabsTrigger
            value="advanced"
            data-testid={testIdPrefix ? `${testIdPrefix}-logs-tab-advanced` : undefined}
          >
            {labels.tabs.advanced}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="simple">
          <SimpleLogView
            steps={filteredByControls}
            labels={labels}
            emptyLabels={emptyLabels}
            appBasePath={appBasePath}
            stepReplay={stepReplay}
            testIdPrefix={testIdPrefix}
          />
        </TabsContent>
        <TabsContent value="advanced">
          <AdvancedLogView
            steps={filteredByControls}
            labels={labels}
            emptyLabels={emptyLabels}
            appBasePath={appBasePath}
            stepReplay={stepReplay}
            testIdPrefix={testIdPrefix}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
