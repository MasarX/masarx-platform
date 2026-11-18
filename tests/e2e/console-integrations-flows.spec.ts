import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath, getConsoleOrigin } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedIn } from "./utils/session";
import { fetchUserContext } from "./utils/role-matrix";
import { fetchResourceSampleId } from "./utils/core-resource";
import { fetchResourceSampleRow } from "./utils/core-resource";
import { assertNavigationPerformance } from "./utils/performance";
import { createConsoleV2AuthStorageState } from "./utils/browser-auth";
import { expectSignedIn } from "./utils/auth";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
const consoleOrigin = getConsoleOrigin();

function enforceDemoContext(scopeLabel: string, users: Array<{ email: string }>) {
  if (!demoContext.available) {
    if (strict) {
      throw new Error(`Demo accounts missing for ${scopeLabel}: ${demoContext.reason}`);
    }
    return;
  }
  if (users.length === 0 && strict) {
    throw new Error(`No demo users available for ${scopeLabel}.`);
  }
}

test.describe("console integrations flows", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const consoleUsers = demoContext.users.filter((user) =>
    ["platform", "tenant"].includes(user.scope_type ?? "")
  );

  test.beforeAll(() => enforceDemoContext("console", consoleUsers));

  test("console provider auth detail flow", async ({ browser }) => {
    const user = consoleUsers[0];
    test.skip(!user, "No console demo user available.");
    const consoleBasePath = getConsoleBasePath();
    const context = await browser.newContext({
      baseURL: consoleOrigin,
      storageState: await createConsoleV2AuthStorageState({
        surfaceOrigin: consoleOrigin,
        email: user.email,
        password: demoContext.password ?? "",
        label: `console-provider-auth:${user.email}`,
      }),
    });
    await context.addInitScript(() => {
      window.localStorage.setItem("console-v2.nav-pinned", "true");
    });
    const page = await context.newPage();

    try {
      await page.goto(consoleBasePath || "/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await expectSignedIn(page, user.email, user.scope_type ?? null);

      await page.getByRole("link", { name: "Provider credentials" }).click();
      await page.waitForURL(new RegExp(`${consoleBasePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/integrations/credentials$`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await expectSignedIn(page, user.email, user.scope_type ?? null);
      await expect(
        page.getByRole("heading", { name: "Provider credentials" })
          .or(page.locator('[data-testid="console-auth-required"]'))
      ).toBeVisible();
      await assertNavigationPerformance(page);

      const userContext = await fetchUserContext({
        app: "console",
        email: user.email,
        password: demoContext.password ?? "",
      });
      const resources = Array.isArray(userContext.readRegistry?.resources)
        ? userContext.readRegistry?.resources
        : [];
      const providerResource =
        resources.find((entry) => entry?.key === "integration_credential_directory") ?? null;
      if (!providerResource) return;

      const providerSample = await fetchResourceSampleId({
        resourceKey: "integration_credential_directory",
        idColumn: providerResource.id_column ?? null,
        email: user.email,
        password: demoContext.password ?? "",
      });
      if (providerSample.id) {
        const search = page.locator('input[placeholder^="Search"]').first();
        await search.fill(providerSample.id);
        const row = page.locator("tbody tr").filter({ hasText: providerSample.id }).first();
        const rowVisible = await row
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        if (!rowVisible) {
          await expect(page.getByText("Nothing here yet")).toBeVisible();
          return;
        }
        await row.click();
        await expectSignedIn(page, user.email, user.scope_type ?? null);
        await assertNavigationPerformance(page);
        await expect(
          page.getByRole("dialog", { name: /rotation history/i })
        ).toBeVisible({ timeout: 60_000 });
      }
    } finally {
      await context.close().catch(() => {});
    }
  });

  test("console integration plugin routes are reachable", async ({ page }) => {
    const user = consoleUsers[0];
    test.skip(!user, "No console demo user available.");
    const consoleBasePath = getConsoleBasePath();

    await ensureSignedIn({
      page,
      basePath: consoleBasePath,
      authTestId: "console-auth-required",
      email: user.email,
      password: demoContext.password ?? "",
      scopeType: user.scope_type ?? null,
    });

    await page.goto(`${consoleBasePath}/integrations/plugins`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(
      page.locator(
        '[data-testid="console-integration-plugins-ready"], [data-testid="console-integration-plugins-error"], [data-testid="console-auth-required"]'
      )
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "New Plugin" })).toHaveAttribute(
      "href",
      `${consoleBasePath}/integrations/plugins/new`,
    );
    await expect(page.getByRole("link", { name: "Provider Health" })).toHaveAttribute(
      "href",
      `${consoleBasePath}/resources/provider_health_latest`,
    );
    await expect(page.getByRole("link", { name: "Circuit Breakers" })).toHaveAttribute(
      "href",
      `${consoleBasePath}/resources/circuit_breaker_dashboard`,
    );
    await assertNavigationPerformance(page);

    await page.goto(`${consoleBasePath}/integrations/plugins/new`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(
      page.locator('[data-testid="console-integration-plugin-studio-ready"]').first()
    ).toBeVisible();
    await assertNavigationPerformance(page);

    const context = await fetchUserContext({
      app: "console",
      email: user.email,
      password: demoContext.password ?? "",
    });
    const resources = Array.isArray(context.readRegistry?.resources)
      ? context.readRegistry?.resources
      : [];
    const pluginResource =
      resources.find((entry) => entry?.key === "integration_plugins") ?? null;

    if (pluginResource) {
      const pluginSample = await fetchResourceSampleRow({
        resourceKey: "integration_plugins",
        email: user.email,
        password: demoContext.password ?? "",
      });
      const pluginIdResult = await fetchResourceSampleId({
        resourceKey: "integration_plugins",
        idColumn: pluginResource.id_column ?? null,
        email: user.email,
        password: demoContext.password ?? "",
      });
      if (pluginIdResult.id) {
        await page.goto(
          `${consoleBasePath}/integrations/plugins/${encodeURIComponent(pluginIdResult.id)}`,
          { waitUntil: "domcontentloaded", timeout: 60_000 }
        );
        await expect(
          page.locator(
            '[data-testid="console-integration-plugin-detail-ready"], [data-testid="console-integration-plugin-detail-error"], [data-testid="console-auth-required"]'
          )
        ).toBeVisible();
        await assertNavigationPerformance(page);
      }

      const activeVersionId =
        pluginSample.item && typeof pluginSample.item.active_version_id === "string"
          ? pluginSample.item.active_version_id
          : "";
      if (pluginIdResult.id && activeVersionId) {
        await page.goto(
          `${consoleBasePath}/integrations/plugins/${encodeURIComponent(
            pluginIdResult.id
          )}/versions/${encodeURIComponent(activeVersionId)}`,
          { waitUntil: "domcontentloaded", timeout: 60_000 }
        );
        await expect(
          page.locator(
            '[data-testid="console-integration-plugin-version-ready"], [data-testid="console-integration-plugin-version-error"], [data-testid="console-auth-required"]'
          )
        ).toBeVisible();
        await assertNavigationPerformance(page);
      }
    }
  });
});
