/** Bottom-sheet types define snap points, dismissal behavior and content slots without importing React Native. */

import type * as React from "react";

/**
 * Public prop surface for the BottomSheet primitive.
 *
 * Notes for callers:
 *  - `visible` is the controlled-visibility flag. Callers own the boolean
 *    and toggle it in their own state; the primitive does not animate
 *    closure on its own — flipping `visible` to `false` triggers the
 *    Modal's slide-out via React Native's built-in `animationType="slide"`.
 *  - `onDismiss` is invoked by EITHER the backdrop press (when
 *    `dismissOnBackdrop` is true) OR the close button. Callers should
 *    flip `visible` to false inside this handler — the component does
 *    not auto-close itself so callers can intercept (e.g. confirm-discard
 *    on a partially-filled action composer).
 *  - `actions` is an optional bottom-anchored row. Recommended consumption
 *    is `<AppButton variant="primary" fullWidth ... />` plus an optional
 *    secondary/ghost cancel — but the slot is free-form so callers can
 *    drop in a custom CTA layout when needed.
 *  - `dismissOnBackdrop` defaults to `true`. Set to `false` for sheets
 *    that hold partially-filled forms or destructive confirmations where
 *    an accidental backdrop tap should not silently throw away input.
 *  - `maxHeightPct` defaults to `0.9` — the sheet caps at 90 % of the
 *    viewport so the backdrop scrim is always visible above it (visual
 *    affordance that the surface is dismissible). Callers can opt for
 *    smaller (e.g. `0.5` for a half-sheet date picker) but values above
 *    `1.0` are clamped down to `1.0` inside the component.
 *  - `testID` defaults to `bottom-sheet`. Nested nodes derive their own
 *    testIDs by suffixing (`bottom-sheet-backdrop`, `bottom-sheet-sheet`,
 *    `bottom-sheet-title`, `bottom-sheet-close`, `bottom-sheet-children`,
 *    `bottom-sheet-actions`).
 *  - `accessibilityLabel` defaults to the `title` when supplied, falling
 *    back to a generic "Bottom sheet" string when no title is given.
 *    Override only when neither value carries enough context for AT.
 */
export type BottomSheetProps = {
  /** Controlled visibility flag. Callers own the boolean. */
  visible: boolean;
  /** Invoked by backdrop press (when allowed) and by the close button. */
  onDismiss: () => void;
  /** Optional sheet title rendered in the header row. */
  title?: string;
  /** Body content. Rendered inside the scroll area between header and actions. */
  children: React.ReactNode;
  /** Optional bottom actions row (recommended: AppButton). */
  actions?: React.ReactNode;
  /** Treat backdrop press as dismiss. Defaults to `true`. */
  dismissOnBackdrop?: boolean;
  /**
   * Sheet max height as fraction of viewport. Defaults to `0.9`.
   * Values are clamped to (0, 1].
   */
  maxHeightPct?: number;
  /** Override the default `bottom-sheet` testID. Suffixed for nested nodes. */
  testID?: string;
  /** Override the default a11y label. Falls back to `title` then "Bottom sheet". */
  accessibilityLabel?: string;
};
