import type { UiCommandDefinition } from "@masarx/api";
import type { OutboxEntry, OutboxSyncResult } from "@masarx/mobile-core";
import { normalizeOutboxDisplay } from "@masarx/mobile-core";
import type { FieldOpsStrings } from "./i18n";

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function hasMobileCommandDisabledState(command: unknown): boolean {
  const value = record(command);
  return value.disabled === true || value.enabled === false || value.available === false ||
    value.disabled_reason != null || value.disabledReason != null;
}

export function assertMobileCommandSelection(command: UiCommandDefinition, selectedId: string | null): void {
  if (!text(command.key) || hasMobileCommandDisabledState(command)) throw new Error("Action is disabled by policy.");
  const transport = command.execution?.transport ?? "rpc";
  const target = text(transport === "edge" ? command.execution?.function : command.execution?.rpc);
  if (transport !== "rpc" && transport !== "edge") throw new Error("Unsupported action transport.");
  if (!(transport === "edge" ? /^[a-z][a-z0-9_-]*$/ : /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/).test(target)) throw new Error("Action target is invalid.");
  if (transport === "rpc" && command.execution?.type && !["rpc", "workflow"].includes(command.execution.type)) throw new Error("Action execution is not queueable.");
  const selection = command.selection;
  if (selection != null && (typeof selection !== "object" || Array.isArray(selection))) {
    throw new Error("Action selection policy is invalid.");
  }
  const mode = selection?.mode ?? null;
  const min = selection?.min_count ?? (mode === "none" || mode === "any" ? 0 : 1);
  const max = selection?.max_count ?? (mode === "single" ? 1 : undefined);
  if ((mode !== null && !["none", "single", "multi", "any"].includes(mode)) ||
      !Number.isSafeInteger(min) || min < 0 ||
      (max !== undefined && (!Number.isSafeInteger(max) || max < min))) {
    throw new Error("Action selection policy is invalid.");
  }
  if (selectedId !== null && !text(selectedId)) throw new Error("Action requires a valid selected target.");
  const count = selectedId === null ? 0 : 1;
  if (count < min || (max !== undefined && count > max)) throw new Error("Action requires a valid selected target.");
}

