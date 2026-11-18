"use client";

import * as React from "react";
import { Badge } from "./badge";
import { Button } from "./button";
import { createUiTranslator } from "./i18n";
import { ExternalLinkIcon } from "./icons";
import { cn } from "./utils";

export type PrintProgressVisualStatus =
  | "queued"
  | "checking"
  | "generating"
  | "bundling"
  | "downloading"
  | "completed"
  | "failed";

export type PrintProgressWidgetStatusSnapshot = {
  failureReason?: string | null;
  freshExpectedCount?: number | null;
  freshReadyCount?: number | null;
  outputSource?: string | null;
  timingSource?: string | null;
  artifactPersisted?: boolean | null;
  jobCompletionPending?: boolean | null;
  printAsyncRequestId?: string | number | null;
  printAsyncCompleted?: boolean | null;
  bundleAsyncRequestId?: string | number | null;
  bundleAsyncCompleted?: boolean | null;
  labelJobId?: string | number | null;
  labelId?: string | number | null;
  labelVersionId?: string | number | null;
  activeVersionId?: string | number | null;
  printMode?: string | null;
  artifactKind?: string | null;
};

export type PrintProgressWidgetProps = {
  testId?: string;
  status: PrintProgressVisualStatus;
  workflowRunId: string;
  selectionCount: number;
  elapsedMs: number;
  targetDownloadMs: number;
  targetMiss: boolean;
  minimized?: boolean;
  technicalDetailsOpen?: boolean;
  runOutputsHref?: string | null;
  statusSnapshot?: PrintProgressWidgetStatusSnapshot | null;
  readbackStopped?: boolean;
  onExpand: () => void;
  onHide: () => void;
  onDismiss: () => void;
  onRetry?: (() => void) | null;
  onToggleTechnicalDetails: () => void;
  onOpenRun?: (() => void) | null;
};

type Tone = "info" | "success" | "danger";

const printSourceLabels: Record<string, string> = {
  context: "workflowOutput",
  metadata: "workflowMetadata",
  execute_result: "executionResult",
  step_result: "stepResult",
  execute_async_response: "asyncResult",
  async_response: "asyncResult",
  file_path: "savedFile",
  fresh_ready_url: "freshDownload",
  fresh_ready_file: "freshFile",
  workflow_output_download: "workflowOutput",
  resource_detail: "resourceRecord",
  stage_execute_ms: "executionTiming",
  function_total_ms: "totalTiming",
  stage_render_ms: "renderTiming",
  stage_bundle_wait_ms: "bundleWaitTiming",
  stage_bundle_ms: "bundleTiming",
  missing: "notAvailable",
};

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent",
        className
      )}
    />
  );
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-5 w-5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="10" cy="10" r="7" />
      <path d="M6.8 10.3 9 12.5l4.5-4.8" />
    </svg>
  );
}

function AlertCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-5 w-5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.2v4.8" />
      <path d="M10 13.8h.01" />
    </svg>
  );
}

export function resolvePrintProgressWidgetTone(
  status: PrintProgressVisualStatus
): Tone {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "info";
}

export function resolvePrintProgressWidgetStateLabel(
  status: PrintProgressVisualStatus,
  selectionCount: number
) {
  const t = createUiTranslator("ui.resourceActions");
  if (status === "queued" || status === "checking") {
    return t("printProgress.states.preparing");
  }
  if (status === "generating") {
    return selectionCount === 1
      ? t("printProgress.states.generatingSingle")
      : t("printProgress.states.generatingMulti");
  }
  if (status === "bundling") {
    return t("printProgress.states.bundling");
  }
  if (status === "downloading") {
    return t("printProgress.states.downloading");
  }
  if (status === "completed") {
    return t("printProgress.states.completed");
  }
  return t("printProgress.states.failed");
}

export function resolvePrintProgressWidgetTitle(selectionCount: number) {
  const t = createUiTranslator("ui.resourceActions");
  if (selectionCount === 1) return t("printProgress.titleSingle");
  return t("printProgress.titleMulti", { count: selectionCount });
}

