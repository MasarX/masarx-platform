import "server-only";
import { createUiServerClient } from "@masarx/api/server";
import type { UiReadRegistry, UiResourceList } from "@masarx/api";
import { PageHeader } from "./page-header";
import { ResourceDetail } from "./resource-detail";
import { ResourceTable } from "./resource-table";
import { Section } from "./section";
import { Button } from "./button";
import { Badge } from "./badge";
import { formatUiError } from "./utils";
import { resolvePaginationSettings } from "./pagination-utils";
import { resolveColumns } from "./resource-page-utils";
import { extractWorkflowRunOutputs } from "./workflow-run-outputs";
import { WorkflowRunLogsPanel } from "./workflow-run-logs-panel";
import { createWorkflowRunLogsPanelLabels } from "./workflow-run-logs-labels";
import { WorkflowRunProvenancePanel } from "./workflow-run-provenance-panel";
import { createWorkflowRunProvenanceLabels } from "./workflow-run-provenance-labels";
import { WorkflowTemplateStudioActions } from "./workflow-template-studio-actions";
import { extractWorkflowRunCorrelationId } from "./workflow-run-provenance-model";
import { findRegistryResource } from "./ui-registry-utils";
import { formatDurationMs, normalizeWorkflowRunLogSteps } from "./workflow-run-logs-model";
import {
  buildBatchReplayPayload,
  buildReplayPayload,
  extractReplayAudit,
  resolveReplayIssueSteps,
} from "./workflow-run-replay";
import type { UiTranslateFn } from "./translate";
import { labelFromKey } from "./resource-query";
import { formatReferenceValue } from "./resource-utils";
import { resolveSafeHref } from "./url-guard";
import { CopyFieldButton } from "./detail/copy-field-button";

type WorkflowRunPageProps = {
  runId: string;
  appBasePath: string;
  t: UiTranslateFn;
  includeTraceLink?: boolean;
  testIdPrefix?: string | null;
};

function normalizeText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveWorkflowTemplateId(detail: Record<string, unknown> | null) {
  if (!detail) return null;
  return normalizeText(detail.workflow_template_id);
}

function resolveWorkflowRunReplayPayload(detail: Record<string, unknown> | null) {
  if (!detail) return {};
  const payload = normalizeRecord(detail.payload);
  if (payload) return payload;
  const requestPayload = normalizeRecord(detail.request_payload);
  if (requestPayload) return requestPayload;
  const context = normalizeRecord(detail.context);
  if (context) return context;
  return {};
}

function parseIsoTimestamp(value: string | null) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function resolveWorkflowRunTimestamp(detail: Record<string, unknown> | null, keys: string[]) {
  if (!detail) return null;
  for (const key of keys) {
    const candidate = normalizeText(detail[key]);
    if (candidate) return candidate;
  }
  return null;
}

function resolveWorkflowRunStatus(detail: Record<string, unknown> | null) {
  return resolveWorkflowRunTimestamp(detail, [
    "status",
    "run_status",
    "workflow_status",
    "state",
  ]);
}

function resolveWorkflowRunStatusTone(status: string | null) {
  if (!status) return "neutral";
  const normalized = status.toLowerCase();
  if (normalized.includes("fail") || normalized.includes("error")) return "danger";
  if (normalized.includes("complete") || normalized.includes("success")) return "success";
  if (normalized.includes("progress") || normalized.includes("running")) return "info";
  if (normalized.includes("cancel")) return "neutral";
  if (normalized.includes("pending") || normalized.includes("queued")) return "warning";
  return "neutral";
}

