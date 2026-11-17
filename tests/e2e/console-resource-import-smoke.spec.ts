import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBasePath } from "./utils/base-paths";
import { captureViewport, isCaptureEnabled, resolveEvidencePath } from "./utils/evidence";
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

async function pickComboboxValue(page: import("@playwright/test").Page, testId: string, searchValue: string) {
  const container = page.locator(`[data-testid="${testId}"]`);
  await expect(container.getByRole("combobox")).toBeVisible({ timeout: 30_000 });
  await container.getByRole("combobox").click();
  const searchbox = page.getByRole("searchbox", { name: "Search options" });
  await expect(searchbox).toBeVisible({ timeout: 10_000 });
  await searchbox.fill(searchValue);
  const popupListbox = page.locator('[role="listbox"]:visible').last();
  const popupOption = popupListbox.getByRole("option").first();
  await expect(popupOption).toBeVisible({ timeout: 10_000 });
  await popupOption.click();
  await expect(searchbox).toBeHidden({ timeout: 10_000 });
}

test.describe("console resource import", () => {
  test("blocks missing required fields before approval and completes a shared-profile import", async ({ page }) => {
    const consoleBasePath = getConsoleBasePath();
    const demoClientId = getDemoClientId();
    const demoSenderId = getDemoSenderId();

    await page.goto(`${consoleBasePath}/resources/recipients`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const authGate = page.locator('[data-testid="console-auth-required"]');
    const ready = page.getByRole("button", { name: /^Import$/ }).first();
    await expect(
      page.locator(
        '[data-testid="console-resource-import-ready"], [data-testid="console-auth-required"], [data-testid="console-missing-env"], button:has-text("Import")',
      ).first(),
    ).toBeVisible({ timeout: 30_000 });

    if (demoContext.available && demoContext.users.length > 0 && (await authGate.isVisible().catch(() => false))) {
      const user = demoContext.users.find((entry) => ["platform", "tenant"].includes(entry.scope_type ?? "")) ?? demoContext.users[0];
      if (user?.email && demoContext.password) {
        await signInWithPassword(page, user.email, demoContext.password);
        await expectSignedIn(page, user.email, user.scope_type);
        await page.goto(`${consoleBasePath}/resources/recipients`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
      }
    }

    await expect(ready).toBeVisible({ timeout: 30_000 });
    await ready.click();
    await expect(page.getByText("Import source")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`${consoleBasePath}/resources/recipients`));

    await uploadCsv(
      page,
      "console-resource-file-input",
      "recipients-missing-phone-e2e.csv",
      ["Client Id", "External Id", "Name", "Email", "Preferred Language"],
      [
        [demoClientId, "ext-e2e-blocked-001", "Blocked Recipient One", "blocked.one@example.com", "ar"],
        [demoClientId, "ext-e2e-blocked-002", "Blocked Recipient Two", "blocked.two@example.com", "en"],
      ],
    );

    await expect(page.getByText("Blocked issues").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Required field phone_number is missing on row 1.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve and import" })).toBeDisabled();

    if (isCaptureEnabled()) {
      await page.getByText("Blocked issues").first().scrollIntoViewIfNeeded();
      await captureViewport(
        page,
        resolveEvidencePath(evidenceGroup, "console-resource-import-blocked.png"),
      );
    }

    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.locator('[data-testid="console-resource-file-input"]')).toHaveCount(0);
    await ready.click();
    await expect(page.getByText("Import source")).toBeVisible({ timeout: 30_000 });

    const unique = Date.now().toString().slice(-6);
    const profileName = `Recipients Phone Profile ${unique}`;
    await uploadCsv(
      page,
      "console-resource-file-input",
      "recipients-console-e2e.csv",
      ["Client Id", "External Id", "Name", "Email", "Phone Number", "Preferred Language"],
      [
        [
          demoClientId,
          ` ext-e2e-console-${unique}-1 `,
          "Console E2E Recipient One",
          `console.${unique}.one@example.com`,
          ` ${buildUniquePhone(unique, "01")} `,
          " ar",
        ],
        [
          demoClientId,
          `ext-e2e-console-${unique}-2`,
          "Console E2E Recipient Two",
          `console.${unique}.two@example.com`,
          buildUniquePhone(unique, "02"),
          "en",
        ],
      ],
    );

    await expect(page.locator("body")).toContainText("Will create", { timeout: 60_000 });
    await expect(page.locator("body")).toContainText("Rows staged: 2", { timeout: 60_000 });
    const exactProfileMatch = page.getByText(/Exact profile match:/).first();
    if (!(await exactProfileMatch.isVisible().catch(() => false))) {
      await page.selectOption('[data-testid="console-resource-profile-mode"]', "new");
      await page.locator('[data-testid="console-resource-profile-name"]').fill(profileName);
    }
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
        resolveEvidencePath(evidenceGroup, "console-resource-import-report.png"),
      );
    }

    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.locator('[data-testid="console-resource-file-input"]')).toHaveCount(0);
    await ready.click();
    await uploadCsv(
      page,
      "console-resource-file-input",
      "recipients-console-e2e-reuse.csv",
      ["Client Id", "External Id", "Name", "Email", "Phone Number", "Preferred Language"],
      [
        [
          demoClientId,
          `ext-e2e-console-${unique}-3`,
          "Console E2E Recipient Three",
          `console.${unique}.three@example.com`,
          buildUniquePhone(unique, "03"),
          "en",
        ],
      ],
    );
    await expect(page.getByText(/Exact profile match:/)).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "Close" }).click();
    await page.goto(`${consoleBasePath}/resources/shipments`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const shipmentsImport = page.getByRole("button", { name: /^Import$/ }).first();
    await expect(shipmentsImport).toBeVisible({ timeout: 30_000 });
    await shipmentsImport.click();
    await expect(page.getByText("Import source")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`${consoleBasePath}/resources/shipments`));

    const shipmentUnique = `${Date.now()}`.slice(-8);
    await uploadCsv(
      page,
      "console-resource-file-input",
      "shipments-console-e2e.csv",
      ["Client Id", "Sender Id", "Service Type", "Tracking Number", "Status"],
      [
        [demoClientId, demoSenderId, "delivery", `ship-console-${shipmentUnique}-1`, "created"],
        [demoClientId, demoSenderId, "delivery", `ship-console-${shipmentUnique}-2`, "created"],
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

  test("uses dynamic related-record pickers and row-specific fixes before approval", async ({ page }) => {
    const consoleBasePath = getConsoleBasePath();
    const demoClientId = getDemoClientId();
    const demoSenderId = getDemoSenderId();

    await page.goto(`${consoleBasePath}/resources/shipments`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const authGate = page.locator('[data-testid="console-auth-required"]');
    const ready = page.getByRole("button", { name: /^Import$/ }).first();
    await expect(
      page.locator(
        '[data-testid="console-resource-import-ready"], [data-testid="console-auth-required"], [data-testid="console-missing-env"], button:has-text("Import")',
      ).first(),
    ).toBeVisible({ timeout: 30_000 });

    if (demoContext.available && demoContext.users.length > 0 && (await authGate.isVisible().catch(() => false))) {
      const user = demoContext.users.find((entry) => ["platform", "tenant"].includes(entry.scope_type ?? "")) ?? demoContext.users[0];
      if (user?.email && demoContext.password) {
        await signInWithPassword(page, user.email, demoContext.password);
        await expectSignedIn(page, user.email, user.scope_type);
        await page.goto(`${consoleBasePath}/resources/shipments`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
      }
    }

    await expect(ready).toBeVisible({ timeout: 30_000 });
    await ready.click();
    await expect(page.getByText("Import source")).toBeVisible({ timeout: 30_000 });

    const unique = `${Date.now()}`.slice(-8);
    await uploadCsv(
      page,
      "console-resource-file-input",
      "shipments-console-related-fix-e2e.csv",
      ["Tracking Number", "Service Type", "Status"],
      [
        [`ship-console-fix-${unique}-1`, "delivery", "legacy_status"],
        [`ship-console-fix-${unique}-2`, "delivery", "created"],
      ],
    );

    await expect(page.getByText("Required target client_id is not mapped.").first()).toBeVisible({ timeout: 30_000 });
    await page.selectOption('[data-testid="console-resource-mode-client_id"]', "fixed");
    await page.selectOption('[data-testid="console-resource-mode-sender_id"]', "fixed");

    await pickComboboxValue(page, "console-resource-fixed-client_id", demoClientId);
    await pickComboboxValue(page, "console-resource-fixed-sender_id", demoSenderId);

    await expect(page.getByText("Row-specific fixes", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Status must match one of the configured lookup values.").first()).toBeVisible();

    if (isCaptureEnabled()) {
      await page.getByText("Row-specific fixes", { exact: true }).scrollIntoViewIfNeeded();
      await captureViewport(
        page,
        resolveEvidencePath(evidenceGroup, "console-resource-import-row-fix.png"),
      );
    }

    await page.locator('[data-testid="console-resource-row-1-status"]').selectOption("created");
    await expect(page.getByRole("button", { name: "Approve and import" })).toBeEnabled({ timeout: 30_000 });

    await page.getByRole("button", { name: "Approve and import" }).click();
    await expect(page.getByText("Import in progress")).toBeVisible({ timeout: 30_000 });
    runTabularImportWorkerOnce();
    await waitForOperationReport(page, [
      "Review the imported records in the destination table or import history.",
      "\"created_count\": 2",
      "\"status\": \"completed\"",
    ]);
  });

  test("lets the user attach a related node manually when auto-detection misses it", async ({ page }) => {
    test.setTimeout(120_000);
    const consoleBasePath = getConsoleBasePath();
    const demoClientId = getDemoClientId();
    const demoSenderId = getDemoSenderId();

    await page.goto(`${consoleBasePath}/resources/shipments`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const authGate = page.locator('[data-testid="console-auth-required"]');
    const ready = page.getByRole("button", { name: /^Import$/ }).first();
    await expect(
      page.locator(
        '[data-testid="console-resource-import-ready"], [data-testid="console-auth-required"], [data-testid="console-missing-env"], button:has-text("Import")',
      ).first(),
    ).toBeVisible({ timeout: 30_000 });

    if (demoContext.available && demoContext.users.length > 0 && (await authGate.isVisible().catch(() => false))) {
      const user = demoContext.users.find((entry) => ["platform", "tenant"].includes(entry.scope_type ?? "")) ?? demoContext.users[0];
      if (user?.email && demoContext.password) {
        await signInWithPassword(page, user.email, demoContext.password);
        await expectSignedIn(page, user.email, user.scope_type);
        await page.goto(`${consoleBasePath}/resources/shipments`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
      }
    }

    await expect(ready).toBeVisible({ timeout: 30_000 });
    await ready.click();
    await expect(page.getByText("Import source")).toBeVisible({ timeout: 30_000 });

    const unique = `${Date.now()}`.slice(-8);
    await uploadCsv(
      page,
      "console-resource-file-input",
      "shipments-console-related-manual-e2e.csv",
      ["Tracking Number", "Name", "Phone Number"],
      [
        [`ship-console-manual-${unique}-1`, "Manual Related Recipient One", `+9665${unique}41`],
        [`ship-console-manual-${unique}-2`, "Manual Related Recipient Two", `+9665${unique}42`],
      ],
    );

    await expect(page.getByText("Required target client_id is not mapped.").first()).toBeVisible({ timeout: 30_000 });
    await page.selectOption('[data-testid="console-resource-related-node-picker"]', "recipient");
    await page.getByTestId("console-resource-related-node-add").click();

    await expect(page.getByText("Recipient / Name").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Recipient / Phone Number").first()).toBeVisible({ timeout: 30_000 });

    await page.selectOption('[data-testid="console-resource-mode-client_id"]', "fixed");
    await page.selectOption('[data-testid="console-resource-mode-sender_id"]', "fixed");
    await page.selectOption('[data-testid="console-resource-mode-service_type"]', "fixed");
    await page.selectOption('[data-testid="console-resource-mode-status"]', "fixed");
    await pickComboboxValue(page, "console-resource-fixed-client_id", demoClientId);
    await pickComboboxValue(page, "console-resource-fixed-sender_id", demoSenderId);
    await page.locator('[data-testid="console-resource-fixed-service_type"]').selectOption("delivery");
    await page.locator('[data-testid="console-resource-fixed-status"]').selectOption("created");
    await page.locator('[data-testid="console-resource-source-recipient-name"]').selectOption("Name");
    await page.locator('[data-testid="console-resource-source-recipient-phone_number"]').selectOption("Phone Number");

    await expect(page.getByText("Related node preview").first()).toBeVisible({ timeout: 30_000 });
    await page.getByText("Row review sample").first().click();
    await expect(page.getByText("Recipient: create").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Approve and import" })).toBeEnabled({ timeout: 30_000 });

    if (isCaptureEnabled()) {
      await page.getByText("Row review sample").first().scrollIntoViewIfNeeded();
      await captureViewport(
        page,
        resolveEvidencePath(evidenceGroup, "console-resource-import-manual-related-node.png"),
      );
    }

    await page.getByRole("button", { name: "Approve and import" }).click();
    await expect(page.getByText("Import in progress")).toBeVisible({ timeout: 30_000 });
    runTabularImportWorkerOnce();
    await waitForOperationReport(page, [
      "Review the imported records in the destination table or import history.",
      "\"created_count\": 2",
      "\"status\": \"completed\"",
      "\"recipient\"",
    ]);
  });

  test("builds related recipient and destination-address nodes from shipment rows", async ({ page }) => {
    test.setTimeout(120_000);
    const consoleBasePath = getConsoleBasePath();
    const demoClientId = getDemoClientId();
    const demoSenderId = getDemoSenderId();

    await page.goto(`${consoleBasePath}/resources/shipments`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const authGate = page.locator('[data-testid="console-auth-required"]');
    const ready = page.getByRole("button", { name: /^Import$/ }).first();
    await expect(
      page.locator(
        '[data-testid="console-resource-import-ready"], [data-testid="console-auth-required"], [data-testid="console-missing-env"], button:has-text("Import")',
      ).first(),
    ).toBeVisible({ timeout: 30_000 });

    if (demoContext.available && demoContext.users.length > 0 && (await authGate.isVisible().catch(() => false))) {
      const user = demoContext.users.find((entry) => ["platform", "tenant"].includes(entry.scope_type ?? "")) ?? demoContext.users[0];
      if (user?.email && demoContext.password) {
        await signInWithPassword(page, user.email, demoContext.password);
        await expectSignedIn(page, user.email, user.scope_type);
        await page.goto(`${consoleBasePath}/resources/shipments`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
      }
    }

    await expect(ready).toBeVisible({ timeout: 30_000 });
    await ready.click();
    await expect(page.getByText("Import source")).toBeVisible({ timeout: 30_000 });

    const unique = `${Date.now()}`.slice(-8);
    await uploadCsv(
      page,
      "console-resource-file-input",
      "shipments-console-related-graph.csv",
      ["Tracking Number", "Recipient Name", "Recipient Phone", "Address Line 1", "City", "Postal Code", "Country"],
      [
        [
          `ship-console-related-${unique}-1`,
          "Console Related Recipient One",
          `+9665${unique}31`,
          "742 Example Street",
          "Riyadh",
          "11564",
          "SA",
        ],
        [
          `ship-console-related-${unique}-2`,
          "Console Related Recipient Two",
          `+9665${unique}32`,
          "745 Example Street",
          "Riyadh",
          "11565",
          "SA",
        ],
      ],
    );

    await expect(page.getByText("Related node preview").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Recipient").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Destination address").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Required target client_id is not mapped.").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Required target sender_id is not mapped.").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Required related field destination_address.province is missing on row 1.").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Required related field destination_address.validation_status is missing on row 1.").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Approve and import" })).toBeDisabled();

    await page.selectOption('[data-testid="console-resource-mode-client_id"]', "fixed");
    await page.selectOption('[data-testid="console-resource-mode-sender_id"]', "fixed");
    await page.selectOption('[data-testid="console-resource-mode-service_type"]', "fixed");
    await page.selectOption('[data-testid="console-resource-mode-status"]', "fixed");
    await page.selectOption('[data-testid="console-resource-mode-destination_address-province"]', "fixed");
    await page.selectOption('[data-testid="console-resource-mode-destination_address-validation_status"]', "fixed");

    await pickComboboxValue(page, "console-resource-fixed-client_id", demoClientId);
    await pickComboboxValue(page, "console-resource-fixed-sender_id", demoSenderId);
    await page.locator('[data-testid="console-resource-fixed-service_type"]').selectOption("delivery");
    await page.locator('[data-testid="console-resource-fixed-status"]').selectOption("created");
    await page.locator('[data-testid="console-resource-fixed-destination_address-province"]').fill("Riyadh");
    await page.locator('[data-testid="console-resource-fixed-destination_address-validation_status"]').fill("pending");

    await expect(page.getByRole("button", { name: "Approve and import" })).toBeEnabled({ timeout: 30_000 });

    if (isCaptureEnabled()) {
      const rowReviewSample = page.getByText("Row review sample").first();
      await rowReviewSample.scrollIntoViewIfNeeded();
      await rowReviewSample.click();
      await captureViewport(
        page,
        resolveEvidencePath(evidenceGroup, "console-resource-import-related-graph-review.png"),
      );
    }

    await page.getByRole("button", { name: "Approve and import" }).click();
    await expect(page.getByText("Import in progress")).toBeVisible({ timeout: 30_000 });
    runTabularImportWorkerOnce();
    await waitForOperationReport(page, [
      "Review the imported records in the destination table or import history.",
      "\"created_count\": 2",
      "\"status\": \"completed\"",
      "\"destination_address\"",
      "\"recipient\"",
    ]);

    if (isCaptureEnabled()) {
      await page.getByText("Raw report JSON").first().scrollIntoViewIfNeeded();
      await captureViewport(
        page,
        resolveEvidencePath(evidenceGroup, "console-resource-import-related-graph-report.png"),
      );
    }
  });

  test("platform users can choose the import scope dynamically before upload", async ({ page }) => {
    const consoleBasePath = getConsoleBasePath();
    const demoClientId = getDemoClientId("demo-client-b");
    const demoSenderId = getDemoSenderId("Demo Sender B");

    await page.goto(`${consoleBasePath}/resources/shipments`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const authGate = page.locator('[data-testid="console-auth-required"]');
    const ready = page.getByRole("button", { name: /^Import$/ }).first();
    await expect(
      page.locator(
        '[data-testid="console-resource-import-ready"], [data-testid="console-auth-required"], [data-testid="console-missing-env"], button:has-text("Import")',
      ).first(),
    ).toBeVisible({ timeout: 30_000 });

    if (demoContext.available && demoContext.users.length > 0 && (await authGate.isVisible().catch(() => false))) {
      const user = demoContext.users.find((entry) => entry.scope_type === "platform") ?? demoContext.users[0];
      if (user?.email && demoContext.password) {
        await signInWithPassword(page, user.email, demoContext.password);
        await expectSignedIn(page, user.email, user.scope_type);
        await page.goto(`${consoleBasePath}/resources/shipments`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
      }
    }

    await expect(ready).toBeVisible({ timeout: 30_000 });
    await ready.click();
    await expect(page.getByText("Import scope")).toBeVisible({ timeout: 30_000 });

    await pickComboboxValue(page, "console-resource-scope-tenant", "Demo Organization");
    await pickComboboxValue(page, "console-resource-scope-client", demoClientId);
    await pickComboboxValue(page, "console-resource-scope-sender", demoSenderId);

    const unique = `${Date.now()}`.slice(-8);
    await uploadCsv(
      page,
      "console-resource-file-input",
      "shipments-console-scope-e2e.csv",
      ["Tracking Number", "Service Type", "Status"],
      [
        [`ship-console-scope-${unique}-1`, "delivery", "created"],
        [`ship-console-scope-${unique}-2`, "delivery", "created"],
      ],
    );

    await expect(page.locator("body")).toContainText("Import scope:", { timeout: 30_000 });
    await expect(page.locator("body")).toContainText(demoClientId, { timeout: 30_000 });
    await expect(page.locator("body")).toContainText(demoSenderId, { timeout: 30_000 });
    await expect(page.getByText("Provided by import scope").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Approve and import" })).toBeEnabled({ timeout: 30_000 });

    if (isCaptureEnabled()) {
      await page.getByText("Import scope").first().scrollIntoViewIfNeeded();
      await captureViewport(
        page,
        resolveEvidencePath(evidenceGroup, "console-resource-import-scope-selectors.png"),
      );
    }

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
