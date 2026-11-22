import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { expect, type Page } from "@playwright/test";
import * as en from "../../../packages/config/messages/en.json";
import * as ar from "../../../packages/config/messages/ar.json";

const reportMessages = [en.ui.operationReport, ar.ui.operationReport];
const messagePattern = (values: string[]) => new RegExp(`^(?:${values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`);
type ImportRunIdentity = { id: string; organization_id: string; scope_context: unknown };

export function getOperationReportDetails(page: Page) {
  return page.locator("details").filter({
    has: page.locator("summary").filter({ hasText: messagePattern(reportMessages.map((messages) => messages.reportDetails)) }),
  });
}

type DemoClient = {
  slug?: string;
  id?: string;
};

type DemoManifest = {
  clients?: DemoClient[];
  senders?: { id?: string; sender_name?: string }[];
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

export async function approveResourceImport(page: Page) {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => {
      const request = candidate.request();
      if (request.method() !== "POST" || new URL(candidate.url()).pathname !== "/api/resource-import") return false;
      try {
        return request.postDataJSON()?.action === "start";
      } catch {
        return false;
      }
    }),
    page.getByRole("button", { name: "Approve and import" }).click(),
  ]);
  expect(response.ok(), `Import start HTTP ${response.status()}`).toBe(true);
  const requestedRunId = response.request().postDataJSON().run_id;
  expect(requestedRunId).toMatch(/\S/);
  const result = await response.json();
  expect(result?.ok).toBe(true);
  expect(result?.run?.id).toBe(requestedRunId);
  expect(result?.run?.organization_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(["queued", "processing", "completed"]).toContain(result?.run?.status);
  if (result.run.status !== "completed") runTabularImportWorkerOnce();
  return { id: requestedRunId, organization_id: result.run.organization_id, scope_context: result.run.scope_context } as ImportRunIdentity;
}

export async function waitForOperationReport(
  page: Page,
  identity: ImportRunIdentity,
  expected: { createdCount: number; relatedNodes?: string[] }
) {
  const reportDetails = getOperationReportDetails(page);
  await expect(reportDetails.locator("summary")).toBeVisible({ timeout: 60_000 });
  if ((await reportDetails.getAttribute("open")) === null) await reportDetails.locator("summary").click();
  await expect(reportDetails).toHaveJSProperty("open", true);
  await expect(reportDetails.locator("pre")).toBeVisible();
  const resultDetails = page.locator("details").filter({
    has: page.locator("summary").filter({ hasText: messagePattern(reportMessages.map((messages) => messages.resultDetails)) }),
  });
  await expect(resultDetails.locator("summary")).toBeVisible({ timeout: 60_000 });
  if ((await resultDetails.getAttribute("open")) === null) await resultDetails.locator("summary").click();
  await expect(resultDetails).toHaveJSProperty("open", true);
  await expect(resultDetails.locator("pre")).toBeVisible();
  await expect(reportDetails.locator("..")).toContainText("Review the imported records in the destination table or import history.", { timeout: 60_000 });
  for (const text of ['"id": "[redacted]"', '"organization_id": "[redacted]"', '"status": "completed"', `"created_count": ${expected.createdCount}`]) {
    await expect(resultDetails.locator("pre")).toContainText(text, { timeout: 60_000 });
  }
  // Support JSON redacts identities and may truncate nested results; verify both through authorized run readback.
  const origin = new URL(page.url()).origin;
  const response = await page.request.post(`${origin}/api/resource-import`, {
    headers: { origin }, data: { action: "get_run", run_id: identity.id },
  });
  expect(response.ok(), `Import readback HTTP ${response.status()}`).toBe(true);
  const run = await response.json();
  expect(run?.id).toBe(identity.id);
  expect(run?.organization_id).toBe(identity.organization_id);
  expect(run?.scope_context).toEqual(identity.scope_context);
  expect(run?.status).toBe("completed");
  expect(run?.created_count).toBe(expected.createdCount);
  expect(run?.failed_count).toBe(0);
  if (expected.relatedNodes?.length) {
    expect(run.rows).toHaveLength(expected.createdCount);
    for (const row of run.rows) {
      expect(row.execution_status).toBe("succeeded");
      for (const key of expected.relatedNodes) {
        const node = row.related_nodes?.find((entry: { node_key?: string }) => entry.node_key === key);
        expect(node?.execution_status, `Row ${row.row_number}: ${key} must execute`).toBe("succeeded");
        expect(node?.target_record_id).toMatch(/^[0-9a-f-]{36}$/i);
        expect(row.mapped_row?.[node.reference_field]).toBe(node.target_record_id);
      }
    }
  }
}