export function resolvePrintProgressWidgetHelperText(params: {
  status: PrintProgressVisualStatus;
  selectionCount: number;
  failureReason?: string | null;
  freshExpectedCount?: number | null;
  freshReadyCount?: number | null;
  artifactPersisted?: boolean | null;
  jobCompletionPending?: boolean | null;
}) {
  const t = createUiTranslator("ui.resourceActions");
  const {
    status,
    selectionCount,
    failureReason,
    freshExpectedCount,
    freshReadyCount,
    artifactPersisted,
    jobCompletionPending,
  } = params;
  if (status === "failed") {
    return failureReason?.trim() || t("printProgress.detail.failed");
  }
  if (status === "downloading" || status === "completed") {
    if (
      selectionCount > 1 &&
      typeof freshExpectedCount === "number" &&
      Number.isFinite(freshExpectedCount) &&
      freshExpectedCount > 0 &&
      typeof freshReadyCount === "number" &&
      Number.isFinite(freshReadyCount) &&
      freshReadyCount < freshExpectedCount
    ) {
      return t("printProgress.detail.readyProgress", {
        ready: Math.max(0, freshReadyCount),
        expected: Math.max(0, freshExpectedCount),
      });
    }
    if (jobCompletionPending === true) {
      return t("printProgress.detail.jobCompletionPending");
    }
    if (artifactPersisted === false) {
      return t("printProgress.detail.artifactPersistencePending");
    }
    return t("printProgress.detail.downloading");
  }
  if (
    selectionCount > 1 &&
    typeof freshExpectedCount === "number" &&
    Number.isFinite(freshExpectedCount) &&
    freshExpectedCount > 0 &&
    typeof freshReadyCount === "number" &&
    Number.isFinite(freshReadyCount)
  ) {
    return t("printProgress.detail.readyProgress", {
      ready: Math.max(0, freshReadyCount),
      expected: Math.max(0, freshExpectedCount),
    });
  }
  if (status === "bundling") {
    return t("printProgress.detail.bundling");
  }
  if (status === "generating") {
    return selectionCount === 1
      ? t("printProgress.detail.generatingSingle")
      : t("printProgress.detail.generatingMulti");
  }
  return t("printProgress.detail.preparing");
}

export function resolvePrintProgressWidgetProgress(params: {
  selectionCount: number;
  status: PrintProgressVisualStatus;
  freshExpectedCount?: number | null;
  freshReadyCount?: number | null;
}) {
  const { selectionCount, status, freshExpectedCount, freshReadyCount } = params;
  if (
    selectionCount > 1 &&
    typeof freshExpectedCount === "number" &&
    Number.isFinite(freshExpectedCount) &&
    freshExpectedCount > 0 &&
    typeof freshReadyCount === "number" &&
    Number.isFinite(freshReadyCount)
  ) {
    const ready = Math.max(0, Math.min(freshReadyCount, freshExpectedCount));
    return {
      determinate: true,
      percent: Math.max(0, Math.min(100, Math.round((ready / freshExpectedCount) * 100))),
    };
  }
  if (status === "completed") {
    return { determinate: true, percent: 100 };
  }
  return { determinate: false, percent: null };
}

function ProgressIcon({ status, stopped }: { status: PrintProgressVisualStatus; stopped?: boolean }) {
  if (stopped) return <AlertCircleIcon className="text-[rgb(var(--ui-info))]" />;
  if (status === "completed") {
    return <CheckCircleIcon className="text-[rgb(var(--ui-success))]" />;
  }
  if (status === "failed") {
    return <AlertCircleIcon className="text-[rgb(var(--ui-danger))]" />;
  }
  return <SpinnerIcon className="text-[rgb(var(--ui-info))]" />;
}

function formatBackendRequestState(
  requestId: string | number | null | undefined,
  completed: boolean | null | undefined
) {
  const t = createUiTranslator("ui.resourceActions");
  if (requestId === null || requestId === undefined || requestId === "") {
    return null;
  }
  if (typeof completed === "boolean") {
    return `${requestId} (${t("printProgress.diagnostics.requestCompleted", { value: t(completed ? "printProgress.diagnostics.yes" : "printProgress.diagnostics.no") })})`;
  }
  return String(requestId);
}

