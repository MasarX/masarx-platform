/**
 * Unit tests for the FieldOps mobile gesture-back + navigation state
 * machine (P3.1 gesture back nav).
 *
 * The module under test is pure TS (no React / RN / Expo imports) so these
 * tests run under the standard jest.config.unit.js (node environment).
 */

import {
  createNavigationState,
  interpretSwipeGesture,
  navigationReducer,
  peekActiveFrame,
  type GestureProgress,
  type NavigationAction,
  type NavigationStackFrame,
  type NavigationState,
} from "../../../apps/fieldops/src/mobile-gesture-nav";

/* ---------------------------------------------------------------------------
 * Helpers.
 * -------------------------------------------------------------------------*/

function makeFrame(
  key: string,
  overrides: Partial<NavigationStackFrame> = {},
): NavigationStackFrame {
  return {
    key,
    title: overrides.title ?? `Title ${key}`,
    params: overrides.params ?? null,
    transient: overrides.transient ?? false,
  };
}

function makeProgress(
  overrides: Partial<GestureProgress> = {},
): GestureProgress {
  return {
    dx: 0,
    dy: 0,
    velocityX: 0,
    velocityY: 0,
    ...overrides,
  };
}

/* ---------------------------------------------------------------------------
 * createNavigationState + reducer behaviour.
 * -------------------------------------------------------------------------*/

describe("createNavigationState", () => {
  it("seeds a single-frame stack with canGoBack=false", () => {
    const state = createNavigationState(makeFrame("home"));
    expect(state.stack).toHaveLength(1);
    expect(state.stack[0]?.key).toBe("home");
    expect(state.canGoBack).toBe(false);
  });

  it("forces the root frame to be non-transient even when caller marks it", () => {
    const state = createNavigationState(
      makeFrame("home", { transient: true }),
    );
    expect(state.stack[0]?.transient).toBe(false);
  });

  it("does not leak the input reference into the produced stack", () => {
    const initial = makeFrame("home");
    const state = createNavigationState(initial);
    expect(state.stack[0]).not.toBe(initial);
  });

  it("defaults title to null when not provided and title field is nullable", () => {
    const state = createNavigationState({ key: "home" });
    // title falls back via cloneFrame → null.
    expect(state.stack[0]?.title).toBeNull();
  });

  it("copies params defensively so mutations do not bleed into state", () => {
    const params = { filter: "open" };
    const state = createNavigationState(makeFrame("home", { params }));
    params.filter = "closed";
    expect(state.stack[0]?.params).toEqual({ filter: "open" });
  });
});

describe("navigationReducer — PUSH", () => {
  let base: NavigationState;

  beforeEach(() => {
    base = createNavigationState(makeFrame("home"));
  });

  it("appends a new frame and flips canGoBack to true", () => {
    const next = navigationReducer(base, {
      type: "PUSH",
      frame: makeFrame("detail"),
    });
    expect(next.stack.map((f) => f.key)).toEqual(["home", "detail"]);
    expect(next.canGoBack).toBe(true);
  });

  it("never mutates the previous state stack array", () => {
    const next = navigationReducer(base, {
      type: "PUSH",
      frame: makeFrame("detail"),
    });
    expect(base.stack).toHaveLength(1);
    expect(next.stack).not.toBe(base.stack);
  });

  it("preserves transient flag for modals layered above base route", () => {
    const next = navigationReducer(base, {
      type: "PUSH",
      frame: makeFrame("modal", { transient: true }),
    });
    expect(next.stack[1]?.transient).toBe(true);
  });
});

describe("navigationReducer — POP", () => {
  it("removes the top frame and updates canGoBack", () => {
    const state: NavigationState = navigationReducer(
      createNavigationState(makeFrame("home")),
      { type: "PUSH", frame: makeFrame("detail") },
    );
    const popped = navigationReducer(state, { type: "POP" });
    expect(popped.stack.map((f) => f.key)).toEqual(["home"]);
    expect(popped.canGoBack).toBe(false);
  });

  it("is a no-op (content-wise) when only root remains", () => {
    const state = createNavigationState(makeFrame("home"));
    const popped = navigationReducer(state, { type: "POP" });
    expect(popped.stack).toHaveLength(1);
    expect(popped.canGoBack).toBe(false);
    // Defensive clone — not reference-equal but content-equal.
    expect(popped.stack[0]?.key).toBe("home");
  });

  it("returns a new state object even on no-op pops so reducers never skip via ===", () => {
    const state = createNavigationState(makeFrame("home"));
    const popped = navigationReducer(state, { type: "POP" });
    expect(popped).not.toBe(state);
  });
});

