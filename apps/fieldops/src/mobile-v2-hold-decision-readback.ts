import type { MobileV2HoldItem } from "./mobile-v2-hold-queue-screen";

export type MobileV2HoldDecisionAction = "reinduct" | "escalate" | "discard";

export interface MobileV2HoldDecisionReadback {
  readonly holdId: string;
  readonly action: MobileV2HoldDecisionAction;
  readonly status: "resolved" | "escalated" | "discarded";
  readonly decisionLogId: string;
  readonly resolvedAt: string | null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function expectedStatusForAction(
  action: MobileV2HoldDecisionAction,
): MobileV2HoldDecisionReadback["status"] {
  if (action === "reinduct") return "resolved";
  if (action === "escalate") return "escalated";
  return "discarded";
}

export function readMobileV2HoldDecisionReadback(
  writeEnvelope: Record<string, unknown>,
  action: MobileV2HoldDecisionAction,
  refetchedItems: ReadonlyArray<MobileV2HoldItem>,
): MobileV2HoldDecisionReadback | null {
  const holdId = asText(writeEnvelope.hold_id);
  const decisionLogId = asText(writeEnvelope.decision_log_id);
  if (holdId === null || decisionLogId === null) return null;
  if (refetchedItems.some((item) => item.id === holdId)) return null;

  const expectedStatus = expectedStatusForAction(action);
  const status = asText(writeEnvelope.hold_status);
  if (status !== expectedStatus) return null;

  return {
    holdId,
    action,
    status: expectedStatus,
    decisionLogId,
    resolvedAt: asText(writeEnvelope.resolved_at),
  };
}

export function shortMobileV2HoldDecisionId(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 8 ? trimmed : trimmed.slice(0, 8);
}
