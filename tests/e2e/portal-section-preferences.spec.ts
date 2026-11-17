import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getPortalBasePath } from "./utils/base-paths";
import { ensureSignedIn } from "./utils/session";
import { assertSingleAppShellSidebar } from "./utils/layout-guards";
import { waitForCollapsedSectionPersisted } from "./utils/navigation-state";

const demoContext = loadDemoContext();

test.describe("portal section preferences", () => {
  test.skip(
    !demoContext.available,
    demoContext.reason ?? "Demo accounts missing."
  );

  test("dashboard section collapse persists per user", async ({ page }) => {
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

    const healthContent = page.locator('[data-testid="portal-dashboard-health"]');
    await expect(healthContent).toBeVisible();

    const details = healthContent.locator("xpath=ancestor::details[1]");
    const summary = details.locator("summary");
    await expect(summary).toBeVisible();

    await summary.click();
    await expect(healthContent).not.toBeVisible();
    await waitForCollapsedSectionPersisted({
      page,
      appKey: "portal",
      collapseKey: "dashboard.health",
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await assertSingleAppShellSidebar(page, "portal");
    await waitForCollapsedSectionPersisted({
      page,
      appKey: "portal",
      collapseKey: "dashboard.health",
    });
    await expect(healthContent).not.toBeVisible();

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
    await expect(healthContent).toBeVisible();
  });
});