describe("navigationReducer — RESET", () => {
  it("replaces the entire stack with the provided frames", () => {
    const base = createNavigationState(makeFrame("home"));
    const next = navigationReducer(base, {
      type: "RESET",
      stack: [makeFrame("routes"), makeFrame("routes:42")],
    });
    expect(next.stack.map((f) => f.key)).toEqual(["routes", "routes:42"]);
    expect(next.canGoBack).toBe(true);
  });

  it("ignores an empty reset stack and returns current state", () => {
    const base = createNavigationState(makeFrame("home"));
    const next = navigationReducer(base, { type: "RESET", stack: [] });
    expect(next.stack.map((f) => f.key)).toEqual(["home"]);
    expect(next.canGoBack).toBe(false);
  });

  it("coerces the new root to non-transient", () => {
    const base = createNavigationState(makeFrame("home"));
    const next = navigationReducer(base, {
      type: "RESET",
      stack: [makeFrame("modal-root", { transient: true })],
    });
    expect(next.stack[0]?.transient).toBe(false);
  });
});

describe("navigationReducer — REPLACE", () => {
  it("swaps the top frame in place without changing length", () => {
    const base = navigationReducer(
      createNavigationState(makeFrame("home")),
      { type: "PUSH", frame: makeFrame("detail") },
    );
    const next = navigationReducer(base, {
      type: "REPLACE",
      frame: makeFrame("detail-v2"),
    });
    expect(next.stack.map((f) => f.key)).toEqual(["home", "detail-v2"]);
    expect(next.canGoBack).toBe(true);
  });

  it("keeps frames below the top intact", () => {
    const steps: NavigationAction[] = [
      { type: "PUSH", frame: makeFrame("detail") },
      { type: "PUSH", frame: makeFrame("child") },
    ];
    const base: NavigationState = steps.reduce<NavigationState>(
      (s, a) => navigationReducer(s, a),
      createNavigationState(makeFrame("home")),
    );
    const next = navigationReducer(base, {
      type: "REPLACE",
      frame: makeFrame("child-v2"),
    });
    expect(next.stack.map((f) => f.key)).toEqual([
      "home",
      "detail",
      "child-v2",
    ]);
  });
});

describe("navigationReducer — unknown action", () => {
  it("returns a cloned state when an unknown action type is dispatched", () => {
    const base = createNavigationState(makeFrame("home"));
    // Force a shape that does not match the discriminated union.
    const next = navigationReducer(base, {
      type: "UNSUPPORTED",
    } as unknown as NavigationAction);
    expect(next.stack.map((f) => f.key)).toEqual(["home"]);
    expect(next).not.toBe(base);
  });
});

