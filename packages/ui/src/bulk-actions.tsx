"use client";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createBrowserClient } from "@masarx/auth/browser";
import type {
  UiCommandExecution,
  UiCommandInputField,
  UiCommandReadback,
  UiCommandReadbackParamSource,
  UiCommandSelection,
} from "@masarx/api";
import { getUiDefaults } from "@masarx/config";
import {
  createUiClient,
  requestUiWorkflowRunOutputDownload,
} from "@masarx/api";
import { Button } from "./button";
import {
  BulkActionResultReadback,
  parseBatchResultReadback,
  attachSelectionReadback,
  requiresBatchResultEvidence,
  type BatchResultReadback,
} from "./bulk-action-result-readback";
import { ConfirmDialog } from "./confirm-dialog";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "./dropdown";
import { createUiTranslator } from "./i18n";
import {
  buildScopeMeta,
  reportUiEvent,
  resolveScopeDigest,
  type UiScopeMetaInput,
} from "./reporting";
import { ResourceDownloadAction } from "./resource-download-action";
import { navigateTo } from "./navigate";
import { Input } from "./input";
import {
  PrintProgressWidget,
  type PrintProgressVisualStatus,
} from "./print-progress-widget";
import { resolveWorkflowRunDestination } from "./workflow-run-navigation";
import {
  extractWorkflowRunOutputUrlsByPaths,
  extractWorkflowRunOutputs,
} from "./workflow-run-outputs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";
import { Select } from "./select";
import { Textarea } from "./textarea";
import { useToast } from "./use-toast";
import { buildHref } from "./url";
import { downloadTrustedFile } from "./file-download";
import {
  isTrustedDownloadUrl,
  isTrustedUrl,
  openTrustedInNewTab,
  resolveSafeAppBasePath,
  resolveSafeHref,
} from "./url-guard";
import { formatUiError, getUiErrorMessage, sanitizeUiError } from "./utils";
import { isUuidValue } from "./resource-utils";

const DEFAULT_ID_PARAM = "id";
const DEFAULT_IDS_PARAM = "ids";
const uiDefaults = getUiDefaults();

type DownloadActionMeta = {
  resourceKey: string;
  downloadBasePath: string;
  maxBatch?: number;
};

export type BulkActionDefinition = {
  key: string;
  label: string;
  description?: string | null;
  capability?: string | null;
  resourceKey?: string | null;
  workflowKey?: string | null;
  href?: string | null;
  selection?: UiCommandSelection | null;
  execution?: UiCommandExecution | null;
  disabledReason?: string | null;
  download?: DownloadActionMeta | null;
};

type BulkActionsProps = {
  actions: BulkActionDefinition[];
  selectedIds: string[];
  appBasePath?: string | null;
  telemetry?: UiScopeMetaInput | null;
  testIdPrefix?: string | null;
  onBatchResultReadbackChange?: (result: BatchResultReadback | null) => void;
  renderBatchResultReadback?: boolean;
  onSuccess?: (input: {
    action: BulkActionDefinition;
    result: Record<string, unknown>;
    selectedIds: string[];
  }) => void | Promise<void>;
};

type ActionFeedback = {
  actionKey: string;
  actionLabel: string;
  selectedIds: string[];
  phase: "pending" | "submitted" | "warning" | "error";
  detail: string;
  resultStatus?: string;
  workflowRunId?: string;
  correlationId?: string;
};

type UndoState = {
  action: BulkActionDefinition;
  label: string;
  selectionSignature: string;
  timeoutMs?: number | null;
};

type SelectionConstraints = {
  min: number;
  max?: number;
  idParam: string;
  idsParam: string;
};

type PrintExecutionOptions = {
  autoDownload: boolean;
  outputUrlPaths: string[];
  pollIntervalMs: number;
  pollTimeoutMs: number;
  pollScheduleMs: number[];
  pollProgressEnabled: boolean;
  pollProgressBudgetMs: number;
  pollProgressMaxSteps: number;
  targetDownloadMs: number;
  fallbackMode: "open_run_outputs" | "none";
  contractErrors: string[];
};

type PrintRunOutputStatus = {
  workflowStatus: string | null;
  currentOperation: string | null;
  phase: string | null;
  outputUrl: string | null;
  outputFilePath: string | null;
  outputBucket: string | null;
  outputNeedsSigning: boolean;
  outputSource: string | null;
  artifactPersisted: boolean | null;
  jobCompletionPending: boolean;
  timingSource: string | null;
  outputReady: boolean;
  terminal: boolean;
  failureReason: string | null;
  pendingCount: number | null;
  readyCount: number | null;
  freshExpectedCount: number | null;
  freshReadyCount: number | null;
  freshFailedCount: number | null;
  freshOnlyResolved: boolean;
  printAsyncRequestId: string | number | null;
  printAsyncCompleted: boolean;
  bundleAsyncRequestId: string | number | null;
  labelJobId: string | number | null;
  labelId: string | number | null;
  labelVersionId: string | number | null;
  activeVersionId: string | number | null;
  bundleAsyncCompleted: boolean | null;
  printMode: string | null;
  artifactKind: string | null;
  functionTotalMs: number | null;
  stagePrepareMs: number | null;
  stageExecuteMs: number | null;
  stageEnqueueMs: number | null;
  stageRenderMs: number | null;
  stageBundleMs: number | null;
  stageCompleteMs: number | null;
  stageRenderWaitMs: number | null;
  stageBundleWaitMs: number | null;
  stageFinalizeMs: number | null;
  statusCheckedAt: string | null;
  pollProgressManaged: boolean;
  pollProgressAttempted: boolean;
  pollProgressStatus: string | null;
  pollProgressError: string | null;
  printAsyncProgressAttempted: boolean;
  printAsyncProgressStatus: string | null;
  printAsyncProgressError: string | null;
};

const createDefaultPrintRunOutputStatus = (
  overrides: Partial<PrintRunOutputStatus> = {}
): PrintRunOutputStatus => ({
  workflowStatus: null,
  currentOperation: null,
  phase: null,
  outputUrl: null,
  outputFilePath: null,
  outputBucket: null,
  outputNeedsSigning: false,
  outputSource: null,
  artifactPersisted: null,
  jobCompletionPending: false,
  timingSource: null,
  outputReady: false,
  terminal: false,
  failureReason: null,
  pendingCount: null,
  readyCount: null,
  freshExpectedCount: null,
  freshReadyCount: null,
  freshFailedCount: null,
  freshOnlyResolved: false,
  printAsyncRequestId: null,
  printAsyncCompleted: false,
  bundleAsyncRequestId: null,
  labelJobId: null,
  labelId: null,
  labelVersionId: null,
  activeVersionId: null,
  bundleAsyncCompleted: null,
  printMode: null,
  artifactKind: null,
  functionTotalMs: null,
  stagePrepareMs: null,
  stageExecuteMs: null,
  stageEnqueueMs: null,
  stageRenderMs: null,
  stageBundleMs: null,
  stageCompleteMs: null,
  stageRenderWaitMs: null,
  stageBundleWaitMs: null,
  stageFinalizeMs: null,
  statusCheckedAt: null,
  pollProgressManaged: false,
  pollProgressAttempted: false,
  pollProgressStatus: null,
  pollProgressError: null,
  printAsyncProgressAttempted: false,
  printAsyncProgressStatus: null,
  printAsyncProgressError: null,
  ...overrides,
});

type PrintPollResult = {
  outputUrl: string | null;
  status?: PrintRunOutputStatus | null;
  error?: Error;
};

type PrintProgressStatus = PrintProgressVisualStatus;

type PrintProgressState = {
  actionKey: string;
  actionLabel: string;
  selectionCount: number;
  workflowRunId: string;
  status: PrintProgressStatus;
  detail?: string | null;
  runOutputsHref?: string | null;
  startedAtMs: number;
  elapsedMs?: number | null;
  targetDownloadMs: number;
  targetMiss: boolean;
  minimized: boolean;
  technicalDetailsOpen: boolean;
  statusSnapshot: PrintRunOutputStatus | null;
};

type BulkEventMeta = Record<string, string | number | boolean | null | undefined>;

type LookupOption = {
  value: string;
  label: string;
  description?: string | null;
};

type ConfirmLookupState = {
  loading: boolean;
  error: string | null;
  optionsByCategory: Record<string, LookupOption[]>;
};

function normalizeLookupOptions(value: unknown): LookupOption[] {
  if (!Array.isArray(value)) return [];
  const normalized: LookupOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const rawValue = typeof record.value === "string" ? record.value.trim() : "";
    if (!rawValue) continue;
    const rawLabel = typeof record.label === "string" ? record.label.trim() : "";
    const rawDescription =
      typeof record.description === "string" ? record.description.trim() : "";
    normalized.push({
      value: rawValue,
      label: rawLabel || rawValue,
      description: rawDescription || null,
    });
  }
  return normalized;
}

function resolveLookupOptionsForValue(
  options: LookupOption[],
  currentValue: string
) {
  const normalizedValue = currentValue.trim();
  if (!normalizedValue) return options;
  if (options.some((option) => option.value === normalizedValue)) return options;
  return [
    {
      value: normalizedValue,
      label: normalizedValue,
      description: null,
    },
    ...options,
  ];
}

let printDownloadAuthClient: ReturnType<typeof createBrowserClient> | null =
  null;

async function requestWorkflowRunOutputSignedUrl(params: {
  workflowRunId: string;
  outputUrlPaths: string[];
}) {
  printDownloadAuthClient ??= createBrowserClient();
  const { data, error } = await printDownloadAuthClient.auth.getSession();
  const accessToken = data.session?.access_token ?? "";
  if (error || !accessToken) {
    return {
      ok: false as const,
      status: 401,
      error:
        error?.message ?? "Authentication required for workflow output download.",
    };
  }
  return requestUiWorkflowRunOutputDownload({
    accessToken,
    workflowRunId: params.workflowRunId,
    outputUrlPaths: params.outputUrlPaths,
  });
}

function normalizePrintPhaseToken(value: string | null | undefined) {
  if (!value) return "";
  return value.trim().toLowerCase();
}

function failedPrintOutput(status: PrintRunOutputStatus): PrintRunOutputStatus | null {
  const workflow = normalizePrintPhaseToken(status.workflowStatus);
  const phase = normalizePrintPhaseToken(status.phase);
  if (!['failed', 'cancelled'].includes(workflow) && phase !== 'failed') return null;
  return {
    ...status,
    phase: 'failed',
    terminal: true,
    outputReady: false,
    outputUrl: null,
    outputFilePath: null,
    outputNeedsSigning: false,
  };
}

function resolvePrintProgressStatus(status: PrintRunOutputStatus): PrintProgressStatus {
  if (status.outputReady || status.outputUrl) return "downloading";
  if (status.terminal) {
    return status.workflowStatus === "completed" ? "completed" : "failed";
  }
  const phase = normalizePrintPhaseToken(status.phase);
  if (phase === "queued") return "queued";
  if (phase === "checking") return "checking";
  if (phase === "generating") return "generating";
  if (phase === "bundling") return "bundling";
  if (phase === "downloading") return "downloading";
  if (phase === "completed") return "completed";
  if (phase === "failed") return "failed";
  if (phase.includes("queue")) return "queued";
  if (phase.includes("check")) return "checking";
  if (phase.includes("generate")) return "generating";
  if (phase.includes("bundle")) return "bundling";
  if (phase.includes("download")) return "downloading";
  if (phase.includes("complete")) return "completed";
  if (phase.includes("fail") || phase.includes("cancel")) return "failed";
  const operation = normalizePrintPhaseToken(status.currentOperation);
  if (operation.includes("prepare") || operation.includes("generate")) return "generating";
  if (operation.includes("bundle") || operation.includes("zip")) return "bundling";
  if ((status.pendingCount ?? 0) > 0) return "generating";
  if ((status.readyCount ?? 0) > 0) return "bundling";
  return "checking";
}

function readRequiredNumberParam(value: unknown, minimum: number = 1) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(minimum, Math.floor(parsed));
}

