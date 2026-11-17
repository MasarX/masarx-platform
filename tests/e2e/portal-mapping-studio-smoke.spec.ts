import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getPortalBasePath } from "./utils/base-paths";
import { captureFullPage, isCaptureEnabled, resolveEvidencePath } from "./utils/evidence";

const demoContext = loadDemoContext();
const evidenceGroup = "mapping-studio";

test.describe("portal mapping studio", () => {
  test("mapping studio route is reachable", async ({ page }) => {
    const portalBasePath = getPortalBasePath();

    await page.goto(`${portalBasePath}/integrations/mappings/new`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const authGate = page.locator('[data-testid="portal-auth-required"]');
    const ready = page.locator('[data-testid="portal-mapping-studio-ready"]');
    const visible = page.locator(
      '[data-testid="portal-mapping-studio-ready"], [data-testid="portal-auth-required"], [data-testid="portal-missing-env"]',
    );
    await expect(visible.first()).toBeVisible();

    if (demoContext.available && demoContext.users.length > 0 && (await authGate.isVisible().catch(() => false))) {
      const user = demoContext.users.find((entry) => ["client", "sender"].includes(entry.scope_type ?? "")) ?? demoContext.users[0];
      if (user?.email && demoContext.password) {
        await signInWithPassword(page, user.email, demoContext.password);
        await expectSignedIn(page, user.email, user.scope_type);
        await page.goto(`${portalBasePath}/integrations/mappings/new`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await expect(ready).toBeVisible({ timeout: 30_000 });
      }
    }

    if (isCaptureEnabled()) {
      const state = (await ready.isVisible().catch(() => false)) ? "ready" : "auth";
      await captureFullPage(
        page,
        resolveEvidencePath(evidenceGroup, `portal-mapping-studio-${state}.png`),
      );
    }
  });
});
