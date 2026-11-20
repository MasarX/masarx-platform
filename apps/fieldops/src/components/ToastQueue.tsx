import * as React from "react";
import { StyleSheet, View } from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

import { Toast } from "./Toast";
import {
  TOAST_DEFAULT_DURATION_MS,
  type ToastEnqueueOptions,
  type ToastQueueEntry,
} from "./Toast.types";

/**
 * Shape of the value exposed by `ToastContext`. The enqueue function is
 * the only public surface; other state lives inside the provider so the
 * implementation can evolve (priority queues, dismiss-by-id, etc.) without
 * breaking consumers.
 *
 * `dismissActive` is exposed separately so test harnesses + future power-
 * user callers can advance the queue without waiting for the auto-dismiss
 * timer. The bare `Toast` already calls `onDismiss` on its own, so screens
 * generally do not need to call this directly.
 */
export type ToastContextValue = {
  /** Enqueue a toast for display. Returns the queued entry id. */
  enqueue: (message: string, options?: ToastEnqueueOptions) => string;
  /** Dismiss the currently visible toast (advances the queue). */
  dismissActive: () => void;
};

/**
 * Context is initialised to `null` so `useToast()` throws a clear error
 * when consumed outside the provider. Mirrors the `useTheme()` invariant
 * to keep the error story consistent across context-backed primitives.
 */
export const ToastContext: React.Context<ToastContextValue | null> =
  React.createContext<ToastContextValue | null>(null);
ToastContext.displayName = "FieldOpsToastContext";

export type ToastProviderProps = {
  children: React.ReactNode;
  /**
   * Override the default `toast-queue-overlay` testID for the bottom-
   * anchored overlay container. Suffixed for nested toasts when callers
   * need to target a specific overlay instance (multi-screen tests).
   */
  testID?: string;
};

/**
 * Default overlay testID. Exported so tests can import it instead of
 * hardcoding the string in multiple places.
 */
export const TOAST_QUEUE_OVERLAY_TESTID = "toast-queue-overlay";

/**
 * Monotonically increasing entry id seed. We use a closure-scoped counter
 * (not a UUID) so test snapshots stay deterministic and React keys are
 * collision-free across rapid enqueue calls in the same tick. Resets on
 * module reload (test hygiene); production-side it just counts up.
 */
let entryIdSeed = 0;

function nextEntryId(): string {
  entryIdSeed += 1;
  return `toast-${entryIdSeed}`;
}

/**
 * Internal helper: build a queue entry from the public enqueue arguments.
 * Centralised so future option additions land in one spot and the test
 * suite has a single shape to assert against.
 */
function buildEntry(
  message: string,
  options: ToastEnqueueOptions | undefined,
): ToastQueueEntry {
  return {
    id: nextEntryId(),
    message,
    tone: options?.tone ?? "info",
    durationMs:
      typeof options?.durationMs === "number"
        ? options.durationMs
        : TOAST_DEFAULT_DURATION_MS,
    action: options?.action,
    testID: options?.testID,
    accessibilityLabel: options?.accessibilityLabel,
  };
}

/**
 * `ToastProvider` — wraps the app root.
 *
 * Behavior:
 *   - Holds an internal FIFO queue of `ToastQueueEntry` items.
 *   - Renders the head-of-queue entry through a single `<Toast>` instance.
 *   - When the visible toast dismisses (timer expiry OR explicit
 *     `dismissActive()`), the head is shifted off and the next entry
 *     (if any) becomes visible.
 *   - The overlay container uses absolute positioning at the bottom of
 *     the parent so it floats above the rest of the shell without
 *     reflowing layout.
 */
export function ToastProvider(props: ToastProviderProps): React.JSX.Element {
  const { children, testID = TOAST_QUEUE_OVERLAY_TESTID } = props;
  const styles = useThemedStyles(buildOverlayStyles);

  // Queue state. We use a single `queue` array and read the head as the
  // active entry. Mutating via setQueue keeps React change detection
  // straightforward — no separate "active" slot to keep in sync.
  const [queue, setQueue] = React.useState<ToastQueueEntry[]>([]);

  /**
   * Enqueue a toast for display. Returns the queued entry id so callers
   * can correlate later (telemetry, manual dismiss, etc.).
   *
   * Wrapped in `useCallback` because the function is included in the
   * provider context value — without memoization every parent re-render
   * would invalidate every consumer's `useToast()` reference.
   */
  const enqueue = React.useCallback(
    (message: string, options?: ToastEnqueueOptions): string => {
      const entry = buildEntry(message, options);
      setQueue((prev) => [...prev, entry]);
      return entry.id;
    },
    [],
  );

  /**
   * Dismiss the currently visible toast. Advances the queue head.
   *
   * Memoised for the same reason as `enqueue` — it sits inside the
   * provider context value.
   */
  const dismissActive = React.useCallback((): void => {
    setQueue((prev) => (prev.length > 0 ? prev.slice(1) : prev));
  }, []);

  // Stable context value. Re-computed only when one of the bound
  // functions changes (in practice: never after first render).
  const contextValue = React.useMemo<ToastContextValue>(
    () => ({ enqueue, dismissActive }),
    [enqueue, dismissActive],
  );

  // Head-of-queue entry. Read once per render so JSX stays simple.
  const active = queue.length > 0 ? queue[0] : null;

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <View
        testID={testID}
        // Overlay container is purely visual chrome; do not announce it
        // to screen readers — the inner Toast carries the live region.
        accessibilityElementsHidden={active === null}
        importantForAccessibility={
          active === null ? "no-hide-descendants" : "yes"
        }
        pointerEvents="box-none"
        style={styles.overlay}
      >
        {active ? (
          <Toast
            // Provide a stable React key per entry so unmount/remount
            // cycles correctly tear down the auto-dismiss timer rather
            // than letting it carry over to the next entry.
            key={active.id}
            message={active.message}
            tone={active.tone}
            durationMs={active.durationMs}
            onDismiss={dismissActive}
            action={active.action}
            testID={active.testID}
            accessibilityLabel={active.accessibilityLabel}
          />
        ) : null}
      </View>
    </ToastContext.Provider>
  );
}

/**
 * Read the current toast context. Throws a clear error (with the expected
 * provider reference in the message) when used outside `<ToastProvider>`.
 *
 * Returns the full context value so callers can both `enqueue` and
 * `dismissActive` from a single import. The most common usage is:
 *
 *   const { enqueue } = useToast();
 *   enqueue("Order saved", { tone: "success" });
 */
export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (ctx === null) {
    throw new Error(
      "useToast() must be called inside a <ToastProvider> (Toast.tsx).",
    );
  }
  return ctx;
}

/**
 * Stylesheet factory for the overlay container. Anchors the active toast
 * to the bottom of the parent without reflowing the rest of the shell.
 *
 * `pointerEvents="box-none"` (set on the View itself, not in the style
 * sheet) ensures taps pass through to underlying content unless they hit
 * the toast card — important so a persistent toast does not block the
 * shell's tab bar.
 */
function buildOverlayStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    overlay: {
      position: "absolute",
      // Sit above the bottom tab bar with a comfortable gap. Spacing.lg
      // (16) clears the safe area on devices without a system bar.
      bottom: tokens.spacing.lg,
      left: tokens.spacing.lg,
      right: tokens.spacing.lg,
      // Defensive zIndex — RN-Web honors zIndex; native uses elevation
      // (set on the Toast card itself via buildToastStyles).
      zIndex: 1000,
    },
  });
}

export default ToastProvider;
