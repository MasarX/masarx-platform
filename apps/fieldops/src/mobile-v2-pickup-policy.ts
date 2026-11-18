// Mobile V2 pickup policy helpers. The production reason taxonomy comes from
// pickup_policy.failure.*_reasons through resolve_settings_row_from_policy_context_v1.

export interface MobileV2PickupFailureReason {
  readonly key: string;
  readonly label: string;
  readonly className: "reschedule" | "escalation";
}

export const MOBILE_V2_PICKUP_DEFAULT_FAILURE_REASONS: ReadonlyArray<MobileV2PickupFailureReason> = Object.freeze([
  Object.freeze({ key: "sender_unavailable", label: "Sender unavailable", className: "reschedule" as const }),
  Object.freeze({ key: "pickup_not_ready", label: "Pickup not ready", className: "reschedule" as const }),
  Object.freeze({ key: "access_restricted", label: "Access restricted", className: "escalation" as const }),
  Object.freeze({ key: "quantity_mismatch", label: "Quantity mismatch", className: "escalation" as const }),
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function labelizeReasonCode(code: string): string {
  return code
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function collectReasonCodes(
  value: unknown,
  className: MobileV2PickupFailureReason["className"],
  seen: Set<string>,
  out: MobileV2PickupFailureReason[],
): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const code = entry.trim();
    if (code.length === 0 || seen.has(code)) continue;
    seen.add(code);
    out.push(Object.freeze({ key: code, label: labelizeReasonCode(code), className }));
  }
}

export function parseMobileV2PickupFailureReasons(
  value: unknown,
): ReadonlyArray<MobileV2PickupFailureReason> {
  const root = asRecord(value);
  const failure = root === null ? null : asRecord(root.failure);
  if (failure === null) return MOBILE_V2_PICKUP_DEFAULT_FAILURE_REASONS;
  const seen = new Set<string>();
  const out: MobileV2PickupFailureReason[] = [];
  collectReasonCodes(failure.reschedule_reasons, "reschedule", seen, out);
  collectReasonCodes(failure.escalation_reasons, "escalation", seen, out);
  return out.length > 0 ? Object.freeze(out) : MOBILE_V2_PICKUP_DEFAULT_FAILURE_REASONS;
}

export function selectMobileV2PickupFailureReason(
  reasons: ReadonlyArray<MobileV2PickupFailureReason>,
  preferred = "pickup_not_ready",
): string {
  return reasons.find((reason) => reason.key === preferred)?.key ?? reasons[0]?.key ?? preferred;
}

export function getMobileV2PickupFailureReasonLabel(
  key: string,
  reasons: ReadonlyArray<MobileV2PickupFailureReason>,
): string {
  return reasons.find((reason) => reason.key === key)?.label ?? labelizeReasonCode(key);
}