function readBooleanParam(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function readRequiredBooleanParam(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return null;
}

function readRequiredStringArrayParam(value: unknown) {
  if (!Array.isArray(value)) return null;
  const values = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return values.length > 0 ? values : null;
}

function readRequiredNumberArrayParam(
  value: unknown,
  minimum: number = 25
) {
  if (!Array.isArray(value)) return null;
  const values = value
    .map((entry) =>
      typeof entry === "number"
        ? entry
        : typeof entry === "string"
          ? Number.parseInt(entry, 10)
          : Number.NaN
    )
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .map((entry) => Math.max(minimum, Math.floor(entry as number)));
  return values.length > 0 ? values : null;
}

function resolvePrintExecutionOptions(action: BulkActionDefinition): PrintExecutionOptions {
  const params = action.execution?.params;
  const record =
    params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const fallbackMode =
    record.fallback_mode === "open_run_outputs" ? "open_run_outputs" : "none";
  const autoDownload = readBooleanParam(record.auto_download, false);
  const contractErrors: string[] = [];
  const strictOutputUrlPaths = readRequiredStringArrayParam(record.output_url_paths);
  const strictPollScheduleMs = readRequiredNumberArrayParam(record.poll_schedule_ms, 25);
  const strictPollTimeoutMs = readRequiredNumberParam(record.poll_timeout_ms, 250);
  const strictTargetDownloadMs = readRequiredNumberParam(record.target_download_ms, 1);
  const strictPollIntervalMs = readRequiredNumberParam(record.poll_interval_ms, 25);
  const strictPollProgressEnabled = readRequiredBooleanParam(
    record.poll_progress_enabled
  );
  const strictPollProgressBudgetMs = readRequiredNumberParam(
    record.poll_progress_budget_ms,
    25
  );
  const strictPollProgressMaxSteps = readRequiredNumberParam(
    record.poll_progress_max_steps,
    1
  );
  if (!autoDownload) {
    contractErrors.push("auto_download must be true");
  }
  if (!strictOutputUrlPaths) {
    contractErrors.push("output_url_paths must be a non-empty string array");
  }
  if (!strictPollScheduleMs) {
    contractErrors.push("poll_schedule_ms must be a non-empty positive integer array");
  }
  if (strictPollTimeoutMs === null) {
    contractErrors.push("poll_timeout_ms must be a positive integer");
  }
  if (strictTargetDownloadMs === null) {
    contractErrors.push("target_download_ms must be a positive integer");
  }
  if (strictPollIntervalMs === null) {
    contractErrors.push("poll_interval_ms must be a positive integer");
  }
  if (strictPollProgressEnabled === null) {
    contractErrors.push("poll_progress_enabled must be a boolean");
  }
  if (strictPollProgressBudgetMs === null) {
    contractErrors.push("poll_progress_budget_ms must be a positive integer");
  }
  if (strictPollProgressMaxSteps === null) {
    contractErrors.push("poll_progress_max_steps must be a positive integer");
  }
  if (fallbackMode !== "none") {
    contractErrors.push("fallback_mode must be none");
  }
  const outputUrlPaths = strictOutputUrlPaths ?? [];
  const pollScheduleMs = strictPollScheduleMs ?? [];
  const pollIntervalMs =
    strictPollIntervalMs ?? (pollScheduleMs[pollScheduleMs.length - 1] ?? Number.NaN);
  return {
    autoDownload,
    outputUrlPaths,
    pollIntervalMs,
    pollTimeoutMs: strictPollTimeoutMs ?? Number.NaN,
    pollScheduleMs,
    pollProgressEnabled: strictPollProgressEnabled ?? false,
    pollProgressBudgetMs: strictPollProgressBudgetMs ?? Number.NaN,
    pollProgressMaxSteps: strictPollProgressMaxSteps ?? Number.NaN,
    targetDownloadMs: strictTargetDownloadMs ?? Number.NaN,
    fallbackMode,
    contractErrors,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      setTimeout(resolve, ms);
      return;
    }
    window.setTimeout(resolve, ms);
  });
}

function resolveFirstTrustedWorkflowOutputUrl(
  detail: Record<string, unknown> | null,
  outputUrlPaths: string[]
) {
  if (!detail) return null;
  const fromConfiguredPaths = extractWorkflowRunOutputUrlsByPaths(
    detail,
    outputUrlPaths
  );
  for (const candidate of fromConfiguredPaths) {
    if (isTrustedDownloadUrl(candidate)) return candidate;
  }
  const fallbackLinks = extractWorkflowRunOutputs(detail);
  for (const candidate of fallbackLinks) {
    if (isTrustedDownloadUrl(candidate.url)) return candidate.url;
  }
  return null;
}

function resolveCorrelationId(result: Record<string, unknown> | null) {
  if (!result) return null;
  const direct =
    typeof result.correlation_id === "string"
      ? result.correlation_id.trim()
      : "";
  if (direct) return direct;
  const trace =
    typeof result.trace_id === "string" ? result.trace_id.trim() : "";
  return trace || null;
}

function resolveDiagnosticSuffix(correlationId: string | null) {
  return correlationId ? ` [correlationId=${correlationId}]` : "";
}

async function pollWorkflowRunForOutputUrl(params: {
  ui: ReturnType<typeof createUiClient>;
  workflowRunId: string;
  outputUrlPaths: string[];
  pollScheduleMs: number[];
  pollIntervalMs: number;
  pollTimeoutMs: number;
  pollProgressEnabled: boolean;
  pollProgressBudgetMs: number;
  pollProgressMaxSteps: number;
  onProgress?: (status: PrintRunOutputStatus) => void;
  onSoftTimeout?: () => void;
}) {
  const {
    ui,
    workflowRunId,
    outputUrlPaths,
    pollScheduleMs,
    pollIntervalMs,
    pollTimeoutMs,
    pollProgressEnabled,
    pollProgressBudgetMs,
    pollProgressMaxSteps,
    onProgress,
    onSoftTimeout,
  } = params;
  const getWorkflowRunOutputStatus = (
    ui as Record<string, unknown>
  ).getWorkflowRunOutputStatus;
  const progressWorkflowRunUntilWait = (
    ui as Record<string, unknown>
  ).progressWorkflowRunUntilWait;
  const getResource = (ui as Record<string, unknown>).getResource;
  if (
    typeof getWorkflowRunOutputStatus !== "function" &&
    typeof getResource !== "function"
  ) {
    return {
      outputUrl: null,
      error: new Error(
        "ui.getWorkflowRunOutputStatus/ui.getResource unavailable"
      ),
    } as PrintPollResult;
  }

  const startedAt = Date.now();
  const parseFiniteNumber = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };
  let softTimeoutEmitted = false;
  let attempt = 0;
  while (true) {
    if (
      !softTimeoutEmitted &&
      pollTimeoutMs > 0 &&
      Date.now() - startedAt >= pollTimeoutMs
    ) {
      softTimeoutEmitted = true;
      onSoftTimeout?.();
    }
    try {
      if (typeof getWorkflowRunOutputStatus === "function") {
        const statusRaw = await (getWorkflowRunOutputStatus as (
          workflowRunId: string,
          outputUrlPaths?: string[] | null
        ) => Promise<unknown>)(workflowRunId, outputUrlPaths);
        const statusRecord =
          statusRaw && typeof statusRaw === "object" && !Array.isArray(statusRaw)
            ? (statusRaw as Record<string, unknown>)
            : {};
        const status = createDefaultPrintRunOutputStatus({
          workflowStatus:
            typeof statusRecord.workflow_status === "string"
              ? statusRecord.workflow_status
              : null,
          currentOperation:
            typeof statusRecord.current_operation === "string"
              ? statusRecord.current_operation
              : null,
          phase:
            typeof statusRecord.phase === "string"
              ? statusRecord.phase
              : null,
          outputUrl:
            typeof statusRecord.output_url === "string"
              ? statusRecord.output_url.trim()
              : null,
          outputFilePath:
            typeof statusRecord.output_file_path === "string"
              ? statusRecord.output_file_path.trim()
              : null,
          outputBucket:
            typeof statusRecord.output_bucket === "string"
              ? statusRecord.output_bucket.trim()
              : null,
          outputNeedsSigning: Boolean(statusRecord.output_needs_signing),
          outputSource:
            typeof statusRecord.output_source === "string"
              ? statusRecord.output_source
              : null,
          artifactPersisted: typeof statusRecord.artifact_persisted === "boolean" ? statusRecord.artifact_persisted : null,
          jobCompletionPending: Boolean(statusRecord.job_completion_pending),
          timingSource:
            typeof statusRecord.timing_source === "string"
              ? statusRecord.timing_source
              : null,
          outputReady: Boolean(statusRecord.output_ready),
          terminal: Boolean(statusRecord.terminal),
          failureReason:
            typeof statusRecord.failure_reason === "string"
              ? statusRecord.failure_reason
              : null,
          pendingCount:
            typeof statusRecord.pending_count === "number"
              ? statusRecord.pending_count
              : null,
          readyCount:
            typeof statusRecord.ready_count === "number"
              ? statusRecord.ready_count
              : null,
          freshExpectedCount:
            typeof statusRecord.fresh_expected_count === "number"
              ? statusRecord.fresh_expected_count
              : null,
          freshReadyCount:
            typeof statusRecord.fresh_ready_count === "number"
              ? statusRecord.fresh_ready_count
              : null,
          freshFailedCount:
            typeof statusRecord.fresh_failed_count === "number"
              ? statusRecord.fresh_failed_count
              : null,
          freshOnlyResolved: Boolean(statusRecord.fresh_only_resolved),
          printAsyncRequestId:
            typeof statusRecord.print_async_request_id === "string" ||
            typeof statusRecord.print_async_request_id === "number"
              ? statusRecord.print_async_request_id
              : null,
          printAsyncCompleted: Boolean(statusRecord.print_async_completed),
          bundleAsyncRequestId:
            typeof statusRecord.bundle_async_request_id === "string" || typeof statusRecord.bundle_async_request_id === "number"
              ? statusRecord.bundle_async_request_id : null,
          labelJobId:
            typeof statusRecord.label_job_id === "string" || typeof statusRecord.label_job_id === "number"
              ? statusRecord.label_job_id : null,
          labelId:
            typeof statusRecord.label_id === "string" || typeof statusRecord.label_id === "number"
              ? statusRecord.label_id : null,
          labelVersionId:
            typeof statusRecord.label_version_id === "string" || typeof statusRecord.label_version_id === "number"
              ? statusRecord.label_version_id : null,
          activeVersionId:
            typeof statusRecord.active_version_id === "string" || typeof statusRecord.active_version_id === "number"
              ? statusRecord.active_version_id : null,
          bundleAsyncCompleted: typeof statusRecord.bundle_async_completed === "boolean" ? statusRecord.bundle_async_completed : null,
          printMode:
            typeof statusRecord.print_mode === "string"
              ? statusRecord.print_mode
              : null,
          artifactKind:
            typeof statusRecord.artifact_kind === "string"
              ? statusRecord.artifact_kind
              : null,
          functionTotalMs: parseFiniteNumber(statusRecord.function_total_ms),
          stagePrepareMs: parseFiniteNumber(statusRecord.stage_prepare_ms),
          stageExecuteMs: parseFiniteNumber(statusRecord.stage_execute_ms),
          stageEnqueueMs: parseFiniteNumber(statusRecord.stage_enqueue_ms),
          stageRenderMs: parseFiniteNumber(statusRecord.stage_render_ms),
          stageBundleMs: parseFiniteNumber(statusRecord.stage_bundle_ms),
          stageCompleteMs: parseFiniteNumber(statusRecord.stage_complete_ms),
          stageRenderWaitMs: parseFiniteNumber(statusRecord.stage_render_wait_ms),
          stageBundleWaitMs: parseFiniteNumber(statusRecord.stage_bundle_wait_ms),
          stageFinalizeMs: parseFiniteNumber(statusRecord.stage_finalize_ms),
          statusCheckedAt:
            typeof statusRecord.status_checked_at === "string"
              ? statusRecord.status_checked_at
              : null,
          pollProgressManaged: Boolean(statusRecord.poll_progress_managed),
          pollProgressAttempted: Boolean(statusRecord.poll_progress_attempted),
          pollProgressStatus:
            typeof statusRecord.poll_progress_status === "string"
              ? statusRecord.poll_progress_status
              : null,
          pollProgressError:
            typeof statusRecord.poll_progress_error === "string"
              ? statusRecord.poll_progress_error
              : null,
          printAsyncProgressAttempted: Boolean(
            statusRecord.print_async_progress_attempted
          ),
          printAsyncProgressStatus:
            typeof statusRecord.print_async_progress_status === "string"
              ? statusRecord.print_async_progress_status
              : null,
          printAsyncProgressError:
            typeof statusRecord.print_async_progress_error === "string"
              ? statusRecord.print_async_progress_error
              : null,
        });
        const failed = failedPrintOutput(status);
        if (failed) {
          onProgress?.(failed);
          return { outputUrl: null, status: failed };
        }
        onProgress?.(status);
        if (status.outputUrl && isTrustedDownloadUrl(status.outputUrl)) {
          return { outputUrl: status.outputUrl, status };
        }
        if (status.outputReady && status.outputFilePath) {
          const signedDownload = await requestWorkflowRunOutputSignedUrl({
            workflowRunId,
            outputUrlPaths,
          });
          if (signedDownload.ok && isTrustedDownloadUrl(signedDownload.url)) {
            return {
              outputUrl: signedDownload.url,
              status: {
                ...status,
                outputUrl: signedDownload.url,
                outputSource: status.outputSource ?? "workflow_output_download",
              },
            };
          }
        }
        if (status.terminal) {
          return { outputUrl: null, status };
        }
        if (
          pollProgressEnabled &&
          !status.pollProgressManaged &&
          typeof progressWorkflowRunUntilWait === "function"
        ) {
          await (progressWorkflowRunUntilWait as (
            workflowRunId: string,
            options?: {
              operationResult?: Record<string, unknown> | null;
              budgetMs?: number | null;
              maxSteps?: number | null;
            } | null
          ) => Promise<unknown>)(workflowRunId, {
            budgetMs: pollProgressBudgetMs,
            maxSteps: pollProgressMaxSteps,
          });
        }
      } else if (typeof getResource === "function") {
        const detailRaw = await (getResource as (
          resource: string,
          id: string
        ) => Promise<unknown>)("workflow_runs", workflowRunId);
        const detail =
          detailRaw && typeof detailRaw === "object" && !Array.isArray(detailRaw)
            ? (detailRaw as Record<string, unknown>)
            : null;
        const outputUrl = resolveFirstTrustedWorkflowOutputUrl(
          detail,
          outputUrlPaths
        );
        const workflowStatus =
          detail && typeof detail.workflow_status === "string"
            ? detail.workflow_status
            : null;
        const fallbackStatus = createDefaultPrintRunOutputStatus({
          workflowStatus,
          currentOperation: null,
          phase: outputUrl ? "downloading" : "checking",
          outputUrl,
          outputFilePath: null,
          outputBucket: null,
          outputNeedsSigning: false,
          outputSource: outputUrl ? "resource_detail" : null,
          outputReady: Boolean(outputUrl),
          terminal: ["completed", "failed", "cancelled"].includes(
            workflowStatus ?? ""
          ),
          failureReason:
            typeof detail?.failure_reason === "string"
              ? detail.failure_reason
              : null,
          pendingCount: null,
          readyCount: null,
          freshExpectedCount: null,
          freshReadyCount: null,
          freshFailedCount: null,
          freshOnlyResolved: false,
          functionTotalMs: null,
          stagePrepareMs: null,
          stageRenderWaitMs: null,
          stageBundleWaitMs: null,
          stageFinalizeMs: null,
          statusCheckedAt: null,
          pollProgressManaged: false,
          pollProgressAttempted: false,
          pollProgressStatus: null,
          pollProgressError: null,
        });
        const failed = failedPrintOutput(fallbackStatus);
        if (failed) {
          onProgress?.(failed);
          return { outputUrl: null, status: failed };
        }
        onProgress?.(fallbackStatus);
        if (outputUrl) return { outputUrl, status: fallbackStatus };
        if (fallbackStatus.terminal) {
          return { outputUrl: null, status: fallbackStatus };
        }
        if (
          pollProgressEnabled &&
          typeof progressWorkflowRunUntilWait === "function"
        ) {
          await (progressWorkflowRunUntilWait as (
            workflowRunId: string,
            options?: {
              operationResult?: Record<string, unknown> | null;
              budgetMs?: number | null;
              maxSteps?: number | null;
            } | null
          ) => Promise<unknown>)(workflowRunId, {
            budgetMs: pollProgressBudgetMs,
            maxSteps: pollProgressMaxSteps,
          });
        }
      }
    } catch (error) {
      const code =
        error && typeof error === "object"
          ? (error as { code?: unknown }).code
          : null;
      if (String(code ?? "").trim() === "42501") {
        throw error;
      }
    }
    const delayMs =
      pollScheduleMs[attempt] ??
      pollScheduleMs[pollScheduleMs.length - 1] ??
      pollIntervalMs;
    attempt += 1;
    await sleep(delayMs);
  }
}

