import fs from "fs";
import path from "path";
import { type Locator, type Page } from "@playwright/test";
import { isTruthy } from "./env";

const ensuredDirs = new Set<string>();
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
  const date = new Date().toISOString().slice(0, 10);
  return path.join(process.cwd(), "docs", "ops", "evidence", date, group);
}

export function resolveEvidencePath(group: string, ...segments: string[]) {
  const evidenceDir = resolveEvidenceDir(group);
  if (!ensuredDirs.has(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    ensuredDirs.add(evidenceDir);
  }
  return path.join(evidenceDir, ...segments);
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