function ProgressBar({
  label,
  determinate,
  percent,
  tone,
}: {
  label: string;
  determinate: boolean;
  percent: number | null;
  tone: Tone;
}) {
  const fillClass =
    tone === "success"
      ? "bg-[rgb(var(--ui-success))]"
      : tone === "danger"
        ? "bg-[rgb(var(--ui-danger))]"
        : "bg-[rgb(var(--ui-info))]";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate && typeof percent === "number" ? percent : undefined}
      className="h-2 w-full overflow-hidden rounded-full bg-ui-border/70"
    >
      {determinate && typeof percent === "number" ? (
        <div
          className={cn("h-full rounded-full transition-[width] duration-300", fillClass)}
          style={{ width: `${percent}%` }}
        />
      ) : (
        <div className={cn("h-full w-2/5 animate-pulse rounded-full", fillClass)} />
      )}
    </div>
  );
}

export function PrintProgressWidget({
  testId,
  status,
  workflowRunId,
  selectionCount,
  elapsedMs,
  targetDownloadMs,
  targetMiss,
  minimized = false,
  technicalDetailsOpen = false,
  runOutputsHref,
  statusSnapshot,
  readbackStopped = false,
  onExpand,
  onHide,
  onDismiss,
  onRetry,
  onToggleTechnicalDetails,
  onOpenRun,
}: PrintProgressWidgetProps) {
  const t = createUiTranslator("ui.resourceActions");
  const sourceLabel = (value: string) => t(
    `printProgress.diagnostics.sources.${Object.hasOwn(printSourceLabels, value) ? printSourceLabels[value] : "unknown"}`
  );
  const title = resolvePrintProgressWidgetTitle(selectionCount);
  const observedHelperText = resolvePrintProgressWidgetHelperText({
    status,
    selectionCount,
    failureReason: statusSnapshot?.failureReason,
    freshExpectedCount: statusSnapshot?.freshExpectedCount,
    freshReadyCount: statusSnapshot?.freshReadyCount,
    artifactPersisted: statusSnapshot?.artifactPersisted,
    jobCompletionPending: statusSnapshot?.jobCompletionPending,
  });
  const backendReadbackPending =
    status !== "failed" &&
    (statusSnapshot?.jobCompletionPending === true ||
      statusSnapshot?.artifactPersisted === false ||
      (selectionCount > 1 &&
        typeof statusSnapshot?.freshExpectedCount === "number" &&
        Number.isFinite(statusSnapshot.freshExpectedCount) &&
        statusSnapshot.freshExpectedCount > 0 &&
        typeof statusSnapshot?.freshReadyCount === "number" &&
        Number.isFinite(statusSnapshot.freshReadyCount) &&
        statusSnapshot.freshReadyCount < statusSnapshot.freshExpectedCount));
  const readbackUnverified = readbackStopped && status === "completed" &&
    (backendReadbackPending || statusSnapshot?.artifactPersisted !== true);
  const visualStatus = readbackUnverified ? "checking" : status;
  const progress = resolvePrintProgressWidgetProgress({
    selectionCount,
    status: visualStatus,
    freshExpectedCount: statusSnapshot?.freshExpectedCount,
    freshReadyCount: statusSnapshot?.freshReadyCount,
  });
  const showProgress = !readbackUnverified || progress.determinate;
  const tone = resolvePrintProgressWidgetTone(visualStatus);
  const stateLabel = readbackUnverified
    ? t("printProgress.readbackUnverified")
    : resolvePrintProgressWidgetStateLabel(status, selectionCount);
  const helperText = readbackUnverified
    ? t("printProgress.readbackStopped", { detail: observedHelperText })
    : observedHelperText;
  const isTerminal =
    (status === "completed" || status === "failed") && (!backendReadbackPending || readbackStopped);
  const detailsAvailable = Boolean(
    workflowRunId ||
      runOutputsHref ||
      statusSnapshot?.timingSource ||
      statusSnapshot?.outputSource ||
      statusSnapshot?.printAsyncRequestId ||
      statusSnapshot?.bundleAsyncRequestId ||
      statusSnapshot?.labelJobId ||
      statusSnapshot?.labelId ||
      statusSnapshot?.labelVersionId ||
      statusSnapshot?.activeVersionId ||
      statusSnapshot?.printMode ||
      statusSnapshot?.artifactKind
  );
  const printAsyncState = formatBackendRequestState(
    statusSnapshot?.printAsyncRequestId,
    statusSnapshot?.printAsyncCompleted
  );
  const bundleAsyncState = formatBackendRequestState(
    statusSnapshot?.bundleAsyncRequestId,
    statusSnapshot?.bundleAsyncCompleted
  );
  const pillToneClass =
    tone === "success"
      ? "border-[rgb(var(--ui-success)/0.35)] bg-[rgb(var(--ui-success)/0.12)] text-[rgb(var(--ui-success))]"
      : tone === "danger"
        ? "border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.12)] text-[rgb(var(--ui-danger))]"
        : "border-[rgb(var(--ui-info)/0.35)] bg-[rgb(var(--ui-info)/0.12)] text-[rgb(var(--ui-info))]";

  if (minimized) {
    return (
      <button
        type="button"
        className="fixed inset-x-3 bottom-3 z-40 flex items-center justify-between rounded-full border border-ui-border bg-ui-paper/95 px-4 py-3 text-left shadow-xl backdrop-blur md:inset-x-auto md:right-4 md:bottom-4 md:min-w-[220px] md:max-w-[320px]"
        data-testid={testId ? `${testId}-minimized` : undefined}
        onClick={onExpand}
      >
        <span className="flex items-center gap-2">
          <ProgressIcon status={visualStatus} stopped={readbackUnverified} />
          <span className="text-sm font-medium text-ui-ink">
            {status === "completed" && !readbackUnverified
              ? t("printProgress.minimized.completed")
              : stateLabel}
          </span>
        </span>
        <span className="text-xs text-ui-muted">{t("printProgress.actions.show")}</span>
      </button>
    );
  }

  return (
    <section
      className="fixed inset-x-3 bottom-3 z-40 rounded-2xl border border-ui-border bg-ui-paper/95 p-4 shadow-2xl backdrop-blur md:inset-x-auto md:right-4 md:bottom-4 md:w-[360px]"
      role={status === "failed" ? "alert" : "status"}
      aria-live={status === "failed" ? "assertive" : "polite"}
      aria-atomic="true"
      aria-busy={isTerminal ? undefined : "true"}
      data-testid={testId}
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <ProgressIcon status={visualStatus} stopped={readbackUnverified} />
              <p className="text-sm font-semibold text-ui-ink">{title}</p>
            </div>
            <p className="text-sm text-ui-muted">{helperText}</p>
          </div>
          <Badge
            tone={tone}
            className={cn("shrink-0 px-2.5 py-1 text-[11px] font-semibold", pillToneClass)}
          >
            {stateLabel}
          </Badge>
        </div>

        {showProgress ? <div className="space-y-2">
          <ProgressBar
            label={stateLabel}
            determinate={progress.determinate}
            percent={progress.percent}
            tone={tone}
          />
          <div className="flex items-center justify-between text-[11px] text-ui-muted">
            <span>{t("printProgress.elapsed", { elapsed: elapsedMs })}</span>
            {progress.determinate && typeof progress.percent === "number" ? (
              <span>{t("printProgress.percent", { percent: progress.percent })}</span>
            ) : (
              <span>{t("printProgress.progressLive")}</span>
            )}
          </div>
        </div> : null}

        {technicalDetailsOpen && detailsAvailable ? (
          <div
            className="space-y-2 rounded-xl border border-ui-border bg-ui-surface/70 p-3 text-xs text-ui-muted"
            data-testid={testId ? `${testId}-details` : undefined}
          >
            <p className="font-medium text-ui-ink">
              {t("printProgress.diagnostics.title")}
            </p>
            <div className="grid gap-1.5">
              <div>
                {t("printProgress.diagnostics.runId", { workflowRunId })}
              </div>
              <div>
                {t("printProgress.diagnostics.target", {
                  target: targetDownloadMs,
                })}
              </div>
              <div>
                {t(
                  targetMiss
                    ? "printProgress.diagnostics.targetMiss"
                    : "printProgress.diagnostics.targetHit",
                  { elapsed: elapsedMs }
                )}
              </div>
              {statusSnapshot?.timingSource ? (
                <div>
                  {t("printProgress.diagnostics.timingSource", {
                    value: sourceLabel(statusSnapshot.timingSource),
                  })}
                </div>
              ) : null}
              {statusSnapshot?.outputSource ? (
                <div>
                  {t("printProgress.diagnostics.outputSource", {
                    value: sourceLabel(statusSnapshot.outputSource),
                  })}
                </div>
              ) : null}
              {typeof statusSnapshot?.artifactPersisted === "boolean" ? (
                <div>
                  {t("printProgress.diagnostics.artifactPersisted", {
                    value: statusSnapshot.artifactPersisted
                      ? t("printProgress.diagnostics.yes")
                      : t("printProgress.diagnostics.no"),
                  })}
                </div>
              ) : null}
              {typeof statusSnapshot?.jobCompletionPending === "boolean" ? (
                <div>
                  {t("printProgress.diagnostics.jobCompletionPending", {
                    value: statusSnapshot.jobCompletionPending
                      ? t("printProgress.diagnostics.yes")
                      : t("printProgress.diagnostics.no"),
                  })}
                </div>
              ) : null}
              {printAsyncState ? (
                <div>
                  {t("printProgress.diagnostics.printAsyncRequest", {
                    value: printAsyncState,
                  })}
                </div>
              ) : null}
              {bundleAsyncState ? (
                <div>
                  {t("printProgress.diagnostics.bundleAsyncRequest", {
                    value: bundleAsyncState,
                  })}
                </div>
              ) : null}
              {statusSnapshot?.labelJobId ? (
                <div>
                  {t("printProgress.diagnostics.labelJob", {
                    value: statusSnapshot.labelJobId,
                  })}
                </div>
              ) : null}
              {statusSnapshot?.labelId ? (
                <div>
                  {t("printProgress.diagnostics.label", {
                    value: statusSnapshot.labelId,
                  })}
                </div>
              ) : null}
              {statusSnapshot?.labelVersionId ? (
                <div>
                  {t("printProgress.diagnostics.labelVersion", {
                    value: statusSnapshot.labelVersionId,
                  })}
                </div>
              ) : null}
              {statusSnapshot?.activeVersionId ? (
                <div>
                  {t("printProgress.diagnostics.activeVersion", {
                    value: statusSnapshot.activeVersionId,
                  })}
                </div>
              ) : null}
              {statusSnapshot?.printMode ? (
                <div>
                  {t("printProgress.diagnostics.printMode", {
                    value: statusSnapshot.printMode,
                  })}
                </div>
              ) : null}
              {statusSnapshot?.artifactKind ? (
                <div>
                  {t("printProgress.diagnostics.artifactKind", {
                    value: statusSnapshot.artifactKind,
                  })}
                </div>
              ) : null}
            </div>
            {runOutputsHref && onOpenRun ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="justify-start px-0 text-xs"
                onClick={onOpenRun}
              >
                <ExternalLinkIcon className="h-3.5 w-3.5" />
                {t("printProgress.diagnostics.viewRun")}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {isTerminal ? (
            <>
              {status === "failed" && onRetry ? (
                <Button type="button" size="sm" variant="soft" onClick={onRetry}>
                  {t("printProgress.actions.retry")}
                </Button>
              ) : null}
              {detailsAvailable ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-expanded={technicalDetailsOpen}
                  onClick={onToggleTechnicalDetails}
                >
                  {t("printProgress.actions.technicalDetails")}
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
                {t("printProgress.dismiss")}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="ghost" onClick={onHide}>
                {t("printProgress.actions.hide")}
              </Button>
              {detailsAvailable ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-expanded={technicalDetailsOpen}
                  onClick={onToggleTechnicalDetails}
                >
                  {t("printProgress.actions.technicalDetails")}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
