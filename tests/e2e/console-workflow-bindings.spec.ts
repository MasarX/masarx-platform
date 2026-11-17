import { expect, test } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedIn } from "./utils/session";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

test.describe("console workflow bindings", () => {
  test.skip(
    !demoContext.available && !strict,
    demoContext.reason ?? "Demo accounts missing.",
  );

  test("bindings workspace renders resolved scope and inventory", async ({
    page,
  }, testInfo) => {
    test.slow();
    if (!demoContext.available) {
      throw new Error(demoContext.reason ?? "Demo accounts missing for strict E2E.");
    }

    const reviewer =
      demoContext.users.find((user) => user.email === "sipkxyzyxvgvtksowrxwjgpn@example.invalid") ??
      demoContext.users.find((user) => user.scope_type === "tenant") ??
      null;
    if (!reviewer) {
      throw new Error("No tenant-scoped reviewer demo user available.");
    }

    const basePath = getConsoleBasePath();

    await ensureSignedIn({
      page,
      basePath,
      authTestId: "console-auth-required",
      email: reviewer.email,
      password: demoContext.password ?? "",
      scopeType: reviewer.scope_type ?? null,
    });

    await page.goto(`${basePath}/workflows/bindings`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(
      page.locator('[data-testid="console-workflow-bindings-scope"]').first(),
    ).toBeVisible();
    if (!(await page.locator('[data-testid="console-workflow-bindings-bindings-table"]').count())) {
      await page.getByText("Bindings", { exact: true }).last().click();
    }
    await expect(
      page.locator('[data-testid="console-workflow-bindings-bindings-table"]').first(),
    ).toBeVisible();
    if (!(await page.locator('[data-testid="console-workflow-bindings-inventory"]').count())) {
      await page.getByText("Business action inventory", { exact: true }).click();
    }
    await expect(
      page.locator('[data-testid="console-workflow-bindings-inventory"]').first(),
    ).toBeVisible();

    await expect(
      page.locator('[data-testid="console-workflow-bindings-bindings-table"] tbody').first(),
    ).toContainText("customer_shipment_change");
    await expect(
      page.locator('[data-testid="console-workflow-bindings-bindings-table"] tbody').first(),
    ).toContainText("tenant_signup");
    await expect(
      page.locator('[data-testid="console-workflow-bindings-bindings-table"] tbody').first(),
    ).toContainText("marketing_lead");
    await expect(
      page.locator('[data-testid="console-workflow-bindings-inventory"]').first(),
    ).toContainText("workflow_native");

    await page.screenshot({
      path: testInfo.outputPath("console-workflow-bindings.png"),
      fullPage: true,
    });

    const studioLink = page.getByRole("link", { name: "Open in studio" }).first();
    await expect(studioLink).toBeVisible();
    await Promise.all([
      page.waitForURL(/\/workflows\/templates\//, { timeout: 60_000 }),
      studioLink.click(),
    ]);
  });
});
