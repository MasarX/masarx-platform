import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getPortalBasePath } from "./utils/base-paths";
import { ensureSignedIn } from "./utils/session";
import { assertSingleAppShellSidebar } from "./utils/layout-guards";

const demoContext = loadDemoContext();

test.describe("portal navigation preferences", () => {
  test.skip(
    !demoContext.available,
    demoContext.reason ?? "Demo accounts missing."
  );

  test("sidebar collapse persists per user", async ({ page }) => {
    const portalBasePath = getPortalBasePath();
    const portalUsers = demoContext.users.filter((user) =>
      ["client", "sender"].includes(user.scope_type ?? "")
    );
    const primaryUser =
      portalUsers.find((user) => user.user_type === "client_admin") ??
      portalUsers[0];
    const secondaryUser =
      portalUsers.find((user) => user.email !== primaryUser?.email) ??
      portalUsers[1];

    test.skip(
      !primaryUser || !secondaryUser,
      "Requires at least two portal demo users."
    );

    await ensureSignedIn({
      page,
      basePath: portalBasePath,
      authTestId: "portal-auth-required",
      email: primaryUser.email,
      password: demoContext.password ?? "",
      scopeType: primaryUser.scope_type ?? null,
    });
    await assertSingleAppShellSidebar(page, "portal");

    const sidebar = page.locator('[data-testid="portal-app-shell-sidebar"]');
    const toggle = page.locator(
      '[data-testid="portal-app-shell-sidebar-toggle-main"]'
    );

    await expect(toggle).toBeVisible();
    await expect(sidebar).toBeVisible();

    await toggle.click();
    await expect(sidebar).not.toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(sidebar).not.toBeVisible();

    await page.goto(`${portalBasePath}/auth/sign-out`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await ensureSignedIn({
      page,
      basePath: portalBasePath,
      authTestId: "portal-auth-required",
      email: secondaryUser.email,
      password: demoContext.password ?? "",
      scopeType: secondaryUser.scope_type ?? null,
    });
    await assertSingleAppShellSidebar(page, "portal");
    await expect(sidebar).toBeVisible();
  });
});

