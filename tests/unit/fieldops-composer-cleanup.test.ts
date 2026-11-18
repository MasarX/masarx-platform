// Verify composer reducer contracts and the receiving submission lock.

import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_TSX_PATH = path.join(REPO_ROOT, "apps", "fieldops", "App.tsx");
const REDUCER_PATH = path.join(
  REPO_ROOT,
  "apps",
  "fieldops",
  "src",
  "mobile-composer-reducer.ts"
);
let appSource = "";
let reducerSource = "";

beforeAll(() => {
  appSource = fs.readFileSync(APP_TSX_PATH, "utf8");
  reducerSource = fs.readFileSync(REDUCER_PATH, "utf8");
});

describe("composerReducer covers all composer fields with discriminated actions", () => {
  test("ComposerState declares all required fields", () => {
    for (const field of [
      "command:",
      "values:",
      "artifacts:",
      "signatureStrokes:",
      "cameraOpen:",
      "submitting:",
      "error:",
      "podPolicy:",
      "lastReceipt:",
    ]) {
      expect(reducerSource).toContain(field);
    }
  });

  test("ComposerAction discriminated union covers every required action type", () => {
    const requiredActions = [
      'type: "OPEN"',
      'type: "RESET"',
      'type: "SET_COMMAND"',
      'type: "SET_FIELD"',
      'type: "SET_FIELD_VALUE"',
      'type: "SET_VALUES"',
      'type: "ADD_ARTIFACT"',
      'type: "SET_ARTIFACTS"',
      'type: "REPLACE_SIGNATURE_ARTIFACT"',
      'type: "REMOVE_ARTIFACT"',
      'type: "REMOVE_ARTIFACT_BY_ID"',
      'type: "APPEND_SIGNATURE_POINT"',
      'type: "SET_SIGNATURE_STROKES"',
      'type: "CLEAR_SIGNATURE"',
      'type: "OPEN_CAMERA"',
      'type: "CLOSE_CAMERA"',
      'type: "SUBMIT_START"',
      'type: "SET_SUBMITTING"',
      'type: "SUBMIT_SUCCESS"',
      'type: "SUBMIT_FAILURE"',
      'type: "SET_POD_POLICY"',
      'type: "SET_LAST_RECEIPT"',
      'type: "SET_ERROR"',
    ];
    for (const action of requiredActions) {
      expect(reducerSource).toContain(action);
    }
  });

  test("composerReducer exhaustiveness guard remains in place", () => {
    expect(reducerSource).toContain("const _exhaustive: never = action;");
  });
});

describe("Composer submission lock", () => {
  let submitComposer = "";

  beforeAll(() => {
    const start = appSource.indexOf("const submitComposer = React.useCallback");
    const end = appSource.indexOf("const handleActionPress", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    submitComposer = appSource.slice(start, end);
  });

  test("rejects a repeated tap before submitting", () => {
    expect(submitComposer).toMatch(/if \(!composerCommand \|\| composerSubmitInFlight\.current\b/);
  });

  test("locks before confirmation or asynchronous submission on both paths", () => {
    expect(submitComposer.match(/composerSubmitInFlight\.current = true;[^{}]*?\btry\s*\{/g)).toHaveLength(2);
  });

  test("releases the lock in finally on both paths", () => {
    expect(submitComposer.match(/finally\s*\{\s*composerSubmitInFlight\.current = false;/g)).toHaveLength(2);
  });

  test("reports submission errors while the originating composer is still active", () => {
    expect(submitComposer).toMatch(
      /catch\s*\{\s*if \(admitted\(\) && epoch === composerCaptureEpoch\.current\) setComposerError\(/
    );
    expect(submitComposer).toMatch(
      /catch \(error\)\s*\{\s*if \(submitEpoch !== composerCaptureEpoch\.current\) return;\s*setComposerError\(/
    );
  });
});
