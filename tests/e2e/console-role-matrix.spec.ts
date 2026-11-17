import { test } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { assertNavigationMatches, fetchUserContext } from "./utils/role-matrix";

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

test.describe("console role matrix navigation", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const consoleUsers = demoContext.users.filter((user) =>
    ["platform", "tenant"].includes(user.scope_type ?? "")
  );

  test.beforeAll(() => enforceDemoContext("console", consoleUsers));

  for (const user of consoleUsers) {
    test(`console navigation matches policy for ${user.email}`, async ({ page }) => {
      const consoleBasePath = getConsoleBasePath();
      const context = await fetchUserContext({
        app: "console",
        email: user.email,
        password: demoContext.password ?? "",
      });
      const sections = Array.isArray(context.navigation.sections)
        ? context.navigation.sections
        : [];
      if (sections.length === 0) {
        if (strict) {
          throw new Error(`No console navigation sections for ${user.email}.`);
        }
        test.skip(true, "No navigation sections returned.");
      }

      await page.goto(consoleBasePath || "/");
      const authGate = page.locator('[data-testid="console-auth-required"]');
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);
      await assertNavigationMatches({
        page,
        basePath: consoleBasePath,
        sections,
        readRegistry: context.readRegistry,
        capabilities: context.me?.capabilities ?? null,
        scopeType: context.me?.access_scope?.scope_type ?? null,
        scopeId: context.me?.access_scope?.scope_id ?? null,
        organizationId: context.me?.org?.id ?? null,
      });
    });
  }
});
