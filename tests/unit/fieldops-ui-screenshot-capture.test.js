const { buildCaptureManifest, parseArgs } = require("../../scripts/qa/capture-fieldops-ui-screenshots");

describe("fieldops ui screenshot capture manifest", () => {
  test("buildCaptureManifest writes sample_static provenance", () => {
    const manifest = buildCaptureManifest({
      capturedAt: "2026-03-06T00:00:00.000Z",
      sourceDir: "/repo/docs/product/examples/mobile-field-ops-ui",
      outputDir: "/repo/docs/ops/evidence/2026-03-06/mobile-fieldops/ui-screenshots-version-c",
      baseUrl: "http://127.0.0.1:4179",
      platforms: ["android", "ios"],
      selftests: [{ platform: "android", status: "pass" }],
      scenarios: [{ name: "C-android-tasks-list", file: "C-android-tasks-list.png" }],
    });

    expect(manifest).toEqual({
      captured_at: "2026-03-06T00:00:00.000Z",
      capture_mode: "sample_static",
      source_dir: "/repo/docs/product/examples/mobile-field-ops-ui",
      output_dir: "/repo/docs/ops/evidence/2026-03-06/mobile-fieldops/ui-screenshots-version-c",
      base_url: "http://127.0.0.1:4179",
      platforms: ["android", "ios"],
      selftests: [{ platform: "android", status: "pass" }],
      scenarios: [{ name: "C-android-tasks-list", file: "C-android-tasks-list.png" }],
    });
  });

  test("parseArgs reads explicit source, output, and platforms", () => {
    expect(
      parseArgs([
        "--source-dir",
        "docs/product/examples/mobile-field-ops-ui",
        "--output-dir",
        "docs/ops/evidence/2026-03-06/mobile-fieldops/ui-screenshots-version-c",
        "--platforms",
        "android,ios",
      ])
    ).toEqual({
      "output-dir": "docs/ops/evidence/2026-03-06/mobile-fieldops/ui-screenshots-version-c",
      platforms: "android,ios",
      "source-dir": "docs/product/examples/mobile-field-ops-ui",
    });
  });
});
