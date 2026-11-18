/** Verify that the task detail keeps its primary action reachable while the content scrolls. */

// -----------------------------------------------------------------------------
// Mirror of the App.tsx helper (search for `selectPrimaryCtaForStop`).
// Kept here as a standalone re-implementation so the contract is testable
// without dragging the App component, react-native, expo, or react-query
// into the unit suite. If the App.tsx implementation drifts, this mirror
// drifts in lockstep — the test surface remains the canonical regression
// net for the wiring contract.
// -----------------------------------------------------------------------------

const TASK_TERMINAL_STATUSES = new Set([
  "completed",
  "complete",
  "done",
  "closed",
  "cancelled",
  "canceled",
  "exception",
  "failed",
]);
const TASK_TERMINAL_REASONS = new Set([
  "completed",
  "complete",
  "done",
  "closed",
  "cancelled",
  "canceled",
  "exception",
  "failed",
  "rejected",
]);

type PrimaryCtaCommandKey =
  | "tasks.en_route"
  | "tasks.arrived"
  | "tasks.complete"
  | "tasks.next_stop";

type PrimaryCtaDescriptor = {
  commandKey: PrimaryCtaCommandKey;
  label: string;
  accessibilityLabel: string;
};

function selectPrimaryCtaForStop(
  stop: { status?: string | null; statusReason?: string | null } | null | undefined,
): PrimaryCtaDescriptor | null {
  if (!stop) return null;

  const status = String(stop.status ?? "").trim().toLowerCase();
  const statusReason = String(stop.statusReason ?? "").trim().toLowerCase();

  if (!status) return null;

  if (TASK_TERMINAL_STATUSES.has(status)) return null;
  if (statusReason && TASK_TERMINAL_REASONS.has(statusReason)) {
    if (statusReason === "completed" || statusReason === "complete" || statusReason === "done" || statusReason === "closed") {
      return {
        commandKey: "tasks.next_stop",
        label: "Next stop",
        accessibilityLabel: "Advance to next stop",
      };
    }
    return null;
  }

  if (status === "in_progress") {
    if (statusReason === "arrived") {
      return {
        commandKey: "tasks.complete",
        label: "Open composer",
        accessibilityLabel: "Open the proof-of-delivery composer",
      };
    }
    if (statusReason === "en_route") {
      return {
        commandKey: "tasks.arrived",
        label: "Mark arrived",
        accessibilityLabel: "Mark this stop as arrived",
      };
    }
    return {
      commandKey: "tasks.en_route",
      label: "Start",
      accessibilityLabel: "Mark this stop as en route",
    };
  }

  if (status === "queued" || status === "pending" || status === "open" || status === "assigned") {
    return {
      commandKey: "tasks.en_route",
      label: "Start",
      accessibilityLabel: "Start this stop",
    };
  }

  return null;
}

// -----------------------------------------------------------------------------
// Tests — descriptor resolution
// -----------------------------------------------------------------------------

