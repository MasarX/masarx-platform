import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getPortalBasePath } from "./utils/base-paths";
import { ensureSignedIn } from "./utils/session";
import { assertSingleAppShellSidebar, waitForDashboardHealthReady } from "./utils/layout-guards";
import { waitForCollapsedSectionPersisted } from "./utils/navigation-state";

const demoContext = loadDemoContext();

test.describe("portal section preferences", () => {
  test.skip(!demoContext.available, demoContext.reason ?? "Demo accounts missing.");

  test("dashboard section collapse persists per user", async ({ page }, testInfo) => {
    // Keep stricter lane limits; never inherit a whole-job timeout for this one test.
    test.setTimeout(Math.min(testInfo.timeout || 90_000, 90_000));
    const basePath = getPortalBasePath();
    const users = demoContext.users.filter((user) =>
      ["client", "sender"].includes(user.scope_type ?? "")
    );
    const primaryUser = users.find((user) => user.user_type === "client_admin") ?? users[0];
    const secondaryUser = users.find((user) => user.email !== primaryUser?.email) ?? users[1];
    if (!primaryUser || !secondaryUser) {
      test.skip(true, "Requires at least two portal demo users.");
      return;
    }

    await test.step("primary seeded user's dashboard is ready", async () => {
      await ensureSignedIn({
        page, basePath, authTestId: "portal-auth-required", email: primaryUser.email,
        password: demoContext.password ?? "", scopeType: primaryUser.scope_type ?? null,
      });
      await waitForDashboardHealthReady(page, "portal", primaryUser.email);
      await assertSingleAppShellSidebar(page, "portal");
    }, { timeout: 35_000 });

    const healthContent = page.locator('[data-testid="portal-dashboard-health"]');
    await expect(healthContent).toBeVisible();
    const details = healthContent.locator("xpath=ancestor::details[1]");
    const summary = details.locator("summary");
    await expect(summary).toBeVisible();
    await summary.click();
    await expect(healthContent).toHaveCount(1);
    await expect(healthContent).not.toBeVisible();
    await waitForCollapsedSectionPersisted({
      page, appKey: "portal", email: primaryUser.email, collapseKey: "dashboard.health",
    });

    await test.step("the same user's collapsed health survives reload", async () => {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
      await waitForDashboardHealthReady(page, "portal", primaryUser.email);
      await assertSingleAppShellSidebar(page, "portal");
      await waitForCollapsedSectionPersisted({
        page, appKey: "portal", email: primaryUser.email, collapseKey: "dashboard.health",
      });
      await expect(healthContent).toHaveCount(1);
      await expect(healthContent).not.toBeVisible();
    }, { timeout: 30_000 });

    await test.step("a second seeded user does not inherit the collapse", async () => {
      await page.goto(basePath + "/auth/sign-out", { waitUntil: "domcontentloaded", timeout: 20_000 });
      await ensureSignedIn({
        page, basePath, authTestId: "portal-auth-required", email: secondaryUser.email,
        password: demoContext.password ?? "", scopeType: secondaryUser.scope_type ?? null,
      });
      await waitForDashboardHealthReady(page, "portal", secondaryUser.email);
      await assertSingleAppShellSidebar(page, "portal");
      await expect(healthContent).toHaveCount(1);
      await expect(healthContent).toBeVisible();
    }, { timeout: 35_000 });
  });
});
