import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

function resolveEvidenceDir() {
  const raw = String(process.env.MARKETPLACE_EVIDENCE_DIR || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

export async function captureEvidenceIfRequested(
  page: Page,
  fileName: string,
  options?: { fullPage?: boolean },
) {
  const evidenceDir = resolveEvidenceDir();
  if (!evidenceDir) return "";
  fs.mkdirSync(evidenceDir, { recursive: true });
  const target = path.join(evidenceDir, fileName);
  await page.screenshot({
    path: target,
    fullPage: options?.fullPage ?? true,
  });
  return target;
}
