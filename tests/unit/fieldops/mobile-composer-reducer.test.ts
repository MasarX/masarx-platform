import {
  composerHasUnsavedWork,
  composerIsSubmittable,
  composerReducer,
  composerRequiresPhoto,
  createComposerInitialState,
  type ComposerAction,
  type ComposerArtifactEntry,
  type ComposerCommand,
  type ComposerState,
} from "../../../apps/fieldops/src/mobile-composer-reducer";

function makeCommand(
  overrides: Partial<ComposerCommand> = {},
): ComposerCommand {
  return {
    key: "tasks.complete",
    inputFields: [
      { key: "notes", type: "textarea", required: true },
      { key: "handover", type: "lookup", required: false },
    ],
    ...overrides,
  };
}

function makeArtifact(
  overrides: Partial<ComposerArtifactEntry> = {},
): ComposerArtifactEntry {
  return {
    localId: "local-1",
    artifactId: null,
    storageKey: "storage/photo-1.jpg",
    capturedAt: "2026-04-21T10:00:00.000Z",
    kind: "photo",
    mimeType: "image/jpeg",
    ...overrides,
  };
}

describe("fieldops mobile composer reducer", () => {
  test("createComposerInitialState returns a fresh, independent snapshot", () => {
    const a = createComposerInitialState();
    const b = createComposerInitialState();
    expect(a).toEqual({
      command: null,
      values: {},
      artifacts: [],
      signatureStrokes: [],
      cameraOpen: false,
      submitting: false,
      error: null,
      podPolicy: null,
      lastReceipt: null,
    });
    expect(a).not.toBe(b);
    expect(a.values).not.toBe(b.values);
    expect(a.artifacts).not.toBe(b.artifacts);
    expect(a.signatureStrokes).not.toBe(b.signatureStrokes);
  });

  test("OPEN sets command and clones initial values, clearing prior state", () => {
    const command = makeCommand();
    const dirty: ComposerState = {
      ...createComposerInitialState(),
      artifacts: [makeArtifact()],
      signatureStrokes: [[{ x: 1, y: 1 }]],
      cameraOpen: true,
      error: "prev",
    };
    const inputValues = { notes: "seed", handover: "mailroom" };
    const next = composerReducer(dirty, {
      type: "OPEN",
      command,
      initialValues: inputValues,
    });

    expect(next.command).toEqual(command);
    expect(next.values).toEqual({ notes: "seed", handover: "mailroom" });
    expect(next.values).not.toBe(inputValues);
    expect(next.artifacts).toEqual([]);
    expect(next.signatureStrokes).toEqual([]);
    expect(next.cameraOpen).toBe(false);
    expect(next.error).toBeNull();
    expect(next.submitting).toBe(false);

    // mutating the input values after OPEN must not bleed into reducer state.
    inputValues.notes = "mutated";
    expect(next.values.notes).toBe("seed");
  });

  test("OPEN tolerates a null command and undefined initial values", () => {
    const next = composerReducer(createComposerInitialState(), {
      type: "OPEN",
      command: null,
      initialValues: {},
    });
    expect(next.command).toBeNull();
    expect(next.values).toEqual({});
  });

  test("RESET returns a fresh initial state and is not the same reference", () => {
    const open = composerReducer(createComposerInitialState(), {
      type: "OPEN",
      command: makeCommand(),
      initialValues: { notes: "hi" },
    });
    const reset = composerReducer(open, { type: "RESET" });
    expect(reset).toEqual(createComposerInitialState());
    expect(reset).not.toBe(open);
  });

  test("SET_FIELD shallow-merges without mutating the previous values map", () => {
    const initial: ComposerState = {
      ...createComposerInitialState(),
      values: { notes: "first" },
    };
    const next = composerReducer(initial, {
      type: "SET_FIELD",
      key: "handover",
      value: "mailroom",
    });
    expect(next.values).toEqual({ notes: "first", handover: "mailroom" });
    expect(initial.values).toEqual({ notes: "first" });
    expect(next.values).not.toBe(initial.values);
  });

  test("SET_FIELD overwrites an existing key without touching others", () => {
    const initial: ComposerState = {
      ...createComposerInitialState(),
      values: { notes: "old", handover: "mailroom" },
    };
    const next = composerReducer(initial, {
      type: "SET_FIELD",
      key: "notes",
      value: "new",
    });
    expect(next.values).toEqual({ notes: "new", handover: "mailroom" });
  });

  test("ADD_ARTIFACT appends immutably", () => {
    const first = makeArtifact({ localId: "a-1" });
    const second = makeArtifact({
      localId: "a-2",
      kind: "signature",
      mimeType: "image/png",
      storageKey: "storage/sig.png",
    });
    const afterFirst = composerReducer(createComposerInitialState(), {
      type: "ADD_ARTIFACT",
      artifact: first,
    });
    const afterSecond = composerReducer(afterFirst, {
      type: "ADD_ARTIFACT",
      artifact: second,
    });
    expect(afterFirst.artifacts).toEqual([first]);
    expect(afterSecond.artifacts).toEqual([first, second]);
    expect(afterSecond.artifacts).not.toBe(afterFirst.artifacts);
  });

  test("REMOVE_ARTIFACT filters by localId and is a no-op when no match", () => {
    const keep = makeArtifact({ localId: "keep" });
    const drop = makeArtifact({ localId: "drop" });
    const base: ComposerState = {
      ...createComposerInitialState(),
      artifacts: [keep, drop],
    };
    const removed = composerReducer(base, {
      type: "REMOVE_ARTIFACT",
      localId: "drop",
    });
    expect(removed.artifacts).toEqual([keep]);

    const unchanged = composerReducer(removed, {
      type: "REMOVE_ARTIFACT",
      localId: "does-not-exist",
    });
    expect(unchanged.artifacts).toEqual([keep]);
  });

  test("APPEND_SIGNATURE_POINT creates first stroke when none exists", () => {
    const next = composerReducer(createComposerInitialState(), {
      type: "APPEND_SIGNATURE_POINT",
      point: { x: 10, y: 20 },
    });
    expect(next.signatureStrokes).toEqual([[{ x: 10, y: 20 }]]);
  });

  test("APPEND_SIGNATURE_POINT with start=true starts a new stroke", () => {
    const afterFirst = composerReducer(createComposerInitialState(), {
      type: "APPEND_SIGNATURE_POINT",
      point: { x: 1, y: 1 },
      start: true,
    });
    const afterSecondPoint = composerReducer(afterFirst, {
      type: "APPEND_SIGNATURE_POINT",
      point: { x: 2, y: 2 },
    });
    const afterNewStroke = composerReducer(afterSecondPoint, {
      type: "APPEND_SIGNATURE_POINT",
      point: { x: 5, y: 5 },
      start: true,
    });

    expect(afterFirst.signatureStrokes).toEqual([[{ x: 1, y: 1 }]]);
    expect(afterSecondPoint.signatureStrokes).toEqual([
      [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    ]);
    expect(afterNewStroke.signatureStrokes).toEqual([
      [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
      [{ x: 5, y: 5 }],
    ]);
  });

  test("APPEND_SIGNATURE_POINT without start extends the last stroke", () => {
    const base: ComposerState = {
      ...createComposerInitialState(),
      signatureStrokes: [[{ x: 0, y: 0 }]],
    };
    const next = composerReducer(base, {
      type: "APPEND_SIGNATURE_POINT",
      point: { x: 3, y: 4 },
    });
    expect(next.signatureStrokes).toEqual([
      [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ],
    ]);
    // original stroke must not have been mutated.
    expect(base.signatureStrokes[0]).toEqual([{ x: 0, y: 0 }]);
  });

  test("CLEAR_SIGNATURE wipes strokes but preserves other state fields", () => {
    const base: ComposerState = {
      ...createComposerInitialState(),
      command: makeCommand(),
      values: { notes: "keep" },
      signatureStrokes: [[{ x: 1, y: 1 }]],
    };
    const next = composerReducer(base, { type: "CLEAR_SIGNATURE" });
    expect(next.signatureStrokes).toEqual([]);
    expect(next.command).toEqual(makeCommand());
    expect(next.values).toEqual({ notes: "keep" });
  });

  test("CLEAR_SIGNATURE is a no-op when strokes are already empty", () => {
    const base = createComposerInitialState();
    const next = composerReducer(base, { type: "CLEAR_SIGNATURE" });
    expect(next).toBe(base);
  });

  test("OPEN_CAMERA / CLOSE_CAMERA toggle the camera flag and avoid needless clones", () => {
    const base = createComposerInitialState();
    const opened = composerReducer(base, { type: "OPEN_CAMERA" });
    const stillOpen = composerReducer(opened, { type: "OPEN_CAMERA" });
    const closed = composerReducer(opened, { type: "CLOSE_CAMERA" });
    const stillClosed = composerReducer(base, { type: "CLOSE_CAMERA" });
    expect(opened.cameraOpen).toBe(true);
    expect(stillOpen).toBe(opened);
    expect(closed.cameraOpen).toBe(false);
    expect(stillClosed).toBe(base);
  });

  test("SUBMIT_START flips submitting on and clears error", () => {
    const base: ComposerState = {
      ...createComposerInitialState(),
      error: "old error",
    };
    const next = composerReducer(base, { type: "SUBMIT_START" });
    expect(next.submitting).toBe(true);
    expect(next.error).toBeNull();
  });

  test("SUBMIT_SUCCESS resets to initial but preserves the receipt", () => {
    const command = makeCommand();
    const midFlight: ComposerState = {
      ...createComposerInitialState(),
      command,
      values: { notes: "done" },
      artifacts: [makeArtifact()],
      signatureStrokes: [[{ x: 1, y: 1 }]],
      submitting: true,
    };
    const receipt = {
      status: "queued",
      queueId: "q-123",
      detail: "Task accepted",
    };
    const next = composerReducer(midFlight, {
      type: "SUBMIT_SUCCESS",
      receipt,
    });
    expect(next).toEqual({
      ...createComposerInitialState(),
      lastReceipt: receipt,
    });
    expect(next.submitting).toBe(false);
    expect(next.command).toBeNull();
    expect(next.values).toEqual({});
  });

  test("SUBMIT_SUCCESS tolerates a null receipt", () => {
    const next = composerReducer(
      { ...createComposerInitialState(), submitting: true },
      { type: "SUBMIT_SUCCESS", receipt: null },
    );
    expect(next.lastReceipt).toBeNull();
    expect(next.submitting).toBe(false);
  });

  test("SUBMIT_FAILURE marks error and turns submitting off", () => {
    const base: ComposerState = {
      ...createComposerInitialState(),
      submitting: true,
    };
    const next = composerReducer(base, {
      type: "SUBMIT_FAILURE",
      error: "network timeout",
    });
    expect(next.submitting).toBe(false);
    expect(next.error).toBe("network timeout");
  });

  test("SET_POD_POLICY coerces non-boolean flags safely", () => {
    const next = composerReducer(createComposerInitialState(), {
      type: "SET_POD_POLICY",
      pending: true,
      unavailable: false,
    });
    expect(next.podPolicy).toEqual({ pending: true, unavailable: false });

    const again = composerReducer(next, {
      type: "SET_POD_POLICY",
      pending: false,
      unavailable: true,
    });
    expect(again.podPolicy).toEqual({ pending: false, unavailable: true });
  });

  test("SET_ERROR updates and clears the error string", () => {
    const withError = composerReducer(createComposerInitialState(), {
      type: "SET_ERROR",
      error: "boom",
    });
    expect(withError.error).toBe("boom");
    const cleared = composerReducer(withError, {
      type: "SET_ERROR",
      error: null,
    });
    expect(cleared.error).toBeNull();
  });

  test("unknown actions return the same reference", () => {
    const base = createComposerInitialState();
    // Cast via unknown to simulate an out-of-band runtime action.
    const next = composerReducer(
      base,
      { type: "__UNKNOWN__" } as unknown as ComposerAction,
    );
    expect(next).toBe(base);
  });

  test("composerHasUnsavedWork is false on initial state", () => {
    expect(composerHasUnsavedWork(createComposerInitialState())).toBe(false);
  });

  test("composerHasUnsavedWork is false for empty-string values but true for populated ones", () => {
    const emptyValues: ComposerState = {
      ...createComposerInitialState(),
      values: { notes: "", handover: "" },
    };
    expect(composerHasUnsavedWork(emptyValues)).toBe(false);

    const populatedValues: ComposerState = {
      ...createComposerInitialState(),
      values: { notes: "something" },
    };
    expect(composerHasUnsavedWork(populatedValues)).toBe(true);
  });

  test("composerHasUnsavedWork detects artifacts and signature strokes", () => {
    const withArtifact: ComposerState = {
      ...createComposerInitialState(),
      artifacts: [makeArtifact()],
    };
    const withSig: ComposerState = {
      ...createComposerInitialState(),
      signatureStrokes: [[{ x: 1, y: 1 }]],
    };
    expect(composerHasUnsavedWork(withArtifact)).toBe(true);
    expect(composerHasUnsavedWork(withSig)).toBe(true);
  });

  test("composerRequiresPhoto returns false when no command is active", () => {
    expect(
      composerRequiresPhoto(createComposerInitialState(), {
        photo_required: true,
      }),
    ).toBe(false);
  });

  test("composerRequiresPhoto returns false when requirements are null", () => {
    const state: ComposerState = {
      ...createComposerInitialState(),
      command: makeCommand(),
    };
    expect(composerRequiresPhoto(state, null)).toBe(false);
  });

  test("composerRequiresPhoto returns true only when photo_required is explicitly true", () => {
    const state: ComposerState = {
      ...createComposerInitialState(),
      command: makeCommand(),
    };
    expect(composerRequiresPhoto(state, { photo_required: false })).toBe(false);
    expect(composerRequiresPhoto(state, {})).toBe(false);
    expect(composerRequiresPhoto(state, { photo_required: true })).toBe(true);
  });

  test("composerIsSubmittable is false when no command is set", () => {
    expect(composerIsSubmittable(createComposerInitialState())).toBe(false);
  });

  test("composerIsSubmittable is false while submitting", () => {
    const state: ComposerState = {
      ...createComposerInitialState(),
      command: makeCommand(),
      values: { notes: "done" },
      submitting: true,
    };
    expect(composerIsSubmittable(state)).toBe(false);
  });

  test("composerIsSubmittable is false when required fields are empty or missing", () => {
    const missing: ComposerState = {
      ...createComposerInitialState(),
      command: makeCommand(),
      values: {},
    };
    expect(composerIsSubmittable(missing)).toBe(false);

    const empty: ComposerState = {
      ...createComposerInitialState(),
      command: makeCommand(),
      values: { notes: "" },
    };
    expect(composerIsSubmittable(empty)).toBe(false);
  });

  test("composerIsSubmittable ignores optional fields", () => {
    const state: ComposerState = {
      ...createComposerInitialState(),
      command: makeCommand(),
      // handover is optional and intentionally missing.
      values: { notes: "done" },
    };
    expect(composerIsSubmittable(state)).toBe(true);
  });

  test("composerIsSubmittable is false when pod policy is pending or unavailable", () => {
    const base: ComposerState = {
      ...createComposerInitialState(),
      command: makeCommand(),
      values: { notes: "done" },
    };
    expect(
      composerIsSubmittable({
        ...base,
        podPolicy: { pending: true, unavailable: false },
      }),
    ).toBe(false);
    expect(
      composerIsSubmittable({
        ...base,
        podPolicy: { pending: false, unavailable: true },
      }),
    ).toBe(false);
    expect(
      composerIsSubmittable({
        ...base,
        podPolicy: { pending: false, unavailable: false },
      }),
    ).toBe(true);
  });

  test("composerIsSubmittable handles commands with zero inputFields", () => {
    const state: ComposerState = {
      ...createComposerInitialState(),
      command: { key: "tasks.close_route", inputFields: [] },
    };
    expect(composerIsSubmittable(state)).toBe(true);
  });
});
