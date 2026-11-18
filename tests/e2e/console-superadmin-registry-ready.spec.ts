import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import { hasCapability, resolveCapabilitySet } from "./utils/capabilities";
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

  test("platform checks every registry resource against its declared read scope", async ({ page }) => {
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
    expect(context.me?.access_scope?.scope_type).toBe("platform");

    const resources = Array.isArray(context.readRegistry?.resources)
      ? context.readRegistry.resources
      : [];

    if (resources.length === 0) {
      throw new Error("No ui_read_registry resources available for console.");
    }
    const reassignment = resources.find(entry => entry.key === "route_stop_reassignment_events") as
      (typeof resources[number] & { read_scope_types?: string[] }) | undefined;
    expect(reassignment?.read_scope_types).toEqual(["tenant"]);

    const baseUrl = getConsoleBaseUrl();
    const capture = captureRuntimeErrors(page);
    try {
      await page.goto(baseUrl);
      const authGate = page.locator('[data-testid="console-auth-required"]');
      if (await authGate.isVisible()) {
        await signInWithPassword(page, superAdmin.email, demoContext.password || "");
      }

      await expectSignedIn(page, superAdmin.email, superAdmin.scope_type);
      const capabilitiesBadge = page.getByTestId("ui-context-strip-capabilities");
      await expect(capabilitiesBadge).toContainText("*");
      await assertSingleAppShellSidebar(page, "console");
      await waitForAppShellHydrated(page, "console");
      await assertNoAppErrorReload(page);

      for (const resource of resources) {
        const resourceKey = resource.key?.trim();
        expect(resourceKey, "Every registry entry must retain a resource identity").toBeTruthy();
        const scopes = (resource as typeof resource & { read_scope_types?: unknown }).read_scope_types;
        const explicitScope = Object.prototype.hasOwnProperty.call(resource, "read_scope_types");
        const validScopes = Array.isArray(scopes) && scopes.length > 0
          && new Set(scopes).size === scopes.length
          && scopes.every(scope => typeof scope === "string"
            && ["tenant", "client", "sender", "platform", "global"].includes(scope));
        const platformAllowed = !explicitScope || (validScopes && scopes.includes("platform"));
        const expectedState = platformAllowed ? "console-resource-ready" : "console-resource-blocked";
        await test.step(resourceKey!, async () => {
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
          if (stateId !== expectedState) {
            throw new Error(
              `Expected console resource ${resourceKey} to be ${expectedState}, got ${stateId ?? "unknown"}`
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

  test("tenant with routes.read can load the tenant-only reassignment registry resource", async ({ page }) => {
    test.setTimeout(120_000);
    if (!demoContext.available) throw new Error(demoContext.reason ?? "Demo accounts missing.");
    const resourceKey = "route_stop_reassignment_events";
    let actor: typeof demoContext.users[number] | undefined;
    for (const user of demoContext.users.filter(entry => entry.scope_type === "tenant")) {
      const context = await fetchUserContext({
        app: "console", email: user.email, password: demoContext.password ?? "",
      });
      if (context.me?.access_scope?.scope_type !== "tenant"
          || !hasCapability(resolveCapabilitySet(context.me?.capabilities), "routes.read")) continue;
      const resource = context.readRegistry?.resources?.find(entry => entry.key === resourceKey) as
        { read_scope_types?: string[] } | undefined;
      expect(resource?.read_scope_types).toEqual(["tenant"]);
      actor = user;
      break;
    }
    if (!actor) throw new Error("Governed tenant demo account with routes.read is required for reassignment readiness.");
    const baseUrl = getConsoleBaseUrl();
    const capture = captureRuntimeErrors(page);
    try {
      await page.goto(baseUrl);
      if (await page.locator('[data-testid="console-auth-required"]').isVisible()) {
        await signInWithPassword(page, actor.email, demoContext.password ?? "");
      }
      await expectSignedIn(page, actor.email, "tenant");
      await page.goto(`${baseUrl}/resources/${resourceKey}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("console-resource-ready")).toBeVisible();
      await expect(page.getByTestId("console-resource-error")).toHaveCount(0);
      await expect(page.getByTestId("console-resource-blocked")).toHaveCount(0);
      await assertSingleAppShellSidebar(page, "console");
      await waitForAppShellHydrated(page, "console");
      await assertNoAppErrorReload(page);
    } finally {
      capture.dispose();
    }
    await expectNoRuntimeErrors(capture, { label: "console tenant reassignment registry" });
  });
});
