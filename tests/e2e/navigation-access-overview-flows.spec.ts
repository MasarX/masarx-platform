import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedInAtUrl } from "./utils/session";
import { assertNavigationPerformance } from "./utils/performance";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

type AppConfig = {
  label: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  testIdPrefix: string;
  scopeTypes: string[];
};

const appConfigs: AppConfig[] = [
  {
    label: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    testIdPrefix: "console-access",
    scopeTypes: ["platform", "tenant"],
  },
  {
    label: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    testIdPrefix: "portal-access",
    scopeTypes: ["client", "sender"],
  },
];

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

for (const config of appConfigs) {
  test.describe(`${config.label} access overview flows`, () => {
    test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    test(`${config.label} access overview sections`, async ({ page }) => {
      const user =
        config.label === "console"
          ? scopedUsers.find((candidate) => candidate.scope_type === "platform") ??
            scopedUsers[0] ??
            null
          : scopedUsers[0] ?? null;

      if (!user) {
        if (strict) {
          throw new Error(`No ${config.label} demo user available.`);
        }
        test.skip(true, `No ${config.label} demo user available.`);
      }

      const baseUrl = config.baseUrl();

      await ensureSignedInAtUrl({
        page,
        baseUrl,
        authTestId: config.authTestId,
        email: user.email,
        password: demoContext.password ?? "",
        scopeType: user.scope_type ?? null,
      });

      await page.goto(`${baseUrl}/access`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      const ready = page.locator(`[data-testid="${config.testIdPrefix}-ready"]`);
      const error = page.locator(`[data-testid="${config.testIdPrefix}-error"]`);
      await expect(
        page.locator(
          `[data-testid="${config.testIdPrefix}-ready"], [data-testid="${config.testIdPrefix}-error"], [data-testid="${config.authTestId}"]`
        ).first()
      ).toBeVisible();
      await assertNavigationPerformance(page);
      await expect(error).toHaveCount(0);
      await expect(ready.first()).toBeVisible();

      const sections = page.locator("section details");
      const sectionCount = await sections.count();
      if (sectionCount === 0) {
        throw new Error(`Access overview sections missing for ${config.label}.`);
      }

      const probeCount = Math.min(sectionCount, 2);
      for (let i = 0; i < probeCount; i += 1) {
        const section = sections.nth(i);
        const summary = section.locator("summary");
        if ((await summary.count()) === 0) continue;
        const initialOpen = await section.getAttribute("open");
        await summary.click();
        if (initialOpen === null) {
          await expect(section).toHaveAttribute("open");
        } else {
          await expect(section).not.toHaveAttribute("open");
        }
      }
    });
  });
}
