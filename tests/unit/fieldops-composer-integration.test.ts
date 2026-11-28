import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_TSX_PATH = path.join(REPO_ROOT, "apps", "fieldops", "App.tsx");
let appSource = "";

beforeAll(() => {
  appSource = fs.readFileSync(APP_TSX_PATH, "utf8");
});

describe("Composer integration", () => {
  function section(startName: string, endName: string) {
    const start = appSource.indexOf(startName);
    const end = appSource.indexOf(endName, start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return appSource.slice(start, end);
  }

  test("opens a command with its field defaults and clears the previous capture", () => {
    const open = section("const runCommand = React.useCallback", "const validateComposer");
    expect(open).toMatch(/resolveComposerFieldDefaultValue\(field, selectedStopSnapshot\)[\s\S]*?setComposerValues\(initial\);/);
    expect(open).toMatch(
      /setComposerArtifacts\(\[\]\);\s*setComposerCameraOpen\(false\);\s*composerSignatureStrokeRef\.current = null;\s*setComposerSignatureStrokes\(\[\]\);\s*setComposerError\(null\);\s*setComposerCommand\(command\);/
    );
  });

  test("reset invalidates pending capture before clearing command and evidence state", () => {
    const reset = section("const resetComposer = React.useCallback", "const registerComposerArtifact");
    expect(reset).toMatch(/composerCaptureEpoch\.current \+= 1;[\s\S]*?setComposerCommand\(null\);/);
    expect(reset).toContain("setComposerEvidenceRows([]);");
    expect(reset).toContain("setComposerArtifacts([]);");
    expect(reset).toContain("setComposerSignatureStrokes([]);");
    expect(reset).toContain("setComposerSubmitting(false);");
  });

  test("discards unfinished strokes when the app goes to the background", () => {
    const signature = section("const clearComposerSignature", "const composerSignatureResponder");
    expect(signature).toMatch(
      /AppState\.addEventListener\("change", state => \{\s*if \(state === "background"\) \{\s*composerSignatureStrokeRef\.current = null;\s*setComposerSignatureStrokes\(\[\]\);/
    );
    expect(signature).toContain("return () => subscription.remove();");
  });

  test("stages the captured signature in scoped evidence before attempting registration", () => {
    const capture = section("const captureComposerSignature = React.useCallback", "const removeComposerArtifact");
    const register = section("const registerComposerArtifact = React.useCallback", "const captureComposerArtifact");
    expect(capture).toMatch(
      /await registerComposerArtifact\(\{[\s\S]*?kind: "signature",\s*captureEpoch,[\s\S]*?if \(captureEpoch !== composerCaptureEpoch\.current\) return;\s*clearComposerSignature\(\);/
    );
    expect(register).toMatch(
      /await pendingEvidence\.stage\(composerEvidenceScope, \{[\s\S]*?kind: input\.kind,[\s\S]*?bytes: encodeEvidenceBytes\(input\.bytes\)[\s\S]*?await settleComposerEvidence\(id\)/
    );
  });

  test("reopening restores registered proof for the same organization, actor and task", () => {
    const scope = section("const composerEvidenceSubject", "const evidenceLifecycle");
    expect(scope).toContain("composerSelfEvidence ? sessionUserId : selectedResourceId");
    expect(scope).toMatch(/organizationId: composerOrganizationId,\s*actorId: sessionUserId,\s*subjectId: composerEvidenceSubject,/);
    const refresh = section("const refreshComposerEvidence", "const settleComposerEvidence");
    expect(refresh).toMatch(
      /await pendingEvidence\.list\(composerEvidenceScope\);\s*if \(epoch !== composerCaptureEpoch\.current\) return;\s*setComposerEvidenceRows\(rows\);\s*setComposerArtifacts\(rows\.flatMap\(row => row\.phase === "registered" && row\.artifactId/
    );
    expect(refresh).toMatch(/if \(composerSupportsEvidence && composerEvidenceScope\) \{\s*void refreshComposerEvidence\(epoch\)/);
  });
});
