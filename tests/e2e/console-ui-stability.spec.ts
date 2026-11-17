import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl } from "./utils/base-urls";
import { assertNoAppErrorReload } from "./utils/error-guards";
import { assertSingleAppShellSidebar } from "./utils/layout-guards";
import { captureRuntimeErrors, expectNoRuntimeErrors } from "./utils/runtime-errors";
import { isStrictE2EEnv } from "./utils/env";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

test.describe("console UI stability", () => {
  test.skip(
    !demoContext.available && !strict,
    demoContext.reason ?? "Demo accounts missing."
  );

  test("super admin can open table panels without runtime errors", async ({ page }) => {
    test.setTimeout(300_000);
    if (!demoContext.available) {
      throw new Error(demoContext.reason ?? "Demo accounts missing for strict E2E.");
    }
    const baseUrl = getConsoleBaseUrl();
    const superAdmin =
      demoContext.users.find((user) => user.user_type === "super_admin") ??
      demoContext.users.find((user) => user.scope_type === "platform") ??
      null;

    if (!superAdmin) {
      throw new Error("No super admin demo user available.");
    }

    const capture = captureRuntimeErrors(page);
    try {
      await page.goto(baseUrl);
      const authGate = page.locator('[data-testid="console-auth-required"]');
      const signedInMarker = page.getByText(/Signed in:?/).first();
      await Promise.race([
        authGate.waitFor({ state: "visible", timeout: 15_000 }).catch(() => null),
        signedInMarker.waitFor({ state: "visible", timeout: 15_000 }).catch(() => null),
      ]);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, superAdmin.email, demoContext.password || "");
      }
      await expectSignedIn(page, superAdmin.email, superAdmin.scope_type);

      await page.goto(`${baseUrl}/resources/shipments`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      await expect(
        page.locator(
          '[data-testid="console-resource-ready"], [data-testid="console-resource-error"], [data-testid="console-auth-required"]'
        )
      ).toBeVisible();

      await assertSingleAppShellSidebar(page, "console");
      await assertNoAppErrorReload(page);

      const ready = page.locator('[data-testid="console-resource-ready"]');
      await expect(ready).toBeVisible();

      const panelKeys = ["views", "filters", "sort", "group", "properties", "export"] as const;
      for (const key of panelKeys) {
        const control = page.locator(
          `[data-testid="console-resource-table-view-control-${key}"]`
        );
        await expect(control.first()).toBeVisible();
        await control.first().click();
        await expect(
          page.locator(`[data-testid="console-resource-table-panel-${key}"]`)
        ).toBeVisible();
        await control.first().click();
        await expect(
          page.locator(`[data-testid="console-resource-table-panel-${key}"]`)
        ).toHaveCount(0);
        await assertNoAppErrorReload(page);
      }
    } finally {
      capture.dispose();
    }

    await expectNoRuntimeErrors(capture, { label: "console table panels" });
  });
});
