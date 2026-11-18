import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  applyResourceLimit,
  resolveResourceKeysForUser,
  resolveResourceWithSample,
} from "./utils/core-resource";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

type AppConfig = {
  label: "console" | "portal";
  app: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  resourceTestIdPrefix: string;
  tableTestIdPrefix: string;
  scopeTypes: string[];
};

const appConfigs: AppConfig[] = [
  {
    label: "console",
    app: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    resourceTestIdPrefix: "console-resource",
    tableTestIdPrefix: "console-resource-table",
    scopeTypes: ["platform", "tenant"],
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    resourceTestIdPrefix: "portal-resource",
    tableTestIdPrefix: "portal-resource-table",
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

async function runA11y(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function openPanelA11y(params: {
  page: import("@playwright/test").Page;
  testIdPrefix: string;
  panelKey: string;
  panelLabel: string;
  scopeLabel: string;
}) {
  const { page, testIdPrefix, panelKey, panelLabel, scopeLabel } = params;
  const control = page.locator(
    `[data-testid="${testIdPrefix}-view-control-${panelKey}"]`
  );
  if ((await control.count()) > 0) {
    await control.first().click();
    const panel = page.locator(
      `[data-testid="${testIdPrefix}-panel-${panelKey}"]`
    );
    if ((await panel.count()) > 0) {
      await expect(panel).toBeVisible();
      await runA11y(page);
    }
    await control.first().click();
    return true;
  }
  if (strict) {
    throw new Error(`${panelLabel} panel control missing for ${scopeLabel}.`);
  }
  return false;
}

for (const config of appConfigs) {
  test.describe(`${config.label} a11y panels`, () => {
    test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    const user = scopedUsers[0];
    if (!user) return;

    test(`${config.label} views/export/confirm panels meet a11y baseline`, async ({ page }) => {
      test.setTimeout(600_000);
      const baseUrl = config.baseUrl();
      const context = await fetchUserContext({
        app: config.app,
        email: user.email,
        password: demoContext.password ?? "",
      });

      const sections = Array.isArray(context.navigation.sections)
        ? context.navigation.sections
        : [];
      const resourceKeys = applyResourceLimit(
        resolveResourceKeysForUser({
          sections,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
        })
      );
      if (resourceKeys.length === 0) {
        throw new Error(`No resources available for ${user.email}.`);
      }
      const sample = await resolveResourceWithSample({
        resourceKeys,
        readRegistry: context.readRegistry,
        email: user.email,
        password: demoContext.password ?? "",
      });
      if (!sample) {
        throw new Error(`No resource detail samples for permitted resources: ${resourceKeys.join(", ")}.`);
      }
      const { resourceKey } = sample;

      await page.goto(baseUrl);
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await page.goto(`${baseUrl}/resources/${resourceKey}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const ready = page.locator(
        `[data-testid="${config.resourceTestIdPrefix}-ready"]`
      );
      await expect(
        page.locator(
          `[data-testid="${config.resourceTestIdPrefix}-ready"], [data-testid="${config.resourceTestIdPrefix}-error"], [data-testid="${config.authTestId}"]`
        )
      ).toBeVisible();
      if (!(await ready.isVisible())) return;

      const panelKeys = [
        { key: "views", label: "Views" },
        { key: "export", label: "Export" },
        { key: "filters", label: "Filters" },
        { key: "sort", label: "Sort" },
        { key: "group", label: "Group" },
        { key: "properties", label: "Properties" },
      ];
      for (const panel of panelKeys) {
        await openPanelA11y({
          page,
          testIdPrefix: config.tableTestIdPrefix,
          panelKey: panel.key,
          panelLabel: panel.label,
          scopeLabel: config.label,
        });
      }

      await page.goto(
        `${baseUrl}/resources/${resourceKey}?id=${encodeURIComponent(sample.id)}`,
        { waitUntil: "domcontentloaded", timeout: 60_000 }
      );
      await expect(
        page.locator(
          `[data-testid="${config.resourceTestIdPrefix}-ready"], [data-testid="${config.resourceTestIdPrefix}-error"], [data-testid="${config.authTestId}"]`
        )
      ).toBeVisible();
      await expect(
        page.locator(
          `[data-testid="${config.resourceTestIdPrefix}-detail"]`
        )
      ).toBeVisible();
      await runA11y(page);
    });
  });
}
