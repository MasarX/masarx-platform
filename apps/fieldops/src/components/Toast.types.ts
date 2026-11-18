/** Shared toast variants and actions are available without importing rendering dependencies. */

/**
 * Tonal surface for the toast. Each tone resolves to the matching `*Soft`
 * background + `*Fg` foreground pair from the active theme palette.
 *
 * Adding a new tone requires extending both `ToastTone` and the palette
 * builder inside `Toast.tsx` (the `Record<ToastTone, ToastPalette>`
 * constraint enforces exhaustive coverage).
 */
export type ToastTone = "info" | "success" | "warning" | "danger";

/**
 * Optional CTA payload for actionable toasts. The action renders as a text
 * button on the trailing edge of the toast card; tapping it does NOT auto-
 * dismiss the toast (the caller's `onPress` is responsible for invoking
 * `onDismiss` if dismiss-on-tap semantics are desired).
 */
export type ToastAction = {
  /** Visible button text. Keep short — the action sits inside the toast row. */
  label: string;
  /** Press handler. Caller decides whether to invoke `onDismiss` after. */
  onPress: () => void;
};

/**
 * Public prop surface for the `Toast` primitive.
 *
 * Notes for callers:
 *  - `message` is always required — even icon-only toasts carry semantic
 *    text for screen-reader announcement.
 *  - `tone` defaults to `info`. Use `success` for confirmations, `warning`
 *    for soft errors / retries, `danger` for hard failures.
 *  - `durationMs` defaults to 4000ms (matches Material 3 Snackbar default).
 *    Pass `0` to make the toast persistent (manual dismiss required).
 *  - `onDismiss` is invoked exactly once — either by the auto-dismiss timer
 *    firing or by an external dismissal path (e.g. `ToastQueue` rotation).
 *  - `action` is optional. When supplied the action button renders on the
 *    trailing edge with a foreground color matching the tone.
 *  - `testID` defaults to `toast`. Nested testIDs use the canonical suffixes
 *    `-icon`, `-message`, `-action` for stable selector ergonomics.
 */
export type ToastProps = {
  /** The body text announced + visually rendered. Required. */
  message: string;
  /** Tonal surface. Defaults to `info`. */
  tone?: ToastTone;
  /**
   * Auto-dismiss duration in milliseconds. Defaults to `4000` (4 seconds).
   * Pass `0` to disable auto-dismiss (toast stays visible until
   * `onDismiss` is called externally).
   */
  durationMs?: number;
  /** Dismiss callback — invoked by the timer or when the queue advances. */
  onDismiss: () => void;
  /** Optional CTA payload. When omitted no action button renders. */
  action?: ToastAction;
  /** Override the default `toast` testID. Suffixed for nested nodes. */
  testID?: string;
  /** Override the default a11y label (defaults to the visible `message`). */
  accessibilityLabel?: string;
};

/**
 * Options accepted by the `useToast()` enqueue function. Mirrors
 * `ToastProps` minus the props the queue manages internally (`onDismiss`,
 * `message`).
 *
 * Living next to `ToastProps` keeps the contract co-located so refactors
 * (adding `position`, `priority`, etc.) update both surfaces in one spot.
 */
export type ToastEnqueueOptions = {
  tone?: ToastTone;
  durationMs?: number;
  action?: ToastAction;
  testID?: string;
  accessibilityLabel?: string;
};

/**
 * Internal queue entry shape. Exported for tests + potential future
 * inspectors (Storybook controls, devtools panels). Each entry carries the
 * inputs the renderer needs plus a stable `id` so React keys are
 * deterministic across rotations.
 */
export type ToastQueueEntry = {
  id: string;
  message: string;
  tone: ToastTone;
  durationMs: number;
  action?: ToastAction;
  testID?: string;
  accessibilityLabel?: string;
};

/**
 * Ordered tuple of every supported `ToastTone`. Tests / lint rules use this
 * to enumerate the contract without re-deriving the union (TypeScript
 * unions do not exist at runtime).
 */
export const TOAST_TONES: ReadonlyArray<ToastTone> = [
  "info",
  "success",
  "warning",
  "danger",
];

/**
 * Default auto-dismiss duration (Material 3 Snackbar default). Exported as
 * a constant so consumer tests can assert against the documented value
 * without hardcoding 4000 in multiple places.
 */
export const TOAST_DEFAULT_DURATION_MS = 4000 as const;
