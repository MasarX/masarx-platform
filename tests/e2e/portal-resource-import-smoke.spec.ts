import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getPortalBasePath } from "./utils/base-paths";
import { captureFullPage, captureViewport, isCaptureEnabled, resolveEvidencePath } from "./utils/evidence";
import {
  getDemoClientId,
  getDemoSenderId,
  runTabularImportWorkerOnce,
  uploadCsv,
  waitForOperationReport,
} from "./utils/resource-import";

const demoContext = loadDemoContext();
const evidenceGroup = "resource-import";

function buildUniquePhone(unique: string, suffix: string) {
  return `+9665${unique}${suffix}`;
}

async function signInForPortalResource(
  page: import("@playwright/test").Page,
  resourcePath: string,
  allowedScopes: string[],
) {
  const authGate = page.locator('[data-testid="portal-auth-required"]');
  if (!demoContext.available || demoContext.users.length === 0 || !(await authGate.isVisible().catch(() => false))) {
    return;
  }

  const user =
    demoContext.users.find((entry) => allowedScopes.includes(entry.scope_type ?? "")) ?? demoContext.users[0];
  if (user?.email && demoContext.password) {
    await signInWithPassword(page, user.email, demoContext.password);
    await expectSignedIn(page, user.email, user.scope_type);
    await page.goto(resourcePath, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }
}

test.describe("portal resource import", () => {
  test("client-scoped users see a disabled import action with an explicit reason", async ({ page }) => {
    const portalBasePath = getPortalBasePath();
    const recipientsPath = `${portalBasePath}/resources/recipients`;

    await page.goto(recipientsPath, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(
      page.locator(
        '[data-testid="portal-auth-required"], [data-testid="portal-missing-env"], button:has-text("Import")',
      ).first(),
    ).toBeVisible();

    await signInForPortalResource(page, recipientsPath, ["client"]);

    const importButton = page.getByRole("button", { name: "Import" }).first();
    await expect(importButton).toBeVisible({ timeout: 30_000 });
    await expect(importButton).toBeDisabled();
    await expect(importButton).toHaveAttribute(
      "title",
      /Import requires the recipients\.write capability\./,
    );

    if (isCaptureEnabled()) {
      await captureFullPage(
        page,
        resolveEvidencePath(evidenceGroup, "portal-resource-import-disabled.png"),
      );
    }
  });

  test("client-scoped users cannot start shipment import without shipments.write", async ({ page }) => {
    const portalBasePath = getPortalBasePath();
    const shipmentsPath = `${portalBasePath}/resources/shipments`;

    await page.goto(shipmentsPath, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(
      page.locator(
        '[data-testid="portal-auth-required"], [data-testid="portal-missing-env"], button:has-text("Import")',
      ).first(),
    ).toBeVisible();

    await signInForPortalResource(page, shipmentsPath, ["client"]);

    const importButton = page.getByRole("button", { name: "Import" }).first();
    await expect(importButton).toBeVisible({ timeout: 30_000 });
    await expect(importButton).toBeDisabled();
    await expect(importButton).toHaveAttribute(
      "title",
      /Import requires the shipments\.write capability\./,
    );
  });

  test("portal reuses the saved console profile and completes the import", async ({ page }) => {
    const portalBasePath = getPortalBasePath();
    const demoClientId = getDemoClientId();
    const recipientsPath = `${portalBasePath}/resources/recipients`;

    await page.goto(recipientsPath, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await signInForPortalResource(page, recipientsPath, ["platform", "tenant"]);

    const importButton = page.getByRole("button", { name: /^Import$/ }).first();
    await expect(importButton).toBeVisible({ timeout: 30_000 });
    await importButton.click();
    await expect(page.getByText("Import source")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`${portalBasePath}/resources/recipients`));

    const unique = Date.now().toString().slice(-6);
    await uploadCsv(
      page,
      "portal-resource-file-input",
      "recipients-portal-e2e.csv",
      ["Client Id", "External Id", "Name", "Email", "Phone Number", "Preferred Language"],
      [
        [
          demoClientId,
          ` ext-e2e-portal-${unique}-1 `,
          "Portal E2E Recipient One",
          `portal.${unique}.one@example.com`,
          ` ${buildUniquePhone(unique, "11")} `,
          " ar",
        ],
        [
          demoClientId,
          `ext-e2e-portal-${unique}-2`,
          "Portal E2E Recipient Two",
          `portal.${unique}.two@example.com`,
          buildUniquePhone(unique, "12"),
          "en",
        ],
      ],
    );

    await expect(page.getByText(/Profile resolution/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Approve and import" }).click();
    await expect(page.getByText("Import in progress")).toBeVisible({ timeout: 30_000 });
    runTabularImportWorkerOnce();
    await waitForOperationReport(page, [
      "Review the imported records in the destination table or import history.",
      "\"created_count\": 2",
      "\"status\": \"completed\"",
    ]);

    if (isCaptureEnabled()) {
      await page.getByText("Raw report JSON").first().scrollIntoViewIfNeeded();
      await captureViewport(
        page,
        resolveEvidencePath(evidenceGroup, "portal-resource-import-report.png"),
      );
    }
  });

  test("portal matches the console shipment bulk-import proof on the shared import surface", async ({ page }) => {
    const portalBasePath = getPortalBasePath();
    const demoClientId = getDemoClientId();
    const demoSenderId = getDemoSenderId();
    const shipmentsPath = `${portalBasePath}/resources/shipments`;

    await page.goto(shipmentsPath, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await signInForPortalResource(page, shipmentsPath, ["platform", "tenant"]);

    const importButton = page.getByRole("button", { name: /^Import$/ }).first();
    await expect(importButton).toBeVisible({ timeout: 30_000 });
    await importButton.click();
    await expect(page.getByText("Import source")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`${portalBasePath}/resources/shipments`));

    const shipmentUnique = `${Date.now()}`.slice(-8);
    await uploadCsv(
      page,
      "portal-resource-file-input",
      "shipments-portal-e2e.csv",
      ["Client Id", "Sender Id", "Service Type", "Tracking Number", "Status"],
      [
        [demoClientId, demoSenderId, "delivery", `ship-portal-${shipmentUnique}-1`, "created"],
        [demoClientId, demoSenderId, "delivery", `ship-portal-${shipmentUnique}-2`, "created"],
      ],
    );

    await expect(page.locator("body")).toContainText("Will create", { timeout: 60_000 });
    await expect(page.locator("body")).toContainText("Rows staged: 2", { timeout: 60_000 });
    await page.getByRole("button", { name: "Approve and import" }).click();
    await expect(page.getByText("Import in progress")).toBeVisible({ timeout: 30_000 });
    runTabularImportWorkerOnce();
    await waitForOperationReport(page, [
      "Review the imported records in the destination table or import history.",
      "\"created_count\": 2",
      "\"status\": \"completed\"",
    ]);
  });
});