export async function WorkflowRunPage({
  runId,
  appBasePath,
  t,
  includeTraceLink = false,
  testIdPrefix,
}: WorkflowRunPageProps) {
  const ui = createUiServerClient();
  let registry: UiReadRegistry | null = null;
  let userCapabilities: string[] | null = null;
  let detail: Record<string, unknown> | null = null;
  let detailError: string | null = null;
  let stepsList: UiResourceList | null = null;
  let steps: Record<string, unknown>[] = [];
  let stepsTotal: number | null = null;
  let stepsError: string | null = null;
  let paginationSettings = resolvePaginationSettings(null);

  try {
    registry = await ui.readRegistry();
  } catch (_error) {
    registry = null;
  }

  try {
    const me = await ui.me();
    userCapabilities = Array.isArray(me?.capabilities) ? me.capabilities : null;
  } catch (_error) {
    userCapabilities = null;
  }

  try {
    const preview = await ui.settingsPreview({ category: "ui_pagination" });
    paginationSettings = resolvePaginationSettings(preview?.value);
  } catch (_error) {
    paginationSettings = resolvePaginationSettings(null);
  }

  try {
    detail = await ui.getResource("workflow_runs", runId);
  } catch (error) {
    detailError = formatUiError(error, t("observability.workflowRun.errors.loadDetail"));
  }

  try {
    const stepLimit = Math.max(1, paginationSettings.maxPageSize);
    stepsList = await ui.listResource(
      "workflow_run_steps",
      { workflow_run_id: runId },
      stepLimit,
      0
    );
    steps = Array.isArray(stepsList.items) ? stepsList.items : [];
    stepsTotal = typeof stepsList.total === "number" ? stepsList.total : null;
  } catch (error) {
    stepsError = formatUiError(error, t("observability.workflowRun.errors.loadSteps"));
  }

  const stepsResource = findRegistryResource(registry, "workflow_run_steps");
  const stepColumns = resolveColumns(stepsResource, stepsList);
  const traceId = extractWorkflowRunCorrelationId(detail);
  const outputs = extractWorkflowRunOutputs(detail);
  const workflowTemplateId = resolveWorkflowTemplateId(detail);
  const replayPayload = resolveWorkflowRunReplayPayload(detail);
  const replayAudit = extractReplayAudit(replayPayload);
  const replayIssueSteps = workflowTemplateId
    ? resolveReplayIssueSteps(normalizeWorkflowRunLogSteps(steps), {
        workflowTemplateId,
        workflowRunId: runId,
      })
    : [];
  const firstReplayIssue = replayIssueSteps[0] ?? null;
  const latestReplayIssue =
    replayIssueSteps[replayIssueSteps.length - 1] ?? null;
  const showFirstReplayIssue =
    Boolean(firstReplayIssue) &&
    Boolean(latestReplayIssue) &&
    firstReplayIssue?.id !== latestReplayIssue?.id;
  const showBatchReplay = replayIssueSteps.length > 1;
  const latestReplayPayload =
    latestReplayIssue && workflowTemplateId
      ? buildReplayPayload(replayPayload, latestReplayIssue, runId)
      : null;
  const firstReplayPayload =
    firstReplayIssue && workflowTemplateId && showFirstReplayIssue
      ? buildReplayPayload(replayPayload, firstReplayIssue, runId)
      : null;
  const batchReplayPayload =
    workflowTemplateId && showBatchReplay
      ? buildBatchReplayPayload(replayPayload, replayIssueSteps, runId)
      : null;
  const clientPagination = {
    pageSizes: paginationSettings.allowedSizes,
    defaultPageSize: paginationSettings.defaultPageSize,
  };
  const stepsCountLabel =
    typeof stepsTotal === "number"
      ? t("observability.workflowRun.steps.countWithTotal", {
          count: steps.length,
          total: stepsTotal,
        })
      : t("observability.workflowRun.steps.count", { count: steps.length });
  const replayModeLabel = replayAudit ? labelFromKey(replayAudit.mode) : null;
  const replaySourceLabel = replayAudit?.sourceRunId
    ? formatReferenceValue(replayAudit.sourceRunId)
    : null;

  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const logLabels = createWorkflowRunLogsPanelLabels(t, {
    keyPrefix: "observability.workflowRun.logs",
  });
  const provenanceLabels = createWorkflowRunProvenanceLabels(t, {
    keyPrefix: "observability.workflowRun.provenance",
  });

  const runStatus = resolveWorkflowRunStatus(detail);
  const runStatusTone = resolveWorkflowRunStatusTone(runStatus);
  const runStatusLabel = runStatus ? labelFromKey(runStatus) : "-";
  const createdAt = resolveWorkflowRunTimestamp(detail, [
    "created_at",
    "enqueued_at",
    "requested_at",
  ]);
  const startedAt = resolveWorkflowRunTimestamp(detail, [
    "started_at",
    "run_started_at",
    "operation_started_at",
  ]);
  const completedAt = resolveWorkflowRunTimestamp(detail, [
    "completed_at",
    "run_completed_at",
    "operation_completed_at",
  ]);
  const durationMs = (() => {
    const start = parseIsoTimestamp(startedAt ?? createdAt);
    const end = parseIsoTimestamp(completedAt);
    if (start === null || end === null) return null;
    return Math.max(0, end - start);
  })();
  const durationLabel = formatDurationMs(durationMs);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("observability.workflowRun.title")}
        description={t("observability.workflowRun.description")}
      />
      <Section
        title={t("observability.workflowRun.detailTitle")}
        collapsible
        collapseKey="observability.workflowRun.detail"
      >
        {detailError ? (
          <div
            data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-error` : undefined}
            className="space-y-2 text-sm text-ui-muted"
          >
            <p>{t("observability.workflowRun.unavailable")}</p>
            <p className="text-xs text-ui-muted/70">{detailError}</p>
          </div>
        ) : (
          <div
            data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-ready` : undefined}
            className="space-y-4"
          >
            <div
              data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-summary` : undefined}
              className="space-y-3 rounded-2xl border border-ui-border bg-ui-surface/70 p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={runStatusTone}>{runStatusLabel}</Badge>
                {durationLabel ? (
                  <Badge tone="neutral">
                    {t("observability.workflowRun.summary.duration")}: {durationLabel}
                  </Badge>
                ) : null}
                <Badge tone="neutral">
                  {t("observability.workflowRun.summary.steps")}: {steps.length}
                </Badge>
                <Badge tone="neutral">
                  {t("observability.workflowRun.summary.issues")}: {replayIssueSteps.length}
                </Badge>
                {replayAudit ? (
                  <Badge tone="neutral">
                    {t("observability.workflowRun.logs.controls.replayLabel")}:{" "}
                    {replayAudit.mode}
                  </Badge>
                ) : null}
                {replayAudit?.sourceRunId ? (
                  <Badge tone="neutral">
                    {formatReferenceValue(replayAudit.sourceRunId)}
                  </Badge>
                ) : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-ui-border/60 bg-ui-paper/50 p-3">
                  <div className="text-[10px] uppercase tracking-wide text-ui-muted">
                    {t("observability.workflowRun.summary.createdAt")}
                  </div>
                  <div className="mt-1 text-sm text-ui-ink">{createdAt ?? "-"}</div>
                </div>
                <div className="rounded-xl border border-ui-border/60 bg-ui-paper/50 p-3">
                  <div className="text-[10px] uppercase tracking-wide text-ui-muted">
                    {t("observability.workflowRun.summary.startedAt")}
                  </div>
                  <div className="mt-1 text-sm text-ui-ink">{startedAt ?? "-"}</div>
                </div>
                <div className="rounded-xl border border-ui-border/60 bg-ui-paper/50 p-3">
                  <div className="text-[10px] uppercase tracking-wide text-ui-muted">
                    {t("observability.workflowRun.summary.completedAt")}
                  </div>
                  <div className="mt-1 text-sm text-ui-ink">{completedAt ?? "-"}</div>
                </div>
              </div>
            </div>
            <ResourceDetail
              data={detail}
              emptyMessage={t("observability.workflowRun.notFound")}
              testIdPrefix={resolvedTestIdPrefix || undefined}
            />
            {workflowTemplateId ? (
              <div className="space-y-2">
                {latestReplayPayload ? (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ui-border bg-ui-paper/60 p-3"
                    data-testid={
                      resolvedTestIdPrefix
                        ? `${resolvedTestIdPrefix}-replay-presets`
                        : undefined
                    }
                  >
                    <div className="text-xs text-ui-muted">
                      {t("observability.workflowRun.logs.controls.replayLabel")}{" "}
                      ({replayIssueSteps.length})
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {showFirstReplayIssue && firstReplayPayload ? (
                        <WorkflowTemplateStudioActions
                          templateId={workflowTemplateId}
                          capabilities={userCapabilities}
                          appBasePath={appBasePath}
                          defaultPayload={firstReplayPayload}
                          triggerLabel={t(
                            "observability.workflowRun.logs.controls.replayFirstIssue"
                          )}
                          modalTitle={t(
                            "observability.workflowRun.logs.controls.replayModalTitle"
                          )}
                          modalDescription={t(
                            "observability.workflowRun.logs.controls.replayModalDescription"
                          )}
                          testIdPrefix={
                            resolvedTestIdPrefix
                              ? `${resolvedTestIdPrefix}-replay-first`
                              : null
                          }
                        />
                      ) : null}
                      <WorkflowTemplateStudioActions
                        templateId={workflowTemplateId}
                        capabilities={userCapabilities}
                        appBasePath={appBasePath}
                        defaultPayload={latestReplayPayload}
                        triggerLabel={t(
                          "observability.workflowRun.logs.controls.replayLatestIssue"
                        )}
                        modalTitle={t(
                          "observability.workflowRun.logs.controls.replayModalTitle"
                        )}
                        modalDescription={t(
                          "observability.workflowRun.logs.controls.replayModalDescription"
                        )}
                        testIdPrefix={
                          resolvedTestIdPrefix
                            ? `${resolvedTestIdPrefix}-replay-latest`
                            : null
                        }
                      />
                      {showBatchReplay && batchReplayPayload ? (
                        <WorkflowTemplateStudioActions
                          templateId={workflowTemplateId}
                          capabilities={userCapabilities}
                          appBasePath={appBasePath}
                          defaultPayload={batchReplayPayload}
                          triggerLabel={t(
                            "observability.workflowRun.logs.controls.replayAllIssues"
                          )}
                          modalTitle={t(
                            "observability.workflowRun.logs.controls.replayModalTitle"
                          )}
                          modalDescription={t(
                            "observability.workflowRun.logs.controls.replayModalDescription"
                          )}
                          testIdPrefix={
                            resolvedTestIdPrefix
                              ? `${resolvedTestIdPrefix}-replay-all`
                              : null
                          }
                        />
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ui-border bg-ui-surface/70 p-3">
                  <WorkflowTemplateStudioActions
                    templateId={workflowTemplateId}
                    capabilities={userCapabilities}
                    appBasePath={appBasePath}
                    defaultPayload={replayPayload}
                    testIdPrefix={
                      resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-replay` : null
                    }
                  />
                  {resolveSafeHref(
                    appBasePath,
                    `/workflows/templates/${encodeURIComponent(workflowTemplateId)}`
                  ) ? (
                    <a
                      className="text-sm text-ui-ink underline underline-offset-4"
                      href={
                        resolveSafeHref(
                          appBasePath,
                          `/workflows/templates/${encodeURIComponent(workflowTemplateId)}`
                        ) ?? "#"
                      }
                    >
                      {t("observability.workflowRun.openTemplate")}
                    </a>
                  ) : (
                    <span className="text-sm text-ui-muted">
                      {t("observability.workflowRun.openTemplate")}
                    </span>
                  )}
                </div>
              </div>
            ) : null}
            <WorkflowRunProvenancePanel
              workflowRun={detail}
              appBasePath={appBasePath}
              labels={provenanceLabels}
              testIdPrefix={resolvedTestIdPrefix || undefined}
            />
            {includeTraceLink && traceId ? (
              resolveSafeHref(appBasePath, `/observability/trace/${encodeURIComponent(traceId)}`) ? (
                <a
                  className="text-sm text-ui-ink underline underline-offset-4"
                  href={
                    resolveSafeHref(
                      appBasePath,
                      `/observability/trace/${encodeURIComponent(traceId)}`
                    ) ?? "#"
                  }
                >
                  {t("observability.workflowRun.viewTrace")}
                </a>
              ) : (
                <span className="text-sm text-ui-muted">
                  {t("observability.workflowRun.viewTrace")}
                </span>
              )
            ) : !traceId ? (
              <p className="text-xs text-ui-muted">
                {t("observability.workflowRun.noCorrelation")}
              </p>
            ) : null}
          </div>
        )}
      </Section>
      <div id="outputs">
        <Section
          title={t("observability.workflowRun.outputs.title")}
          collapsible
          collapseKey="observability.workflowRun.outputs"
        >
          {detailError ? (
            <div className="space-y-2 text-sm text-ui-muted">
              <p>{t("observability.workflowRun.outputs.unavailable")}</p>
            </div>
          ) : outputs.length === 0 ? (
            <p className="text-sm text-ui-muted">
              {t("observability.workflowRun.outputs.empty")}
            </p>
          ) : (
            <div className="space-y-2">
              {outputs.map((entry) => (
                <div
                  key={entry.url}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ui-border bg-ui-paper/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-ui-muted" title={entry.fullLabel}>
                      {entry.label}
                    </div>
                    <div className="truncate text-sm text-ui-ink">{entry.url}</div>
                  </div>
                  {entry.trustedUrl ? (
                    <Button asChild size="sm" variant="ghost">
                      <a
                        href={entry.trustedUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("observability.workflowRun.outputs.open")}
                      </a>
                    </Button>
                  ) : (
                    <CopyFieldButton
                      value={entry.url}
                      label={entry.fullLabel}
                      className="!opacity-100"
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
      <Section
        title={t("observability.workflowRun.logs.title")}
        description={t("observability.workflowRun.logs.description")}
        collapsible
        collapseKey="observability.workflowRun.logs"
      >
        {stepsError ? (
          <div
            data-testid={
              resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-logs-error` : undefined
            }
            className="space-y-2 text-sm text-ui-muted"
          >
            <p>{t("observability.workflowRun.logs.unavailable")}</p>
            <p className="text-xs text-ui-muted/70">{stepsError}</p>
          </div>
        ) : (
          <WorkflowRunLogsPanel
            steps={steps}
            appBasePath={appBasePath}
            labels={logLabels}
            stepReplay={
              workflowTemplateId
                ? {
                    workflowTemplateId,
                    workflowRunId: runId,
                    payload: replayPayload,
                    capabilities: userCapabilities,
                  }
                : null
            }
            testIdPrefix={resolvedTestIdPrefix || undefined}
          />
        )}
      </Section>
      <Section
        title={t("observability.workflowRun.steps.title")}
        collapsible
        collapseKey="observability.workflowRun.steps"
      >
        <div className="space-y-3">
          {stepsError ? (
            <div
              data-testid={
                resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-steps-error` : undefined
              }
              className="space-y-2 text-sm text-ui-muted"
            >
              <p>{t("observability.workflowRun.steps.unavailable")}</p>
              <p className="text-xs text-ui-muted/70">{stepsError}</p>
            </div>
          ) : (
            <div
              data-testid={
                resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-steps-ready` : undefined
              }
              className="space-y-3"
            >
              {replayAudit ? (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ui-border bg-ui-paper/60 p-3"
                  data-testid={
                    resolvedTestIdPrefix
                      ? `${resolvedTestIdPrefix}-steps-replay-audit`
                      : undefined
                  }
                >
                  <div className="text-xs text-ui-muted">
                    {t("observability.workflowRun.logs.controls.replayLabel")}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
                    <Badge tone="neutral">
                      {replayModeLabel ?? replayAudit.mode}
                    </Badge>
                    {replaySourceLabel ? (
                      <Badge tone="neutral">{replaySourceLabel}</Badge>
                    ) : null}
                    <Badge tone={replayIssueSteps.length > 0 ? "warning" : "neutral"}>
                      {t("observability.workflowRun.summary.issues")}:{" "}
                      {replayIssueSteps.length}
                    </Badge>
                  </div>
                </div>
              ) : null}
              {workflowTemplateId && latestReplayPayload ? (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ui-border bg-ui-surface/70 p-3"
                  data-testid={
                    resolvedTestIdPrefix
                      ? `${resolvedTestIdPrefix}-steps-replay-presets`
                      : undefined
                  }
                >
                  <div className="text-xs text-ui-muted">
                    {t("observability.workflowRun.logs.controls.replayLabel")} (
                    {replayIssueSteps.length})
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {showFirstReplayIssue && firstReplayPayload ? (
                      <WorkflowTemplateStudioActions
                        templateId={workflowTemplateId}
                        capabilities={userCapabilities}
                        appBasePath={appBasePath}
                        defaultPayload={firstReplayPayload}
                        triggerLabel={t(
                          "observability.workflowRun.logs.controls.replayFirstIssue"
                        )}
                        modalTitle={t(
                          "observability.workflowRun.logs.controls.replayModalTitle"
                        )}
                        modalDescription={t(
                          "observability.workflowRun.logs.controls.replayModalDescription"
                        )}
                        testIdPrefix={
                          resolvedTestIdPrefix
                            ? `${resolvedTestIdPrefix}-steps-replay-first`
                            : null
                        }
                      />
                    ) : null}
                    <WorkflowTemplateStudioActions
                      templateId={workflowTemplateId}
                      capabilities={userCapabilities}
                      appBasePath={appBasePath}
                      defaultPayload={latestReplayPayload}
                      triggerLabel={t(
                        "observability.workflowRun.logs.controls.replayLatestIssue"
                      )}
                      modalTitle={t(
                        "observability.workflowRun.logs.controls.replayModalTitle"
                      )}
                      modalDescription={t(
                        "observability.workflowRun.logs.controls.replayModalDescription"
                      )}
                      testIdPrefix={
                        resolvedTestIdPrefix
                          ? `${resolvedTestIdPrefix}-steps-replay-latest`
                          : null
                      }
                    />
                    {showBatchReplay && batchReplayPayload ? (
                      <WorkflowTemplateStudioActions
                        templateId={workflowTemplateId}
                        capabilities={userCapabilities}
                        appBasePath={appBasePath}
                        defaultPayload={batchReplayPayload}
                        triggerLabel={t(
                          "observability.workflowRun.logs.controls.replayAllIssues"
                        )}
                        modalTitle={t(
                          "observability.workflowRun.logs.controls.replayModalTitle"
                        )}
                        modalDescription={t(
                          "observability.workflowRun.logs.controls.replayModalDescription"
                        )}
                        testIdPrefix={
                          resolvedTestIdPrefix
                            ? `${resolvedTestIdPrefix}-steps-replay-all`
                            : null
                        }
                      />
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="text-xs text-ui-muted">{stepsCountLabel}</div>
                  <ResourceTable
                    columns={stepColumns}
                    items={steps}
                    idKey="id"
                    clientPagination={clientPagination}
                    baseHref={resolveSafeHref(
                      appBasePath,
                      `/resources/workflow_run_steps?workflow_run_id=${encodeURIComponent(runId)}`
                    )}
                    appBasePath={appBasePath}
                    emptyMessage={t("observability.workflowRun.steps.empty")}
                  />
                  {resolveSafeHref(
                    appBasePath,
                    `/resources/workflow_run_steps?workflow_run_id=${encodeURIComponent(runId)}`
                  ) ? (
                    <a
                      className="text-sm text-ui-ink underline underline-offset-4"
                      href={
                        resolveSafeHref(
                          appBasePath,
                          `/resources/workflow_run_steps?workflow_run_id=${encodeURIComponent(runId)}`
                        ) ?? "#"
                      }
                    >
                      {t("observability.workflowRun.steps.openFullView")}
                    </a>
                  ) : null}
                </div>
              )}
            </div>
      </Section>
    </div>
  );
}
