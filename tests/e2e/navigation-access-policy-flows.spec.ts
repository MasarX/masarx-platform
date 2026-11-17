import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedInAtUrl } from "./utils/session";
import { fetchUserContext } from "./utils/role-matrix";
import { assertNavigationPerformance } from "./utils/performance";
import { hasCapability, resolveCapabilitySet } from "./utils/capabilities";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

type AppConfig = {
  label: "console" | "portal";
  app: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  testIdPrefix: string;
  scopeTypes: string[];
};

const appConfigs: AppConfig[] = [
  {
    label: "console",
    app: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    testIdPrefix: "console-access-policy",
    scopeTypes: ["platform", "tenant"],
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    testIdPrefix: "portal-access-policy",
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
  test.describe(`${config.label} access policy flows`, () => {
    test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    test(`${config.label} access policy sections and request action`, async ({ page }) => {
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
      const context = await fetchUserContext({
        app: config.app,
        email: user.email,
        password: demoContext.password ?? "",
      });
      const capabilitySet = resolveCapabilitySet(
        Array.isArray(context.me?.capabilities) ? context.me?.capabilities : []
      );
      const canRead = hasCapability(capabilitySet, "access_policy.read");
      const canRequest = hasCapability(capabilitySet, "access_policy.request");

      await ensureSignedInAtUrl({
        page,
        baseUrl,
        authTestId: config.authTestId,
        email: user.email,
        password: demoContext.password ?? "",
        scopeType: user.scope_type ?? null,
      });

      await page.goto(`${baseUrl}/access-policy`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      const ready = page.locator(`[data-testid="${config.testIdPrefix}-ready"]`);
      const error = page.locator(`[data-testid="${config.testIdPrefix}-error"]`);
      const blocked = page.locator(`[data-testid="${config.testIdPrefix}-blocked"]`);
      await expect(
        page.locator(
          `[data-testid="${config.testIdPrefix}-ready"], [data-testid="${config.testIdPrefix}-error"], [data-testid="${config.testIdPrefix}-blocked"], [data-testid="${config.authTestId}"]`
        ).first()
      ).toBeVisible();
      await assertNavigationPerformance(page);
      await expect(error).toHaveCount(0);

      if (canRead) {
        await expect(ready).toBeVisible();
      } else {
        await expect(blocked).toBeVisible();
      }

      if (canRead) {
        const sections = page.locator("section details");
        const sectionCount = await sections.count();
        if (sectionCount === 0) {
          throw new Error(`Access policy sections missing for ${config.label}.`);
        }

        const probeCount = Math.min(sectionCount, 3);
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
      }

      const requestControl = page.locator(
        `[data-testid="${config.testIdPrefix}-request"]`
      );
      if ((await requestControl.count()) === 0) {
        throw new Error(`Access policy request control missing for ${config.label}.`);
      }
      if (canRequest) {
        await expect(requestControl).toHaveAttribute("href", /access-policy\/request/);
      } else {
        await expect(requestControl).toBeDisabled();
      }
    });
  });
}
