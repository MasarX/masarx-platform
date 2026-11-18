"use client";

import * as React from "react";
import type { UiCommandExecution } from "@masarx/api";
import { createUiTranslator } from "./i18n";

type BatchResultOutcome = "success" | "failed" | "already_processed" | "queued";

export type BatchResultItem = {
  id: string;
  statusCode: string;
  outcome: BatchResultOutcome;
  errorCode: string | null;
  workflowReferenceReturned?: boolean;
};

export type BatchResultReadback = {
  actionKey: string;
  actionLabel: string;
  status: string;
  total: number;
  success: number;
  failure: number;
  alreadyProcessed: number;
  queued: number;
  items: BatchResultItem[];
  malformedReason: string | null;
  selectionReadback?: Array<{ id: string; status: string }>;
};

type BatchResultParseInput = {
  actionKey: string;
  actionLabel: string;
  selectedIds: string[];
  result: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const readCount = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
};

const readItemId = (item: Record<string, unknown>) => {
  for (const key of ["selection_id", "resource_id", "id"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const normalizeServerCode = (value: unknown) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized && normalized.length <= 80 && /^[a-z0-9_.-]+$/.test(normalized)
    ? normalized
    : null;
};

const readItemErrorCode = (value: unknown) => {
  if (typeof value === "string") return normalizeServerCode(value);
  return isRecord(value) ? normalizeServerCode(value.code) : null;
};

const AGGREGATE_STATUSES = new Set([
  "completed",
  "cancelled",
  "rescheduled",
  "partial",
  "failed",
  "already_processed",
  "queued"
]);

const SUCCESS_ITEM_STATUSES = new Set([
  "completed",
  "cancelled",
  "rescheduled"
]);

const malformedReadback = (input: BatchResultParseInput, reason: string): BatchResultReadback => ({
  actionKey: input.actionKey,
  actionLabel: input.actionLabel,
  status: "malformed",
  total: input.selectedIds.length,
  success: 0,
  failure: input.selectedIds.length,
  alreadyProcessed: 0,
  queued: 0,
  items: input.selectedIds.map((id) => ({
    id,
    statusCode: "unverified",
    outcome: "failed",
    errorCode: null
  })),
  malformedReason: reason
});

export const requiresBatchResultEvidence = (execution?: UiCommandExecution | null) =>
  execution?.result_contract === "batch_items_v1";

export function parseBatchResultReadback(input: BatchResultParseInput): BatchResultReadback {
  if (!isRecord(input.result)) {
    return malformedReadback(input, "result_not_object");
  }

  const status = typeof input.result.status === "string" ? input.result.status.trim() : "";
  const total = readCount(input.result, "count");
  const success = readCount(input.result, "success_count");
  const failure = readCount(input.result, "failure_count");
  const alreadyProcessed = readCount(input.result, "already_processed_count");
  const queued = Object.prototype.hasOwnProperty.call(input.result, "queued_count")
    ? readCount(input.result, "queued_count")
    : 0;
  const rawItems = input.result.items;

  if (
    !status ||
    !AGGREGATE_STATUSES.has(status) ||
    total === null ||
    success === null ||
    failure === null ||
    alreadyProcessed === null ||
    queued === null ||
    !Array.isArray(rawItems)
  ) {
    return malformedReadback(input, "missing_summary_evidence");
  }
  if (total !== input.selectedIds.length || rawItems.length !== total) {
    return malformedReadback(input, "selection_count_mismatch");
  }
  if (success + failure + alreadyProcessed + queued !== total) {
    return malformedReadback(input, "summary_count_mismatch");
  }

  const selectedIdSet = new Set(input.selectedIds);
  const seenIds = new Set<string>();
  const items: BatchResultItem[] = [];

  for (const rawItem of rawItems) {
    if (!isRecord(rawItem)) {
      return malformedReadback(input, "item_not_object");
    }
    const id = readItemId(rawItem);
    const itemStatus = normalizeServerCode(rawItem.status);
    if (!id || !itemStatus || !selectedIdSet.has(id) || seenIds.has(id)) {
      return malformedReadback(input, "item_identity_mismatch");
    }
    seenIds.add(id);

    const errorCode = readItemErrorCode(rawItem.error);
    const already = rawItem.already_processed === true;
    const ok = rawItem.ok === true;
    const explicitlyFailed = rawItem.ok === false;
    let outcome: BatchResultOutcome;
    if (already) {
      if (explicitlyFailed || errorCode || itemStatus !== "already_processed") {
        return malformedReadback(input, "item_outcome_contradiction");
      }
      outcome = "already_processed";
    } else if (itemStatus === "queued") {
      if (!ok || errorCode || typeof rawItem.workflow_run_id !== "string" ||
        !rawItem.workflow_run_id.trim() ||
        !["pending", "in_progress", "running", "waiting"].includes(String(rawItem.workflow_status))) {
        return malformedReadback(input, "item_outcome_contradiction");
      }
      outcome = "queued";
    } else if (ok) {
      if (errorCode || !SUCCESS_ITEM_STATUSES.has(itemStatus) ||
        (rawItem.workflow_status !== undefined && rawItem.workflow_status !== "completed")) {
        return malformedReadback(input, "item_outcome_contradiction");
      }
      outcome = "success";
    } else {
      if (!errorCode) {
        return malformedReadback(input, "item_outcome_contradiction");
      }
      outcome = "failed";
    }
    items.push({ id, statusCode: itemStatus, outcome, errorCode,
      ...(typeof rawItem.workflow_run_id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawItem.workflow_run_id)
        ? { workflowReferenceReturned: true } : {}),
    });
  }

  const itemSuccess = items.filter((item) => item.outcome === "success").length;
  const itemFailure = items.filter((item) => item.outcome === "failed").length;
  const itemAlready = items.filter((item) => item.outcome === "already_processed").length;
  const itemQueued = items.filter((item) => item.outcome === "queued").length;
  if (itemSuccess !== success || itemFailure !== failure || itemAlready !== alreadyProcessed || itemQueued !== queued) {
    return malformedReadback(input, "item_summary_mismatch");
  }

  const expectedStatus =
    failure > 0 && success + alreadyProcessed + queued > 0
      ? "partial"
      : failure > 0
        ? "failed"
        : queued > 0
          ? "queued"
          : success === 0 && alreadyProcessed > 0
            ? "already_processed"
            : null;
  if (
    (expectedStatus && status !== expectedStatus) ||
    (!expectedStatus && !["completed", "cancelled", "rescheduled"].includes(status))
  ) {
    return malformedReadback(input, "status_summary_mismatch");
  }

  return {
    actionKey: input.actionKey,
    actionLabel: input.actionLabel,
    status,
    total,
    success,
    failure,
    alreadyProcessed,
    queued,
    items,
    malformedReason: null
  };
}

export function attachSelectionReadback(batch: BatchResultReadback, value: unknown): BatchResultReadback {
  if (!isRecord(value) || value.visible !== true || value.count !== batch.total ||
      !Array.isArray(value.items) || value.items.length !== batch.total) {
    throw new Error("Selected record readback is incomplete");
  }
  const expected = new Set(batch.items.map((item) => item.id));
  const seen = new Set<string>();
  const selectionReadback = value.items.map((item: unknown) => {
    if (!isRecord(item) || typeof item.selection_id !== "string" ||
        !expected.has(item.selection_id) || seen.has(item.selection_id)) {
      throw new Error("Selected record readback identities do not match");
    }
    const status = normalizeServerCode(item.status);
    if (!status) throw new Error("Selected record readback status is missing");
    seen.add(item.selection_id);
    return { id: item.selection_id, status };
  });
  return { ...batch, selectionReadback };
}

export function BulkActionResultReadback({
  result,
  testId
}: {
  result: BatchResultReadback;
  testId: string;
}) {
  const t = createUiTranslator("ui.resourceActions.resultReadback");
  const freshStatuses = new Map(result.selectionReadback?.map((item) => [item.id, item.status]));
  const isMalformed = Boolean(result.malformedReason);
  const hasFailures = result.failure > 0;
  const title = isMalformed
    ? t("status.malformed")
    : hasFailures && result.queued > 0
      ? t("status.partialQueued")
    : hasFailures && result.success + result.alreadyProcessed > 0
      ? t("status.partial")
      : hasFailures
        ? t("status.failed")
        : result.queued > 0
          ? t("status.queued")
          : result.success === 0 && result.alreadyProcessed > 0
            ? t("status.alreadyProcessed")
            : t("status.completed");
  const itemOutcomeLabel = (outcome: BatchResultOutcome) =>
    outcome === "success"
      ? t("itemStatus.success")
      : outcome === "queued"
        ? t("itemStatus.queued")
        : outcome === "already_processed"
          ? t("itemStatus.alreadyProcessed")
          : t("itemStatus.failed");
  const itemErrorLabel = (errorCode: string | null) => {
    if (errorCode === "shipment_not_visible") {
      return t("error.shipmentNotVisible");
    }
    if (errorCode === "shipment_batch_operation_failed") {
      return t("error.operationFailed");
    }
    return t("error.generic");
  };

  return (
    <section
      aria-live="polite"
      aria-label={t("ariaLabel", { action: result.actionLabel })}
      className={`rounded-lg border p-3 text-sm ${
        hasFailures ? "border-ui-danger/30 bg-ui-danger/5" : "border-ui-border bg-ui-surface"
      }`}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={hasFailures ? "font-medium text-ui-danger" : "font-medium text-ui-ink"}>
          {result.actionLabel}: {title}
        </p>
        <p className="text-xs text-ui-muted" data-testid={`${testId}-summary`}>
          {t(result.queued > 0 ? "summaryWithQueued" : "summary", {
            total: result.total,
            success: result.success,
            failure: result.failure,
            already: result.alreadyProcessed,
            queued: result.queued
          })}
        </p>
      </div>
      {isMalformed ? (
        <p className="mt-2 text-xs text-ui-danger" role="alert">
          {t("malformedDetail")}
        </p>
      ) : null}
      <ul className="mt-2 space-y-1" data-testid={`${testId}-items`}>
        {result.items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center gap-x-2 text-xs"
            data-outcome={item.outcome}
            data-testid={`${testId}-item-${item.id}`}
          >
            <span className="font-mono text-ui-ink">{item.id}</span>
            <span className={item.outcome === "failed" ? "text-ui-danger" : "text-ui-muted"}>
              {itemOutcomeLabel(item.outcome)}
            </span>
            {freshStatuses.has(item.id) ? (
              <span data-testid={`${testId}-fresh-${item.id}`}>
                {t("freshStatus", { status: freshStatuses.get(item.id)! })}
              </span>
            ) : null}
            {item.workflowReferenceReturned ? <span>{t("workflowReferenceReturned")}</span> : null}
            {item.outcome === "failed" ? (
              <span className="text-ui-danger">{itemErrorLabel(item.errorCode)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
