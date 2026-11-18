/**
 * Pure TypeScript navigation state machine + swipe-gesture interpreter for
 * the Field Ops mobile app (P3.1 gesture back nav).
 *
 * This module is intentionally free of React / React Native / Expo / DOM
 * imports so it can be consumed by unit tests under node or jsdom without
 * any shims, and it can stand in place of `@react-navigation` + `react-
 * native-gesture-handler` until those dependencies are introduced.
 *
 * Responsibilities:
 *  - A reducer-shaped navigation state ({ stack, canGoBack }) with pure
 *    transitions for PUSH / POP / RESET / REPLACE. Mirrors the ergonomics
 *    of a stack navigator without pulling in the library.
 *  - An interpreter that maps a raw horizontal-swipe gesture (`dx`, `dy`,
 *    velocities) into a discrete `GestureOutcome` that the parent can wire
 *    to a navigation action (`commit_back`, `cancel`, `open_drawer`, or
 *    `none`).
 *
 * When `react-native-gesture-handler` + `@react-navigation` are eventually
 * adopted, the wiring layer is expected to pipe platform gesture events
 * through `interpretSwipeGesture` and dispatch the corresponding navigation
 * action, so the same interface survives the upgrade.
 */

export type NavigationStackFrame = {
  key: string;
  title?: string | null;
  params?: Record<string, unknown> | null;
  transient?: boolean;
};

export type NavigationState = {
  stack: NavigationStackFrame[];
  canGoBack: boolean;
};

export type NavigationAction =
  | { type: "PUSH"; frame: NavigationStackFrame }
  | { type: "POP" }
  | { type: "RESET"; stack: NavigationStackFrame[] }
  | { type: "REPLACE"; frame: NavigationStackFrame };

export type GestureProgress = {
  dx: number;
  dy: number;
  velocityX: number;
  velocityY: number;
};

export type GestureOutcome = "commit_back" | "cancel" | "open_drawer" | "none";

export type InterpretSwipeOptions = {
  containerWidth: number;
  edgeThresholdPct?: number;
  velocityThreshold?: number;
};

const DEFAULT_EDGE_THRESHOLD_PCT = 0.35;
const DEFAULT_VELOCITY_THRESHOLD = 0.5;

/**
 * Clone a single stack frame. Params and the frame itself are shallow-copied
 * so downstream reducers never observe mutations from the caller.
 */
function cloneFrame(frame: NavigationStackFrame): NavigationStackFrame {
  return {
    key: frame.key,
    title: frame.title ?? null,
    params: frame.params ? { ...frame.params } : null,
    transient: frame.transient === true,
  };
}

/**
 * Clone the whole stack, freezing per-frame mutations so the returned
 * NavigationState is independent of the caller's reference graph.
 */
function cloneStack(stack: NavigationStackFrame[]): NavigationStackFrame[] {
  return stack.map(cloneFrame);
}

function toState(stack: NavigationStackFrame[]): NavigationState {
  return {
    stack,
    canGoBack: stack.length > 1,
  };
}

/**
 * Build the initial NavigationState from a single root frame. The root frame
 * is never considered transient regardless of the input flag (transient is
 * meaningful for modals layered on top of a base route).
 */
export function createNavigationState(
  initial: NavigationStackFrame,
): NavigationState {
  const frame = cloneFrame(initial);
  // Root is never transient.
  frame.transient = false;
  return toState([frame]);
}

/**
 * Pure navigation reducer. Never mutates input state or action payloads.
 * Unknown action types are ignored and the existing state is returned as-is.
 */
