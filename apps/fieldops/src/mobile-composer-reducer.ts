/**
 * Pure TypeScript state machine for the Field Ops action composer.
 *
 * The runtime composer lives inside the (very large) `App.tsx` of the Field Ops
 * Expo app. That render function currently drives a handful of `useState` hooks
 * in parallel (values, artifacts, signature strokes, camera visibility,
 * submitting state, POD policy, receipt, error). Keeping the transitions in
 * plain TS makes them cheap to unit-test and lets the React layer be swapped to
 * `useReducer(composerReducer, createComposerInitialState())` without touching
 * any runtime behaviour.
 *
 * The module intentionally avoids importing React / React Native / Expo / DOM
 * types so it can be consumed from any JS environment (tests, worker scripts,
 * future server-rendered previews, etc.).
 */

export type ComposerKind =
  | "tasks.complete"
  | "tasks.exception"
  | "tasks.arrived"
  | "tasks.en_route"
  | "tasks.close_route";

export type ComposerInputFieldType = "text" | "textarea" | "lookup" | "number";

export type ComposerInputField = {
  key: string;
  type: ComposerInputFieldType;
  required: boolean;
};

export type ComposerCommand = {
  key: ComposerKind;
  inputFields: ComposerInputField[];
};

export type ComposerArtifactKind = "photo" | "signature";

export type ComposerArtifactEntry = {
  localId: string;
  artifactId: string | null;
  storageKey: string;
  capturedAt: string;
  kind: ComposerArtifactKind;
  mimeType: string;
};

export type ComposerSignaturePoint = { x: number; y: number };

export type ComposerSignatureStroke = ComposerSignaturePoint[];

export type ComposerPodPolicy = {
  pending: boolean;
  unavailable: boolean;
};

export type ComposerReceipt = {
  status: string;
  queueId: string;
  detail: string;
};

/**
 * The composer state is parameterized so the App.tsx host can plug in its
 * richer runtime types (UiCommandDefinition for command, ActionSubmissionReceipt
 * for receipt, server-resolved policy rows, etc.) without forcing the reducer
 * module to import React Native or app-only contracts. Default type parameters
 * keep the existing pure unit tests (and any other consumer) source-compatible.
 *
 * Keep composer values and submission state together so validation and teardown share the same state.
 *
 * `ComposerArtifactLike` is the minimal structural contract artifacts must
 * satisfy for the reducer's filtering logic to work (we only ever read
 * `kind`, `localId`, and `artifactId`). Both the reducer's narrow
 * `ComposerArtifactEntry` and the App-level richer entry satisfy this shape;
 * constraints are deliberately loose so the host can stay the SSOT for its
 * own artifact contract.
 */
export type ComposerArtifactLike = {
  kind: ComposerArtifactKind;
  localId?: string | null;
  artifactId?: string | null;
};

export type ComposerState<
  TCommand = ComposerCommand,
  TArtifact extends ComposerArtifactLike = ComposerArtifactEntry,
  TPodPolicy = ComposerPodPolicy,
  TReceipt = ComposerReceipt,
> = {
  command: TCommand | null;
  values: Record<string, string>;
  artifacts: TArtifact[];
  signatureStrokes: ComposerSignatureStroke[];
  cameraOpen: boolean;
  submitting: boolean;
  error: string | null;
  podPolicy: TPodPolicy | null;
  lastReceipt: TReceipt | null;
};

export type ComposerAction<
  TCommand = ComposerCommand,
  TArtifact extends ComposerArtifactLike = ComposerArtifactEntry,
  TPodPolicy = ComposerPodPolicy,
  TReceipt = ComposerReceipt,
> =
  | {
      type: "OPEN";
      command: TCommand | null;
      initialValues: Record<string, string>;
    }
  | { type: "RESET" }
  // SET_COMMAND lets the host swap the active command without resetting the
  // composer (keeps values/artifacts/signature in place when the underlying
  // command definition is reloaded from the registry).
  | { type: "SET_COMMAND"; command: TCommand | null }
  | { type: "SET_FIELD"; key: string; value: string }
  // Keep SET_FIELD_VALUE as a compatibility alias for SET_VALUE.
  | { type: "SET_FIELD_VALUE"; key: string; value: string }
  // SET_VALUES replaces the entire values map atomically (used when the
  // composer is opened with seed values resolved from a stop snapshot).
  | { type: "SET_VALUES"; values: Record<string, string> }
  | { type: "ADD_ARTIFACT"; artifact: TArtifact }
  // SET_ARTIFACTS replaces the artifact list atomically (used during evidence
  // rehydration so we do not have to walk a sequence of ADD_ARTIFACT actions).
  | { type: "SET_ARTIFACTS"; artifacts: TArtifact[] }
  // REPLACE_SIGNATURE_ARTIFACT atomically swaps any existing signature
  // artifact for the new entry — mirrors the App-level "drop old signature,
  // append new one" pattern that previously lived in setComposerArtifacts.
  | { type: "REPLACE_SIGNATURE_ARTIFACT"; artifact: TArtifact }
  | { type: "REMOVE_ARTIFACT"; localId: string }
  // REMOVE_ARTIFACT_BY_ID removes by `artifactId` (string), which is what the
  // composer modal uses when the user taps "Remove" on a captured photo.
  | { type: "REMOVE_ARTIFACT_BY_ID"; artifactId: string }
  | {
      type: "APPEND_SIGNATURE_POINT";
      point: ComposerSignaturePoint;
      start?: boolean;
    }
  | { type: "SET_SIGNATURE_STROKES"; strokes: ComposerSignatureStroke[] }
  | { type: "CLEAR_SIGNATURE" }
  | { type: "OPEN_CAMERA" }
  | { type: "CLOSE_CAMERA" }
  | { type: "SUBMIT_START" }
  | { type: "SET_SUBMITTING"; submitting: boolean }
  | { type: "SUBMIT_SUCCESS"; receipt: TReceipt | null }
  | { type: "SUBMIT_FAILURE"; error: string }
  | { type: "SET_POD_POLICY"; pending: boolean; unavailable: boolean }
  | { type: "SET_POD_POLICY_RAW"; policy: TPodPolicy | null }
  | { type: "SET_LAST_RECEIPT"; receipt: TReceipt | null }
  | { type: "SET_ERROR"; error: string | null };

