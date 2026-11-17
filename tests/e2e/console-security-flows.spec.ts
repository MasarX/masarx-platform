import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedIn } from "./utils/session";
import { fetchUserContext } from "./utils/role-matrix";
import { fetchResourceSampleId } from "./utils/core-resource";
import { assertNavigationPerformance } from "./utils/performance";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

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

test.describe("console security flows", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const consoleUsers = demoContext.users.filter((user) =>
    ["platform", "tenant"].includes(user.scope_type ?? "")
  );

  test.beforeAll(() => enforceDemoContext("console", consoleUsers));

  test("console audit logs and token rotation detail flows", async ({ page }) => {
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

    const context = await fetchUserContext({
      app: "console",
      email: user.email,
      password: demoContext.password ?? "",
    });
    const resources = Array.isArray(context.readRegistry?.resources)
      ? context.readRegistry?.resources
      : [];
    const auditResource = resources.find((entry) => entry?.key === "audit_table_changes") ?? null;
    const tokenResource = resources.find((entry) => entry?.key === "token_rotation_requests") ?? null;

    await page.goto(`${consoleBasePath}/security/audit-logs`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(
      page.locator(
        '[data-testid="console-audit-logs-ready"], [data-testid="console-audit-logs-error"], [data-testid="console-auth-required"]'
      )
    ).toBeVisible();
    await assertNavigationPerformance(page);

    if (auditResource) {
      const auditSample = await fetchResourceSampleId({
        resourceKey: "audit_table_changes",
        idColumn: auditResource.id_column ?? null,
        email: user.email,
        password: demoContext.password ?? "",
      });
      if (auditSample.id) {
      await page.goto(
        `${consoleBasePath}/security/audit-logs?id=${encodeURIComponent(auditSample.id)}`,
        { waitUntil: "domcontentloaded", timeout: 60_000 }
      );
      await expect(
          page.locator(
          '[data-testid="console-audit-logs-ready"], [data-testid="console-audit-logs-error"], [data-testid="console-auth-required"]'
        )
      ).toBeVisible();
      await assertNavigationPerformance(page);
      await expect(
        page.locator('[data-testid="console-audit-logs-detail"]')
      ).toBeVisible();
    }
    }

    await page.goto(`${consoleBasePath}/security/token-rotation`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(
      page.locator(
        '[data-testid="console-token-rotation-ready"], [data-testid="console-token-rotation-error"], [data-testid="console-auth-required"]'
      )
    ).toBeVisible();
    await assertNavigationPerformance(page);

    if (tokenResource) {
      const tokenSample = await fetchResourceSampleId({
        resourceKey: "token_rotation_requests",
        idColumn: tokenResource.id_column ?? null,
        email: user.email,
        password: demoContext.password ?? "",
      });
      if (tokenSample.id) {
      await page.goto(
        `${consoleBasePath}/security/token-rotation?id=${encodeURIComponent(tokenSample.id)}`,
        { waitUntil: "domcontentloaded", timeout: 60_000 }
      );
      await expect(
          page.locator(
          '[data-testid="console-token-rotation-ready"], [data-testid="console-token-rotation-error"], [data-testid="console-auth-required"]'
        )
      ).toBeVisible();
      await assertNavigationPerformance(page);
      await expect(
        page.locator('[data-testid="console-token-rotation-detail"]')
      ).toBeVisible();
      }
    }
  });
});
