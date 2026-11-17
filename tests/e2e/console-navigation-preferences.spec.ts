import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { ensureSignedIn } from "./utils/session";
import { assertSingleAppShellSidebar } from "./utils/layout-guards";

const demoContext = loadDemoContext();

test.describe("console navigation preferences", () => {
  test.skip(
    !demoContext.available,
    demoContext.reason ?? "Demo accounts missing."
  );

  test("sidebar collapse persists per user", async ({ page }) => {
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

    const sidebar = page.locator('[data-testid="console-app-shell-sidebar"]');
    const toggle = page.locator(
      '[data-testid="console-app-shell-sidebar-toggle-main"]'
    );

    await expect(toggle).toBeVisible();
    await expect(sidebar).toBeVisible();

    await toggle.click();
    await expect(sidebar).not.toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(sidebar).not.toBeVisible();

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
    await expect(sidebar).toBeVisible();
  });
});

