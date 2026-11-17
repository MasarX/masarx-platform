import { test, expect } from "@playwright/test";
import { getPortalBasePath } from "./utils/base-paths";
import { assertNoAppErrorReload } from "./utils/error-guards";
import { assertNavigationPerformance } from "./utils/performance";

test.describe("portal help flow", () => {
  test("portal help loads without sign-in", async ({ page }) => {
    const portalBasePath = getPortalBasePath();
    await page.goto(`${portalBasePath}/help`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await assertNoAppErrorReload(page);
    await expect(page.locator('[data-testid="portal-help-ready"]')).toBeVisible();
    await expect(page.locator('[data-testid="portal-auth-required"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="portal-help-intro"]')).toContainText(
      /\S+/
    );
    await expect(
      page.locator('[data-testid="portal-help-contact"]')
    ).toContainText(/\S+/);
    await assertNavigationPerformance(page);
  });
});
