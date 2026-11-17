import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { ensureSignedInAtUrl } from "./utils/session";
import { waitForAppShellHydrated } from "./utils/layout-guards";
import { isStrictE2EEnv } from "./utils/env";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

type AppCase = {
  label: "console" | "portal";
  appKey: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  userScopeTypes: string[];
};

const appCases: AppCase[] = [
  {
    label: "console",
    appKey: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    userScopeTypes: ["platform", "tenant"],
  },
  {
    label: "portal",
    appKey: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    userScopeTypes: ["client", "sender"],
  },
];

function enforceDemoContext(scopeLabel: string, users: Array<{ email: string }>) {
  if (!demoContext.available) {
    if (strict) {
      throw new Error(`Demo accounts missing for ${scopeLabel}: ${demoContext.reason}`);
    }
    return;
  }
  if (users.length < 2 && strict) {
    throw new Error(`Need at least 2 demo users for ${scopeLabel} preference isolation tests.`);
  }
}

async function signOut(page: import("@playwright/test").Page, baseUrl: string) {
  await page.goto(`${baseUrl}/auth/sign-out`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
}

for (const config of appCases) {
  test.describe(`${config.label} navigation preferences isolation`, () => {
    test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

    const scopedUsers = demoContext.users.filter((user) =>
      config.userScopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    test(`${config.label} sidebar state does not bleed across users`, async ({ page }) => {
      test.setTimeout(600_000);

      const [userA, userB] = scopedUsers;
      if (!userA || !userB) {
        test.skip(true, "Not enough demo users available.");
      }

      const baseUrl = config.baseUrl();
      const sidebar = page.locator(`[data-testid="${config.appKey}-app-shell-sidebar"]`);
      const sidebarToggle = page.locator(
        `[data-testid="${config.appKey}-app-shell-sidebar-toggle-main"]`
      );

      await ensureSignedInAtUrl({
        page,
        baseUrl,
        authTestId: config.authTestId,
        email: userA.email,
        password: demoContext.password ?? "",
        scopeType: userA.scope_type ?? null,
      });
      await waitForAppShellHydrated(page, config.appKey);
      await expect(sidebar).not.toHaveAttribute("aria-hidden", "true");

      await sidebarToggle.click();
      await expect(sidebar).toHaveAttribute("aria-hidden", "true");

      await signOut(page, baseUrl);

      await ensureSignedInAtUrl({
        page,
        baseUrl,
        authTestId: config.authTestId,
        email: userB.email,
        password: demoContext.password ?? "",
        scopeType: userB.scope_type ?? null,
      });
      await waitForAppShellHydrated(page, config.appKey);
      await expect(sidebar).not.toHaveAttribute("aria-hidden", "true");

      await signOut(page, baseUrl);

      await ensureSignedInAtUrl({
        page,
        baseUrl,
        authTestId: config.authTestId,
        email: userA.email,
        password: demoContext.password ?? "",
        scopeType: userA.scope_type ?? null,
      });
      await waitForAppShellHydrated(page, config.appKey);
      await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    });
  });
}