/**
 * Build a fresh composer snapshot. Returned object is a new reference on every
 * invocation so callers can safely use it as `useReducer` initial state without
 * worrying about shared mutation.
 *
 * Generic so the App-level host can declare the full runtime shape via the
 * type parameters (UiCommandDefinition, ActionSubmissionReceipt, etc.) while
 * keeping the reducer module pure-TS and consumable from unit tests.
 */
export function createComposerInitialState<
  TCommand = ComposerCommand,
  TArtifact extends ComposerArtifactLike = ComposerArtifactEntry,
  TPodPolicy = ComposerPodPolicy,
  TReceipt = ComposerReceipt,
>(): ComposerState<TCommand, TArtifact, TPodPolicy, TReceipt> {
  return {
    command: null,
    values: {},
    artifacts: [],
    signatureStrokes: [],
    cameraOpen: false,
    submitting: false,
    error: null,
    podPolicy: null,
    lastReceipt: null,
  };
}

function cloneValues(values: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (typeof value === "string") {
      next[key] = value;
    }
  }
  return next;
}

function appendSignaturePoint(
  strokes: ComposerSignatureStroke[],
  point: ComposerSignaturePoint,
  start: boolean,
): ComposerSignatureStroke[] {
  const safePoint: ComposerSignaturePoint = { x: point.x, y: point.y };
  if (start || strokes.length === 0) {
    return [...strokes, [safePoint]];
  }
  const next = strokes.slice(0, -1);
  const lastStroke = strokes[strokes.length - 1];
  const extended: ComposerSignatureStroke = lastStroke
    ? [...lastStroke, safePoint]
    : [safePoint];
  next.push(extended);
  return next;
}

/**
 * Reducer contract. Each branch returns a brand new `ComposerState` object — no
 * input arguments are mutated. Unknown actions return the current state
 * reference so React can bail out of renders.
 *
 * Generic over the command/artifact/policy/receipt shape so the App.tsx host
 * may pass its richer runtime types without losing exhaustiveness checking.
 */
export function composerReducer<
  TCommand = ComposerCommand,
  TArtifact extends ComposerArtifactLike = ComposerArtifactEntry,
  TPodPolicy = ComposerPodPolicy,
  TReceipt = ComposerReceipt,
