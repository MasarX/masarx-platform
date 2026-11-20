/** Apply React Native direction at the locale boundary and resolve directional spacing, flex and text styles consistently. */

import * as React from "react";

type I18nManagerLike = {
  isRTL?: boolean;
  allowRTL?: (allow: boolean) => void;
  forceRTL?: (force: boolean) => void;
};

/**
 * Read `I18nManager` from `react-native` if available. Returns `null` in
 * test environments (jsdom / node) where the module isn't installed or
 * doesn't expose the manager. Never throws.
 */
function safeReadI18nManager(): I18nManagerLike | null {
  try {
    // We use `require` (not a top-level `import`) so test environments that
    // don't have `react-native` installed still load this module without
    // throwing at import time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const rn = require("react-native");
    const candidate = rn?.I18nManager;
    if (candidate && typeof candidate === "object") {
      return candidate as I18nManagerLike;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure resolver: returns the current effective RTL flag from
 * `I18nManager.isRTL`. Returns `false` when React Native is unavailable.
 */
export function resolveIsRTL(): boolean {
  const manager = safeReadI18nManager();
  return Boolean(manager?.isRTL);
}

/**
 * Pure resolver: returns the row direction to use for `flexDirection`.
 */
export function resolveRowDirection(): "row" | "row-reverse" {
  return resolveIsRTL() ? "row-reverse" : "row";
}

/**
 * Pure resolver: returns the logical text-start alignment ("left" in LTR,
 * "right" in RTL).
 */
export function resolveTextStart(): "left" | "right" {
  return resolveIsRTL() ? "right" : "left";
}

/**
 * Pure resolver: returns the logical text-end alignment (opposite of
 * `resolveTextStart`).
 */
export function resolveTextEnd(): "right" | "left" {
  return resolveIsRTL() ? "left" : "right";
}

/**
 * Pure resolver: returns an RTL-aware logical-margin object that maps to
 * `marginLeft` in LTR and `marginRight` in RTL.
 */
export function resolveMarginStart(value: number):
  | { marginLeft: number }
  | { marginRight: number } {
  return resolveIsRTL() ? { marginRight: value } : { marginLeft: value };
}

/**
 * Apply the RTL policy for the supplied locale. Calls
 * `I18nManager.allowRTL(true)` + `I18nManager.forceRTL(locale === "ar")`.
 * Wrapped in try/catch so test environments without React Native (or any
 * future host that does not expose `I18nManager`) silently no-op.
 *
 * NOTE: `forceRTL` only takes effect on the NEXT bundle reload. The rest
 * of the app already updates `document.dir` (web) and resolves
 * `selectedDirectionMode` for in-tree direction-aware paddings, so the
 * user-visible behavior stays consistent. Mid-session
 * `Updates.reloadAsync()` is intentionally a follow-up.
 */
export function applyRTLPolicy(locale: string): void {
  try {
    const manager = safeReadI18nManager();
    if (!manager) return;
    if (typeof manager.allowRTL === "function") {
      manager.allowRTL(true);
    }
    if (typeof manager.forceRTL === "function") {
      manager.forceRTL(locale === "ar");
    }
  } catch {
    // Swallow — test environments and unsupported hosts must not crash.
  }
}

/**
 * Hook: returns the current effective RTL flag from `I18nManager.isRTL`.
 * Memoized for referential stability across renders.
 */
export function useIsRTL(): boolean {
  return React.useMemo<boolean>(() => resolveIsRTL(), []);
}

/**
 * Hook: returns the row direction to use for `flexDirection` in RTL-aware
 * layouts. Components that previously hardcoded `"row"` should switch to
 * this hook so the layout swaps to `"row-reverse"` automatically when RTL
 * is active.
 */
export function useRowDirection(): "row" | "row-reverse" {
  const isRTL = useIsRTL();
  return React.useMemo<"row" | "row-reverse">(
    () => (isRTL ? "row-reverse" : "row"),
    [isRTL]
  );
}

/**
 * Hook: returns the logical text-start alignment ("left" in LTR, "right"
 * in RTL). Use for `textAlign` on labels that should hug the leading edge.
 */
export function useTextStart(): "left" | "right" {
  const isRTL = useIsRTL();
  return React.useMemo<"left" | "right">(
    () => (isRTL ? "right" : "left"),
    [isRTL]
  );
}

/**
 * Hook: returns the logical text-end alignment (opposite of `useTextStart`).
 * Use for `textAlign` on labels that should hug the trailing edge.
 */
export function useTextEnd(): "right" | "left" {
  const isRTL = useIsRTL();
  return React.useMemo<"right" | "left">(
    () => (isRTL ? "left" : "right"),
    [isRTL]
  );
}

/**
 * Hook: returns an RTL-aware logical-margin object that maps to
 * `marginLeft` in LTR and `marginRight` in RTL. Use this anywhere
 * component code previously hardcoded `marginLeft: <n>` for a
 * leading-edge offset (e.g. icon-then-label gaps in a row).
 */
export function useMarginStart(value: number):
  | { marginLeft: number }
  | { marginRight: number } {
  const isRTL = useIsRTL();
  return React.useMemo<{ marginLeft: number } | { marginRight: number }>(
    () => (isRTL ? { marginRight: value } : { marginLeft: value }),
    [isRTL, value]
  );
}
