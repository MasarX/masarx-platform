import type { OutboxEntry, OutboxSyncResult } from "@masarx/mobile-core";

import { redactDisplayErrorText } from "./mobile-display-error";

export type ActionSubmissionStatus =
  | "synced"
  | "queued_offline"
  | "queued_pending_sync"
  | "retryable_failure";

type QueueEntrySummary = Pick<OutboxEntry, "status" | "last_error"> | null | undefined;

function normalizeQueueErrorDetail(value: string | null | undefined) {
  const firstLine = redactDisplayErrorText(value ?? undefined, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) return null;

  const compact = firstLine.replace(/\s+/gu, " ").trim();
  if (!compact) return null;
  if (compact.length <= 180) return compact;
  return `${compact.slice(0, 177).trimEnd()}...`;
}

export function getOutboxSyncFailureMessage(result: OutboxSyncResult) {
  if (result.dead > 0 && result.failed > 0) {
    return `Outbox sync left ${result.failed} retryable and ${result.dead} terminal failures.`;
  }
  if (result.dead > 0) {
    return `Outbox sync left ${result.dead} terminal failure${result.dead === 1 ? "" : "s"}.`;
  }
  if (result.failed > 0) {
    return `Outbox sync left ${result.failed} retryable failure${result.failed === 1 ? "" : "s"}.`;
  }
  if (result.attempted > 0 && result.succeeded < result.attempted) {
    return `Outbox sync completed only ${result.succeeded} of ${result.attempted} attempted entries.`;
  }
  return null;
}

export function resolveActionSubmissionStatus(input: {
  effectiveOnline: boolean;
  queueEntry?: QueueEntrySummary;
  syncResult?: OutboxSyncResult | null;
}): ActionSubmissionStatus {
  if (!input.effectiveOnline) return "queued_offline";

  if (input.queueEntry?.status === "failed" || input.queueEntry?.status === "dead") {
    return "retryable_failure";
  }

  if (input.syncResult) {
    if (getOutboxSyncFailureMessage(input.syncResult)) {
      return "retryable_failure";
    }
    if (input.syncResult.succeeded > 0) {
      return "synced";
    }
  }

  return "queued_pending_sync";
}

export function describeActionReceiptStatus(input: {
  status: ActionSubmissionStatus;
  queueEntry?: QueueEntrySummary;
}) {
  if (input.status === "synced") return "Synced successfully.";
  if (input.status === "queued_offline") {
    return "Queued offline and will retry when connectivity returns.";
  }
  if (input.status === "queued_pending_sync") return "Queued and pending sync.";

  const queueError = normalizeQueueErrorDetail(input.queueEntry?.last_error);
  if (input.queueEntry?.status === "dead") {
    return queueError
      ? `Sync failed and needs review. ${queueError}`
      : "Sync failed and needs review. Review Outbox for details.";
  }

  return queueError
    ? `Queued, but sync could not complete. ${queueError}`
    : "Queued, but sync could not complete. Review Outbox for retry state.";
}