describe("peekActiveFrame", () => {
  it("returns the top frame of the stack", () => {
    const state: NavigationState = navigationReducer(
      createNavigationState(makeFrame("home")),
      { type: "PUSH", frame: makeFrame("detail") },
    );
    expect(peekActiveFrame(state)?.key).toBe("detail");
  });

  it("returns null when the stack is somehow empty", () => {
    const empty: NavigationState = { stack: [], canGoBack: false };
    expect(peekActiveFrame(empty)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * interpretSwipeGesture behaviour.
 * -------------------------------------------------------------------------*/

describe("interpretSwipeGesture", () => {
  const containerWidth = 400;

  it("returns 'commit_back' for a right-drag past threshold with positive velocity", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: 200, velocityX: 1.5 }),
      { containerWidth },
    );
    expect(outcome).toBe("commit_back");
  });

  it("returns 'cancel' for a right-drag under threshold", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: 40, velocityX: 0.2 }),
      { containerWidth },
    );
    expect(outcome).toBe("cancel");
  });

  it("returns 'cancel' when velocity is non-positive despite distance", () => {
    // Reached threshold distance but no forward momentum → cancel.
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: 180, velocityX: 0 }),
      { containerWidth },
    );
    expect(outcome).toBe("cancel");
  });

  it("treats the default edgeThresholdPct as 0.35", () => {
    const belowThreshold = interpretSwipeGesture(
      makeProgress({ dx: 0.34 * containerWidth, velocityX: 1 }),
      { containerWidth },
    );
    const aboveThreshold = interpretSwipeGesture(
      makeProgress({ dx: 0.36 * containerWidth, velocityX: 1 }),
      { containerWidth },
    );
    expect(belowThreshold).toBe("cancel");
    expect(aboveThreshold).toBe("commit_back");
  });

  it("respects an explicit edgeThresholdPct override", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: 0.6 * containerWidth, velocityX: 1 }),
      { containerWidth, edgeThresholdPct: 0.7 },
    );
    expect(outcome).toBe("cancel");
  });

  it("returns 'open_drawer' for a left-drag with enough magnitude + velocity", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: -200, velocityX: -1.2 }),
      { containerWidth },
    );
    expect(outcome).toBe("open_drawer");
  });

  it("returns 'none' for a tiny left-drag that stays below threshold", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: -20, velocityX: -0.1 }),
      { containerWidth },
    );
    expect(outcome).toBe("none");
  });

  it("returns 'none' for a left-drag past threshold without matching velocity", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: -200, velocityX: -0.2 }),
      { containerWidth },
    );
    expect(outcome).toBe("none");
  });

  it("returns 'none' for a dominantly vertical gesture", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: 50, dy: 200, velocityX: 1.5, velocityY: 3 }),
      { containerWidth },
    );
    expect(outcome).toBe("none");
  });

  it("returns 'none' for a perfectly diagonal gesture (tie → vertical)", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: 100, dy: 100, velocityX: 1, velocityY: 1 }),
      { containerWidth },
    );
    expect(outcome).toBe("none");
  });

  it("returns 'none' for a zero gesture", () => {
    const outcome = interpretSwipeGesture(makeProgress(), { containerWidth });
    expect(outcome).toBe("none");
  });

  it("returns 'none' when containerWidth is zero (defensive)", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: 200, velocityX: 1 }),
      { containerWidth: 0 },
    );
    expect(outcome).toBe("none");
  });

  it("returns 'none' when containerWidth is NaN (defensive)", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: 200, velocityX: 1 }),
      { containerWidth: Number.NaN },
    );
    expect(outcome).toBe("none");
  });

  it("clamps a negative edgeThresholdPct to 0 (any right-drag commits)", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: 10, velocityX: 0.6 }),
      { containerWidth, edgeThresholdPct: -1 },
    );
    expect(outcome).toBe("commit_back");
  });

  it("clamps an edgeThresholdPct above 1 so nothing ever commits", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: containerWidth, velocityX: 5 }),
      { containerWidth, edgeThresholdPct: 2 },
    );
    expect(outcome).toBe("cancel");
  });

  it("sanitises non-finite dx to zero (returns 'none')", () => {
    const outcome = interpretSwipeGesture(
      { dx: Number.NaN, dy: 0, velocityX: 5, velocityY: 0 },
      { containerWidth },
    );
    expect(outcome).toBe("none");
  });

  it("respects a custom velocityThreshold for drawer-open intent", () => {
    // dx is past threshold to the left and velocity is below the custom
    // velocity threshold → falls through to 'none'.
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: -200, velocityX: -0.6 }),
      { containerWidth, velocityThreshold: 1 },
    );
    expect(outcome).toBe("none");
  });

  it("accepts a lower velocityThreshold override and fires open_drawer earlier", () => {
    const outcome = interpretSwipeGesture(
      makeProgress({ dx: -200, velocityX: -0.3 }),
      { containerWidth, velocityThreshold: 0.2 },
    );
    expect(outcome).toBe("open_drawer");
  });
});