>(
  state: ComposerState<TCommand, TArtifact, TPodPolicy, TReceipt>,
  action: ComposerAction<TCommand, TArtifact, TPodPolicy, TReceipt>,
): ComposerState<TCommand, TArtifact, TPodPolicy, TReceipt> {
  switch (action.type) {
    case "OPEN": {
      return {
        ...createComposerInitialState<TCommand, TArtifact, TPodPolicy, TReceipt>(),
        command: action.command ?? null,
        values: cloneValues(action.initialValues ?? {}),
      };
    }
    case "RESET": {
      return createComposerInitialState<TCommand, TArtifact, TPodPolicy, TReceipt>();
    }
    case "SET_COMMAND": {
      // Shallow swap — leaves values/artifacts/signature in place. Used when
      // the registry refreshes but the user is mid-composer for the same key.
      return { ...state, command: action.command ?? null };
    }
    case "SET_FIELD":
    case "SET_FIELD_VALUE": {
      const nextValues = cloneValues(state.values);
      nextValues[action.key] = action.value;
      // Clear any prior error when the user types — mirrors the historical
      // setComposerFieldValue behavior in App.tsx.
      const nextError = state.error ? null : state.error;
      return { ...state, values: nextValues, error: nextError };
    }
    case "SET_VALUES": {
      return { ...state, values: cloneValues(action.values ?? {}) };
    }
    case "ADD_ARTIFACT": {
      return {
        ...state,
        artifacts: [...state.artifacts, action.artifact],
      };
    }
    case "SET_ARTIFACTS": {
      return {
        ...state,
        artifacts: [...action.artifacts],
      };
    }
    case "REPLACE_SIGNATURE_ARTIFACT": {
      return {
        ...state,
        artifacts: [
          ...state.artifacts.filter((entry) => entry.kind !== "signature"),
          action.artifact,
        ],
      };
    }
    case "REMOVE_ARTIFACT": {
      return {
        ...state,
        artifacts: state.artifacts.filter(
          (entry) => entry.localId !== action.localId,
        ),
      };
    }
    case "REMOVE_ARTIFACT_BY_ID": {
      return {
        ...state,
        artifacts: state.artifacts.filter(
          (entry) => entry.artifactId !== action.artifactId,
        ),
      };
    }
    case "APPEND_SIGNATURE_POINT": {
      return {
        ...state,
        signatureStrokes: appendSignaturePoint(
          state.signatureStrokes,
          action.point,
          action.start === true,
        ),
      };
    }
    case "SET_SIGNATURE_STROKES": {
      // Composer evidence must belong to the current session.
      return { ...state, signatureStrokes: [...action.strokes] };
    }
    case "CLEAR_SIGNATURE": {
      if (state.signatureStrokes.length === 0) return state;
      return { ...state, signatureStrokes: [] };
    }
    case "OPEN_CAMERA": {
      if (state.cameraOpen) return state;
      return { ...state, cameraOpen: true };
    }
    case "CLOSE_CAMERA": {
      if (!state.cameraOpen) return state;
      return { ...state, cameraOpen: false };
    }
    case "SUBMIT_START": {
      return { ...state, submitting: true, error: null };
    }
    case "SET_SUBMITTING": {
      // Keep submit state explicit so success and failure both release the submission lock.
      if (state.submitting === action.submitting) return state;
      return { ...state, submitting: action.submitting };
    }
    case "SUBMIT_SUCCESS": {
      return {
        ...createComposerInitialState<TCommand, TArtifact, TPodPolicy, TReceipt>(),
        lastReceipt: action.receipt ?? null,
      };
    }
    case "SUBMIT_FAILURE": {
      return { ...state, submitting: false, error: action.error };
    }
    case "SET_POD_POLICY": {
      return {
        ...state,
        podPolicy: {
          pending: action.pending === true,
          unavailable: action.unavailable === true,
        } as unknown as TPodPolicy,
      };
    }
    case "SET_POD_POLICY_RAW": {
      return { ...state, podPolicy: action.policy ?? null };
    }
    case "SET_LAST_RECEIPT": {
      return { ...state, lastReceipt: action.receipt ?? null };
    }
    case "SET_ERROR": {
      return { ...state, error: action.error };
    }
    default: {
      // Exhaustiveness guard — any new action type must be handled above.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

/**
 * Returns true when the composer holds work the user has not yet submitted.
 * Used by the App shell to show confirmation prompts before dismissing the
 * composer.
 *
 * Generic across the same shape so App.tsx can call it with its full state
 * without losing type safety.
 */
export function composerHasUnsavedWork<
  TCommand,
  TArtifact extends ComposerArtifactLike,
  TPodPolicy,
  TReceipt,
>(state: ComposerState<TCommand, TArtifact, TPodPolicy, TReceipt>): boolean {
  if (state.artifacts.length > 0) return true;
  if (state.signatureStrokes.length > 0) return true;
  for (const key of Object.keys(state.values)) {
    const value = state.values[key];
    if (typeof value === "string" && value.length > 0) return true;
  }
  return false;
}

/**
 * Returns true when the current command + POD requirements make a photo
 * attachment mandatory. The call site passes in the resolved POD requirements
 * (which are policy-driven and therefore supplied from outside this reducer).
 */
export function composerRequiresPhoto<
  TCommand,
  TArtifact extends ComposerArtifactLike,
  TPodPolicy,
  TReceipt,
>(
  state: ComposerState<TCommand, TArtifact, TPodPolicy, TReceipt>,
  requirements: { photo_required?: boolean } | null,
): boolean {
  if (!state.command) return false;
  if (!requirements) return false;
  return requirements.photo_required === true;
}

/**
 * Pure gate for whether the composer is ready to dispatch the underlying RPC.
 *
 * - A command must be selected.
 * - The composer must not be mid-submit.
 * - Every required input field must have a non-empty value.
 * - POD policy must not be in the `unavailable` state.
 *
 * The `pending` POD state is also blocking because the resolver is still
 * fetching requirements and submitting without them could bypass mandatory
 * proof capture.
 *
 * The default narrow `ComposerCommand` shape is preserved so existing pure
 * callers (the unit test suite) keep their current contract; specialised
 * hosts may project their richer command types and the field-required check
 * runs against the `inputFields` array if present.
 */
export function composerIsSubmittable(state: ComposerState): boolean {
  if (!state.command) return false;
  if (state.submitting) return false;
  if (state.podPolicy && state.podPolicy.unavailable) return false;
  if (state.podPolicy && state.podPolicy.pending) return false;
  for (const field of state.command.inputFields) {
    if (!field.required) continue;
    const value = state.values[field.key];
    if (typeof value !== "string" || value.length === 0) return false;
  }
  return true;
}