export function validateMobileComposerNumberValue(key: string, label: string, value: number): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a valid number.`);
  if (key === "confirmed_quantity" && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  if (key === "payment_amount" && value < 0) throw new Error(`${label} cannot be negative.`);
  return value;
}

export function isMobileOutboxSyncBatchSuccessful(result: OutboxSyncResult | null | undefined): boolean {
  if (!result) return false;
  const values = [result.attempted, result.succeeded, result.failed, result.dead];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) return false;
  return result.attempted > 0 && result.failed === 0 && result.dead === 0 && result.attempted === result.succeeded;
}

export type MobileActionReceipt = {
  actionKey: string;
  actionLabel?: string | null;
  targetLabel?: string | null;
  queueId: string;
  status: "synced" | "queued_offline" | "queued_pending_sync" | "retryable_failure";
  detail: string;
  recordedAt: string;
  resourceId: string | null;
};

export function describeMobileActionReceiptStatus(status: MobileActionReceipt["status"], strings: FieldOpsStrings): string {
  const copy = strings.actionFeedback;
  return status === "synced" ? copy.syncedReceipt : status === "queued_offline" ? copy.offlineReceipt :
    status === "queued_pending_sync" ? copy.pendingReceipt : copy.failedReceipt;
}

function tokenLabel(value: string): string {
  return value.replace(/[._:-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function formatMobileActionReceipt(receipt: MobileActionReceipt, strings: FieldOpsStrings): string {
  return [
    text(receipt.actionLabel) || tokenLabel(text(receipt.actionKey)) || strings.actionFeedback.queued,
    text(receipt.targetLabel),
    receipt.detail,
    receipt.resourceId ? strings.detail.reference(receipt.resourceId) : null,
    strings.actionFeedback.queueReference(receipt.queueId),
  ].filter(Boolean).join("\n");
}

export function describeMobileOutboxEntry(entry: OutboxEntry, strings: FieldOpsStrings) {
  const copy = strings.actionFeedback;
  const args = record(entry.args), params = record(args.p_params), payload = record(params.payload);
  const events = Array.isArray(args.p_events) ? args.p_events.flatMap(value => {
    const event = record(value); return [event, record(event.metadata)];
  }) : [];
  const rows = [args, params, payload, ...events];
  const pick = (keys: string[]) => {
    for (const row of rows) for (const key of keys) { const value = text(row[key]); if (value) return value; }
    return "";
  };
  const display = normalizeOutboxDisplay(entry.display);
  const title = display?.actionLabel || pick(["p_action_label", "action_label", "command_label"]) ||
    tokenLabel(pick(["event_type", "p_action_key"])) || copy.queued;
  const displayTarget = pick(["p_target_label", "target_label", "p_selection_label", "selection_label",
    "route_stop_label", "task_label", "shipment_label", "customer_label"]);
  const contextTarget = pick(["route_stop_id", "p_route_stop_id", "p_stop_id", "task_id", "p_task_id", "route_run_id",
      "p_route_run_id", "settlement_id", "p_settlement_id", "driver_shift_id", "p_driver_shift_id",
      "shipment_id", "p_shipment_id", "p_parcel_id", "p_pickup_id", "client_id", "resource_id",
      "organization_id", "device_id", "p_selection_id"]);
  const count = typeof args.p_selection_count === "number" && Number.isFinite(args.p_selection_count)
    ? Math.max(0, Math.floor(args.p_selection_count)) : 0;
  const targetLabel = display?.targetLabel || displayTarget || (count > 1 ? copy.selectedCount(count) : contextTarget || copy.noTarget);
  const error = text(entry.last_error).toLowerCase();
  const auth = /401|jwt|not authenticated|unauthenticated|unauthorized|session/.test(error);
  const permission = /42501|403|forbidden|permission denied|insufficient[_ ]privilege|rls/.test(error);
  const unavailable = /api\/auth|backend unavailable|backend_not_ready|connection refused|econnrefused|failed to fetch|network request failed|startup_pending|db.only|timed out/.test(error);
  const conflict = /409|23505|40001|conflict|stale state|state changed|state transition|already completed|already closed|already synced|not pending|not current/.test(error);
  let status = copy.unknown, detail = copy.unknownDetail;
  if (entry.status === "queued") { status = copy.queued; detail = copy.queuedDetail; }
  else if (entry.status === "in_flight") { status = copy.inFlight; detail = copy.inFlightDetail; }
  else if (entry.status === "succeeded") { status = copy.synced; detail = copy.syncedReceipt; }
  else if (entry.status === "failed" || entry.status === "dead") {
    if (auth) { status = copy.auth; detail = copy.authDetail; }
    else if (permission) { status = copy.permission; detail = copy.permissionDetail; }
    else if (conflict) { status = copy.conflict; detail = copy.conflictDetail; }
    else if (unavailable) { status = copy.unavailable; detail = copy.unavailableDetail; }
    else if (entry.status === "dead") { status = copy.dead; detail = copy.deadDetail; }
    else if (error.includes("recovered stale")) { status = copy.recovered; detail = copy.recoveredDetail; }
    else { status = copy.retry; detail = entry.next_attempt_at ? copy.retryAt(entry.next_attempt_at) : copy.retryDetail; }
  }
  if (entry.status === "dead") detail = copy.deadDetail;
  const attempts = Number.isSafeInteger(entry.attempt_count) && entry.attempt_count >= 0 ? entry.attempt_count : 0;
  const lines = [copy.queueReference(entry.id), copy.attempts(attempts),
    entry.updated_at ? copy.lastUpdate(entry.updated_at) : null].filter(Boolean) as string[];
  return { title, targetLabel, status, detail, lines,
    accessibilityLabel: [title, targetLabel, status, detail, ...lines].join(". ") };
}