export function navigationReducer(
  state: NavigationState,
  action: NavigationAction,
): NavigationState {
  switch (action.type) {
    case "PUSH": {
      const next = cloneStack(state.stack);
      next.push(cloneFrame(action.frame));
      return toState(next);
    }
    case "POP": {
      if (state.stack.length <= 1) {
        // Can't pop the root; return a fresh state shell so consumers do not
        // observe mutation but never drop below length 1.
        return toState(cloneStack(state.stack));
      }
      const next = cloneStack(state.stack);
      next.pop();
      return toState(next);
    }
    case "RESET": {
      if (!Array.isArray(action.stack) || action.stack.length === 0) {
        // Refuse to reset to an empty stack; fall back to current state.
        return toState(cloneStack(state.stack));
      }
      const next = cloneStack(action.stack);
      // Root is never transient.
      if (next[0]) next[0].transient = false;
      return toState(next);
    }
    case "REPLACE": {
      if (state.stack.length === 0) {
        // Defensive: an empty stack should never happen, but if it does,
        // treat REPLACE as a seed.
        return toState([cloneFrame(action.frame)]);
      }
      const next = cloneStack(state.stack);
      next[next.length - 1] = cloneFrame(action.frame);
      return toState(next);
    }
    default: {
      // Unknown action — return current state but defensively cloned so the
      // caller never observes reference equality-driven skips.
      return toState(cloneStack(state.stack));
    }
  }
}

/**
 * Map a raw horizontal-swipe gesture to a navigation outcome.
 *
 *   - `commit_back` when the user has dragged more than
 *     `containerWidth * edgeThresholdPct` to the right AND the horizontal
 *     velocity is positive (trailing momentum) — this is the classic
 *     edge-swipe-back gesture on iOS/Android.
 *   - `cancel` when the user started dragging right (`dx > 0`) but released
 *     before crossing the threshold, so the parent should animate the
 *     in-flight screen back to its resting position instead of popping.
 *   - `open_drawer` when the user dragged left (`dx < 0`) with enough
 *     magnitude / velocity — reserved for a future drawer-open gesture so
 *     callers can wire the same interpreter to both gestures.
 *   - `none` when the gesture is dominantly vertical or too small to matter.
 *
 * Defaults: `edgeThresholdPct = 0.35`, `velocityThreshold = 0.5` px/ms.
 */
export function interpretSwipeGesture(
  progress: GestureProgress,
  options: InterpretSwipeOptions,
): GestureOutcome {
  const containerWidth = Number.isFinite(options.containerWidth)
    ? Math.max(0, options.containerWidth)
    : 0;
  const edgeThresholdPct =
    typeof options.edgeThresholdPct === "number" &&
    Number.isFinite(options.edgeThresholdPct)
      ? Math.max(0, Math.min(1, options.edgeThresholdPct))
      : DEFAULT_EDGE_THRESHOLD_PCT;
  const velocityThreshold =
    typeof options.velocityThreshold === "number" &&
    Number.isFinite(options.velocityThreshold)
      ? Math.max(0, options.velocityThreshold)
      : DEFAULT_VELOCITY_THRESHOLD;

  const dx = Number.isFinite(progress.dx) ? progress.dx : 0;
  const dy = Number.isFinite(progress.dy) ? progress.dy : 0;
  const velocityX = Number.isFinite(progress.velocityX)
    ? progress.velocityX
    : 0;

  // If the container width is zero we can't meaningfully compare against a
  // percentage threshold; bail.
  if (containerWidth <= 0) return "none";

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  // Ignore dominantly vertical gestures (list scroll, pull-to-refresh, etc.).
  // A gesture is only "horizontal" when |dx| strictly dominates |dy|; diagonal
  // ties are treated as vertical to avoid accidentally triggering back.
  if (absDx <= absDy) return "none";

  const threshold = containerWidth * edgeThresholdPct;

  if (dx > 0) {
    // Dragging left-to-right → potential "go back".
    if (dx > threshold && velocityX > 0) {
      return "commit_back";
    }
    return "cancel";
  }

  if (dx < 0) {
    // Dragging right-to-left → potential "open drawer".
    if (absDx > threshold && velocityX < -velocityThreshold) {
      return "open_drawer";
    }
    return "none";
  }

  return "none";
}

/**
 * Helper: read the currently active frame (top of stack). Returns null if
 * the stack is somehow empty (defensive; should not happen via the reducer).
 */
export function peekActiveFrame(
  state: NavigationState,
): NavigationStackFrame | null {
  if (!state.stack.length) return null;
  return state.stack[state.stack.length - 1] ?? null;
}