const resolveSelectionConstraints = (
  selection?: UiCommandSelection | null
): SelectionConstraints => {
  const mode = selection?.mode ?? null;
  const min =
    selection?.min_count ??
    (mode === "none" || mode === "any" ? 0 : 1);
  const max =
    selection?.max_count ?? (mode === "single" ? 1 : undefined);
  const idParam =
    selection?.id_param?.trim() || DEFAULT_ID_PARAM;
  const idsParam =
    selection?.ids_param?.trim() || DEFAULT_IDS_PARAM;
  return { min, max, idParam, idsParam };
};

const buildSelectionParams = (
  selectedIds: string[],
  constraints: SelectionConstraints
) => {
  if (selectedIds.length === 0) return {};
  if (selectedIds.length === 1) {
    return { [constraints.idParam]: selectedIds[0] };
  }
  return { [constraints.idsParam]: selectedIds.join(",") };
};

const resolveSelectionDisabledReason = (
  t: ReturnType<typeof createUiTranslator>,
  selectedCount: number,
  constraints: SelectionConstraints
) => {
  if (selectedCount === 0 && constraints.min > 0) {
    return t("disabled.noSelection");
  }
  if (constraints.max === 1 && selectedCount > 1) {
    return t("disabled.requiresSingle");
  }
  if (constraints.min > 1 && selectedCount < constraints.min) {
    return t("disabled.minSelection", { min: constraints.min });
  }
  if (constraints.max !== undefined && selectedCount > constraints.max) {
    return t("disabled.maxSelection", { max: constraints.max });
  }
  return null;
};

const requiresExplicitConfirmation = (action: BulkActionDefinition) => {
  if (action.execution?.confirm) {
    return true;
  }
  const actionType = action.execution?.type ?? "navigate";
  return (
    actionType === "rpc" || actionType === "workflow" || actionType === "print"
  );
};

const resolveActionType = (action: BulkActionDefinition) =>
  action.execution?.type ?? "navigate";

const normalizeHrefParams = (
  params: Record<string, unknown> | null | undefined
): Record<string, string | number | boolean | null | undefined> => {
  if (!params || typeof params !== "object") return {};
  return Object.entries(params).reduce(
    (acc, [key, value]) => {
      if (value === null || value === undefined) {
        acc[key] = value;
        return acc;
      }
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, string | number | boolean | null | undefined>
  );
};

const resolveActionHref = (
  action: BulkActionDefinition,
  selectedIds: string[]
) => {
  const baseHref = action.href?.trim();
  if (!baseHref) return null;
  const params = buildSelectionParams(
    selectedIds,
    resolveSelectionConstraints(action.selection)
  );
  const extraParams = normalizeHrefParams(action.execution?.params ?? null);
  return buildHref(baseHref, { ...extraParams, ...params });
};

const resolveRpcName = (action: BulkActionDefinition) => {
  const rpc = action.execution?.rpc?.trim();
  return rpc || null;
};

type ActionInputValues = Record<string, string>;

const normalizeActionInputFields = (
  action: BulkActionDefinition | null
): UiCommandInputField[] => {
  const fields = action?.execution?.input_schema?.fields;
  return Array.isArray(fields)
    ? fields.filter(
        (field): field is UiCommandInputField =>
          Boolean(field?.key?.trim() && field?.label?.trim())
      )
    : [];
};

const buildActionInputDefaults = (fields: UiCommandInputField[]): ActionInputValues =>
  fields.reduce<ActionInputValues>((acc, field) => {
    const key = field.key.trim();
    const defaultValue = field.default_value;
    if (
      typeof defaultValue === "string" ||
      typeof defaultValue === "number" ||
      typeof defaultValue === "boolean"
    ) {
      acc[key] = String(defaultValue);
    } else {
      acc[key] = "";
    }
    return acc;
  }, {});

const validateActionInputValues = (
  fields: UiCommandInputField[],
  values: ActionInputValues
) =>
  fields.reduce<Record<string, string>>((acc, field) => {
    const key = field.key.trim();
    if (field.required && !String(values[key] ?? "").trim()) {
      acc[key] = `${field.label} is required.`;
    }
    return acc;
  }, {});

const buildActionInputParams = (
  action: BulkActionDefinition,
  values: ActionInputValues | null | undefined
) => {
  const fields = normalizeActionInputFields(action);
  if (fields.length === 0 || !values) {
    return null;
  }

  const params = fields.reduce<Record<string, string>>((acc, field) => {
    const key = field.key.trim();
    const value = String(values[key] ?? "").trim();
    if (value) {
      acc[key] = value;
    }
    return acc;
  }, {});

  return Object.keys(params).length > 0 ? params : null;
};

const buildActionPayload = (
  action: BulkActionDefinition,
  selectedIds: string[],
  inputValues?: ActionInputValues | null
) => {
  const rawParams = action.execution?.params;
  const staticParams =
    rawParams && typeof rawParams === "object"
      ? { ...rawParams }
      : null;
  const inputParams = buildActionInputParams(action, inputValues);
  const payloadKey = action.execution?.payload_key?.trim() || null;
  let params = staticParams;

  if (inputParams) {
    if (payloadKey) {
      params = {
        ...(params ?? {}),
        [payloadKey]: inputParams,
      };
    } else {
      params = {
        ...(params ?? {}),
        ...inputParams,
      };
    }
  }

  return {
    p_action_key: action.key,
    p_resource_key: action.resourceKey ?? null,
    p_selection_ids: selectedIds,
    p_selection_id: selectedIds.length === 1 ? selectedIds[0] : null,
    p_selection_count: selectedIds.length,
    p_params: params && Object.keys(params).length > 0 ? params : null,
  };
};

const readValueAtPath = (value: unknown, path?: string | null): unknown => {
  const normalizedPath = path?.trim() ?? "";
  if (!normalizedPath) return value;
  return normalizedPath.split(".").reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) && index >= 0 ? current[index] : undefined;
    }
    if (typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
};

const isReadbackParamSource = (
  value: unknown
): value is UiCommandReadbackParamSource => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = (value as Record<string, unknown>).source;
  return source === "result" || source === "selection" || source === "static";
};

const resolveReadbackParam = (
  spec: unknown,
  commandResult: unknown,
  selectedIds: string[]
) => {
  if (!isReadbackParamSource(spec)) return spec;
  if (spec.source === "result") {
    return readValueAtPath(commandResult, spec.path);
  }
  if (spec.source === "selection") {
    if (spec.path === "id") return selectedIds.length === 1 ? selectedIds[0] : null;
    if (spec.path === "ids") return selectedIds;
    return selectedIds.length;
  }
  return spec.value;
};

const clampInteger = (
  value: number | null | undefined,
  fallback: number,
  max: number
) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
};

