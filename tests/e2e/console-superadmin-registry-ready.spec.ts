import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import { assertNoAppErrorReload } from "./utils/error-guards";
import {
  assertSingleAppShellSidebar,
  waitForAppShellHydrated,
} from "./utils/layout-guards";
import { captureRuntimeErrors, expectNoRuntimeErrors } from "./utils/runtime-errors";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

test.describe("console super admin read registry readiness", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  test("super admin can load every ui_read_registry resource", async ({ page }) => {
    test.slow();
    test.setTimeout(900_000);

    if (!demoContext.available) {
      throw new Error(demoContext.reason ?? "Demo accounts missing for strict E2E.");
    }

    const superAdmin =
      demoContext.users.find((user) => user.user_type === "super_admin") ??
      demoContext.users.find((user) => user.scope_type === "platform") ??
      null;

    if (!superAdmin) {
      if (strict) {
        throw new Error("No console super admin demo user available.");
      }
      test.skip(true, "No console super admin demo user available.");
      return;
    }

    const context = await fetchUserContext({
      app: "console",
      email: superAdmin.email,
      password: demoContext.password ?? "",
    });

    expect(context.me?.capabilities ?? []).toContain("*");

    const resourceKeys = Array.isArray(context.readRegistry?.resources)
      ? context.readRegistry?.resources
          .map((entry) => entry?.key?.trim() ?? "")
          .filter(Boolean)
      : [];

    if (resourceKeys.length === 0) {
      throw new Error("No ui_read_registry resources available for console.");
    }

    const baseUrl = getConsoleBaseUrl();
    const capture = captureRuntimeErrors(page);
    try {
      await page.goto(baseUrl);
      const authGate = page.locator('[data-testid="console-auth-required"]');
      if (await authGate.isVisible()) {
        await signInWithPassword(page, superAdmin.email, demoContext.password || "");
      }

      await expectSignedIn(page, superAdmin.email, superAdmin.scope_type);
      const capabilitiesBadge = page.getByText(/Capabilities:?/).first().locator("..");
      await expect(capabilitiesBadge).toContainText("*");
      await assertSingleAppShellSidebar(page, "console");
      await waitForAppShellHydrated(page, "console");
      await assertNoAppErrorReload(page);

      for (const resourceKey of resourceKeys) {
        await test.step(resourceKey, async () => {
          await page.goto(`${baseUrl}/resources/${resourceKey}`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });

          const state = page
            .locator(
              '[data-testid="console-resource-ready"], [data-testid="console-resource-error"], [data-testid="console-resource-blocked"], [data-testid="console-auth-required"], [data-testid="console-context-unavailable"], [data-testid="console-not-found"]'
            )
            .first();
          await expect(state).toBeVisible();
          const stateId = await state.getAttribute("data-testid");
          if (!stateId?.endsWith("-ready")) {
            throw new Error(
              `Expected console resource ${resourceKey} to be ready for super admin, got ${stateId ?? "unknown"}`
            );
          }

          await assertSingleAppShellSidebar(page, "console");
          await waitForAppShellHydrated(page, "console");
          await assertNoAppErrorReload(page);
        });
      }
    } finally {
      capture.dispose();
    }

    await expectNoRuntimeErrors(capture, { label: "console super admin registry" });
  });
});
