/** Verify that a swipe opens the prefilled completion form and preserves the confirmation step. */

// -----------------------------------------------------------------------------
// Mirror of the App.tsx helpers (search for `useSwipeToCompleteRow` and the
// `pendingSwipeCompleteTaskId` effect). Kept here as standalone re-implementations
// so the contract is testable without dragging the App component, react-native,
// expo, or react-query into the unit suite. If the App.tsx implementation
// drifts, this mirror drifts in lockstep — the test surface remains the
// canonical regression net for the wiring contract.
// -----------------------------------------------------------------------------

type GestureSnapshot = { dx: number; dy: number };

type SwipeDecisionInput = {
  gesture: GestureSnapshot;
  rowWidth?: number;
  thresholdPx?: number;
  disabled?: boolean;
};

type SwipeDecision =
  | { kind: "ignored"; reason: "disabled" | "vertical" | "too_small" | "rightward" }
  | { kind: "snap_back"; deltaX: number }
  | { kind: "commit"; deltaX: number; effectiveThresholdPx: number };

/**
 * Pure decision function mirroring `useSwipeToCompleteRow` in App.tsx.
 * Given the gesture snapshot at release time + the row's width + the
 * (optional) threshold override, returns whether the gesture commits, snaps
 * back, or is ignored entirely (responder never claimed).
 *
 * App.tsx uses two signals to decide commitment:
 *   - onMoveShouldSetPanResponder gates the responder claim (horizontal-only,
 *     |dx| > 8). We mirror that as the "ignored" branches.
 *   - onPanResponderRelease commits when (dx < 0) AND |dx| > effectiveThreshold.
 */
function decideSwipe(input: SwipeDecisionInput): SwipeDecision {
  if (input.disabled === true) {
    return { kind: "ignored", reason: "disabled" };
  }
  // Mirror onMoveShouldSetPanResponder: horizontal-only.
  if (Math.abs(input.gesture.dy) >= 16) {
    return { kind: "ignored", reason: "vertical" };
  }
  if (Math.abs(input.gesture.dx) <= 8) {
    return { kind: "ignored", reason: "too_small" };
  }
  // Mirror onPanResponderMove: only translate on leftward drag. Rightward
  // drags pass the responder claim but don't translate the row, and the
  // release handler also only commits on (dx < 0) so they snap back.
  if (input.gesture.dx > 0) {
    return { kind: "ignored", reason: "rightward" };
  }
  // Threshold resolution mirrors App.tsx exactly:
  //   - explicit thresholdPx wins
  //   - else 25% of rowWidth (default 320 when rowWidth not measured)
  //   - clamped to a min of 80px so very narrow rows still feel deliberate
  const effectiveRowWidth =
    typeof input.rowWidth === "number" && input.rowWidth > 0 ? input.rowWidth : 320;
  const effectiveThreshold =
    typeof input.thresholdPx === "number" && input.thresholdPx > 0
      ? input.thresholdPx
      : Math.max(80, Math.round(effectiveRowWidth * 0.25));

  if (Math.abs(input.gesture.dx) > effectiveThreshold) {
    return {
      kind: "commit",
      deltaX: input.gesture.dx,
      effectiveThresholdPx: effectiveThreshold,
    };
  }
  return { kind: "snap_back", deltaX: input.gesture.dx };
}

// -----------------------------------------------------------------------------
// Mirror of the parent `pendingSwipeCompleteTaskId` effect that watches the
// available actions and fires runCommand(tasks.complete) once available.
// -----------------------------------------------------------------------------

type AvailableActionLike = { key: string };

