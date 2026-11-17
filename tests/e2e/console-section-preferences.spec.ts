import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { ensureSignedIn } from "./utils/session";
import { assertSingleAppShellSidebar } from "./utils/layout-guards";
import { waitForCollapsedSectionPersisted } from "./utils/navigation-state";

const demoContext = loadDemoContext();

test.describe("console section preferences", () => {
  test.skip(
    !demoContext.available,
    demoContext.reason ?? "Demo accounts missing."
  );

  test("dashboard section collapse persists per user", async ({ page }) => {
    const consoleBasePath = getConsoleBasePath();
    const consoleUsers = demoContext.users.filter((user) =>
      ["platform", "tenant"].includes(user.scope_type ?? "")
    );
    const primaryUser =
      consoleUsers.find((user) => user.user_type === "super_admin") ??
      consoleUsers[0];
    const secondaryUser =
      consoleUsers.find((user) => user.email !== primaryUser?.email) ??
      consoleUsers[1];

    test.skip(
      !primaryUser || !secondaryUser,
      "Requires at least two console demo users."
    );

    await ensureSignedIn({
      page,
      basePath: consoleBasePath,
      authTestId: "console-auth-required",
      email: primaryUser.email,
      password: demoContext.password ?? "",
      scopeType: primaryUser.scope_type ?? null,
    });
    await assertSingleAppShellSidebar(page, "console");

    const healthContent = page.locator('[data-testid="console-dashboard-health"]');
    await expect(healthContent).toBeVisible();

    const details = healthContent.locator("xpath=ancestor::details[1]");
    const summary = details.locator("summary");
    await expect(summary).toBeVisible();

    await summary.click();
    await expect(healthContent).not.toBeVisible();
    await waitForCollapsedSectionPersisted({
      page,
      appKey: "console",
      collapseKey: "dashboard.health",
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await assertSingleAppShellSidebar(page, "console");
    await waitForCollapsedSectionPersisted({
      page,
      appKey: "console",
      collapseKey: "dashboard.health",
    });
    await expect(healthContent).not.toBeVisible();

    await page.goto(`${consoleBasePath}/auth/sign-out`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await ensureSignedIn({
      page,
      basePath: consoleBasePath,
      authTestId: "console-auth-required",
      email: secondaryUser.email,
      password: demoContext.password ?? "",
      scopeType: secondaryUser.scope_type ?? null,
    });
    await assertSingleAppShellSidebar(page, "console");
    await expect(healthContent).toBeVisible();
  });
});
