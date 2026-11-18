import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveEvidenceDir, resolveEvidencePath } from "../e2e/utils/evidence";

describe("browser evidence paths", () => {
  const originalOutputDir = process.env.PLAYWRIGHT_TEST_OUTPUT_DIR;

  afterEach(() => {
    if (originalOutputDir === undefined) {
      delete process.env.PLAYWRIGHT_TEST_OUTPUT_DIR;
    } else {
      process.env.PLAYWRIGHT_TEST_OUTPUT_DIR = originalOutputDir;
    }
    jest.useRealTimers();
  });

  test("trims and isolates capture evidence under the configured Playwright output", () => {
    const outputRoot = path.join(process.cwd(), ".tmp", "playwright-output");
    process.env.PLAYWRIGHT_TEST_OUTPUT_DIR = "  " + outputRoot + "  ";

    expect(resolveEvidenceDir("console-capture")).toBe(
      path.resolve(outputRoot, "screenshots", "console-capture"),
    );
  });

  test.each([undefined, "   "])(
    "retains the dated durable fallback for output root %p",
    (outputRoot) => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
      if (outputRoot === undefined) delete process.env.PLAYWRIGHT_TEST_OUTPUT_DIR;
      else process.env.PLAYWRIGHT_TEST_OUTPUT_DIR = outputRoot;

      expect(resolveEvidenceDir("manual-capture")).toBe(
        path.join(
          process.cwd(),
          "docs",
          "ops",
          "evidence",
          "2026-08-31",
          "manual-capture",
        ),
      );
    },
  );

  test.each([
    ["group traversal", () => resolveEvidenceDir("../escape")],
    ["absolute group", () => resolveEvidenceDir(path.parse(process.cwd()).root)],
    ["RPC segment traversal", () => resolveEvidencePath("capture", "../rpc.png")],
    [
      "absolute segment",
      () => resolveEvidencePath("capture", path.resolve(os.tmpdir(), "rpc.png")),
    ],
  ])("rejects %s", (_label, resolve) => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-evidence-path-"));
    process.env.PLAYWRIGHT_TEST_OUTPUT_DIR = outputRoot;
    try {
      expect(resolve).toThrow("e2e_evidence_path_outside_root");
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test("rejects a symbolic-link directory parent", () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-evidence-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-evidence-outside-"));
    process.env.PLAYWRIGHT_TEST_OUTPUT_DIR = outputRoot;
    const screenshots = path.join(outputRoot, "screenshots");
    const group = path.join(screenshots, "capture");
    fs.mkdirSync(screenshots, { recursive: true });
    fs.symlinkSync(outside, group, process.platform === "win32" ? "junction" : "dir");

    try {
      expect(() => resolveEvidencePath("capture", "screen.png"))
        .toThrow("e2e_evidence_directory_parent_invalid");
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  (process.platform === "win32" ? test.skip : test)("rejects a symbolic-link output file", () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-evidence-file-root-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-evidence-file-outside-"));
    const outside = path.join(outsideRoot, "outside.png");
    process.env.PLAYWRIGHT_TEST_OUTPUT_DIR = outputRoot;
    fs.writeFileSync(outside, "outside");
    const target = resolveEvidencePath("capture", "screen.png");
    fs.symlinkSync(outside, target);

    try {
      expect(() => resolveEvidencePath("capture", "screen.png"))
        .toThrow("e2e_evidence_output_symlink");
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
