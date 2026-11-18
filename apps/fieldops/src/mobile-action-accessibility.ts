import type { FieldOpsStrings } from "./i18n";

export function mobileActionAccessibility(hint: string | undefined, disabled: boolean, busy = false) {
  return {
    accessibilityRole: "button" as const,
    "aria-busy": busy,
    accessibilityHint: disabled ? hint : undefined,
    accessibilityState: { disabled, busy },
  };
}

export function mobileSyncAccessibility(
  copy: FieldOpsStrings["actionAccessibility"],
  syncing: boolean,
  online: boolean,
  policyEnabled: boolean,
  pending: number,
) {
  const count = Number.isFinite(pending) ? Math.max(0, Math.floor(pending)) : 0;
  const hint = syncing ? copy.syncBusy : !policyEnabled ? copy.syncPolicy : !online ? copy.syncOffline : copy.syncReady;
  return {
    ...mobileActionAccessibility(hint, syncing || !online || !policyEnabled, syncing),
    accessibilityHint: `${copy.pending(count)} ${hint}`,
  };
}
