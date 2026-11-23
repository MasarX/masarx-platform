import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { ensureSignedIn } from "./utils/session";
import { assertSingleAppShellSidebar, waitForDashboardHealthReady } from "./utils/layout-guards";
import { waitForCollapsedSectionPersisted } from "./utils/navigation-state";

const demoContext = loadDemoContext();

test.describe("console section preferences", () => {
  test("dashboard section collapse persists per user", async ({ page }, testInfo) => {
    if (!demoContext.available) throw new Error(demoContext.reason ?? "Console identity fixtures are missing.");
    // Keep stricter lane limits; never inherit a whole-job timeout for this one test.
    test.setTimeout(Math.min(testInfo.timeout || 90_000, 90_000));
    const basePath = getConsoleBasePath();
    const users = demoContext.users.filter((user) =>
      ["platform", "tenant"].includes(user.scope_type ?? "")
    );
    const primaryUser = users.find((user) => user.user_type === "super_admin") ?? users[0];
    const secondaryUser = users.find((user) => user.email.toLowerCase() !== primaryUser?.email.toLowerCase());
    if (!primaryUser || !secondaryUser) {
      throw new Error("Requires at least two distinct Console fixture users.");
    }

    await test.step("primary seeded user's dashboard is ready", async () => {
      await ensureSignedIn({
        page, basePath, authTestId: "console-auth-required", email: primaryUser.email,
        password: demoContext.password ?? "", scopeType: primaryUser.scope_type ?? null,
      });
      await waitForDashboardHealthReady(page, "console", primaryUser.email);
      await assertSingleAppShellSidebar(page, "console");
    }, { timeout: 35_000 });

    const healthContent = page.locator('[data-testid="console-dashboard-health"]');
    await expect(healthContent).toBeVisible();
    const details = healthContent.locator("xpath=ancestor::details[1]");
    const summary = details.locator("summary");
    await expect(summary).toBeVisible();
    await summary.click();
    await expect(healthContent).toHaveCount(1);
    await expect(healthContent).not.toBeVisible();
    await waitForCollapsedSectionPersisted({
      page, appKey: "console", email: primaryUser.email, collapseKey: "dashboard.health",
    });

    await test.step("the same user's collapsed health survives reload", async () => {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
      await waitForDashboardHealthReady(page, "console", primaryUser.email);
      await assertSingleAppShellSidebar(page, "console");
      await waitForCollapsedSectionPersisted({
        page, appKey: "console", email: primaryUser.email, collapseKey: "dashboard.health",
      });
      await expect(healthContent).toHaveCount(1);
      await expect(healthContent).not.toBeVisible();
    }, { timeout: 30_000 });

    await test.step("a second seeded user does not inherit the collapse", async () => {
      await page.goto(basePath + "/auth/sign-out", { waitUntil: "domcontentloaded", timeout: 20_000 });
      await ensureSignedIn({
        page, basePath, authTestId: "console-auth-required", email: secondaryUser.email,
        password: demoContext.password ?? "", scopeType: secondaryUser.scope_type ?? null,
      });
      await waitForDashboardHealthReady(page, "console", secondaryUser.email);
      await assertSingleAppShellSidebar(page, "console");
      await expect(healthContent).toHaveCount(1);
      await expect(healthContent).toBeVisible();
    }, { timeout: 35_000 });
  });
});
