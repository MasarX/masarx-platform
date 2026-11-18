import * as fs from "fs";
import * as path from "path";
import { type Locator, type Page } from "@playwright/test";
import { isTruthy } from "./env";

const deterministicCss = `
  *,
  *::before,
  *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }
`;

function assertContained(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("e2e_evidence_path_outside_root");
  }
  return candidate;
}

function ensureDirectoryWithoutSymlinks(directory: string) {
  let current = path.parse(directory).root;
  const segments = path.relative(current, directory).split(path.sep).filter(Boolean);

  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("e2e_evidence_directory_parent_invalid");
    }
  }
}

async function stabilizePage(page: Page) {
  try {
    await page.addStyleTag({ content: deterministicCss });
  } catch {
    // Ignore style injection failures (e.g., navigation races).
  }
}

export function isCaptureEnabled() {
  return isTruthy(process.env.E2E_CAPTURE_UI);
}

export function resolveEvidenceDir(group: string) {
  const outputRoot = process.env.PLAYWRIGHT_TEST_OUTPUT_DIR?.trim();
  const evidenceRoot = outputRoot
    ? path.resolve(outputRoot, "screenshots")
    : path.join(
        process.cwd(),
        "docs",
        "ops",
        "evidence",
        new Date().toISOString().slice(0, 10),
      );
  return assertContained(evidenceRoot, path.resolve(evidenceRoot, group));
}

export function resolveEvidencePath(group: string, ...segments: string[]) {
  const evidenceDir = resolveEvidenceDir(group);
  const filePath = assertContained(
    evidenceDir,
    path.resolve(evidenceDir, ...segments),
  );
  ensureDirectoryWithoutSymlinks(path.dirname(filePath));
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error("e2e_evidence_output_symlink");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return filePath;
}

export async function captureFullPage(page: Page, filePath: string) {
  await stabilizePage(page);
  await page.screenshot({ path: filePath, fullPage: true });
}

export async function captureViewport(page: Page, filePath: string) {
  await stabilizePage(page);
  await page.screenshot({ path: filePath });
}

export async function focusWithTab(page: Page, locator: Locator, maxTabs = 60) {
  for (let attempt = 0; attempt < maxTabs; attempt += 1) {
    const isFocused = await locator.evaluate(
      (element) => element === document.activeElement
    );
    if (isFocused) return true;
    await page.keyboard.press("Tab");
  }
  return false;
}

