import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { expect, type Page } from "@playwright/test";

type DemoClient = {
  slug?: string;
  id?: string;
};

type DemoManifest = {
  clients?: DemoClient[];
};

function readDemoManifest(): DemoManifest {
  const manifestPath =
    process.env.DEMO_ACCOUNTS_PATH ??
    path.join(process.cwd(), "tmp", "demo-accounts.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Demo manifest not found at ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as DemoManifest;
}

export function getDemoClientId(slug = "demo-client-a") {
  const manifest = readDemoManifest();
  const match = (manifest.clients ?? []).find((client) => client.slug === slug);
  if (!match?.id) {
    throw new Error(`Demo client ${slug} missing from manifest.`);
  }
  return match.id;
}

export function getDemoSenderId(senderName = "Demo Sender A") {
  const manifest = readDemoManifest();
  const match = (manifest.senders ?? []).find((sender) => sender.sender_name === senderName);
  if (!match?.id) {
    throw new Error(`Demo sender ${senderName} missing from manifest.`);
  }
  return match.id;
}

export function buildCsvPayload(headers: string[], rows: string[][]) {
  const lines = [headers.join(",")];
  rows.forEach((row) => lines.push(row.join(",")));
  return Buffer.from(lines.join("\n"), "utf8");
}

export async function uploadCsv(
  page: Page,
  testId: string,
  name: string,
  headers: string[],
  rows: string[][]
) {
  await page.locator(`[data-testid="${testId}"]`).setInputFiles({
    name,
    mimeType: "text/csv",
    buffer: buildCsvPayload(headers, rows),
  });
}

export function runTabularImportWorkerOnce() {
  const envFile =
    process.env.ENV_FILE && process.env.ENV_FILE.trim()
      ? process.env.ENV_FILE
      : path.join("config", "env", ".env.local");
  execFileSync(
    process.execPath,
    ["scripts/workers/tabular-import-worker.js", "--once"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ENV_FILE: envFile,
      },
      stdio: "inherit",
    }
  );
}

export async function waitForOperationReport(
  page: Page,
  expectedTexts: string | string[]
) {
  await expect(page.getByText("Raw report JSON")).toBeVisible({
    timeout: 60_000,
  });
  const body = page.locator("body");
  const values = Array.isArray(expectedTexts) ? expectedTexts : [expectedTexts];
  for (const value of values) {
    await expect(body).toContainText(value, { timeout: 60_000 });
  }
}