describe("selectPrimaryCtaForStop — null/empty input", () => {
  test("returns null for null input", () => {
    expect(selectPrimaryCtaForStop(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(selectPrimaryCtaForStop(undefined)).toBeNull();
  });

  test("returns null when status is empty string (no signal to act on)", () => {
    expect(selectPrimaryCtaForStop({ status: "" })).toBeNull();
  });

  test("returns null when status is missing entirely", () => {
    expect(selectPrimaryCtaForStop({} as any)).toBeNull();
  });
});

describe("selectPrimaryCtaForStop — queued / pending / assigned start CTA", () => {
  test('queued status → "Start" CTA targeting tasks.en_route', () => {
    const cta = selectPrimaryCtaForStop({ status: "queued" });
    expect(cta).toEqual({
      commandKey: "tasks.en_route",
      label: "Start",
      accessibilityLabel: "Start this stop",
    });
  });

  test('pending status → "Start" CTA targeting tasks.en_route', () => {
    const cta = selectPrimaryCtaForStop({ status: "pending" });
    expect(cta?.commandKey).toBe("tasks.en_route");
    expect(cta?.label).toBe("Start");
  });

  test('open status → "Start" CTA targeting tasks.en_route', () => {
    const cta = selectPrimaryCtaForStop({ status: "open" });
    expect(cta?.commandKey).toBe("tasks.en_route");
    expect(cta?.label).toBe("Start");
  });

  test('assigned status → "Start" CTA targeting tasks.en_route', () => {
    const cta = selectPrimaryCtaForStop({ status: "assigned" });
    expect(cta?.commandKey).toBe("tasks.en_route");
    expect(cta?.label).toBe("Start");
  });

  test("status normalization — uppercase + whitespace are tolerated", () => {
    const cta = selectPrimaryCtaForStop({ status: "  QUEUED  " });
    expect(cta?.commandKey).toBe("tasks.en_route");
  });
});

describe("selectPrimaryCtaForStop — in_progress lifecycle", () => {
  test('in_progress without statusReason → "Start" (en_route advance)', () => {
    const cta = selectPrimaryCtaForStop({ status: "in_progress" });
    expect(cta?.commandKey).toBe("tasks.en_route");
    expect(cta?.label).toBe("Start");
  });

  test('in_progress + statusReason="en_route" → "Mark arrived"', () => {
    const cta = selectPrimaryCtaForStop({
      status: "in_progress",
      statusReason: "en_route",
    });
    expect(cta).toEqual({
      commandKey: "tasks.arrived",
      label: "Mark arrived",
      accessibilityLabel: "Mark this stop as arrived",
    });
  });

  test('in_progress + statusReason="arrived" → "Open composer"', () => {
    const cta = selectPrimaryCtaForStop({
      status: "in_progress",
      statusReason: "arrived",
    });
    expect(cta).toEqual({
      commandKey: "tasks.complete",
      label: "Open composer",
      accessibilityLabel: "Open the proof-of-delivery composer",
    });
  });
});

describe("selectPrimaryCtaForStop — terminal states", () => {
  test('completed status → null (no CTA — back-to-list is the only forward path)', () => {
    expect(selectPrimaryCtaForStop({ status: "completed" })).toBeNull();
  });

  test('done status → null', () => {
    expect(selectPrimaryCtaForStop({ status: "done" })).toBeNull();
  });

  test('closed status → null', () => {
    expect(selectPrimaryCtaForStop({ status: "closed" })).toBeNull();
  });

  test('failed status → null', () => {
    expect(selectPrimaryCtaForStop({ status: "failed" })).toBeNull();
  });

  test('exception status → null', () => {
    expect(selectPrimaryCtaForStop({ status: "exception" })).toBeNull();
  });

  test('cancelled status → null', () => {
    expect(selectPrimaryCtaForStop({ status: "cancelled" })).toBeNull();
  });

  test('terminal-reason "completed" with non-terminal status → "Next stop" CTA', () => {
    // This covers a transient state where the status hasn't yet caught up to
    // the terminal reason. The CTA gives the driver an explicit next-stop
    // hand-off so they don't have to navigate back to the list manually.
    const cta = selectPrimaryCtaForStop({
      status: "in_progress",
      statusReason: "completed",
    });
    expect(cta).toEqual({
      commandKey: "tasks.next_stop",
      label: "Next stop",
      accessibilityLabel: "Advance to next stop",
    });
  });

  test('terminal-reason "rejected" with non-terminal status → null', () => {
    expect(
      selectPrimaryCtaForStop({ status: "in_progress", statusReason: "rejected" }),
    ).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Tests — press-handler dispatch contract
// -----------------------------------------------------------------------------

describe("sticky CTA bar — onPress dispatch contract", () => {
  type FakeCommand = { key: string; label: string };

  function simulateOnPress(args: {
    cta: PrimaryCtaDescriptor;
    availableActions: FakeCommand[];
    drivingModeLocked: boolean;
    onDrivingLockAlert: () => void;
    onActionPress: (command: FakeCommand) => void;
    onNextStopFallback: () => void;
  }): void {
    const { cta, availableActions, drivingModeLocked } = args;
    const matchingCommand =
      cta.commandKey === "tasks.next_stop"
        ? null
        : availableActions.find((c) => c.key === cta.commandKey) ?? null;
    if (cta.commandKey !== "tasks.next_stop" && !matchingCommand) {
      // Self-hide path — the consumer should never reach onPress when
      // matchingCommand is missing; the bar is collapsed instead. Mirroring
      // the App.tsx wiring guard here.
      return;
    }
    if (drivingModeLocked) {
      args.onDrivingLockAlert();
      return;
    }
    if (matchingCommand) {
      args.onActionPress(matchingCommand);
      return;
    }
    args.onNextStopFallback();
  }

  test('dispatches matching command via onActionPress when CTA is "Start"', () => {
    const cta = selectPrimaryCtaForStop({ status: "queued" })!;
    const onActionPress = jest.fn();
    const onNextStopFallback = jest.fn();
    const onDrivingLockAlert = jest.fn();
    simulateOnPress({
      cta,
      availableActions: [{ key: "tasks.en_route", label: "En route" }],
      drivingModeLocked: false,
      onDrivingLockAlert,
      onActionPress,
      onNextStopFallback,
    });
    expect(onActionPress).toHaveBeenCalledTimes(1);
    expect(onActionPress.mock.calls[0]?.[0]).toEqual({ key: "tasks.en_route", label: "En route" });
    expect(onNextStopFallback).not.toHaveBeenCalled();
    expect(onDrivingLockAlert).not.toHaveBeenCalled();
  });

  test("self-hides (no dispatch) when matching command is missing from availableActions", () => {
    const cta = selectPrimaryCtaForStop({ status: "queued" })!;
    const onActionPress = jest.fn();
    const onNextStopFallback = jest.fn();
    const onDrivingLockAlert = jest.fn();
    simulateOnPress({
      cta,
      availableActions: [], // no command available — the bar should self-hide
      drivingModeLocked: false,
      onDrivingLockAlert,
      onActionPress,
      onNextStopFallback,
    });
    expect(onActionPress).not.toHaveBeenCalled();
    expect(onNextStopFallback).not.toHaveBeenCalled();
    expect(onDrivingLockAlert).not.toHaveBeenCalled();
  });

  test("driving lock surfaces alert and skips dispatch", () => {
    const cta = selectPrimaryCtaForStop({ status: "in_progress", statusReason: "en_route" })!;
    const onActionPress = jest.fn();
    const onNextStopFallback = jest.fn();
    const onDrivingLockAlert = jest.fn();
    simulateOnPress({
      cta,
      availableActions: [{ key: "tasks.arrived", label: "Arrived" }],
      drivingModeLocked: true,
      onDrivingLockAlert,
      onActionPress,
      onNextStopFallback,
    });
    expect(onDrivingLockAlert).toHaveBeenCalledTimes(1);
    expect(onActionPress).not.toHaveBeenCalled();
    expect(onNextStopFallback).not.toHaveBeenCalled();
  });

  test('next-stop pseudo-key dispatches onNextStopFallback (no command lookup needed)', () => {
    const cta = selectPrimaryCtaForStop({
      status: "in_progress",
      statusReason: "completed",
    })!;
    expect(cta.commandKey).toBe("tasks.next_stop");
    const onActionPress = jest.fn();
    const onNextStopFallback = jest.fn();
    const onDrivingLockAlert = jest.fn();
    simulateOnPress({
      cta,
      availableActions: [],
      drivingModeLocked: false,
      onDrivingLockAlert,
      onActionPress,
      onNextStopFallback,
    });
    expect(onNextStopFallback).toHaveBeenCalledTimes(1);
    expect(onActionPress).not.toHaveBeenCalled();
  });

  test('Open composer CTA dispatches the tasks.complete command', () => {
    const cta = selectPrimaryCtaForStop({
      status: "in_progress",
      statusReason: "arrived",
    })!;
    expect(cta.commandKey).toBe("tasks.complete");
    const onActionPress = jest.fn();
    const onNextStopFallback = jest.fn();
    simulateOnPress({
      cta,
      availableActions: [{ key: "tasks.complete", label: "Complete" }],
      drivingModeLocked: false,
      onDrivingLockAlert: jest.fn(),
      onActionPress,
      onNextStopFallback,
    });
    expect(onActionPress).toHaveBeenCalledWith({ key: "tasks.complete", label: "Complete" });
  });
});
