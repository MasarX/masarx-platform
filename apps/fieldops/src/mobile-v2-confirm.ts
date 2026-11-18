// Mobile V2 platform-aware confirm dialog. Separate file from
// mobile-v2-ops-helpers because it imports react-native (Alert,
// Platform); the ops-helpers module is unit-tested directly and
// must stay react-native-free for the jest unit runner.

import { Alert, Platform } from "react-native";

/**
 * Platform-aware confirmation dialog. AGENTS.md mandates a confirm
 * step before destructive actions (Destroy parcel, Sign out, etc.).
 * On native we use Alert.alert which renders a real native dialog;
 * on react-native-web Alert.alert is a console-only no-op, so we
 * fall through to `window.confirm` for the web preview surface.
 *
 * 2nd-pass audit P1 fix: previous direct Alert.alert calls silently
 * bypassed the confirmation on the web preview that the
 * screenshot-iteration policy uses.
 */
export interface MobileV2ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly cancelLabel?: string;
  readonly confirmLabel?: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
}

export function confirmMobileV2Action(opts: MobileV2ConfirmOptions): void {
  const cancelLabel = opts.cancelLabel ?? "Cancel";
  const confirmLabel = opts.confirmLabel ?? "Confirm";
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      const ok = window.confirm(`${opts.title}\n\n${opts.message}`);
      if (ok) opts.onConfirm();
      else opts.onCancel?.();
      return;
    }
    // No window.confirm (SSR / unusual env) — fail-safe: run cancel,
    // surface the prompt via Alert.alert (it'll console.warn) so the
    // user has telemetry that the confirmation flow didn't render.
    Alert.alert(opts.title, opts.message);
    opts.onCancel?.();
    return;
  }
  Alert.alert(opts.title, opts.message, [
    { text: cancelLabel, style: "cancel", onPress: opts.onCancel },
    {
      text: confirmLabel,
      style: opts.destructive === true ? "destructive" : "default",
      onPress: opts.onConfirm,
    },
  ]);
}
