/**
 * Schedule development-only accessibility checks and return a teardown to stop them.
 *
 * This module exposes a small scheduler API:
 *   - `startA11yRuntimeTick(audit, options)` — schedules `audit()` once
 *     immediately and again every `intervalMs`. Returns a teardown.
 *   - `shouldRunA11yRuntimeTick()` — pure resolver returning whether the
 *     current build should run the runtime tick (true only in __DEV__ mode).
 *
 * Test-environment safety:
 *   - The scheduler does NOT import `react-native` directly so jest/jsdom
 *     environments can exercise it without mocks.
 *   - `__DEV__` is read defensively via `globalThis` so the scheduler works
 *     in environments where the constant is not declared.
 *
 * Contract for callers (App.tsx wires this in a `useEffect` near other
 * shell-mount effects):
 *   1. Resolve `shouldRunA11yRuntimeTick()` once.
 *   2. If false, do nothing — production builds never schedule the tick.
 *   3. If true, call `startA11yRuntimeTick(audit, { intervalMs })` and
 *      return its teardown from the effect cleanup.
 *
 * The `audit` callback is supplied by the caller because the actual
 * `runA11yAudit` invocation needs platform-specific element snapshotting
 * (web DOM vs React Native AccessibilityInfo). Keeping the scheduler
 * platform-agnostic lets us unit-test the timing contract in isolation.
 */

import { redactOutboxErrorText } from "@masarx/mobile-core";

export type A11yRuntimeTickOptions = {
  /**
   * Interval between audit ticks in milliseconds. Defaults to 30_000
   * (30 seconds) — fast enough to catch regressions during interactive dev
   * but slow enough not to flood the logger.
   *
   * Values <= 0 fall back to the default to avoid tight CPU loops.
   */
  intervalMs?: number;

  /**
   * When `true`, the first audit fires synchronously on mount before the
   * polling timer is scheduled. Defaults to `true` (ship-friendly: engineers
   * see findings immediately on app start). Tests pass `false` to assert
   * pure-timer behavior.
   */
  runOnMount?: boolean;
};

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1;

type GlobalsLike = {
  __DEV__?: unknown;
};

/**
 * Pure resolver: returns whether the runtime tick should run in the current
 * build. True only when `__DEV__` is strictly truthy. Production bundles
 * always return false so the tick never runs in a shipped app.
 */
export function shouldRunA11yRuntimeTick(): boolean {
  try {
    const dev = (globalThis as GlobalsLike).__DEV__;
    return Boolean(dev);
  } catch {
    return false;
  }
}

/**
 * Start the a11y runtime tick scheduler.
 *
 * Schedules `audit()` immediately (when `runOnMount` is true) and again
 * every `intervalMs` until the returned teardown is invoked. The teardown
 * is idempotent — calling it twice is safe.
 *
 * The scheduler swallows any exception thrown by `audit()` so a buggy
 * adapter cannot crash the shell. Errors are reported via console.warn so
 * engineers still see them in the dev console.
 */
export function startA11yRuntimeTick(
  audit: () => void,
  options: A11yRuntimeTickOptions = {},
): () => void {
  if (typeof audit !== "function") {
    return () => {
      // no-op teardown — nothing was scheduled
    };
  }

  const requestedInterval =
    typeof options.intervalMs === "number" &&
    Number.isFinite(options.intervalMs) &&
    options.intervalMs > 0
      ? Math.max(MIN_INTERVAL_MS, Math.trunc(options.intervalMs))
      : DEFAULT_INTERVAL_MS;

  const runOnMount = options.runOnMount !== false;

  let teardownDone = false;

  const safeAudit = (): void => {
    if (teardownDone) return;
    try {
      audit();
    } catch (error) {
      // Swallow — but surface in dev console so engineers still see it.
      try {
        // eslint-disable-next-line no-console
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        console.warn("[a11y-runtime-tick] audit threw", redactOutboxErrorText(message));
      } catch {
        // Even console.warn might fail in some test envs; ignore.
      }
    }
  };

  if (runOnMount) {
    safeAudit();
  }

  const interval = setInterval(safeAudit, requestedInterval);

  return () => {
    if (teardownDone) return;
    teardownDone = true;
    clearInterval(interval);
  };
}
