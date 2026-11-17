import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBasePath } from "./utils/base-paths";
import { captureFullPage, isCaptureEnabled, resolveEvidencePath } from "./utils/evidence";

const demoContext = loadDemoContext();
const evidenceGroup = "mapping-studio";

test.describe("console mapping studio", () => {
  test("mapping studio route is reachable", async ({ page }) => {
    const consoleBasePath = getConsoleBasePath();

    await page.goto(`${consoleBasePath}/integrations/mappings/new`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const authGate = page.locator('[data-testid="console-auth-required"]');
    const ready = page.locator('[data-testid="console-mapping-studio-ready"]');
    const visible = page.locator(
      '[data-testid="console-mapping-studio-ready"], [data-testid="console-auth-required"], [data-testid="console-missing-env"]',
    );
    await expect(visible.first()).toBeVisible();

    if (demoContext.available && demoContext.users.length > 0 && (await authGate.isVisible().catch(() => false))) {
      const user = demoContext.users.find((entry) => ["platform", "tenant"].includes(entry.scope_type ?? "")) ?? demoContext.users[0];
      if (user?.email && demoContext.password) {
        await signInWithPassword(page, user.email, demoContext.password);
        await expectSignedIn(page, user.email, user.scope_type);
        await page.goto(`${consoleBasePath}/integrations/mappings/new`, {
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
        resolveEvidencePath(evidenceGroup, `console-mapping-studio-${state}.png`),
      );
    }
  });
});