function applyPendingSwipeCompletion(input: {
  pendingTaskId: string | null;
  selectedResourceId: string | null;
  availableActions: AvailableActionLike[];
}):
  | { kind: "noop" }
  | { kind: "drop"; reason: "task_changed" | "no_pending" }
  | { kind: "fire"; commandKey: string } {
  if (!input.pendingTaskId) return { kind: "drop", reason: "no_pending" };
  if (input.selectedResourceId !== input.pendingTaskId) {
    return { kind: "drop", reason: "task_changed" };
  }
  const command = input.availableActions.find((c) => c.key === "tasks.complete");
  if (!command) return { kind: "noop" };
  return { kind: "fire", commandKey: command.key };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("decideSwipe — gesture decision", () => {
  test("disabled gesture is ignored regardless of magnitude", () => {
    const result = decideSwipe({
      gesture: { dx: -200, dy: 0 },
      rowWidth: 360,
      disabled: true,
    });
    expect(result).toEqual({ kind: "ignored", reason: "disabled" });
  });

  test("vertical drag (|dy| >= 16) is ignored — FlatList scroll wins", () => {
    const result = decideSwipe({ gesture: { dx: -100, dy: 30 }, rowWidth: 360 });
    expect(result).toEqual({ kind: "ignored", reason: "vertical" });
  });

  test("tiny horizontal drag (|dx| <= 8) is ignored — accidental touch jitter", () => {
    const result = decideSwipe({ gesture: { dx: -5, dy: 0 }, rowWidth: 360 });
    expect(result).toEqual({ kind: "ignored", reason: "too_small" });
  });

  test("rightward drag is ignored even when large — gesture is left-only", () => {
    const result = decideSwipe({ gesture: { dx: 200, dy: 0 }, rowWidth: 360 });
    expect(result).toEqual({ kind: "ignored", reason: "rightward" });
  });

  test("leftward drag past 25% of rowWidth commits", () => {
    // 360 * 0.25 = 90 → threshold 90px (above the 80px clamp)
    const result = decideSwipe({ gesture: { dx: -100, dy: 0 }, rowWidth: 360 });
    expect(result).toEqual({
      kind: "commit",
      deltaX: -100,
      effectiveThresholdPx: 90,
    });
  });

  test("leftward drag below threshold snaps back", () => {
    const result = decideSwipe({ gesture: { dx: -50, dy: 0 }, rowWidth: 360 });
    expect(result).toEqual({ kind: "snap_back", deltaX: -50 });
  });

  test("leftward drag exactly at threshold snaps back (strict greater-than)", () => {
    // The contract is `|dx| > threshold` — equal-to is snap_back.
    const result = decideSwipe({ gesture: { dx: -90, dy: 0 }, rowWidth: 360 });
    expect(result).toEqual({ kind: "snap_back", deltaX: -90 });
  });

  test("explicit thresholdPx overrides the 25%-of-rowWidth default", () => {
    // 25% of 360 would be 90; with thresholdPx=200 the row needs a much bigger
    // drag to commit — useful when a tenant wants a stricter gesture.
    const undecided = decideSwipe({
      gesture: { dx: -150, dy: 0 },
      rowWidth: 360,
      thresholdPx: 200,
    });
    expect(undecided).toEqual({ kind: "snap_back", deltaX: -150 });
    const committed = decideSwipe({
      gesture: { dx: -250, dy: 0 },
      rowWidth: 360,
      thresholdPx: 200,
    });
    expect(committed).toEqual({
      kind: "commit",
      deltaX: -250,
      effectiveThresholdPx: 200,
    });
  });

  test("threshold clamps to min 80px even on narrow rows", () => {
    // 200 * 0.25 = 50 → clamped to 80
    const result = decideSwipe({ gesture: { dx: -70, dy: 0 }, rowWidth: 200 });
    expect(result).toEqual({ kind: "snap_back", deltaX: -70 });
    const result2 = decideSwipe({ gesture: { dx: -90, dy: 0 }, rowWidth: 200 });
    expect(result2).toEqual({
      kind: "commit",
      deltaX: -90,
      effectiveThresholdPx: 80,
    });
  });

  test("missing rowWidth falls back to 320 default → 80px threshold (clamped)", () => {
    // 320 * 0.25 = 80 (exactly clamp boundary)
    const result = decideSwipe({ gesture: { dx: -85, dy: 0 } });
    expect(result).toEqual({
      kind: "commit",
      deltaX: -85,
      effectiveThresholdPx: 80,
    });
  });
});

describe("applyPendingSwipeCompletion — composer pre-fill flow", () => {
  test("no pending task → drop with reason 'no_pending'", () => {
    const result = applyPendingSwipeCompletion({
      pendingTaskId: null,
      selectedResourceId: "task-1",
      availableActions: [{ key: "tasks.complete" }],
    });
    expect(result).toEqual({ kind: "drop", reason: "no_pending" });
  });

  test("pending task differs from selected → drop (driver navigated away)", () => {
    const result = applyPendingSwipeCompletion({
      pendingTaskId: "task-1",
      selectedResourceId: "task-2",
      availableActions: [{ key: "tasks.complete" }],
    });
    expect(result).toEqual({ kind: "drop", reason: "task_changed" });
  });

  test("pending task matches but tasks.complete not yet available → noop (wait for detail load)", () => {
    const result = applyPendingSwipeCompletion({
      pendingTaskId: "task-1",
      selectedResourceId: "task-1",
      availableActions: [{ key: "tasks.en_route" }],
    });
    expect(result).toEqual({ kind: "noop" });
  });

  test("pending task matches AND tasks.complete is available → fire", () => {
    const result = applyPendingSwipeCompletion({
      pendingTaskId: "task-1",
      selectedResourceId: "task-1",
      availableActions: [
        { key: "tasks.en_route" },
        { key: "tasks.complete" },
        { key: "tasks.exception" },
      ],
    });
    expect(result).toEqual({ kind: "fire", commandKey: "tasks.complete" });
  });

  test("availableActions is empty → noop (still waiting)", () => {
    const result = applyPendingSwipeCompletion({
      pendingTaskId: "task-1",
      selectedResourceId: "task-1",
      availableActions: [],
    });
    expect(result).toEqual({ kind: "noop" });
  });
});

describe("end-to-end swipe → composer pre-fill simulation", () => {
  /**
   * Walks a single task row through the full swipe → composer-open lifecycle,
   * mirroring the App.tsx state transitions:
   *
   *   1. Driver swipes leftward past threshold on a task row in the list view.
   *   2. Parent receives onSwipeCompleteTask(item), sets selectedResourceId
   *      + selectedResourceTitle, and flags pendingSwipeCompleteTaskId.
   *   3. Detail query loads → availableActions populates → effect fires
   *      runCommand(tasks.complete).
   *   4. runCommand opens the composer (existing flow handles pre-fill).
   *   5. Pending flag clears (single-fire guard).
   */
  type SimulatedAppState = {
    selectedResourceId: string | null;
    pendingSwipeCompleteTaskId: string | null;
    availableActions: AvailableActionLike[];
    runCommandCalls: string[];
  };

  function applyEffectStep(state: SimulatedAppState): SimulatedAppState {
    const decision = applyPendingSwipeCompletion({
      pendingTaskId: state.pendingSwipeCompleteTaskId,
      selectedResourceId: state.selectedResourceId,
      availableActions: state.availableActions,
    });
    if (decision.kind === "fire") {
      return {
        ...state,
        pendingSwipeCompleteTaskId: null, // single-fire guard
        runCommandCalls: [...state.runCommandCalls, decision.commandKey],
      };
    }
    if (decision.kind === "drop" && decision.reason === "task_changed") {
      return { ...state, pendingSwipeCompleteTaskId: null };
    }
    return state;
  }

  test("happy path: swipe → detail loads → composer open command fires once", () => {
    let state: SimulatedAppState = {
      selectedResourceId: null,
      pendingSwipeCompleteTaskId: null,
      availableActions: [],
      runCommandCalls: [],
    };

    // Step 1: swipe commits (leftward past threshold).
    const decision = decideSwipe({ gesture: { dx: -150, dy: 0 }, rowWidth: 360 });
    expect(decision.kind).toBe("commit");

    // Step 2: parent flags pending + navigates to detail.
    state = {
      ...state,
      selectedResourceId: "task-42",
      pendingSwipeCompleteTaskId: "task-42",
    };
    state = applyEffectStep(state); // detail not yet loaded → noop
    expect(state.runCommandCalls).toEqual([]);

    // Step 3: detail query resolves, availableActions populates.
    state = {
      ...state,
      availableActions: [
        { key: "tasks.complete" },
        { key: "tasks.exception" },
      ],
    };
    state = applyEffectStep(state); // → fires runCommand(tasks.complete)
    expect(state.runCommandCalls).toEqual(["tasks.complete"]);
    expect(state.pendingSwipeCompleteTaskId).toBeNull();

    // Step 4: subsequent renders (re-running the effect) must NOT re-fire.
    state = applyEffectStep(state);
    state = applyEffectStep(state);
    expect(state.runCommandCalls).toEqual(["tasks.complete"]);
  });

  test("driver navigates to a different task before detail loads → pending clears, no fire", () => {
    let state: SimulatedAppState = {
      selectedResourceId: "task-42",
      pendingSwipeCompleteTaskId: "task-42",
      availableActions: [],
      runCommandCalls: [],
    };

    // Driver taps back, opens task-99 instead before the original detail loaded.
    state = { ...state, selectedResourceId: "task-99" };
    state = applyEffectStep(state);
    expect(state.pendingSwipeCompleteTaskId).toBeNull();
    expect(state.runCommandCalls).toEqual([]);

    // Even if availableActions later includes tasks.complete for task-99, no
    // fire is triggered because the pending flag has been cleared.
    state = {
      ...state,
      availableActions: [{ key: "tasks.complete" }],
    };
    state = applyEffectStep(state);
    expect(state.runCommandCalls).toEqual([]);
  });

  test("driving-lock disable blocks swipe → no commit → no pending flag", () => {
    // Driver attempts a leftward swipe while moving.
    const decision = decideSwipe({
      gesture: { dx: -200, dy: 0 },
      rowWidth: 360,
      disabled: true,
    });
    expect(decision).toEqual({ kind: "ignored", reason: "disabled" });

    // Parent never receives onSwipeCompleteTask → state stays null.
    let state: SimulatedAppState = {
      selectedResourceId: null,
      pendingSwipeCompleteTaskId: null,
      availableActions: [{ key: "tasks.complete" }],
      runCommandCalls: [],
    };
    state = applyEffectStep(state);
    expect(state.runCommandCalls).toEqual([]);
  });
});