const waitForConfiguredReadback = async (
  ui: ReturnType<typeof createUiClient>,
  readback: UiCommandReadback,
  commandResult: unknown,
  selectedIds: string[],
  failureMessage: string
) => {
  const rpcName = readback.rpc?.trim() ?? "";
  if (!rpcName) throw new Error(failureMessage);

  const params = Object.fromEntries(
    Object.entries(readback.params ?? {}).map(([key, spec]) => [
      key,
      resolveReadbackParam(spec, commandResult, selectedIds),
    ])
  );
  const successPath = readback.success_path?.trim() || "visible";
  const maxAttempts = clampInteger(readback.max_attempts, 4, 10);
  const delayMs = Math.min(
    Math.max(Math.trunc(readback.delay_ms ?? 150), 0),
    2000
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const readbackResult = await ui.rpc<Record<string, unknown>>(rpcName, params);
    if (readValueAtPath(readbackResult, successPath) === true) {
      return readbackResult;
    }
    if (attempt < maxAttempts && delayMs > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
    }
  }

  throw new Error(failureMessage);
};

const subscribeToClientReady = () => () => {};
const getClientReadySnapshot = () => true;
const getServerReadySnapshot = () => false;

export function BulkActions({
  actions,
  selectedIds,
  appBasePath,
  telemetry,
  testIdPrefix,
  onSuccess,
  onBatchResultReadbackChange,
  renderBatchResultReadback = true,
}: BulkActionsProps) {
  const t = createUiTranslator("ui.resourceActions");
  // Server-rendered controls must wait until their confirmation handlers are attached.
  const clientReady = React.useSyncExternalStore(
    subscribeToClientReady,
    getClientReadySnapshot,
    getServerReadySnapshot,
  );
  const queryClient = useQueryClient();
  const resolvedTestIdPrefix = testIdPrefix?.trim()
    ? `${testIdPrefix}-bulk-actions`
    : undefined;
  const { toast } = useToast();
  const [pendingKey, setPendingKey] = React.useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = React.useState<ActionFeedback | null>(null);
  const [batchResultReadback, setBatchResultReadback] =
    React.useState<BatchResultReadback | null>(null);
  const [printProgress, setPrintProgress] = React.useState<PrintProgressState | null>(
    null
  );
  const [confirmAction, setConfirmAction] =
    React.useState<BulkActionDefinition | null>(null);
  const [confirmingActionKey, setConfirmingActionKey] = React.useState<string | null>(
    null
  );
  const [confirmInputValues, setConfirmInputValues] =
    React.useState<ActionInputValues>({});
  const [confirmInputErrors, setConfirmInputErrors] =
    React.useState<Record<string, string>>({});
  const [confirmLookupState, setConfirmLookupState] =
    React.useState<ConfirmLookupState>({
      loading: false,
      error: null,
      optionsByCategory: {},
    });
  const [undoState, setUndoState] = React.useState<UndoState | null>(null);
  const undoTimerRef = React.useRef<number | null>(null);
  const actionsByKey = React.useMemo(() => {
    return new Map(actions.map((action) => [action.key, action]));
  }, [actions]);
  const selectionSignature = React.useMemo(
    () => [...selectedIds].sort().join(","),
    [selectedIds]
  );
  const updateBatchResultReadback = React.useCallback(
    (result: BatchResultReadback | null) => {
      setBatchResultReadback(result);
      onBatchResultReadbackChange?.(result);
    },
    [onBatchResultReadbackChange]
  );
  React.useEffect(() => {
    if (!onBatchResultReadbackChange) setBatchResultReadback(null);
  }, [onBatchResultReadbackChange, selectionSignature]);
  const scopeMeta = React.useMemo(
    () => buildScopeMeta(telemetry),
    [
      telemetry?.scopeId,
      telemetry?.scopeType,
      telemetry?.scopeValue,
      telemetry?.settingsResolutionId,
    ]
  );
  const scopeDigest = React.useMemo(
    () => resolveScopeDigest(telemetry),
    [telemetry?.settingsResolutionId]
  );
  const reportBulkEvent = React.useCallback(
    (
      type: string,
      action?: BulkActionDefinition | null,
      message?: string,
      eventMeta?: BulkEventMeta
    ) => {
      const mergedMeta: BulkEventMeta = {
        ...(scopeMeta ?? {}),
        ...(eventMeta ?? {}),
      };
      const normalizedMeta = Object.fromEntries(
        Object.entries(mergedMeta).filter(([, value]) => value !== undefined)
      ) as Record<string, string | number | boolean | null>;
      reportUiEvent({
        type,
        timestamp: new Date().toISOString(),
        context: action?.resourceKey ?? undefined,
        name: action?.key,
        message: message ?? action?.label,
        digest: scopeDigest,
        meta:
          Object.keys(normalizedMeta).length > 0 ? normalizedMeta : undefined,
      });
    },
    [scopeDigest, scopeMeta]
  );
  const openConfirmDialog = React.useCallback((action: BulkActionDefinition) => {
    const fields = normalizeActionInputFields(action);
    reportBulkEvent("ui.bulk_action.confirm.open", action);
    setConfirmInputValues(buildActionInputDefaults(fields));
    setConfirmInputErrors({});
    setConfirmAction(action);
  }, [reportBulkEvent]);
  const describePrintProgress = React.useCallback(
    (
      status: PrintRunOutputStatus,
      progressStatus: PrintProgressStatus,
      targetDownloadMs: number
    ) => {
      if (progressStatus === "failed" && status.failureReason) {
        return status.failureReason;
      }
      if ((status.pendingCount ?? 0) > 0) {
        return t("printProgress.detail.pendingCount", {
          count: status.pendingCount ?? 0,
        });
      }
      if ((status.readyCount ?? 0) > 0) {
        return t("printProgress.detail.readyCount", {
          count: status.readyCount ?? 0,
        });
      }
      if (progressStatus === "checking") {
        return t("printProgress.detail.checking");
      }
      if (progressStatus === "generating") {
        return t("printProgress.detail.generating");
      }
      if (progressStatus === "bundling") {
        return t("printProgress.detail.bundling");
      }
      if (progressStatus === "downloading") {
        return t("printProgress.detail.downloading");
      }
      if (progressStatus === "completed") {
        return t("printProgress.detail.completed");
      }
      if (progressStatus === "failed") {
        return t("printProgress.detail.failed");
      }
      return t("printProgress.detail.target", { target: targetDownloadMs });
    },
    [t]
  );
  const resolveUndoMeta = React.useCallback(
    (action: BulkActionDefinition) => {
      const params = action.execution?.params;
      if (!params || typeof params !== "object") return null;
      const rawKey =
        typeof params.undo_command_key === "string"
          ? params.undo_command_key.trim()
          : "";
      if (!rawKey) return null;
      const undoAction = actionsByKey.get(rawKey);
      if (!undoAction) return null;
      const rawLabel =
        typeof params.undo_label === "string" ? params.undo_label.trim() : "";
      const label =
        rawLabel || t("undoLabel", { action: action.label ?? "" });
      const rawTimeout = params.undo_timeout_ms;
      const timeoutMs =
        typeof rawTimeout === "number"
          ? rawTimeout
          : typeof rawTimeout === "string"
            ? Number.parseInt(rawTimeout, 10)
            : null;
      return {
        action: undoAction,
        label,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : null,
      };
    },
    [actionsByKey, t]
  );
  React.useEffect(() => {
    if (!undoState) return;
    if (undoState.selectionSignature !== selectionSignature) {
      setUndoState(null);
      return;
    }
    if (undoState.timeoutMs && undoState.timeoutMs > 0) {
      if (undoTimerRef.current) {
        window.clearTimeout(undoTimerRef.current);
      }
      undoTimerRef.current = window.setTimeout(() => {
        setUndoState(null);
        undoTimerRef.current = null;
      }, undoState.timeoutMs);
      return () => {
        if (undoTimerRef.current) {
          window.clearTimeout(undoTimerRef.current);
          undoTimerRef.current = null;
        }
      };
    }
    return () => {
      if (undoTimerRef.current) {
        window.clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    };
  }, [selectionSignature, undoState]);

  React.useEffect(() => {
    if (!printProgress) return;
    if (printProgress.status === "failed" && printProgress.minimized) {
      setPrintProgress((current) => {
        if (!current || current.workflowRunId !== printProgress.workflowRunId) {
          return current;
        }
        return current.minimized ? { ...current, minimized: false } : current;
      });
      return;
    }
    if (printProgress.status !== "completed" || printProgress.minimized) {
      return;
    }
    const timer = window.setTimeout(() => {
      setPrintProgress((current) => {
        if (!current || current.workflowRunId !== printProgress.workflowRunId) {
          return current;
        }
        if (current.status !== "completed" || current.minimized) {
          return current;
        }
        return {
          ...current,
          minimized: true,
        };
      });
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [printProgress]);

  const selectedCount = selectedIds.length;
  const safeBasePath = React.useMemo(
    () => resolveSafeAppBasePath(appBasePath ?? ""),
    [appBasePath]
  );
  const safeRunHref = React.useCallback(
    (destination: string | null) => {
      if (safeBasePath === null || !destination) return null;
      const normalizedDestination = destination.trim();
      if (!normalizedDestination) return null;
      const basePrefix = `${safeBasePath}/`;
      if (!normalizedDestination.startsWith(basePrefix)) return null;
      const relativePath = normalizedDestination.slice(safeBasePath.length);
      return resolveSafeHref(safeBasePath, relativePath);
    },
    [safeBasePath]
  );

  const runAction = React.useCallback(
    async (
      action: BulkActionDefinition,
      inputValues?: ActionInputValues | null
    ) => {
      const invocationIds = [...selectedIds];
      const feedbackIdentity = {
        actionKey: action.key,
        actionLabel: action.label,
        selectedIds: invocationIds,
      };
      if (undoState) setUndoState(null);
      const execution = action.execution;
      const actionType = execution?.type ?? "navigate";
      const href = resolveActionHref(action, selectedIds);
      const rpcName = resolveRpcName(action);
      const navigateFallback =
        (actionType === "workflow" ||
          actionType === "workflow_binding" ||
          actionType === "print") &&
        !rpcName;
      reportBulkEvent("ui.bulk_action.execute", action);
      if (actionType === "navigate" || navigateFallback) {
        if (href) {
          if (!isTrustedUrl(href)) {
            const blockedMessage = t("toast.errorTitle", {
              action: action.label,
            });
            toast({
              tone: "error",
              title: blockedMessage,
              description: blockedMessage,
            });
            reportBulkEvent("ui.bulk_action.navigate.blocked", action, href);
            return;
          }
          reportBulkEvent("ui.bulk_action.navigate", action);
          navigateTo(href);
        } else {
          reportBulkEvent("ui.bulk_action.navigate.skip", action, "missing href");
        }
        return;
      }
      if (
        actionType === "rpc" ||
        actionType === "workflow" ||
        actionType === "workflow_binding" ||
        actionType === "print"
      ) {
        if (!rpcName) {
          reportBulkEvent("ui.bulk_action.rpc.missing", action, "missing rpc");
          return;
        }
        const genericReceipt = actionType === "rpc" && !requiresBatchResultEvidence(execution);
        const showFeedback = (
          phase: ActionFeedback["phase"],
          detail: string,
          result?: Record<string, unknown>,
        ) => {
          const field = (value: unknown) => typeof value === "string" && value.trim()
            ? sanitizeUiError(value.trim())?.slice(0, 512)
            : undefined;
          const identity = (value: unknown) => typeof value === "string" && isUuidValue(value)
            ? value.trim()
            : field(value);
          setActionFeedback({
            ...feedbackIdentity, phase, detail,
            resultStatus: field(result?.status),
            workflowRunId: identity(result?.workflow_run_id),
            correlationId: identity(result?.correlation_id),
          });
        };
        setPendingKey(action.key);
        showFeedback("pending", t("feedback.pending", {
          action: action.label, count: invocationIds.length,
        }));
        if (
          actionType === "rpc" &&
          requiresBatchResultEvidence(action.execution)
        ) {
          updateBatchResultReadback(null);
        }
        let rpcReturned = false;
        let receiptResult: Record<string, unknown> | undefined;
        try {
          const ui = createUiClient();
          const commandStartedAtMs = Date.now();
          const result = await ui.rpc<Record<string, unknown>>(
            rpcName,
            buildActionPayload(action, invocationIds, inputValues)
          );
          rpcReturned = true;
          receiptResult = result;
          const commandDurationMs = Math.max(0, Date.now() - commandStartedAtMs);
          const batchReadback = actionType === "rpc" && requiresBatchResultEvidence(execution)
            ? parseBatchResultReadback({ actionKey: action.key, actionLabel: action.label,
                selectedIds: invocationIds, result })
            : null;
          // Keep committed outcomes even if refreshing the rows unmounts this toolbar.
          if (batchReadback) updateBatchResultReadback(batchReadback);
          const notifySuccess = async () => {
            try {
              await onSuccess?.({ action, result, selectedIds: [...invocationIds] });
              return true;
            } catch (error) {
              const errorMessage = formatUiError(error, "");
              if (genericReceipt) {
                showFeedback("warning", t("toast.readbackErrorDescription"), result);
              }
              toast({
                tone: "warning",
                title: t("toast.readbackErrorDescription"),
                description: errorMessage,
              });
              reportBulkEvent("ui.bulk_action.readback.refresh_error", action, errorMessage);
              return false;
            }
          };

          let configuredReadback: unknown = null;
          let configuredReadbackFailed = false;
          if (execution?.readback) {
            try {
              configuredReadback = await waitForConfiguredReadback(
                ui,
                execution.readback,
                result,
                invocationIds,
                t("toast.readbackErrorDescription")
              );
              const resourceKey = action.resourceKey?.trim() ?? "";
              if (resourceKey) {
                await Promise.all([
                  queryClient.invalidateQueries({
                    queryKey: ["resource", resourceKey],
                    refetchType: "active",
                  }),
                  queryClient.invalidateQueries({
                    queryKey: ["resource-detail", resourceKey],
                    refetchType: "active",
                  }),
                ]);
              }
              reportBulkEvent("ui.bulk_action.readback.success", action);

            } catch (error) {
              if (!requiresBatchResultEvidence(execution)) throw error;
              configuredReadbackFailed = true;
              toast({ tone: "warning", title: t("toast.readbackErrorDescription"),
                description: formatUiError(error, "") });
              reportBulkEvent("ui.bulk_action.readback.refresh_error", action);
            }
          }
          if (actionType === "rpc" && action.resourceKey) {
            void queryClient
              .invalidateQueries({
                queryKey: ["resource", action.resourceKey],
                refetchType: "active",
              })
              .catch((error) => {
                reportBulkEvent(
                  "ui.bulk_action.result.refresh.error",
                  action,
                  formatUiError(error, "Resource refresh failed")
                );
              });
          }

          if (batchReadback) {
            let readback = batchReadback;
            if (configuredReadback !== null && !configuredReadbackFailed && !readback.malformedReason) {
              try {
                readback = attachSelectionReadback(readback, configuredReadback);
              } catch (error) {
                configuredReadbackFailed = true;
                reportBulkEvent("ui.bulk_action.readback.refresh_error", action);
                toast({ tone: "warning", title: t("toast.readbackErrorDescription"),
                  description: formatUiError(error, "") });
              }
            }

            const resultMeta = {
              result_status: readback.status,
              total_count: readback.total,
              success_count: readback.success,
              failure_count: readback.failure,
              already_processed_count: readback.alreadyProcessed,
              queued_count: readback.queued,
              failed_ids: readback.items
                .filter((item) => item.outcome === "failed")
                .map((item) => item.id)
                .join(","),
              malformed_reason: readback.malformedReason,
            };

            // Refresh confirmed committed outcomes without changing partial-failure evidence.
            updateBatchResultReadback(readback);
            const refreshSucceeded = !readback.malformedReason && (readback.success > 0 || readback.failure === 0)
              ? await notifySuccess()
              : true;
            if (readback.malformedReason || readback.failure > 0) {
              toast({
                tone: "error",
                title: t("toast.errorTitle", { action: action.label }),
                description: readback.malformedReason
                  ? t("resultReadback.malformedDetail")
                  : t(readback.queued > 0 ? "resultReadback.toast.failureWithQueuedDescription" : "resultReadback.toast.failureDescription", {
                      total: readback.total,
                      success: readback.success,
                      failure: readback.failure,
                      already: readback.alreadyProcessed,
                      queued: readback.queued,
                    }),
              });
              reportBulkEvent(
                readback.malformedReason
                  ? "ui.bulk_action.result.malformed"
                  : "ui.bulk_action.result.failed",
                action,
                readback.status,
                resultMeta
              );
              return;
            }

            if (readback.queued > 0) {
              toast({
                tone: "info",
                title: t("resultReadback.toast.queuedTitle", { action: action.label }),
                description: t("resultReadback.toast.queuedDescription", {
                  total: readback.total,
                  success: readback.success,
                  already: readback.alreadyProcessed,
                  queued: readback.queued,
                }),
              });
              reportBulkEvent("ui.bulk_action.result.queued", action, readback.status, resultMeta);
              return;
            }

            if (refreshSucceeded && !configuredReadbackFailed) {
              toast({
                tone: "success",
                title: t("toast.successTitle", { action: action.label }),
                description: t("resultReadback.toast.successDescription", {
                  total: readback.total,
                  success: readback.success,
                  already: readback.alreadyProcessed,
                }),
              });
            }
            reportBulkEvent(
              "ui.bulk_action.success",
              action,
              readback.status,
              resultMeta
            );
            if (readback.success > 0) {
              const undoMeta = resolveUndoMeta(action);
              if (undoMeta) {
                reportBulkEvent(
                  "ui.bulk_action.undo.ready",
                  undoMeta.action,
                  undoMeta.label
                );
                setUndoState({
                  ...undoMeta,
                  selectionSignature,
                });
              }
            }
            return;
          }

          const workflowRunIdRaw =
            (actionType === "workflow" ||
              actionType === "workflow_binding" ||
              actionType === "print") &&
            result &&
            typeof result === "object"
              ? (result as Record<string, unknown>).workflow_run_id
              : null;
          const workflowRunId =
            typeof workflowRunIdRaw === "string" && workflowRunIdRaw.trim()
              ? workflowRunIdRaw.trim()
              : null;

          if (
            workflowRunId &&
            (actionType === "workflow" ||
              actionType === "workflow_binding" ||
              actionType === "print")
          ) {
            await notifySuccess();
            if (safeBasePath === null) {
              const blockedMessage = t("toast.errorTitle", {
                action: action.label,
              });
              toast({
                tone: "error",
                title: blockedMessage,
                description: blockedMessage,
              });
              return;
            }
            const typedResult =
              result && typeof result === "object"
                ? (result as Record<string, unknown>)
                : null;
            const correlationId = resolveCorrelationId(typedResult);
            const diagnosticSuffix = resolveDiagnosticSuffix(correlationId);
            const runHrefBase = resolveSafeHref(
              safeBasePath,
              `/workflows/runs/${encodeURIComponent(workflowRunId)}`
            );
            const runOutputsHref = resolveSafeHref(
              safeBasePath,
              `/workflows/runs/${encodeURIComponent(workflowRunId)}#outputs`
            );
            const workflowRunHref =
              actionType === "workflow" || actionType === "workflow_binding"
                ? resolveWorkflowRunDestination({
                    appBasePath: safeBasePath,
                    result,
                  })
                : null;
            const runHref =
              actionType === "print"
                ? runOutputsHref
                : safeRunHref(workflowRunHref) ?? runHrefBase;
            reportBulkEvent("ui.bulk_action.workflow.run", action, runHref ?? undefined);
            if (!runHref) {
              const blockedMessage = t("toast.errorTitle", {
                action: action.label,
              });
              toast({
                tone: "error",
                title: blockedMessage,
                description: blockedMessage,
              });
              reportBulkEvent(
                "ui.bulk_action.workflow.run.blocked",
                action,
                runHref ?? undefined
              );
              return;
            }
            if (actionType === "print") {
              const printOptions = resolvePrintExecutionOptions(action);
              if (printOptions.contractErrors.length > 0) {
                const contractError = `Invalid print action contract: ${printOptions.contractErrors.join(
                  "; "
                )}`;
                toast({
                  tone: "error",
                  title: t("toast.errorTitle", { action: action.label }),
                  description: contractError,
                });
                reportBulkEvent(
                  "ui.bulk_action.print.contract.invalid",
                  action,
                  contractError,
                  {
                    workflow_run_id: workflowRunId,
                    phase: "contract_invalid",
                    auto_download: printOptions.autoDownload,
                    fallback_mode: printOptions.fallbackMode,
                  }
                );
                return;
              }
              if (printOptions.autoDownload) {
                const startedAtMs = Date.now();
                const pushProgress = (
                  patch: Partial<PrintProgressState> & {
                    status?: PrintProgressStatus;
                  }
                ) => {
                  setPrintProgress((current) => {
                    if (!current || current.workflowRunId !== workflowRunId) {
                      return current;
                    }
                    return {
                      ...current,
                      ...patch,
                      elapsedMs: Date.now() - startedAtMs,
                    };
                  });
                };
                setPrintProgress({
                  actionKey: action.key,
                  actionLabel: action.label,
                  selectionCount: selectedCount,
                  workflowRunId,
                  status: "queued",
                  detail: t("printProgress.detail.queued"),
                  runOutputsHref,
                  startedAtMs,
                  elapsedMs: 0,
                  targetDownloadMs: printOptions.targetDownloadMs,
                  targetMiss: false,
                  minimized: false,
                  technicalDetailsOpen: false,
                  statusSnapshot: null,
                });
                reportBulkEvent(
                  "ui.bulk_action.print.progress.started",
                  action,
                  `workflow_run_id=${workflowRunId};target_download_ms=${printOptions.targetDownloadMs};fallback_mode=${printOptions.fallbackMode}`,
                  {
                    workflow_run_id: workflowRunId,
                    target_download_ms: printOptions.targetDownloadMs,
                    fallback_mode: printOptions.fallbackMode,
                    stage_command_ms: commandDurationMs,
                    phase: "queued",
                  }
                );
                void (async () => {
                  let lastReportedStatus: PrintProgressStatus | null = null;
                  let firstStatusAtMs: number | null = null;
                  let outputReadyAtMs: number | null = null;
                  let outputSource: string | null = null;
                  let functionTotalMs: number | null = null;
                  const polled = await pollWorkflowRunForOutputUrl({
                    ui,
                    workflowRunId,
                    outputUrlPaths: printOptions.outputUrlPaths,
                    pollScheduleMs: printOptions.pollScheduleMs,
                    pollIntervalMs: printOptions.pollIntervalMs,
                    pollTimeoutMs: printOptions.pollTimeoutMs,
                    pollProgressEnabled: printOptions.pollProgressEnabled,
                    pollProgressBudgetMs: printOptions.pollProgressBudgetMs,
                    pollProgressMaxSteps: printOptions.pollProgressMaxSteps,
                    onProgress: (status) => {
                      const nowMs = Date.now();
                      if (firstStatusAtMs === null) {
                        firstStatusAtMs = nowMs;
                      }
                      if (status.outputReady || status.outputUrl) {
                        outputReadyAtMs = nowMs;
                      }
                      if (status.outputSource) {
                        outputSource = status.outputSource;
                      }
                      if (
                        typeof status.functionTotalMs === "number" &&
                        Number.isFinite(status.functionTotalMs)
                      ) {
                        functionTotalMs = status.functionTotalMs;
                      }
                      const progressStatus = resolvePrintProgressStatus(status);
                      const detail = describePrintProgress(
                        status,
                        progressStatus,
                        printOptions.targetDownloadMs
                      );
                      pushProgress({
                        status: progressStatus,
                        detail,
                        statusSnapshot: {
                          ...status,
                          failureReason: status.failureReason,
                        },
                      });
                      if (progressStatus !== lastReportedStatus) {
                        reportBulkEvent(
                          "ui.bulk_action.print.progress.status",
                          action,
                          `status=${progressStatus};workflow_status=${status.workflowStatus ?? "unknown"}`,
                          {
                            workflow_run_id: workflowRunId,
                            status: progressStatus,
                            workflow_status: status.workflowStatus ?? "unknown",
                            phase: progressStatus,
                          }
                        );
                        lastReportedStatus = progressStatus;
                      }
                    },
                    onSoftTimeout: () => {
                      pushProgress({
                        status: "checking",
                        detail: t("printProgress.detail.stillWaiting"),
                        minimized: false,
                      });
                      reportBulkEvent(
                        "ui.bulk_action.print.progress.soft_timeout",
                        action,
                        undefined,
                        {
                          workflow_run_id: workflowRunId,
                          phase: "checking",
                        }
                      );
                    },
                  });
                  if (polled.outputUrl) {
                    let elapsedMs = Date.now() - startedAtMs;
                    if (outputReadyAtMs === null) {
                      outputReadyAtMs = Date.now();
                    }
                    if (polled.status?.outputSource) {
                      outputSource = polled.status.outputSource;
                    }
                    if (
                      typeof polled.status?.functionTotalMs === "number" &&
                      Number.isFinite(polled.status.functionTotalMs)
                    ) {
                      functionTotalMs = polled.status.functionTotalMs;
                    }
                    const stageFirstStatusMs =
                      firstStatusAtMs === null ? null : Math.max(0, firstStatusAtMs - startedAtMs);
                    const stageOutputReadyMs =
                      outputReadyAtMs === null ? null : Math.max(0, outputReadyAtMs - startedAtMs);
                    const stageTransportMs =
                      stageOutputReadyMs === null ? null : Math.max(0, elapsedMs - stageOutputReadyMs);
                    const edgeOverheadMs =
                      functionTotalMs === null
                        ? null
                        : Math.max(0, Number((elapsedMs - functionTotalMs).toFixed(2)));
                    const stagePrepareMs =
                      typeof polled.status?.stagePrepareMs === "number" &&
                      Number.isFinite(polled.status.stagePrepareMs)
                        ? polled.status.stagePrepareMs
                        : null;
                    const stageExecuteMs =
                      typeof polled.status?.stageExecuteMs === "number" &&
                      Number.isFinite(polled.status.stageExecuteMs)
                        ? polled.status.stageExecuteMs
                        : null;
                    const stageEnqueueMs =
                      typeof polled.status?.stageEnqueueMs === "number" &&
                      Number.isFinite(polled.status.stageEnqueueMs)
                        ? polled.status.stageEnqueueMs
                        : null;
                    const stageRenderMs =
                      typeof polled.status?.stageRenderMs === "number" &&
                      Number.isFinite(polled.status.stageRenderMs)
                        ? polled.status.stageRenderMs
                        : null;
                    const stageBundleMs =
                      typeof polled.status?.stageBundleMs === "number" &&
                      Number.isFinite(polled.status.stageBundleMs)
                        ? polled.status.stageBundleMs
                        : null;
                    const stageCompleteMs =
                      typeof polled.status?.stageCompleteMs === "number" &&
                      Number.isFinite(polled.status.stageCompleteMs)
                        ? polled.status.stageCompleteMs
                        : null;
                    const stageRenderWaitMs =
                      typeof polled.status?.stageRenderWaitMs === "number" &&
                      Number.isFinite(polled.status.stageRenderWaitMs)
                        ? polled.status.stageRenderWaitMs
                        : null;
                    const stageBundleWaitMs =
                      typeof polled.status?.stageBundleWaitMs === "number" &&
                      Number.isFinite(polled.status.stageBundleWaitMs)
                        ? polled.status.stageBundleWaitMs
                        : null;
                    const stageFinalizeMs =
                      typeof polled.status?.stageFinalizeMs === "number" &&
                      Number.isFinite(polled.status.stageFinalizeMs)
                        ? polled.status.stageFinalizeMs
                        : null;
                    const opened = await downloadTrustedFile(polled.outputUrl);
                    elapsedMs = Date.now() - startedAtMs;
                    const targetMiss = elapsedMs > printOptions.targetDownloadMs;
                    const targetMessage = targetMiss
                      ? t("printProgress.detail.targetMiss", {
                          elapsed: elapsedMs,
                          target: printOptions.targetDownloadMs,
                        })
                      : t("printProgress.detail.targetHit", { elapsed: elapsedMs });
                    const kpiMessage = `click_to_download_start_ms=${elapsedMs};target_download_ms=${printOptions.targetDownloadMs};classification=${targetMiss ? "miss" : "hit"}`;
                    reportBulkEvent(
                      "ui.bulk_action.print.download.kpi",
                      action,
                      kpiMessage,
                      {
                        workflow_run_id: workflowRunId,
                        click_to_download_start_ms: elapsedMs,
                        target_download_ms: printOptions.targetDownloadMs,
                        classification: targetMiss ? "miss" : "hit",
                        stage_command_ms: commandDurationMs,
                        stage_first_status_ms: stageFirstStatusMs,
                        stage_output_ready_ms: stageOutputReadyMs,
                        stage_transport_ms: stageTransportMs,
                        function_total_ms: functionTotalMs,
                        edge_overhead_ms: edgeOverheadMs,
                        stage_prepare_ms: stagePrepareMs,
                        stage_execute_ms: stageExecuteMs,
                        stage_enqueue_ms: stageEnqueueMs,
                        stage_render_ms: stageRenderMs,
                        stage_bundle_ms: stageBundleMs,
                        stage_complete_ms: stageCompleteMs,
                        stage_render_wait_ms: stageRenderWaitMs,
                        stage_bundle_wait_ms: stageBundleWaitMs,
                        stage_finalize_ms: stageFinalizeMs,
                        fresh_expected_count: polled.status?.freshExpectedCount ?? null,
                        fresh_ready_count: polled.status?.freshReadyCount ?? null,
                        fresh_failed_count: polled.status?.freshFailedCount ?? null,
                        fresh_only_resolved: polled.status?.freshOnlyResolved ?? null,
                        print_mode: polled.status?.printMode ?? null,
                        artifact_kind: polled.status?.artifactKind ?? null,
                        output_source: outputSource,
                        artifact_persisted: polled.status?.artifactPersisted ?? null,
                        job_completion_pending:
                          polled.status?.jobCompletionPending ?? null,
                        timing_source: polled.status?.timingSource ?? null,
                        phase: "downloading",
                      }
                    );
                    if (targetMiss) {
                      reportBulkEvent(
                        "ui.bulk_action.print.download.target_miss",
                        action,
                        kpiMessage,
                        {
                          workflow_run_id: workflowRunId,
                          click_to_download_start_ms: elapsedMs,
                          target_download_ms: printOptions.targetDownloadMs,
                          classification: "miss",
                          stage_command_ms: commandDurationMs,
                          stage_first_status_ms: stageFirstStatusMs,
                          stage_output_ready_ms: stageOutputReadyMs,
                          stage_transport_ms: stageTransportMs,
                          function_total_ms: functionTotalMs,
                          edge_overhead_ms: edgeOverheadMs,
                          stage_prepare_ms: stagePrepareMs,
                          stage_execute_ms: stageExecuteMs,
                          stage_enqueue_ms: stageEnqueueMs,
                          stage_render_ms: stageRenderMs,
                          stage_bundle_ms: stageBundleMs,
                          stage_complete_ms: stageCompleteMs,
                          stage_render_wait_ms: stageRenderWaitMs,
                          stage_bundle_wait_ms: stageBundleWaitMs,
                          stage_finalize_ms: stageFinalizeMs,
                          fresh_expected_count: polled.status?.freshExpectedCount ?? null,
                          fresh_ready_count: polled.status?.freshReadyCount ?? null,
                          fresh_failed_count: polled.status?.freshFailedCount ?? null,
                          fresh_only_resolved: polled.status?.freshOnlyResolved ?? null,
                          print_mode: polled.status?.printMode ?? null,
                          artifact_kind: polled.status?.artifactKind ?? null,
                          output_source: outputSource,
                          artifact_persisted: polled.status?.artifactPersisted ?? null,
                          job_completion_pending:
                            polled.status?.jobCompletionPending ?? null,
                          timing_source: polled.status?.timingSource ?? null,
                          phase: "downloading",
                        }
                      );
                    }
                    if (opened) {
                      pushProgress({
                        status: "completed",
                        detail: targetMessage,
                        targetMiss,
                        elapsedMs,
                        minimized: false,
                        statusSnapshot:
                          polled.status
                            ? {
                                ...polled.status,
                                outputSource,
                                functionTotalMs,
                              }
                            : createDefaultPrintRunOutputStatus({
                                workflowStatus: "completed",
                                outputSource,
                                functionTotalMs,
                                outputReady: true,
                              }),
                      });
                      toast({
                        tone: "success",
                        title: t("toast.successTitle", { action: action.label }),
                        description: `${t("toast.printDownloadStartedDescription")} ${targetMessage}${diagnosticSuffix}`,
                      });
                      reportBulkEvent(
                        "ui.bulk_action.print.download.started",
                        action,
                        polled.outputUrl,
                        {
                          workflow_run_id: workflowRunId,
                          click_to_download_start_ms: elapsedMs,
                          target_download_ms: printOptions.targetDownloadMs,
                          classification: targetMiss ? "miss" : "hit",
                          stage_command_ms: commandDurationMs,
                          stage_first_status_ms: stageFirstStatusMs,
                          stage_output_ready_ms: stageOutputReadyMs,
                          stage_transport_ms: stageTransportMs,
                          function_total_ms: functionTotalMs,
                          edge_overhead_ms: edgeOverheadMs,
                          stage_prepare_ms: stagePrepareMs,
                          stage_execute_ms: stageExecuteMs,
                          stage_enqueue_ms: stageEnqueueMs,
                          stage_render_ms: stageRenderMs,
                          stage_bundle_ms: stageBundleMs,
                          stage_complete_ms: stageCompleteMs,
                          stage_render_wait_ms: stageRenderWaitMs,
                          stage_bundle_wait_ms: stageBundleWaitMs,
                          stage_finalize_ms: stageFinalizeMs,
                          fresh_expected_count: polled.status?.freshExpectedCount ?? null,
                          fresh_ready_count: polled.status?.freshReadyCount ?? null,
                          fresh_failed_count: polled.status?.freshFailedCount ?? null,
                          fresh_only_resolved: polled.status?.freshOnlyResolved ?? null,
                          print_mode: polled.status?.printMode ?? null,
                          artifact_kind: polled.status?.artifactKind ?? null,
                          output_source: outputSource,
                          artifact_persisted: polled.status?.artifactPersisted ?? null,
                          job_completion_pending:
                            polled.status?.jobCompletionPending ?? null,
                          timing_source: polled.status?.timingSource ?? null,
                          phase: "completed",
                        }
                      );
                      return;
                    }
                    pushProgress({
                      status: "failed",
                      detail: t("printProgress.detail.downloadFailed"),
                      targetMiss,
                      elapsedMs,
                      minimized: false,
                      statusSnapshot:
                        polled.status
                          ? {
                              ...polled.status,
                              failureReason: t("printProgress.detail.downloadFailed"),
                              outputSource,
                            }
                          : createDefaultPrintRunOutputStatus({
                              workflowStatus: "failed",
                              terminal: true,
                              failureReason: t("printProgress.detail.downloadFailed"),
                              outputSource,
                            }),
                    });
                    toast({
                      tone: "error",
                      title: t("toast.errorTitle", { action: action.label }),
                      description: `${t("printProgress.detail.downloadFailed")}${diagnosticSuffix}`,
                    });
                    reportBulkEvent(
                      "ui.bulk_action.print.download.failed_to_start",
                      action,
                      polled.outputUrl,
                      {
                        workflow_run_id: workflowRunId,
                        click_to_download_start_ms: elapsedMs,
                        target_download_ms: printOptions.targetDownloadMs,
                        classification: targetMiss ? "miss" : "hit",
                        stage_command_ms: commandDurationMs,
                        stage_first_status_ms: stageFirstStatusMs,
                        stage_output_ready_ms: stageOutputReadyMs,
                        stage_transport_ms: stageTransportMs,
                        function_total_ms: functionTotalMs,
                        edge_overhead_ms: edgeOverheadMs,
                        stage_prepare_ms: stagePrepareMs,
                        stage_execute_ms: stageExecuteMs,
                        stage_enqueue_ms: stageEnqueueMs,
                        stage_render_ms: stageRenderMs,
                        stage_bundle_ms: stageBundleMs,
                        stage_complete_ms: stageCompleteMs,
                        stage_render_wait_ms: stageRenderWaitMs,
                        stage_bundle_wait_ms: stageBundleWaitMs,
                        stage_finalize_ms: stageFinalizeMs,
                        fresh_expected_count: polled.status?.freshExpectedCount ?? null,
                        fresh_ready_count: polled.status?.freshReadyCount ?? null,
                        fresh_failed_count: polled.status?.freshFailedCount ?? null,
                        fresh_only_resolved: polled.status?.freshOnlyResolved ?? null,
                        print_mode: polled.status?.printMode ?? null,
                        artifact_kind: polled.status?.artifactKind ?? null,
                        output_source: outputSource,
                        artifact_persisted: polled.status?.artifactPersisted ?? null,
                        job_completion_pending:
                          polled.status?.jobCompletionPending ?? null,
                        timing_source: polled.status?.timingSource ?? null,
                        phase: "failed",
                      }
                    );
                    return;
                  }
                  if (polled.status?.terminal) {
                    const failureReason =
                      polled.status.failureReason ||
                      t("printProgress.detail.terminalFailure");
                    pushProgress({
                      status: "failed",
                      detail: failureReason,
                      minimized: false,
                      statusSnapshot: {
                        ...polled.status,
                        failureReason,
                      },
                    });
                    toast({
                      tone: "error",
                      title: t("toast.errorTitle", { action: action.label }),
                      description: `${failureReason}${diagnosticSuffix}`,
                    });
                    reportBulkEvent(
                      "ui.bulk_action.print.failed",
                      action,
                      failureReason,
                      {
                        workflow_run_id: workflowRunId,
                        fresh_expected_count: polled.status.freshExpectedCount,
                        fresh_ready_count: polled.status.freshReadyCount,
                        fresh_failed_count: polled.status.freshFailedCount,
                        fresh_only_resolved: polled.status.freshOnlyResolved,
                        stage_prepare_ms: polled.status.stagePrepareMs,
                        stage_execute_ms: polled.status.stageExecuteMs,
                        stage_enqueue_ms: polled.status.stageEnqueueMs,
                        stage_render_ms: polled.status.stageRenderMs,
                        stage_bundle_ms: polled.status.stageBundleMs,
                        stage_complete_ms: polled.status.stageCompleteMs,
                        stage_render_wait_ms: polled.status.stageRenderWaitMs,
                        stage_bundle_wait_ms: polled.status.stageBundleWaitMs,
                        stage_finalize_ms: polled.status.stageFinalizeMs,
                        print_mode: polled.status.printMode,
                        artifact_kind: polled.status.artifactKind,
                        output_source: polled.status.outputSource,
                        artifact_persisted: polled.status.artifactPersisted,
                        job_completion_pending:
                          polled.status.jobCompletionPending,
                        timing_source: polled.status.timingSource,
                        phase: "failed",
                      }
                    );
                    return;
                  }
                  if (polled.error) {
                    const errorMessage = formatUiError(
                      polled.error,
                      t("toast.errorTitle", { action: action.label })
                    );
                    pushProgress({
                      status: "failed",
                      detail: errorMessage,
                      minimized: false,
                      statusSnapshot: createDefaultPrintRunOutputStatus({
                        workflowStatus: "failed",
                        terminal: true,
                        failureReason: errorMessage,
                      }),
                    });
                    toast({
                      tone: "error",
                      title: t("toast.errorTitle", { action: action.label }),
                      description: `${errorMessage}${diagnosticSuffix}`,
                    });
                    reportBulkEvent(
                      "ui.bulk_action.print.poll.error",
                      action,
                      polled.error.message,
                      {
                        workflow_run_id: workflowRunId,
                        phase: "failed",
                      }
                    );
                    return;
                  }
                  pushProgress({
                    status: "checking",
                    detail: t("printProgress.detail.stillWaiting"),
                    minimized: false,
                  });
                })().catch((error) => {
                  const errorMessage = formatUiError(
                    error,
                    t("toast.errorTitle", { action: action.label })
                  );
                  setPrintProgress((current) => {
                    if (!current || current.workflowRunId !== workflowRunId) return current;
                    return {
                      ...current,
                      status: "failed",
                      detail: errorMessage,
                      elapsedMs: Date.now() - startedAtMs,
                      minimized: false,
                      statusSnapshot: createDefaultPrintRunOutputStatus({
                        workflowStatus: "failed",
                        terminal: true,
                        failureReason: errorMessage,
                      }),
                    };
                  });
                  reportBulkEvent("ui.bulk_action.print.error", action, getUiErrorMessage(error) ?? errorMessage);
                });
                return;
              }

              const opened = openTrustedInNewTab(runHref);
              if (opened) {
                toast({
                  tone: "success",
                  title: t("toast.successTitle", { action: action.label }),
                  description: t("toast.successDescription", {
                    count: selectedCount,
                  }),
                });
                reportBulkEvent("ui.bulk_action.print.opened", action, runHref);
                return;
              }
              toast({
                tone: "error",
                title: t("toast.errorTitle", { action: action.label }),
                description: t("toast.errorTitle", { action: action.label }),
              });
              reportBulkEvent("ui.bulk_action.print.blocked", action, runHref);
              return;
            }
            navigateTo(runHref);
            return;
          }
          if (await notifySuccess()) {
            if (genericReceipt) {
              showFeedback("submitted", t("toast.successDescription", { count: invocationIds.length }), result);
            }
            toast({
              tone: "success",
              title: t("toast.successTitle", { action: action.label }),
              description: t("toast.successDescription", {
                count: selectedCount,
              }),
            });
          }
          reportBulkEvent("ui.bulk_action.success", action);
          const undoMeta = resolveUndoMeta(action);
          if (undoMeta) {
            reportBulkEvent(
              "ui.bulk_action.undo.ready",
              undoMeta.action,
              undoMeta.label
            );
            setUndoState({
              ...undoMeta,
              selectionSignature,
            });
          }
        } catch (error) {
          const errorMessage = formatUiError(
            error,
            t("toast.errorTitle", { action: action.label })
          );
          toast({
            tone: "error",
            title: t("toast.errorTitle", { action: action.label }),
            description: errorMessage,
          });
          if (genericReceipt) {
            showFeedback(
              rpcReturned ? "warning" : "error",
              rpcReturned ? t("toast.readbackErrorDescription") : errorMessage,
              receiptResult,
            );
          }
          reportBulkEvent("ui.bulk_action.error", action, getUiErrorMessage(error) ?? errorMessage);
        } finally {
          setPendingKey(null);
          setActionFeedback((current) => current?.actionKey === action.key && current.phase === "pending"
            ? null : current);
        }
      }
    },
    [
      describePrintProgress,
      queryClient,
      reportBulkEvent,
      resolveUndoMeta,
      selectedCount,
      selectedIds,
      safeBasePath,
      safeRunHref,
      onSuccess,
      updateBatchResultReadback,
      selectionSignature,
      t,
      toast,
      undoState?.action.key,
    ]
  );

  const confirmOpen = Boolean(confirmAction);
  const confirmConfig = confirmAction?.execution?.confirm ?? null;
  const confirmInputFields = React.useMemo(
    () => normalizeActionInputFields(confirmAction),
    [confirmAction]
  );
  React.useEffect(() => {
    if (!confirmAction) {
      setConfirmLookupState({
        loading: false,
        error: null,
        optionsByCategory: {},
      });
      return;
    }

    const categories = Array.from(
      new Set(
        confirmInputFields
          .filter((field) => field.type === "lookup")
          .map((field) => field.lookup_category?.trim() ?? "")
          .filter(Boolean)
      )
    );

    if (categories.length === 0) {
      setConfirmLookupState({
        loading: false,
        error: null,
        optionsByCategory: {},
      });
      return;
    }

    let cancelled = false;
    const ui = createUiClient();

    setConfirmLookupState({
      loading: true,
      error: null,
      optionsByCategory: {},
    });

    void (async () => {
      try {
        const entries = await Promise.all(
          categories.map(async (category) => {
            const lookupRows = await ui.rpc("list_lookup_values_v1", {
              p_category: category,
            });
            return [category, normalizeLookupOptions(lookupRows)] as const;
          })
        );
        if (cancelled) return;
        setConfirmLookupState({
          loading: false,
          error: null,
          optionsByCategory: Object.fromEntries(entries),
        });
      } catch (error) {
        if (cancelled) return;
        setConfirmLookupState({
          loading: false,
          error: formatUiError(error, "Unable to load lookup options."),
          optionsByCategory: {},
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [confirmAction, confirmInputFields]);
  const confirmTitle =
    confirmConfig?.title ??
    (confirmAction
      ? t("confirm.title", { action: confirmAction.label })
      : "");
  const confirmDescription =
    confirmConfig?.description ??
    (confirmAction
      ? t("confirm.description", {
          action: confirmAction.label,
          count: selectedCount,
        })
      : "");
  const inlineLimit = Math.max(uiDefaults.table.bulkActionInlineMax, 0);
  const isDownloadAction = (action: BulkActionDefinition) =>
    action.execution?.type === "download" && Boolean(action.download);
  const downloadCount = actions.filter(isDownloadAction).length;
  const inlineOtherLimit = Math.max(inlineLimit - downloadCount, 0);
  const inlineActions: BulkActionDefinition[] = [];
  const overflowActions: BulkActionDefinition[] = [];
  let inlineOtherCount = 0;

  actions.forEach((action) => {
    if (isDownloadAction(action)) {
      inlineActions.push(action);
      return;
    }
    if (inlineOtherCount < inlineOtherLimit) {
      inlineActions.push(action);
      inlineOtherCount += 1;
      return;
    }
    overflowActions.push(action);
  });
  const overflowGroups = overflowActions.reduce(
    (acc, action) => {
      const actionType = resolveActionType(action);
      const groupKey =
        actionType === "print"
          ? "print"
          : actionType === "workflow"
            ? "workflow"
            : actionType === "rpc"
              ? "rpc"
              : actionType === "navigate"
                ? "navigate"
                : actionType === "download"
                  ? "download"
                  : "other";
      const next = acc[groupKey] ?? [];
      next.push(action);
      acc[groupKey] = next;
      return acc;
    },
    {} as Record<string, BulkActionDefinition[]>
  );
  const groupedOverflow = [
    "print",
    "workflow",
    "rpc",
    "navigate",
    "download",
    "other",
  ]
    .map((key) => ({
      key,
      label: t(`groups.${key}`),
      actions: overflowGroups[key] ?? [],
    }))
    .filter((group) => group.actions.length > 0);
  const printProgressTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-print-progress`
    : "bulk-actions-print-progress";
  const printProgressIsTerminal =
    printProgress?.status === "completed" || printProgress?.status === "failed";

  const handlePrintProgressExpand = React.useCallback(() => {
    setPrintProgress((current) =>
      current
        ? {
            ...current,
            minimized: false,
          }
        : current
    );
  }, []);

  const handlePrintProgressHide = React.useCallback(() => {
    setPrintProgress((current) =>
      current
        ? {
            ...current,
            minimized: true,
            technicalDetailsOpen: false,
          }
        : current
    );
  }, []);

  const handlePrintProgressDismiss = React.useCallback(() => {
    setPrintProgress(null);
  }, []);

  const handlePrintProgressToggleDetails = React.useCallback(() => {
    setPrintProgress((current) =>
      current
        ? {
            ...current,
            technicalDetailsOpen: !current.technicalDetailsOpen,
            minimized: false,
          }
        : current
    );
  }, []);

  const handlePrintProgressOpenRun = React.useCallback(() => {
    if (!printProgress?.runOutputsHref) return;
    openTrustedInNewTab(printProgress.runOutputsHref);
  }, [printProgress?.runOutputsHref]);

  const handlePrintProgressRetry = React.useCallback(() => {
    if (!printProgress) return;
    const action = actionsByKey.get(printProgress.actionKey);
    if (!action) return;
    setPrintProgress(null);
    if (requiresExplicitConfirmation(action)) {
      openConfirmDialog(action);
      return;
    }
    void runAction(action);
  }, [actionsByKey, openConfirmDialog, printProgress, runAction]);

  const resolveActionState = (action: BulkActionDefinition) => {
    const actionType = action.execution?.type ?? "navigate";
    const constraints = resolveSelectionConstraints(action.selection);
    const href = resolveActionHref(action, selectedIds);
    const rpcName = resolveRpcName(action);
    const canNavigate =
      actionType === "navigate" ||
      ((actionType === "workflow" || actionType === "print") && !rpcName);
    const selectionReason = resolveSelectionDisabledReason(
      t,
      selectedCount,
      constraints
    );
    const executionDisabledReason =
      actionType === "download"
        ? null
        : actionType === "rpc" && !rpcName
          ? t("disabled.noRpc")
          : (actionType === "workflow" || actionType === "print") &&
              !rpcName &&
              !href
            ? t("disabled.noRpc")
            : canNavigate && !href
              ? t("disabled.noHref")
              : null;
    const disabledReason =
      action.disabledReason || executionDisabledReason || selectionReason;
    const disabled = !clientReady || Boolean(disabledReason) || pendingKey === action.key;
    return { actionType, disabledReason, disabled };
  };

  return (
    <>
      <TooltipProvider>
        <div className="space-y-2">
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid={resolvedTestIdPrefix}
          >
            {undoState && undoState.selectionSignature === selectionSignature ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  reportBulkEvent("ui.bulk_action.undo.execute", undoState.action);
                  void runAction(undoState.action);
                }}
                aria-label={undoState.label}
              >
                {undoState.label}
              </Button>
            ) : null}
            {inlineActions.map((action) => {
              const actionType = resolveActionType(action);
              if (actionType === "download" && action.download) {
                return (
                  <ResourceDownloadAction
                    key={action.key}
                    resourceKey={action.download.resourceKey}
                    downloadBasePath={action.download.downloadBasePath}
                    selectedIds={selectedIds}
                    maxBatch={action.download.maxBatch}
                    disabled={!clientReady}
                    disabledReason={action.disabledReason}
                    testIdPrefix={resolvedTestIdPrefix}
                    actionKey={action.key}
                    telemetry={telemetry ?? null}
                  />
                );
              }
              const { disabled, disabledReason } = resolveActionState(action);
              const description =
                disabledReason || action.description || undefined;
              const isPrimary = actionType === "print";
              const handleClick = () => {
                if (disabled) return;
                if (requiresExplicitConfirmation(action)) {
                  openConfirmDialog(action);
                  return;
                }
                void runAction(action);
              };
              const button = (
                <Button
                  key={action.key}
                  type="button"
                  variant={isPrimary ? "solid" : "ghost"}
                  size="sm"
                  disabled={disabled}
                  onClick={handleClick}
                  title={description}
                  data-action-key={action.key}
                  data-testid={
                    resolvedTestIdPrefix
                      ? `${resolvedTestIdPrefix}-action-${action.key}`
                      : undefined
                  }
                >
                  {action.label}
                </Button>
              );
              if (!description) return button;
              return (
                <Tooltip key={`${action.key}-tooltip`}>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">{button}</span>
                  </TooltipTrigger>
                  <TooltipContent>{description}</TooltipContent>
                </Tooltip>
              );
            })}
            {overflowActions.length > 0 ? (
              <Dropdown>
                <DropdownTrigger asChild>
                  <Button
                    type="button"
                    disabled={!clientReady}
                    variant="ghost"
                    size="sm"
                    aria-label={t("actionsMenuAria")}
                    data-testid={
                      resolvedTestIdPrefix
                        ? `${resolvedTestIdPrefix}-menu`
                        : undefined
                    }
                  >
                    {t("actionsMenu")}
                  </Button>
                </DropdownTrigger>
                <DropdownContent align="start" className="z-[60]">
                  {groupedOverflow.map((group, index) => (
                    <div key={group.key}>
                      {groupedOverflow.length > 1 ? (
                        <DropdownLabel>{group.label}</DropdownLabel>
                      ) : null}
                      {group.actions.map((action) => {
                        const { disabled, disabledReason } =
                          resolveActionState(action);
                        const description =
                          disabledReason || action.description || undefined;
                        const handleSelect = () => {
                          if (disabled) return;
                          if (requiresExplicitConfirmation(action)) {
                            openConfirmDialog(action);
                            return;
                          }
                          void runAction(action);
                        };
                        return (
                          <DropdownItem
                            key={action.key}
                            disabled={disabled}
                            onSelect={handleSelect}
                            title={description}
                            className="data-[disabled]:opacity-60 data-[disabled]:pointer-events-none"
                            data-action-key={action.key}
                            data-testid={
                              resolvedTestIdPrefix
                                ? `${resolvedTestIdPrefix}-menu-action-${action.key}`
                                : undefined
                            }
                          >
                            <div className="flex flex-col text-left">
                              <span>{action.label}</span>
                              {description ? (
                                <span className="text-xs text-ui-muted">
                                  {description}
                                </span>
                              ) : null}
                            </div>
                          </DropdownItem>
                        );
                      })}
                      {index < groupedOverflow.length - 1 ? (
                        <DropdownSeparator />
                      ) : null}
                    </div>
                  ))}
                </DropdownContent>
              </Dropdown>
            ) : null}
          </div>
          {printProgress ? (
            <PrintProgressWidget
              testId={printProgressTestId}
              status={printProgress.status}
              workflowRunId={printProgress.workflowRunId}
              selectionCount={printProgress.selectionCount}
              elapsedMs={
                printProgress.elapsedMs ?? Date.now() - printProgress.startedAtMs
              }
              targetDownloadMs={printProgress.targetDownloadMs}
              targetMiss={printProgress.targetMiss}
              minimized={printProgress.minimized}
              technicalDetailsOpen={printProgress.technicalDetailsOpen}
              runOutputsHref={printProgress.runOutputsHref}
              statusSnapshot={printProgress.statusSnapshot}
              readbackStopped={printProgressIsTerminal}
              onExpand={handlePrintProgressExpand}
              onHide={handlePrintProgressHide}
              onDismiss={handlePrintProgressDismiss}
              onRetry={printProgressIsTerminal ? handlePrintProgressRetry : null}
              onToggleTechnicalDetails={handlePrintProgressToggleDetails}
              onOpenRun={
                printProgress.runOutputsHref ? handlePrintProgressOpenRun : null
              }
            />
          ) : null}
          {actionFeedback && actionFeedback.phase !== "pending" ? (
            <div role="status" aria-live="polite"
              data-action-key={actionFeedback.actionKey}
              data-phase={actionFeedback.phase}
              data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-feedback` : undefined}
              className="space-y-1 text-sm">
              <p>{actionFeedback.actionLabel}: {actionFeedback.detail}</p>
              <p>{t("feedback.selectedIds", { ids: actionFeedback.selectedIds.join(", ") })}</p>
              {actionFeedback.resultStatus ? <p>{t("feedback.resultStatus", { status: actionFeedback.resultStatus })}</p> : null}
              {actionFeedback.workflowRunId ? <p>{t("feedback.workflowRunId", { id: actionFeedback.workflowRunId })}</p> : null}
              {actionFeedback.correlationId ? <p>{t("feedback.correlationId", { id: actionFeedback.correlationId })}</p> : null}
            </div>
          ) : null}
          {renderBatchResultReadback && batchResultReadback ? (
            <BulkActionResultReadback
              result={batchResultReadback}
              testId={
                resolvedTestIdPrefix
                  ? `${resolvedTestIdPrefix}-result`
                  : "bulk-action-result"
              }
            />
          ) : null}
        </div>
      </TooltipProvider>
      {confirmAction ? (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            if (!open && confirmAction) {
              reportBulkEvent("ui.bulk_action.confirm.cancel", confirmAction);
              setConfirmAction(null);
              setConfirmingActionKey(null);
              setConfirmInputValues({});
              setConfirmInputErrors({});
            }
          }}
          onConfirm={() => {
            if (!confirmAction || confirmingActionKey) {
              return;
            }
            const action = confirmAction;
            const nextErrors = validateActionInputValues(
              confirmInputFields,
              confirmInputValues
            );
            setConfirmInputErrors(nextErrors);
            if (Object.keys(nextErrors).length > 0) {
              return;
            }
            setConfirmingActionKey(action.key);
            reportBulkEvent("ui.bulk_action.confirm.submit", action);
            void runAction(action, confirmInputValues)
              .catch(() => {
                // runAction owns error handling and user feedback.
              })
              .finally(() => {
                setConfirmingActionKey((pendingKey) =>
                  pendingKey === action.key ? null : pendingKey
                );
                setConfirmAction((openAction) =>
                  openAction?.key === action.key ? null : openAction
                );
                setConfirmInputValues({});
                setConfirmInputErrors({});
              });
          }}
          title={confirmTitle}
          description={confirmDescription}
          confirmLabel={confirmConfig?.confirm_label ?? undefined}
          cancelLabel={confirmConfig?.cancel_label ?? undefined}
          tone={confirmConfig?.tone ?? "default"}
          testIdPrefix={resolvedTestIdPrefix}
          actionKey={confirmAction.key}
          isPending={confirmAction?.key === confirmingActionKey}
          autoCloseOnConfirm={false}
        >
          {actionFeedback?.phase === "pending" && actionFeedback.actionKey === confirmAction.key ? (
            <p role="status" aria-live="polite"
              data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-confirm-status` : undefined}>
              {actionFeedback.detail}
            </p>
          ) : null}
          {confirmLookupState.error ? (
            <p className="text-xs text-ui-danger" role="alert">
              {confirmLookupState.error}
            </p>
          ) : null}
          {confirmInputFields.map((field) => {
            const key = field.key.trim();
            const value = confirmInputValues[key] ?? "";
            const error = confirmInputErrors[key];
            const lookupCategory = field.lookup_category?.trim() ?? "";
            const isLookupField = field.type === "lookup" && lookupCategory.length > 0;
            const lookupOptions = isLookupField
              ? resolveLookupOptionsForValue(
                  confirmLookupState.optionsByCategory[lookupCategory] ?? [],
                  value
                )
              : [];
            const lookupDisabled =
              isLookupField && (confirmLookupState.loading || Boolean(confirmLookupState.error));
            const handleFieldChange = (
              event:
                | React.ChangeEvent<HTMLInputElement>
                | React.ChangeEvent<HTMLTextAreaElement>
                | React.ChangeEvent<HTMLSelectElement>
            ) => {
              const nextValue = event.target.value;
              setConfirmInputValues((current) => ({
                ...current,
                [key]: nextValue,
              }));
              setConfirmInputErrors((current) => {
                if (!current[key]) return current;
                const next = { ...current };
                delete next[key];
                return next;
              });
            };
            const sharedProps = {
              id: `${resolvedTestIdPrefix ?? "bulk-actions"}-confirm-field-${key}`,
              "aria-invalid": Boolean(error),
              value,
              onChange: handleFieldChange,
              "data-testid": resolvedTestIdPrefix
                ? `${resolvedTestIdPrefix}-confirm-field-${key}`
                : undefined,
            };

            return (
              <div key={key} className="space-y-1.5">
                <label
                  htmlFor={sharedProps.id}
                  className="text-sm font-medium text-ui-ink"
                >
                  {field.label}
                </label>
                {field.type === "textarea" ? (
                  <Textarea
                    {...sharedProps}
                    placeholder={field.placeholder ?? undefined}
                    rows={4}
                  />
                ) : isLookupField ? (
                  <Select
                    id={sharedProps.id}
                    aria-invalid={sharedProps["aria-invalid"]}
                    value={sharedProps.value}
                    onChange={handleFieldChange}
                    disabled={lookupDisabled}
                    aria-busy={confirmLookupState.loading || undefined}
                    data-testid={sharedProps["data-testid"]}
                  >
                    <option value="">{field.placeholder ?? "Select an option"}</option>
                    {lookupOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    {...sharedProps}
                    placeholder={field.placeholder ?? undefined}
                    type="text"
                  />
                )}
                {isLookupField && confirmLookupState.loading ? (
                  <p className="text-xs text-ui-muted">Loading lookup options...</p>
                ) : null}
                {error ? (
                  <p className="text-xs text-ui-danger" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </ConfirmDialog>
      ) : null}
    </>
  );
}
